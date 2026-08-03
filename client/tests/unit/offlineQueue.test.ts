import { describe, expect, it } from 'vitest';
import {
  applyOutcomes,
  enqueue,
  itemsToSync,
  markInFlight,
  outstandingCount,
  purgeSynced,
  QueueItem,
  QueueStorage,
  readQueue,
} from '../../src/features/capture/offlineQueue';

/** An in-memory store that behaves like Web Storage, including surviving a "restart". */
function makeStorage(seed: Record<string, string> = {}): QueueStorage & { data: Record<string, string> } {
  const data: Record<string, string> = { ...seed };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

function capture(id: string, overrides: Partial<QueueItem> = {}) {
  return {
    clientCaptureId: id,
    captureKind: 'contact' as const,
    rawInput: `Contact ${id}`,
    originClass: 'USER_PROVIDED',
    propertyReference: null,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('surviving a force-quit', () => {
  it('keeps five captures across a simulated restart', () => {
    const storage = makeStorage();
    for (let i = 1; i <= 5; i += 1) {
      enqueue(storage, capture(`c${i}`));
    }

    // The force-quit: a brand new storage wrapper over the SAME persisted data,
    // which is exactly what a relaunch gives you. Nothing in memory carries
    // over — if the queue lived in a React hook, this is where it vanished.
    const afterRestart = makeStorage(storage.data);

    expect(readQueue(afterRestart)).toHaveLength(5);
  });

  it('is empty, not broken, on a first launch', () => {
    expect(readQueue(makeStorage())).toEqual([]);
  });

  it('returns EMPTY rather than throwing when the store is corrupt', () => {
    // Throwing here would take the app down on launch: the operator loses the
    // queue AND the product. Losing the queue is bad; being unable to open the
    // app to discover that is worse.
    const storage = makeStorage({ 'leadflow.captureQueue.v1': '{not json' });
    expect(readQueue(storage)).toEqual([]);
  });
});

describe('enqueueing', () => {
  it('starts an item pending with no attempts', () => {
    const storage = makeStorage();
    const queue = enqueue(storage, capture('a'));

    expect(queue[0].syncState).toBe('pending');
    expect(queue[0].attempts).toBe(0);
  });

  it('IGNORES a repeat of the same id — a double-tap must not queue twice', () => {
    const storage = makeStorage();
    enqueue(storage, capture('a'));
    const queue = enqueue(storage, capture('a'));

    expect(queue).toHaveLength(1);
  });
});

describe('what gets sent on a sync', () => {
  it('sends pending items', () => {
    const storage = makeStorage();
    enqueue(storage, capture('a'));

    expect(itemsToSync(readQueue(storage))).toHaveLength(1);
  });

  it('RE-SENDS in-flight items, because the device cannot know if they landed', () => {
    const storage = makeStorage();
    enqueue(storage, capture('a'));
    markInFlight(storage, ['a']);

    // This is the force-quit-mid-sync case. Excluding in-flight would silently
    // lose a capture that never arrived. Re-sending is safe ONLY because the
    // server deduplicates on the client id — the whole design leans on it.
    expect(itemsToSync(readQueue(storage))).toHaveLength(1);
  });

  it('does not re-send what the server confirmed', () => {
    const storage = makeStorage();
    enqueue(storage, capture('a'));
    applyOutcomes(storage, [{ clientCaptureId: 'a', status: 'accepted' }]);

    expect(itemsToSync(readQueue(storage))).toHaveLength(0);
  });

  it('counts an attempt when an item goes in flight', () => {
    const storage = makeStorage();
    enqueue(storage, capture('a'));
    markInFlight(storage, ['a']);
    markInFlight(storage, ['a']);

    expect(readQueue(storage)[0].attempts).toBe(2);
  });
});

describe('applying the server verdicts', () => {
  it('treats a DUPLICATE as synced, not as an error', () => {
    const storage = makeStorage();
    enqueue(storage, capture('a'));

    applyOutcomes(storage, [{ clientCaptureId: 'a', status: 'duplicate' }]);

    // The server is saying this already exists — that is success. Treating it
    // as a failure would leave the item queued forever, retried on every sync,
    // and the Offline Queue count would never reach zero for a rep who did
    // nothing wrong.
    expect(readQueue(storage)[0].syncState).toBe('synced');
  });

  it('returns a failed item to pending so it is retried', () => {
    const storage = makeStorage();
    enqueue(storage, capture('a'));
    markInFlight(storage, ['a']);

    applyOutcomes(storage, [
      { clientCaptureId: 'a', status: 'failed', error: 'Network unreachable' },
    ]);

    const item = readQueue(storage)[0];
    expect(item.syncState).toBe('pending');
    expect(item.error).toBe('Network unreachable');
  });

  it('leaves untouched anything the server did not mention', () => {
    const storage = makeStorage();
    enqueue(storage, capture('a'));
    enqueue(storage, capture('b'));

    applyOutcomes(storage, [{ clientCaptureId: 'a', status: 'accepted' }]);

    // A partial response must not silently resolve items it said nothing about.
    expect(readQueue(storage).find((i) => i.clientCaptureId === 'b')?.syncState).toBe('pending');
  });
});

describe('the Offline Queue count', () => {
  it('counts only what is still owed to the server', () => {
    const storage = makeStorage();
    enqueue(storage, capture('a'));
    enqueue(storage, capture('b'));
    enqueue(storage, capture('c'));
    applyOutcomes(storage, [{ clientCaptureId: 'a', status: 'accepted' }]);

    // Showing 3 here would tell a rep they have a backlog they already cleared.
    expect(outstandingCount(readQueue(storage))).toBe(2);
  });

  it('reaches zero once everything has synced', () => {
    const storage = makeStorage();
    enqueue(storage, capture('a'));
    applyOutcomes(storage, [{ clientCaptureId: 'a', status: 'duplicate' }]);

    expect(outstandingCount(readQueue(storage))).toBe(0);
  });

  it('drops synced items on purge but keeps outstanding ones', () => {
    const storage = makeStorage();
    enqueue(storage, capture('a'));
    enqueue(storage, capture('b'));
    applyOutcomes(storage, [{ clientCaptureId: 'a', status: 'accepted' }]);

    const remaining = purgeSynced(storage);

    expect(remaining).toHaveLength(1);
    expect(remaining[0].clientCaptureId).toBe('b');
  });
});

describe('the full acceptance journey', () => {
  it('five captured offline, force-quit mid-sync, reconnect — five synced, none lost', () => {
    const storage = makeStorage();
    for (let i = 1; i <= 5; i += 1) {
      enqueue(storage, capture(`f${i}`));
    }

    // Sync starts: all five go in flight. Then the app is killed — no outcomes
    // are ever applied.
    markInFlight(storage, ['f1', 'f2', 'f3', 'f4', 'f5']);

    const relaunched = makeStorage(storage.data);
    const toRetry = itemsToSync(readQueue(relaunched));

    // All five are retried, because the device cannot know which landed.
    expect(toRetry).toHaveLength(5);

    // The server saw three the first time and answers accordingly. The counts
    // add to five, and no capture was lost or doubled.
    applyOutcomes(relaunched, [
      { clientCaptureId: 'f1', status: 'duplicate' },
      { clientCaptureId: 'f2', status: 'duplicate' },
      { clientCaptureId: 'f3', status: 'duplicate' },
      { clientCaptureId: 'f4', status: 'accepted' },
      { clientCaptureId: 'f5', status: 'accepted' },
    ]);

    expect(outstandingCount(readQueue(relaunched))).toBe(0);
    expect(purgeSynced(relaunched)).toHaveLength(0);
  });
});

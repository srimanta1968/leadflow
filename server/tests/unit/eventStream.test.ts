import { eventStream, LeadEvent } from '../../src/services/EventStream';

/**
 * The publish/subscribe behind `GET /api/events/stream`.
 *
 * WHY THESE LIVE HERE. The endpoint is SSE: it holds the connection open and
 * never completes, so the API contract runner cannot drive it and its
 * definition is declared `testability: manual`. That leaves the handshake and
 * the 401 as the only parts anything black-box can check — and the parts that
 * actually matter are all in-process:
 *
 *   - every subscriber receives every event, exactly once
 *   - unsubscribe really detaches, so a disconnected client stops being written to
 *   - a throwing subscriber cannot break the request that published the event
 *
 * Without these the endpoint would have no coverage of its real contract at
 * all, and marking the definition `manual` would have quietly removed the only
 * test touching it.
 */

/** Collect events, returning the unsubscribe the caller must invoke. */
function collect(into: LeadEvent[]): () => void {
  return eventStream.subscribe((event) => {
    into.push(event);
  });
}

describe('EventStream', () => {
  it('delivers a published event to a subscriber', () => {
    const seen: LeadEvent[] = [];
    const off = collect(seen);

    try {
      eventStream.publish({ type: 'lead.captured', subject_id: 'lead-1' });
    } finally {
      off();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'lead.captured', subject_id: 'lead-1' });
  });

  it('stamps `at` at publish time rather than trusting the caller', () => {
    const seen: LeadEvent[] = [];
    const off = collect(seen);

    try {
      eventStream.publish({ type: 'sla.breached', subject_id: 'lead-2' });
    } finally {
      off();
    }

    // The client discards events older than its own state, so a missing or
    // caller-supplied timestamp would make that comparison meaningless.
    expect(typeof seen[0].at).toBe('string');
    expect(Number.isNaN(Date.parse(seen[0].at))).toBe(false);
  });

  it('delivers to EVERY subscriber, not just the first', () => {
    const a: LeadEvent[] = [];
    const b: LeadEvent[] = [];
    const offA = collect(a);
    const offB = collect(b);

    try {
      eventStream.publish({ type: 'lead.routed', subject_id: 'lead-3' });
    } finally {
      offA();
      offB();
    }

    // Two operators with the inbox open are two subscribers; one of them
    // silently missing the hint is the bug this catches.
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('stops delivering after unsubscribe', () => {
    const seen: LeadEvent[] = [];
    const off = collect(seen);
    off();

    eventStream.publish({ type: 'lead.reassigned', subject_id: 'lead-4' });

    // The SSE handler unsubscribes on 'close' and on 'error'. If detaching did
    // not work, every page load would leave a listener behind writing to a
    // dead socket, and they would accumulate until the process ran out.
    expect(seen).toHaveLength(0);
  });

  it('leaves no listener behind once every subscriber detaches', () => {
    const before = eventStream.subscriberCount();
    const off1 = collect([]);
    const off2 = collect([]);
    expect(eventStream.subscriberCount()).toBe(before + 2);

    off1();
    off2();

    expect(eventStream.subscriberCount()).toBe(before);
  });

  it('NEVER throws out of publish, even when a subscriber does', () => {
    const survivor: LeadEvent[] = [];
    const offBad = eventStream.subscribe(() => {
      throw new Error('subscriber exploded');
    });
    const offGood = collect(survivor);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      // Publishing is a side effect of doing the work, not part of it. A
      // failing subscriber must never fail the capture that caused the event —
      // the lead is already saved, and throwing here would report failure for
      // work that succeeded.
      expect(() =>
        eventStream.publish({ type: 'lead.captured', subject_id: 'lead-5' })
      ).not.toThrow();
    } finally {
      offBad();
      offGood();
      jest.restoreAllMocks();
    }
  });

  it('replays NOTHING to a subscriber that arrives late', () => {
    eventStream.publish({ type: 'sla_alert.raised', subject_id: 'lead-6' });

    const seen: LeadEvent[] = [];
    const off = collect(seen);
    off();

    // At-most-once, by design. An event emitted while a client was
    // disconnected is simply lost, which is safe ONLY because the event
    // carries no state — it is a hint to re-read, and the projection stays the
    // source of truth. This test exists to keep that guarantee honest: if
    // replay is ever added, the "carries no state" reasoning has to be
    // revisited rather than silently inherited.
    expect(seen).toHaveLength(0);
  });
});

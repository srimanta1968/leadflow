import {
  parseInboxQuery,
  encodeCursor,
  decodeCursor,
  actionsForTrustState,
  availableActions,
  captureSourceFor,
  isAfterCursor,
  MAX_LIMIT,
} from '../../src/features/capture/inboxQuery';

/**
 * The capture inbox's query handling and action computation.
 *
 * Unit tests because these are the decisions an api_definition testCase cannot
 * reach: what a cursor does under a concurrent insert, and how a trust state
 * intersects with a policy verdict.
 */

describe('cursor pagination', () => {
  it('round-trips a cursor', () => {
    const cursor = { createdAt: '2026-08-02T10:00:00.000Z', sourceRecordId: 'cap-1' };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('keeps the id, so two captures in the same millisecond cannot collide', () => {
    // Captures arrive in bursts. A time-only cursor would skip the second row
    // or return it twice depending on the comparison operator.
    const a = encodeCursor({ createdAt: '2026-08-02T10:00:00.000Z', sourceRecordId: 'cap-1' });
    const b = encodeCursor({ createdAt: '2026-08-02T10:00:00.000Z', sourceRecordId: 'cap-2' });

    expect(a).not.toBe(b);
    expect(decodeCursor(b).sourceRecordId).toBe('cap-2');
  });

  it('survives an id containing the separator', () => {
    const cursor = { createdAt: '2026-08-02T10:00:00.000Z', sourceRecordId: 'cap|weird|id' };

    // Split on the FIRST separator: the ISO timestamp cannot contain a pipe,
    // but an upstream id can.
    expect(decodeCursor(encodeCursor(cursor)).sourceRecordId).toBe('cap|weird|id');
  });

  it('walks the page in the queue order, and never twice over a shared millisecond', () => {
    // The queue is newest first, so "after the cursor" means OLDER than it.
    const cursor = { createdAt: '2026-08-02T10:00:00.000Z', sourceRecordId: 'cap-5' };

    expect(
      isAfterCursor({ createdAt: '2026-08-02T09:59:00.000Z', sourceRecordId: 'cap-9' }, cursor)
    ).toBe(true);
    expect(
      isAfterCursor({ createdAt: '2026-08-02T10:01:00.000Z', sourceRecordId: 'cap-1' }, cursor)
    ).toBe(false);

    // The cursor row itself must not come back: it was the last row of the
    // previous page, and re-serving it is duplicated triage work.
    expect(isAfterCursor(cursor, cursor)).toBe(false);

    // Two captures in the SAME millisecond are split by id, using the same
    // ordering the page is sorted by — so one lands on each side and neither
    // is skipped nor repeated.
    expect(
      isAfterCursor({ createdAt: '2026-08-02T10:00:00.000Z', sourceRecordId: 'cap-4' }, cursor)
    ).toBe(true);
    expect(
      isAfterCursor({ createdAt: '2026-08-02T10:00:00.000Z', sourceRecordId: 'cap-6' }, cursor)
    ).toBe(false);
  });

  it('refuses a malformed cursor rather than silently restarting at page one', () => {
    // A silent restart re-serves rows the operator already triaged, which in a
    // queue is duplicated work rather than a visible error.
    expect(() => decodeCursor('not-a-cursor')).toThrow();
    expect(() => decodeCursor(Buffer.from('no-separator').toString('base64url'))).toThrow();
    expect(() =>
      decodeCursor(Buffer.from('not-a-date|cap-1').toString('base64url'))
    ).toThrow();
  });
});

describe('query validation', () => {
  it('defaults the limit and accepts one inside the cap', () => {
    expect(parseInboxQuery({}).limit).toBe(25);
    expect(parseInboxQuery({ limit: '50' }).limit).toBe(50);
  });

  it('rejects a limit above the cap or below one', () => {
    expect(() => parseInboxQuery({ limit: String(MAX_LIMIT + 1) })).toThrow();
    expect(() => parseInboxQuery({ limit: '0' })).toThrow();
    expect(() => parseInboxQuery({ limit: 'ten' })).toThrow();
  });

  it('rejects an unknown filter value instead of ignoring it', () => {
    // Dropping an unrecognised filter answers a DIFFERENT question: the
    // operator mistypes an origin class and is shown everything while
    // believing they filtered.
    expect(() => parseInboxQuery({ trust_state: 'P9_ASCENDED' })).toThrow();
    expect(() => parseInboxQuery({ origin_class: 'HEARSAY' })).toThrow();
  });

  it('treats an empty filter as absent rather than as a value', () => {
    const query = parseInboxQuery({ trust_state: '', origin_class: '', cursor: '' });

    expect(query.trustState).toBeNull();
    expect(query.originClass).toBeNull();
    expect(query.cursor).toBeNull();
  });
});

describe('capture source attribution', () => {
  it('maps each surface, splits the offline sync by kind, and buckets the rest as other', () => {
    expect(captureSourceFor('leadflow', undefined)).toBe('quick_add');
    expect(captureSourceFor('leadflow-extension', undefined)).toBe('browser_extension');

    // One system name, two surfaces — the device says which.
    expect(captureSourceFor('leadflow-offline', 'contact')).toBe('mobile_contacts');
    expect(captureSourceFor('leadflow-offline', 'business_card')).toBe('business_card');

    // An import or a partner feed is NOT a quick add. Forcing it into the
    // nearest bucket would overstate a channel nobody used.
    expect(captureSourceFor('acculynx-import', undefined)).toBe('other');
    expect(captureSourceFor(undefined, undefined)).toBe('other');
  });
});

describe('available actions', () => {
  it('offers only what the trust state allows', () => {
    // A capture that has not been parsed cannot be promoted.
    expect(actionsForTrustState('P0_CAPTURED')).toContain('source_record.normalize');
    expect(actionsForTrustState('P0_CAPTURED')).not.toContain('source_record.promote');
    expect(actionsForTrustState('P1_NORMALIZED')).toContain('source_record.promote');
  });

  it('leaves nothing to promote at the top of the ladder', () => {
    const actions = actionsForTrustState('P4_DIRECT');

    expect(actions).not.toContain('source_record.promote');
    // Suppression still applies: a person may always ask to stop being
    // contacted, however trusted the record is.
    expect(actions).toContain('suppression.apply');
  });

  it('intersects the state with the caller policy verdict', () => {
    // A Rep may normalize but not promote, so a P1 row offers neither promote
    // nor an action they would be refused for on click.
    const repPermits = new Set(['source_record.normalize', 'suppression.apply']);

    expect(availableActions('P1_NORMALIZED', repPermits)).toEqual(['suppression.apply']);
    expect(availableActions('P0_CAPTURED', repPermits)).toEqual([
      'source_record.normalize',
      'suppression.apply',
    ]);
  });

  it('offers nothing to a caller the policy permits nothing', () => {
    expect(availableActions('P2_CANDIDATE', new Set())).toEqual([]);
  });

  it('never offers an action the state forbids, however broad the permission', () => {
    // Policy permitting everything must not resurrect a transition the state
    // machine does not allow.
    const everything = new Set([
      'source_record.normalize',
      'source_record.promote',
      'identity.link.verify',
      'suppression.apply',
    ]);

    expect(availableActions('P4_DIRECT', everything)).toEqual(['suppression.apply']);
  });
});

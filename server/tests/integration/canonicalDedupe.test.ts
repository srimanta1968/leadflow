import { randomUUID } from 'crypto';
import {
  DEDUP_WINDOW_MINUTES,
  acknowledgementIsSuppressed,
  canonicalKeys,
  claimAcknowledgement,
  dedupeAndRecord,
  normaliseEmail,
  normalisePhone,
  normaliseSocialId,
} from '../../src/features/intake/canonicalDedupe';
import { REQUIRED_FIELDS, evaluateActivationGate } from '../../src/features/intake/activationGate';
import { dataService } from '../../src/services/DataService';

/**
 * Canonical dedupe and the activation gate.
 *
 * Integration, because both guarantees are enforced against real rows: dedupe
 * by an indexed lookup over normalised columns, and the gate by reading the
 * record's actual state. A mocked data layer would assert the mock.
 */

beforeAll(async () => {
  await dataService.query("DELETE FROM lead_source_event WHERE platform LIKE 'ded-%'", []);
  await dataService.query("DELETE FROM leads WHERE name LIKE 'DEDUP-TEST%'", []);
});

/** A signal for the same person, arriving by a named platform. */
function signal(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'ded-web',
    sourceEventId: `ded-${randomUUID()}`,
    name: 'DEDUP-TEST Priya Raman',
    ...overrides,
  };
}

describe('normalisation', () => {
  it('lower-cases and trims an email', () => {
    expect(normaliseEmail('  Priya@Example.TEST ')).toBe('priya@example.test');
  });

  it('does NOT strip dots or +suffix', () => {
    // Those are Gmail conventions, not standards. Applying them universally
    // would merge two genuinely different mailboxes at any provider that treats
    // the local part literally — and over-merging puts two people's data in one
    // record, which is far worse than a split one.
    expect(normaliseEmail('p.riya+news@example.test')).toBe('p.riya+news@example.test');
    expect(normaliseEmail('priya@example.test')).not.toBe(
      normaliseEmail('p.riya+news@example.test')
    );
  });

  it('rejects a string that is not an address', () => {
    expect(normaliseEmail('not-an-email')).toBeNull();
    expect(normaliseEmail('')).toBeNull();
  });

  it('strips phone formatting but keeps a leading +', () => {
    expect(normalisePhone('+44 (0)7700 900-123')).toBe('+4407700900123');
    expect(normalisePhone('07700 900123')).toBe('07700900123');
  });

  it('does NOT guess a country code', () => {
    // Assuming a default is how a UK 07700 and a differently-prefixed number
    // collide, and the guess is invisible once stored. Two numbers match only
    // if they normalise identically, so an ambiguous one fails to match rather
    // than matching wrongly.
    expect(normalisePhone('07700900123')).not.toBe(normalisePhone('+447700900123'));
  });

  it('rejects a fragment too short to be dialable', () => {
    // Otherwise a reference number or an extension could match another
    // record's fragment.
    expect(normalisePhone('12345')).toBeNull();
  });

  it('drops a leading @ from a social handle', () => {
    expect(normaliseSocialId('@PriyaRaman')).toBe('priyaraman');
  });

  it('reports each key independently', () => {
    const keys = canonicalKeys({ email: 'A@B.test', phone: 'nope', socialId: '@x' });
    expect(keys.email).toBe('a@b.test');
    expect(keys.phone).toBeNull();
    expect(keys.socialId).toBe('x');
  });
});

describe('the acceptance case: three signals, one record, three events', () => {
  it('merges three simultaneous signals for the same person', async () => {
    const email = `dedup.${Date.now()}@example.test`;
    const phone = '+447700900987';
    const social = `@dedup${Date.now()}`;

    // Three platforms, three different keys, one human.
    const first = await dedupeAndRecord(signal({ platform: 'ded-web', email }));
    const second = await dedupeAndRecord(signal({ platform: 'ded-phone', email, phone }));
    const third = await dedupeAndRecord(signal({ platform: 'ded-social', email, socialId: social }));

    // ONE record.
    expect(second.leadId).toBe(first.leadId);
    expect(third.leadId).toBe(first.leadId);
    expect(first.merged).toBe(false);
    expect(second.merged).toBe(true);

    // THREE preserved source events.
    expect(third.sourceEventCount).toBe(3);
  });

  it('records WHICH key matched, so a merge is auditable', async () => {
    const email = `match.${Date.now()}@example.test`;
    await dedupeAndRecord(signal({ platform: 'ded-a', email }));
    const merged = await dedupeAndRecord(signal({ platform: 'ded-b', email }));

    // "Why did you think these were the same person" is the first question of
    // any merge audit.
    expect(merged.matchedOn).toBe('email');
  });

  it('matches on ANY key, not all of them', async () => {
    const phone = '+447700900555';
    const created = await dedupeAndRecord(signal({ platform: 'ded-call', phone }));
    // A DM from the same person shares no email — requiring every key would
    // create a second record for somebody plainly the same human.
    const byPhone = await dedupeAndRecord(signal({ platform: 'ded-dm', phone }));

    expect(byPhone.leadId).toBe(created.leadId);
    expect(byPhone.matchedOn).toBe('phone');
  });

  it('ENRICHES a record with a key it lacked', async () => {
    const email = `enrich.${Date.now()}@example.test`;
    const created = await dedupeAndRecord(signal({ platform: 'ded-web', email }));
    await dedupeAndRecord(signal({ platform: 'ded-call', email, phone: '+447700900444' }));

    const row = await dataService.queryOne<{ canonical_phone: string | null }>(
      'SELECT canonical_phone FROM leads WHERE id = $1',
      [created.leadId]
    );
    expect(row?.canonical_phone).toBe('+447700900444');
  });

  it('does NOT overwrite a key the record already has', async () => {
    const email = `keep.${Date.now()}@example.test`;
    const created = await dedupeAndRecord(signal({ platform: 'ded-a', email, phone: '+447700900111' }));
    // A later signal carrying a DIFFERENT phone must not repoint the record —
    // silently changing a record's contact details is how a merge becomes a
    // hijack.
    await dedupeAndRecord(signal({ platform: 'ded-b', email, phone: '+447700900222' }));

    const row = await dataService.queryOne<{ canonical_phone: string }>(
      'SELECT canonical_phone FROM leads WHERE id = $1',
      [created.leadId]
    );
    expect(row?.canonical_phone).toBe('+447700900111');
  });

  it('preserves the consent captured WITH each signal, separately', async () => {
    const email = `consent.${Date.now()}@example.test`;
    const created = await dedupeAndRecord(
      signal({ platform: 'ded-x', email, consent: { marketing: true } })
    );
    await dedupeAndRecord(signal({ platform: 'ded-y', email, consent: { marketing: false } }));

    const rows = await dataService.query<{ consent_snapshot: Record<string, unknown> }>(
      'SELECT consent_snapshot FROM lead_source_event WHERE lead_id = $1 ORDER BY recorded_at',
      [created.leadId]
    );
    // Two signals can carry DIFFERENT permissions. Flattening them onto the
    // merged record would silently upgrade the weaker one.
    expect(rows).toHaveLength(2);
    expect(rows[0].consent_snapshot).toMatchObject({ marketing: true });
    expect(rows[1].consent_snapshot).toMatchObject({ marketing: false });
  });

  it('counts a replayed event once', async () => {
    const email = `replay.${Date.now()}@example.test`;
    const eventId = `ded-replay-${randomUUID()}`;
    await dedupeAndRecord({ platform: 'ded-web', sourceEventId: eventId, email, name: 'DEDUP-TEST R' });
    const again = await dedupeAndRecord({
      platform: 'ded-web',
      sourceEventId: eventId,
      email,
      name: 'DEDUP-TEST R',
    });

    expect(again.sourceEventCount).toBe(1);
  });
});

describe('the 30-minute acknowledgement window', () => {
  it('is 30 minutes', () => {
    expect(DEDUP_WINDOW_MINUTES).toBe(30);
  });

  it('does not suppress when nothing has been acknowledged', () => {
    expect(acknowledgementIsSuppressed(null)).toBe(false);
  });

  it('SUPPRESSES a repeat inside the window', () => {
    const fourMinutesAgo = new Date(Date.now() - 4 * 60000);
    // Three signals in five minutes should produce ONE "thanks, we have this".
    // Sending three is how a keen prospect concludes the system is broken.
    expect(acknowledgementIsSuppressed(fourMinutesAgo)).toBe(true);
  });

  it('allows one again once the window has passed', () => {
    const thirtyOneMinutesAgo = new Date(Date.now() - 31 * 60000);
    expect(acknowledgementIsSuppressed(thirtyOneMinutesAgo)).toBe(false);
  });

  it('claims the acknowledgement once and refuses the second', async () => {
    const created = await dedupeAndRecord(signal({ email: `ack.${Date.now()}@example.test` }));

    expect(await claimAcknowledgement(created.leadId)).toBe(true);
    // The second signal arrives four minutes later and must NOT acknowledge.
    expect(await claimAcknowledgement(created.leadId)).toBe(false);
  });

  it('allows it again after the window, using an explicit clock', async () => {
    const created = await dedupeAndRecord(signal({ email: `ack2.${Date.now()}@example.test` }));
    await claimAcknowledgement(created.leadId);

    const later = new Date(Date.now() + (DEDUP_WINDOW_MINUTES + 1) * 60000);
    expect(await claimAcknowledgement(created.leadId, later)).toBe(true);
  });
});

describe('the activation gate', () => {
  it('names EVERY missing field, not just the first', async () => {
    const created = await dedupeAndRecord(signal({ email: `gate.${Date.now()}@example.test` }));
    const verdict = await evaluateActivationGate(created.leadId);

    expect(verdict?.state).toBe('blocked');
    // A gate that stops at the first failure turns completing a record into a
    // guessing game — fill one field, resubmit, be told about the next.
    expect(verdict!.missing.length).toBeGreaterThan(1);
  });

  it('explains WHY each field is required', async () => {
    const created = await dedupeAndRecord(signal({ email: `why.${Date.now()}@example.test` }));
    const verdict = await evaluateActivationGate(created.leadId);

    for (const missing of verdict!.missing) {
      expect(missing.reason.length).toBeGreaterThan(30);
      // And what would have satisfied it, so the operator knows their options.
      expect(missing.satisfiedByAnyOf.length).toBeGreaterThan(0);
    }
  });

  it('groups the gaps so a manager sees where the problem is', async () => {
    const created = await dedupeAndRecord(signal({ email: `grp.${Date.now()}@example.test` }));
    const verdict = await evaluateActivationGate(created.leadId);

    const total =
      verdict!.byGroup.identity_and_source +
      verdict!.byGroup.ownership_and_lifecycle +
      verdict!.byGroup.communication_and_commercial;
    expect(total).toBe(verdict!.missing.length);
  });

  it('treats a one-of requirement as satisfied by ANY member', () => {
    // "Usable phone, email or social id" is ONE requirement met three ways.
    // Listing them separately would block a perfectly contactable record for
    // lacking two channels it never needed.
    const channel = REQUIRED_FIELDS.find((f) => f.field === 'contactable_channel');
    expect(channel?.oneOf).toEqual(['email', 'phone', 'social_id']);
  });

  it('MARKS the record blocked, which is what makes it manager-visible', async () => {
    const created = await dedupeAndRecord(signal({ email: `vis.${Date.now()}@example.test` }));
    await evaluateActivationGate(created.leadId);

    const row = await dataService.queryOne<{ activation_state: string }>(
      'SELECT activation_state FROM leads WHERE id = $1',
      [created.leadId]
    );
    // The marker is local and does not depend on the incident SDK, so the
    // record stays in the integrity queue even during an upstream outage — a
    // silently incomplete record is the worse outcome, sitting in the pipeline
    // looking like every other lead while being unworkable.
    expect(row?.activation_state).toBe('blocked');
  });

  it('returns null for a lead that does not exist', async () => {
    expect(await evaluateActivationGate('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('covers all three SOP groups', () => {
    const groups = new Set(REQUIRED_FIELDS.map((f) => f.group));
    expect(groups).toEqual(
      new Set(['identity_and_source', 'ownership_and_lifecycle', 'communication_and_commercial'])
    );
  });
});

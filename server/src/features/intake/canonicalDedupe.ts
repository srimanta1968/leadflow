import { dataService } from '../../services/DataService';

/** How long after an acknowledgement a repeat is suppressed. */
export const DEDUP_WINDOW_MINUTES = 30;

/** Which key matched an incoming signal onto an existing record. */
export type MatchedOn = 'email' | 'phone' | 'social_id' | 'open_opportunity' | 'new';

export interface CanonicalKeys {
  email: string | null;
  phone: string | null;
  socialId: string | null;
}

export interface DedupeResult {
  leadId: string;
  /** False when this signal created the record rather than joining one. */
  merged: boolean;
  matchedOn: MatchedOn;
  /** True when an acknowledgement was already sent inside the window. */
  acknowledgementSuppressed: boolean;
  /** How many source events now contribute to this record. */
  sourceEventCount: number;
}

/**
 * Normalise an email for comparison.
 *
 * Lower-cased and trimmed, and NOTHING ELSE. Specifically it does not strip
 * dots or `+suffix` from the local part: those are Gmail conventions, not
 * standards, and applying them universally would merge two genuinely different
 * mailboxes at any provider that treats the local part literally. Over-merging
 * is the expensive direction — a wrongly split record is an annoyance, a
 * wrongly merged one puts two people's data in one place.
 */
export function normaliseEmail(email: string | null | undefined): string | null {
  if (typeof email !== 'string') {
    return null;
  }
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 && trimmed.includes('@') ? trimmed : null;
}

/**
 * Normalise a phone number towards E.164.
 *
 * Strips formatting and keeps a leading `+`. A number with no country code is
 * returned digits-only rather than guessed at: assuming a default country is
 * how a UK 07700 and a US 07700-prefixed number collide, and the guess is
 * invisible once stored. Two numbers only match if they normalise identically,
 * so an ambiguous one simply fails to match rather than matching wrongly.
 */
export function normalisePhone(phone: string | null | undefined): string | null {
  if (typeof phone !== 'string') {
    return null;
  }
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7) {
    // Too short to be a dialable number anywhere. Returning it would let a
    // reference number or an extension match another record's fragment.
    return null;
  }
  return hasPlus ? `+${digits}` : digits;
}

/** Normalise a social handle: lower-cased, without a leading @. */
export function normaliseSocialId(socialId: string | null | undefined): string | null {
  if (typeof socialId !== 'string') {
    return null;
  }
  const trimmed = socialId.trim().toLowerCase().replace(/^@/, '');
  return trimmed.length > 0 ? trimmed : null;
}

/** Build the canonical keys for a signal. */
export function canonicalKeys(input: {
  email?: string | null;
  phone?: string | null;
  socialId?: string | null;
}): CanonicalKeys {
  return {
    email: normaliseEmail(input.email),
    phone: normalisePhone(input.phone),
    socialId: normaliseSocialId(input.socialId),
  };
}

/**
 * Find an existing record for these keys.
 *
 * ANY key matching is a match — they are alternatives, not a composite. The
 * same person reaching us by web form and by DM shares neither email nor phone,
 * and requiring all of them would create a second record for somebody we can
 * plainly see is the same human.
 *
 * Order of preference is email, then phone, then social id: email is the most
 * specific of the three and the least likely to be shared between people, where
 * a household phone or a shared brand account genuinely can be.
 */
export async function findCanonical(
  keys: CanonicalKeys
): Promise<{ leadId: string; matchedOn: MatchedOn } | null> {
  const probes: { column: string; value: string; matchedOn: MatchedOn }[] = [];
  if (keys.email) {
    probes.push({ column: 'canonical_email', value: keys.email, matchedOn: 'email' });
  }
  if (keys.phone) {
    probes.push({ column: 'canonical_phone', value: keys.phone, matchedOn: 'phone' });
  }
  if (keys.socialId) {
    probes.push({ column: 'canonical_social_id', value: keys.socialId, matchedOn: 'social_id' });
  }

  for (const probe of probes) {
    const row = await dataService.queryOne<{ id: string }>(
      `SELECT id FROM leads WHERE ${probe.column} = $1 ORDER BY created_at ASC LIMIT 1`,
      [probe.value]
    );
    if (row) {
      // The OLDEST match, so repeated merges converge on one record rather than
      // ping-ponging between two that both carry the key.
      return { leadId: row.id, matchedOn: probe.matchedOn };
    }
  }

  return null;
}

/**
 * Whether an acknowledgement was already sent inside the dedup window.
 *
 * The window protects the ACKNOWLEDGEMENT, not the record. Three signals in
 * five minutes should produce one record and one "thanks, we have this" — the
 * person is not helped by three, and sending them is how a keen prospect
 * concludes the system is broken.
 */
export function acknowledgementIsSuppressed(
  acknowledgedAt: Date | null,
  now: Date = new Date()
): boolean {
  if (!acknowledgedAt) {
    return false;
  }
  const elapsedMinutes = (now.getTime() - acknowledgedAt.getTime()) / 60000;
  return elapsedMinutes < DEDUP_WINDOW_MINUTES;
}

/**
 * Merge a signal onto a canonical record, or create one.
 *
 * EVERY SOURCE EVENT IS PRESERVED, whichever way it goes. That is the
 * acceptance case: three simultaneous signals for one person produce one
 * canonical record and three source-event rows. Discarding the losers would
 * destroy the provenance that says why the record exists — and the consent
 * captured alongside each signal, which belongs to the event that collected it
 * rather than to the merged record.
 */
export async function dedupeAndRecord(input: {
  platform: string;
  sourceEventId: string;
  email?: string | null;
  phone?: string | null;
  socialId?: string | null;
  name?: string | null;
  consent?: Record<string, unknown> | null;
  occurredAt?: string | null;
}): Promise<DedupeResult> {
  const keys = canonicalKeys(input);
  const existing = await findCanonical(keys);

  let leadId: string;
  let matchedOn: MatchedOn;
  let merged: boolean;
  let acknowledgedAt: Date | null = null;

  if (existing) {
    leadId = existing.leadId;
    matchedOn = existing.matchedOn;
    merged = true;

    const row = await dataService.queryOne<{ acknowledged_at: Date | null }>(
      `UPDATE leads
          SET canonical_email     = COALESCE(canonical_email, $2),
              canonical_phone     = COALESCE(canonical_phone, $3),
              canonical_social_id = COALESCE(canonical_social_id, $4),
              updated_at          = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING acknowledged_at`,
      [leadId, keys.email, keys.phone, keys.socialId]
    );
    // COALESCE, so a signal carrying a key the record lacks ENRICHES it while a
    // signal carrying a different value for a key it already has cannot
    // overwrite it. Silently repointing a record's email is how a merge turns
    // into a hijack.
    acknowledgedAt = row?.acknowledged_at ?? null;
  } else {
    matchedOn = 'new';
    merged = false;
    const row = await dataService.queryOne<{ id: string }>(
      `INSERT INTO leads (name, email, source, canonical_email, canonical_phone, canonical_social_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [input.name ?? null, input.email ?? null, input.platform, keys.email, keys.phone, keys.socialId]
    );
    leadId = row!.id;
  }

  // ON CONFLICT DO NOTHING: a replayed webhook must not add a second
  // contribution row for a signal already counted.
  await dataService.query(
    `INSERT INTO lead_source_event
       (lead_id, platform, source_event_id, matched_on, consent_snapshot, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [
      leadId,
      input.platform,
      input.sourceEventId,
      matchedOn,
      input.consent ? JSON.stringify(input.consent) : null,
      input.occurredAt ? new Date(input.occurredAt) : null,
    ]
  );

  const counted = await dataService.queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM lead_source_event WHERE lead_id = $1`,
    [leadId]
  );

  return {
    leadId,
    merged,
    matchedOn,
    // Computed from the record's own acknowledged_at, not hardcoded. A merge
    // onto a record acknowledged four minutes ago must report the suppression,
    // because that is the whole point of the window.
    acknowledgementSuppressed: acknowledgementIsSuppressed(acknowledgedAt),
    sourceEventCount: parseInt(counted?.count ?? '0', 10),
  };
}

/**
 * Record that an acknowledgement was sent, if the window allows it.
 *
 * @returns true when the acknowledgement should be sent, false when it is
 *          suppressed because one went out inside the window.
 */
export async function claimAcknowledgement(
  leadId: string,
  now: Date = new Date()
): Promise<boolean> {
  const row = await dataService.queryOne<{ acknowledged_at: Date | null }>(
    'SELECT acknowledged_at FROM leads WHERE id = $1',
    [leadId]
  );
  if (!row) {
    return false;
  }

  if (acknowledgementIsSuppressed(row.acknowledged_at, now)) {
    return false;
  }

  await dataService.query('UPDATE leads SET acknowledged_at = $2 WHERE id = $1', [leadId, now]);
  return true;
}

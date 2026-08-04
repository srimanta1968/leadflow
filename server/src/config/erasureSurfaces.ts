/**
 * Every LeadFlow-local surface that can hold data about a data subject.
 *
 * THE CERTIFICATE IS ONLY AS HONEST AS THIS LIST. An erasure certificate names
 * a shred proof per surface; a surface missing here produces a certificate that
 * says the subject's data is gone while it is still sitting in a table. That is
 * worse than an incomplete erasure — it is a false attestation, and the person
 * relying on it has no way to know.
 *
 * Enumerated from the actual migrations rather than from memory. Verified
 * against server/src/db/migrations: the schema holds leads, users,
 * routing_rules, sla_metrics, sla_alerts, sla_policies, offline_capture_sync,
 * intake_event, intake_outage_queue and lead_source_event — and each is classified below, including the ones that
 * hold NOTHING, because "we checked and it is clean" and "we forgot it
 * existed" must not look alike. `erasurePlan.test.ts` reads the live schema and
 * fails if a table is added without a decision here, which is how this list
 * stays true rather than merely starting true.
 */

/** How a surface is cleared. */
export type ErasureMethod =
  /** Row deleted outright. */
  | 'delete'
  /** Personal columns nulled, the row kept because something references it. */
  | 'redact'
  /** Encryption key destroyed, ciphertext left unreadable. */
  | 'crypto_shred'
  /** Nothing to do — recorded so the check is visible. */
  | 'no_subject_data';

export interface ErasureSurface {
  /** Table or store name. */
  surface: string;
  method: ErasureMethod;
  /** Columns carrying personal data, empty when none do. */
  personalColumns: string[];
  /** Why this method and not another. */
  rationale: string;
}

export const ERASURE_SURFACES: ErasureSurface[] = [
  {
    surface: 'leads',
    method: 'redact',
    personalColumns: ['name', 'email', 'canonical_email', 'canonical_phone', 'canonical_social_id'],
    rationale:
      'The primary subject surface, and it holds LESS than it looks. The local projection stores name, email and source only — phone, company, message and utm are accepted by the capture validator and asserted upstream, never inserted here. This list previously named all six, and the four phantom columns would have made erasure fail with "column does not exist" at the exact moment somebody exercised their erasure right, on a path nobody walks in normal use. `erasurePlan.test.ts` now checks every named column against the live schema so it cannot drift again. The fields held upstream are cleared through the source record, which is a different surface and not this list. The canonical_* columns are NORMALISED COPIES of the same personal data, added for dedupe, and they must be redacted too — leaving them would keep the email and phone in the very table designed to be probed on every inbound signal. Doing so also stops an erased person being deduped against, which is correct: a later signal from them starts a fresh record rather than resurrecting the one they asked to be erased. REDACTED rather than deleted: sla_metrics, sla_alerts and every routing decision reference the lead id, and deleting the row would either cascade away the compliance record or break the FK. Nulling the personal columns removes the person while leaving the fact that a lead existed and was handled, which is what an SLA audit needs.',
  },
  {
    surface: 'users',
    method: 'redact',
    personalColumns: ['first_name', 'last_name', 'email', 'phone', 'username'],
    rationale:
      'Operators are data subjects too, and an employee erasure request is as valid as a prospect\'s. Redacted, not deleted, for the same reason: users.id is the target of five foreign keys across four tables, and removing it would erase who handled a lead rather than just who they were.',
  },
  {
    surface: 'sla_metrics',
    method: 'redact',
    personalColumns: ['note'],
    rationale:
      'Holds subject_lead_id plus a free-text note an operator wrote, which routinely quotes what the person said. The note is the only personal field; the timings and clock provenance are about our own performance and are retained.',
  },
  {
    surface: 'sla_alerts',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'References lead_id and recipient_user_id but stores no personal values of its own, so it is cleared transitively by the two surfaces above. Listed explicitly so a future column addition is a visible change to this file rather than a silent gap.',
  },
  {
    surface: 'routing_rules',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'Configuration. Holds assigned_user_id as a pointer, never personal values.',
  },
  {
    surface: 'sla_policies',
    method: 'no_subject_data',
    personalColumns: [],
    rationale: 'Configuration only — response targets by lead type.',
  },
  {
    surface: 'analytics_rollups',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'DELIBERATE FINDING, not an omission. LeadFlow stores no rollup table: AnalyticsService aggregates over the leads table at query time, so once leads is redacted the dashboard reflects it on the next read with nothing further to shred. Recorded because the task brief names dashboard rollups as a surface, and the honest answer is that this app does not have one.',
  },
  {
    surface: 'template_merge_cache',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'Named in the brief; does not exist in LeadFlow today. Listed so that adding one later forces a decision here rather than quietly creating an unerasable surface.',
  },
  {
    surface: 'client_saved_view',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'The analytics saved view lives in the operator\'s own browser localStorage, not on the server, and holds filter selections — which can include an owner_user_id. It is out of reach of a server-side erasure and belongs to the operator\'s device rather than the tenant. Flagged so it is a known limit of the certificate rather than an unexamined one.',
  },
  {
    surface: 'offline_capture_sync',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'The idempotency ledger for offline sync. Holds a device-generated capture id, the source record id it produced, the capture kind and two timestamps — no name, no contact point, no captured content. The evidence itself lives in the source record, which is where erasure acts. AND THE ROW MUST BE KEPT, not merely left alone: if an erasure deleted it, a device still holding that capture in its queue would sync again, the server would see an id it has never seen, and it would create a NEW source record for the person just erased. Retaining the row is what makes the erasure stick — the replay answers duplicate and creates nothing. Deleting it would quietly undo the erasure through the most ordinary action in the system, a phone reconnecting.',
  },
  {
    surface: 'intake_event',
    method: 'redact',
    personalColumns: ['raw_payload'],
    rationale:
      'The raw intake archive. raw_payload holds whatever the platform sent — names, emails, phone numbers, call transcripts — so it is a real subject surface, and leaving it while redacting the lead would defeat the erasure entirely: the same personal data would still sit here, in the table specifically designed to survive everything else. REDACTED, NOT DELETED, for the same reason as the offline sync ledger: the row IS the replay key. Delete it and the next redelivery of that webhook looks new, and a lead is recreated for the person just erased — the erasure undone by a provider retry nobody controls. Nulling raw_payload removes the person while the (platform, source_event_id) pair stays to keep refusing the replay. What remains is that an event arrived and what became of it, which is the provenance record an audit needs and carries nothing about who it concerned.',
  },
  {
    surface: 'intake_outage_queue',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'Holds a platform, a source event id, which dependency was down, an attempt count and timestamps. No payload and no personal data — the content it refers to lives in intake_event, which is where erasure acts. Kept rather than cleared so the record of a delay survives: "this event sat queued for four hours during an outage" is exactly what gets asked afterwards, and a draining backfill would in any case find a redacted payload and create nothing.',
  },
  {
    surface: 'lead_source_event',
    method: 'no_subject_data',
    personalColumns: [],
    rationale:
      'One row per source event that contributed to a canonical lead. Holds a lead id, the platform, the event id that platform issued, which dedupe key matched, and a consent snapshot — no name, email, phone or handle. The person is identified only through lead_id, which the leads surface redacts. KEPT rather than cleared, and consent is the reason: the snapshot is the proof of what was permitted at the moment each signal arrived, including a revocation, and erasing it would destroy the evidence that the erasure itself was honoured. SOP §03 is explicit that a merge preserves every source event and consent record; erasure does not get to undo that, because the record of a privacy action must outlive the data it acted on.',
  },
];

/** Surfaces that actually require an erasure action. */
export function actionableSurfaces(): ErasureSurface[] {
  return ERASURE_SURFACES.filter((surface) => surface.method !== 'no_subject_data');
}

/** Every surface name, for reconciling a certificate against the plan. */
export function allSurfaceNames(): string[] {
  return ERASURE_SURFACES.map((surface) => surface.surface);
}

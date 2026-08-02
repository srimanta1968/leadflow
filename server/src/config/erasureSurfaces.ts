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
 * against server/src/db/migrations: the schema holds exactly six tables —
 * leads, users, routing_rules, sla_metrics, sla_alerts and sla_policies — and
 * each is classified below, including the ones that hold NOTHING, because
 * "we checked and it is clean" and "we forgot it existed" must not look alike.
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
    personalColumns: ['name', 'email', 'phone', 'company', 'message', 'utm'],
    rationale:
      'The primary subject surface. REDACTED rather than deleted: sla_metrics, sla_alerts and every routing decision reference the lead id, and deleting the row would either cascade away the compliance record or break the FK. Nulling the personal columns removes the person while leaving the fact that a lead existed and was handled, which is what an SLA audit needs.',
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
];

/** Surfaces that actually require an erasure action. */
export function actionableSurfaces(): ErasureSurface[] {
  return ERASURE_SURFACES.filter((surface) => surface.method !== 'no_subject_data');
}

/** Every surface name, for reconciling a certificate against the plan. */
export function allSurfaceNames(): string[] {
  return ERASURE_SURFACES.map((surface) => surface.surface);
}

import { dataService } from '../../services/DataService';
import { config } from '../../config/env';

/**
 * Ownership, acceptance clocks and the zero-orphan validator. SOP §02 and §30.
 *
 * THE ONE RULE EVERYTHING ELSE SERVES: the response clock runs from when the
 * LEAD ARRIVED, not from when its current owner got it. Every handover — accept,
 * decline, manager reassign, backup takeover — moves `assigned_at` and leaves
 * `source_timestamp` and `sla_due_at` exactly where they were.
 *
 * That is enforced in three places, deliberately. A BEFORE UPDATE trigger makes
 * a changed source_timestamp raise; every statement here writes the assignment
 * columns and never that one; and each handover records the clock it saw into
 * leadflow_ownership_event, so the invariant is CHECKABLE after the fact rather
 * than only assertable at the time.
 */

/** How long a rep has to accept before the backup may take over. SOP §02. */
export const ACCEPTANCE_MINUTES = 5;

/** When capacity freezing begins for new P1 work. SOP §30. */
export const CAPACITY_FREEZE_MINUTES = 25;

/** Open work at which a rep is considered overloaded. */
export const CAPACITY_LIMIT = 15;

/** The fields an open record must carry to not be an orphan. SOP §30. */
export const REQUIRED_FIELDS = [
  'owner_user_id',
  'backup_user_id',
  'stage',
  'priority',
  'next_action',
  'next_due_at',
  'intended_outcome',
] as const;

export type RequiredField = (typeof REQUIRED_FIELDS)[number];

/** One ownership act. */
export type OwnershipEventKind =
  | 'assigned'
  | 'accepted'
  | 'declined'
  | 'reassigned'
  | 'backup_takeover'
  | 'capacity_frozen';

export interface LeadOwnershipRow {
  id: string;
  owner_user_id: string | null;
  backup_user_id: string | null;
  manager_user_id: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  assigned_at: string | null;
  source_timestamp: string | null;
  sla_due_at: string | null;
  closed_at: string | null;
  stage: string | null;
  priority: string | null;
  next_action: string | null;
  next_due_at: string | null;
  intended_outcome: string | null;
}

const LEAD_COLUMNS = `id, owner_user_id, backup_user_id, manager_user_id, accepted_at,
  declined_at, decline_reason, assigned_at, source_timestamp, sla_due_at, closed_at,
  stage, priority, next_action, next_due_at, intended_outcome`;

export async function readLead(leadId: string): Promise<LeadOwnershipRow | null> {
  const rows = await dataService.query<LeadOwnershipRow>(
    `SELECT ${LEAD_COLUMNS} FROM leads WHERE id = $1`,
    [leadId]
  );
  return rows[0] ?? null;
}

/** Append one ownership act, carrying the clock it saw. */
export async function recordEvent(input: {
  leadId: string;
  kind: OwnershipEventKind;
  fromUserId?: string | null;
  toUserId?: string | null;
  reason?: string | null;
  sourceTimestamp: string | null;
  slaDueAt: string | null;
  actorUserId: string | null;
}): Promise<void> {
  await dataService.query(
    `INSERT INTO leadflow_ownership_event
       (tenant_id, lead_id, kind, from_user_id, to_user_id, reason,
        source_timestamp, sla_due_at, actor_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      config.projexCloud.tenantId,
      input.leadId,
      input.kind,
      input.fromUserId ?? null,
      input.toUserId ?? null,
      input.reason ?? null,
      input.sourceTimestamp,
      input.slaDueAt,
      input.actorUserId,
    ]
  );
}

/**
 * Record acceptance.
 *
 * STAMPS accepted_at AND NOTHING ELSE about the clock. Accepting is the rep
 * saying they have it; it is not a new lead and it does not buy them more time.
 */
export async function acceptLead(leadId: string, userId: string): Promise<LeadOwnershipRow | null> {
  const rows = await dataService.query<LeadOwnershipRow>(
    `UPDATE leads
        SET accepted_at = COALESCE(accepted_at, now()),
            declined_at = NULL,
            decline_reason = NULL,
            updated_at = now()
      WHERE id = $1 AND owner_user_id = $2
      RETURNING ${LEAD_COLUMNS}`,
    [leadId, userId]
  );
  return rows[0] ?? null;
}

/**
 * Decline, and hand straight to the backup.
 *
 * ONE STATEMENT, because the alternative loses leads. A decline that clears the
 * owner and then fails before setting the backup leaves an unowned record with a
 * running clock and nobody watching it — which is precisely the orphan the
 * validator exists to catch, manufactured by the code meant to prevent it.
 *
 * THE BACKUP BECOMES THE OWNER AND THE OWNER SLOT IS NOT LEFT EMPTY. When there
 * is no backup the decline is REFUSED by the caller rather than executed, for
 * the same reason.
 *
 * source_timestamp and sla_due_at are untouched: the customer has been waiting
 * exactly as long as they were before somebody declined.
 */
export async function declineToBackup(input: {
  leadId: string;
  decliningUserId: string;
  reason: string;
}): Promise<LeadOwnershipRow | null> {
  const rows = await dataService.query<LeadOwnershipRow>(
    `UPDATE leads
        SET owner_user_id  = backup_user_id,
            backup_user_id = NULL,
            declined_at    = now(),
            decline_reason = $3,
            accepted_at    = NULL,
            assigned_at    = now(),
            updated_at     = now()
      WHERE id = $1
        AND owner_user_id = $2
        AND backup_user_id IS NOT NULL
      RETURNING ${LEAD_COLUMNS}`,
    [input.leadId, input.decliningUserId, input.reason]
  );
  return rows[0] ?? null;
}

/**
 * Move a lead to a new owner.
 *
 * `assigned_at` moves and the clock does not. The WHERE clause deliberately does
 * NOT require the caller to be the current owner: a manager reassigning from an
 * alert is the main path, and requiring ownership would make the one-click
 * reassign impossible for the person it exists for.
 */
export async function reassignLead(input: {
  leadId: string;
  toUserId: string;
  backupUserId?: string | null;
}): Promise<LeadOwnershipRow | null> {
  const rows = await dataService.query<LeadOwnershipRow>(
    `UPDATE leads
        SET owner_user_id  = $2,
            backup_user_id = COALESCE($3, backup_user_id),
            accepted_at    = NULL,
            declined_at    = NULL,
            decline_reason = NULL,
            assigned_at    = now(),
            updated_at     = now()
      WHERE id = $1 AND closed_at IS NULL
      RETURNING ${LEAD_COLUMNS}`,
    [input.leadId, input.toUserId, input.backupUserId ?? null]
  );
  return rows[0] ?? null;
}

/** How much open work a rep is carrying. */
export async function openLoad(userId: string): Promise<number> {
  const rows = await dataService.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM leads
      WHERE owner_user_id = $1 AND closed_at IS NULL`,
    [userId]
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Whether a lead is far enough into its life for the capacity freeze to bite.
 *
 * MEASURED FROM THE SOURCE TIMESTAMP, not from assignment. A lead reassigned
 * three times at T+30 is still a T+30 lead, and measuring from the latest
 * handover would reset the freeze every time somebody passed it on — which is
 * exactly the moment the freeze is supposed to start mattering.
 */
export function minutesSinceSource(row: LeadOwnershipRow, now = Date.now()): number | null {
  if (!row.source_timestamp) return null;
  const at = Date.parse(row.source_timestamp);
  if (Number.isNaN(at)) return null;
  return Math.floor((now - at) / 60_000);
}

/** Whether the acceptance window has passed without an accept. */
export function acceptanceOverdue(row: LeadOwnershipRow, now = Date.now()): boolean {
  if (row.accepted_at) return false;
  const elapsed = minutesSinceSource(row, now);
  return elapsed !== null && elapsed >= ACCEPTANCE_MINUTES;
}

/**
 * The capacity verdict for putting a P1 lead on this rep.
 *
 * FROZEN ONLY WHEN ALL THREE HOLD: the work is P1, the lead is past T+25, and
 * the rep is already at the limit. Freezing earlier would block ordinary
 * assignment; freezing on load alone would block the manager's one-click
 * reassign in the exact situation it exists for, which is a lead about to
 * breach.
 */
export function capacityVerdict(input: {
  priority: string | null;
  minutesSinceSource: number | null;
  openLoad: number;
}): { frozen: boolean; reason: string | null } {
  const isP1 = (input.priority ?? '').toUpperCase() === 'P1';
  const pastFreeze =
    input.minutesSinceSource !== null && input.minutesSinceSource >= CAPACITY_FREEZE_MINUTES;
  const overloaded = input.openLoad >= CAPACITY_LIMIT;

  if (isP1 && pastFreeze && overloaded) {
    return {
      frozen: true,
      reason: `This rep already holds ${input.openLoad} open records, and a P1 past T+${CAPACITY_FREEZE_MINUTES} must not be added to an overloaded queue. Choose another owner or clear their queue first.`,
    };
  }
  return { frozen: false, reason: null };
}

/** One open record and what it is missing. */
export interface OrphanRow {
  lead_id: string;
  missing: RequiredField[];
  source_timestamp: string | null;
  minutes_since_source: number | null;
  owner_user_id: string | null;
}

/**
 * Every open record missing anything SOP §30 requires.
 *
 * ASSERTED FIELD BY FIELD rather than as one boolean, because "this lead is
 * incomplete" is not actionable and "this lead has no NEXT and no due time" is.
 * The whole point of the validator is that somebody can fix what it finds.
 *
 * SCOPED TO OPEN RECORDS. A won or lost lead legitimately has no next action,
 * and reporting every closed record forever would make the validator a list
 * nobody reads — which is the same as not having one.
 */
export async function findOrphans(limit = 500): Promise<OrphanRow[]> {
  const rows = await dataService.query<LeadOwnershipRow>(
    `SELECT ${LEAD_COLUMNS} FROM leads
      WHERE closed_at IS NULL
        AND (owner_user_id IS NULL OR backup_user_id IS NULL OR stage IS NULL
             OR priority IS NULL OR next_action IS NULL OR next_due_at IS NULL
             OR intended_outcome IS NULL)
      ORDER BY source_timestamp ASC NULLS FIRST
      LIMIT $1`,
    [limit]
  );

  const now = Date.now();
  return rows.map((row) => ({
    lead_id: row.id,
    missing: REQUIRED_FIELDS.filter((field) => {
      const value = row[field as keyof LeadOwnershipRow];
      return value === null || value === undefined || value === '';
    }),
    source_timestamp: row.source_timestamp,
    minutes_since_source: minutesSinceSource(row, now),
    owner_user_id: row.owner_user_id,
  }));
}

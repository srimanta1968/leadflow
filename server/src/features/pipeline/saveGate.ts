import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { STAGES, canMoveStage, evidenceRequiredToEnter, stage } from '../../config/verticalProfile';

/**
 * The NO BLANK NEXT save-gate and the stage guard. SOP §01, §06, §28.
 *
 * THE SAME GATE RUNS SERVER-SIDE. The UI renders a NEXT composer that blocks
 * submit until it is complete, and that is a convenience rather than a control:
 * a client can be bypassed with one curl. So this module is the enforcement, and
 * the UI simply asks it the same question earlier.
 *
 * THE REFUSAL IS STRUCTURED, never a sentence. "Please complete all fields"
 * cannot be rendered against a field, so the operator has to guess which one —
 * and the gate fires on every save, so guessing is a tax on ordinary work. Each
 * refusal names the field, why it is required and what to do.
 */

/** The five things a NEXT must say. SOP §01. */
export const NEXT_FIELDS = ['action_type', 'owner_user_id', 'due_at', 'purpose', 'intended_outcome'] as const;
export type NextField = (typeof NEXT_FIELDS)[number];

/** What an OPEN record must carry beyond its NEXT. SOP §28. */
export const OPEN_RECORD_FIELDS = [
  'owner_user_id', 'backup_user_id', 'stage', 'priority', 'permission_state', 'last_disposition',
] as const;

/** One refusal, addressed to a field. */
export interface FieldRefusal {
  field: string;
  message: string;
  /** What the operator should do, in the words the UI can render verbatim. */
  remedy: string;
}

export interface GateVerdict {
  allowed: boolean;
  refusals: FieldRefusal[];
  /** True when the record is terminal and therefore exempt from the NEXT rule. */
  terminal: boolean;
}

export interface NextDraft {
  action_type?: unknown;
  owner_user_id?: unknown;
  due_at?: unknown;
  purpose?: unknown;
  intended_outcome?: unknown;
}

const present = (value: unknown): boolean =>
  typeof value === 'string' ? value.trim() !== '' : value !== null && value !== undefined;

const FIELD_HELP: Record<NextField, { message: string; remedy: string }> = {
  action_type: {
    message: 'No action type. A NEXT that does not say what will happen cannot be worked by anybody but its author.',
    remedy: 'Choose the action type — call, email, meeting or task.',
  },
  owner_user_id: {
    message: 'No owner. An action with no name against it is an action nobody has agreed to do.',
    remedy: 'Name the person who will carry it out.',
  },
  due_at: {
    message: 'No exact due date and time. "Next week" cannot be queued, reminded on, or reported as overdue.',
    remedy: 'Pick an exact date and time.',
  },
  purpose: {
    message: 'No purpose. Without it the next person to open this record cannot tell why the action was planned.',
    remedy: 'State why this action is being taken.',
  },
  intended_outcome: {
    message: 'No intended outcome. An action with no defined success cannot be judged done or not done.',
    remedy: 'State what a good result looks like.',
  },
};

/**
 * Whether a NEXT is complete.
 *
 * EVERY MISSING FIELD IS REPORTED, not just the first. Returning one at a time
 * turns a five-field form into five round trips, and an operator who is told
 * about one omission at a time reasonably concludes the system is broken.
 */
export function checkNext(draft: NextDraft): FieldRefusal[] {
  const refusals: FieldRefusal[] = [];
  for (const field of NEXT_FIELDS) {
    if (!present(draft[field])) {
      refusals.push({ field, ...FIELD_HELP[field] });
    }
  }
  // A due date that will not parse is worse than an absent one: it looks set.
  if (present(draft.due_at) && Number.isNaN(Date.parse(String(draft.due_at)))) {
    refusals.push({
      field: 'due_at',
      message: 'The due date and time could not be read as a timestamp.',
      remedy: 'Pick the date and time again rather than typing it.',
    });
  }
  return refusals;
}

/** The record as the gate needs to see it. */
export interface GateSubject {
  subject_ref: string;
  stage: string | null;
  owner_user_id: string | null;
  backup_user_id: string | null;
  priority: string | null;
  permission_state: string | null;
  last_disposition: string | null;
  onboarding_accepted: boolean;
  has_open_next: boolean;
}

/**
 * Whether a stage is terminal FOR GATE PURPOSES.
 *
 * CLOSED WON IS NOT TERMINAL until onboarding has been accepted and
 * calendarized. SOP §28 is explicit, and the reason is that the handover is
 * where deals are actually lost after the signature — a record that goes quiet
 * the moment payment clears is the failure this rule exists to prevent. So
 * CLOSED_WON_ONBOARDING_PENDING still requires a NEXT until the handover lands.
 */
export function isTerminalForGate(subject: GateSubject): boolean {
  const def = subject.stage ? stage(subject.stage) : null;
  if (!def) return false;
  if (def.key === 'CLOSED_WON_ONBOARDING_PENDING') return subject.onboarding_accepted;
  return def.terminal;
}

/** The full save-gate verdict for a record. */
export function evaluateGate(subject: GateSubject, draft: NextDraft | null): GateVerdict {
  const terminal = isTerminalForGate(subject);
  if (terminal) return { allowed: true, refusals: [], terminal: true };

  const refusals: FieldRefusal[] = [];

  // The open-record requirement, SOP §28.
  const openChecks: [string, unknown, string][] = [
    ['owner_user_id', subject.owner_user_id, 'An open record with no owner is an orphan.'],
    ['backup_user_id', subject.backup_user_id, 'Without a backup nobody covers this record when its owner is away.'],
    ['stage', subject.stage, 'A record with no stage cannot be worked, reported or aged.'],
    ['priority', subject.priority, 'Priority decides what gets worked first; without it this record competes on nothing.'],
    ['permission_state', subject.permission_state, 'Without a recorded permission state nobody can tell whether this contact may be contacted.'],
    ['last_disposition', subject.last_disposition, 'Without the last outcome the next person repeats the last conversation.'],
  ];
  for (const [field, value, message] of openChecks) {
    if (!present(value)) {
      refusals.push({ field, message, remedy: `Set ${field.replace(/_/g, ' ')} before saving.` });
    }
  }

  /*
   * THE NEXT ITSELF. A draft is checked field by field; with no draft at all the
   * record still passes IF it already carries an open NEXT — saving a note on a
   * record that is already properly queued must not demand a second one.
   */
  if (draft) {
    refusals.push(...checkNext(draft));
  } else if (!subject.has_open_next) {
    refusals.push({
      field: 'next_action',
      message: 'This record has no NEXT. SOP §01 does not permit an open record without one.',
      remedy: 'Add the next action, its owner, its exact due date and time, its purpose and its intended outcome.',
    });
  }

  return { allowed: refusals.length === 0, refusals, terminal: false };
}

/** Read the record the gate is about to judge. */
export async function readSubject(subjectRef: string): Promise<GateSubject | null> {
  const rows = await dataService.query<{
    id: string; stage: string | null; owner_user_id: string | null; backup_user_id: string | null;
    priority: string | null; activation_state: string | null; closed_at: string | null;
  }>(
    `SELECT id, stage, owner_user_id, backup_user_id, priority, activation_state, closed_at
       FROM leads WHERE id::text = $1`,
    [subjectRef]
  );
  const lead = rows[0];
  if (!lead) return null;

  const [nextRows, dispRows] = await Promise.all([
    dataService.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM leadflow_next_action
        WHERE subject_ref = $1 AND completed_at IS NULL`,
      [subjectRef]
    ),
    dataService.query<{ code_key: string }>(
      `SELECT code_key FROM leadflow_disposition_event
        WHERE subject_ref = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [subjectRef]
    ),
  ]);

  return {
    subject_ref: subjectRef,
    stage: lead.stage,
    owner_user_id: lead.owner_user_id,
    backup_user_id: lead.backup_user_id,
    priority: lead.priority,
    // The activation state IS the permission state for a lead: it records
    // whether the record has cleared its consent and required-field gate.
    permission_state: lead.activation_state,
    last_disposition: dispRows[0]?.code_key ?? null,
    onboarding_accepted: false,
    has_open_next: Number(nextRows[0]?.n ?? 0) > 0,
  };
}

/**
 * Record that a save was refused.
 *
 * A BLOCKED SAVE IS VISIBLE TO A MANAGER rather than failing silently. Silence
 * is how a gate becomes something reps route around: nobody sees that the same
 * record has been refused eleven times, so nobody asks why.
 */
export async function raiseIntegrityException(input: {
  subjectRef: string;
  kind: 'blank_next' | 'stage_guard' | 'open_record_incomplete' | 'terminal_without_onboarding';
  missing: string[];
  attemptedBy: string | null;
  detail: string;
}): Promise<string> {
  const rows = await dataService.query<{ exception_id: string }>(
    `INSERT INTO leadflow_integrity_exception
       (tenant_id, subject_ref, kind, missing, attempted_by, detail)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6)
     RETURNING exception_id`,
    [
      config.projexCloud.tenantId, input.subjectRef, input.kind,
      JSON.stringify(input.missing), input.attemptedBy, input.detail,
    ]
  );
  return rows[0].exception_id;
}

/** Save one NEXT, replacing any open one on the same record. */
export async function writeNext(input: {
  subjectRef: string;
  draft: Required<NextDraft>;
  createdBy: string | null;
}): Promise<string> {
  // The previous open NEXT is COMPLETED rather than deleted: what the record was
  // waiting on before is part of its history.
  await dataService.query(
    `UPDATE leadflow_next_action SET completed_at = now()
      WHERE subject_ref = $1 AND completed_at IS NULL`,
    [input.subjectRef]
  );
  const rows = await dataService.query<{ next_id: string }>(
    `INSERT INTO leadflow_next_action
       (tenant_id, subject_ref, action_type, owner_user_id, due_at, purpose, intended_outcome, created_by)
     VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8)
     RETURNING next_id`,
    [
      config.projexCloud.tenantId, input.subjectRef,
      String(input.draft.action_type), String(input.draft.owner_user_id),
      String(input.draft.due_at), String(input.draft.purpose), String(input.draft.intended_outcome),
      input.createdBy,
    ]
  );
  // Mirrored onto the lead so the zero-orphan validator and the pipeline board
  // read one shape rather than joining for every row.
  await dataService.query(
    `UPDATE leads SET next_action = $2, next_due_at = $3::timestamptz, intended_outcome = $4, updated_at = now()
      WHERE id::text = $1`,
    [input.subjectRef, String(input.draft.action_type), String(input.draft.due_at), String(input.draft.intended_outcome)]
  );
  return rows[0].next_id;
}

/** What the stage guard concluded. */
export interface StageGuardVerdict {
  allowed: boolean;
  from: string | null;
  to: string;
  reason: string | null;
  requiredEvidence: string[];
  missingEvidence: string[];
}

/**
 * Whether a record may enter a stage.
 *
 * A ROADMAP FEATURE STATUS CANNOT SATISFY AN EXIT CRITERION. SOP §06 says it and
 * this is where it is enforced: only a dependency recorded as `available`
 * counts. Recording "we promised to build it" as satisfied evidence is how a
 * deal reaches Closed Won on a capability nobody has written.
 */
export async function checkStageGuard(
  subjectRef: string,
  from: string | null,
  to: string
): Promise<StageGuardVerdict> {
  const required = evidenceRequiredToEnter(to);
  const move = from ? canMoveStage(from, to) : { allowed: Boolean(stage(to)), reason: stage(to) ? null : `${to} is not a stage` };

  const deps = await dataService.query<{ capability: string; status: string }>(
    `SELECT capability, status FROM leadflow_feature_dependency WHERE subject_ref = $1`,
    [subjectRef]
  );
  const unmetFeatures = deps.filter((d) => d.status !== 'available');

  const missing: string[] = [];
  if (unmetFeatures.length > 0) {
    for (const dep of unmetFeatures) {
      missing.push(`feature:${dep.capability} is ${dep.status}, not available`);
    }
  }

  return {
    allowed: move.allowed && missing.length === 0,
    from,
    to,
    reason: move.allowed
      ? (missing.length > 0
          ? 'A required capability is not yet available. A roadmap promise cannot satisfy a stage exit criterion.'
          : null)
      : move.reason,
    requiredEvidence: required,
    missingEvidence: missing,
  };
}

/** The ten stages, with the guidance the record header renders. */
export function stageCatalog(): {
  key: string; position: number; label: string;
  entry_evidence: string[]; exit_evidence: string[];
  stale_after_business_days: number | null; allowed_next: string[]; terminal: boolean;
  guidance: { crm: string; rep: string; manager: string };
}[] {
  return STAGES.map((s) => ({
    key: s.key, position: s.position, label: s.label,
    entry_evidence: s.entryEvidence, exit_evidence: s.exitEvidence,
    stale_after_business_days: s.staleAfterBusinessDays,
    allowed_next: s.allowedNext, terminal: s.terminal,
    /* SOP §31-32 responsibilities, rendered in the record header rather than
       kept in a manual nobody opens mid-call. */
    guidance: {
      crm: `The system records ${s.entryEvidence.join(', ') || 'the entry event'} on entry and requires ${s.exitEvidence.join(', ') || 'no further evidence'} before the record leaves.`,
      rep: `Work this stage to its exit evidence: ${s.exitEvidence.join(', ') || 'none'}. Leave a NEXT with an exact date and time every time you touch it.`,
      manager: s.staleAfterBusinessDays === null
        ? 'Ageing is not measured here, so review this stage by volume rather than by staleness.'
        : `Review anything sitting here beyond ${s.staleAfterBusinessDays} business days.`,
    },
  }));
}

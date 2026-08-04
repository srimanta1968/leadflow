import {
  KIND_REQUIRES_PERMISSION,
  ProposalKind,
  agentByKey,
  isProposalKind,
} from '../../config/aiAgents';
import { dataService } from '../../services/DataService';
import { AppError, ErrorCodes } from '../../utils/errors';
import { evaluate } from '../policy/policyEngine';
import { completionById } from './activityLedger';

/**
 * The human-review gate.
 *
 * SOP §21: "AI may suggest messages, scores, summaries, and next actions; a
 * qualified human reviews consequential outputs." This module is that sentence
 * in code, and it is ONE module rather than one per agent for a specific reason:
 * with the rule implemented per module, the guarantee holds only for the modules
 * that remembered, and the module written next year is the one that forgets.
 *
 * THERE IS NO DELIVERY FUNCTION HERE AND NO DELIVERY COLUMN IN THE TABLE. An
 * accepted proposal is a decision, not a dispatch. What stops a machine from
 * releasing a message is not a flag it must not set — it is that no code exists
 * to release one.
 *
 * "QUALIFIED" IS ENFORCED, NOT ASSUMED. Each kind names the SOP §28 permission a
 * reviewer must hold, and the decision runs through the same PDP as every other
 * governed act. So a Sales Manager, who holds call.review and not
 * message.send_approved, may accept a call summary and may NOT release a drafted
 * message — the same separation that applies when a human writes one by hand.
 */

export interface Proposal {
  id: string;
  kind: ProposalKind;
  agentKey: string;
  completionId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  content: Record<string, unknown>;
  editedContent: Record<string, unknown> | null;
  status: 'proposed' | 'accepted' | 'rejected';
  /** The authority a reviewer needed, stamped when the proposal was made. */
  requiredPermission: string;
  /**
   * Always false, and present so a caller can assert it.
   *
   * A field that is structurally incapable of being true is worth more than a
   * comment saying nothing is delivered: a test can read it, and an api
   * definition can assert it on every response.
   */
  delivered: false;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  proposedAt: string;
}

interface ProposalRow {
  id: string;
  kind: ProposalKind;
  agent_key: string;
  completion_id: string | null;
  subject_type: string | null;
  subject_id: string | null;
  content: Record<string, unknown>;
  edited_content: Record<string, unknown> | null;
  status: Proposal['status'];
  required_permission: string;
  decision_note: string | null;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  proposed_at: Date;
}

const SELECT_COLUMNS = `id, kind, agent_key, completion_id, subject_type, subject_id, content,
                        edited_content, status, required_permission, decision_note,
                        decided_by_user_id, decided_at, proposed_at`;

function toProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    kind: row.kind,
    agentKey: row.agent_key,
    completionId: row.completion_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    content: row.content,
    editedContent: row.edited_content,
    status: row.status,
    requiredPermission: row.required_permission,
    delivered: false,
    decisionNote: row.decision_note,
    decidedByUserId: row.decided_by_user_id,
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    proposedAt: row.proposed_at.toISOString(),
  };
}

export interface ProposeInput {
  agentKey: string;
  kind: string;
  content: Record<string, unknown>;
  subjectType?: string | null;
  subjectId?: string | null;
  /** The ledger row this output came from, when a completion produced it. */
  completionId?: string | null;
}

/**
 * Record a consequential AI output for review.
 *
 * @throws AppError(400) for an unknown agent, an unknown kind, or a kind the
 *         agent is not registered to propose.
 * @throws AppError(422 AI_COMPLETION_NOT_ACCOUNTED) when the named completion
 *         does not exist or did not complete.
 */
export async function propose(input: ProposeInput): Promise<Proposal> {
  const agent = agentByKey(input.agentKey);
  if (!agent) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `No AI agent is registered under '${input.agentKey}'`
    );
  }

  if (!isProposalKind(input.kind)) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `kind must be one of: ${Object.keys(KIND_REQUIRES_PERMISSION).join(', ')}`
    );
  }

  const kind = input.kind;

  // THE AGENT REGISTRY BOUNDS WHAT EACH AGENT MAY PROPOSE. Without this, an
  // agent registered to suggest next actions could propose a change of offer
  // terms and would be reviewed under that kind's authority — which sounds safe
  // until you notice it means any agent can reach any authority just by asking.
  if (!agent.proposes.includes(kind)) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `Agent '${agent.key}' is not registered to propose '${kind}' (registered: ${agent.proposes.join(', ')})`
    );
  }

  if (input.completionId) {
    const completion = await completionById(input.completionId);
    if (!completion) {
      throw new AppError(
        422,
        ErrorCodes.AI_COMPLETION_NOT_ACCOUNTED,
        'The named completion is not in the activity ledger.'
      );
    }
    if (completion.outcome !== 'completed') {
      // A proposal citing a REFUSED completion would be output produced outside
      // the four controls, wearing the reference of an attempt that was stopped.
      throw new AppError(
        422,
        ErrorCodes.AI_COMPLETION_NOT_ACCOUNTED,
        `The named completion did not complete (${completion.outcome}), so it cannot have produced this output.`
      );
    }
  }

  if (!input.content || Object.keys(input.content).length === 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'content must not be empty');
  }

  const row = await dataService.queryOne<ProposalRow>(
    `INSERT INTO ai_proposal
       (kind, agent_key, completion_id, subject_type, subject_id, content, required_permission)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SELECT_COLUMNS}`,
    [
      kind,
      agent.key,
      input.completionId ?? null,
      input.subjectType ?? null,
      input.subjectId ?? null,
      JSON.stringify(input.content),
      // Resolved and STORED now rather than looked up at decision time, so a
      // later edit to the role matrix cannot retroactively change who was
      // qualified to approve something already approved.
      KIND_REQUIRES_PERMISSION[kind],
    ]
  );

  return toProposal(row!);
}

/** One proposal by id. */
export async function proposalById(id: string): Promise<Proposal | null> {
  const row = await dataService.queryOne<ProposalRow>(
    `SELECT ${SELECT_COLUMNS} FROM ai_proposal WHERE id = $1`,
    [id]
  );
  return row ? toProposal(row) : null;
}

/** The reviewer's queue, oldest first — what is waiting on a human. */
export async function awaitingReview(limit = 50): Promise<Proposal[]> {
  const rows = await dataService.query<ProposalRow>(
    `SELECT ${SELECT_COLUMNS} FROM ai_proposal
      WHERE status = 'proposed' ORDER BY proposed_at LIMIT $1`,
    [Math.min(Math.max(1, limit), 200)]
  );
  return rows.map(toProposal);
}

export interface DecideInput {
  proposalId: string;
  decision: 'accept' | 'reject';
  /** The reviewer's roles, from the session. Never taken from the request body. */
  roles: string[];
  userId: string | null;
  /** A rewrite, kept ALONGSIDE the original rather than over it. */
  editedContent?: Record<string, unknown> | null;
  note?: string | null;
}

export interface DecisionResult {
  proposal: Proposal;
  /** The PDP verdict that permitted the decision. */
  decisionRef: string;
  /** The permission the reviewer had to hold. */
  requiredPermission: string;
  /** True when the reviewer rewrote the content before accepting. */
  wasEdited: boolean;
}

/**
 * A qualified human decides.
 *
 * THE PERMISSION CHECK IS AGAINST THE PERMISSION STORED ON THE PROPOSAL, not
 * against one derived from the kind now. Those are the same value today; they
 * stop being the same the moment somebody edits the kind map, and at that point
 * the stored one is the honest answer to "what did this approval actually
 * require".
 *
 * A REJECTION IS A DECISION AND IS RECORDED AS ONE. The alternative — deleting a
 * rejected proposal — destroys the only evidence that the gate is doing
 * anything, and "how often does a human turn the machine down" is the single
 * most useful number about an AI feature.
 *
 * @throws AppError(404) when no such proposal exists.
 * @throws AppError(409 CONFLICT) when it has already been decided.
 * @throws AppError(403 FORBIDDEN / APPROVAL_REQUIRED) when the reviewer is not
 *         qualified for this kind of output.
 */
export async function decide(input: DecideInput): Promise<DecisionResult> {
  const existing = await proposalById(input.proposalId);
  if (!existing) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Proposal not found');
  }

  if (existing.status !== 'proposed') {
    // A conflict, not a silent no-op: two decisions mean two people each
    // believed they were the one taking responsibility for this output, and
    // answering 200 to both hides a coordination failure worth surfacing.
    throw new AppError(409, ErrorCodes.CONFLICT, 'Proposal has already been decided');
  }

  const decision = evaluate(
    {
      action: existing.requiredPermission,
      resourceType: 'ai_proposal',
      resourceId: existing.id,
    },
    input.roles
  );

  if (decision.effect === 'requires_approval') {
    // A DISTINCT code from a plain refusal. This reviewer MAY take the decision,
    // but not alone — telling them they are forbidden would send them looking
    // for a way round a workflow the business actually runs on.
    throw new AppError(
      403,
      ErrorCodes.APPROVAL_REQUIRED,
      `Accepting a '${existing.kind}' proposal needs ${existing.requiredPermission}, which you hold only with a second party's approval. ${decision.reason}`
    );
  }

  if (decision.effect === 'deny') {
    throw new AppError(
      403,
      ErrorCodes.FORBIDDEN,
      `Deciding a '${existing.kind}' proposal requires ${existing.requiredPermission}. ${decision.reason}`
    );
  }

  const accepting = input.decision === 'accept';
  const editedContent = accepting ? (input.editedContent ?? null) : null;

  const row = await dataService.queryOne<ProposalRow>(
    `UPDATE ai_proposal
        SET status = $2, edited_content = $3, decision_note = $4,
            decided_by_user_id = $5, decided_at = CURRENT_TIMESTAMP, decision_ref = $6
      WHERE id = $1 AND status = 'proposed'
      RETURNING ${SELECT_COLUMNS}`,
    [
      existing.id,
      accepting ? 'accepted' : 'rejected',
      editedContent ? JSON.stringify(editedContent) : null,
      input.note ?? null,
      input.userId,
      decision.decisionRef,
    ]
  );

  if (!row) {
    // Lost the race with a concurrent decision between the read above and this
    // UPDATE. The guarded WHERE is what makes that safe; this turns it into the
    // same 409 the sequential case gets rather than a null dereference.
    throw new AppError(409, ErrorCodes.CONFLICT, 'Proposal has already been decided');
  }

  return {
    proposal: toProposal(row),
    decisionRef: decision.decisionRef,
    requiredPermission: existing.requiredPermission,
    wasEdited: editedContent !== null,
  };
}

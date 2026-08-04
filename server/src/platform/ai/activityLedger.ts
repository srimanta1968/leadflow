import { dataService } from '../../services/DataService';
import { RedactionHit } from './redaction';

/**
 * The AI activity ledger.
 *
 * EVERY ATTEMPT LANDS HERE, INCLUDING THE ONES THAT WERE REFUSED. An "AI
 * activity" record holding only successes cannot answer the question actually
 * asked after an incident — did we generate anything for this person after they
 * objected — because a refusal and never-having-been-asked look identical in it.
 *
 * IT IS NOT THE AUDIT LEDGER. The tamper-evident chain in `platform/audit`
 * records what a PERSON did; this records what the MACHINE did and under which
 * controls, at a volume (one row per completion) that would swamp a chain built
 * to be walked. The two meet at the proposal: a human accepting one appends to
 * the audit chain and names the completion recorded here.
 */

/** How a completion attempt ended. Mirrors the CHECK constraint on the table. */
export type CompletionOutcome =
  | 'completed'
  | 'refused_halted'
  | 'refused_consent'
  | 'refused_budget'
  | 'refused_template'
  | 'upstream_error';

export interface CompletionRecord {
  tenantId: string;
  agentKey: string;
  runId?: string | null;
  promptTemplateKey: string;
  promptTemplateVersion: string;
  purpose: string;
  consentBasisRef?: string | null;
  consentMethod?: string | null;
  budgetReservationRef?: string | null;
  tokensCharged?: number;
  redactionApplied?: RedactionHit[] | null;
  redactedSpanCount?: number;
  /** Minted before anything else happens, so a refusal has one too. */
  traceId: string;
  upstreamCompletionId?: string | null;
  outcome: CompletionOutcome;
  refusalReason?: string | null;
}

/**
 * Append one row.
 *
 * THIS ONE THROWS, unlike the audit append next door, and the difference is
 * worth stating. The audit chain records an act that has ALREADY happened, so
 * failing the act afterwards would leave the system in a state the caller was
 * told did not occur. Here the ledger row is written as part of deciding whether
 * to proceed — a completion whose accountability record could not be written has
 * not yet done anything, so refusing it costs nothing and preserves the property
 * that every completion is accounted for.
 */
export async function recordCompletion(record: CompletionRecord): Promise<string> {
  const row = await dataService.queryOne<{ id: string }>(
    `INSERT INTO ai_completion
       (tenant_id, agent_key, run_id, prompt_template_key, prompt_template_version, purpose,
        consent_basis_ref, consent_method, budget_reservation_ref, tokens_charged,
        redaction_applied, redacted_span_count, trace_id, upstream_completion_id,
        outcome, refusal_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING id`,
    [
      record.tenantId,
      record.agentKey,
      record.runId ?? null,
      record.promptTemplateKey,
      record.promptTemplateVersion,
      record.purpose,
      record.consentBasisRef ?? null,
      record.consentMethod ?? null,
      record.budgetReservationRef ?? null,
      record.tokensCharged ?? 0,
      // Null rather than '[]' on a refusal: the CHECK constraint distinguishes
      // "redaction ran and removed nothing" from "redaction never ran", and
      // writing an empty array on a refused attempt would erase that difference.
      record.redactionApplied ? JSON.stringify(record.redactionApplied) : null,
      record.redactedSpanCount ?? 0,
      record.traceId,
      record.upstreamCompletionId ?? null,
      record.outcome,
      record.refusalReason ?? null,
    ]
  );

  return row!.id;
}

export interface LedgerEntry {
  id: string;
  agentKey: string;
  promptTemplateKey: string;
  promptTemplateVersion: string;
  purpose: string;
  consentBasisRef: string | null;
  budgetReservationRef: string | null;
  redactedSpanCount: number;
  traceId: string;
  outcome: CompletionOutcome;
  refusalReason: string | null;
  tokensCharged: number;
  createdAt: string;
}

interface LedgerRow {
  id: string;
  agent_key: string;
  prompt_template_key: string;
  prompt_template_version: string;
  purpose: string;
  consent_basis_ref: string | null;
  budget_reservation_ref: string | null;
  redacted_span_count: number;
  trace_id: string;
  outcome: CompletionOutcome;
  refusal_reason: string | null;
  tokens_charged: number;
  created_at: Date;
}

function toEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    agentKey: row.agent_key,
    promptTemplateKey: row.prompt_template_key,
    promptTemplateVersion: row.prompt_template_version,
    purpose: row.purpose,
    consentBasisRef: row.consent_basis_ref,
    budgetReservationRef: row.budget_reservation_ref,
    redactedSpanCount: row.redacted_span_count,
    traceId: row.trace_id,
    outcome: row.outcome,
    refusalReason: row.refusal_reason,
    tokensCharged: row.tokens_charged,
    createdAt: row.created_at.toISOString(),
  };
}

/** One entry by id, for tracing a proposal back to what produced it. */
export async function completionById(id: string): Promise<LedgerEntry | null> {
  const row = await dataService.queryOne<LedgerRow>(
    `SELECT id, agent_key, prompt_template_key, prompt_template_version, purpose,
            consent_basis_ref, budget_reservation_ref, redacted_span_count, trace_id,
            outcome, refusal_reason, tokens_charged, created_at
       FROM ai_completion WHERE id = $1`,
    [id]
  );
  return row ? toEntry(row) : null;
}

/** Recent activity for a tenant, newest first. */
export async function recentCompletions(tenantId: string, limit = 50): Promise<LedgerEntry[]> {
  const rows = await dataService.query<LedgerRow>(
    `SELECT id, agent_key, prompt_template_key, prompt_template_version, purpose,
            consent_basis_ref, budget_reservation_ref, redacted_span_count, trace_id,
            outcome, refusal_reason, tokens_charged, created_at
       FROM ai_completion
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [tenantId, Math.min(Math.max(1, limit), 200)]
  );
  return rows.map(toEntry);
}

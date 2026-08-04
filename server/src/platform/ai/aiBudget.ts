import { randomUUID } from 'crypto';
import { dataService } from '../../services/DataService';
import { AppError, ErrorCodes } from '../../utils/errors';
import { currentTenantContext, tenantIdFor } from '../tenancy/tenantHierarchy';

/**
 * Per-tenant AI budget control.
 *
 * RESERVE BEFORE, SETTLE AFTER. A budget checked only after the provider
 * answers is not a budget — the tokens are already spent and the bill already
 * incurred. So a completion reserves an estimate first, and the actual usage is
 * settled against that reservation when the provider reports it.
 *
 * THE RESERVATION IS OPTIMISTIC AND THE SETTLEMENT IS AUTHORITATIVE. An estimate
 * that runs high blocks generation the tenant had budget for; one that runs low
 * lets a single very large completion overshoot. Overshoot is the better
 * failure: it is bounded by one completion, whereas over-blocking is unbounded
 * and looks like an outage.
 */

/** The tenant an AI budget belongs to. */
export function budgetTenantId(): string {
  // 'ai_budget' rather than 'billing': the control is "stop THIS app
  // generating", and a customer-scoped allowance would let one app's runaway
  // loop halt every other product they run.
  return tenantIdFor(currentTenantContext(), 'ai_budget');
}

/**
 * The default period allowance, in tokens.
 *
 * Zero would halt a fresh install, and unlimited would make the control
 * decorative on the deployment most likely to have a runaway loop — a
 * development one. A concrete default that an operator raises deliberately is
 * the only option that is safe on day one and honest afterwards.
 */
function defaultTokenLimit(): number {
  return parseInt(process.env.AI_TOKEN_BUDGET_PER_PERIOD || '2000000', 10);
}

/** First day of the current budget period, as a DATE literal. */
function currentPeriodStart(now = new Date()): string {
  // Calendar month. It matches how the provider bills, which is the only
  // alignment that makes "are we going to overspend this month" answerable
  // without arithmetic.
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export interface BudgetReservation {
  /** Stamped onto the completion row. */
  ref: string;
  tenantId: string;
  periodStart: string;
  reservedTokens: number;
  /** What remains after this reservation. */
  remainingTokens: number;
}

export interface BudgetStatus {
  tenantId: string;
  periodStart: string;
  tokenLimit: number;
  tokensSpent: number;
  remainingTokens: number;
  exhaustedAt: string | null;
}

interface BudgetRow {
  tenant_id: string;
  period_start: Date | string;
  token_limit: number;
  tokens_spent: number;
  exhausted_at: Date | null;
}

/** Normalise a DATE column, which pg returns as a Date in local time. */
function periodOf(row: BudgetRow): string {
  return typeof row.period_start === 'string'
    ? row.period_start.slice(0, 10)
    : row.period_start.toISOString().slice(0, 10);
}

/** Read the current period's budget, creating it on first use. */
export async function currentBudget(): Promise<BudgetStatus> {
  const tenantId = budgetTenantId();
  const periodStart = currentPeriodStart();

  // ON CONFLICT DO NOTHING then read, rather than read-then-insert: two
  // concurrent first completions of the month would both see no row and both
  // insert, and the second would fail on the primary key.
  await dataService.query(
    `INSERT INTO ai_budget (tenant_id, period_start, token_limit)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, period_start) DO NOTHING`,
    [tenantId, periodStart, defaultTokenLimit()]
  );

  const row = await dataService.queryOne<BudgetRow>(
    `SELECT tenant_id, period_start, token_limit, tokens_spent, exhausted_at
       FROM ai_budget WHERE tenant_id = $1 AND period_start = $2`,
    [tenantId, periodStart]
  );

  const limit = row?.token_limit ?? defaultTokenLimit();
  const spent = row?.tokens_spent ?? 0;

  return {
    tenantId,
    periodStart: row ? periodOf(row) : periodStart,
    tokenLimit: limit,
    tokensSpent: spent,
    remainingTokens: Math.max(0, limit - spent),
    exhaustedAt: row?.exhausted_at ? row.exhausted_at.toISOString() : null,
  };
}

/**
 * Reserve an estimated spend, or refuse.
 *
 * The reservation IS the spend, recorded immediately. Holding it separately and
 * only counting settled usage would let a burst of concurrent completions each
 * see the same remaining balance and every one of them pass — which is the exact
 * failure a budget is bought to prevent.
 *
 * @throws AppError(429 AI_BUDGET_EXHAUSTED) when the period allowance is gone.
 */
export async function reserveTokens(estimatedTokens: number): Promise<BudgetReservation> {
  const status = await currentBudget();
  const estimate = Math.max(1, Math.round(estimatedTokens));

  // The conditional UPDATE is what makes this safe under concurrency: the
  // balance is re-checked inside the same statement that decrements it, so two
  // callers cannot both be told there is room for the last thousand tokens.
  const updated = await dataService.queryOne<BudgetRow>(
    `UPDATE ai_budget
        SET tokens_spent = tokens_spent + $3,
            updated_at = CURRENT_TIMESTAMP,
            exhausted_at = CASE
              WHEN tokens_spent + $3 >= token_limit AND exhausted_at IS NULL
                THEN CURRENT_TIMESTAMP ELSE exhausted_at END
      WHERE tenant_id = $1 AND period_start = $2
        AND tokens_spent + $3 <= token_limit
      RETURNING tenant_id, period_start, token_limit, tokens_spent, exhausted_at`,
    [status.tenantId, status.periodStart, estimate]
  );

  if (!updated) {
    throw new AppError(
      429,
      ErrorCodes.AI_BUDGET_EXHAUSTED,
      `The AI token budget for this period is exhausted (${status.tokensSpent}/${status.tokenLimit}).`
    );
  }

  return {
    ref: `bud_${randomUUID()}`,
    tenantId: status.tenantId,
    periodStart: status.periodStart,
    reservedTokens: estimate,
    remainingTokens: Math.max(0, updated.token_limit - updated.tokens_spent),
  };
}

/**
 * Correct a reservation against what was actually used.
 *
 * Settles the DIFFERENCE, which may be negative — an overestimate returns the
 * unused tokens to the period. Clamped at zero so a burst of refunds cannot
 * drive the counter below zero and hand a tenant free allowance.
 */
export async function settleTokens(
  reservation: BudgetReservation,
  actualTokens: number
): Promise<void> {
  const delta = Math.round(actualTokens) - reservation.reservedTokens;
  if (delta === 0) {
    return;
  }

  await dataService.query(
    `UPDATE ai_budget
        SET tokens_spent = GREATEST(0, tokens_spent + $3),
            updated_at = CURRENT_TIMESTAMP,
            exhausted_at = CASE
              WHEN GREATEST(0, tokens_spent + $3) >= token_limit AND exhausted_at IS NULL
                THEN CURRENT_TIMESTAMP ELSE exhausted_at END
      WHERE tenant_id = $1 AND period_start = $2`,
    [reservation.tenantId, reservation.periodStart, delta]
  );
}

/**
 * Return a reservation in full, when the completion never happened.
 *
 * Separate from `settleTokens(reservation, 0)` so the intent is legible at the
 * call site: this is the upstream-failed path, not a completion that used no
 * tokens.
 */
export async function releaseReservation(reservation: BudgetReservation): Promise<void> {
  await settleTokens(reservation, 0);
}

/** Raise or lower the current period's allowance. */
export async function setPeriodLimit(tokenLimit: number): Promise<BudgetStatus> {
  const status = await currentBudget();
  await dataService.query(
    `UPDATE ai_budget
        SET token_limit = $3,
            updated_at = CURRENT_TIMESTAMP,
            -- Raising the limit CLEARS the exhaustion mark, because the tenant
            -- is no longer exhausted; lowering it below current spend sets one,
            -- because they now are.
            exhausted_at = CASE WHEN tokens_spent < $3 THEN NULL
                                ELSE COALESCE(exhausted_at, CURRENT_TIMESTAMP) END
      WHERE tenant_id = $1 AND period_start = $2`,
    [status.tenantId, status.periodStart, Math.max(0, Math.round(tokenLimit))]
  );
  return currentBudget();
}

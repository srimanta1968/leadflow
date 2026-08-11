/**
 * The four budget tiers the Data Credits drawer shows, in the mockup's words.
 *
 * WHY THIS IS A LOCAL CONSTANT rather than a read from sdk-data-credits: the
 * drawer must render the tenant's INTENDED policy even when the upstream is
 * unreachable, and an empty Budget Controls panel reads as "nobody has any
 * budget" rather than "we could not ask". The upstream budget_policy rows are
 * the operative truth for what actually gets reserved; these are the four tiers
 * the tenant configured and the labels an operator recognises. Where the two
 * disagree, the drawer says so rather than quietly showing one.
 *
 * THE LABELS ARE COPIED FROM THE MOCKUP, NOT PARAPHRASED. "Request only ·
 * manager approval required" is a statement about who may spend the tenant's
 * money, and an operator comparing the screen against the policy they agreed
 * needs the same words on both.
 *
 * MODE MAPS TO sdk-data-credits' budget_policy vocabulary: REQUEST_ONLY,
 * DAILY_CAP and FULL. That is the enum the reservation path actually reads, so
 * naming anything else here would produce a screen that describes a policy the
 * broker cannot enforce.
 */

export type BudgetMode = 'REQUEST_ONLY' | 'DAILY_CAP' | 'FULL';

export interface BudgetTier {
  /** The tier as the drawer names it. */
  label: string;
  /** The sentence under it, verbatim from the mockup. */
  detail: string;
  /** The right-hand figure the mockup shows. */
  allowance: string;
  mode: BudgetMode;
  /** Credits per day, or null when the tier is not capped that way. */
  dailyCap: number | null;
  /** Above this estimate the request needs approval even inside the cap. */
  bulkApprovalThreshold: number | null;
  /**
   * The LeadFlow role this tier governs, when one exists locally.
   *
   * `canvasser` and `owner` have no entry in config/roles.ts: canvassing is a
   * field activity this deployment models through sales_rep, and ownership is
   * carried by `leadership`. Stated as null rather than guessed, because
   * silently binding "Canvassers · request only" to sales_rep would give every
   * representative the most restrictive tier on the screen while the broker
   * applied a different one.
   */
  localRole: string | null;
}

export const BUDGET_TIERS: readonly BudgetTier[] = [
  {
    label: 'Canvassers',
    detail: 'Request only · manager approval required',
    allowance: '0 direct',
    mode: 'REQUEST_ONLY',
    dailyCap: 0,
    bulkApprovalThreshold: null,
    localRole: null,
  },
  {
    label: 'Sales representatives',
    detail: '10 credits/day · approved capabilities',
    allowance: '10/day',
    mode: 'DAILY_CAP',
    dailyCap: 10,
    bulkApprovalThreshold: null,
    localRole: 'sales_rep',
  },
  {
    label: 'Sales managers',
    detail: '100 credits/day · bulk approval threshold 50',
    allowance: '100/day',
    mode: 'DAILY_CAP',
    dailyCap: 100,
    bulkApprovalThreshold: 50,
    localRole: 'sales_manager',
  },
  {
    label: 'Owner',
    detail: 'Organization balance and purchase authority',
    allowance: 'Full',
    mode: 'FULL',
    dailyCap: null,
    bulkApprovalThreshold: null,
    localRole: 'leadership',
  },
];

/** The tier governing a local role, or the most restrictive one if unmapped. */
export function tierForRole(role: string | null | undefined): BudgetTier {
  const matched = BUDGET_TIERS.find((t) => t.localRole !== null && t.localRole === role);
  // FAILS CLOSED. An unrecognised role gets Canvassers — request-only — rather
  // than the permissive end. Somebody whose role we cannot place must not be
  // handed the organization's purchase authority by default.
  return matched ?? BUDGET_TIERS[0];
}

/**
 * Whether this tier must route through approval before anything is executed.
 *
 * TWO REASONS, and both are the tenant's money: the tier may be request-only, or
 * the estimate may exceed the bulk-approval threshold the tier carries. The
 * second is the one that is easy to forget — a sales manager has 100 a day and
 * still needs a decision on a single 60-credit run.
 */
export function requiresApproval(tier: BudgetTier, estimatedCredits: number): {
  required: boolean;
  because: string | null;
} {
  if (tier.mode === 'REQUEST_ONLY') {
    return { required: true, because: `${tier.label} may request only; a manager must approve it.` };
  }
  if (tier.bulkApprovalThreshold !== null && estimatedCredits > tier.bulkApprovalThreshold) {
    return {
      required: true,
      because: `This run is ${estimatedCredits} credits, above the ${tier.bulkApprovalThreshold}-credit bulk approval threshold for ${tier.label}.`,
    };
  }
  if (tier.dailyCap !== null && estimatedCredits > tier.dailyCap) {
    return {
      required: true,
      because: `This run is ${estimatedCredits} credits, above the ${tier.dailyCap}/day allowance for ${tier.label}.`,
    };
  }
  return { required: false, because: null };
}

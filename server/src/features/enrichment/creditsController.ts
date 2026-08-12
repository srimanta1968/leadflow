import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { governed, type GovernedRequest } from '../../platform/policy/governed';
import { PERMISSIONS } from '../../config/roles';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { BUDGET_TIERS } from './budgetTiers';
import {
  listCapabilityRequests,
  listLedgerEntries,
  readBalance,
  type CapabilityRequestRow,
} from './enrichmentGateway';

/**
 * The Data Credits drawer (#creditsDrawer), in one call.
 *
 * ONE CALL FOR THE WHOLE DRAWER. The three upstream reads are issued
 * CONCURRENTLY and degrade independently, so an unreachable credit account
 * empties the balance tile and leaves Budget Controls readable. Fanning out from
 * the browser would put the balance and the usage at two different instants
 * behind one panel, and a 'saved through cache' figure that does not correspond
 * to the usage printed beside it is worse than an absent one.
 *
 * PROVIDER COST IS NOT IN HERE AND CANNOT BE. Every field is named out by hand
 * rather than spread from an upstream row, so a column added to
 * `provider_binding` cannot arrive by default. The drawer states this on screen.
 *
 * THE FIGURES COME FROM THE CAPABILITY REQUESTS, NOT THE CREDIT LEDGER, and that
 * is a deliberate correction rather than a convenience. `credit_ledger` carries
 * entry_no, entry_type, request_id, balance/reserved deltas, reason and
 * created_at - and NO capability key. A Capability Usage breakdown built from it
 * would have nothing to group by. The capability-request projection carries
 * capability_key, credits_reserved, credits_charged, outcome and
 * served_from_cache per request, which is precisely the row AC4 asks the export
 * to contain. The ledger is still read, because its reachability is what tells
 * the drawer whether the export is complete.
 */
export const creditsRoutes: Router = Router();

creditsRoutes.use(authenticate);

const NOT_AN_OWNED_RECORD = {
  own_record_only: {
    kind: 'defer' as const,
    because: 'a credit balance belongs to the organization, not to an operator',
  },
};

const creditsOf = (n: number | undefined): number => (typeof n === 'number' ? n : 0);

/**
 * Capability Usage, counting what was CHARGED rather than what was reserved.
 *
 * A reservation refunded because the provider found nothing must not appear as
 * usage: the tenant was not charged for it, and showing it would make the
 * breakdown disagree with the cycle total printed directly above it.
 */
function usageByCapability(requests: CapabilityRequestRow[]): { capability: string; credits: number }[] {
  const totals = new Map<string, number>();
  for (const row of requests) {
    const charged = creditsOf(row.credits_charged);
    if (charged <= 0) continue;
    const key = row.capability_key ?? 'unknown';
    totals.set(key, (totals.get(key) ?? 0) + charged);
  }
  return [...totals.entries()]
    .map(([capability, credits]) => ({ capability, credits }))
    .sort((a, b) => b.credits - a.credits);
}

/**
 * AC4: one export row per request, carrying all three figures.
 *
 * REFUND IS DERIVED AS reserved - charged, which is exactly what a RELEASE entry
 * returns to the account: the hold that was taken and not spent. A no-match or a
 * technical failure settles at zero charged, so its whole reservation shows as
 * refunded - which is the line a disputed invoice is actually arguing about.
 */
function ledgerExport(requests: CapabilityRequestRow[]): Record<string, unknown>[] {
  return requests.map((row) => {
    const reserved = creditsOf(row.credits_reserved);
    const charged = creditsOf(row.credits_charged);
    return {
      request_id: row.request_id ?? null,
      capability_key: row.capability_key ?? null,
      reserved,
      charged,
      refunded: Math.max(reserved - charged, 0),
      outcome: row.outcome ?? null,
      served_from_cache: row.served_from_cache === true,
      status: row.status ?? null,
      created_at: row.created_at ?? null,
    };
  });
}

/**
 * GET /api/leadflow/credits/summary - balance, cycle, usage, budgets, export.
 */
creditsRoutes.get(
  '/summary',
  asyncHandler(governed(
    {
      action: PERMISSIONS.DATA_CONFIGURE,
      event: AUDIT_EVENTS.ENRICHMENT_QUEUE_INSPECTED,
      purpose: 'lead_management',
      resourceType: 'credit_account',
      metadata: () => ({ surface: 'data_credits_drawer' }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const raw = Number(req.query?.limit ?? 200);
      const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : 200, 1), 1000);

      const [balance, requests, ledger] = await Promise.all([
        readBalance(),
        listCapabilityRequests(limit),
        listLedgerEntries(limit),
      ]);

      const rows = requests.available ? requests.value : [];
      const used = rows.reduce((t, r) => t + creditsOf(r.credits_charged), 0);
      /*
       * SAVED THROUGH CACHE counts the requests that were SERVED FROM CACHE,
       * not the gap between reserved and charged. That gap also contains
       * no-match refunds and technical failures, and calling those a saving
       * would credit the cache with work it never did.
       */
      const savedThroughCache = rows
        .filter((r) => r.served_from_cache === true)
        .reduce((t, r) => t + creditsOf(r.credits_reserved), 0);

      res.status(200).json({
        success: true,
        data: {
          organization_balance: {
            balance: balance.value?.balance ?? null,
            reserved: balance.value?.reserved ?? null,
            available: balance.available,
          },
          current_cycle: {
            used,
            saved_through_cache: savedThroughCache,
            available: requests.available,
          },
          capability_usage: usageByCapability(rows),
          /* AC3: the four tiers, in the drawer's own words. */
          budget_controls: BUDGET_TIERS.map((tier) => ({
            label: tier.label,
            detail: tier.detail,
            allowance: tier.allowance,
            mode: tier.mode,
            daily_cap: tier.dailyCap,
            bulk_approval_threshold: tier.bulkApprovalThreshold,
            local_role: tier.localRole,
          })),
          /* AC4: reservation, actual charge and refund, per request. */
          ledger_export: ledgerExport(rows),
          /*
           * REPORTED SEPARATELY from the export itself. An export built while
           * the ledger was unreachable is a PARTIAL export, and a finance user
           * downloading it needs to know that before they reconcile against it.
           */
          ledger_available: ledger.available,
          export_complete: requests.available && ledger.available,
          operator_only_notice:
            'Provider costs are operator-only. Tenant users see capability price, reservation, actual charge, result and refund, not provider-specific credentials or routing.',
        },
      });
    },
  )),
);

/**
 * GET /api/leadflow/credits/balance — what is left, and what it is committed to.
 *
 * A THIN ALIAS OF /summary, kept because the workspace asks a narrower question:
 * "can I afford this action right now". Pointing the screen at /summary would
 * work and would return a page of budget-tier detail it has no use for, and the
 * first person to change that shape would break a screen that never wanted it.
 */
creditsRoutes.get(
  '/balance',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const upstream = SdkGatewayClient.isConfigured()
      ? await SdkGatewayClient.call<{ data?: { balance?: number; committed?: number } }>({
        sdk: 'sdk-data-credits', path: '/api/credits/balance', method: 'GET',
        idempotencyKey: 'credits-balance:read',
      }).catch(() => ({ delivered: false, data: undefined }))
      : { delivered: false, data: undefined };

    res.status(200).json({
      success: true,
      data: {
        balance: upstream.data?.data?.balance ?? null,
        committed: upstream.data?.data?.committed ?? null,
        upstream_available: { credits: upstream.delivered },
        /* NULL, NEVER ZERO, when the balance cannot be read. Zero means "you
           cannot afford this"; unknown means "we could not check" — and a
           screen that greys out an action for the wrong one of those reasons
           sends somebody to find a workaround. */
        field_gaps: upstream.delivered ? [] : [
          { field: 'balance', reason: 'sdk-data-credits could not be reached, so the balance is unknown rather than zero.' },
        ],
      },
    });
  })
);

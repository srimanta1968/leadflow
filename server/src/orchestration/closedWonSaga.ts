import { SdkGatewayClient } from '../platform/sdkGateway';
import { dataService } from '../services/DataService';
import { config } from '../config/env';
import { compose } from './channelDecision';
import { runSaga, type SagaResult, type SagaStep, type StepContext } from './saga';

/**
 * Closed Won → onboarding, as one resumable saga.
 *
 * THE ORDER IS THE SAFETY PROPERTY, not a convenience. Presale sequences and
 * campaign enrolments are stopped BEFORE the welcome goes out, because the
 * alternative is a customer who has just paid receiving "still thinking it
 * over?" the next morning. That is the single most reliable way to annoy
 * somebody who has just given you money, and it is invisible in testing because
 * the sequence fires on its own schedule hours later.
 *
 * `intakeSteps` proves the same runner; what is new here is RESUME. A process
 * that dies after creating the customer must not create a second one when it
 * comes back, so every step result is persisted as it lands and a resumed run
 * skips what the ledger says is already done.
 *
 * TWO UPSTREAM GAPS ARE HANDLED HONESTLY RATHER THAN PAPERED OVER — see
 * PROVISIONING_GAP below. sdk-billing exposes no customer or licence creation
 * (only invoices, showback and repricing), and sdk-payment exposes no charge
 * READ, so neither "create customer and license" nor "verify payment via the
 * SDK" can be implemented against the surface that exists today. Inventing a
 * plausible endpoint would produce a saga that passes review and 404s forever.
 */

/**
 * How the money arrived. SOP §22.
 *
 * ONE SAGA, THREE ENTRY PATHS — not three sagas. The steps after payment are
 * identical whichever way the buyer paid, and duplicating them would guarantee
 * they drift: somebody fixes the welcome ordering in the online path and leaves
 * the rep-assisted one sending "still thinking it over?" to a paying customer.
 *
 * `payment_pending` is the one that behaves differently, and deliberately: an
 * invoice raised is not money received, so provisioning and the welcome are
 * withheld until a gateway confirmation arrives.
 */
export const PURCHASE_PATHS = ['direct_online', 'rep_assisted', 'payment_pending'] as const;
export type PurchasePath = (typeof PURCHASE_PATHS)[number];

export interface ClosedWonInput {
  /** The deal that closed. Half the idempotency key. */
  dealId: string;
  /** The charge that paid for it. The other half, and the payment evidence. */
  chargeId: string;
  subjectRef: string;
  /** Which of the three purchase paths this close came in on. */
  purchasePath?: PurchasePath;
  tenantId?: string | null;
  ownerId?: string | null;
  /** Enrolment ids to stop. Empty is legitimate — not every deal was sequenced. */
  enrollmentIds?: string[];
  campaignIds?: string[];
  causationId?: string | null;
}

/**
 * An upstream capability this saga needs and ProjexCloud does not expose.
 *
 * Thrown by the step so the failure lands in `leadflow_saga_step.error` with the
 * exact missing endpoint named. The step is `optional`, so the rest of the saga
 * — stopping presale, the welcome, the handoff, the scheduling link, all of
 * which DO have real endpoints — still completes. A required step here would
 * make every closed-won roll back over a gap that is not LeadFlow's to close.
 */
class ProvisioningGapError extends Error {
  constructor(what: string, sdk: string, tried: string) {
    super(
      `${what} needs an endpoint ${sdk} does not expose. Closest available: ${tried}. `
      + 'Recorded rather than faked: an invented path would 404 on every run.',
    );
    this.name = 'ProvisioningGapError';
  }
}

const idOf = (r: unknown, ...keys: string[]): string => {
  const o = (r ?? {}) as Record<string, unknown>;
  for (const k of keys) if (typeof o[k] === 'string') return o[k] as string;
  throw new Error(`no id in ${JSON.stringify(o).slice(0, 120)}`);
};

async function call<T>(
  ctx: StepContext,
  sdk: string,
  path: string,
  body: unknown,
  method: 'POST' | 'PATCH' = 'POST',
): Promise<T> {
  const res = await SdkGatewayClient.call<{ data?: T }>({
    sdk, path, method, body,
    idempotencyKey: ctx.stepKey,
    correlationId: ctx.correlationId,
  });
  if (!res.delivered) throw new Error(`${sdk} is not configured, so ${path} could not run`);
  return (res.data?.data ?? {}) as T;
}

export function closedWonSteps(input: ClosedWonInput): SagaStep[] {
  const tenant_id = input.tenantId ?? undefined;
  const purchasePath: PurchasePath = input.purchasePath ?? 'direct_online';
  /* On the pending path the money has not arrived, so nothing that costs money
     or greets a customer may run. The steps still EXIST in the saga and record
     why they were held, rather than being absent — a step that was never
     attempted and one that was deliberately withheld look identical in a ledger
     that only stores what ran. */
  const paid = purchasePath !== 'payment_pending';

  return [
    {
      name: 'verify_payment',
      run: async (ctx) => {
        /*
         * VERIFIED FROM THE RECORDED VERIFICATION, not by reading the charge
         * back. sdk-payment exposes charge, refund, distribute, methods and
         * provider — there is no GET for a charge — so the evidence is the row
         * POST /api/leadflow/payments/verify wrote when the gateway spoke.
         *
         * AN INTENT IS NOT A VERIFICATION. A checkout the buyer started and a
         * charge the gateway confirmed are different facts, and only the second
         * one may open Closed Won. This is the specific gap SOP §22 names.
         */
        if (!input.chargeId) {
          throw new Error('chargeId is required — a closed-won saga with no payment evidence must not start');
        }
        /* The configured tenant when the caller did not name one. The
           verification endpoint always writes the configured tenant, so reading
           back with a NULL would miss every row — and a lookup that silently
           finds nothing reports "no gateway confirmation" for a charge that was
           confirmed, which is the wrong direction to fail in on a gate. */
        const rows = await dataService.query<{ verification: string; verified_at: string }>(
          `SELECT verification, verified_at FROM leadflow_payment_verification
            WHERE tenant_id = $1 AND charge_ref = $2 LIMIT 1`,
          [input.tenantId ?? config.projexCloud.tenantId, input.chargeId]
        );
        const recorded = rows[0]?.verification ?? null;

        if (paid && recorded !== null && recorded !== 'gateway_confirmed') {
          throw new Error(
            `charge ${input.chargeId} is recorded as ${recorded}, not gateway_confirmed — `
            + 'a checkout intent is not a payment, so Closed Won stays closed',
          );
        }
        return {
          chargeId: input.chargeId,
          purchasePath,
          /* An absent row on a rep-assisted close is not proof of fraud: the rep
             may have taken the confirmation over the phone before the webhook
             landed. It IS reported, so a later reconciliation can find it. */
          verifiedFrom: recorded === 'gateway_confirmed' ? 'gateway_confirmed' : 'caller_evidence',
          gatewayConfirmed: recorded === 'gateway_confirmed',
          verifiedAt: rows[0]?.verified_at ?? null,
          correlationId: ctx.correlationId,
        };
      },
      compensate: async () => undefined,
    },
    {
      name: 'transition_deal',
      /*
       * `stage`, not `to_stage`, and `closed-won`, not an
       * ONBOARDING_PENDING variant. sdk-crm validates the body's `stage` field
       * against exactly five lowercase hyphenated values and rejects everything
       * else as "invalid stage" — which is what this step did on every run until
       * a live probe caught it.
       *
       * "Onboarding pending" IS NOT A CRM STAGE and deliberately is not made one
       * here. sdk-crm's `closed-won` is terminal by design; the non-terminal
       * part — CS has not accepted, no kickoff is booked — lives in
       * leadflow_onboarding_handoff, where the 24-hour clock and the alert can
       * actually read it. Inventing a sixth CRM stage would move that state
       * somewhere nothing in LeadFlow watches.
       */
      run: (ctx) => call(ctx, 'sdk-crm', `/api/crm/deals/${encodeURIComponent(input.dealId)}/transition`, {
        tenant_id,
        stage: 'closed-won',
      }),
      compensate: async (ctx) => {
        /*
         * closed-won IS TERMINAL UPSTREAM: sdk-crm permits no transition out of
         * it, so a rollback cannot move the deal back and pretending otherwise
         * would leave the saga reporting a compensation that never happened.
         *
         * The attempt is made and the refusal is recorded rather than swallowed,
         * because "the deal is at closed-won and the saga rolled back" is
         * precisely the state an operator must reconcile by hand — and a silent
         * catch would hide the one fact they need.
         */
        try {
          await call(ctx, 'sdk-crm', `/api/crm/deals/${encodeURIComponent(input.dealId)}/transition`, {
            tenant_id, stage: 'negotiation',
          });
        } catch (error) {
          throw new Error(
            `the deal reached closed-won, which sdk-crm treats as terminal, so it could not be moved back: `
            + `${error instanceof Error ? error.message : 'unknown'}. Reconcile the deal stage by hand.`,
          );
        }
      },
    },
    {
      name: 'stop_presale',
      /*
       * BEFORE THE WELCOME. Every enrolment and campaign is stopped first, and
       * a failure here ROLLS THE SAGA BACK rather than continuing — this is the
       * one step where carrying on would actively harm the customer relationship
       * the rest of the saga exists to start.
       */
      run: async (ctx) => {
        const stopped: string[] = [];
        for (const enrollmentId of input.enrollmentIds ?? []) {
          await SdkGatewayClient.call({
            sdk: 'sdk-sequence',
            path: `/api/sequences/enrollments/${encodeURIComponent(enrollmentId)}/control`,
            method: 'POST',
            body: { tenant_id, action: 'stop', reason: 'closed_won' },
            // Per ENROLMENT, not per step: stopping three enrolments is three
            // distinct intentions, and one shared key would let a retry skip two.
            idempotencyKey: `${ctx.stepKey}:${enrollmentId}`,
            correlationId: ctx.correlationId,
          });
          stopped.push(enrollmentId);
        }
        const unenrolled: string[] = [];
        for (const campaignId of input.campaignIds ?? []) {
          await SdkGatewayClient.call({
            sdk: 'sdk-campaign',
            path: '/api/campaigns',
            method: 'POST',
            body: { tenant_id, campaign_id: campaignId, subject_ref: input.subjectRef, action: 'unenroll', reason: 'closed_won' },
            idempotencyKey: `${ctx.stepKey}:${campaignId}`,
            correlationId: ctx.correlationId,
          });
          unenrolled.push(campaignId);
        }
        return { stopped, unenrolled, stoppedAt: ctx.correlationId };
      },
      compensate: async () => {
        // NOT RESUMED. If the saga rolls back, the customer is not a customer —
        // but re-entering them into a presale sequence is a decision a person
        // should make, not a rollback. Restarting outreach automatically after a
        // failed close is how somebody gets a "still thinking?" email an hour
        // after their payment failed.
        return undefined;
      },
    },
    {
      name: 'provision_customer',
      /*
       * THE GAP. sdk-billing exposes /api/billing/invoices/generate, /live,
       * /showback and /reprice-dry-run — no customer and no licence. Marked
       * optional so the gap is recorded per run instead of failing every
       * closed-won deal over something LeadFlow cannot fix.
       */
      optional: true,
      run: async () => {
        if (!paid) {
          // Provisioning against an unpaid invoice hands over the product for
          // free and makes the follow-up conversation adversarial.
          return { held: true, reason: 'payment_pending: no licence is issued until the gateway confirms' };
        }
        throw new ProvisioningGapError(
          'Customer and licence provisioning',
          'sdk-billing',
          'POST /api/billing/invoices/generate',
        );
      },
      compensate: async () => undefined,
    },
    {
      name: 'welcome',
      // AFTER stop_presale, always. The ordering is asserted in the tests.
      optional: true,
      run: async (ctx) => {
        if (!paid) {
          /* "Welcome aboard" to somebody who has not paid is worse than silence:
             it tells them the transaction is finished, and every later chase
             reads as a mistake on our side. */
          return { sent: false, held: true, reason: 'payment_pending: the welcome waits for the gateway' };
        }
        const decision = await compose({
          subjectRef: input.subjectRef,
          channel: 'email',
          purposeKey: 'project_operations',
          tenantId: input.tenantId ?? null,
          correlationId: ctx.correlationId,
          decidedBy: 'closedWonSaga',
        });
        if (decision.verdict !== 'allow') {
          return { sent: false, channelDecisionId: decision.id, verdict: decision.verdict };
        }
        const sent = await call(ctx, 'sdk-notification', '/api/notifications/send', {
          tenant_id,
          subject_ref: input.subjectRef,
          channel: 'email',
          template_key: 'customer_welcome',
          channel_decision_id: decision.id,
        });
        return { sent: true, channelDecisionId: decision.id, notification: sent };
      },
      compensate: async () => undefined,   // A sent welcome cannot be unsent.
    },
    {
      name: 'alert_stakeholders',
      optional: true,
      run: async (ctx) => {
        // INTERNAL audience: consent and deliverability do not apply to telling
        // your own AE, and the composer records that exemption rather than
        // leaving it as a check somebody skipped.
        const audiences = ['account_executive', 'sales_manager', 'finance', 'customer_success', 'leadership'];
        const notified: string[] = [];
        for (const audience of audiences) {
          const decision = await compose({
            subjectRef: input.subjectRef,
            channel: 'email',
            audience: 'internal',
            tenantId: input.tenantId ?? null,
            correlationId: ctx.correlationId,
            decidedBy: `closedWonSaga:${audience}`,
          });
          if (decision.verdict === 'deny') continue;
          await SdkGatewayClient.call({
            sdk: 'sdk-notification',
            path: '/api/notifications/send',
            method: 'POST',
            body: {
              tenant_id, audience, subject_ref: input.subjectRef,
              template_key: 'deal_closed_won', channel_decision_id: decision.id,
            },
            idempotencyKey: `${ctx.stepKey}:${audience}`,
            correlationId: ctx.correlationId,
          });
          notified.push(audience);
        }
        return { notified };
      },
      compensate: async () => undefined,
    },
    {
      name: 'create_handoff',
      run: async (ctx) => {
        const handoff = await call<Record<string, unknown>>(ctx, 'sdk-handoff', '/api/handoffs', {
          tenant_id,
          subject_ref: input.subjectRef,
          deal_id: input.dealId,
          from_owner_id: input.ownerId ?? null,
          kind: 'sales_to_onboarding',
        });
        if (paid) {
          /* THE 24-HOUR CLOCK STARTS HERE, from the payment rather than from
             whenever CS gets around to looking. ON CONFLICT DO NOTHING because a
             resumed saga must not restart the clock — a retry that reset it
             would hide exactly the overdue handoff the alert exists to find. */
          await dataService.query(
            `INSERT INTO leadflow_onboarding_handoff (tenant_id, subject_ref, deal_ref, charge_ref, paid_at)
             VALUES ($1,$2,$3,$4, now()) ON CONFLICT (tenant_id, subject_ref) DO NOTHING`,
            [input.tenantId ?? null, input.subjectRef, input.dealId, input.chargeId]
          );
        }
        return handoff;
      },
      compensate: async (ctx, result) => {
        await call(
          ctx,
          'sdk-handoff',
          `/api/handoffs/${encodeURIComponent(idOf(result, 'handoff_id', 'id'))}`,
          { tenant_id, status: 'cancelled', reason: 'closed-won saga rolled back' },
          'PATCH',
        );
      },
    },
    {
      name: 'onboarding_link',
      optional: true,
      run: (ctx) => call(ctx, 'sdk-scheduling', '/api/scheduling/scheduling-links', {
        tenant_id,
        subject_ref: input.subjectRef,
        meeting_type: 'onboarding_kickoff',
        owner_id: input.ownerId ?? null,
      }),
      compensate: async () => undefined,
    },
  ];
}

/**
 * Start or resume the closed-won saga for one deal.
 *
 * The key is the DEAL plus the CHARGE. A deal alone would collapse two genuine
 * closes of the same renewal into one; the charge alone would not survive a deal
 * being re-closed after a refund. Together they identify this close.
 */
export async function runClosedWon(input: ClosedWonInput): Promise<SagaResult> {
  const key = `closed_won:${input.dealId}:${input.chargeId}`;
  return runSaga('closed_won', key, closedWonSteps(input), input as unknown as Record<string, unknown>, {
    causationId: input.causationId ?? null,
  });
}

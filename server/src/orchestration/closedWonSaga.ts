import { SdkGatewayClient } from '../platform/sdkGateway';
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

export interface ClosedWonInput {
  /** The deal that closed. Half the idempotency key. */
  dealId: string;
  /** The charge that paid for it. The other half, and the payment evidence. */
  chargeId: string;
  subjectRef: string;
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

  return [
    {
      name: 'verify_payment',
      run: async (ctx) => {
        /*
         * VERIFIED FROM THE EVIDENCE PRESENTED, not by reading the charge back.
         * sdk-payment exposes charge, refund, distribute, methods and provider —
         * there is no GET for a charge, so there is nothing to verify against.
         *
         * What CAN be enforced, and is: no chargeId, no saga. Starting a
         * closed-won flow with no payment evidence at all is the failure that
         * matters, and it is caught here rather than eight steps later when a
         * licence has already been issued.
         */
        if (!input.chargeId) {
          throw new Error('chargeId is required — a closed-won saga with no payment evidence must not start');
        }
        return { chargeId: input.chargeId, verifiedFrom: 'caller_evidence', correlationId: ctx.correlationId };
      },
      compensate: async () => undefined,
    },
    {
      name: 'transition_deal',
      run: (ctx) => call(ctx, 'sdk-crm', `/api/crm/deals/${encodeURIComponent(input.dealId)}/transition`, {
        tenant_id,
        to_stage: 'CLOSED_WON_ONBOARDING_PENDING',
        reason_key: 'WON_STANDARD',
      }),
      compensate: async (ctx) => {
        // Forward action: move it back rather than pretending the transition
        // never happened. The stage history keeps both moves, which is correct —
        // a deal that briefly reached Closed Won and was rolled back is a fact.
        await call(ctx, 'sdk-crm', `/api/crm/deals/${encodeURIComponent(input.dealId)}/transition`, {
          tenant_id, to_stage: 'COMMERCIAL_REVIEW', reason_key: 'closed-won saga rolled back',
        });
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
      run: (ctx) => call(ctx, 'sdk-handoff', '/api/handoffs', {
        tenant_id,
        subject_ref: input.subjectRef,
        deal_id: input.dealId,
        from_owner_id: input.ownerId ?? null,
        kind: 'sales_to_onboarding',
      }),
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

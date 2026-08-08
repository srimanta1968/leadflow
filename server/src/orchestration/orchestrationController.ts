import { Router, type Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { authenticate } from '../middleware/auth';
import { AppError, ErrorCodes } from '../utils/errors';
import { governed, type GovernedRequest } from '../platform/policy/governed';
import { PERMISSIONS } from '../config/roles';
import { AUDIT_EVENTS } from '../platform/audit/vocabulary';
import { orchestrateIntake } from './leadIntakeOrchestrator';
import { runClosedWon } from './closedWonSaga';
import { sagaSteps } from './saga';
import { dataService } from '../services/DataService';
import { compose, composeBulk, type Channel, type ChannelDecisionInput } from './channelDecision';

export const orchestrationRoutes: Router = Router();

/*
 * BEHIND `authenticate`, and this line is load-bearing.
 *
 * `governed()` reads the caller's roles from req.session, which only exists once
 * authenticate has run. Without it rolesFor() returns an EMPTY array and every
 * request is refused with "No policy grants this action to the caller's roles" —
 * a message that points at the policy bundle and is therefore maximally
 * misleading, because the bundle is fine and the caller simply has no identity.
 *
 * Found by probing live: both a freshly registered user and the seeded operator
 * were refused, and sales_rep demonstrably holds message.send_approved in
 * roles.ts. The grant was never the problem.
 */
orchestrationRoutes.use(authenticate);

const CHANNELS: Channel[] = ['email', 'sms', 'call', 'social', 'push'];

/** Reads one decision request out of a body, or says exactly what is wrong. */
function readDecisionInput(body: Record<string, unknown>, at: string): ChannelDecisionInput {
  const subjectRef = typeof body.subjectRef === 'string' ? body.subjectRef : '';
  if (!subjectRef) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `${at}subjectRef is required`);
  }
  const channel = body.channel as Channel;
  if (!CHANNELS.includes(channel)) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `${at}channel must be one of: ${CHANNELS.join(', ')}`,
    );
  }
  const audience = body.audience === 'internal' ? 'internal' : 'prospect';
  /*
   * purposeKey is NOT defaulted for a prospect.
   *
   * A purpose is the basis on which somebody agreed to be contacted, so choosing
   * one for them invents that basis. The composer answers DENY when it is
   * missing, which keeps the caller's omission visible instead of quietly
   * supplying a value that would then appear in the consent record as though it
   * had been stated.
   */
  return {
    subjectRef,
    channel,
    audience,
    purposeKey: typeof body.purposeKey === 'string' ? body.purposeKey : undefined,
    tenantId: typeof body.tenantId === 'string' ? body.tenantId : null,
  };
}

/*
 * WHY EVERY ONE OF THESE IS WRAPPED IN asyncHandler.
 *
 * `governed()` returns an async function that THROWS on a deny — a 403 is its
 * normal, correct output, not an exceptional one. Express 4 does not catch a
 * rejected promise from a handler, so a bare `governed(...)` turns every refusal
 * into an unhandled rejection and, under ts-node-dev, kills the process.
 *
 * Found the hard way: the first live probe with a freshly registered user hit
 * "No policy grants this action to the caller's roles" — the PDP working exactly
 * as designed — and took the server down with it. The refusal was right; the
 * mounting was wrong.
 */

/**
 * POST /api/leadflow/intake/orchestrate — raw signal to acknowledged lead.
 *
 * 200, NOT 201. A replay of the same source event creates nothing and returns
 * the original ids, so 201 would be a lie on the second call — and the caller
 * cannot know in advance which call it is making. The body says `replayed`.
 */
orchestrationRoutes.post(
  '/intake/orchestrate',
  asyncHandler(governed(
    {
      action: PERMISSIONS.LEAD_WORK_ASSIGNED,
      event: AUDIT_EVENTS.CAPTURE_NORMALIZED,
      purpose: 'lead_management',
      resourceType: 'intake_signal',
      metadata: (req) => ({
        platform: (req.body as { platform?: string })?.platform ?? null,
        source_event_id: (req.body as { sourceEventId?: string })?.sourceEventId ?? null,
      }),
      obligations: {
        own_record_only: {
          kind: 'defer',
          because: 'intake decides whether a record exists at all, so there is no owner yet',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sourceEventId = typeof body.sourceEventId === 'string' ? body.sourceEventId : '';
      const platform = typeof body.platform === 'string' ? body.platform : '';
      if (!sourceEventId || !platform) {
        // Both halves of the idempotency key. Without either, a replay cannot be
        // recognised — which is the one property this endpoint exists to provide.
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'sourceEventId and platform are both required — together they are the idempotency key',
        );
      }

      const result = await orchestrateIntake({
        sourceEventId,
        platform,
        tenantId: typeof body.tenantId === 'string' ? body.tenantId : null,
        rawPayload: (body.rawPayload ?? {}) as Record<string, unknown>,
        occurredAt: typeof body.occurredAt === 'string' ? body.occurredAt : null,
        causationId: typeof body.causationId === 'string' ? body.causationId : null,
      });

      res.status(200).json({ success: true, data: result });
    },
  )),
);

/** POST /api/leadflow/channel-decision — may we contact this person, this way? */
orchestrationRoutes.post(
  '/channel-decision',
  asyncHandler(governed(
    {
      action: PERMISSIONS.MESSAGE_SEND_APPROVED,
      event: AUDIT_EVENTS.CAPTURE_NORMALIZED,
      purpose: 'lead_management',
      resourceType: 'channel_decision',
      metadata: (req) => ({
        channel: (req.body as { channel?: string })?.channel ?? null,
        audience: (req.body as { audience?: string })?.audience ?? 'prospect',
      }),
      obligations: {
        own_record_only: {
          kind: 'defer',
          because: 'a decision is about whether a subject may be contacted, not about who owns them',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const input = readDecisionInput((req.body ?? {}) as Record<string, unknown>, '');
      const decision = await compose({ ...input, decidedBy: req.session?.userId ?? null });
      // 200 EVEN FOR A DENY. The question was answered, and "no" is a successful
      // answer to "may I?" — a 403 would make a correct refusal look like the
      // caller lacked permission to ask it.
      res.status(200).json({ success: true, data: decision });
    },
  )),
);

/** POST /api/leadflow/channel-decision/bulk — the same question for many subjects. */
orchestrationRoutes.post(
  '/channel-decision/bulk',
  asyncHandler(governed(
    {
      action: PERMISSIONS.MESSAGE_SEND_APPROVED,
      event: AUDIT_EVENTS.CAPTURE_NORMALIZED,
      purpose: 'lead_management',
      resourceType: 'channel_decision',
      metadata: (req) => ({
        count: Array.isArray((req.body as { requests?: unknown[] })?.requests)
          ? (req.body as { requests: unknown[] }).requests.length
          : 0,
      }),
      obligations: {
        own_record_only: {
          kind: 'defer',
          because: 'a decision is about whether a subject may be contacted, not about who owns them',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const raw = (req.body as { requests?: unknown })?.requests;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'requests must be a non-empty array');
      }
      if (raw.length > 500) {
        // A cap with a STATED number rather than a silent truncation. Answering
        // 200 for the first 500 of 5,000 would let a campaign send to the other
        // 4,500 with no decision behind them at all.
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `requests may contain at most 500 entries, received ${raw.length}`,
        );
      }

      // Validated BEFORE any decision is composed, so a malformed entry at
      // position 400 does not leave 399 decisions already written to the ledger.
      const inputs = raw.map((entry, i) =>
        readDecisionInput((entry ?? {}) as Record<string, unknown>, `requests[${i}].`),
      );

      const decisions = await composeBulk(
        inputs.map((i) => ({ ...i, decidedBy: req.session?.userId ?? null })),
      );
      res.status(200).json({
        success: true,
        data: {
          decisions,
          allowed: decisions.filter((d) => d.verdict === 'allow').length,
          review: decisions.filter((d) => d.verdict === 'review').length,
          denied: decisions.filter((d) => d.verdict === 'deny').length,
        },
      });
    },
  )),
);

/**
 * POST /api/leadflow/closed-won/start — start or RESUME the closed-won saga.
 *
 * One endpoint for both, deliberately. A caller retrying after a timeout cannot
 * know whether the first attempt died mid-saga, and making them choose between
 * "start" and "resume" guarantees somebody eventually picks wrong. The runner
 * reads the step ledger and continues from the first unfinished step, so the
 * same call is correct in every case — the body reports `replayed` and `resumed`
 * so the caller can tell what actually happened.
 */
orchestrationRoutes.post(
  '/closed-won/start',
  asyncHandler(governed(
    {
      action: PERMISSIONS.ONBOARDING_MANAGE,
      event: AUDIT_EVENTS.CAPTURE_NORMALIZED,
      purpose: 'lead_management',
      resourceType: 'deal',
      resourceId: (req) => (req.body as { dealId?: string })?.dealId,
      metadata: (req) => ({
        deal_id: (req.body as { dealId?: string })?.dealId ?? null,
        charge_id: (req.body as { chargeId?: string })?.chargeId ?? null,
      }),
      obligations: {
        own_record_only: {
          kind: 'defer',
          because: 'a closed-won handoff crosses from sales to onboarding, so it belongs to neither one alone',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const dealId = typeof body.dealId === 'string' ? body.dealId : '';
      const chargeId = typeof body.chargeId === 'string' ? body.chargeId : '';
      const subjectRef = typeof body.subjectRef === 'string' ? body.subjectRef : '';
      if (!dealId || !chargeId || !subjectRef) {
        // chargeId is REQUIRED and is the payment evidence. sdk-payment exposes
        // no charge read, so this is the only verification available — and a
        // closed-won saga starting with no payment evidence at all is precisely
        // the failure worth catching before a licence is issued.
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          'dealId, chargeId and subjectRef are all required — dealId and chargeId together identify this close',
        );
      }

      const result = await runClosedWon({
        dealId,
        chargeId,
        subjectRef,
        tenantId: typeof body.tenantId === 'string' ? body.tenantId : null,
        ownerId: typeof body.ownerId === 'string' ? body.ownerId : null,
        enrollmentIds: Array.isArray(body.enrollmentIds) ? (body.enrollmentIds as string[]) : [],
        campaignIds: Array.isArray(body.campaignIds) ? (body.campaignIds as string[]) : [],
        causationId: typeof body.causationId === 'string' ? body.causationId : null,
      });

      res.status(200).json({ success: true, data: result });
    },
  )),
);

/**
 * GET /api/leadflow/sagas/:run_id — the run and its step ledger.
 *
 * The ledger is the point rather than the summary: "which steps ran, which were
 * compensated, and which compensation itself failed" is what an operator
 * reconciles a half-finished saga from, and a status field alone cannot say it.
 */
orchestrationRoutes.get(
  '/sagas/:run_id',
  asyncHandler(governed(
    {
      action: PERMISSIONS.ONBOARDING_MANAGE,
      event: AUDIT_EVENTS.CAPTURE_NORMALIZED,
      purpose: 'lead_management',
      resourceType: 'saga_run',
      resourceId: (req) => String(req.params.run_id),
      metadata: (req) => ({ run_id: String(req.params.run_id) }),
      obligations: {
        own_record_only: {
          kind: 'defer',
          because: 'a saga run is operational state, not a record with an owner',
        },
      },
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const runId = String(req.params.run_id);
      const runs = await dataService.query<Record<string, unknown>>(
        `SELECT idempotency_key, saga_name, status, correlation_id, causation_id,
                output, failed_step, error, started_at, finished_at
           FROM leadflow_saga_run WHERE idempotency_key = $1`,
        [runId],
      );
      if (runs.length === 0) {
        throw new AppError(404, ErrorCodes.NOT_FOUND, 'No saga run with that id');
      }
      res.status(200).json({
        success: true,
        data: { run: runs[0], steps: await sagaSteps(runId) },
      });
    },
  )),
);

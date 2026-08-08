import { SdkGatewayClient } from '../platform/sdkGateway';
import { compose } from './channelDecision';
import { runSaga, type SagaResult, type SagaStep, type StepContext } from './saga';

/**
 * Raw signal to acknowledged, assigned lead — as ONE saga.
 *
 * Nine ProjexCloud calls that used to be nine independent decisions scattered
 * across the capture services, each with its own idea of what to do when the
 * previous one had already half-succeeded. Under one idempotency key and one
 * causation chain, a redelivered intake event produces exactly one of each
 * artefact, and a failure at step six leaves nothing behind from steps one to
 * five.
 *
 * EVERY COMPENSATION IS A FORWARD ACTION. You cannot un-create a CRM contact, so
 * the undo is to retire it. Where an SDK offers no retirement the compensation
 * says so in the log rather than pretending — a silent no-op would read as a
 * clean rollback while the artefact is still there.
 */

export interface IntakeInput {
  /** The provider's own event id. This IS the idempotency key. */
  sourceEventId: string;
  platform: string;
  tenantId?: string | null;
  rawPayload: Record<string, unknown>;
  occurredAt?: string | null;
  causationId?: string | null;
}

const ok = <T>(v: T | null | undefined, what: string): T => {
  if (v === null || v === undefined) throw new Error(`${what} returned nothing usable`);
  return v;
};

/** One gateway call, tagged with the saga's identity. */
async function call<T>(ctx: StepContext, sdk: string, path: string, body: unknown): Promise<T> {
  const res = await SdkGatewayClient.call<{ data?: T }>({
    sdk,
    path,
    method: 'POST',
    body,
    // The step key, not a fresh uuid. A retry of this step alone presents the
    // same key upstream and cannot create a second artefact.
    idempotencyKey: ctx.stepKey,
    correlationId: ctx.correlationId,
  });
  if (!res.delivered) throw new Error(`${sdk} is not configured, so ${path} could not run`);
  return ok(res.data?.data as T, `${sdk} ${path}`);
}

type Ref = { id?: string; [k: string]: unknown };
const idOf = (r: unknown, ...keys: string[]): string => {
  const o = (r ?? {}) as Record<string, unknown>;
  for (const k of keys) if (typeof o[k] === 'string') return o[k] as string;
  throw new Error(`no id in ${JSON.stringify(o).slice(0, 120)}`);
};

export function intakeSteps(input: IntakeInput): SagaStep[] {
  const tenant_id = input.tenantId ?? undefined;

  return [
    {
      name: 'source_record',
      run: (ctx) => call<Ref>(ctx, 'sdk-source-record', '/api/source-records', {
        tenant_id,
        platform: input.platform,
        source_event_id: input.sourceEventId,
        payload: input.rawPayload,
        occurred_at: input.occurredAt ?? null,
      }),
      // NOT RETIRED. The source record is the evidence that the signal arrived,
      // and it is the one artefact that must outlive a failed intake — otherwise
      // a rollback erases the proof that we ever heard from this person, which
      // is exactly what an incident review needs.
      compensate: async () => undefined,
    },
    {
      name: 'parse_contact',
      run: (ctx) => call<Ref>(ctx, 'sdk-parsing', '/api/parsing/contact/extract', {
        tenant_id,
        payload: input.rawPayload,
      }),
      // Pure computation upstream — nothing was stored, so nothing to undo.
      compensate: async () => undefined,
    },
    {
      name: 'resolve_identity',
      run: (ctx) => call<Ref>(ctx, 'sdk-identity-resolver', '/api/resolver/resolve', {
        tenant_id,
        source_record_id: idOf(ctx.results.source_record, 'source_record_id', 'id'),
        contact: ctx.results.parse_contact,
      }),
      compensate: async () => undefined,
    },
    {
      name: 'crm_contact',
      run: (ctx) => call<Ref>(ctx, 'sdk-crm', '/api/crm/contacts', {
        tenant_id,
        subject_ref: idOf(ctx.results.resolve_identity, 'subject_ref', 'entity_id', 'id'),
        ...(ctx.results.parse_contact as Record<string, unknown>),
      }),
      compensate: async (ctx, result) => {
        await SdkGatewayClient.call({
          sdk: 'sdk-crm',
          path: `/api/crm/contacts/${idOf(result, 'contact_id', 'id')}`,
          method: 'PATCH',
          // Retired, not deleted: other artefacts already reference this id, and
          // deleting it would break them rather than undo it.
          body: { tenant_id, status: 'retired', retired_reason: 'intake saga rolled back' },
          idempotencyKey: `${ctx.stepKey}:compensate`,
          correlationId: ctx.correlationId,
        });
      },
    },
    {
      name: 'crm_deal',
      run: (ctx) => call<Ref>(ctx, 'sdk-crm', '/api/crm/deals', {
        tenant_id,
        contact_id: idOf(ctx.results.crm_contact, 'contact_id', 'id'),
        stage_key: 'NEW_UNWORKED',
      }),
      compensate: async (ctx, result) => {
        await SdkGatewayClient.call({
          sdk: 'sdk-crm',
          path: `/api/crm/deals/${idOf(result, 'deal_id', 'id')}`,
          method: 'PATCH',
          body: { tenant_id, status: 'void', void_reason: 'intake saga rolled back' },
          idempotencyKey: `${ctx.stepKey}:compensate`,
          correlationId: ctx.correlationId,
        });
      },
    },
    {
      name: 'score',
      run: (ctx) => call<Ref>(ctx, 'sdk-lead-scoring', '/api/lead-scoring/score', {
        tenant_id,
        deal_id: idOf(ctx.results.crm_deal, 'deal_id', 'id'),
        signals: input.rawPayload,
      }),
      // A score is an opinion attached to a deal that is itself being voided, so
      // it disappears with it. Nothing to undo on its own.
      compensate: async () => undefined,
    },
    {
      name: 'assign',
      run: (ctx) => call<Ref>(ctx, 'sdk-assignment', '/api/assignment/route', {
        tenant_id,
        subject_ref: idOf(ctx.results.crm_deal, 'deal_id', 'id'),
        priority: (ctx.results.score as Record<string, unknown> | undefined)?.band ?? 'P2',
      }),
      compensate: async (ctx, result) => {
        await SdkGatewayClient.call({
          sdk: 'sdk-assignment',
          path: '/api/assignment/route',
          method: 'POST',
          // Unassigning matters more than it looks: a representative left holding
          // a lead that was rolled back has it in their queue with nothing behind
          // it, and they will work it.
          body: {
            tenant_id,
            subject_ref: idOf(ctx.results.crm_deal, 'deal_id', 'id'),
            unassign: true,
            reason: 'intake saga rolled back',
          },
          idempotencyKey: `${ctx.stepKey}:compensate`,
          correlationId: ctx.correlationId,
        });
      },
    },
    {
      name: 'sla_clock',
      run: (ctx) => call<Ref>(ctx, 'sdk-sla', '/api/sla/clocks', {
        tenant_id,
        subject_ref: idOf(ctx.results.crm_deal, 'deal_id', 'id'),
        owner_id: idOf(ctx.results.assign, 'owner_id', 'assignee_id'),
        priority: (ctx.results.score as Record<string, unknown> | undefined)?.band ?? 'P2',
      }),
      compensate: async (ctx, result) => {
        await SdkGatewayClient.call({
          sdk: 'sdk-sla',
          path: '/api/sla/clocks',
          method: 'POST',
          // A clock left running against a voided deal breaches, escalates, and
          // pages somebody about a lead that does not exist.
          body: {
            tenant_id,
            subject_ref: idOf(ctx.results.crm_deal, 'deal_id', 'id'),
            cancel: true,
            clock_id: idOf(result, 'clock_id', 'id'),
            reason: 'intake saga rolled back',
          },
          idempotencyKey: `${ctx.stepKey}:compensate`,
          correlationId: ctx.correlationId,
        });
      },
    },
    {
      name: 'next_action',
      run: (ctx) => call<Ref>(
        ctx,
        'sdk-crm',
        `/api/crm/subjects/${encodeURIComponent(idOf(ctx.results.crm_deal, 'deal_id', 'id'))}/next-action`,
        {
          tenant_id,
          action: 'First contact attempt',
          due_at: (ctx.results.sla_clock as Record<string, unknown> | undefined)?.due_at ?? null,
          owner_id: idOf(ctx.results.assign, 'owner_id', 'assignee_id'),
        },
      ),
      compensate: async (ctx, result) => {
        await SdkGatewayClient.call({
          sdk: 'sdk-crm',
          path: `/api/crm/next-actions/${idOf(result, 'next_action_id', 'id')}/reschedule`,
          method: 'POST',
          body: { tenant_id, cancel: true, reason: 'intake saga rolled back' },
          idempotencyKey: `${ctx.stepKey}:compensate`,
          correlationId: ctx.correlationId,
        });
      },
    },
    {
      name: 'acknowledge',
      // OPTIONAL. The lead exists, is assigned, has a clock and a NEXT action;
      // the only thing that failed is telling them so. Rolling all of that back
      // over an undelivered text is destroying good work over the least
      // consequential step in the chain.
      optional: true,
      run: async (ctx) => {
        const subjectRef = idOf(ctx.results.resolve_identity, 'subject_ref', 'entity_id', 'id');
        // THROUGH THE COMPOSER, like every other send. An acknowledgement is a
        // message to a person, and being first does not exempt it from consent.
        const decision = await compose({
          subjectRef,
          channel: 'email',
          purposeKey: 'inspection_estimate',
          tenantId: input.tenantId ?? null,
          correlationId: ctx.correlationId,
          decidedBy: 'leadIntakeOrchestrator',
        });
        if (decision.verdict !== 'allow') {
          // NOT AN ERROR. A refusal here is the system working: the lead is
          // still created and assigned, and the reason is carried back so a
          // person can see why no acknowledgement went out.
          return { sent: false, channelDecisionId: decision.id, verdict: decision.verdict, reasons: decision.reasons };
        }
        const sent = await call<Ref>(ctx, 'sdk-notification', '/api/notifications/send', {
          tenant_id,
          subject_ref: subjectRef,
          channel: 'email',
          template_key: 'lead_acknowledgement',
          channel_decision_id: decision.id,
        });
        return { sent: true, channelDecisionId: decision.id, notification: sent };
      },
      compensate: async () => undefined,   // A sent message cannot be unsent.
    },
  ];
}

/**
 * Run the intake saga for one signal.
 *
 * The idempotency key is the PROVIDER's event id, not one we mint. That is what
 * makes a redelivery collapse: a key generated here would be unique per call,
 * which is precisely the wrong property.
 */
export async function orchestrateIntake(input: IntakeInput): Promise<SagaResult> {
  const key = `intake:${input.platform}:${input.sourceEventId}`;
  return runSaga('lead_intake', key, intakeSteps(input), input as unknown as Record<string, unknown>, {
    causationId: input.causationId ?? null,
  });
}

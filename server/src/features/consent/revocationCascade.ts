import { dataService } from '../../services/DataService';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { revokeReceipt } from './consentGateway';

/**
 * What has to stop when somebody says stop.
 *
 * SUPPRESSION ALONE IS NOT ENOUGH, and that is the whole reason this file
 * exists. Writing "suppressed" into the ledger stops anything that ASKS the
 * ledger — which is every send the channel-decision composer authorises from
 * that moment on. It does nothing about work already committed: a sequence
 * with four steps queued, an audience the subject is already inside, an
 * automated task holding a reminder to call them. Those fire from their own
 * schedules and never consult a decision made after they were enqueued.
 *
 * THE RECEIPT IS REVOKED, NEVER DELETED. Withdrawing permission and destroying
 * the record of what was once agreed are opposite acts: the second one removes
 * the evidence that the earlier messages were lawful, which is exactly what the
 * tenant needs if the subject later disputes them. sdk-consent's revoke marks
 * the receipt withdrawn and keeps it.
 *
 * EVERY STEP RECORDS ITS OWN OUTCOME. A cascade that cancelled the sequence but
 * could not reach the campaign service is a PARTIAL stop, and reporting it as
 * success would hide a channel that can still send. `complete` is true only
 * when nothing was left unreachable.
 */

export type StepOutcome = 'done' | 'unreachable' | 'nothing_to_do';

export interface CascadeStep {
  step: string;
  outcome: StepOutcome;
  detail: string;
}

export interface CascadeResult {
  cascadeId: string;
  steps: CascadeStep[];
  /** True only when no step was left unreachable. */
  complete: boolean;
}

export interface CascadeInput {
  signalId: string;
  subjectRef: string;
  tenantId?: string | null;
  channels: string[];
  reason: string;
  receiptRef?: string;
  correlationId?: string;
}

/**
 * One upstream stop, reduced to a step outcome.
 *
 * AN UNREACHABLE UPSTREAM IS NOT A FAILED CASCADE and it is not a successful
 * one either. It is recorded as `unreachable`, which keeps `complete` false and
 * puts the cascade on the list somebody works through — the honest position
 * being that we asked and do not know whether it landed.
 */
async function attempt(
  step: string,
  call: () => Promise<{ delivered: boolean; status: number | null }>,
): Promise<CascadeStep> {
  try {
    const res = await call();
    return res.delivered
      ? { step, outcome: 'done', detail: `accepted (${res.status ?? 200})` }
      : { step, outcome: 'unreachable', detail: 'the service is not configured in this environment' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { step, outcome: 'unreachable', detail: message };
  }
}

export async function runCascade(input: CascadeInput): Promise<CascadeResult> {
  const steps: CascadeStep[] = [];

  /*
   * ORDER IS DELIBERATE: stop the things that can SEND before touching the
   * things that merely record. If the process dies halfway through, the half
   * that ran is the half that prevents a message.
   */

  // 1. Queued sequence steps. The enrollment is cancelled rather than paused —
  //    a pause is resumable, and nothing about a STOP is resumable.
  steps.push(await attempt('sequence_enrollments', async () =>
    SdkGatewayClient.call({
      sdk: 'sdk-sequence',
      path: '/api/sequences/enrollments/control',
      method: 'POST',
      body: {
        tenant_id: input.tenantId ?? undefined,
        subject_ref: input.subjectRef,
        action: 'cancel',
        reason: input.reason,
        channels: input.channels,
      },
      correlationId: input.correlationId,
    })));

  // 2. Active campaign audiences. Removal, not exclusion-on-next-build: the
  //    next build may be after the next send.
  steps.push(await attempt('campaign_audiences', async () =>
    SdkGatewayClient.call({
      sdk: 'sdk-campaign',
      path: '/api/campaigns/audiences/remove-subject',
      method: 'POST',
      body: {
        tenant_id: input.tenantId ?? undefined,
        subject_ref: input.subjectRef,
        reason: input.reason,
        channels: input.channels,
      },
      correlationId: input.correlationId,
    })));

  // 3. The provider's own suppression list. Ours already refuses; this stops
  //    the provider from sending anything we did not originate, and is the
  //    state the daily reconciliation compares against.
  steps.push(await attempt('provider_suppressions', async () =>
    SdkGatewayClient.call({
      sdk: 'sdk-deliverability',
      path: '/api/deliverability/suppressions',
      method: 'POST',
      body: {
        tenant_id: input.tenantId ?? undefined,
        subject_ref: input.subjectRef,
        channels: input.channels,
        reason: input.reason,
      },
      correlationId: input.correlationId,
    })));

  /*
   * 4. Sends already QUEUED LOCALLY.
   *
   * This is the step that actually delivers "within one tick", and it is the
   * only one that does not depend on an upstream being reachable. The outbox
   * holds intentions that have been accepted but not yet dispatched; the
   * dispatcher reads it on its own schedule and does NOT re-ask the composer,
   * because the decision was made when the row was written. A STOP that leaves
   * those rows pending is a STOP that still sends.
   *
   * Only notification sends are cancelled. The outbox also carries audit
   * appends, evidence captures and consent writes for this subject, and those
   * must still go out — cancelling the audit trail of a revocation because the
   * subject revoked is precisely backwards.
   */
  const cancelled = await dataService.query<{ id: string }>(
    `UPDATE leadflow_outbox
        SET status = 'cancelled',
            last_error = $3
      WHERE status = 'pending'
        AND sdk = 'sdk-notification'
        AND COALESCE(payload->>'subject_ref', payload->>'subjectRef') = $1
        AND (
          payload->>'channel' IS NULL
          OR payload->>'channel' = ANY($2::text[])
        )
      RETURNING id`,
    [input.subjectRef, input.channels, `cancelled by revocation cascade: ${input.reason}`],
  );
  steps.push({
    step: 'queued_sends',
    outcome: cancelled.length > 0 ? 'done' : 'nothing_to_do',
    detail: `${cancelled.length} pending notification(s) cancelled`,
  });

  // 5. The receipt. LAST, and revoked rather than removed.
  if (input.receiptRef) {
    steps.push(await attempt('consent_receipt', async () => {
      // revokeReceipt answers with the upstream body, or null when it could not
      // be reached — there is no separate delivered flag to read.
      const body = await revokeReceipt(input.receiptRef as string, input.reason);
      return { delivered: body !== null, status: body !== null ? 200 : null };
    }));
  } else {
    steps.push({
      step: 'consent_receipt',
      outcome: 'nothing_to_do',
      detail: 'the signal named no receipt, so there is no basis to withdraw',
    });
  }

  const complete = steps.every((s) => s.outcome !== 'unreachable');

  const rows = await dataService.query<{ id: string }>(
    `INSERT INTO leadflow_revocation_cascade (signal_id, subject_ref, steps, complete)
     VALUES ($1,$2,$3::jsonb,$4)
     RETURNING id`,
    [input.signalId, input.subjectRef, JSON.stringify(steps), complete],
  );

  return { cascadeId: rows[0].id, steps, complete };
}

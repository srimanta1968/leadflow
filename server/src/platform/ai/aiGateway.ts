import { randomUUID } from 'crypto';
import { agentByKey } from '../../config/aiAgents';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { AppError, ErrorCodes } from '../../utils/errors';
import { budgetTenantId, releaseReservation, reserveTokens, settleTokens } from './aiBudget';
import { verifyAiConsentBasis } from './aiConsent';
import { recordCompletion } from './activityLedger';
import { assertAiPermitted } from './killSwitch';
import { renderTemplate, resolveTemplate } from './promptLibrary';
import { redactSlots } from './redaction';

/**
 * The AI gateway — the ONLY way a prompt leaves this application.
 *
 * THE FOUR CONTROLS ARE NOT OPTIONAL ARGUMENTS, they are the function. Every
 * completion passes consent, budget, redaction and trace, in that order, and
 * every one of them lands in the activity ledger before the caller gets a
 * result. The alternative — a `complete(prompt)` with the controls left to
 * callers — makes the guarantee "we remembered at each call site", which is a
 * guarantee only until the next call site.
 *
 * ORDER MATTERS AND IS NOT NEGOTIABLE:
 *   0. The kill switch, before anything else. A halted system does not spend a
 *      consent check or a token on deciding not to run.
 *   1. Template resolution, so an unapproved prompt is refused before any
 *      personal data is touched.
 *   2. Consent, before the budget: refusing on consent must not cost the tenant
 *      a reservation.
 *   3. Budget reservation, before the call, because a budget checked afterwards
 *      is not a budget.
 *   4. Redaction, immediately before the payload is serialised, so nothing added
 *      between here and the wire escapes it.
 *
 * There is NO raw-prompt entry point. `slots` are values; the text they go into
 * is approved copy from the versioned library.
 */

export interface CompletionRequest {
  /** Agent from `config/aiAgents.ts`. Decides the template, purpose and reach. */
  agentKey: string;
  /** Values for the template's declared slots. Redacted before they leave. */
  slots: Record<string, string>;
  /** Consent receipt this completion is permitted under. */
  consentBasisRef?: string | null;
  /** The run this belongs to, when an agent run is driving it. */
  runId?: string | null;
  /** Rough size, used for the reservation. Settled against actual usage after. */
  estimatedTokens?: number;
  /** Streaming rather than a single response. */
  stream?: boolean;
}

export interface CompletionResult {
  /** The ledger row. Stamped onto any proposal this completion produces. */
  completionId: string;
  traceId: string;
  text: string;
  templateKey: string;
  templateVersion: string;
  tokensUsed: number;
  redactedSpanCount: number;
  /** True when the answer came from the gateway rather than a local fallback. */
  delivered: boolean;
}

/**
 * A default estimate, in tokens.
 *
 * Used when the caller does not supply one. Deliberately generous relative to
 * the templates in the library: under-reserving lets a burst overshoot the
 * period allowance, and the reservation is settled against actual usage a moment
 * later anyway, so an overestimate costs a tenant nothing.
 */
const DEFAULT_ESTIMATE_TOKENS = 1500;

/** Rough token count for the reservation, when the caller has no better number. */
function estimateFor(rendered: string): number {
  // Four characters per token is the usual rule of thumb and is close enough for
  // a reservation that gets settled. The output is assumed to be about as long
  // as the input, hence the doubling.
  return Math.max(DEFAULT_ESTIMATE_TOKENS, Math.ceil((rendered.length / 4) * 2));
}

/**
 * Run one completion through the four controls.
 *
 * @throws AppError(503 AI_HALTED) when the kill switch is engaged.
 * @throws AppError(422 AI_CONSENT_BASIS_MISSING) when consent cannot be shown.
 * @throws AppError(429 AI_BUDGET_EXHAUSTED) when the period allowance is gone.
 * @throws AppError(422 PROMPT_TEMPLATE_NOT_PERMITTED) for an unapproved template.
 */
export async function complete(request: CompletionRequest): Promise<CompletionResult> {
  // CONTROL 4 FIRST, because a refusal needs one too. A trace minted only on the
  // success path leaves every refusal uncorrelatable with the request that
  // caused it — and refusals are what an incident review reads.
  const traceId = `tr_${randomUUID()}`;
  const tenantId = budgetTenantId();

  const agent = agentByKey(request.agentKey);
  if (!agent) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `No AI agent is registered under '${request.agentKey}'`
    );
  }

  // A ledger row for a refusal, written before the throw so the refusal is a
  // record rather than a log line. Template key and version come from the pinned
  // registry because a refusal may happen before resolution.
  const recordRefusal = async (
    outcome: 'refused_halted' | 'refused_consent' | 'refused_budget' | 'refused_template',
    reason: string,
    templateVersion = 'unresolved'
  ): Promise<void> => {
    await recordCompletion({
      tenantId,
      agentKey: agent.key,
      runId: request.runId ?? null,
      promptTemplateKey: agent.promptTemplateKey,
      promptTemplateVersion: templateVersion,
      purpose: agent.consentPurpose,
      traceId,
      outcome,
      refusalReason: reason,
    });
  };

  // ---- 0. Kill switch --------------------------------------------------
  try {
    await assertAiPermitted();
  } catch (error) {
    await recordRefusal('refused_halted', 'kill_switch_engaged');
    throw error;
  }

  // ---- 1. Approved prompt ----------------------------------------------
  let template;
  try {
    template = await resolveTemplate(agent.promptTemplateKey);
  } catch (error) {
    await recordRefusal('refused_template', 'template_not_registered');
    throw error;
  }

  // ---- 2. Consent -------------------------------------------------------
  const consent = await verifyAiConsentBasis(
    request.consentBasisRef ?? null,
    agent.consentPurpose
  );
  if (!consent.permitted) {
    await recordRefusal('refused_consent', consent.reason ?? 'consent_not_verified', template.version);
    throw new AppError(
      422,
      ErrorCodes.AI_CONSENT_BASIS_MISSING,
      `This completion has no verified consent basis (${consent.reason ?? 'unknown'}).`
    );
  }

  // ---- 3. Redaction -----------------------------------------------------
  // Before the budget reservation, because rendering is what produces the size
  // estimate the reservation is made from — and because redaction must run on
  // the exact values that will be serialised, not on an earlier copy.
  const redaction = redactSlots(request.slots);
  const rendered = renderTemplate(template, redaction.slots);

  // ---- 4. Budget --------------------------------------------------------
  let reservation;
  try {
    reservation = await reserveTokens(request.estimatedTokens ?? estimateFor(rendered));
  } catch (error) {
    await recordRefusal('refused_budget', 'period_allowance_exhausted', template.version);
    throw error;
  }

  // ---- The call ---------------------------------------------------------
  if (!SdkGatewayClient.isConfigured()) {
    // No gateway. The reservation is returned rather than kept: nothing was
    // generated, so charging for it would make the budget report spend that
    // never happened — and on a developer machine that is every completion.
    await releaseReservation(reservation);
    const completionId = await recordCompletion({
      tenantId,
      agentKey: agent.key,
      runId: request.runId ?? null,
      promptTemplateKey: template.key,
      promptTemplateVersion: template.version,
      purpose: agent.consentPurpose,
      consentBasisRef: consent.basisRef,
      consentMethod: consent.method,
      budgetReservationRef: reservation.ref,
      tokensCharged: 0,
      redactionApplied: redaction.applied,
      redactedSpanCount: redaction.spanCount,
      traceId,
      outcome: 'upstream_error',
      refusalReason: 'gateway_not_configured',
    });

    throw new AppError(
      502,
      ErrorCodes.UPSTREAM_UNAVAILABLE,
      'No AI gateway is configured, so no completion was produced.',
      { completionId, traceId }
    );
  }

  try {
    const result = await SdkGatewayClient.call<{
      data?: { completion_id?: string; text?: string; usage?: { total_tokens?: number } };
    }>({
      sdk: 'sdk-ai-gateway',
      path: request.stream ? '/api/ai-gateway/stream' : '/api/ai-gateway/complete',
      method: 'POST',
      // The trace is the idempotency key: a retry of the SAME completion must
      // not be billed twice upstream, and a new attempt has a new trace.
      idempotencyKey: traceId,
      correlationId: traceId,
      body: {
        tenant_id: tenantId,
        agent: agent.key,
        // The template KEY and VERSION travel with the prompt so the gateway's
        // own record names the approved copy rather than only the rendered text.
        prompt_template: { key: template.key, version: template.version },
        prompt: rendered,
        purpose: agent.consentPurpose,
        consent_basis_ref: consent.basisRef,
        // Declared so the gateway can enforce it too. Belt and braces: the
        // reservation above is ours, this is the ceiling it will not exceed.
        max_tokens: reservation.reservedTokens,
        trace_id: traceId,
      },
    });

    const text = result.data?.data?.text ?? '';
    const tokensUsed = result.data?.data?.usage?.total_tokens ?? reservation.reservedTokens;

    await settleTokens(reservation, tokensUsed);

    const completionId = await recordCompletion({
      tenantId,
      agentKey: agent.key,
      runId: request.runId ?? null,
      promptTemplateKey: template.key,
      promptTemplateVersion: template.version,
      purpose: agent.consentPurpose,
      consentBasisRef: consent.basisRef,
      consentMethod: consent.method,
      budgetReservationRef: reservation.ref,
      tokensCharged: tokensUsed,
      redactionApplied: redaction.applied,
      redactedSpanCount: redaction.spanCount,
      traceId,
      upstreamCompletionId: result.data?.data?.completion_id ?? null,
      outcome: 'completed',
    });

    return {
      completionId,
      traceId,
      text,
      templateKey: template.key,
      templateVersion: template.version,
      tokensUsed,
      redactedSpanCount: redaction.spanCount,
      delivered: true,
    };
  } catch (error) {
    // The provider failed after the reservation. Return it — nothing was
    // generated — and record the attempt, because "the gateway was failing all
    // morning" is a thing an operator needs to be able to see.
    await releaseReservation(reservation);
    const message = error instanceof Error ? error.message : String(error);
    await recordCompletion({
      tenantId,
      agentKey: agent.key,
      runId: request.runId ?? null,
      promptTemplateKey: template.key,
      promptTemplateVersion: template.version,
      purpose: agent.consentPurpose,
      consentBasisRef: consent.basisRef,
      consentMethod: consent.method,
      budgetReservationRef: reservation.ref,
      tokensCharged: 0,
      redactionApplied: redaction.applied,
      redactedSpanCount: redaction.spanCount,
      traceId,
      outcome: 'upstream_error',
      refusalReason: message.slice(0, 64),
    });

    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(502, ErrorCodes.UPSTREAM_UNAVAILABLE, 'The AI gateway is unavailable');
  }
}

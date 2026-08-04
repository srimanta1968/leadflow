import { dataService } from '../../services/DataService';
import {
  APPROVED_OBJECTIONS,
  COACHING_DIMENSIONS,
  LACE_STEPS,
  objectionByKey,
} from '../../config/coachingScorecard';
import { SdkGatewayClient } from '../../services/projexcloud/SdkGatewayClient';
import { AppError, ErrorCodes } from '../../utils/errors';
import { ConsentVerification, verifyRecordingBasis } from './recordingConsent';
import { appendAuditEntry } from '../../platform/audit/auditLog';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';

/**
 * The AI Sales Coach module.
 *
 * Scores a call against the SOP coaching scorecard and returns one behaviour to
 * keep, one to change and one practice assignment — the SOP's biweekly
 * individual coaching output, not a wall of metrics.
 */

export interface DimensionScore {
  key: string;
  label: string;
  /** 0-5, the SOP scorecard's own scale. Null when the call gave no evidence. */
  score: number | null;
  lookFor: string;
  evidence: string | null;
}

export interface DetectedObjection {
  key: string | null;
  heard: string;
  /** The approved LACE response, or null when nothing in the library matches. */
  approvedResponse: string | null;
  approvedNextAction: string | null;
  /**
   * True when the library has no entry.
   *
   * Reported rather than filled in. An invented rebuttal is how an unapproved
   * claim reaches a prospect wearing the authority of the SOP — and it would
   * carry that authority precisely BECAUSE it appeared in the coaching tool.
   */
  unmapped: boolean;
}

export interface Scorecard {
  callId: string;
  dimensions: DimensionScore[];
  /** Always the SOP's ten. Present so a caller can assert it cheaply. */
  dimensionCount: number;
  laceFrame: { key: string; label: string }[];
  missedQuestions: string[];
  objections: DetectedObjection[];
  keepBehaviour: string | null;
  changeBehaviour: string | null;
  practiceAssignment: string | null;
  /** How the recording basis was verified, stamped onto the artefact. */
  consentVerification: ConsentVerification;
}

export interface RegisterCallInput {
  externalCallId: string;
  repEmail: string | null;
  leadId: string | null;
  occurredAt: string;
  recordingConsentBasisRef: string | null;
  recordingConsentCapturedAt: string | null;
}

/**
 * Register a call for coaching.
 *
 * THE BASIS IS CAPTURED HERE, at the moment of recording, because that is the
 * only moment it can be captured honestly. A basis reconstructed later is a
 * guess about what the prospect was told.
 *
 * NO TRANSCRIPT CONTENT IS STORED. Only identifiers, the basis, and the pointer
 * to sdk-conversation — so a call whose consent is later revoked has no content
 * in this database to purge. The safest place to keep call content is somewhere
 * it never was.
 */
export async function registerCall(input: RegisterCallInput): Promise<{
  id: string;
  hasRecordingBasis: boolean;
}> {
  if (!input.recordingConsentBasisRef || !input.recordingConsentCapturedAt) {
    throw new AppError(
      422,
      ErrorCodes.RECORDING_CONSENT_MISSING,
      'A recording consent basis is required before a call may be registered'
    );
  }

  const row = await dataService.queryOne<{ id: string }>(
    `INSERT INTO ai_coach_call
       (external_call_id, rep_email, lead_id, occurred_at,
        recording_consent_basis_ref, recording_consent_captured_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (external_call_id) DO UPDATE
       SET rep_email = EXCLUDED.rep_email
     RETURNING id`,
    [
      input.externalCallId,
      input.repEmail,
      input.leadId,
      new Date(input.occurredAt),
      input.recordingConsentBasisRef,
      new Date(input.recordingConsentCapturedAt),
    ]
  );

  return { id: row!.id, hasRecordingBasis: true };
}

/** Match a heard objection against the approved library. */
export function mapObjection(heard: string): DetectedObjection {
  const needle = heard.toLowerCase();
  const match = APPROVED_OBJECTIONS.find((entry) => {
    const key = entry.objection.toLowerCase().replace(/[.]/g, '');
    return needle.includes(key) || key.includes(needle);
  });

  if (!match) {
    return { key: null, heard, approvedResponse: null, approvedNextAction: null, unmapped: true };
  }

  const approved = objectionByKey(match.key)!;
  return {
    key: approved.key,
    heard,
    approvedResponse: approved.response,
    approvedNextAction: approved.nextAction,
    unmapped: false,
  };
}

/**
 * Choose the one keep, one change and one practice assignment.
 *
 * ONE OF EACH, per the SOP's biweekly cadence. Returning a ranked list of ten
 * would be easier and worse: a rep given ten things to fix changes nothing, and
 * the SOP's constraint to a single behaviour commitment is the whole mechanism.
 */
function coachingFocus(dimensions: DimensionScore[]): {
  keep: string | null;
  change: string | null;
  practice: string | null;
} {
  const scored = dimensions.filter((dimension) => dimension.score !== null);
  if (scored.length === 0) {
    return { keep: null, change: null, practice: null };
  }

  const best = scored.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a));
  const worst = scored.reduce((a, b) => ((b.score ?? 0) < (a.score ?? 0) ? b : a));

  return {
    keep: `${best.label}: keep doing this. ${best.lookFor}`,
    change: `${worst.label}: this is the one thing to change. ${worst.lookFor}`,
    practice: `Practise ${worst.label.toLowerCase()} on the next three calls and bring one recording to the next review.`,
  };
}

/**
 * Produce a scorecard for a call.
 *
 * CONSENT IS VERIFIED FIRST — before the transcript is requested, not after. A
 * check that runs after retrieval has already done the thing it was meant to
 * prevent.
 */
export async function scoreCall(callId: string, actor: string | null = null): Promise<Scorecard> {
  const consentVerification = await verifyRecordingBasis(callId);

  if (!consentVerification.verified) {
    // THE REFUSAL IS RECORDED, and this is the entry that matters most in the
    // module. An absent entry cannot distinguish "we declined to process this
    // call" from "nobody ever asked", and only the first is evidence that the
    // consent gate is doing its job. Appended BEFORE the throw, because after
    // it there is no code path left to append from — which is exactly how the
    // `governed` wrapper, which appends only on success, would have lost it.
    await appendAuditEntry({
      event: AUDIT_EVENTS.AI_COACH_REFUSED_NO_CONSENT,
      actor: actor ?? 'system',
      personaRole: 'system',
      purpose: 'quality_assurance',
      decisionRef: `recording-consent:${consentVerification.reason}`,
      // The basis reference is NOT recorded here. The refusal is the fact; the
      // pointer into the consent service is not the ledger's business, and the
      // ledger has a wider audience than the consent record does.
      evidenceRef: `call:${callId}`,
      causationId: callId,
      idempotencyRef: `coach-refused:${callId}:${consentVerification.checkedAt}`,
    });

    throw new AppError(
      403,
      ErrorCodes.RECORDING_CONSENT_MISSING,
      `Call content cannot be processed: ${consentVerification.reason}. This answer is also returned for a call that is not registered, so call ids cannot be enumerated.`
    );
  }

  // Only now is content touched.
  const analysis = await fetchAnalysis(callId);

  const dimensions: DimensionScore[] = COACHING_DIMENSIONS.map((dimension) => ({
    key: dimension.key,
    label: dimension.label,
    score: analysis.scores[dimension.key] ?? null,
    lookFor: dimension.lookFor,
    evidence: analysis.evidence[dimension.key] ?? null,
  }));

  const objections = analysis.objectionsHeard.map(mapObjection);
  const focus = coachingFocus(dimensions);

  await dataService.query(
    `INSERT INTO ai_coach_scorecard
       (call_id, dimension_scores, missed_questions, objections, keep_behaviour,
        change_behaviour, practice_assignment, consent_verification)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (call_id) DO UPDATE
       SET dimension_scores = EXCLUDED.dimension_scores,
           missed_questions = EXCLUDED.missed_questions,
           objections = EXCLUDED.objections,
           keep_behaviour = EXCLUDED.keep_behaviour,
           change_behaviour = EXCLUDED.change_behaviour,
           practice_assignment = EXCLUDED.practice_assignment,
           consent_verification = EXCLUDED.consent_verification,
           scored_at = CURRENT_TIMESTAMP`,
    [
      callId,
      JSON.stringify(dimensions),
      JSON.stringify(analysis.missedQuestions),
      JSON.stringify(objections),
      focus.keep,
      focus.change,
      focus.practice,
      JSON.stringify(consentVerification),
    ]
  );

  await appendAuditEntry({
    event: AUDIT_EVENTS.AI_COACH_SCORED,
    actor: actor ?? 'system',
    personaRole: 'system',
    purpose: 'quality_assurance',
    // HOW consent was verified, in the ledger as well as on the scorecard. The
    // scorecard can be redacted by an erasure; the ledger entry is the durable
    // proof that the check happened at all.
    decisionRef: `recording-consent:${consentVerification.method}`,
    evidenceRef: `call:${callId}`,
    causationId: callId,
    idempotencyRef: `coach-scored:${callId}`,
  });

  return {
    callId,
    dimensions,
    dimensionCount: dimensions.length,
    laceFrame: LACE_STEPS.map((step) => ({ key: step.key, label: step.label })),
    missedQuestions: analysis.missedQuestions,
    objections,
    keepBehaviour: focus.keep,
    changeBehaviour: focus.change,
    practiceAssignment: focus.practice,
    consentVerification,
  };
}

interface CallAnalysis {
  scores: Record<string, number>;
  evidence: Record<string, string>;
  missedQuestions: string[];
  objectionsHeard: string[];
}

/**
 * Fetch the conversation analysis.
 *
 * When the gateway is unconfigured this returns EMPTY, and the scorecard comes
 * back with every dimension null. That is deliberately not the same as scoring
 * zero: a call nobody analysed and a call that opened badly are different
 * facts, and a zero would put a rep on a performance plan for an outage.
 */
async function fetchAnalysis(callId: string): Promise<CallAnalysis> {
  const empty: CallAnalysis = { scores: {}, evidence: {}, missedQuestions: [], objectionsHeard: [] };

  if (!SdkGatewayClient.isConfigured()) {
    return empty;
  }

  try {
    const result = await SdkGatewayClient.call<{ data?: Partial<CallAnalysis> }>({
      sdk: 'sdk-conversation',
      path: `/api/conversations/${encodeURIComponent(callId)}/analysis`,
      method: 'GET',
    });

    const data = result.data?.data;
    if (!data) {
      return empty;
    }

    return {
      scores: data.scores ?? {},
      evidence: data.evidence ?? {},
      missedQuestions: data.missedQuestions ?? [],
      objectionsHeard: data.objectionsHeard ?? [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[coachScorecard] analysis unavailable for ${callId}:`, message);
    return empty;
  }
}

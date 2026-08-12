import { dataService } from '../../services/DataService';
import { SdkGatewayClient } from '../../platform/sdkGateway';

/**
 * The recording-consent gate.
 *
 * NOTHING IN THE COACH MODULE TOUCHES CALL CONTENT WITHOUT PASSING THROUGH
 * HERE, and it runs BEFORE the transcript is fetched rather than after. The
 * ordering is the guarantee: a check that runs after retrieval has already done
 * the thing it was meant to prevent, and "we did not use it" is not the same
 * promise as "we did not process it".
 *
 * FAILING CLOSED IS CORRECT HERE, and that is not a general rule — an earlier
 * feature in this codebase got it wrong in the other direction by treating an
 * unreachable policy service as a prohibition and blanket-denying captures
 * against a rule nobody had written. The distinction is whether the restriction
 * exists independently of our ability to check it. Here it does: the SOP
 * requires calls to follow recording-consent rules, so an unverifiable basis
 * means we cannot show the call was lawfully recorded, and a revocation we
 * cannot see is exactly the case this protects against.
 */

export type ConsentVerificationMethod =
  /** Confirmed against sdk-consent just now. */
  | 'upstream_verified'
  /** Trusted from the locally recorded basis because an operator opted in. */
  | 'local_basis_only';

export interface ConsentVerification {
  verified: boolean;
  method: ConsentVerificationMethod | null;
  /** Why it failed, when it did. Names the cause rather than saying "denied". */
  reason: string | null;
  basisRef: string | null;
  checkedAt: string;
}

/**
 * Whether an operator has explicitly accepted local-only verification.
 *
 * The same shape as the capture module's configured policy id, and for the same
 * reason: an operator must DELIBERATELY accept a weaker check rather than get
 * one by accident from an unset variable. Without it, an unconfigured gateway
 * denies — which is what a fresh install should do.
 */
function localOnlyAccepted(): boolean {
  return process.env.AI_RECORDING_CONSENT_LOCAL_ONLY === 'true';
}

/**
 * Verify that a call may be processed.
 *
 * Returns a verdict rather than throwing, because the caller stamps it onto the
 * scorecard: "was this call lawfully processed" is asked about the OUTPUT, long
 * after any log line has scrolled away.
 */
export async function verifyRecordingBasis(callId: string): Promise<ConsentVerification> {
  const checkedAt = new Date().toISOString();

  const call = await dataService.queryOne<{
    recording_consent_basis_ref: string;
  }>('SELECT recording_consent_basis_ref FROM ai_coach_call WHERE id = $1', [callId]);

  if (!call) {
    // An unregistered call and a call with no basis get the SAME answer, and
    // the caller returns the same status for both, so call ids cannot be
    // enumerated by watching status codes.
    return {
      verified: false,
      method: null,
      reason: 'no_registered_call_with_recording_basis',
      basisRef: null,
      checkedAt,
    };
  }

  const basisRef = call.recording_consent_basis_ref;

  if (!SdkGatewayClient.isConfigured()) {
    if (localOnlyAccepted()) {
      return { verified: true, method: 'local_basis_only', reason: null, basisRef, checkedAt };
    }
    return {
      verified: false,
      method: null,
      reason: 'consent_service_unavailable',
      basisRef,
      checkedAt,
    };
  }

  try {
    const result = await SdkGatewayClient.call<{ data?: { active?: boolean; revoked?: boolean } }>({
      sdk: 'sdk-consent',
      path: `/api/consent/receipts?subject_ref=${encodeURIComponent(basisRef)}`,
      method: 'GET',
    });

    const receipt = result.data?.data;
    // Explicitly `=== true`, so a malformed response or a missing field reads
    // as NOT verified. Truthiness here would let `{}` pass as consent.
    const active = receipt?.active === true && receipt?.revoked !== true;

    if (!active) {
      return {
        verified: false,
        method: null,
        reason: receipt?.revoked === true ? 'consent_revoked' : 'consent_not_active',
        basisRef,
        checkedAt,
      };
    }

    return { verified: true, method: 'upstream_verified', reason: null, basisRef, checkedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[recordingConsent] verification failed for call ${callId}:`, message);
    // An outage denies. The alternative is processing call content on the
    // assumption that a consent we cannot read is still valid, which is the one
    // assumption this gate exists to refuse.
    return {
      verified: false,
      method: null,
      reason: 'consent_service_unavailable',
      basisRef,
      checkedAt,
    };
  }
}

import { JurisdictionPolicy, ruleFor } from '../../config/recordingJurisdictions';
import { SdkGatewayClient } from '../../platform/sdkGateway';

/**
 * May this call be recorded, and if not, why.
 *
 * ANSWERED BEFORE THE CALL, which is the whole point. A consent check that runs
 * when the recording webhook arrives is a check that runs after the recording
 * exists — the audio is already captured, the prospect has already been
 * recorded, and the only remaining question is whether to delete it. The
 * criterion asks for the block and the REASON to reach the rep beforehand, so
 * this takes a lead and a jurisdiction rather than a call id: there is no call
 * yet.
 *
 * TWO INDEPENDENT GATES, BOTH OF WHICH MUST PASS. The tenant's consent basis
 * (do we hold a receipt) and the jurisdiction rule (does the law where the other
 * party sits allow recording on that basis). Checking only the first is the
 * common failure: it records a two-party-consent state on a one-party basis,
 * which is unlawful and leaves nothing in the record to show it happened.
 *
 * THE REASON IS WRITTEN FOR THE REP, not for a log. "consent_not_verified" tells
 * a rep nothing they can act on; "ask the prospect on the call and capture their
 * agreement, then record" tells them exactly what to do next, which is the
 * difference between a control people work with and one they work around.
 */

export type BlockCode =
  /** No consent receipt was supplied at all. */
  | 'no_consent_basis'
  /** A receipt was supplied but could not be confirmed. */
  | 'consent_not_verified'
  /** The receipt exists and has been withdrawn. */
  | 'consent_revoked'
  /** The jurisdiction needs every party, and we only hold the rep's consent. */
  | 'all_party_consent_required'
  /** Recording is not permitted here on any basis. */
  | 'jurisdiction_prohibits';

export interface RecordingEligibility {
  allowed: boolean;
  /** Null when allowed. */
  blockCode: BlockCode | null;
  /** Rep-facing wording. Empty when allowed. */
  reason: string;
  /** What the rep can do to make it allowed, when there is something. */
  remedy: string | null;
  jurisdiction: JurisdictionPolicy;
  /** How the basis was confirmed, when it was. */
  consentMethod: 'upstream_verified' | 'local_basis_only' | null;
  basisRef: string | null;
  checkedAt: string;
}

export interface EligibilityInput {
  /** Consent receipt reference the tenant holds for this prospect. */
  consentBasisRef?: string | null;
  /** Where the OTHER party is, which is the jurisdiction that governs. */
  jurisdiction?: string | null;
  /**
   * True when the prospect has been asked on this call and agreed.
   *
   * Separate from `consentBasisRef` deliberately: a stored receipt is a standing
   * permission from an earlier interaction, and an all-party jurisdiction wants
   * agreement for THIS conversation. Conflating them would let a receipt
   * captured months ago satisfy a rule that exists precisely to make somebody
   * ask again.
   */
  allPartyConsentCaptured?: boolean;
}

/** Whether an operator has explicitly accepted local-only verification. */
function localOnlyAccepted(): boolean {
  return process.env.AI_RECORDING_CONSENT_LOCAL_ONLY === 'true';
}

/** Confirm the receipt against sdk-consent. */
async function verifyBasis(
  basisRef: string
): Promise<{ ok: boolean; method: RecordingEligibility['consentMethod']; code: BlockCode | null }> {
  if (!SdkGatewayClient.isConfigured()) {
    if (localOnlyAccepted()) {
      return { ok: true, method: 'local_basis_only', code: null };
    }
    // Failing closed is correct HERE and is not a general rule: the SOP requires
    // recording-consent rules to be followed, so the restriction exists whether
    // or not we can reach the service. A revocation we cannot see is precisely
    // the case this protects against.
    return { ok: false, method: null, code: 'consent_not_verified' };
  }

  try {
    const result = await SdkGatewayClient.call<{
      data?: { active?: boolean; revoked?: boolean };
    }>({
      sdk: 'sdk-consent',
      path: '/api/consents/check',
      method: 'POST',
      body: { receipt_ref: basisRef, purpose: 'call_recording' },
    });

    const receipt = result.data?.data;
    if (receipt?.revoked === true) {
      return { ok: false, method: null, code: 'consent_revoked' };
    }
    // `=== true`, so a malformed response reads as NOT verified rather than
    // letting `{}` pass as consent.
    if (receipt?.active !== true) {
      return { ok: false, method: null, code: 'consent_not_verified' };
    }
    return { ok: true, method: 'upstream_verified', code: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[recordingEligibility] consent check failed for ${basisRef}:`, message);
    return { ok: false, method: null, code: 'consent_not_verified' };
  }
}

/** Rep-facing wording per block code. */
function wordingFor(
  code: BlockCode,
  jurisdiction: JurisdictionPolicy
): { reason: string; remedy: string | null } {
  switch (code) {
    case 'no_consent_basis':
      return {
        reason: 'No recording consent has been captured for this prospect.',
        remedy: 'Ask on the call, capture their agreement, then start recording.',
      };
    case 'consent_not_verified':
      return {
        reason:
          'The recording consent on file could not be confirmed, so we cannot show this call was lawfully recorded.',
        // Names the honest options rather than implying a retry will fix it.
        remedy: 'Capture fresh consent on the call, or continue without recording.',
      };
    case 'consent_revoked':
      return {
        reason: 'This prospect has withdrawn their consent to be recorded.',
        // No remedy, and saying so is the point: "ask again" would invite a rep
        // to talk somebody out of a withdrawal they already made.
        remedy: null,
      };
    case 'all_party_consent_required':
      return { reason: jurisdiction.blockReason, remedy: 'Capture the prospect’s agreement on this call, then record.' };
    case 'jurisdiction_prohibits':
      return { reason: jurisdiction.blockReason, remedy: null };
    default:
      return { reason: 'Recording is not permitted for this call.', remedy: null };
  }
}

/** Assemble a block verdict. */
function blocked(
  code: BlockCode,
  jurisdiction: JurisdictionPolicy,
  basisRef: string | null,
  checkedAt: string
): RecordingEligibility {
  const { reason, remedy } = wordingFor(code, jurisdiction);
  return {
    allowed: false,
    blockCode: code,
    reason,
    remedy,
    jurisdiction,
    consentMethod: null,
    basisRef,
    checkedAt,
  };
}

/**
 * Decide whether this call may be recorded.
 *
 * ORDER MATTERS: the jurisdiction is checked FIRST for the prohibited case,
 * because where recording is not permitted at all there is no point asking
 * whether a receipt exists — and a rep shown "no consent on file" would go and
 * capture one for a call that still could not be recorded.
 */
export async function checkRecordingEligibility(
  input: EligibilityInput
): Promise<RecordingEligibility> {
  const checkedAt = new Date().toISOString();
  const jurisdiction = ruleFor(input.jurisdiction);
  const basisRef = input.consentBasisRef ?? null;

  if (jurisdiction.rule === 'prohibited') {
    return blocked('jurisdiction_prohibits', jurisdiction, basisRef, checkedAt);
  }

  if (!basisRef) {
    return blocked('no_consent_basis', jurisdiction, null, checkedAt);
  }

  const verification = await verifyBasis(basisRef);
  if (!verification.ok) {
    return blocked(verification.code ?? 'consent_not_verified', jurisdiction, basisRef, checkedAt);
  }

  // The receipt is good. In an all-party jurisdiction that is still not enough:
  // the receipt is a standing permission from an earlier interaction, and the
  // rule exists to make somebody ask again on THIS call.
  if (jurisdiction.rule === 'all_party' && input.allPartyConsentCaptured !== true) {
    return blocked('all_party_consent_required', jurisdiction, basisRef, checkedAt);
  }

  return {
    allowed: true,
    blockCode: null,
    reason: '',
    remedy: null,
    jurisdiction,
    consentMethod: verification.method,
    basisRef,
    checkedAt,
  };
}

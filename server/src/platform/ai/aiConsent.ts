import { isKnownPurpose } from '../../config/consentPurposes';
import { SdkGatewayClient } from '../../platform/sdkGateway';

/**
 * The consent gate on AI completions.
 *
 * A SEPARATE GATE FROM `features/ai/recordingConsent.ts`, and deliberately so.
 * That one answers a narrower question — may we process the content of THIS
 * recorded call — by reading the basis stored on the call row. This one answers
 * the general question every completion has to answer: is there a live consent
 * receipt permitting us to process this person's data for this purpose. Merging
 * them would mean either the call gate stops reading the call, or every
 * completion has to invent a call.
 *
 * FAILING CLOSED IS CORRECT HERE, for the same reason it is correct there: the
 * restriction exists independently of our ability to check it. Processing
 * somebody's data through a model is processing whether or not the consent
 * service is answering, and a revocation we cannot see is precisely the case
 * this protects against.
 */

export type AiConsentMethod =
  /** Confirmed against sdk-consent just now. */
  | 'upstream_verified'
  /** Service-necessary purpose, permitted without a receipt. See below. */
  | 'service_necessary'
  /** Trusted locally because an operator explicitly opted in. */
  | 'local_basis_only';

export interface AiConsentVerification {
  permitted: boolean;
  method: AiConsentMethod | null;
  basisRef: string | null;
  /** Why not, when not. Names the cause rather than saying 'denied'. */
  reason: string | null;
  checkedAt: string;
}

/**
 * Whether an operator has explicitly accepted local-only verification.
 *
 * The same shape and the same reasoning as `AI_RECORDING_CONSENT_LOCAL_ONLY`: a
 * weaker check has to be chosen, never inherited from an unset variable. A fresh
 * install with no consent service refuses, which is what it should do.
 */
function localOnlyAccepted(): boolean {
  return process.env.AI_CONSENT_LOCAL_ONLY === 'true';
}

/**
 * Verify that a completion may proceed for this purpose.
 *
 * @param basisRef The consent receipt reference, when the caller holds one.
 * @param purpose  The consent purpose from the agent registry.
 */
export async function verifyAiConsentBasis(
  basisRef: string | null,
  purpose: string
): Promise<AiConsentVerification> {
  const checkedAt = new Date().toISOString();

  if (!basisRef) {
    // A purpose from the registry that is service-necessary needs no receipt —
    // the lawful basis is the contract, not consent, and demanding a receipt
    // would be asking for a record that correctly does not exist. Anything else
    // without a basis is refused.
    //
    // Note the two AI purposes in `config/aiAgents.ts` — lead_management and
    // quality_assurance — are NOT in the consent registry, so they take the
    // refusal branch. That is intentional: an agent acting on a person's data
    // must name the receipt it is acting under.
    if (isKnownPurpose(purpose)) {
      return {
        permitted: true,
        method: 'service_necessary',
        basisRef: null,
        reason: null,
        checkedAt,
      };
    }
    return {
      permitted: false,
      method: null,
      basisRef: null,
      reason: 'no_consent_basis_supplied',
      checkedAt,
    };
  }

  if (!SdkGatewayClient.isConfigured()) {
    if (localOnlyAccepted()) {
      return { permitted: true, method: 'local_basis_only', basisRef, reason: null, checkedAt };
    }
    return {
      permitted: false,
      method: null,
      basisRef,
      reason: 'consent_service_unavailable',
      checkedAt,
    };
  }

  try {
    const result = await SdkGatewayClient.call<{
      data?: { active?: boolean; revoked?: boolean; purpose?: string };
    }>({
      sdk: 'sdk-consent',
      path: `/api/consent/receipts/${encodeURIComponent(basisRef)}`,
      method: 'GET',
    });

    const receipt = result.data?.data;
    // `=== true` throughout, so a malformed response or a missing field reads as
    // NOT permitted. Truthiness would let `{}` pass as consent.
    const active = receipt?.active === true && receipt?.revoked !== true;

    if (!active) {
      return {
        permitted: false,
        method: null,
        basisRef,
        reason: receipt?.revoked === true ? 'consent_revoked' : 'consent_not_active',
        checkedAt,
      };
    }

    // A LIVE RECEIPT FOR A DIFFERENT PURPOSE IS NOT CONSENT FOR THIS ONE.
    // Skipping this check is how a receipt for appointment updates ends up
    // authorising a marketing draft, which is the single most common way
    // purpose limitation is lost in practice.
    if (receipt?.purpose && receipt.purpose !== purpose) {
      return {
        permitted: false,
        method: null,
        basisRef,
        reason: 'consent_purpose_mismatch',
        checkedAt,
      };
    }

    return { permitted: true, method: 'upstream_verified', basisRef, reason: null, checkedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[aiConsent] verification failed for basis ${basisRef}:`, message);
    return {
      permitted: false,
      method: null,
      basisRef,
      reason: 'consent_service_unavailable',
      checkedAt,
    };
  }
}

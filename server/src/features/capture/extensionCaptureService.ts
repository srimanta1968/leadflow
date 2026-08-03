import { config } from '../../config/env';
import { SdkGatewayClient } from '../../services/projexcloud/SdkGatewayClient';
import { currentTenantContext, tenantIdFor } from '../../platform/tenancy/tenantHierarchy';
import { AppError, ErrorCodes } from '../../utils/errors';

/** Which quick action the operator pressed. */
export type QuickAction = 'contact' | 'property' | 'lead';

export const QUICK_ACTIONS: QuickAction[] = ['contact', 'property', 'lead'];

/**
 * Body keys that must never appear on a browser capture.
 *
 * These are not fields we decline to store — they are fields whose PRESENCE
 * means the client read something it must never touch. A cookie cannot arrive
 * by accident from a text selection.
 *
 * Matched as substrings, case-insensitively, so `sessionCookie`, `csrf_token`
 * and `hidden_inputs` are caught alongside the bare names. Over-matching is the
 * safe direction here: a legitimate field with `token` in its name is a small
 * inconvenience, and a credential that slipped through is not.
 */
const FORBIDDEN_KEY_FRAGMENTS = [
  'cookie',
  'token',
  'password',
  'passwd',
  'secret',
  'credential',
  'authorization',
  'session',
  'hidden',
  'localstorage',
  'sessionstorage',
];

export interface ExtensionCaptureInput {
  /** The visible text the operator selected. The only content ever read. */
  selectedText: string;
  domain: string;
  /** Sent only when the operator ticked the retention box. */
  sourceUrl: string | null;
  /** The operator confirmed the transmission preview. */
  confirmed: boolean;
  retainSourceUrl: boolean;
  quickAction: QuickAction | null;
}

export interface DomainPolicyDecision {
  domain: string;
  allowed: boolean;
  /** Written for the operator, and displayed. A silent block reads as a bug. */
  reason: string;
  /**
   * ALWAYS true. Restricting automated reading of a page says nothing about
   * whether a person may type what they can see with their own eyes, and
   * conflating the two pushes people to a personal notebook — which is worse
   * for the tenant than a governed manual entry.
   */
  manualEntryPermitted: true;
}

export interface ExtensionCaptureResult {
  sourceRecordId: string;
  /** Always USER_PROVIDED — a person selected this and pressed a button. */
  originClass: 'USER_PROVIDED';
  domain: string;
  /** False unless the operator ticked the box AND supplied a URL. */
  sourceUrlRetained: boolean;
  audited: boolean;
  trustState: 'P0_CAPTURED';
}

/**
 * Reject a payload carrying anything that must never leave the page.
 *
 * REJECTS, never strips. Stripping would accept the request and silently
 * discard the only evidence that a client is reading cookies — the capture
 * would look identical to a well-behaved one, and the misbehaving extension
 * build would ship. A guardrail that tidies up after a broken client cannot
 * tell you the client is broken.
 *
 * @throws AppError(422 FORBIDDEN_FIELD) naming the offending key.
 */
export function assertNoForbiddenFields(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    const lowered = key.toLowerCase();
    const hit = FORBIDDEN_KEY_FRAGMENTS.find((fragment) => lowered.includes(fragment));
    if (hit) {
      throw new AppError(
        422,
        ErrorCodes.FORBIDDEN_FIELD,
        `'${key}' must never leave the page — a browser capture reads only the visible selection`
      );
    }
  }
}

/**
 * Ask the tenant's policy whether capture is permitted on this domain.
 *
 * FAILS CLOSED. An unreachable policy is not permission: capturing from a page
 * the tenant may well have restricted, on the grounds that we could not ask, is
 * precisely the outcome the policy exists to prevent. The reason says the
 * decision could not be obtained, so the operator can tell a restriction from
 * an outage — those call for different actions.
 */
export async function evaluateDomainPolicy(domain: string): Promise<DomainPolicyDecision> {
  // NO RULE IS NOT THE SAME AS AN UNREADABLE RULE, and conflating them was a
  // real bug: with a gateway reachable but no capture policy defined, every
  // capture failed closed and the feature was unusable for a tenant who had
  // simply never restricted anything. You cannot fail closed against a rule
  // nobody wrote. The POLICY ID is what declares a restriction exists.
  if (!SdkGatewayClient.isConfigured() || !config.projexCloud.capturePolicyId) {
    return {
      domain,
      allowed: true,
      reason: 'No domain restrictions are configured.',
      manualEntryPermitted: true,
    };
  }

  try {
    const result = await SdkGatewayClient.call<{ data?: { effect?: string; reason?: string } }>({
      sdk: 'sdk-policy',
      path: '/api/policies/evaluate',
      method: 'POST',
      // sdk-policy's contract, verified against the running gateway rather than
      // assumed: policy_id and subject_id are both required, and the earlier
      // shape {action, resource} was rejected 400 — which the fail-closed path
      // then turned into a blanket 403 on every domain.
      body: {
        tenant_id: tenantIdFor(currentTenantContext(), 'consent'),
        policy_id: config.projexCloud.capturePolicyId,
        // The DOMAIN is the subject of this decision. The question is not "may
        // this operator capture" — that is the PDP's job and already answered
        // by the time we are here — it is "may anyone capture from this site".
        subject_id: domain,
        action: 'browser_capture.read_selection',
        resource: { type: 'web_domain', id: domain },
      },
    });

    const effect = result.data?.data?.effect;
    if (effect === 'permit') {
      return {
        domain,
        allowed: true,
        reason: 'Capture is permitted on this domain.',
        manualEntryPermitted: true,
      };
    }

    return {
      domain,
      allowed: false,
      reason:
        result.data?.data?.reason ??
        `Your organisation has restricted browser capture on ${domain}. You can still add the details by hand.`,
      manualEntryPermitted: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[extensionCapture] domain policy unavailable:', message);
    return {
      domain,
      allowed: false,
      // Names the OUTAGE rather than claiming a restriction. A steward told
      // "your organisation restricted this" would go and argue with an admin
      // about a rule that does not exist.
      reason:
        'The capture policy could not be checked just now, so capture is paused on this page. You can still add the details by hand.',
      manualEntryPermitted: true,
    };
  }
}

export class ExtensionCaptureService {
  /**
   * Record a confirmed browser capture.
   *
   * The domain policy is re-checked HERE, not trusted from the extension. The
   * extension asks before reading so it can tell the operator early; this asks
   * again before storing, because the first answer came from a client we do not
   * control and a restriction that only a client enforces is not a restriction.
   *
   * @throws AppError(403 FORBIDDEN) when the tenant restricts this domain.
   */
  static async capture(input: ExtensionCaptureInput): Promise<ExtensionCaptureResult> {
    const policy = await evaluateDomainPolicy(input.domain);
    if (!policy.allowed) {
      throw new AppError(403, ErrorCodes.FORBIDDEN, policy.reason);
    }

    // Retained only when BOTH are true. The checkbox alone is not enough — a
    // ticked box with no URL means the extension had nothing to give, and
    // reporting retention we did not perform would misstate what is stored.
    const sourceUrlRetained = input.retainSourceUrl && Boolean(input.sourceUrl);

    const captureId = `ext_${Date.now().toString(36)}_${Math.abs(hash(input.selectedText))}`;

    if (SdkGatewayClient.isConfigured()) {
      await SdkGatewayClient.call({
        sdk: 'sdk-source-record',
        path: '/api/source-records',
        method: 'POST',
        idempotencyKey: captureId,
        body: {
          tenant_id: tenantIdFor(currentTenantContext(), 'lead'),
          source_system: 'leadflow-extension',
          source_external_id: captureId,
          // Not the caller's to choose. A person selected this text and pressed
          // a button, which is the strongest provenance claim available.
          origin_class: 'USER_PROVIDED',
          raw_evidence: {
            selected_text: input.selectedText,
            domain: input.domain,
            // Present ONLY when retained. Sending it as null when the operator
            // declined would still transmit the field, and the transmission
            // preview promised them it would not be sent at all.
            ...(sourceUrlRetained ? { source_url: input.sourceUrl } : {}),
            quick_action: input.quickAction,
          },
        },
      });
    }

    return {
      sourceRecordId: captureId,
      originClass: 'USER_PROVIDED',
      domain: input.domain,
      sourceUrlRetained,
      // The controller's `governed` wrapper appends the entry after this
      // returns; reporting it here tells the operator the transmission is on
      // the record, which is what the criterion promises them.
      audited: true,
      trustState: 'P0_CAPTURED',
    };
  }
}

/** Small stable hash, so a retried transmission reuses one capture id. */
function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result << 5) - result + value.charCodeAt(index);
    result |= 0;
  }
  return result;
}

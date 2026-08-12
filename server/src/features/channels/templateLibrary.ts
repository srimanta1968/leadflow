import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';

/**
 * The versioned, approval-gated template library. SOP §16, §17, §18, §21.
 *
 * VERSIONS RATHER THAN EDITS. Approving in place overwrites the copy that was
 * live, so "what did we actually send in March" becomes unanswerable — which is
 * the question asked first when a complaint arrives about a message nobody can
 * find. Each publish creates a version and retains the last.
 *
 * ONLY REVOPS MAY PUBLISH. A Rep may USE approved copy and may not alter it: a
 * rep who edits a template changes what every other rep sends without anybody
 * reviewing it, which is how an unapproved claim reaches a thousand prospects.
 */

/** The set SOP §16-18 requires, so a missing one is a visible gap. */
export const TEMPLATE_CATALOG: readonly { key: string; channel: string; purpose: string }[] = [
  { key: 'form_confirmation_immediate', channel: 'email', purpose: 'inspection_estimate' },
  { key: 'after_hours_acknowledgement', channel: 'email', purpose: 'inspection_estimate' },
  { key: 'no_answer_after_call', channel: 'email', purpose: 'inspection_estimate' },
  { key: 'demo_confirmation', channel: 'email', purpose: 'inspection_estimate' },
  { key: 'demo_recap_decision_step', channel: 'email', purpose: 'inspection_estimate' },
  { key: 'checkout_commercial_follow_up', channel: 'email', purpose: 'inspection_estimate' },
  { key: 'close_the_loop_recycle', channel: 'email', purpose: 'inspection_estimate' },
  { key: 'closed_won_welcome_onboarding', channel: 'email', purpose: 'service_delivery' },
  { key: 'sms_form_confirmation', channel: 'sms', purpose: 'inspection_estimate' },
  { key: 'sms_after_hours', channel: 'sms', purpose: 'inspection_estimate' },
  { key: 'sms_no_answer', channel: 'sms', purpose: 'inspection_estimate' },
  { key: 'sms_appointment_confirm', channel: 'sms', purpose: 'inspection_estimate' },
  { key: 'sms_appointment_reminder', channel: 'sms', purpose: 'inspection_estimate' },
  { key: 'sms_on_the_way', channel: 'sms', purpose: 'service_delivery' },
  { key: 'sms_reschedule', channel: 'sms', purpose: 'inspection_estimate' },
  { key: 'sms_quote_ready', channel: 'sms', purpose: 'inspection_estimate' },
  { key: 'sms_payment_link', channel: 'sms', purpose: 'billing' },
  { key: 'sms_welcome_onboarding', channel: 'sms', purpose: 'service_delivery' },
  { key: 'voicemail_first_attempt', channel: 'voice', purpose: 'inspection_estimate' },
  { key: 'voicemail_follow_up', channel: 'voice', purpose: 'inspection_estimate' },
  { key: 'call_script_opening', channel: 'call_script', purpose: 'inspection_estimate' },
  { key: 'objection_response_library', channel: 'call_script', purpose: 'inspection_estimate' },
];

/** Roles permitted to publish. A Rep is deliberately absent. */
const PUBLISHER_ROLES = ['revenue_operations', 'admin'];

export interface TemplateRow {
  id: string;
  template_key: string;
  channel: string;
  purpose_key: string;
  current_version: number;
  live_version: number | null;
  live_published_at: string | null;
  draft_versions: number;
  cta_count: number | null;
  approved: boolean;
}

/** The library, with which version is actually live. */
export async function listTemplates(channel: string | null): Promise<TemplateRow[]> {
  return dataService.query<TemplateRow>(
    `SELECT t.id, t.template_key, t.channel, t.purpose_key, t.current_version, t.cta_count,
            (t.approved_at IS NOT NULL) AS approved,
            live.version    AS live_version,
            live.published_at AS live_published_at,
            (SELECT COUNT(*)::int FROM leadflow_template_version v
              WHERE v.template_id = t.id AND v.published_at IS NULL) AS draft_versions
       FROM leadflow_template_library t
       LEFT JOIN LATERAL (
         SELECT version, published_at FROM leadflow_template_version v
          WHERE v.template_id = t.id AND v.published_at IS NOT NULL
          ORDER BY v.published_at DESC LIMIT 1
       ) live ON true
      WHERE t.retired_at IS NULL AND ($1::text IS NULL OR t.channel = $1)
      ORDER BY t.channel, t.template_key`,
    [channel]
  );
}

export interface PublishResult {
  found: boolean;
  approvalRef: string | null;
  refusal: { status: number; message: string } | null;
}

/**
 * Publish one version, behind the approval gate.
 *
 * THE FEATURE-HONESTY CHECK RUNS AT PUBLISH, not at authoring. Copy is written
 * long before it goes out and a capability can slip between the two, so the
 * question "is this still true" belongs at the moment the claim becomes live.
 */
export async function publishTemplateVersion(input: {
  templateId: string;
  version: number;
  publishedBy: string;
  role: string | null;
  approvalRef: string | null;
}): Promise<PublishResult> {
  /*
   * ROLE FIRST. Checking the version before the permission would tell a Rep
   * whether a draft exists, which is information they have no claim on and a
   * hint about copy they are not allowed to change.
   */
  const role = (input.role ?? '').toLowerCase();
  if (!PUBLISHER_ROLES.includes(role)) {
    return {
      found: false, approvalRef: null,
      refusal: {
        status: 403,
        message: 'Only Revenue Operations may publish a template. A Rep may use approved copy but may not alter it — editing a template changes what every other rep sends without anybody reviewing it.',
      },
    };
  }

  const rows = await dataService.query<{
    version_id: string; claims_feature_available: boolean; claimed_capability: string | null; cta_count: number;
  }>(
    `SELECT version_id, claims_feature_available, claimed_capability, cta_count
       FROM leadflow_template_version WHERE template_id = $1 AND version = $2`,
    [input.templateId, input.version]
  );
  if (rows.length === 0) return { found: false, approvalRef: null, refusal: null };
  const version = rows[0];

  if (version.cta_count !== 1) {
    return {
      found: true, approvalRef: null,
      refusal: { status: 400, message: `This version carries ${version.cta_count} calls to action. Exactly one is permitted — a message asking for two things reliably gets neither.` },
    };
  }

  /*
   * A CLAIM ABOUT AN UNAVAILABLE CAPABILITY IS REFUSED. The copy would promise
   * something the product does not do, to everybody it is sent to, and a
   * roadmap item described as shipped is the single most expensive sentence a
   * template can contain.
   */
  if (version.claims_feature_available && version.claimed_capability) {
    const deps = await dataService.query<{ status: string }>(
      `SELECT status FROM leadflow_feature_dependency
        WHERE tenant_id = $1 AND capability = $2 ORDER BY created_at DESC LIMIT 1`,
      [config.projexCloud.tenantId, version.claimed_capability]
    );
    const status = deps[0]?.status ?? 'not_planned';
    if (status !== 'available') {
      return {
        found: true, approvalRef: null,
        refusal: { status: 400, message: `This copy describes ${version.claimed_capability} as available, but it is recorded as ${status}. A template may not promise a capability the product does not have.` },
      };
    }
  }

  // The approval is raised upstream where one is configured; a missing approval
  // service does not block the publish, but the absence is recorded rather than
  // a reference being invented.
  let approvalRef = input.approvalRef;
  if (!approvalRef && SdkGatewayClient.isConfigured()) {
    try {
      const result = await SdkGatewayClient.call<{ data?: { approval_id?: string } }>({
        sdk: 'sdk-approval',
        path: '/api/approvals/requests',
        method: 'POST',
        idempotencyKey: `template-publish:${input.templateId}:${input.version}`,
        body: {
          tenant_id: config.projexCloud.tenantId, kind: 'template_publish',
          subject_ref: input.templateId, reason: `Publish version ${input.version}`,
        },
      });
      approvalRef = result.data?.data?.approval_id ?? null;
    } catch {
      approvalRef = null;
    }
  }

  await dataService.query(
    `UPDATE leadflow_template_version
        SET published_at = now(), published_by = $3, approval_ref = $4
      WHERE template_id = $1 AND version = $2`,
    [input.templateId, input.version, input.publishedBy, approvalRef]
  );
  await dataService.query(
    `UPDATE leadflow_template_library
        SET current_version = $2, approved_at = now(), approved_by = $3, updated_at = now()
      WHERE id = $1`,
    [input.templateId, input.version, input.publishedBy]
  );

  return { found: true, approvalRef, refusal: null };
}

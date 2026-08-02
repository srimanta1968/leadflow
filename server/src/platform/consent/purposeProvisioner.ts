import { config } from '../../config/env';
import { CONSENT_PURPOSES, ConsentPurpose } from '../../config/consentPurposes';
import { SdkGatewayClient } from '../../services/projexcloud/SdkGatewayClient';

export interface PurposeProvisionResult {
  purposeKey: string;
  outcome: 'created' | 'already_present' | 'skipped' | 'failed';
  detail?: string;
}

export interface PurposeProvisionSummary {
  attempted: boolean;
  created: number;
  alreadyPresent: number;
  failed: number;
  results: PurposeProvisionResult[];
}

/** True when the upstream refusal means the purpose is already registered. */
function isAlreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /returned (409|422)\b/.test(message);
}

/**
 * Register the six purposes with sdk-consent at boot.
 *
 * IDEMPOTENT, and it runs on every boot rather than once behind a flag, for the
 * same reason the role provisioner does: a local "already done" marker is a
 * second source of truth that is wrong the moment somebody edits the tenant
 * directly.
 *
 * NOT FATAL — but note what that costs. Until the purposes exist upstream a
 * receipt cannot be issued against them, so the capture path should REFUSE to
 * record consent rather than record it against a purpose nobody registered. A
 * receipt naming an unregistered purpose is worse than no receipt: it looks like
 * evidence and cannot be honoured on revocation. That refusal belongs in the
 * capture path, not here, and is not yet built.
 */
export async function provisionConsentPurposes(
  purposes: ConsentPurpose[] = CONSENT_PURPOSES
): Promise<PurposeProvisionSummary> {
  const summary: PurposeProvisionSummary = {
    attempted: false,
    created: 0,
    alreadyPresent: 0,
    failed: 0,
    results: [],
  };

  if (!SdkGatewayClient.isConfigured()) {
    summary.results = purposes.map((purpose) => ({
      purposeKey: purpose.key,
      outcome: 'skipped' as const,
      detail: 'No ProjexCloud gateway configured',
    }));
    return summary;
  }

  summary.attempted = true;

  for (const purpose of purposes) {
    try {
      await SdkGatewayClient.call({
        sdk: 'sdk-consent',
        path: '/api/consents/purposes',
        method: 'POST',
        idempotencyKey: `consent-purpose:${purpose.key}`,
        body: {
          tenant_id: config.projexCloud.tenantId,
          key: purpose.key,
          label: purpose.label,
          description: purpose.description,
          service_necessary: purpose.serviceNecessary,
        },
      });
      summary.created += 1;
      summary.results.push({ purposeKey: purpose.key, outcome: 'created' });
    } catch (error) {
      if (isAlreadyExists(error)) {
        summary.alreadyPresent += 1;
        summary.results.push({ purposeKey: purpose.key, outcome: 'already_present' });
        continue;
      }
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[consent] purpose ${purpose.key} could not be registered:`, detail);
      summary.failed += 1;
      summary.results.push({ purposeKey: purpose.key, outcome: 'failed', detail });
    }
  }

  return summary;
}

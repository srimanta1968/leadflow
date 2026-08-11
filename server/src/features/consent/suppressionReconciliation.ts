import { dataService } from '../../services/DataService';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { listSuppressions } from './consentGateway';
import { recordSignal } from './suppressionLedger';

/**
 * The daily check that the provider and the platform still agree.
 *
 * TWO SYSTEMS HOLD A SUPPRESSION LIST and they drift for ordinary reasons: a
 * webhook is lost, a provider dedupes an opt-out we never saw, an operator
 * releases somebody here but the provider still refuses them, a bounce is
 * recorded upstream during an outage of ours. Neither list is wrong so much as
 * incomplete, and nobody notices — a divergence produces no error anywhere. It
 * produces a message that should not have been sent, weeks later.
 *
 * DIVERGENCE IS NOT AUTO-HEALED IN BOTH DIRECTIONS, and that asymmetry is the
 * heart of this file:
 *
 *   provider suppressed, platform not  -> we ADOPT it immediately. The provider
 *     heard something we did not, almost always an opt-out or a complaint sent
 *     directly to them. Waiting for a human to confirm a refusal we already
 *     have evidence for means sending in the meantime.
 *
 *   platform suppressed, provider not  -> we DO NOT release. It would be the
 *     same code path in reverse, and it would be a disaster: a lost provider
 *     record would silently un-suppress somebody who opted out. The platform
 *     keeps refusing and the case asks a human to re-push it upstream.
 *
 * Both are reported either way. Adopting quietly would hide how often signals
 * are being lost, which is the thing worth fixing.
 */

export interface Divergence {
  subject_ref: string;
  channel: string;
  provider_state: 'suppressed' | 'not_suppressed';
  platform_state: 'suppressed' | 'not_suppressed';
  direction: 'provider_only' | 'platform_only';
  action: 'adopted' | 'held_for_review';
}

export interface ReconciliationResult {
  reconciliationId: string;
  providerReached: boolean;
  providerCount: number | null;
  platformCount: number;
  divergences: Divergence[];
  caseRef: string | null;
  adopted: number;
}

const CHANNELS = ['email', 'sms', 'call', 'social', 'push'];

interface ProviderSuppression {
  subject_ref?: string;
  contact_ref?: string;
  channel?: string;
}

/**
 * Compare the two lists and record what was found.
 *
 * @param tenantId Scope for the platform side. The provider list is whatever
 *                 the gateway's credential can see.
 */
export async function reconcile(tenantId?: string | null): Promise<ReconciliationResult> {
  /*
   * The provider is asked per channel because sdk-deliverability's suppression
   * list is channel-scoped. A failure on ANY channel makes the whole run
   * unreached rather than partially trusted: a run that compared email but
   * silently skipped SMS, and then reported no divergence, is worse than no run
   * at all, because it closes the question.
   */
  const provider = new Set<string>();
  let providerReached = true;
  for (const channel of CHANNELS) {
    const res = await listSuppressions(channel);
    if (!res.available) { providerReached = false; break; }
    for (const row of (res.value ?? []) as ProviderSuppression[]) {
      const ref = row.subject_ref ?? row.contact_ref;
      if (ref) provider.add(`${ref}::${row.channel ?? channel}`);
    }
  }

  // The platform side: the current derived state, not the raw signal log — a
  // released subject has signals but is not suppressed.
  const platformRows = await dataService.query<{ subject_ref: string; channel: string; signal: string }>(
    `SELECT DISTINCT ON (subject_ref, channel) subject_ref, channel, signal
       FROM leadflow_suppression_signal
      WHERE ($1::text IS NULL OR tenant_id IS NOT DISTINCT FROM $1::text)
      ORDER BY subject_ref, channel, occurred_at DESC, (signal = 'release') ASC, recorded_at DESC`,
    [tenantId ?? null],
  );
  const platform = new Set(
    platformRows.filter((r) => r.signal !== 'release').map((r) => `${r.subject_ref}::${r.channel}`),
  );

  const divergences: Divergence[] = [];

  if (providerReached) {
    for (const key of provider) {
      if (platform.has(key)) continue;
      const [subject_ref, channel] = key.split('::');
      divergences.push({
        subject_ref, channel,
        provider_state: 'suppressed', platform_state: 'not_suppressed',
        direction: 'provider_only', action: 'adopted',
      });
    }
    for (const key of platform) {
      if (provider.has(key)) continue;
      const [subject_ref, channel] = key.split('::');
      divergences.push({
        subject_ref, channel,
        provider_state: 'not_suppressed', platform_state: 'suppressed',
        direction: 'platform_only', action: 'held_for_review',
      });
    }
  }

  // Adopt the provider's refusals now, before the case is even opened. The
  // signal is attributed to 'reconciliation' so the record shows we inferred it
  // rather than received it, and dated now rather than backdated — we genuinely
  // do not know when the subject acted.
  const toAdopt = divergences.filter((d) => d.action === 'adopted');
  for (const d of toAdopt) {
    await recordSignal({
      tenantId,
      subjectRef: d.subject_ref,
      signal: 'staff_revocation',
      source: 'reconciliation',
      channel: d.channel as 'email',
      reason: `adopted from the provider suppression list on ${d.channel}; the originating signal was never received here`,
    });
  }

  const caseRef = divergences.length > 0 || !providerReached
    ? await openDataReviewCase(tenantId, divergences, providerReached)
    : null;

  const rows = await dataService.query<{ id: string }>(
    `INSERT INTO leadflow_suppression_reconciliation
       (tenant_id, provider_reached, provider_count, platform_count, divergences, case_ref)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)
     RETURNING id`,
    [
      tenantId ?? null, providerReached, providerReached ? provider.size : null,
      platform.size, JSON.stringify(divergences), caseRef,
    ],
  );

  return {
    reconciliationId: rows[0].id,
    providerReached,
    providerCount: providerReached ? provider.size : null,
    platformCount: platform.size,
    divergences,
    caseRef,
    adopted: toAdopt.length,
  };
}

/**
 * Open the Data Review case a divergence calls for.
 *
 * A CASE IS ALSO OPENED WHEN THE PROVIDER COULD NOT BE REACHED. An unreachable
 * provider means the comparison did not happen, and the one outcome this must
 * never produce is a silent "no divergences found" for a run that compared
 * nothing.
 *
 * The case reference falls back to a local id when sdk-case is unreachable, so
 * the reconciliation row always carries something an operator can search for
 * rather than a null that reads as "no case was needed".
 */
async function openDataReviewCase(
  tenantId: string | null | undefined,
  divergences: Divergence[],
  providerReached: boolean,
): Promise<string> {
  const summary = providerReached
    ? `${divergences.length} suppression divergence(s) between the provider and the platform`
    : 'the provider suppression list could not be read, so no comparison was made';

  try {
    const res = await SdkGatewayClient.call<{ data?: { case_id?: string; id?: string } }>({
      sdk: 'sdk-case',
      path: '/api/cases',
      method: 'POST',
      body: {
        tenant_id: tenantId ?? undefined,
        type: 'data_review',
        severity: providerReached ? 'medium' : 'high',
        summary,
        detail: { divergences, provider_reached: providerReached },
      },
    });
    const id = res.data?.data?.case_id ?? res.data?.data?.id;
    if (res.delivered && id) return id;
  } catch {
    // Falls through to the local reference.
  }
  return `local-data-review:${new Date().toISOString()}`;
}

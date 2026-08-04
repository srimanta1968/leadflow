import { randomUUID } from 'crypto';
import { adapterKeys } from '../../config/sourceAdapters';
import { dataService } from '../../services/DataService';
import { currentTenantContext, tenantIdFor } from '../../platform/tenancy/tenantHierarchy';
import { SdkGatewayClient } from '../../services/projexcloud/SdkGatewayClient';
import { SignatureState } from './signatureVerifier';

/**
 * Platforms whose signals LeadFlow accepts.
 *
 * DERIVED FROM THE ADAPTER REGISTRY, not typed out beside it. The two lists
 * were written separately and drifted immediately: seven configured adapters —
 * linkedin, tiktok, chat_handoff, email, referral among them — named platforms
 * this validator rejected, so they were configuration that could never fire and
 * looked complete in every review. A hand-maintained second list is a second
 * thing to forget, and this one failed on its first day.
 *
 * The extras below are channels intake accepts that have no adapter of their
 * own: facebook and instagram arrive through the Meta adapter but platforms
 * label them separately, and csv_import, whatsapp and partner_api are ingress
 * routes rather than integrations.
 */
export const INTAKE_PLATFORMS = [
  ...adapterKeys(),
  'facebook',
  'instagram',
  'whatsapp',
  'csv_import',
  'partner_api',
] as const;

export type IntakePlatform = (typeof INTAKE_PLATFORMS)[number];

/** What kind of signal this is. */
export const SIGNAL_KINDS = ['lead', 'task', 'message', 'payment'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export type IntakeOutcome = 'accepted' | 'rejected' | 'deferred' | 'duplicate';

export interface IntakeSignal {
  platform: string;
  sourceEventId: string;
  signalKind: SignalKind;
  occurredAt: string | null;
  rawPayload: Record<string, unknown>;
  contactHints: Record<string, unknown> | null;
  campaign: Record<string, unknown> | null;
  permissionFields: Record<string, unknown> | null;
  transcript: string | null;
}

export interface IntakeResult {
  platform: string;
  sourceEventId: string;
  outcome: IntakeOutcome;
  /** Always true once the request reached this service. See `archive`. */
  archived: boolean;
  leadId: string | null;
  signatureState: SignatureState;
  /** Present on rejection and on deferral. */
  reason: string | null;
  /** True when this exact event had already been seen. */
  replay: boolean;
}

/**
 * Write the arrival record.
 *
 * CALLED BEFORE ANYTHING IS JUDGED, and that ordering is the criterion. A
 * signal that is about to be refused still gets archived, because "the webhook
 * never arrived" and "the webhook arrived and we discarded it" are completely
 * different incidents and must not look alike from the outside.
 *
 * ON CONFLICT DO NOTHING gives the replay guarantee: the second delivery of the
 * same (platform, sourceEventId) writes no row, and the caller reads that as a
 * replay rather than creating a second lead.
 *
 * @returns true when this insert created the row — i.e. the event is NEW.
 */
async function archive(
  signal: Pick<IntakeSignal, 'platform' | 'sourceEventId' | 'rawPayload' | 'occurredAt'>,
  tenantId: string | null,
  signatureState: SignatureState,
  outcome: IntakeOutcome,
  rejectionReason: string | null
): Promise<boolean> {
  const rows = await dataService.query<{ platform: string }>(
    `INSERT INTO intake_event
       (platform, source_event_id, tenant_id, raw_payload, signature_state, outcome,
        rejection_reason, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT DO NOTHING
     RETURNING platform`,
    [
      signal.platform,
      signal.sourceEventId,
      tenantId,
      JSON.stringify(signal.rawPayload ?? {}),
      signatureState,
      outcome,
      rejectionReason,
      signal.occurredAt ? new Date(signal.occurredAt) : null,
    ]
  );
  return rows.length > 0;
}

/** What a previous delivery of this event concluded. */
async function previousOutcome(
  platform: string,
  sourceEventId: string,
  tenantId: string | null
): Promise<{ outcome: IntakeOutcome; leadId: string | null } | null> {
  const rows = await dataService.query<{ outcome: IntakeOutcome; lead_id: string | null }>(
    `SELECT outcome, lead_id
       FROM intake_event
      WHERE platform = $1
        AND source_event_id = $2
        AND COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [platform, sourceEventId, tenantId]
  );
  return rows.length > 0 ? { outcome: rows[0].outcome, leadId: rows[0].lead_id } : null;
}

/** Reject reasons that are about the SIGNAL, not the platform. */
function reasonInvalid(signal: Partial<IntakeSignal>): string | null {
  if (typeof signal.sourceEventId !== 'string' || signal.sourceEventId.trim().length === 0) {
    return 'sourceEventId is required — it is half the idempotency key';
  }
  if (!signal.platform || !INTAKE_PLATFORMS.includes(signal.platform as IntakePlatform)) {
    return `platform must be one of: ${INTAKE_PLATFORMS.join(', ')}`;
  }
  if (!signal.signalKind || !SIGNAL_KINDS.includes(signal.signalKind)) {
    return `signalKind must be one of: ${SIGNAL_KINDS.join(', ')}`;
  }
  return null;
}

export class IntakeService {
  /**
   * Take one normalized signal.
   *
   * ORDER: archive, then judge, then process. A rejected signal is archived
   * with its reason; a replayed one is recognised before any work happens.
   */
  static async accept(
    signal: Partial<IntakeSignal>,
    signatureState: SignatureState = 'verified'
  ): Promise<IntakeResult> {
    const tenantId = tenantIdFor(currentTenantContext(), 'lead') || null;
    const platform = String(signal.platform ?? 'unknown');
    const sourceEventId = String(signal.sourceEventId ?? '');

    const invalid = reasonInvalid(signal);

    // ARCHIVED FIRST, whatever the verdict is going to be.
    const isNew = await archive(
      {
        platform,
        sourceEventId: sourceEventId || `malformed:${Date.now()}`,
        rawPayload: signal.rawPayload ?? (signal as Record<string, unknown>),
        occurredAt: signal.occurredAt ?? null,
      },
      tenantId,
      signatureState,
      invalid ? 'rejected' : 'accepted',
      invalid
    );

    if (!isNew) {
      // THE REPLAY GUARANTEE. A second delivery does no work at all — no lead,
      // no task, no message, no payment — and returns what the first one
      // concluded, so the sender sees a consistent answer however many times
      // they retry.
      const previous = await previousOutcome(platform, sourceEventId, tenantId);
      return {
        platform,
        sourceEventId,
        outcome: previous?.outcome ?? 'duplicate',
        archived: true,
        leadId: previous?.leadId ?? null,
        signatureState,
        reason: 'This event has already been received.',
        replay: true,
      };
    }

    if (invalid) {
      return {
        platform,
        sourceEventId,
        outcome: 'rejected',
        // The archive row exists even though the signal was refused — this is
        // the criterion, and it is why `archived` is reported separately from
        // `outcome`.
        archived: true,
        leadId: null,
        signatureState,
        reason: invalid,
        replay: false,
      };
    }

    // The downstream work. A failure here DEFERS rather than rejects: the
    // signal was good, the platform did nothing wrong, and losing it because
    // one of our dependencies was restarting would be our fault presented as
    // theirs.
    try {
      const leadId = await IntakeService.process(signal as IntakeSignal, tenantId);
      await dataService.query(
        `UPDATE intake_event SET lead_id = $1, outcome = 'accepted'
          WHERE platform = $2 AND source_event_id = $3`,
        [leadId, platform, sourceEventId]
      );
      return {
        platform,
        sourceEventId,
        outcome: 'accepted',
        archived: true,
        leadId,
        signatureState,
        reason: null,
        replay: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[intake] ${platform}/${sourceEventId} deferred:`, message);
      await IntakeService.defer(platform, sourceEventId, tenantId, 'sdk-source-record', message);
      return {
        platform,
        sourceEventId,
        outcome: 'deferred',
        archived: true,
        leadId: null,
        signatureState,
        reason: 'A downstream service is unavailable. The event is queued and will be processed.',
        replay: false,
      };
    }
  }

  /** Assert the raw event upstream. */
  private static async process(signal: IntakeSignal, tenantId: string | null): Promise<string> {
    // A REAL uuid, because intake_event.lead_id is a UUID column. A composite
    // like `intake_<platform>_<eventId>` reads nicely and is not a uuid, so the
    // insert threw, the catch treated it as a downstream outage, and every
    // signal came back `deferred` — a schema mismatch wearing an outage's
    // clothes. The platform and source event id are already columns on the same
    // row, so nothing is lost for tracing.
    const leadId = randomUUID();

    if (SdkGatewayClient.isConfigured()) {
      await SdkGatewayClient.call({
        sdk: 'sdk-source-record',
        path: '/api/source-records',
        method: 'POST',
        // The platform's own event id, so a retry that reaches upstream twice
        // lands once there too.
        idempotencyKey: `${signal.platform}:${signal.sourceEventId}`,
        body: {
          tenant_id: tenantId,
          source_system: `leadflow-intake:${signal.platform}`,
          source_external_id: signal.sourceEventId,
          origin_class: 'FIRST_PARTY_DIRECT',
          raw_evidence: {
            platform: signal.platform,
            signal_kind: signal.signalKind,
            occurred_at: signal.occurredAt,
            raw_payload: signal.rawPayload,
            campaign: signal.campaign,
            permission_fields: signal.permissionFields,
            transcript: signal.transcript,
            contact_hints: signal.contactHints,
          },
        },
      });
    }

    return leadId;
  }

  /** Queue an event whose downstream was unavailable. */
  private static async defer(
    platform: string,
    sourceEventId: string,
    tenantId: string | null,
    blockedOn: string,
    lastError: string
  ): Promise<void> {
    await dataService.query(
      `INSERT INTO intake_outage_queue
         (platform, source_event_id, tenant_id, blocked_on, attempts, last_error)
       VALUES ($1, $2, $3, $4, 1, $5)
       ON CONFLICT (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), platform, source_event_id)
       DO UPDATE SET attempts = intake_outage_queue.attempts + 1, last_error = EXCLUDED.last_error`,
      [platform, sourceEventId, tenantId, blockedOn, lastError]
    );
    await dataService.query(
      `UPDATE intake_event SET outcome = 'deferred' WHERE platform = $1 AND source_event_id = $2`,
      [platform, sourceEventId]
    );
  }

  /**
   * Drain the outage queue after a dependency recovers.
   *
   * BACKFILLS BY EVENT ID, replaying each queued event from its ARCHIVED raw
   * payload rather than asking the platform to send it again. Providers expire
   * their retry windows — by the time an outage is noticed and fixed, asking
   * for a resend is often no longer possible, and the archive is the only copy
   * that still exists.
   *
   * @param blockedOn Drain only what was waiting on this dependency, so a
   *                  recovery in one SDK does not retry events blocked on
   *                  another that is still down.
   */
  static async backfill(blockedOn?: string): Promise<{ drained: number; failed: number }> {
    const queued = await dataService.query<{
      platform: string;
      source_event_id: string;
      tenant_id: string | null;
    }>(
      `SELECT q.platform, q.source_event_id, q.tenant_id
         FROM intake_outage_queue q
        WHERE q.drained_at IS NULL
          AND ($1::text IS NULL OR q.blocked_on = $1)
        ORDER BY q.queued_at ASC
        LIMIT 500`,
      [blockedOn ?? null]
    );

    let drained = 0;
    let failed = 0;

    for (const row of queued) {
      const archived = await dataService.queryOne<{ raw_payload: Record<string, unknown> }>(
        `SELECT raw_payload FROM intake_event
          WHERE platform = $1 AND source_event_id = $2`,
        [row.platform, row.source_event_id]
      );
      if (!archived) {
        // Queued with no archive row should be impossible — the archive is
        // written first — so this means someone deleted history. Counted as a
        // failure rather than skipped silently.
        failed += 1;
        continue;
      }

      try {
        const leadId = await IntakeService.process(
          {
            platform: row.platform,
            sourceEventId: row.source_event_id,
            signalKind: 'lead',
            occurredAt: null,
            rawPayload: archived.raw_payload,
            contactHints: null,
            campaign: null,
            permissionFields: null,
            transcript: null,
          },
          row.tenant_id
        );

        await dataService.query(
          `UPDATE intake_event SET lead_id = $1, outcome = 'accepted'
            WHERE platform = $2 AND source_event_id = $3`,
          [leadId, row.platform, row.source_event_id]
        );
        await dataService.query(
          `UPDATE intake_outage_queue SET drained_at = CURRENT_TIMESTAMP
            WHERE platform = $1 AND source_event_id = $2`,
          [row.platform, row.source_event_id]
        );
        drained += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await dataService.query(
          `UPDATE intake_outage_queue
              SET attempts = attempts + 1, last_error = $3
            WHERE platform = $1 AND source_event_id = $2`,
          [row.platform, row.source_event_id, message]
        );
        failed += 1;
      }
    }

    return { drained, failed };
  }
}

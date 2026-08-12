import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';

/**
 * The failure runbook and the connector dead-letter queue. SOP §21, §29.
 *
 * Every documented failure gets an automated fallback and a NAMED OWNER. The
 * owner is the part that is easy to leave out and the part that decides whether
 * anything happens: an alert addressed to everybody is addressed to nobody.
 */

export interface RunbookEntry {
  mode: string;
  label: string;
  /** What happens automatically. */
  fallback: string;
  ownerRole: string;
  /** How quickly a human must act. */
  responseWindow: string;
  /** Whether a retry is attempted before the human fallback, and how many. */
  retries: number;
}

/**
 * The six documented modes.
 *
 * RETRIES ARE PART OF THE ENTRY, not a transport setting. "Retry safely ONCE
 * with no duplicate" is a product decision about a customer's inbox, and burying
 * it in an HTTP client's config is how it silently becomes three.
 */
export const RUNBOOK: RunbookEntry[] = [
  {
    mode: 'connector_down', label: 'Social or form connector down',
    fallback: 'Queue the event with its ORIGINAL event id retained, allow export or manual creation of critical leads, and backfill after restoration.',
    ownerRole: 'revenue_operations', responseWindow: 'immediate', retries: 0,
  },
  {
    mode: 'provider_send_failure', label: 'SMS or email provider failure',
    fallback: 'Retry exactly once. If it fails again, create a call or manual-email task and flag the dashboard — never a third attempt.',
    ownerRole: 'revenue_operations', responseWindow: 'same business day', retries: 1,
  },
  {
    mode: 'calendar_sync_failure', label: 'Calendar sync failure',
    fallback: 'Send a manual invite and record its URL before contact ends; repair the connection the same business day.',
    ownerRole: 'rep_and_systems_admin', responseWindow: 'same business day', retries: 0,
  },
  {
    mode: 'payment_webhook_missing', label: 'Payment webhook missing',
    fallback: 'Verify in the gateway directly. NEVER mark won on assumption. Create a finance and a RevOps task either way.',
    ownerRole: 'revenue_operations', responseWindow: 'immediate when the buyer is present', retries: 0,
  },
  {
    mode: 'duplicate_send_loop', label: 'Duplicate sends or automation loop',
    fallback: 'Pause the sequence GLOBALLY, suppress the contact, and investigate the event and idempotency trail.',
    ownerRole: 'revenue_operations_incident_lead', responseWindow: 'immediate', retries: 0,
  },
  {
    mode: 'timezone_or_holiday_rule', label: 'Wrong timezone or holiday rule',
    fallback: 'Apply America/Chicago plus the recipient timezone, correct affected tasks, and notify affected leads.',
    ownerRole: 'revenue_operations', responseWindow: 'same business day', retries: 0,
  },
];

export const RUNBOOK_MODES = RUNBOOK.map((r) => r.mode);
export const entryFor = (mode: string): RunbookEntry | undefined => RUNBOOK.find((r) => r.mode === mode);

/**
 * Record a failure and take its fallback.
 *
 * THE ORIGINAL EVENT ID IS THE DEDUPE KEY. A connector outage that loses it
 * makes the backfill produce duplicates, because nothing can tell which events
 * already landed — so it is part of the unique constraint rather than a field
 * somebody remembers to populate.
 */
export async function record(input: {
  mode: string; originalEventId: string; sourceRef: string | null; payload: unknown;
}): Promise<{ failureId: string | null; duplicate: boolean; entry: RunbookEntry | null }> {
  const entry = entryFor(input.mode) ?? null;
  if (entry === null) return { failureId: null, duplicate: false, entry: null };

  const rows = await dataService.query<{ failure_id: string }>(
    `INSERT INTO leadflow_failure_event
       (tenant_id, failure_mode, source_ref, original_event_id, payload, owner_role, fallback_taken)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
     ON CONFLICT (tenant_id, failure_mode, original_event_id) DO NOTHING
     RETURNING failure_id`,
    [
      config.projexCloud.tenantId, input.mode, input.sourceRef, input.originalEventId,
      JSON.stringify(input.payload ?? {}), entry.ownerRole, entry.fallback,
    ]
  );
  return { failureId: rows[0]?.failure_id ?? null, duplicate: rows.length === 0, entry };
}

/**
 * Claim the single retry a provider failure is allowed.
 *
 * CLAIMED BY THE UPDATE, not decided by a read. Two concurrent handlers would
 * both read retry_count = 0 and both retry, which is the duplicate send this
 * exists to prevent — the customer gets two copies of the same message and the
 * incident report says "we retried once".
 */
export async function claimRetry(failureId: string): Promise<boolean> {
  const entry = await dataService.query<{ failure_mode: string }>(
    `SELECT failure_mode FROM leadflow_failure_event WHERE failure_id = $1`, [failureId]
  );
  const allowed = entryFor(entry[0]?.failure_mode ?? '')?.retries ?? 0;
  if (allowed === 0) return false;

  const rows = await dataService.query<{ retry_count: number }>(
    `UPDATE leadflow_failure_event SET retry_count = retry_count + 1
      WHERE failure_id = $1 AND retry_count < $2 RETURNING retry_count`,
    [failureId, allowed]
  );
  return rows.length > 0;
}

/* --------------------------------------------------------------- DLQ */

export interface DlqItem {
  source: string; id: string; kind: string; attempts: number; last_error: string | null; created_at: string | null;
}

/**
 * The dead-letter queue, from both places it lives.
 *
 * READ FROM BOTH sdk-connectors AND sdk-webhook, merged. They are different
 * queues for different failures — an inbound connector that could not deliver
 * and an outbound webhook that could not be delivered — and an operator asking
 * "what is stuck" means both. Two screens means one of them goes unwatched.
 *
 * AN UNREACHABLE SOURCE IS REPORTED, never silently omitted: an empty DLQ and a
 * DLQ that could not be read look identical, and only one of them is good news.
 */
export async function readDlq(): Promise<{ items: DlqItem[]; sources: Record<string, boolean> }> {
  const items: DlqItem[] = [];
  const sources: Record<string, boolean> = { 'sdk-connectors': false, 'sdk-webhook': false };
  if (!SdkGatewayClient.isConfigured()) return { items, sources };

  try {
    const c = await SdkGatewayClient.call<{ data?: { items?: Record<string, unknown>[] } }>({
      sdk: 'sdk-connectors',
      /* THE SPEC EXPOSES NO CONNECTOR DLQ READ — only /dlq/replay and
         /dlq/retry-tick. retry-tick is the closest thing that reports queue
         state, so it is used as the reachability probe and the items come back
         empty with the source flagged, rather than calling a read path that
         does not exist and reporting the queue as clear. */
      path: '/api/connectors/dlq/retry-tick',
      method: 'POST', idempotencyKey: 'dlq-read:connectors',
    });
    if (c.delivered) {
      sources['sdk-connectors'] = true;
      for (const raw of c.data?.data?.items ?? []) {
        items.push({
          source: 'sdk-connectors', id: String(raw.id ?? raw.dlq_id ?? ''),
          kind: String(raw.kind ?? raw.event_type ?? 'unknown'),
          attempts: Number(raw.attempts ?? 0),
          last_error: typeof raw.last_error === 'string' ? raw.last_error : null,
          created_at: typeof raw.created_at === 'string' ? raw.created_at : null,
        });
      }
    }
  } catch { /* sources flag stays false, which is the honest report */ }

  try {
    const w = await SdkGatewayClient.call<{ data?: { deliveries?: Record<string, unknown>[] } }>({
      sdk: 'sdk-webhook',
      // The spec exposes deliveries, not a dlq collection: failed ones are
      // filtered out of it rather than living on their own path.
      path: '/api/webhooks/deliveries?status=failed', method: 'GET', idempotencyKey: 'dlq-read:webhook',
    });
    if (w.delivered) {
      sources['sdk-webhook'] = true;
      for (const raw of w.data?.data?.deliveries ?? []) {
        items.push({
          source: 'sdk-webhook', id: String(raw.delivery_id ?? raw.id ?? ''),
          kind: String(raw.event_type ?? 'unknown'),
          attempts: Number(raw.attempts ?? 0),
          last_error: typeof raw.last_error === 'string' ? raw.last_error : null,
          created_at: typeof raw.created_at === 'string' ? raw.created_at : null,
        });
      }
    }
  } catch { /* as above */ }

  return { items, sources };
}

/** How many items one replay call may take. */
export const REPLAY_BATCH_CAP = 50;

/**
 * Replay DLQ items, in a bounded batch.
 *
 * THE CAP IS THE POINT, not a pagination convenience. A queue that has been
 * filling for six hours holds thousands of items, and replaying them all at once
 * is a burst that trips the provider's rate limit, refills the queue and — for a
 * messaging connector — puts thousands of messages into inboxes in one minute.
 * The item count that was NOT replayed is returned, because a silent cap reads
 * as "the queue is clear".
 */
export async function replay(ids: string[]): Promise<{
  replayed: string[]; failed: { id: string; error: string }[]; skipped: number;
}> {
  const batch = ids.slice(0, REPLAY_BATCH_CAP);
  const replayed: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const id of batch) {
    try {
      const result = await SdkGatewayClient.call({
        sdk: 'sdk-webhook', path: `/api/webhooks/deliveries/${encodeURIComponent(id)}/replay`,
        method: 'POST',
        /* KEYED ON THE ITEM, so a replay of a replay is one replay. A DLQ item
           delivered twice is the duplicate the whole queue exists to avoid. */
        idempotencyKey: `dlq-replay:${id}`,
        body: { tenant_id: config.projexCloud.tenantId },
      });
      if (result.delivered) replayed.push(id);
      else failed.push({ id, error: 'the webhook service did not answer' });
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : 'unknown' });
    }
  }
  return { replayed, failed, skipped: Math.max(0, ids.length - batch.length) };
}

/* -------------------------------------------------------- the kill switch */

/**
 * Engage or release the global send pause.
 *
 * LOCAL FIRST, UPSTREAM SECOND. The local row is what every send path checks, so
 * engaging it stops sending on the next tick whether or not sdk-feature-flags is
 * reachable — a kill switch that depends on a remote service is unavailable
 * exactly when the incident that needs it is happening.
 */
export async function setKillSwitch(input: {
  key: string; engaged: boolean; reason: string | null; actorId: string | null;
}): Promise<{ engaged: boolean; engagedAt: string | null; upstream: boolean }> {
  const rows = await dataService.query<{ engaged: boolean; engaged_at: string | null }>(
    `INSERT INTO leadflow_kill_switch (tenant_id, switch_key, engaged, engaged_at, engaged_by, reason, released_at, updated_at)
     VALUES ($1,$2,$3, CASE WHEN $3 THEN now() ELSE NULL END, $4, $5, CASE WHEN $3 THEN NULL ELSE now() END, now())
     ON CONFLICT (tenant_id, switch_key) DO UPDATE
       SET engaged = EXCLUDED.engaged,
           engaged_at = CASE WHEN EXCLUDED.engaged THEN COALESCE(leadflow_kill_switch.engaged_at, now()) ELSE NULL END,
           engaged_by = EXCLUDED.engaged_by, reason = EXCLUDED.reason,
           released_at = CASE WHEN EXCLUDED.engaged THEN NULL ELSE now() END,
           updated_at = now()
     RETURNING engaged, engaged_at`,
    [config.projexCloud.tenantId, input.key, input.engaged, input.actorId, input.reason]
  );

  let upstream = false;
  if (SdkGatewayClient.isConfigured()) {
    try {
      const result = await SdkGatewayClient.call({
        // PUT /api/flags is the upsert; /api/feature-flags does not exist.
        sdk: 'sdk-feature-flags', path: '/api/flags', method: 'PUT',
        idempotencyKey: `kill-switch:${input.key}:${input.engaged}`,
        body: {
          tenant_id: config.projexCloud.tenantId, key: input.key,
          enabled: input.engaged, reason: input.reason,
        },
      });
      upstream = result.delivered;
    } catch { upstream = false; }
  }

  return { engaged: rows[0].engaged, engagedAt: rows[0].engaged_at, upstream };
}

/** Whether automated sending is currently halted. Fails CLOSED on error. */
export async function sendsHalted(key = 'global_send_pause'): Promise<boolean> {
  try {
    const rows = await dataService.query<{ engaged: boolean }>(
      `SELECT engaged FROM leadflow_kill_switch WHERE tenant_id = $1 AND switch_key = $2`,
      [config.projexCloud.tenantId, key]
    );
    return rows[0]?.engaged === true;
  } catch {
    /* A kill switch that cannot be read is treated as ENGAGED. The asymmetry is
       deliberate: the cost of pausing sends we did not need to pause is a delay,
       and the cost of sending during the incident the switch was thrown for is
       the incident getting worse. */
    return true;
  }
}

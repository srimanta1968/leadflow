import { dataService } from './DataService';
import { SdkGatewayClient } from './projexcloud/SdkGatewayClient';
import { eventStream } from './EventStream';
import { AppError } from '../utils/errors';
import { SlaAlert, SlaAlertChannel, SlaAlertKind, SlaAlertState } from '../types';

/**
 * Roles treated as managers for breach escalation.
 *
 * Derived from `users.role`, whose vocabulary is the two values the register
 * endpoint documents. Declared as a list rather than a single literal so adding
 * a `sales_manager` role later is a one-line change here instead of a hunt
 * through query strings.
 */
export const MANAGER_ROLES: readonly string[] = ['admin'];

/**
 * Outbound attempts allowed before an alert is marked `failed`.
 *
 * A permanently undeliverable address must not stall the retry queue for every
 * other escalation behind it.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

interface SlaAlertRow {
  id: string;
  lead_id: string;
  recipient_user_id: string;
  kind: string;
  state: string;
  channel: string;
  reason: string | null;
  minutes_to_due: number | null;
  raised_at: Date;
  delivered_at: Date | null;
  acknowledged_at: Date | null;
  acknowledged_by_user_id: string | null;
  attempts: number;
  last_error: string | null;
  correlation_id: string | null;
  /** Joined, so the ledger view issues no per-row lookup. */
  lead_name?: string | null;
  recipient_name?: string | null;
  recipient_email?: string | null;
}

/** What the caller must tell us to raise an escalation. */
export interface RaiseAlertInput {
  leadId: string;
  leadName: string | null;
  kind: SlaAlertKind;
  ownerUserId: string | null;
  reason: string;
  minutesToDue: number | null;
  correlationId: string;
}

const ALERT_SELECT = `
  SELECT a.*,
         l.name AS lead_name,
         COALESCE(
           NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
           u.email
         ) AS recipient_name,
         u.email AS recipient_email
    FROM sla_alerts a
    JOIN leads l ON l.id = a.lead_id
    JOIN users u ON u.id = a.recipient_user_id`;

/**
 * Raises and delivers SLA escalations.
 *
 * The ordering here is the whole design: the alert ROW is written first and the
 * outbound notification attempted second. That means
 *
 *  - a gateway outage degrades the CHANNEL rather than silencing the escalation
 *    — the alert is already durable and already visible in-app, and
 *    `dispatchPending` drains the backlog when the gateway returns;
 *  - the ledger can answer "was anyone actually told, and when?" after the fact,
 *    which a fire-and-forget notification cannot.
 *
 * Two invariants hold throughout:
 *
 *  1. NO DUPLICATE ESCALATIONS. A unique index on (lead, recipient, tier) means
 *     the repeating sweep raises each escalation exactly once. Without it every
 *     pass would re-notify and managers would learn to ignore the alerts.
 *  2. ACKNOWLEDGING IS NOT FORGIVING. Acknowledgement clears the alert from a
 *     manager's queue but never touches `leads.sla_breached` — a missed deadline
 *     is a historical fact, and letting an acknowledgement erase it would make
 *     the compliance number meaningless.
 */
export class SlaAlertService {
  /** Map a row to the API shape. */
  private static toAlert(row: SlaAlertRow): SlaAlert {
    return {
      id: row.id,
      lead_id: row.lead_id,
      lead_name: row.lead_name ?? null,
      recipient_user_id: row.recipient_user_id,
      recipient_name: row.recipient_name ?? null,
      kind: row.kind as SlaAlertKind,
      state: row.state as SlaAlertState,
      channel: row.channel as SlaAlertChannel,
      reason: row.reason,
      minutes_to_due: row.minutes_to_due,
      raised_at: row.raised_at.toISOString(),
      delivered_at: row.delivered_at ? row.delivered_at.toISOString() : null,
      acknowledged_at: row.acknowledged_at ? row.acknowledged_at.toISOString() : null,
      acknowledged_by_user_id: row.acknowledged_by_user_id,
      attempts: row.attempts,
      last_error: row.last_error,
    };
  }

  /**
   * Who should be told about this escalation.
   *
   * An `owner_warning` goes to the lead's owner — they are the one who can still
   * act while the clock runs. A `manager_breach` goes to every ACTIVE manager,
   * deliberately not to the owner: the owner already had their warning, and the
   * point of the second tier is that somebody ABOVE them now knows.
   *
   * @returns Recipient user ids, empty when nobody is eligible.
   */
  private static async resolveRecipients(input: RaiseAlertInput): Promise<string[]> {
    if (input.kind === 'owner_warning') {
      if (!input.ownerUserId) {
        // An unowned lead has nobody to warn. The breach tier will still reach
        // the managers, which is the correct escalation for an orphaned lead.
        return [];
      }
      const owner = await dataService.queryOne<{ id: string }>(
        'SELECT id FROM users WHERE id = $1 AND is_active = TRUE',
        [input.ownerUserId]
      );
      return owner ? [owner.id] : [];
    }

    const managers = await dataService.query<{ id: string }>(
      `SELECT id FROM users
        WHERE is_active = TRUE
          AND role = ANY($1::text[])
        ORDER BY created_at ASC`,
      [MANAGER_ROLES]
    );
    return managers.map((row) => row.id);
  }

  /**
   * Send one alert through ProjexCloud `sdk-notification`.
   *
   * @returns Whether the notification was accepted, and the error if not.
   */
  private static async deliver(
    row: SlaAlertRow
  ): Promise<{ delivered: boolean; error: string | null }> {
    if (!SdkGatewayClient.isConfigured()) {
      // Deliberately NOT marked delivered. Claiming delivery that no
      // notification service ever saw would be a lie the audit trail could not
      // detect; the alert stays pending and visible in-app.
      return { delivered: false, error: null };
    }

    try {
      const result = await SdkGatewayClient.call({
        sdk: 'sdk-notification',
        path: '/v1/notifications',
        method: 'POST',
        // The alert id, so a retry after a timeout cannot deliver twice upstream.
        idempotencyKey: row.id,
        correlationId: row.correlation_id ?? undefined,
        body: {
          template:
            row.kind === 'manager_breach' ? 'lead_sla_breached' : 'lead_sla_at_risk',
          urgency: row.kind === 'manager_breach' ? 'high' : 'normal',
          recipient: {
            user_id: row.recipient_user_id,
            email: row.recipient_email ?? null,
          },
          subject_type: 'lead',
          subject_id: row.lead_id,
          context: {
            lead_name: row.lead_name ?? null,
            reason: row.reason,
            minutes_to_due: row.minutes_to_due,
          },
        },
      });
      return { delivered: result.delivered, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[SlaAlertService] notification failed for alert ${row.id}:`, message);
      return { delivered: false, error: message };
    }
  }

  /** Record the outcome of a delivery attempt. */
  private static async recordAttempt(
    alertId: string,
    outcome: { delivered: boolean; error: string | null }
  ): Promise<void> {
    if (outcome.delivered) {
      await dataService.query(
        `UPDATE sla_alerts
            SET state        = 'delivered',
                channel      = 'projexcloud',
                delivered_at = CURRENT_TIMESTAMP,
                attempts     = attempts + 1,
                last_error   = NULL,
                updated_at   = CURRENT_TIMESTAMP
          WHERE id = $1
            AND state = 'pending'`,
        [alertId]
      );
      return;
    }

    // A failed attempt only counts when there was a gateway to fail against. An
    // unconfigured gateway must not burn the retry budget, or a project that
    // connects ProjexCloud later would find every historical alert already
    // marked failed.
    if (outcome.error === null) {
      return;
    }

    await dataService.query(
      `UPDATE sla_alerts
          SET attempts   = attempts + 1,
              last_error = $2,
              state      = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE state END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND state = 'pending'`,
      [alertId, outcome.error, MAX_DELIVERY_ATTEMPTS]
    );
  }

  /**
   * Raise an escalation, then attempt to deliver it.
   *
   * Idempotent by the unique index: a recipient who already holds an alert for
   * this lead at this tier is skipped, so the repeating sweep never re-notifies.
   *
   * NEVER THROWS. Monitoring must not fail because alerting did — an undetected
   * breach is worse than an undelivered email, and the sweep's own results are
   * still worth committing.
   *
   * @returns How many NEW alerts this call raised and how many were delivered.
   */
  static async raise(input: RaiseAlertInput): Promise<{ raised: number; delivered: number }> {
    try {
      const recipients = await SlaAlertService.resolveRecipients(input);
      if (recipients.length === 0) {
        return { raised: 0, delivered: 0 };
      }

      let raised = 0;
      let delivered = 0;

      for (const recipientId of recipients) {
        // ON CONFLICT DO NOTHING against the (lead, recipient, kind) index, so
        // an existing escalation returns no row and is silently skipped.
        const created = await dataService.queryOne<{ id: string }>(
          `INSERT INTO sla_alerts
             (lead_id, recipient_user_id, kind, state, channel, reason,
              minutes_to_due, correlation_id)
           VALUES ($1, $2, $3, 'pending', 'in_app', $4, $5, $6)
           ON CONFLICT (lead_id, recipient_user_id, kind) DO NOTHING
           RETURNING id`,
          [
            input.leadId,
            recipientId,
            input.kind,
            input.reason,
            input.minutesToDue,
            input.correlationId,
          ]
        );

        if (!created) {
          continue;
        }
        raised += 1;

        const row = await dataService.queryOne<SlaAlertRow>(
          `${ALERT_SELECT} WHERE a.id = $1`,
          [created.id]
        );
        if (!row) {
          continue;
        }

        const outcome = await SlaAlertService.deliver(row);
        await SlaAlertService.recordAttempt(created.id, outcome);
        if (outcome.delivered) {
          delivered += 1;
        }

        eventStream.publish({ type: 'sla_alert.raised', subject_id: input.leadId });
      }

      return { raised, delivered };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[SlaAlertService] could not raise ${input.kind} for ${input.leadId}:`, message);
      return { raised: 0, delivered: 0 };
    }
  }

  /**
   * Read the alert ledger, newest first.
   *
   * @param filters Optional state, kind and lead narrowing, plus paging.
   */
  static async list(filters: {
    state?: SlaAlertState;
    kind?: SlaAlertKind;
    lead_id?: string;
    limit: number;
    offset: number;
  }): Promise<{ alerts: SlaAlert[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.state) {
      params.push(filters.state);
      conditions.push(`a.state = $${params.length}`);
    }
    if (filters.kind) {
      params.push(filters.kind);
      conditions.push(`a.kind = $${params.length}`);
    }
    if (filters.lead_id) {
      params.push(filters.lead_id);
      conditions.push(`a.lead_id = $${params.length}`);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    const countRow = await dataService.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sla_alerts a${where}`,
      params
    );

    params.push(filters.limit);
    const limitPlaceholder = `$${params.length}`;
    params.push(filters.offset);
    const offsetPlaceholder = `$${params.length}`;

    const rows = await dataService.query<SlaAlertRow>(
      `${ALERT_SELECT}${where}
        ORDER BY a.raised_at DESC
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
      params
    );

    return {
      alerts: rows.map(SlaAlertService.toAlert),
      total: countRow ? parseInt(countRow.count, 10) : rows.length,
    };
  }

  /**
   * Acknowledge every alert addressed to `userId` for one lead.
   *
   * Scoped to the caller's OWN alerts: the recipient comes from the verified
   * session, never from the request body, so one manager cannot silence an
   * escalation addressed to another.
   *
   * Does NOT clear `leads.sla_breached`. Acknowledgement means "I have seen
   * this", not "this did not happen".
   *
   * @throws AppError(404 NOT_FOUND) when no lead has that id.
   */
  static async acknowledgeForLead(
    leadId: string,
    userId: string
  ): Promise<{ acknowledged: number; already_acknowledged: boolean; alerts: SlaAlert[] }> {
    const lead = await dataService.queryOne<{ id: string }>('SELECT id FROM leads WHERE id = $1', [
      leadId,
    ]);
    if (!lead) {
      throw AppError.notFound('Lead not found');
    }

    // Guarded on `state <> 'acknowledged'` so a repeat call updates nothing and
    // the original acknowledged_at survives — the audit record of when the
    // manager actually saw it must not be overwritten by a later click.
    const updated = await dataService.query<{ id: string }>(
      `UPDATE sla_alerts
          SET state                   = 'acknowledged',
              acknowledged_at         = CURRENT_TIMESTAMP,
              acknowledged_by_user_id = $2,
              updated_at              = CURRENT_TIMESTAMP
        WHERE lead_id           = $1
          AND recipient_user_id = $2
          AND state <> 'acknowledged'
        RETURNING id`,
      [leadId, userId]
    );

    const mine = await dataService.query<SlaAlertRow>(
      `${ALERT_SELECT} WHERE a.lead_id = $1 AND a.recipient_user_id = $2
        ORDER BY a.raised_at DESC`,
      [leadId, userId]
    );

    return {
      acknowledged: updated.length,
      // True only when there was something to acknowledge and it was already
      // done — distinct from "this lead has no alerts for me at all".
      already_acknowledged: updated.length === 0 && mine.length > 0,
      alerts: mine.map(SlaAlertService.toAlert),
    };
  }

  /**
   * Retry the outbound notification for pending alerts, oldest first.
   *
   * @param limit Maximum alerts to attempt in one pass.
   */
  static async dispatchPending(
    limit: number
  ): Promise<{
    attempted: number;
    delivered: number;
    failed: number;
    gateway_configured: boolean;
  }> {
    const gatewayConfigured = SdkGatewayClient.isConfigured();

    const rows = await dataService.query<SlaAlertRow>(
      `${ALERT_SELECT}
        WHERE a.state = 'pending'
          AND a.attempts < $1
        ORDER BY a.raised_at ASC
        LIMIT $2`,
      [MAX_DELIVERY_ATTEMPTS, limit]
    );

    let delivered = 0;
    let failed = 0;

    for (const row of rows) {
      const outcome = await SlaAlertService.deliver(row);
      await SlaAlertService.recordAttempt(row.id, outcome);
      if (outcome.delivered) {
        delivered += 1;
      } else if (outcome.error !== null) {
        failed += 1;
      }
    }

    return {
      attempted: rows.length,
      delivered,
      failed,
      gateway_configured: gatewayConfigured,
    };
  }
}

import { randomUUID } from 'crypto';
import { dataService } from './DataService';
import { SdkGatewayClient } from './projexcloud/SdkGatewayClient';
import { RoutingService } from './RoutingService';
import { eventStream } from './EventStream';
import { AppError, ErrorCodes } from '../utils/errors';
import { LeadCaptureInput, LeadRecord, LeadOriginClass } from '../types';

interface LeadRow {
  id: string;
  name: string | null;
  email: string | null;
  source: string | null;
  created_at: Date;
  updated_at: Date;
  owner_user_id: string | null;
  assigned_at: Date | null;
  sla_due_at: Date | null;
  routing_method: string | null;
  sla_breached: boolean;
  first_response_at: Date | null;
  /** Joined from `users`, so the inbox does not issue one lookup per row. */
  owner_name?: string | null;
}

/**
 * The lead projection plus its owner's display name.
 *
 * Selected as one join rather than N per-row lookups — the Capture Inbox renders
 * fifty rows at a time and a lookup per row is the classic N+1 that makes a
 * queue screen feel slow.
 */
const LEAD_SELECT = `
  SELECT l.*,
         COALESCE(
           NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
           u.email
         ) AS owner_name
    FROM leads l
    LEFT JOIN users u ON u.id = l.owner_user_id`;

/**
 * Captures inbound leads through the ProjexCloud lead-capture SDK.
 *
 * The SDK owns the canonical contact record, its provenance assertion and its
 * consent state. LeadFlow keeps only a lightweight local projection so the
 * capture inbox and dashboards can read without fanning out to the SDK on every
 * request.
 *
 * Capture is deliberately fault-tolerant at the boundary: the local projection
 * is always written, and the upstream assertion is attempted alongside it. A
 * capture is never lost because ProjexCloud was briefly unreachable — the
 * response reports whether the assertion was delivered so the caller (and the
 * reconciliation job) can tell the difference.
 */
export class LeadCaptureService {
  /** Convert a database row into the API shape. */
  private static toRecord(row: LeadRow): LeadRecord {
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      source: row.source,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      owner_user_id: row.owner_user_id,
      owner_name: row.owner_name ?? null,
      assigned_at: row.assigned_at ? row.assigned_at.toISOString() : null,
      sla_due_at: row.sla_due_at ? row.sla_due_at.toISOString() : null,
      routing_method: row.routing_method,
      sla_breached: row.sla_breached,
      first_response_at: row.first_response_at ? row.first_response_at.toISOString() : null,
    };
  }

  /**
   * Capture a lead: assert it upstream and project it locally.
   *
   * @param input Validated capture fields.
   * @returns The local projection plus whether the upstream assertion landed.
   */
  static async capture(input: LeadCaptureInput): Promise<{
    lead: LeadRecord;
    asserted_upstream: boolean;
    routed: boolean;
    correlation_id: string;
  }> {
    const correlationId = randomUUID();

    const row = await dataService.queryOne<LeadRow>(
      `INSERT INTO leads (name, email, source)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.name, input.email, input.source]
    );

    if (!row) {
      throw new AppError(500, ErrorCodes.INTERNAL_ERROR, 'Lead could not be captured');
    }

    const originClass: LeadOriginClass = input.origin_class ?? 'first_party_declared';
    let assertedUpstream = false;

    try {
      const result = await SdkGatewayClient.call({
        sdk: 'sdk-lead-capture',
        path: '/v1/captures',
        method: 'POST',
        idempotencyKey: row.id,
        correlationId,
        body: {
          external_id: row.id,
          origin_class: originClass,
          source_channel: input.source,
          captured_at: row.created_at.toISOString(),
          consent_granted: input.consent_granted ?? false,
          utm: input.utm ?? {},
          assertions: {
            full_name: input.name,
            email: input.email,
            phone: input.phone ?? null,
            company: input.company ?? null,
            message: input.message ?? null,
          },
        },
      });
      assertedUpstream = result.delivered;
    } catch (error) {
      // The local projection is already durable. Log and reconcile later rather
      // than failing a capture the prospect has no way to retry.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[LeadCaptureService] upstream assertion deferred (${correlationId}):`, message);
    }

    // Route at intake, not on a later click. The SOP's non-negotiable is that a
    // lead has a named owner and a running clock from the moment it arrives —
    // leaving it unowned until somebody notices is the exact failure this
    // product exists to remove.
    //
    // A routing failure does NOT fail the capture. The lead is already durable
    // and surfaces in the Capture Inbox as unowned with a Route action, and the
    // zero-orphan sweep (`AssignmentService.routeUnowned`) will pick it up. A
    // capture the prospect cannot retry must never be lost because no operator
    // happened to be available.
    let routed = false;
    try {
      const decision = await RoutingService.routeLead(row.id);
      routed = decision.decision.owner_user_id !== null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[LeadCaptureService] intake routing deferred (${correlationId}):`, message);
    }

    // Re-read so the response carries the owner and clock the caller now has,
    // rather than the pre-routing snapshot.
    const finalRow =
      (await dataService.queryOne<LeadRow>(`${LEAD_SELECT} WHERE l.id = $1`, [row.id])) ?? row;

    eventStream.publish({ type: 'lead.captured', subject_id: row.id });

    return {
      lead: LeadCaptureService.toRecord(finalRow),
      asserted_upstream: assertedUpstream,
      routed,
      correlation_id: correlationId,
    };
  }

  /**
   * List captured leads, newest first.
   *
   * @param limit  Page size, clamped to 1..200.
   * @param offset Rows to skip.
   */
  static async list(limit = 50, offset = 0): Promise<{ leads: LeadRecord[]; total: number }> {
    const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? limit : 50, 1), 200);
    const safeOffset = Math.max(Number.isFinite(offset) ? offset : 0, 0);

    const rows = await dataService.query<LeadRow>(
      `${LEAD_SELECT} ORDER BY l.created_at DESC LIMIT $1 OFFSET $2`,
      [safeLimit, safeOffset]
    );
    const countRow = await dataService.queryOne<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM leads'
    );

    return {
      leads: rows.map(LeadCaptureService.toRecord),
      total: countRow ? parseInt(countRow.count, 10) : rows.length,
    };
  }

  /**
   * Fetch one lead by id.
   * @throws AppError(404 NOT_FOUND) when no lead has that id.
   */
  static async getById(id: string): Promise<LeadRecord> {
    const row = await dataService.queryOne<LeadRow>(`${LEAD_SELECT} WHERE l.id = $1`, [id]);
    if (!row) {
      throw AppError.notFound('Lead not found');
    }
    return LeadCaptureService.toRecord(row);
  }
}

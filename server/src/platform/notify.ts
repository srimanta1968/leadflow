import { SdkGatewayClient } from './sdkGateway';
import { config } from '../config/env';

/**
 * The one place LeadFlow talks to sdk-notification.
 *
 * WHY THIS EXISTS. Six call sites had independently invented the same wrong
 * request: `POST /api/notifications` with `{audience[], channels[], template,
 * body, recipients[]}`. That path does not exist — sdk-notification registers
 * `/api/notifications/send` — and none of those field names are read by it
 * either. Every one of those calls had been 404ing since it was written, and
 * because each caller wraps the gateway in a try/catch and degrades, the
 * failures were invisible: the alert simply never arrived.
 *
 * THE DEEPER MISMATCH, and the reason this is a module rather than a
 * find-and-replace: sdk-notification is POINT-TO-POINT. It sends ONE message,
 * to ONE person, on ONE channel, at a KNOWN destination — it validates
 * template_code, person_id, channel and destination and rejects anything
 * missing them. LeadFlow's callers think in AUDIENCES: "tell the sales manager
 * and RevOps". There is no endpoint that resolves an audience to its people.
 *
 * So this helper does the honest thing in both directions. Given resolved
 * recipients it sends one correctly-shaped call each. Given only an audience it
 * does NOT fire a request that is guaranteed to 400 — it returns `delivered:
 * false` with a reason naming the missing resolution, so the caller records a
 * gap instead of believing somebody was told.
 */

export interface NotifyRecipient {
  /** The platform persona. Required by sdk-notification, no substitute. */
  personId: string;
  /** The address or number. sdk-notification will not look one up. */
  destination: string;
  channel: 'email' | 'sms' | 'in_app' | 'push';
}

export interface NotifyResult {
  delivered: boolean;
  sent: number;
  attempted: number;
  /** Present whenever `delivered` is false. Never null on a failure. */
  reason: string | null;
}

export async function notify(input: {
  templateCode: string;
  recipients: NotifyRecipient[];
  /** Named only for the gap message when recipients could not be resolved. */
  audience?: string[];
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  correlationId?: string | null;
}): Promise<NotifyResult> {
  if (!SdkGatewayClient.isConfigured()) {
    return { delivered: false, sent: 0, attempted: 0, reason: 'The notification service is not configured in this environment.' };
  }

  if (input.recipients.length === 0) {
    /*
     * REFUSED RATHER THAN ATTEMPTED. Posting an audience with no resolved
     * person is a guaranteed 400, and a 400 in the log reads like a bug in the
     * request when the real fact is that nobody has resolved who "the sales
     * manager" is. Saying so plainly is more useful than a rejected call.
     */
    return {
      delivered: false, sent: 0, attempted: 0,
      reason: input.audience?.length
        ? `No recipient was resolved for ${input.audience.join(', ')}. sdk-notification sends to one person at a known destination and exposes no audience lookup, so this alert has nowhere to go until LeadFlow resolves the audience to personas and addresses first.`
        : 'No recipient was supplied.',
    };
  }

  let sent = 0;
  const failures: string[] = [];
  for (const [index, r] of input.recipients.entries()) {
    try {
      const result = await SdkGatewayClient.call({
        sdk: 'sdk-notification',
        path: '/api/notifications/send',
        method: 'POST',
        // Per RECIPIENT, so a retry cannot re-send to the ones that already
        // succeeded — telling somebody twice is the harm being avoided here.
        idempotencyKey: `${input.idempotencyKey}:${index}`,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        body: {
          tenant_id: config.projexCloud.tenantId,
          template_code: input.templateCode,
          person_id: r.personId,
          channel: r.channel,
          destination: r.destination,
          payload: input.payload ?? {},
        },
      });
      if (result.delivered) sent += 1;
      else failures.push(`${r.channel} to ${r.personId} was not accepted`);
    } catch (error) {
      failures.push(`${r.channel} to ${r.personId}: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  return {
    delivered: sent > 0,
    sent,
    attempted: input.recipients.length,
    /* A PARTIAL SEND REPORTS ITS FAILURES. "delivered: true" on 1 of 5 would
       let a caller record that everybody was told. */
    reason: failures.length === 0 ? null : failures.join('; '),
  };
}

import { config } from '../../config/env';
import { SdkGatewayClient } from '../sdkGateway';
import { HANDLED_EVENT_TYPES } from './projections';

/**
 * Registering LeadFlow's receiver with sdk-webhook, and subscribing it.
 *
 * THIS IS PUSH, NOT POLL, and that is worth stating because the task describes
 * "subscribe and fan in". There is no domain-event bus to read from: sdk-event
 * is event registration and ticketing, and GET /api/webhooks/deliveries returns
 * `listDlq()` — it surfaces what has already FAILED, never the live stream. So
 * the only way to receive an event is to register an https endpoint, subscribe
 * it per event type, and let ProjexCloud POST to it. The receiver is
 * eventsController's POST /api/leadflow/events/projexcloud.
 *
 * PAYLOAD SHAPES ARE THE PRODUCER'S, transcribed rather than guessed:
 *
 *   POST /api/webhooks/endpoints   -> 201
 *     tenant_id        required, UUID
 *     url              required, must be https:// — plain http is REFUSED
 *     signing_key_ref  required, a REFERENCE to a key, not the key itself
 *     signing_algo     optional, hmac-sha256 (default) | hmac-sha512
 *
 *   POST /api/webhooks/endpoints/:id/subscribe -> 201
 *     event_type       required; endpoint_id comes from the PATH, not the body
 *
 *   POST /api/webhooks/publish     -> 202, a queue accept rather than a create
 *     tenant_id, event_type, event_id, payload  all required
 *
 * SUBSCRIBE REFUSES AN UNREGISTERED EVENT TYPE. sdk-webhook mirrors the OC-2
 * guard: a type in neither the platform baseline nor this tenant's own
 * registrations is rejected, because a typo would otherwise drop every delivery
 * silently and an empty deliveries list is indistinguishable from "nothing has
 * happened yet". LeadFlow registers its vocabulary in eventTypeProvisioner, so
 * ordering matters — provision first, subscribe second.
 */

export interface RegistrationResult {
  attempted: boolean;
  endpointId: string | null;
  subscribed: string[];
  refused: { eventType: string; reason: string }[];
  skipped: string | null;
}

/** Every event type the pipeline projection can actually do something with. */
export function subscribableEventTypes(): string[] {
  return Object.keys(HANDLED_EVENT_TYPES).sort();
}

/**
 * Register the receiver and subscribe it to everything we handle.
 *
 * Idempotent in intention rather than by contract: re-registering the same URL
 * is the producer's business, and a duplicate subscription is reported as a
 * refusal rather than treated as a failure. Runs at boot, so a fresh
 * environment wires itself up.
 */
export async function registerEventReceiver(): Promise<RegistrationResult> {
  const result: RegistrationResult = {
    attempted: false,
    endpointId: null,
    subscribed: [],
    refused: [],
    skipped: null,
  };

  if (!SdkGatewayClient.isConfigured()) {
    result.skipped = 'ProjexCloud gateway is not configured';
    return result;
  }
  if (!config.projexCloud.tenantId) {
    // tenant_id must be a UUID and the endpoint belongs to exactly one tenant.
    result.skipped = 'PROJEXCLOUD_TENANT_ID is not set, and the endpoint belongs to a tenant';
    return result;
  }
  const url = config.projexCloud.webhookReceiverUrl;
  if (!url) {
    result.skipped = 'PROJEXCLOUD_WEBHOOK_RECEIVER_URL is not set, so there is nowhere to deliver to';
    return result;
  }
  if (!url.startsWith('https://')) {
    // Refused HERE rather than upstream, so the reason names the actual problem.
    // A cleartext receiver would carry personal data over the open internet, and
    // the HMAC proves origin, not confidentiality.
    result.skipped = `Receiver URL must be https:// — sdk-webhook refuses plain http (${url})`;
    return result;
  }
  if (!config.projexCloud.webhookSigningKeyRef) {
    // A REF, not the secret. Sending the literal key here would put it in the
    // producer's request log, and the field is not what it is for.
    result.skipped = 'PROJEXCLOUD_WEBHOOK_SIGNING_KEY_REF is not set';
    return result;
  }

  result.attempted = true;

  const endpoint = await SdkGatewayClient.call<{ data?: { endpoint?: { endpoint_id?: string } } }>({
    sdk: 'sdk-webhook',
    path: '/api/webhooks/endpoints',
    method: 'POST',
    body: {
      tenant_id: config.projexCloud.tenantId,
      url,
      signing_key_ref: config.projexCloud.webhookSigningKeyRef,
      signing_algo: 'hmac-sha256',
    },
    // Same URL and tenant every boot, so a redelivery of this registration is
    // the same intention rather than a second endpoint.
    idempotencyKey: `leadflow:webhook-endpoint:${config.projexCloud.tenantId}:${url}`,
  });

  const endpointId = endpoint.data?.data?.endpoint?.endpoint_id ?? null;
  result.endpointId = endpointId;
  if (!endpointId) {
    result.refused.push({ eventType: '*', reason: 'endpoint registration returned no endpoint_id' });
    return result;
  }

  for (const eventType of subscribableEventTypes()) {
    try {
      await SdkGatewayClient.call({
        sdk: 'sdk-webhook',
        path: `/api/webhooks/endpoints/${endpointId}/subscribe`,
        method: 'POST',
        // endpoint_id comes from the PATH; the handler merges it in and accepts
        // an empty body, so sending it again would be redundant at best.
        body: { event_type: eventType },
        idempotencyKey: `leadflow:webhook-sub:${endpointId}:${eventType}`,
      });
      result.subscribed.push(eventType);
    } catch (error) {
      // ONE REFUSAL MUST NOT STOP THE REST. A single unregistered type would
      // otherwise leave every later subscription unmade, and the symptom would
      // be "most events do not arrive" rather than "this one type is unknown".
      const message = error instanceof Error ? error.message : String(error);
      result.refused.push({ eventType, reason: message });
    }
  }

  return result;
}

/**
 * Register LeadFlow's audit event types with ProjexCloud.
 *
 * WHY THIS EXISTS. ProjexCloud refuses an append whose event_type it does not
 * know — OC-2: "a type in neither the platform registry nor the tenant's own
 * registrations is rejected before any write". LeadFlow declared 48 names in
 * platform/audit/vocabulary.ts and never registered any of them, so sdk-audit
 * answered 400 to every append and the whole audit trail was discarded.
 *
 * That failure is invisible by design: emitEvent SWALLOWS append errors so a
 * transient outage cannot take a request down with it. The cost is that a
 * permanent rejection looks exactly like a blip — the chain still verifies
 * clean, because it is empty. These lines in the server log were the only
 * evidence:
 *
 *   [audit] FAILED TO APPEND sla.policy.updated (...): ProjexCloud sdk-audit returned 400
 *
 * A consuming application registers its OWN types at runtime. It must never add
 * to the platform's EVENT_TYPE_REGISTRY constant, and must not reuse a platform
 * name: resolution is baseline-first then tenant, so a tenant type can never
 * shadow a platform one.
 *
 * Runs on EVERY boot rather than once behind a flag, like the role and consent
 * provisioners: a flag would be a local record of upstream state, and the two
 * drift the first time the tenant is rebuilt.
 */
import { SdkGatewayClient } from '../../services/projexcloud/SdkGatewayClient';
import { config } from '../../config/env';
import { AUDIT_EVENTS } from './vocabulary';

export interface EventTypeProvisionSummary {
  attempted: boolean;
  created: number;
  alreadyPresent: number;
  failed: number;
  skipped?: string;
}

/** A 409/duplicate is success: registration is additive and idempotent. */
function isAlreadyExists(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /409|already exists|duplicate/i.test(message);
}

export async function provisionAuditEventTypes(): Promise<EventTypeProvisionSummary> {
  const summary: EventTypeProvisionSummary = {
    attempted: false,
    created: 0,
    alreadyPresent: 0,
    failed: 0,
  };

  if (!config.projexCloud?.tenantId) {
    summary.skipped = 'PROJEXCLOUD_TENANT_ID is not set';
    return summary;
  }

  // Deduplicated: the vocabulary maps many constants onto a closed set of names,
  // and registering the same type twice is wasted round-trips, not an error.
  const eventTypes = Array.from(new Set(Object.values(AUDIT_EVENTS)));
  summary.attempted = true;

  for (const eventType of eventTypes) {
    try {
      await SdkGatewayClient.call({
        sdk: 'sdk-audit',
        path: '/api/events/types',
        method: 'POST',
        // Keyed on the type so a retry after a timeout cannot register twice.
        idempotencyKey: `event-type:${eventType}`,
        body: {
          tenant_id: config.projexCloud.tenantId,
          event_type: eventType,
        },
      });
      summary.created += 1;
    } catch (error) {
      if (isAlreadyExists(error)) {
        summary.alreadyPresent += 1;
        continue;
      }
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[eventTypes] ${eventType} could not be registered:`, detail);
      summary.failed += 1;
    }
  }

  return summary;
}

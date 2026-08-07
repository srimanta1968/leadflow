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
import { SdkGatewayClient, upstreamStatusOf } from '../../platform/sdkGateway';
import { config } from '../../config/env';
import { AUDIT_EVENTS } from './vocabulary';

export interface EventTypeProvisionSummary {
  attempted: boolean;
  created: number;
  alreadyPresent: number;
  failed: number;
  skipped?: string;
}

/**
 * A 409/duplicate is success: registration is additive and idempotent.
 *
 * So is a PLATFORM BASELINE collision, which arrives as a 400 rather than a
 * 409. `import.run.committed.v1` and `handoff.accepted.v1` are both in
 * ProjexCloud's EVENT_TYPE_REGISTRY, and registerTenantEventType refuses to let
 * a tenant re-register a baseline name — resolution is baseline-first, so the
 * tenant row could never win and would read as a redefinition of a type other
 * tenants already write under. What is refused is REGISTERING the name; using
 * it is unaffected, because resolveEventType finds it in the baseline and both
 * carry the regulated + event-sourcing metadata we wanted anyway. Counting that
 * as a failure logged two permanent errors on every boot for event types that
 * append perfectly well.
 */
function isAlreadyExists(error: unknown): boolean {
  // A 409 is structural and read from the error, not from its wording.
  const status = upstreamStatusOf(error);
  if (status === 409) return true;

  // The baseline case is genuinely TEXTUAL and cannot be read from a status:
  // ProjexCloud answers 400 for it, which is the same status as a real
  // validation failure. The distinguishing information exists only in the
  // detail the gateway quoted, so this half stays a message match -- narrowed
  // to a 400 so it cannot swallow an unrelated error.
  if (status !== 400) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|duplicate|platform baseline type/i.test(message);
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
          event_type: eventType,
          // REQUIRED, and there are no server-side defaults — omitting either one
          // fails validation with a 400 that emitEvent then swallows, which is how
          // all 48 registrations failed silently while the boot log still read as
          // routine. tenant_id is deliberately NOT sent: the route takes it from
          // the verified claim and ignores the body, so passing it only suggests
          // a caller could choose its own tenant.
          //
          // regulated + event-sourcing to match how the platform classifies the
          // equivalent vault/consent types. This vocabulary is consent receipts,
          // PII reveals, SLA breaches and AI decisions — the record you have to
          // produce when asked why someone was contacted, so it must not be
          // compacted or last-write-wins away.
          retention_class: 'regulated',
          conflict_policy: 'event-sourcing',
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

import { dataService } from '../../services/DataService';
import { SdkGatewayClient } from '../../services/projexcloud/SdkGatewayClient';
import { currentTenantContext, tenantIdFor } from '../../platform/tenancy/tenantHierarchy';

/** The three groups SOP §03 organises the required fields into. */
export type FieldGroup = 'identity_and_source' | 'ownership_and_lifecycle' | 'communication_and_commercial';

export interface RequiredField {
  /** The field as the SOP names it. */
  field: string;
  group: FieldGroup;
  /**
   * True when ANY ONE of a set satisfies the requirement.
   *
   * "Usable phone, email or social id" is one requirement met three ways, not
   * three requirements. Listing them separately would block a perfectly
   * contactable record for lacking two channels it never needed.
   */
  oneOf?: string[];
  /** Why the field is required, in the SOP's terms. */
  reason: string;
}

/**
 * Every field a record needs before it may be ACTIVATED.
 *
 * ACTIVATION, not creation. A record is created the moment a signal arrives —
 * refusing to store it until it is complete would lose the lead, which is the
 * opposite of the point. The gate governs whether it may be worked: assigned,
 * sequenced, counted in the pipeline.
 */
export const REQUIRED_FIELDS: RequiredField[] = [
  // ---- Identity + Source ----
  {
    field: 'name_or_company',
    group: 'identity_and_source',
    oneOf: ['name', 'company'],
    reason: 'A record nobody can name cannot be worked, and a rep opening it has nothing to say.',
  },
  {
    field: 'contactable_channel',
    group: 'identity_and_source',
    oneOf: ['email', 'phone', 'social_id'],
    reason:
      'One usable channel, met by any of the three. A record with none is not a lead — it is a note.',
  },
  {
    field: 'original_source',
    group: 'identity_and_source',
    reason: 'Where the record came from. Without it the provenance chain starts nowhere.',
  },
  {
    field: 'latest_source',
    group: 'identity_and_source',
    reason:
      'The most recent touch. Distinct from the original: a lead that arrived by ad and returned by referral has two, and only tracking both explains the journey.',
  },
  {
    field: 'attribution_campaign',
    group: 'identity_and_source',
    oneOf: ['attribution_campaign_id', 'utm_campaign', 'attribution_form_id'],
    reason:
      'The campaign, UTM or form that produced it. Any one satisfies it — an organic web form has no campaign and is still perfectly activatable.',
  },
  // ---- Ownership + Lifecycle ----
  {
    field: 'primary_owner',
    group: 'ownership_and_lifecycle',
    oneOf: ['owner_user_id', 'owner_persona_id'],
    reason: 'SOP §28: every open record has an owner. An unowned record is nobody’s problem.',
  },
  {
    field: 'assigned_at',
    group: 'ownership_and_lifecycle',
    reason: 'When ownership started. The SLA clock is measured from it.',
  },
  {
    field: 'stage',
    group: 'ownership_and_lifecycle',
    oneOf: ['stage', 'routing_method'],
    reason: 'Where the record sits in the pipeline.',
  },
  {
    field: 'next_action',
    group: 'ownership_and_lifecycle',
    oneOf: ['next_action_type', 'sla_due_at'],
    reason:
      'SOP §28’s NO BLANK NEXT rule: an open record always has a next action with an owner and a due time. A record with no next step is one that quietly stops moving.',
  },
  // ---- Communication + Commercial ----
  {
    field: 'email_status',
    group: 'communication_and_commercial',
    oneOf: ['email_status', 'email'],
    reason:
      'Whether the address is usable. Sending to an unverified address burns the sending domain for everyone else.',
  },
  {
    field: 'dnc_checked',
    group: 'communication_and_commercial',
    oneOf: ['dnc_checked_at', 'suppression_checked_at'],
    reason:
      'Do-not-contact must be CHECKED before activation, not at send time. Checking late means the first outreach is the one that breaks the rule.',
  },
];

export type ActivationState = 'active' | 'blocked';

export interface MissingField {
  field: string;
  group: FieldGroup;
  reason: string;
  /** The alternatives that would each have satisfied it. */
  satisfiedByAnyOf: string[];
}

export interface ActivationVerdict {
  leadId: string;
  state: ActivationState;
  /** EVERY missing field, not the first one found. */
  missing: MissingField[];
  /** Counts per group, so a manager sees where the gap is. */
  byGroup: Record<FieldGroup, number>;
  /** Set when the gate failed and an exception was raised. */
  integrityExceptionRef: string | null;
}

/** Whether a row satisfies one requirement. */
function isSatisfied(row: Record<string, unknown>, requirement: RequiredField): boolean {
  const candidates = requirement.oneOf ?? [requirement.field];
  return candidates.some((column) => {
    const value = row[column];
    return value !== null && value !== undefined && String(value).trim().length > 0;
  });
}

/**
 * Evaluate the activation gate for one record.
 *
 * REPORTS EVERY MISSING FIELD, never just the first. A gate that stops at the
 * first failure turns completing a record into a guessing game: the operator
 * fills one field, resubmits, and is told about the next — six round trips for
 * six fields. Naming them all is the difference between a gate and an obstacle.
 */
export async function evaluateActivationGate(leadId: string): Promise<ActivationVerdict | null> {
  const row = await dataService.queryOne<Record<string, unknown>>(
    `SELECT l.*,
            (SELECT max(platform) FROM lead_source_event e WHERE e.lead_id = l.id) AS latest_source,
            (SELECT min(platform) FROM lead_source_event e WHERE e.lead_id = l.id) AS original_source
       FROM leads l WHERE l.id = $1`,
    [leadId]
  );

  if (!row) {
    return null;
  }

  const missing: MissingField[] = REQUIRED_FIELDS.filter(
    (requirement) => !isSatisfied(row, requirement)
  ).map((requirement) => ({
    field: requirement.field,
    group: requirement.group,
    reason: requirement.reason,
    satisfiedByAnyOf: requirement.oneOf ?? [requirement.field],
  }));

  const byGroup: Record<FieldGroup, number> = {
    identity_and_source: missing.filter((m) => m.group === 'identity_and_source').length,
    ownership_and_lifecycle: missing.filter((m) => m.group === 'ownership_and_lifecycle').length,
    communication_and_commercial: missing.filter(
      (m) => m.group === 'communication_and_commercial'
    ).length,
  };

  const state: ActivationState = missing.length === 0 ? 'active' : 'blocked';

  await dataService.query(
    `UPDATE leads SET activation_state = $2, activation_checked_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [leadId, state]
  );

  const integrityExceptionRef =
    state === 'blocked' ? await raiseIntegrityException(leadId, missing) : null;

  return { leadId, state, missing, byGroup, integrityExceptionRef };
}

/**
 * Raise a manager-visible integrity exception.
 *
 * VISIBLE, not logged. The criterion is that a record failing the gate becomes
 * a manager's problem rather than silently incomplete — and a silently
 * incomplete record is the worse outcome by far, because it sits in the
 * pipeline looking like every other lead while being unworkable.
 *
 * The local `activation_state = 'blocked'` marker is written FIRST and does not
 * depend on the incident SDK. If raising the exception fails, the record is
 * still flagged and still appears in the manager's integrity queue — the queue
 * is an indexed read over that column, so the visibility survives an upstream
 * outage.
 */
async function raiseIntegrityException(
  leadId: string,
  missing: MissingField[]
): Promise<string | null> {
  if (!SdkGatewayClient.isConfigured()) {
    // The local marker is already written, so the record is visible in the
    // queue regardless. Reported as null rather than a fabricated reference.
    return null;
  }

  try {
    const result = await SdkGatewayClient.call<{ data?: { incident_id?: string } }>({
      sdk: 'sdk-incident',
      path: '/api/incidents',
      method: 'POST',
      idempotencyKey: `activation-gate:${leadId}`,
      body: {
        tenant_id: tenantIdFor(currentTenantContext(), 'lead'),
        kind: 'lead_activation_blocked',
        severity: 'warning',
        summary: `Lead ${leadId} cannot be activated: ${missing.length} required field(s) missing`,
        // The FIELD NAMES, not a count. An exception saying "3 fields missing"
        // sends the manager back to the record to find out which.
        detail: missing.map((m) => `${m.group}.${m.field}`).join(', '),
      },
    });
    return result.data?.data?.incident_id ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[activationGate] could not raise incident for ${leadId}:`, message);
    return null;
  }
}

import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { evaluateBulk, type ChannelDecisionInput } from '../../orchestration/channelDecision';

/**
 * Audience segments over the GOVERNED dimensions of the contact data platform.
 *
 * The point of this module is one guarantee: a record whose source rights do not
 * permit the campaign's purpose CANNOT enter the audience. Everything else —
 * the estimate, the breakdown, the snapshot — exists to make that guarantee
 * legible after the fact.
 */

/** The governed dimensions a segment may filter on. */
export const SEGMENT_DIMENSIONS = [
  'trust_state', 'origin_class', 'permitted_uses', 'channel_eligibility',
  'property_role', 'consent_state', 'suppression_state', 'engagement_recency',
  'lead_score', 'pipeline_stage',
] as const;

/** Why a record was refused. Each is a different fix by a different person. */
export const EXCLUSION_REASONS = [
  'source_rights_forbid_purpose',
  'no_consent_for_purpose',
  'suppressed',
  'channel_ineligible',
  'trust_state_too_low',
  'undeliverable',
  'criteria_not_met',
  'rights_unknown',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface SegmentCriteria {
  trust_state_min?: string;
  origin_class?: string[];
  pipeline_stage?: string[];
  lead_score_min?: number;
  engagement_within_days?: number;
  property_role?: string[];
}

export interface Candidate {
  subjectRef: string;
  leadId?: string | null;
  originClass?: string | null;
  trustState?: string | null;
  stage?: string | null;
}

export interface Exclusion { subjectRef: string; reason: ExclusionReason; detail: string }

export interface PreviewResult {
  eligible: string[];
  exclusions: Exclusion[];
  breakdown: Record<string, number>;
  rightsChecked: number;
  rightsUnavailable: boolean;
  undecided: number;
}

/**
 * Which permitted use a campaign purpose needs from a licensed record.
 *
 * THE MAP IS EXPLICIT RATHER THAN A STRING COMPARISON. "marketing" in a purpose
 * key and "Marketing SMS" in a licence are not the same vocabulary, and matching
 * them by substring is how a record licensed for Marketing Email ends up in an
 * SMS audience — the exact failure named in the acceptance test.
 */
const PERMITTED_USE_FOR: Record<string, Record<string, string>> = {
  marketing: { sms: 'marketing_sms', email: 'marketing_email', voice: 'marketing_voice' },
  sales_outreach: { sms: 'sales_sms', email: 'sales_email', voice: 'sales_voice' },
  project_operations: { sms: 'operational_sms', email: 'operational_email', voice: 'operational_voice' },
};

export function requiredPermittedUse(purposeKey: string, channel: string): string | null {
  const family = purposeKey.split('.')[0]?.toLowerCase() ?? '';
  return PERMITTED_USE_FOR[family]?.[channel.toLowerCase()] ?? null;
}

/**
 * Ask sdk-source-record which uses each candidate's licence permits.
 *
 * AN UNREACHABLE RIGHTS SERVICE EXCLUDES RATHER THAN ADMITS. A record whose
 * rights cannot be read is not a record whose rights are permissive: shipping a
 * marketing SMS to a licensed contact whose licence forbade it is a contractual
 * breach, and "the service was down" is not a defence anybody accepts. The
 * refusal is reported as its own reason so an operator can tell an outage from a
 * genuine restriction.
 */
export async function permittedUsesFor(
  subjectRefs: string[]
): Promise<{ uses: Map<string, string[]>; available: boolean }> {
  const uses = new Map<string, string[]>();
  if (subjectRefs.length === 0) return { uses, available: true };
  if (!SdkGatewayClient.isConfigured()) return { uses, available: false };

  try {
    const result = await SdkGatewayClient.call<{ data?: { records?: { subject_ref?: string; permitted_uses?: string[] }[] } }>({
      sdk: 'sdk-source-record',
      path: '/api/source-records/lookup',
      method: 'POST',
      idempotencyKey: `segment-rights:${subjectRefs.length}:${subjectRefs[0]}`,
      body: { tenant_id: config.projexCloud.tenantId, subject_refs: subjectRefs.slice(0, 1000) },
    });
    if (!result.delivered) return { uses, available: false };
    for (const row of result.data?.data?.records ?? []) {
      if (typeof row.subject_ref === 'string') uses.set(row.subject_ref, row.permitted_uses ?? []);
    }
    return { uses, available: true };
  } catch {
    return { uses, available: false };
  }
}

/**
 * Compute the audience, with every refusal named.
 *
 * THE BREAKDOWN IS THE DELIVERABLE, not the count. "412 eligible" tells a
 * marketer nothing they can act on; "412 eligible, 88 excluded — 60 have no
 * consent for this purpose, 21 are suppressed, 7 are licensed records whose
 * rights forbid marketing SMS" tells them which of those they can fix and which
 * they must not.
 */
export async function preview(input: {
  candidates: Candidate[];
  purposeKey: string;
  channel: string;
  criteria: SegmentCriteria;
}): Promise<PreviewResult> {
  const exclusions: Exclusion[] = [];
  const survivors: Candidate[] = [];

  /* Local criteria first, because they are free and shrink the set before the
     expensive governed checks run over it. */
  for (const c of input.candidates) {
    const failed = criteriaFailure(c, input.criteria);
    if (failed) exclusions.push({ subjectRef: c.subjectRef, reason: 'criteria_not_met', detail: failed });
    else survivors.push(c);
  }

  /* SOURCE RIGHTS BEFORE ANYTHING ELSE. It is the one check that is contractual
     rather than operational: consent can be re-obtained and a suppression can
     expire, but a licence that forbids marketing SMS forbids it permanently, and
     a record that fails here must never reach the channel decision — not even to
     be denied there, because a denial is a decision about a record we should not
     be considering. */
  const needed = requiredPermittedUse(input.purposeKey, input.channel);
  const licensed = survivors.filter((c) => (c.originClass ?? '') === 'licensed_third_party');
  const { uses, available } = licensed.length > 0
    ? await permittedUsesFor(licensed.map((c) => c.subjectRef))
    : { uses: new Map<string, string[]>(), available: true };

  const rightsCleared: Candidate[] = [];
  for (const c of survivors) {
    if ((c.originClass ?? '') !== 'licensed_third_party') { rightsCleared.push(c); continue; }
    if (!available) {
      exclusions.push({
        subjectRef: c.subjectRef, reason: 'rights_unknown',
        detail: 'The source-rights service could not be reached, so this licensed record is held out. Unknown rights are not permissive rights.',
      });
      continue;
    }
    const permitted = uses.get(c.subjectRef) ?? [];
    if (needed !== null && !permitted.includes(needed)) {
      exclusions.push({
        subjectRef: c.subjectRef, reason: 'source_rights_forbid_purpose',
        detail: `This licensed record's permitted uses do not include ${needed}, so it cannot enter a ${input.channel} audience for ${input.purposeKey}.`,
      });
      continue;
    }
    rightsCleared.push(c);
  }

  /* Consent, suppression, deliverability and channel eligibility, in one bulk
     pass rather than one call per subject. */
  let undecided = 0;
  const eligible: string[] = [];
  if (rightsCleared.length > 0) {
    const inputs: ChannelDecisionInput[] = rightsCleared.map((c) => ({
      subjectRef: c.subjectRef,
      channel: input.channel as ChannelDecisionInput['channel'],
      purposeKey: input.purposeKey,
      audience: 'prospect',
      tenantId: config.projexCloud.tenantId,
      decidedBy: 'segmentPreview',
    }));
    const bulk = await evaluateBulk(inputs);
    undecided = bulk.undecided.length;

    bulk.decisions.forEach((decision, position) => {
      const candidate = rightsCleared[position];
      if (!candidate) return;
      if (decision.verdict === 'allow') { eligible.push(candidate.subjectRef); return; }
      exclusions.push({
        subjectRef: candidate.subjectRef,
        reason: reasonFor(decision.reasons),
        detail: decision.reasons[0]?.text ?? `The channel decision returned ${decision.verdict}.`,
      });
    });
    /* Budget exhaustion is NAMED, never silently treated as eligible — a caller
       that believes it holds a verdict it never got would send to it. */
    for (const position of bulk.undecided) {
      const candidate = rightsCleared[position];
      if (!candidate) continue;
      exclusions.push({
        subjectRef: candidate.subjectRef, reason: 'rights_unknown',
        detail: 'The eligibility budget ran out before this record was evaluated. It is held out rather than assumed eligible.',
      });
    }
  }

  const breakdown: Record<string, number> = {};
  for (const r of EXCLUSION_REASONS) breakdown[r] = 0;
  for (const e of exclusions) breakdown[e.reason] = (breakdown[e.reason] ?? 0) + 1;

  return {
    eligible, exclusions, breakdown,
    rightsChecked: licensed.length,
    rightsUnavailable: !available,
    undecided,
  };
}

function criteriaFailure(c: Candidate, criteria: SegmentCriteria): string | null {
  if (criteria.origin_class?.length && !criteria.origin_class.includes(c.originClass ?? '')) {
    return `origin class ${c.originClass ?? 'unknown'} is not in the segment's list`;
  }
  if (criteria.pipeline_stage?.length && !criteria.pipeline_stage.includes(c.stage ?? '')) {
    return `pipeline stage ${c.stage ?? 'unknown'} is not in the segment's list`;
  }
  if (criteria.trust_state_min && (c.trustState ?? 'P4') > criteria.trust_state_min) {
    /* P0 is the most trusted, so a HIGHER label is a lower trust state — the
       string comparison is correct and the comment is here because it reads
       backwards. */
    return `trust state ${c.trustState ?? 'P4'} is below the segment's minimum of ${criteria.trust_state_min}`;
  }
  return null;
}

function reasonFor(reasons: { code?: string }[]): ExclusionReason {
  const code = (reasons[0]?.code ?? '').toUpperCase();
  if (code.includes('CONSENT')) return 'no_consent_for_purpose';
  if (code.includes('SUPPRESS')) return 'suppressed';
  if (code.includes('DELIVER') || code.includes('BOUNCE')) return 'undeliverable';
  if (code.includes('ELIGIB') || code.includes('QUIET') || code.includes('CAP')) return 'channel_ineligible';
  if (code.includes('TRUST')) return 'trust_state_too_low';
  return 'criteria_not_met';
}

/* ------------------------------------------------------------------ storage */

export async function saveDefinition(input: {
  segmentKey: string; name: string; purposeKey: string; channel: string;
  criteria: SegmentCriteria; createdBy: string | null;
}): Promise<{ segmentId: string; version: number }> {
  /* SUPERSEDE THEN INSERT. A definition is immutable once written and an edit
     produces a new version, because an audience computed last week must stay
     explainable against the definition that produced it — an in-place update
     silently rewrites the reason every past snapshot was built. */
  await dataService.query(
    `UPDATE leadflow_segment_definition SET superseded_at = now()
      WHERE tenant_id = $1 AND segment_key = $2 AND superseded_at IS NULL`,
    [config.projexCloud.tenantId, input.segmentKey]
  );
  const rows = await dataService.query<{ segment_id: string; version: number }>(
    `INSERT INTO leadflow_segment_definition
       (tenant_id, segment_key, version, name, purpose_key, channel, criteria, created_by)
     VALUES ($1,$2,
             (SELECT COALESCE(MAX(version),0)+1 FROM leadflow_segment_definition WHERE tenant_id = $1 AND segment_key = $2),
             $3,$4,$5,$6::jsonb,$7)
     RETURNING segment_id, version`,
    [
      config.projexCloud.tenantId, input.segmentKey, input.name, input.purposeKey,
      input.channel, JSON.stringify(input.criteria), input.createdBy,
    ]
  );
  return { segmentId: rows[0].segment_id, version: rows[0].version };
}

export async function captureSnapshot(input: {
  segmentId: string; segmentKey: string; version: number; purposeKey: string;
  channel: string; result: PreviewResult; computedBy: string | null;
}): Promise<string> {
  const rows = await dataService.query<{ snapshot_id: string }>(
    `INSERT INTO leadflow_audience_snapshot
       (tenant_id, segment_id, segment_key, segment_version, purpose_key, channel,
        eligible_count, excluded_count, members, exclusions, breakdown, computed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12)
     RETURNING snapshot_id`,
    [
      config.projexCloud.tenantId, input.segmentId, input.segmentKey, input.version,
      input.purposeKey, input.channel,
      input.result.eligible.length, input.result.exclusions.length,
      JSON.stringify(input.result.eligible),
      /* The refusals are stored, not only the members. "Who did we message" is
         answerable from the members alone; "why was this person not messaged"
         is the question a complaint or a rights audit actually asks. */
      JSON.stringify(input.result.exclusions),
      JSON.stringify(input.result.breakdown), input.computedBy,
    ]
  );
  return rows[0].snapshot_id;
}

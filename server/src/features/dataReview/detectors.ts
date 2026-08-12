import { degradingRead, type Reached } from '../../platform/sdkGateway/degradingRead';
import { config } from '../../config/env';
import { caseTypeByKey, CASE_TYPE_KEYS } from './caseTypes';
import {
  closeMissingCases,
  dedupeKeyOf,
  finishRun,
  openCase,
  startRun,
  type DetectedCase,
  type DetectorOutcome,
} from './caseStore';

/**
 * The eight governed case detectors.
 *
 * EACH ONE READS, DECIDES, AND WRITES NOTHING ITSELF. A detector returns
 * findings; the register decides whether each is new. That split is what makes
 * idempotence a property of the system rather than of eight separate authors
 * each remembering to check first.
 *
 * A DETECTOR THAT CANNOT LOOK REPORTS SO, and reports zero found ALONGSIDE
 * `sourceAvailable: false` rather than instead of it. "No problems" and "we
 * could not check" are different statements and the first is the single most
 * dangerous thing this file could say while blind — a Data Review screen showing
 * an empty queue during an outage tells every steward to go home.
 *
 * NOTHING IS CLOSED ON AN UNREADABLE SOURCE, for the same reason. A pass that
 * found nothing because it could not look would otherwise resolve every open
 * case of its type, silently, during exactly the incident where the queue
 * matters most.
 */

const TENANT = (): string => config.projexCloud.tenantId;

/** A finding plus the dedupe key the register will use. */
type Finding = DetectedCase;

/** What every detector implements. */
interface Detector {
  key: string;
  /** The domain events that should provoke it, for the subscriber (AC3). */
  events: string[];
  run: () => Promise<{ findings: Finding[]; available: boolean; note: string | null }>;
}

const ownerRoleFor = (key: string): string => caseTypeByKey(key)?.ownerRole ?? 'data_steward';

/** A source that could not be read, said the same way by every detector. */
const blind = (note: string) => ({ findings: [] as Finding[], available: false, note });

const asArray = <T>(body: unknown, ...keys: string[]): T[] => {
  const bag = (body ?? {}) as Record<string, unknown>;
  for (const key of keys) if (Array.isArray(bag[key])) return bag[key] as T[];
  const data = bag.data as Record<string, unknown> | undefined;
  if (data) for (const key of keys) if (Array.isArray(data[key])) return data[key] as T[];
  return [];
};

const read = <T>(sdk: string, path: string, ...keys: string[]): Promise<Reached<T[]>> =>
  degradingRead<T[]>(sdk, path, [], (body) => asArray<T>(body, ...keys));

/* ------------------------------------------------------------------ (1) */

/**
 * Candidate links the resolver would not make on its own.
 *
 * BELOW THE AUTO-LINK THRESHOLD IS THE WHOLE POPULATION. Anything at or above it
 * was linked without a human and is not a case; anything below it is a question
 * nobody has answered. Reading the threshold from the resolver rather than
 * hard-coding one keeps this queue aligned with the policy actually in force —
 * a tenant that tightens the threshold should see MORE cases here the next tick,
 * not the same ones.
 */
const possibleDuplicates: Detector = {
  key: 'possible_duplicates',
  events: ['identity.candidate_link.created.v1', 'capture.promoted.v1'],
  run: async () => {
    const links = await read<{
      link_id?: string;
      person_id_a?: string;
      person_id_b?: string;
      confidence?: number;
      status?: string;
    }>(
      'sdk-identity-resolver',
      '/api/empi/candidate-links?status=open&limit=500',
      'candidate_links'
    );
    if (!links.available) return blind('The identity resolver could not be reached.');

    const findings = links.value.map((link) => {
      const a = link.person_id_a ?? '';
      const b = link.person_id_b ?? '';
      const score = Number(link.confidence ?? 0);
      return {
        caseType: 'possible_duplicates',
        // SORTED inside dedupeKeyOf, so the same pair seen as (a,b) and later as
        // (b,a) is one case rather than two. For duplicate detection that is not
        // an edge case — it is half the inputs.
        dedupeKey: dedupeKeyOf([a, b]),
        risk: score >= 0.9 ? ('high' as const) : score >= 0.7 ? ('medium' as const) : ('low' as const),
        entityRef: a,
        entityLabel: `${a} / ${b}`,
        issue: 'Two records may describe the same person, and the resolver would not link them unaided.',
        evidence: [
          {
            kind: 'candidate_link',
            ref: link.link_id ?? '',
            detail: `Match confidence ${score.toFixed(2)}, below the auto-link threshold.`,
          },
        ],
        remediation: {
          action: 'identity.link.verify',
          description: 'Compare the evidence and either verify the link or keep the records separate.',
          reversible: true,
          reversal: 'A verified link is retracted with POST /api/leadflow/identity/links/:merge_id/retract, which emits a compensating event and replays projections. Neither source record is deleted.',
        },
        ownerRole: ownerRoleFor('possible_duplicates'),
      };
    });
    return { findings, available: true, note: null };
  },
};

/* ------------------------------------------------------------------ (2) */

/**
 * Two sources asserting different values for the same handle, both current.
 *
 * OVERLAPPING VALIDITY IS THE CONDITION, not mere disagreement. A phone number
 * that was right last year and is wrong now is not a conflict, it is history —
 * and raising a case for every superseded value would bury the queue in
 * resolved facts. What matters is two claims that both say they are true NOW.
 */
const contactPointConflicts: Detector = {
  key: 'contact_point_conflicts',
  events: ['capture.normalized.v1', 'enrichment.settled.v1'],
  run: async () => {
    const assertions = await read<{
      assertion_id?: string;
      subject_ref?: string;
      attribute?: string;
      value?: string;
      origin_class?: string;
      status?: string;
      effective_to?: string | null;
    }>(
      'sdk-source-record',
      `/api/source-assertions?tenant_id=${encodeURIComponent(TENANT())}&exclude_superseded=true&limit=500`,
      'assertions'
    );
    if (!assertions.available) return blind('The provenance store could not be reached.');

    // Grouped by (subject, attribute): a conflict is defined WITHIN one handle
    // type on one person, never across two.
    const groups = new Map<string, typeof assertions.value>();
    for (const row of assertions.value) {
      if (!row.subject_ref || !row.attribute) continue;
      // Still-current only. An assertion with a past effective_to has expired and
      // cannot conflict with anything.
      if (row.effective_to && Date.parse(row.effective_to) < Date.now()) continue;
      const key = `${row.subject_ref}::${row.attribute}`;
      const bag = groups.get(key) ?? [];
      bag.push(row);
      groups.set(key, bag);
    }

    const findings: Finding[] = [];
    for (const [key, rows] of groups) {
      const values = [...new Set(rows.map((r) => (r.value ?? '').trim()).filter(Boolean))];
      if (values.length < 2) continue;
      const [subjectRef, attribute] = key.split('::');
      findings.push({
        caseType: 'contact_point_conflicts',
        // The VALUES make the conflict, so they make the key. Two new sources
        // asserting the same two values is the same conflict; a third value
        // arriving is a different one and deserves a fresh look.
        dedupeKey: dedupeKeyOf([subjectRef, attribute, ...values]),
        risk: attribute === 'phone' || attribute === 'email' ? 'high' : 'medium',
        entityRef: subjectRef,
        entityLabel: `${attribute} on ${subjectRef}`,
        issue: `Two sources assert different ${attribute} values and both claim to be current.`,
        evidence: rows.slice(0, 6).map((row) => ({
          kind: 'source_assertion',
          ref: row.assertion_id ?? '',
          detail: `${row.origin_class ?? 'unknown origin'} asserts ${row.value ?? ''}.`,
        })),
        remediation: {
          action: 'source_record.supersede',
          description: 'Choose the value that is current and supersede the others.',
          reversible: true,
          reversal: 'Superseding retains the prior row rather than deleting it, so a wrong choice is corrected by superseding again and the whole chain stays readable.',
        },
        ownerRole: ownerRoleFor('contact_point_conflicts'),
      });
    }
    return { findings, available: true, note: null };
  },
};

/* ------------------------------------------------------------------ (3) */

/**
 * An attestation that is missing, expired, or does not cover the use.
 *
 * THREE CONDITIONS, ONE CASE TYPE, and the issue line says which. They are the
 * same conversation with the same owner — may we still use this data — and
 * splitting them into three tiles would triple the queue without changing a
 * single decision.
 */
const sourceRights: Detector = {
  key: 'source_rights',
  events: ['import.run.committed.v1'],
  run: async () => {
    const attestations = await read<{
      attestation_id?: string;
      source_ref?: string;
      expires_at?: string | null;
      permitted_uses?: string[];
      status?: string;
    }>(
      'sdk-source-record',
      `/api/source-rights/attestations?tenant_id=${encodeURIComponent(TENANT())}&limit=500`,
      'attestations'
    );
    if (!attestations.available) return blind('The rights register could not be reached.');

    const now = Date.now();
    const findings: Finding[] = [];
    for (const row of attestations.value) {
      const expired = row.expires_at ? Date.parse(row.expires_at) < now : false;
      const uses = Array.isArray(row.permitted_uses) ? row.permitted_uses : [];
      // `lead_management` is what this product actually does with imported
      // contacts; an attestation that does not name it does not cover us.
      const covers = uses.length === 0 ? false : uses.includes('lead_management');
      if (!expired && covers) continue;

      const problem = expired
        ? 'The rights attestation behind this source has expired.'
        : uses.length === 0
          ? 'No permitted uses are recorded against this source.'
          : 'The recorded permitted uses do not cover lead management.';

      findings.push({
        caseType: 'source_rights',
        dedupeKey: dedupeKeyOf([row.attestation_id ?? row.source_ref ?? '', expired ? 'expired' : 'uncovered']),
        risk: 'high',
        entityRef: row.source_ref ?? row.attestation_id ?? '',
        entityLabel: row.source_ref ?? null,
        issue: problem,
        evidence: [
          {
            kind: 'rights_attestation',
            ref: row.attestation_id ?? '',
            detail: `Expires ${row.expires_at ?? 'never stated'}; permitted uses: ${uses.join(', ') || 'none recorded'}.`,
          },
        ],
        remediation: {
          action: 'source_rights.reattest',
          description: 'Obtain a current attestation covering lead management, or stop processing records from this source.',
          reversible: false,
          reversal: null,
        },
        ownerRole: ownerRoleFor('source_rights'),
      });
    }
    return { findings, available: true, note: null };
  },
};

/* ------------------------------------------------------------------ (4) */

/** A receipt whose subject, purpose or validity cannot be determined. */
const consentAmbiguity: Detector = {
  key: 'consent_ambiguity',
  events: ['consent.receipt.issued.v1', 'consent.receipt.revoked.v1'],
  run: async () => {
    const receipts = await read<{
      receipt_id?: string;
      subject_ref?: string | null;
      purpose_id?: string | null;
      expires_at?: string | null;
      granted_at?: string | null;
      revoked_at?: string | null;
    }>(
      'sdk-consent',
      `/api/consents/receipts?tenant_id=${encodeURIComponent(TENANT())}&limit=500`,
      'receipts'
    );
    if (!receipts.available) return blind('The consent register could not be reached.');

    const findings: Finding[] = [];
    for (const row of receipts.value) {
      if (row.revoked_at) continue; // A withdrawn receipt is unambiguous.
      const noSubject = !row.subject_ref;
      const noPurpose = !row.purpose_id;
      // Indeterminate validity: no grant instant to measure from. An absent
      // EXPIRY is not ambiguous — many receipts are open-ended by design.
      const noValidity = !row.granted_at;
      if (!noSubject && !noPurpose && !noValidity) continue;

      const which = noSubject
        ? 'unresolved subject'
        : noPurpose
          ? 'unknown purpose'
          : 'indeterminate validity';

      findings.push({
        caseType: 'consent_ambiguity',
        dedupeKey: dedupeKeyOf([row.receipt_id ?? '', which]),
        risk: 'high',
        entityRef: row.subject_ref ?? row.receipt_id ?? '',
        entityLabel: row.receipt_id ?? null,
        issue: `A consent receipt has an ${which}, so what it permits cannot be determined.`,
        evidence: [
          {
            kind: 'consent_receipt',
            ref: row.receipt_id ?? '',
            detail: `subject=${row.subject_ref ?? 'none'}, purpose=${row.purpose_id ?? 'none'}, granted=${row.granted_at ?? 'none'}.`,
          },
        ],
        remediation: {
          action: 'consent.receipt.clarify',
          description: 'Resolve the subject and purpose, or treat the receipt as absent and stop relying on it.',
          reversible: true,
          reversal: 'Clarification issues a new receipt; the ambiguous one is revoked rather than edited, so the original record of what was collected survives.',
        },
        ownerRole: ownerRoleFor('consent_ambiguity'),
      });
    }
    return { findings, available: true, note: null };
  },
};

/* ------------------------------------------------------------------ (5) */

/** Owner, occupant and representative claims that cannot all be true. */
const relationshipConflicts: Detector = {
  key: 'relationship_conflicts',
  events: ['relationship.established.v1', 'relationship.ended.v1'],
  run: async () => {
    const relationships = await read<{
      relationship_id?: string;
      subject_ref?: string;
      object_ref?: string;
      role?: string;
      ended_at?: string | null;
    }>(
      'sdk-rebac',
      `/api/relationships?tenant_id=${encodeURIComponent(TENANT())}&limit=500`,
      'relationships'
    );
    if (!relationships.available) return blind('The relationship graph could not be reached.');

    // EXCLUSIVE ROLES ONLY. A property has one owner and one occupant at a time;
    // it can have any number of representatives, so a second representative is
    // not a conflict and raising one would be noise.
    const EXCLUSIVE = new Set(['owner', 'occupant']);
    const byPropertyRole = new Map<string, typeof relationships.value>();
    for (const row of relationships.value) {
      if (row.ended_at) continue;
      const role = (row.role ?? '').toLowerCase();
      if (!EXCLUSIVE.has(role) || !row.object_ref) continue;
      const key = `${row.object_ref}::${role}`;
      const bag = byPropertyRole.get(key) ?? [];
      bag.push(row);
      byPropertyRole.set(key, bag);
    }

    const findings: Finding[] = [];
    for (const [key, rows] of byPropertyRole) {
      const subjects = [...new Set(rows.map((r) => r.subject_ref ?? '').filter(Boolean))];
      if (subjects.length < 2) continue;
      const [objectRef, role] = key.split('::');
      findings.push({
        caseType: 'relationship_conflicts',
        dedupeKey: dedupeKeyOf([objectRef, role, ...subjects]),
        risk: 'medium',
        entityRef: objectRef,
        entityLabel: `${role} of ${objectRef}`,
        issue: `Two people are recorded as the current ${role} of the same property.`,
        evidence: rows.slice(0, 6).map((row) => ({
          kind: 'relationship',
          ref: row.relationship_id ?? '',
          detail: `${row.subject_ref ?? ''} is recorded as ${role}, with no end date.`,
        })),
        remediation: {
          action: 'relationship.end',
          description: 'End the relationship that is no longer current, dating it from when it actually ended.',
          reversible: true,
          reversal: 'Ending a relationship records an end date rather than deleting the row, so an end applied in error is corrected by clearing it.',
        },
        ownerRole: ownerRoleFor('relationship_conflicts'),
      });
    }
    return { findings, available: true, note: null };
  },
};

/* ------------------------------------------------------------------ (6) */

/**
 * An assertion older than its refresh policy.
 *
 * THE WINDOW DEPENDS ON WHAT THE FIELD IS. A mobile number goes stale far faster
 * than a date of birth, and one flat threshold would either flood the queue with
 * fields that do not move or miss the ones that do.
 */
const REFRESH_DAYS: Record<string, number> = {
  phone: 180,
  email: 365,
  address: 365,
  employer: 270,
  profile_url: 540,
};

const staleData: Detector = {
  key: 'stale_data',
  events: [],
  run: async () => {
    const assertions = await read<{
      assertion_id?: string;
      subject_ref?: string;
      attribute?: string;
      retrieved_at?: string | null;
      status?: string;
      origin_class?: string;
    }>(
      'sdk-source-record',
      `/api/source-assertions?tenant_id=${encodeURIComponent(TENANT())}&exclude_superseded=true&limit=500`,
      'assertions'
    );
    if (!assertions.available) return blind('The provenance store could not be reached.');

    const now = Date.now();
    const findings: Finding[] = [];
    for (const row of assertions.value) {
      const window = REFRESH_DAYS[row.attribute ?? ''];
      if (!window || !row.subject_ref) continue;
      // NO retrieved_at is NOT treated as stale. An assertion with no retrieval
      // timestamp has an unknown age, and reporting unknown as overdue would
      // fill the queue with rows nobody can act on.
      if (!row.retrieved_at) continue;
      const ageDays = (now - Date.parse(row.retrieved_at)) / 86_400_000;
      if (!Number.isFinite(ageDays) || ageDays <= window) continue;

      findings.push({
        caseType: 'stale_data',
        // The ATTRIBUTE and SUBJECT, not the age: a field that goes on ageing
        // must stay one case rather than opening a new one every sweep.
        dedupeKey: dedupeKeyOf([row.subject_ref, row.attribute ?? '']),
        risk: ageDays > window * 2 ? 'high' : 'low',
        entityRef: row.subject_ref,
        entityLabel: `${row.attribute} on ${row.subject_ref}`,
        issue: `This ${row.attribute} has gone ${Math.floor(ageDays)} days without confirmation, past its ${window}-day refresh window.`,
        evidence: [
          {
            kind: 'source_assertion',
            ref: row.assertion_id ?? '',
            detail: `Last retrieved ${row.retrieved_at}, origin ${row.origin_class ?? 'unknown'}.`,
          },
        ],
        remediation: {
          action: 'source_record.refresh',
          description: 'Confirm the value with the contact, or mark it no longer current.',
          reversible: true,
          reversal: 'A refresh writes a new assertion and supersedes the old one; nothing is deleted, so a mistaken refresh is itself superseded.',
        },
        ownerRole: ownerRoleFor('stale_data'),
      });
    }
    return { findings, available: true, note: null };
  },
};

/* ------------------------------------------------------------------ (7) */

/** The provider and the platform disagreeing about who may be contacted. */
const suppressionMismatch: Detector = {
  key: 'suppression_mismatch',
  events: ['suppression.applied.v1'],
  run: async () => {
    const mismatches = await read<{
      subject_ref?: string;
      channel?: string;
      provider_suppressed?: boolean;
      platform_suppressed?: boolean;
      observed_at?: string;
    }>(
      'sdk-deliverability',
      `/api/suppressions/reconciliation?tenant_id=${encodeURIComponent(TENANT())}`,
      'mismatches',
      'discrepancies'
    );
    if (!mismatches.available) return blind('The deliverability reconciliation could not be reached.');

    const findings: Finding[] = [];
    for (const row of mismatches.value) {
      if (row.provider_suppressed === row.platform_suppressed) continue;
      const subject = row.subject_ref ?? '';
      const channel = row.channel ?? 'unknown';
      // THE DANGEROUS DIRECTION IS HIGH RISK. Provider-suppressed but
      // platform-permitted means we believe we may contact somebody the provider
      // knows has opted out — that is a message about to be sent to a person who
      // said stop. The reverse merely means we are being over-cautious.
      const weMightSend = row.provider_suppressed === true && row.platform_suppressed !== true;
      findings.push({
        caseType: 'suppression_mismatch',
        dedupeKey: dedupeKeyOf([subject, channel]),
        risk: weMightSend ? 'high' : 'low',
        entityRef: subject,
        entityLabel: `${channel} for ${subject}`,
        issue: weMightSend
          ? `The provider has suppressed ${channel} for this person and the platform has not, so a send would reach somebody who opted out.`
          : `The platform has suppressed ${channel} for this person and the provider has not.`,
        evidence: [
          {
            kind: 'suppression_reconciliation',
            ref: `${subject}:${channel}`,
            detail: `provider=${row.provider_suppressed}, platform=${row.platform_suppressed}, observed ${row.observed_at ?? 'unknown'}.`,
          },
        ],
        remediation: {
          action: 'suppression.apply',
          description: 'Apply the suppression on whichever side is missing it. The stricter of the two always wins.',
          reversible: true,
          reversal: 'The suppression ledger is append-only, so a release is another entry and the record that they once opted out survives.',
        },
        ownerRole: ownerRoleFor('suppression_mismatch'),
      });
    }
    return { findings, available: true, note: null };
  },
};

/* ------------------------------------------------------------------ (8) */

/**
 * Enough first-party evidence to establish a direct relationship.
 *
 * THE ONLY DETECTOR THAT REPORTS AN OPPORTUNITY RATHER THAN A PROBLEM, and it
 * belongs here for the same reason the others do: it is a governed decision
 * about provenance that a human must take. Promoting to P4_DIRECT on the
 * strength of an automated count is exactly the shortcut the trust ladder
 * exists to prevent.
 */
const FIRST_PARTY = new Set([
  'USER_PROVIDED',
  'FIRST_PARTY_DIRECT',
  'TENANT_FIRST_PARTY_CRM',
  'USER_AUTHORIZED_CONTACT_STORE',
]);

const promotionEvidence: Detector = {
  key: 'promotion_evidence',
  events: ['capture.promoted.v1', 'consent.receipt.issued.v1'],
  run: async () => {
    const assertions = await read<{
      assertion_id?: string;
      subject_ref?: string;
      origin_class?: string;
      attribute?: string;
    }>(
      'sdk-source-record',
      `/api/source-assertions?tenant_id=${encodeURIComponent(TENANT())}&exclude_superseded=true&limit=500`,
      'assertions'
    );
    if (!assertions.available) return blind('The provenance store could not be reached.');

    const bySubject = new Map<string, typeof assertions.value>();
    for (const row of assertions.value) {
      if (!row.subject_ref || !FIRST_PARTY.has(row.origin_class ?? '')) continue;
      const bag = bySubject.get(row.subject_ref) ?? [];
      bag.push(row);
      bySubject.set(row.subject_ref, bag);
    }

    const findings: Finding[] = [];
    for (const [subject, rows] of bySubject) {
      // TWO DISTINCT ATTRIBUTES, not two assertions. The same email asserted
      // twice by the same form is one fact recorded twice, and treating it as
      // corroboration would promote a record on the strength of a duplicate.
      const attributes = [...new Set(rows.map((r) => r.attribute ?? '').filter(Boolean))];
      if (attributes.length < 2) continue;
      findings.push({
        caseType: 'promotion_evidence',
        dedupeKey: dedupeKeyOf([subject, ...attributes]),
        risk: 'low',
        entityRef: subject,
        entityLabel: subject,
        issue: 'First-party evidence now supports a direct relationship with this contact.',
        evidence: rows.slice(0, 6).map((row) => ({
          kind: 'source_assertion',
          ref: row.assertion_id ?? '',
          detail: `${row.origin_class} evidence for ${row.attribute}.`,
        })),
        remediation: {
          action: 'source_record.promote',
          description: 'Review the evidence and promote the record to a direct relationship, or leave it where it is.',
          reversible: true,
          reversal: 'A promotion is recorded as an event and can be retracted, which replays the projections built on it.',
        },
        ownerRole: ownerRoleFor('promotion_evidence'),
      });
    }
    return { findings, available: true, note: null };
  },
};

/* ------------------------------------------------------------------ runner */

export const DETECTORS: readonly Detector[] = [
  possibleDuplicates,
  contactPointConflicts,
  sourceRights,
  consentAmbiguity,
  relationshipConflicts,
  staleData,
  suppressionMismatch,
  promotionEvidence,
];

/** Which detectors a domain event should provoke (AC3). */
export function detectorsForEvent(eventType: string): string[] {
  return DETECTORS.filter((d) => d.events.includes(eventType)).map((d) => d.key);
}

/** Every detector key, for validation and for the event subscriber. */
export const DETECTOR_KEYS: readonly string[] = DETECTORS.map((d) => d.key);

/**
 * The eight keys must match the eight case types exactly.
 *
 * Asserted at MODULE LOAD rather than in a test, because the failure it catches
 * — a detector writing a case type the screen has no tile for — produces cases
 * that are invisible in the queue rather than an error anybody sees.
 */
if (DETECTOR_KEYS.length !== CASE_TYPE_KEYS.length) {
  throw new Error(
    `detector/case-type drift: ${DETECTOR_KEYS.length} detectors for ${CASE_TYPE_KEYS.length} case types`
  );
}

export interface SweepResult {
  runId: string;
  trigger: string;
  outcomes: DetectorOutcome[];
  totals: { found: number; opened: number; suppressed: number; resolved: number };
}

/**
 * Run one detector or all eight.
 *
 * THE SAME PATH FOR EVERY TRIGGER (AC3). The nightly sweep, the event subscriber
 * and an operator all arrive here, so a detector cannot behave differently
 * depending on what woke it — which is the bug that makes a scheduled job pass
 * every test and misbehave only in production.
 */
export async function runDetectors(
  trigger: 'schedule' | 'event' | 'manual',
  options: { detector?: string; triggerRef?: string | null } = {}
): Promise<SweepResult> {
  const selected = options.detector
    ? DETECTORS.filter((d) => d.key === options.detector)
    : DETECTORS;

  const runId = await startRun(options.detector ?? 'all', trigger, options.triggerRef ?? null);
  const outcomes: DetectorOutcome[] = [];
  const availability: Record<string, boolean> = {};
  let found = 0;
  let opened = 0;
  let suppressed = 0;
  let resolved = 0;

  for (const detector of selected) {
    const result = await detector.run();
    availability[detector.key] = result.available;

    let detectorOpened = 0;
    for (const finding of result.findings) {
      const inserted = await openCase(finding, runId);
      if (inserted) detectorOpened += 1;
    }

    /*
     * CLOSED ONLY WHEN THE SOURCE ANSWERED. A pass that could not look found
     * nothing for a reason that says nothing about the cases, and resolving them
     * on that basis would empty the queue during exactly the incident where it
     * matters most.
     */
    const detectorResolved = result.available
      ? await closeMissingCases(detector.key, result.findings.map((f) => f.dedupeKey), runId)
      : 0;

    const detectorSuppressed = result.findings.length - detectorOpened;
    outcomes.push({
      detector: detector.key,
      found: result.findings.length,
      opened: detectorOpened,
      suppressed: detectorSuppressed,
      sourceAvailable: result.available,
      note: result.note,
    });

    found += result.findings.length;
    opened += detectorOpened;
    suppressed += detectorSuppressed;
    resolved += detectorResolved;
  }

  const totals = { found, opened, suppressed, resolved };
  await finishRun(runId, totals, availability);
  return { runId, trigger, outcomes, totals };
}

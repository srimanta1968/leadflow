import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { governed, type GovernedRequest } from '../../platform/policy/governed';
import { PERMISSIONS } from '../../config/roles';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import { CAPABILITY_CATALOG, CAPABILITY_CAVEATS } from './capabilityCatalog';
import { createHash } from 'crypto';
import { config } from '../../config/env';
import { BUDGET_TIERS, requiresApproval, tierForRole } from './budgetTiers';
import { CATALOG_KEYS } from './capabilityCatalog';
import {
  evaluateEligibility,
  executeCapabilityRequest,
  requestApproval,
  reserveCapabilityRequest,
  listCapabilities,
  listCapabilityRequests,
  listLedgerEntries,
  readBalance,
  type CapabilityRequestRow,
  type CapabilityRow,
  type LedgerEntryRow,
} from './enrichmentGateway';

/**
 * The Enrichment Queue screen's read surface: one endpoint, one screen.
 *
 * READS ARE GOVERNED, not merely authenticated. The register says which contacts
 * somebody asked a paid question about and what the tenant was charged for it,
 * so opening it is a disclosure whether or not anything is spent, and who looked
 * belongs in the record.
 *
 * ONE CALL FOR THE WHOLE SCREEN. The four upstream reads are issued CONCURRENTLY
 * and degrade independently, so an unreachable credit account empties one tile
 * and leaves the register workable. Fanning out from the browser would put four
 * reads at four different instants behind one screen, and a headline that
 * disagrees with the rows beneath it reads as a bug in the rows.
 */
export const enrichmentRoutes: Router = Router();

enrichmentRoutes.use(authenticate);

/**
 * The register belongs to the tenant that paid for the lookups, not to whoever
 * requested one, so `own_record_only` is deferred rather than discharged — the
 * same reasoning the Import Center and the Identity Review queue state.
 */
const NOT_AN_OWNED_RECORD = {
  own_record_only: {
    kind: 'defer' as const,
    because:
      'a capability request belongs to the tenant whose credits paid for it, not to the persona who raised it',
  },
};

/** The four words this screen is allowed to say about a request. */
const PRESENTATION_STATUSES = ['awaiting', 'processing', 'complete', 'blocked'] as const;
export type PresentationStatus = (typeof PRESENTATION_STATUSES)[number];

/** How the register is narrowed and what a row offers. */
const POLICY_VERDICTS = ['approval', 'eligible', 'denied'] as const;
export type PolicyVerdict = (typeof POLICY_VERDICTS)[number];

/** How many register rows one page carries; upstream clamps to 500 itself. */
const REGISTER_LIMIT = 200;

/**
 * How far back to read the ledger for refusal reasons.
 *
 * Larger than the register because the ledger holds several entries per request
 * — a reservation, then a charge or a release — so the same window of work
 * occupies more rows there than here.
 */
const LEDGER_LIMIT = 600;

/**
 * sdk-data-credits' six states, collapsed onto the four the mockup shows.
 *
 * COLLAPSED HERE AND NOWHERE ELSE. Two screens each mapping six onto four is two
 * chances to disagree about what "Blocked" means, and the one that matters is
 * the one an operator acts on. The pairs that merge are the ones that mean the
 * same thing to somebody working the queue: APPROVED and EXECUTING are both
 * "under way, nothing for you to do", and REJECTED and FAILED are both "stopped,
 * and nobody was charged".
 */
const PRESENTATION_OF: Record<string, PresentationStatus> = {
  PENDING_APPROVAL: 'awaiting',
  APPROVED: 'processing',
  EXECUTING: 'processing',
  COMPLETED: 'complete',
  REJECTED: 'blocked',
  FAILED: 'blocked',
};

/**
 * The action a row offers, by presentation status.
 *
 * Verbatim from the mockup's register. Explain is the one that carries weight:
 * it is the only route to the reason a request was refused, which is why a
 * blocked row never offers Open instead.
 */
const ACTION_OF: Record<PresentationStatus, string> = {
  awaiting: 'Review',
  processing: 'Open',
  complete: 'Result',
  blocked: 'Explain',
};

/**
 * A number from upstream, whether it arrives as one or as a string.
 *
 * NUMERIC CROSSES JSON AS A STRING from Postgres, and credit_price and the
 * reservation columns are all NUMERIC upstream. sdk-data-credits casts them with
 * `Number(...)` before it sends, so today they arrive as numbers — but a
 * number-only guard here would turn a future `::text` projection into a silent
 * zero, and a zero on a price is the one wrong value nobody questions.
 *
 * Null still means NOT MEASURED rather than zero.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Whether an ISO timestamp falls on today's UTC day. */
function isToday(value: string | undefined, now: Date): boolean {
  if (!value) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

/** One row of the register, as the screen renders it. */
interface RegisterRow {
  request_id: string | null;
  created_at: string | null;
  /** Null until upstream projects it. See `field_gaps`. */
  contact: string | null;
  /**
   * The capabilities this request bought, as chips.
   *
   * An ARRAY for a surface that returns one key per request, because the mockup
   * renders chips and a bulk request is the obvious next feature. A caller
   * written against a bare string would need rewriting the day that lands; one
   * written against a one-element array would not.
   */
  capabilities: string[];
  /** Null until upstream projects it. See `field_gaps`. */
  purpose: string | null;
  /** Null until upstream projects it. See `field_gaps`. */
  requested_by: string | null;
  /** What the tenant was quoted. */
  estimate: number | null;
  /** What the tenant was actually billed. Zero for anything but a match. */
  credits_charged: number | null;
  policy_verdict: PolicyVerdict;
  status: PresentationStatus;
  /** The upstream state, kept so the drill-in never has to un-collapse the four. */
  upstream_status: string | null;
  outcome: string | null;
  served_from_cache: boolean;
  action: string;
  /**
   * Why a refusal happened, quoted from the ledger. Null on every row that was
   * not refused, and null on a refused row only when the ledger was unreachable
   * — which `upstream_available.ledger` distinguishes.
   */
  explain_reason: string | null;
}

/** A tile or a column the mockup asks for that has no upstream source. */
interface Gap {
  reason: string;
}

/**
 * The refusal reason for each request, indexed from the ledger.
 *
 * RELEASE IS THE ENTRY THAT CARRIES IT. A refusal gives the held credits back,
 * and `rejectRequest` writes the approver's reason onto that release — while
 * refusing a reason-less refusal outright, so the string is guaranteed present
 * for every rejected request rather than merely likely.
 */
function refusalReasons(entries: LedgerEntryRow[]): Map<string, string> {
  const byRequest = new Map<string, string>();
  for (const entry of entries) {
    if (entry.entry_type !== 'RELEASE') continue;
    const id = entry.request_id;
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (!id || reason === '') continue;
    // Last write wins: the ledger is append-only and ordered ascending, so the
    // most recent release for a request is the one that explains its state now.
    byRequest.set(id, reason);
  }
  return byRequest;
}

/** Projects one upstream request into the register's row shape. */
function toRegisterRow(row: CapabilityRequestRow, reasons: Map<string, string>): RegisterRow {
  const upstreamStatus =
    typeof row.status === 'string' && row.status.trim() !== '' ? row.status : null;

  /*
   * AN UNMAPPED STATE FALLS TO `awaiting`, WHICH IS THE SAFE DIRECTION.
   * PRESENTATION_OF covers all six states the broker declares, so landing here
   * means upstream grew a seventh. Putting it in front of a human is the error
   * that gets noticed; filing it as complete or processing is the error that
   * hides a request nobody is working, and one of those is recoverable.
   */
  const status: PresentationStatus = upstreamStatus
    ? PRESENTATION_OF[upstreamStatus] ?? 'awaiting'
    : 'awaiting';

  /*
   * THE VERDICT IS DERIVED FROM THE STATE, never stored twice. A request sits in
   * PENDING_APPROVAL precisely because the requester's role budget demanded a
   * second party, and it reaches REJECTED only by somebody refusing it — so the
   * state already IS the verdict, and a separate field would be a second copy
   * free to drift from the first.
   */
  const verdict: PolicyVerdict =
    upstreamStatus === 'REJECTED' ? 'denied' : upstreamStatus === 'PENDING_APPROVAL' ? 'approval' : 'eligible';

  const requestId = typeof row.request_id === 'string' ? row.request_id : null;

  return {
    request_id: requestId,
    created_at: typeof row.created_at === 'string' ? row.created_at : null,
    contact: row.metadata?.contact_label ?? row.subject_label ?? null,
    capabilities: typeof row.capability_key === 'string' ? [row.capability_key] : [],
    purpose: row.metadata?.purpose ?? null,
    requested_by: typeof row.requested_by_persona_id === 'string' ? row.requested_by_persona_id : null,
    estimate: asNumber(row.credits_reserved),
    credits_charged: asNumber(row.credits_charged),
    policy_verdict: verdict,
    status,
    upstream_status: upstreamStatus,
    outcome: typeof row.outcome === 'string' ? row.outcome : null,
    served_from_cache: row.served_from_cache === true,
    action: ACTION_OF[status],
    /* AC2 — the reason, quoted rather than composed, and only where there is one. */
    explain_reason: verdict === 'denied' && requestId ? reasons.get(requestId) ?? null : null,
  };
}

/**
 * The catalog: the four named cards, priced from upstream where offered.
 *
 * MERGED RATHER THAN REPLACED. Upstream is authoritative for the outcome label
 * and the price, because a tenant can hold a negotiated price and a local
 * constant would misquote them. The four keys are ours, because the screen shows
 * the same grid whether or not this tenant is entitled to all of it.
 */
function composeCatalog(rows: CapabilityRow[]): {
  key: string;
  outcome_label: string;
  description: string | null;
  credit_price: number | null;
  category: string | null;
  offered: boolean;
  caveats: readonly string[];
}[] {
  const upstream = new Map<string, CapabilityRow>();
  for (const row of rows) {
    if (typeof row.key === 'string') upstream.set(row.key, row);
  }

  return CAPABILITY_CATALOG.map((copy) => {
    const found = upstream.get(copy.key);
    return {
      key: copy.key,
      outcome_label:
        typeof found?.outcome_label === 'string' && found.outcome_label.trim() !== ''
          ? found.outcome_label
          : copy.fallbackOutcome,
      /* Upstream prose wins where it exists; ours is the readable fallback. */
      description:
        typeof found?.description === 'string' && found.description.trim() !== ''
          ? found.description
          : copy.description,
      /*
       * NULL, NEVER ZERO, when the tenant has no entitlement. A price of 0 reads
       * as "free", which is the single most expensive thing this card could get
       * wrong.
       */
      credit_price: found ? asNumber(found.credit_price) : null,
      category: found?.category ?? null,
      offered: Boolean(found),
      /* AC4 — outcome, price and the two governance caveats. No implementation. */
      caveats: CAPABILITY_CAVEATS,
    };
  });
}

/**
 * GET /api/leadflow/enrichment/queue — the tiles, the register and the catalog.
 *
 * NO VENDOR IS NAMEABLE THROUGH THIS RESPONSE (AC1). Every field is written out
 * by hand rather than spread from an upstream row, so a column added to
 * `provider_binding` cannot arrive here by default — the same discipline
 * sdk-data-credits applies on its own side, applied again on ours. The one tile
 * the mockup asks for that WOULD have leaked provider behaviour is returned as a
 * named gap instead; see `metric_gaps`.
 */
enrichmentRoutes.get(
  '/queue',
  asyncHandler(governed(
    {
      action: PERMISSIONS.DATA_CONFIGURE,
      event: AUDIT_EVENTS.ENRICHMENT_QUEUE_INSPECTED,
      purpose: 'lead_management',
      resourceType: 'enrichment_queue',
      metadata: (req) => ({
        surface: 'enrichment_queue',
        status: (req.query?.status as string) ?? 'all',
      }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const requested = req.query?.status;
      const filter = typeof requested === 'string' && requested.length > 0 ? requested : undefined;

      /*
       * REJECTED, NOT IGNORED. Silently dropping an unrecognised filter would
       * return the WHOLE register to somebody who asked for one segment, and a
       * screen headed "Awaiting approval" listing settled work would be worked
       * as though those requests still needed a decision.
       */
      if (filter !== undefined && !PRESENTATION_STATUSES.includes(filter as PresentationStatus)) {
        throw new AppError(
          400,
          ErrorCodes.VALIDATION_ERROR,
          `status must be one of ${PRESENTATION_STATUSES.join(', ')}`
        );
      }

      const [capabilities, requests, balance, ledger] = await Promise.all([
        listCapabilities(),
        listCapabilityRequests(REGISTER_LIMIT),
        readBalance(),
        listLedgerEntries(LEDGER_LIMIT),
      ]);

      const reasons = refusalReasons(ledger.value);
      const all = requests.value.map((row) => toRegisterRow(row, reasons));
      const rows = filter ? all.filter((row) => row.status === filter) : all;

      const now = new Date();

      /*
       * THE TILES COUNT THE WHOLE WINDOW, NOT THE FILTERED SLICE. A rail that
       * moved with the segmented filter would make "Awaiting Approval: 4" mean
       * something different on every tab, and the tile an operator clicks to
       * narrow the table must not change the number they clicked.
       */
      const awaiting = all.filter((row) => row.status === 'awaiting');
      const processing = all.filter((row) => row.status === 'processing');
      const completedToday = all.filter(
        (row) => row.status === 'complete' && isToday(row.created_at ?? undefined, now)
      );
      const noMatch = all.filter((row) => row.outcome === 'NO_MATCH');

      /*
       * CACHE REUSE IS MEASURED OVER SETTLED WORK (AC3), not over everything.
       * A request still awaiting approval has not been served from anywhere yet,
       * and counting it as a cache miss would drag the rate down every time the
       * queue got busier — a figure that falls because more work arrived is
       * measuring arrival, not reuse.
       */
      const settled = all.filter((row) => row.status === 'complete' || row.status === 'blocked');
      const fromCache = settled.filter((row) => row.served_from_cache);
      const creditsSaved = fromCache.reduce(
        (total, row) => total + Math.max(0, (row.estimate ?? 0) - (row.credits_charged ?? 0)),
        0
      );
      const heldForApproval = awaiting.reduce((total, row) => total + (row.estimate ?? 0), 0);

      /*
       * NULL RATHER THAN ZERO WHEN THE REGISTER WAS UNREACHABLE. "We saved you
       * nothing" and "we could not find out" are different statements, and a
       * cache-reuse tile reading 0% during an outage is the one that sends
       * somebody to investigate a saving that never stopped happening.
       */
      const registerRead = requests.available;

      res.status(200).json({
        success: true,
        data: {
          kpis: {
            awaiting_approval: {
              count: registerRead ? awaiting.length : null,
              estimated_credits: registerRead ? heldForApproval : null,
            },
            processing: {
              count: registerRead ? processing.length : null,
              /*
               * THE ONE TILE THAT CANNOT BE SOURCED (AC1). The mockup asks for a
               * provider-fallback count, and the only place that exists is
               * data_credits.provider_attempt — a table keyed by provider, which
               * no tenant-facing route projects and none should. A count of how
               * often we failed over describes the shape of the provider chain
               * even without printing a brand, so this is a gap by DESIGN rather
               * than an omission, and it is named instead of being approximated
               * from TECHNICAL_FAILURE outcomes, which count something else.
               */
              provider_fallbacks: null,
            },
            completed_today: {
              count: registerRead ? completedToday.length : null,
              matched: registerRead
                ? completedToday.filter((row) => row.outcome === 'MATCHED').length
                : null,
            },
            no_match: {
              count: registerRead ? noMatch.length : null,
              /* Stated, not implied: only a MATCHED settlement is ever charged. */
              policy: 'No-charge policy applied',
            },
            cache_reuse: {
              /* AC3 — computed from the rows returned, never from a counter. */
              rate:
                registerRead && settled.length > 0 ? fromCache.length / settled.length : null,
              credits_saved: registerRead ? creditsSaved : null,
              settled_count: registerRead ? settled.length : null,
            },
            budget_remaining: {
              available: asNumber(balance.value?.available),
              reserved: asNumber(balance.value?.reserved),
              balance: asNumber(balance.value?.balance),
            },
          },
          /* Named so a null is never read as a zero. */
          metric_gaps: [
            {
              metric: 'provider_fallbacks',
              reason:
                'Provider fallbacks are recorded per provider inside the broker and are never projected to a tenant. Publishing the count would describe the provider chain, which this screen exists not to do.',
            } satisfies Gap & { metric: string },
          ],
          /*
           * THREE COLUMNS WITH NO UPSTREAM SOURCE, NAMED RATHER THAN BLANK. An
           * unexplained empty column reads as a bug in the row; a named gap
           * reads as a thing somebody is waiting on.
           */
          field_gaps: [
            {
              field: 'contact',
              reason:
                'The broker stores only a fingerprint of the subject, never the subject itself, and does not project even that. Populated once a request carries a contact label in its metadata.',
            },
            {
              field: 'purpose',
              reason:
                'Accepted on the request as metadata but not returned by the list projection. Raised as a handoff.',
            },
            {
              field: 'requested_by',
              reason:
                'requested_by_persona_id is accepted on the request but not returned by the list projection. Raised as a handoff.',
            },
          ],
          requests: rows,
          request_count: rows.length,
          /* Counted over the WHOLE window, matching the segmented filter. */
          status_counts: PRESENTATION_STATUSES.reduce<Record<string, number>>((counts, key) => {
            counts[key] = all.filter((row) => row.status === key).length;
            return counts;
          }, {}),
          /* AC4 — outcome and price, with the caveats, and no implementation. */
          capabilities: composeCatalog(capabilities.value),
          status: filter ?? null,
          upstream_available: {
            capabilities: capabilities.available,
            requests: requests.available,
            balance: balance.available,
            ledger: ledger.available,
          },
        },
      });
    }
  ))
);

/*
 * ---------------------------------------------------------------------------
 * The Contact Enrichment modal's write surface, and the Data Credits drawer.
 */

/** The business reasons the modal offers, in the mockup's order and wording. */
const BUSINESS_REASONS: readonly string[] = [
  'Inspection lead follow-up',
  'Existing customer service',
  'Commercial account qualification',
  'Data quality remediation',
];

/** Sum the catalog prices for a selection, using upstream prices when reachable. */
function estimateCredits(
  keys: string[],
  upstream: CapabilityRow[] | null,
): number {
  return keys.reduce((total, key) => {
    const priced = upstream?.find((c) => c.key === key);
    // FALLS BACK TO THE CATALOG PRICE, not to zero. A missing upstream price
    // showing an estimate of 0 would tell the operator the run is free.
    return total + (typeof priced?.credit_price === 'number' ? priced.credit_price : CATALOG_PRICE[key] ?? 1);
  }, 0);
}

/** The mockup's per-capability prices, used when upstream cannot be reached. */
const CATALOG_PRICE: Record<string, number> = {
  validate_phone: 1,
  validate_email: 1,
  find_contact_points: 2,
  find_possible_profiles: 1,
};

function readSelection(body: Record<string, unknown>): {
  capabilityKeys: string[];
  purpose: string;
  subjectRef: string;
} {
  const raw = body.capability_keys;
  const capabilityKeys = Array.isArray(raw) ? raw.map(String) : [];
  if (capabilityKeys.length === 0) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'capability_keys must name at least one capability');
  }
  const unknown = capabilityKeys.filter((k) => !CATALOG_KEYS.includes(k));
  if (unknown.length > 0) {
    /*
     * REJECTED, NOT IGNORED. Dropping an unrecognised capability would quote an
     * estimate for a smaller run than the operator asked for, and then reserve
     * against that quote.
     */
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `unknown capability: ${unknown.join(', ')}. Known: ${CATALOG_KEYS.join(', ')}`,
    );
  }
  const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : '';
  if (!BUSINESS_REASONS.includes(purpose)) {
    /*
     * A PURPOSE IS NOT FREE TEXT HERE. It is the basis on which the tenant is
     * about to spend money on somebody's personal data, and 'Purpose &
     * Governance' is the panel that records it. An arbitrary string would make
     * the policy verdict unanswerable and the ledger unauditable.
     */
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `purpose must be one of: ${BUSINESS_REASONS.join(', ')}`,
    );
  }
  const subjectRef = typeof body.subject_ref === 'string' ? body.subject_ref.trim() : '';
  if (!subjectRef) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
  }
  return { capabilityKeys, purpose, subjectRef };
}

/**
 * POST /api/leadflow/enrichment/eligibility — the LIVE policy verdict (AC1).
 *
 * A SEPARATE, NON-SPENDING ENDPOINT, and that is the whole point. The modal
 * re-asks this every time the operator ticks a capability or changes the
 * business reason, because the verdict genuinely depends on both: 'Find
 * additional contact points' under 'Data quality remediation' is a different
 * question from the same capability under 'Commercial account qualification'.
 * Deriving the callout from the reservation endpoint would mean holding the
 * tenant's credits to find out whether they are allowed to hold them.
 *
 * 200 even for a refusal. The question was answered; 'no' is a successful
 * answer to 'may I?', and a 403 would make a correct refusal look like the
 * caller lacked permission to ask.
 *
 * DEGRADES TO `review`, NEVER TO `allow`. An unreachable policy service means
 * we could not ask, and treating that as permission is how the tenant spends
 * money on a lookup a policy would have refused.
 */
enrichmentRoutes.post(
  '/eligibility',
  asyncHandler(governed(
    {
      action: PERMISSIONS.DATA_CONFIGURE,
      event: AUDIT_EVENTS.ENRICHMENT_QUEUE_INSPECTED,
      purpose: 'lead_management',
      resourceType: 'enrichment_request',
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const { capabilityKeys, purpose, subjectRef } = readSelection(
        (req.body ?? {}) as Record<string, unknown>,
      );
      const role = req.session?.role ?? null;
      const tier = tierForRole(role);

      const upstream = await listCapabilities();
      const estimated = estimateCredits(capabilityKeys, upstream.available ? upstream.value : null);
      const approval = requiresApproval(tier, estimated);

      const verdict = await evaluateEligibility({
        capabilityKeys,
        purposeKey: purpose,
        roleRef: tier.localRole ?? tier.label,
        subjectRef,
      });

      const effect = verdict.available ? verdict.value?.effect ?? 'allow' : 'review';
      const eligible = effect === 'allow' && !approval.required;

      res.status(200).json({
        success: true,
        data: {
          eligible,
          /*
           * THREE STATES, NOT TWO. `allow` and `deny` are the policy's answers;
           * `review` is ours for 'the policy could not be reached' and for a
           * tier that needs a human. Collapsing review into deny would tell an
           * operator they are forbidden when they are merely waiting.
           */
          verdict: approval.required ? 'review' : effect,
          headline: approval.required
            ? 'Eligible with approval'
            : effect === 'allow'
              ? 'Eligible'
              : effect === 'deny'
                ? 'Not eligible'
                : 'Needs review',
          reason: approval.because
            ?? verdict.value?.reason
            ?? (verdict.available
              ? 'Property and direct relationship are established.'
              : 'The policy service could not be reached, so this needs a person to approve it.'),
          estimated_credits: estimated,
          requires_approval: approval.required,
          budget_tier: tier.label,
          policy_reached: verdict.available,
        },
      });
    },
  )),
);

/**
 * POST /api/leadflow/enrichment/requests — Reserve & Run (AC2).
 *
 * RESERVE FIRST, EXECUTE SECOND, and never execute what a tier may not spend.
 * When the requester's tier is request-only, or the estimate exceeds its
 * bulk-approval threshold, this holds the credits and raises an approval
 * INSTEAD of running the providers, and answers with `status: awaiting_approval`
 * so the modal can say so. The upstream broker enforces the same rule with a 409
 * on execute; blocking here as well is deliberate belt-and-braces, because the
 * failure this prevents is spending somebody else's money.
 *
 * 201: a request is a new record, whether or not it ran.
 */
enrichmentRoutes.post(
  '/requests',
  asyncHandler(governed(
    {
      action: PERMISSIONS.DATA_CONFIGURE,
      event: AUDIT_EVENTS.ENRICHMENT_REQUESTED,
      purpose: 'lead_management',
      resourceType: 'enrichment_request',
      metadata: (req) => ({
        capabilities: Array.isArray((req.body as Record<string, unknown>)?.capability_keys)
          ? ((req.body as { capability_keys: unknown[] }).capability_keys).length
          : 0,
        purpose: String((req.body as Record<string, unknown>)?.purpose ?? ''),
      }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const { capabilityKeys, purpose, subjectRef } = readSelection(body);

      const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
      const role = req.session?.role ?? null;
      const tier = tierForRole(role);

      const upstream = await listCapabilities();
      const estimated = estimateCredits(capabilityKeys, upstream.available ? upstream.value : null);
      const approval = requiresApproval(tier, estimated);

      /*
       * THE FINGERPRINT, NEVER THE RAW SUBJECT. Upstream keeps only a
       * fingerprint precisely so a register of everybody every tenant ever
       * looked up cannot accumulate there; sending the raw value would defeat
       * that from our side. Hashed here so the same contact fingerprints the
       * same way across requests, which is what makes the cache hit at all.
       */
      const subjectFingerprint = createHash('sha256')
        .update(`${config.projexCloud.tenantId}:${subjectRef}`)
        .digest('hex');

      const reservations: Record<string, unknown>[] = [];
      let anyReserved = false;
      for (const key of capabilityKeys) {
        const held = await reserveCapabilityRequest({
          capabilityKey: key,
          subjectFingerprint,
          roleRef: tier.localRole ?? tier.label,
          requestedByPersonaId: req.session?.userId ?? undefined,
          metadata: { purpose, notes, requested_via: 'enrichment_modal' },
        });
        if (held.available) anyReserved = true;
        reservations.push({
          capability_key: key,
          request_id: held.value?.request_id ?? null,
          estimated_credits: held.value?.estimated_credits ?? CATALOG_PRICE[key] ?? null,
          reserved: held.available,
        });
      }

      if (approval.required) {
        const raised = await requestApproval({
          requestId: String(reservations[0]?.request_id ?? subjectFingerprint),
          roleRef: tier.localRole ?? tier.label,
          reason: approval.because ?? 'approval required',
          estimatedCredits: estimated,
        });
        res.status(201).json({
          success: true,
          data: {
            status: 'awaiting_approval',
            /* NOTHING RAN. Stated plainly so the modal cannot imply results. */
            executed: false,
            blocked_reason: approval.because,
            approval_ref: raised.value?.approval_id ?? null,
            approval_raised: raised.available,
            estimated_credits: estimated,
            budget_tier: tier.label,
            reservations,
            purpose,
          },
        });
        return;
      }

      const executions: Record<string, unknown>[] = [];
      for (const reservation of reservations) {
        const requestId = reservation.request_id;
        if (typeof requestId !== 'string') {
          executions.push({ capability_key: reservation.capability_key, executed: false });
          continue;
        }
        const ran = await executeCapabilityRequest(requestId, { subject_ref: subjectRef });
        executions.push({
          capability_key: reservation.capability_key,
          request_id: requestId,
          executed: ran.available,
          outcome: (ran.value as { outcome?: string } | null)?.outcome ?? null,
        });
      }

      res.status(201).json({
        success: true,
        data: {
          status: anyReserved ? 'reserved' : 'not_reserved',
          executed: executions.some((e) => e.executed === true),
          estimated_credits: estimated,
          budget_tier: tier.label,
          reservations,
          executions,
          purpose,
          note: 'Technical failures and recent cache hits are not double-charged.',
        },
      });
    },
  )),
);

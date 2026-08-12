import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { actionableSurfaces } from '../../config/erasureSurfaces';
import {
  assertTraceLayers,
  mirrorSavedQuery,
  readTrace,
  runEvidenceSearch,
  verifyChainRange,
} from './auditGateway';

/**
 * The Advanced Query surface behind the Audit & History screen.
 *
 * READS ARE OPEN, and that is a decision rather than an oversight. The
 * navigation model states it: `audit.delete_event` is the only gated audit
 * capability, and gating READS would defeat the point of an audit trail. So
 * these routes are `authenticate`-only and tenant-scoped by the composer.
 *
 * EVERY RESULT CARRIES A CHAIN VERDICT. An auditor reading a filtered list of
 * governed actions is reasoning about what happened; if the tamper-evident chain
 * is broken across that window then every row is unsafe to reason over, and that
 * is not an optional field a caller can forget to read.
 */
export const auditRoutes: Router = Router();

auditRoutes.use(authenticate);

/** The three outcomes a policy decision can have been recorded with. */
const DECISION_OUTCOMES = ['permitted', 'denied', 'approval_required'] as const;

/** Who else may run a saved query. */
const VISIBILITIES = ['private', 'role', 'tenant'] as const;
type Visibility = (typeof VISIBILITIES)[number];

/** How many rows one page of evidence carries. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** The filters the query builder can express. */
interface EvidenceFilters {
  actor?: string;
  persona_role?: string;
  purpose?: string;
  decision_outcome?: string;
  policy_version?: string;
  consent_epoch?: string;
  entity_ref?: string;
  case_id?: string;
  import_run_id?: string;
  trace_id?: string;
  from?: string;
  to?: string;
}

/** The caller's persona, which owns anything they save. */
const personaOf = (req: AuthenticatedRequest): string => req.session?.userId ?? 'unknown';

/**
 * Translate the LeadFlow filter shape into the search DSL.
 *
 * KEPT SEPARATE FROM THE STORED FILTER. `leadflow_audit_saved_query` persists
 * the FILTER, not the DSL, precisely so that a change in how we talk to
 * sdk-search does not strand every saved query somebody wrote last quarter.
 * This function is that translation, and it is the only place it happens.
 */
function toSearchDsl(filters: EvidenceFilters): Record<string, unknown> {
  const must: Record<string, unknown>[] = [];
  const term = (field: string, value: string | undefined): void => {
    if (value && value.trim() !== '') must.push({ term: { [field]: value.trim() } });
  };

  term('actor', filters.actor);
  term('persona_role', filters.persona_role);
  term('purpose', filters.purpose);
  term('outcome', filters.decision_outcome);
  term('policy_version', filters.policy_version);
  term('consent_epoch', filters.consent_epoch);
  term('entity_ref', filters.entity_ref);
  term('case_id', filters.case_id);
  term('import_run_id', filters.import_run_id);
  term('trace_id', filters.trace_id);

  if (filters.from || filters.to) {
    const range: Record<string, string> = {};
    if (filters.from) range.gte = filters.from;
    if (filters.to) range.lte = filters.to;
    must.push({ range: { occurred_at: range } });
  }

  return { query: { bool: { must } } };
}

/** Reads the filter block from a request body, wherever the caller put it. */
function readFilters(body: Record<string, unknown>): EvidenceFilters {
  const nested = (body.filters ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const value = body[key] ?? nested[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };
  return {
    actor: pick('actor'),
    persona_role: pick('persona_role'),
    purpose: pick('purpose'),
    decision_outcome: pick('decision_outcome'),
    policy_version: pick('policy_version'),
    consent_epoch: pick('consent_epoch'),
    entity_ref: pick('entity_ref'),
    case_id: pick('case_id'),
    import_run_id: pick('import_run_id'),
    trace_id: pick('trace_id'),
    from: pick('from'),
    to: pick('to'),
  };
}

/**
 * POST /api/leadflow/audit/query — filtered evidence, with a chain verdict.
 *
 * THREE UPSTREAMS, READ CONCURRENTLY AND DEGRADING SEPARATELY. A search that
 * cannot run must not stop the response reporting that the chain is broken,
 * which is the more urgent of the two facts.
 */
auditRoutes.post(
  '/query',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const filters = readFilters(body);

    /*
     * REJECTED, NOT IGNORED. Dropping an unrecognised outcome would return EVERY
     * governed action to somebody who asked for the refusals, and an auditor
     * reading that list as "these were denied" draws exactly the wrong
     * conclusion from it.
     */
    if (
      filters.decision_outcome !== undefined &&
      !DECISION_OUTCOMES.includes(filters.decision_outcome as (typeof DECISION_OUTCOMES)[number])
    ) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `decision_outcome must be one of ${DECISION_OUTCOMES.join(', ')}`
      );
    }

    /*
     * An inverted range is refused rather than silently swapped: swapping would
     * answer a different question from the one asked, and the chain verdict
     * below would then describe a window the caller never named.
     */
    if (filters.from && filters.to && Date.parse(filters.to) < Date.parse(filters.from)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'to must be at or after from');
    }

    const requestedLimit = Number(body.limit ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(1, Math.trunc(requestedLimit)), MAX_LIMIT)
      : DEFAULT_LIMIT;

    const fromSeq = typeof body.from_seq === 'number' ? body.from_seq : undefined;
    const toSeq = typeof body.to_seq === 'number' ? body.to_seq : undefined;

    const [search, chain, trace] = await Promise.all([
      runEvidenceSearch({ dsl: toSearchDsl(filters), limit }),
      verifyChainRange(fromSeq, toSeq),
      filters.trace_id ? readTrace(filters.trace_id) : Promise.resolve(null),
    ]);

    /* AC3 — a trace id asks "what else happened as part of this", so the layer
       assertion runs alongside the timeline rather than instead of it. */
    const layers = filters.trace_id
      ? await assertTraceLayers(filters.trace_id, ['api', 'service', 'sdk'])
      : null;

    res.status(200).json({
      success: true,
      data: {
        query_ref: `${personaOf(req)}:${Date.now()}`,
        filters,
        results: search.value.hits,
        result_count: search.value.hits.length,
        total: search.value.total,
        /*
         * AC1 — REQUIRED ON EVERY RESPONSE, never optional. `state` is one of
         * verified / broken / unknown, because a broken chain and an unreachable
         * verifier are opposite instructions to the reader: stop trusting these
         * rows, versus try again later.
         */
        chain: {
          state: chain.state,
          verified: chain.state === 'verified',
          entries_checked: chain.entriesChecked,
          break_at_seq: chain.breakAtSeq,
          break_reason: chain.breakReason,
          detail: chain.detail,
          range: { from_seq: fromSeq ?? null, to_seq: toSeq ?? null },
        },
        /* AC3 — the cross-service causation chain, when one was asked for. */
        trace: filters.trace_id
          ? {
              trace_id: filters.trace_id,
              spans: trace?.value ?? [],
              span_count: trace?.value.length ?? 0,
              available: trace?.available ?? false,
              layers: layers?.value ?? null,
              layers_available: layers?.available ?? false,
            }
          : null,
        upstream_available: {
          search: search.available,
          audit: chain.state !== 'unknown',
          trace: filters.trace_id ? (trace?.available ?? false) : null,
        },
      },
    });
  })
);

/** One saved query as the register stores it. */
interface SavedQueryRow {
  query_id: string;
  name: string;
  filters: EvidenceFilters;
  visibility: Visibility;
  owner_persona_id: string;
  owner_role: string | null;
  upstream_query_id: string | null;
  created_at: string;
}

/**
 * POST /api/leadflow/audit/saved-queries — save a query and say who may run it.
 *
 * THE LOCAL ROW IS THE SOURCE OF TRUTH FOR VISIBILITY, because sdk-search has no
 * concept of it — it stores a query against one persona and can answer "mine"
 * and nothing else. The owner's copy is mirrored upstream so the platform store
 * stays populated, and whether that mirror landed is REPORTED rather than
 * assumed.
 */
auditRoutes.post(
  '/saved-queries',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const visibility = (typeof body.visibility === 'string' ? body.visibility : 'private') as Visibility;
    const filters = readFilters(body);

    if (name === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'name is required');
    }

    /*
     * Refused rather than defaulted to private. Private is the safe direction
     * for DISCLOSURE but the wrong one for INTENT: somebody who meant to share
     * with their team would believe they had, and nobody would ever see it.
     */
    if (!VISIBILITIES.includes(visibility)) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `visibility must be one of ${VISIBILITIES.join(', ')}`
      );
    }

    const persona = personaOf(req);
    const role = req.session?.role ?? null;

    const rows = await dataService.query<SavedQueryRow>(
      `INSERT INTO leadflow_audit_saved_query
         (tenant_id, owner_persona_id, owner_role, name, filters, visibility)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (tenant_id, owner_persona_id, lower(name))
       DO UPDATE SET filters = EXCLUDED.filters,
                     visibility = EXCLUDED.visibility,
                     owner_role = EXCLUDED.owner_role,
                     updated_at = now()
       RETURNING query_id, name, filters, visibility, owner_persona_id, owner_role,
                 upstream_query_id, created_at`,
      [config.projexCloud.tenantId, persona, role, name, JSON.stringify(filters), visibility]
    );
    const saved = rows[0];

    // Best effort, and reported. Two stores silently disagreeing about what
    // exists is worse than one admitting it is behind.
    const mirrored = await mirrorSavedQuery({
      personaId: persona,
      name,
      dsl: toSearchDsl(filters),
    });
    if (mirrored.available && mirrored.value?.query_id) {
      await dataService.query(
        `UPDATE leadflow_audit_saved_query SET upstream_query_id = $2 WHERE query_id = $1`,
        [saved.query_id, mirrored.value.query_id]
      );
    }

    res.status(201).json({
      success: true,
      data: {
        query_id: saved.query_id,
        name: saved.name,
        filters: saved.filters,
        /* AC2 — who else may RUN it. Never who else may see its results: a
           shared query re-executes under the caller's own scopes. */
        visibility: saved.visibility,
        owner_role: saved.owner_role,
        mirrored_upstream: mirrored.available && Boolean(mirrored.value?.query_id),
        shareable_note:
          'A saved query is a filter, never a result set. Running it re-executes the search under the caller own scopes, so sharing never widens what anybody can see.',
      },
    });
  })
);

/**
 * GET /api/leadflow/audit/saved-queries — the queries this caller may run.
 *
 * SCOPED IN THE QUERY, NOT AFTER IT. A row the caller may not run is never
 * loaded and never serialised. Fetching everything and filtering in the handler
 * is the shape that leaks: one early return, one refactor, and rows nobody was
 * entitled to see are already in the response object.
 */
auditRoutes.get(
  '/saved-queries',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const requested = req.query?.visibility;
    const filter = typeof requested === 'string' && requested !== '' ? requested : undefined;

    if (filter !== undefined && !VISIBILITIES.includes(filter as Visibility)) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `visibility must be one of ${VISIBILITIES.join(', ')}`
      );
    }

    const persona = personaOf(req);
    const role = req.session?.role ?? null;

    const rows = await dataService.query<SavedQueryRow & { visible_because: string }>(
      `SELECT query_id, name, filters, visibility, owner_persona_id, owner_role,
              upstream_query_id, created_at,
              CASE
                WHEN owner_persona_id = $2 THEN 'owner'
                WHEN visibility = 'tenant'  THEN 'tenant'
                ELSE 'role'
              END AS visible_because
         FROM leadflow_audit_saved_query
        WHERE tenant_id = $1
          AND (
                owner_persona_id = $2
             OR visibility = 'tenant'
             OR (visibility = 'role' AND owner_role IS NOT DISTINCT FROM $3)
          )
          AND ($4::text IS NULL OR visibility = $4)
        ORDER BY created_at DESC
        LIMIT 200`,
      [config.projexCloud.tenantId, persona, role, filter ?? null]
    );

    res.status(200).json({
      success: true,
      data: {
        queries: rows.map((row) => ({
          query_id: row.query_id,
          name: row.name,
          filters: row.filters,
          visibility: row.visibility,
          /* Not decoration: an auditor should know whether they are about to run
             their own work or somebody else's, because the two carry different
             assumptions about what the filters were built to prove. */
          visible_because: row.visible_because,
          owner_role: row.owner_role,
          is_owner: row.owner_persona_id === persona,
          mirrored_upstream: row.upstream_query_id !== null,
          created_at: row.created_at,
        })),
        count: rows.length,
        visibility: filter ?? null,
        /* The local table is authoritative for this read, so an empty list is a
           true statement rather than a degraded one. */
        upstream_available: { search: null },
        note: 'Visibility governs who may RUN a query. Running it re-executes the search under the caller own scopes.',
      },
    });
  })
);

/**
 * GET /api/leadflow/audit/timeline — the correlated narrative for one subject.
 *
 * A NARRATIVE, NOT A LOG TAIL. The events are grouped by correlation so a
 * reader sees "this lead arrived, was routed, was messaged, and the message was
 * suppressed" as one story rather than four rows they have to join in their
 * head. That joining is exactly where a reader gets the story wrong.
 */
auditRoutes.get(
  '/timeline',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const subjectRef = typeof req.query?.subject_ref === 'string' ? req.query.subject_ref.trim() : '';
    if (subjectRef === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
    }

    const upstream = await SdkGatewayClient.isConfigured()
      ? await SdkGatewayClient.call<{ data?: { events?: Record<string, unknown>[] } }>({
        sdk: 'sdk-audit',
        // A POST, not a GET — /api/audit/export takes its filter in the body.
        path: '/api/audit/export',
        method: 'POST',
        body: { tenant_id: config.projexCloud.tenantId, subject_ref: subjectRef, limit: 200 }, idempotencyKey: `audit-timeline:${subjectRef}`,
      }).catch(() => ({ delivered: false, data: undefined }))
      : { delivered: false, data: undefined };

    const events = (upstream.data?.data?.events ?? []).map((e: Record<string, unknown>) => ({
      event_id: String(e.event_id ?? e.id ?? ''),
      title: String(e.event_type ?? 'event'),
      reference: typeof e.resource_id === 'string' ? e.resource_id : null,
      actor: typeof e.actor_id === 'string' ? e.actor_id : null,
      policy_decision_ref: typeof e.policy_decision_ref === 'string' ? e.policy_decision_ref : null,
      credit_estimate: null,
      occurred_at: typeof e.occurred_at === 'string' ? e.occurred_at : null,
      correlation_id: typeof e.correlation_id === 'string' ? e.correlation_id : null,
    }));

    res.status(200).json({
      success: true,
      data: {
        subject_ref: subjectRef, entries: events, entry_count: events.length,
        upstream_available: { audit: upstream.delivered },
        field_gaps: upstream.delivered ? [] : [
          {
            field: 'entries',
            /* An empty timeline and an unreachable one look identical, and only
               one of them means nothing happened to this person. */
            reason: 'sdk-audit could not be reached, so this subject\'s history is unknown rather than empty.',
          },
        ],
      },
    });
  })
);

/**
 * The four reversible actions the Audit screen offers, and what each would touch.
 *
 * DECLARED, NOT INFERRED. The panel in client/src/features/audit/
 * ReversibleActionsPanel.tsx offers exactly these four keys; anything else is a
 * caller error rather than an empty preview, because a blast radius of "nothing"
 * for a typo'd action is the one answer an operator must never be shown before
 * approving a reversal.
 */
const REVERSIBLE_ACTIONS: Record<string, { label: string; categories: string[] }> = {
  retract_identity_link: {
    label: 'Retract identity link',
    categories: ['identity_links', 'merged_records', 'audit_entries'],
  },
  end_relationship: {
    label: 'End relationship',
    categories: ['relationships', 'derived_access', 'audit_entries'],
  },
  withdraw_consent: {
    label: 'Withdraw consent',
    categories: ['consent_receipts', 'queued_messages', 'suppression_entries', 'audit_entries'],
  },
  start_privacy_erasure: {
    label: 'Start privacy erasure',
    categories: ['erasure_surfaces', 'retained_records', 'audit_entries'],
  },
};

/**
 * POST /api/leadflow/audit/reversals/preview — what a reversal would touch.
 *
 * ZERO SIDE EFFECTS BY CONTRACT. This runs while an operator is deciding, so it
 * reads and counts and does nothing else — no write, no suppression, no audit
 * append. An entry here would record a reversal that never happened, and the one
 * thing worse than an unlogged action is a logged one that did not occur.
 *
 * A NULL COUNT IS NOT ZERO, and the distinction is the whole point of the
 * `field_gaps` list. "Nothing would be touched" and "we could not find out what
 * would be touched" look identical in a number and are opposites in a decision:
 * the first invites approval, the second forbids it. Every unreachable upstream
 * therefore yields count:null AND a named gap, and `reversible` goes false when
 * any category could not be counted — an operator may not approve a blast radius
 * nobody can state.
 *
 * COUNTED FROM WHAT THIS DEPLOYMENT CAN ACTUALLY SEE. The erasure surfaces are
 * local configuration, so that count is exact; identity, relationship and
 * consent counts come from their gateways and degrade honestly when ProjexCloud
 * is unreachable.
 */
auditRoutes.post(
  '/reversals/preview',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectRef = typeof body.subject_ref === 'string' ? body.subject_ref.trim() : '';
    const action = typeof body.action === 'string' ? body.action.trim() : '';

    if (subjectRef === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
    }
    if (!(action in REVERSIBLE_ACTIONS)) {
      throw new AppError(
        400,
        ErrorCodes.VALIDATION_ERROR,
        `action must be one of ${Object.keys(REVERSIBLE_ACTIONS).join(', ')}`
      );
    }

    const configured = SdkGatewayClient.isConfigured();
    const gaps: { field: string; reason: string }[] = [];

    /** Count rows an upstream would return, or null when it cannot be asked. */
    const upstreamCount = async (
      field: string,
      sdk: string,
      path: string,
      unreachableReason: string
    ): Promise<number | null> => {
      if (!configured) {
        gaps.push({ field, reason: `No ProjexCloud gateway is configured, so ${unreachableReason}` });
        return null;
      }
      try {
        const r = await SdkGatewayClient.call<{ data?: unknown }>({ sdk, path, method: 'GET' });
        if (!r.delivered) {
          gaps.push({ field, reason: `${sdk} did not answer, so ${unreachableReason}` });
          return null;
        }
        const bag = r.data?.data as Record<string, unknown> | unknown[] | undefined;
        const rows = Array.isArray(bag)
          ? bag
          : Array.isArray((bag as Record<string, unknown>)?.items)
            ? ((bag as Record<string, unknown>).items as unknown[])
            : null;
        if (rows === null) {
          gaps.push({ field, reason: `${sdk} answered in a shape this preview cannot count, so ${unreachableReason}` });
          return null;
        }
        return rows.length;
      } catch {
        gaps.push({ field, reason: `${sdk} could not be reached, so ${unreachableReason}` });
        return null;
      }
    };

    const subject = encodeURIComponent(subjectRef);
    const blast: { category: string; count: number | null; detail: string }[] = [];

    if (action === 'retract_identity_link') {
      const links = await upstreamCount(
        'identity_links',
        'sdk-identity',
        `/api/identity/subjects/${subject}/links`,
        'the number of links on this subject is unknown rather than zero.'
      );
      blast.push({
        category: 'identity_links',
        count: links,
        detail: 'Links withdrawn. The underlying assertions survive; only the claim that they describe one person is retracted.',
      });
      blast.push({
        category: 'merged_records',
        count: links,
        detail: 'Records that would separate again. Each keeps its own history rather than losing it.',
      });
    } else if (action === 'end_relationship') {
      const roles = await upstreamCount(
        'relationships',
        'sdk-rebac',
        `/api/rebac/subjects/${subject}/relationships`,
        'the number of open relationships is unknown rather than zero.'
      );
      blast.push({
        category: 'relationships',
        count: roles,
        detail: 'Closed with a valid_to date rather than deleted, so the period each was true stays answerable.',
      });
      blast.push({
        category: 'derived_access',
        count: roles,
        detail: 'Access that came FROM the relationship ends with it. Access granted by a role is unaffected.',
      });
    } else if (action === 'withdraw_consent') {
      const receipts = await upstreamCount(
        'consent_receipts',
        'sdk-consent',
        `/api/consent/receipts?subject_ref=${subject}`,
        'the number of live receipts is unknown rather than zero.'
      );
      blast.push({
        category: 'consent_receipts',
        count: receipts,
        detail: 'Revoked. The evidence that consent was once given is preserved — a withdrawal is not a denial that it happened.',
      });

      // LOCAL AND EXACT. Queued sequence steps live in this database, so this
      // one number is not a guess and does not degrade.
      const queued = await dataService.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n
           FROM leadflow_sequence_enrollment
          WHERE tenant_id = $1 AND subject_ref = $2 AND status = 'active'`,
        [config.projexCloud.tenantId, subjectRef]
      );
      blast.push({
        category: 'queued_messages',
        count: Number(queued[0]?.n ?? 0),
        detail: 'Active enrolments whose remaining steps would be cancelled immediately, before the next tick.',
      });
      blast.push({
        category: 'suppression_entries',
        count: 1,
        detail: 'One suppression entry is written per withdrawal, so a later send is refused rather than merely undesirable.',
      });
    } else {
      // start_privacy_erasure — the surfaces are local configuration, so this is
      // the one action whose blast radius is exact without any upstream.
      const surfaces = actionableSurfaces();
      blast.push({
        category: 'erasure_surfaces',
        count: surfaces.length,
        detail: `Surfaces carrying this person's data: ${surfaces.map((s) => s.surface).join(', ')}.`,
      });
      blast.push({
        category: 'retained_records',
        count: surfaces.filter((s) => s.method === 'redact').length,
        detail: 'Redacted rather than deleted. The row survives so SLA, routing and audit references stay intact; the person does not.',
      });
    }

    // Always last, and never a number. The chain is append-only, so a reversal
    // ADDS to it — claiming a count of entries "affected" would imply entries
    // change, which is the one thing they never do.
    blast.push({
      category: 'audit_entries',
      count: null,
      detail: 'None are altered. The reversal appends its own entry naming the actor and the reason; the entries it reverses stay exactly as written.',
    });
    gaps.push({
      field: 'audit_entries',
      reason: 'Deliberately uncounted: audit entries are never modified by a reversal, so a count would imply an effect that cannot occur.',
    });

    const uncounted = blast.filter((b) => b.count === null && b.category !== 'audit_entries');

    res.status(200).json({
      success: true,
      data: {
        action,
        blast_radius: blast,
        /*
         * FALSE WHEN ANYTHING COULD NOT BE COUNTED. An operator approving a
         * reversal is approving its consequences, and consequences nobody can
         * enumerate are not approvable. This is the field the panel gates its
         * confirm button on.
         */
        reversible: uncounted.length === 0,
        field_gaps: gaps,
      },
    });
  })
);

/**
 * POST /api/leadflow/audit/evidence-bundle — everything about one subject.
 *
 * ASSEMBLED ON DEMAND rather than stored. A bundle is requested because
 * somebody is answering a question NOW — a complaint, a rights request, a
 * dispute — and a pre-built one is stale by definition and reassuring by
 * accident.
 */
auditRoutes.post(
  '/evidence-bundle',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const subjectRef = typeof body.subject_ref === 'string' ? body.subject_ref.trim() : '';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (subjectRef === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'subject_ref is required');
    if (reason === '') {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        'reason is required — an evidence bundle assembles somebody\'s whole record, and why it was assembled is itself an auditable act'
      );
    }

    const configured = SdkGatewayClient.isConfigured();
    const fetchOne = async (sdk: string, path: string): Promise<{ ok: boolean; data: unknown }> => {
      if (!configured) return { ok: false, data: null };
      try {
        const r = await SdkGatewayClient.call<{ data?: unknown }>({
          sdk, path, method: 'GET', idempotencyKey: `bundle:${sdk}:${subjectRef}`,
        });
        return { ok: r.delivered, data: r.data?.data ?? null };
      } catch { return { ok: false, data: null }; }
    };

    const audit = await fetchOne('sdk-audit', `/api/audit/export?subject_ref=${encodeURIComponent(subjectRef)}&limit=500`);
    const consent = await fetchOne('sdk-consent', `/api/consent/receipts?subject_ref=${encodeURIComponent(subjectRef)}`);
    const source = await fetchOne('sdk-source-record', `/api/source-records/subjects/${encodeURIComponent(subjectRef)}/assertions`);

    const sections = [
      { section: 'audit_events', available: audit.ok, data: audit.data },
      { section: 'consent_receipts', available: consent.ok, data: consent.data },
      { section: 'source_assertions', available: source.ok, data: source.data },
    ];
    const incomplete = sections.filter((s) => !s.available).map((s) => s.section);

    // The bundle records its own assembly, because pulling somebody's entire
    // record together is itself an act somebody may later ask about.
    if (configured) {
      try {
        await SdkGatewayClient.call({
          sdk: 'sdk-audit', path: '/api/audit/append', method: 'POST',
          idempotencyKey: `bundle-assembled:${subjectRef}:${reason}`,
          body: {
            tenant_id: config.projexCloud.tenantId,
            event_type: 'leadflow.evidence_bundle.assembled.v1',
            actor_id: req.session?.userId ?? null, resource_type: 'subject', resource_id: subjectRef,
            metadata: { reason, sections_unavailable: incomplete },
          },
        });
      } catch { /* the bundle is still returned; the trail entry is best-effort */ }
    }

    res.status(200).json({
      success: true,
      data: {
        subject_ref: subjectRef, reason, sections,
        assembled_at: new Date().toISOString(),
        /* A PARTIAL BUNDLE SAYS SO, prominently. Handing somebody an incomplete
           record labelled "complete" is worse than handing them nothing: they
           answer a regulator from it. */
        complete: incomplete.length === 0,
        sections_unavailable: incomplete,
      },
    });
  })
);

import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
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

import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { governed, type GovernedRequest } from '../../platform/policy/governed';
import { PERMISSIONS } from '../../config/roles';
import { AUDIT_EVENTS } from '../../platform/audit/vocabulary';
import {
  getAttestation,
  getPermittedUse,
  getRun,
  listConnectors,
  listExceptions,
  listRuns,
  listTemplates,
  tenantId,
  type GovernanceVerdict,
  type ImportRunRow,
  type LineageRow,
} from './importGateway';

/**
 * The Import Center's read surface: four endpoints, one per screen action.
 *
 * ONE CALL PER SCREEN, and the composition happens HERE rather than in the
 * browser. Fanning out from the client means three round trips over the
 * operator's network, three chances to half-render, and headline counts that
 * can disagree with the register beneath them because the two reads were taken
 * a second apart. Composing server-side makes the screen consistent by
 * construction — the counts are derived from the same list that is returned.
 *
 * READS ARE GOVERNED, not merely authenticated. An import names what happened
 * to whose data, so who looked is part of the record; `governed()` evaluates
 * the grant and appends the audit entry in one place rather than leaving either
 * to a handler that might forget.
 */
export const importsRoutes: Router = Router();

/*
 * BEHIND `authenticate`, and this line is load-bearing.
 *
 * governed() reads the caller's roles from the session, which only exists once
 * authenticate has run. Without it rolesFor() returns an EMPTY array and every
 * request is refused with "No policy grants this action to the caller's roles"
 * — a message that points at the policy bundle and is therefore maximally
 * misleading, because the bundle is fine and the caller simply has no identity.
 */
importsRoutes.use(authenticate);

/**
 * Every panel this feature reads is scoped to the caller's tenant, and none of
 * them belongs to one person, so `own_record_only` is deferred rather than
 * discharged. Stated once here because all four endpoints share the reasoning.
 */
const NOT_AN_OWNED_RECORD = {
  own_record_only: {
    kind: 'defer' as const,
    because: 'an import run belongs to the tenant that ran it, not to an individual owner',
  },
};

const runIdOf = (req: GovernedRequest): string => String(req.params.run_id);

/** Turn "sdk-import answered and has no such run" into a 404. */
function assertFound(run: ImportRunRow | null, available: boolean, runId: string): void {
  if (available && !run) {
    // ONLY when the store actually answered. An unreachable store must never
    // present as a missing run — that would let an outage look like a deletion.
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'No import run with that id');
  }
  void runId;
}

/**
 * Lineage as a SHAPE rather than as rows.
 *
 * A committed run can create tens of thousands of lineage rows, and the drill-in
 * needs how many of each kind and how many are already reversed — not the rows.
 * Streaming them would make the screen slower the more successful the import
 * was, which is precisely backwards.
 */
function summariseLineage(rows: LineageRow[]): Record<string, unknown> {
  const byKind: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  let reversed = 0;

  for (const row of rows) {
    const kind = row.entity_kind ?? 'unknown';
    const action = row.action ?? 'unknown';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    byAction[action] = (byAction[action] ?? 0) + 1;
    if (row.reversed_at) {
      reversed += 1;
    }
  }

  return { total: rows.length, by_entity_kind: byKind, by_action: byAction, reversed };
}

/**
 * The dry run's verdicts, INCLUDING the ones that passed.
 *
 * A panel that lists only failures cannot tell "every check passed" apart from
 * "no checks ran", and for an import nobody has reviewed yet those are very
 * different states.
 */
function verdictsOf(run: ImportRunRow | null): GovernanceVerdict[] {
  const governance = run?.dry_run_result?.governance;
  return Array.isArray(governance) ? governance : [];
}

/** Whether the rollback window is open AS OF NOW, rather than a raw deadline. */
function rollbackState(run: ImportRunRow | null): Record<string, unknown> {
  const deadline = run?.rollback_deadline ?? null;
  const rolledBackAt = run?.rolled_back_at ?? null;
  const parsed = deadline ? Date.parse(deadline) : Number.NaN;
  return {
    deadline,
    rolled_back_at: rolledBackAt,
    // Computed, not copied: "rollback_deadline: last Tuesday" asks the reader to
    // do date arithmetic to answer the only question they actually have.
    available: !rolledBackAt && !Number.isNaN(parsed) && parsed > Date.now(),
  };
}

/* --------------------------------------------------------------- center */

/**
 * GET /api/leadflow/imports/center — the register, the templates and the
 * connectors, in one answer.
 *
 * The three reads are issued CONCURRENTLY and degrade independently, so a
 * connector outage empties the connector tiles and leaves the register intact.
 */
importsRoutes.get(
  '/center',
  asyncHandler(governed(
    {
      action: PERMISSIONS.IMPORT_RUN_READ,
      event: AUDIT_EVENTS.IMPORT_RUN_INSPECTED,
      purpose: 'lead_management',
      resourceType: 'import_center',
      metadata: () => ({ surface: 'import_center' }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (_req: GovernedRequest, res: Response): Promise<void> => {
      const [runs, templates, connectors] = await Promise.all([
        listRuns(),
        listTemplates(),
        listConnectors(),
      ]);

      // Derived from the SAME list that is returned, so a tile can never
      // disagree with the rows beneath it.
      const statusCounts: Record<string, number> = {};
      for (const run of runs.value) {
        const status = run.status ?? 'unknown';
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      }

      res.status(200).json({
        success: true,
        data: {
          runs: runs.value.map((run) => ({
            run_id: run.run_id ?? null,
            status: run.status ?? null,
            source_kind: run.source_kind ?? null,
            file_name: run.file_name ?? null,
            row_count: run.row_count ?? null,
            committed_row_count: run.committed_row_count ?? null,
            exception_count: run.exception_count ?? 0,
            quarantine_reason: run.quarantine_reason ?? null,
            created_at: run.created_at ?? null,
            committed_at: run.committed_at ?? null,
            rollback: rollbackState(run),
          })),
          run_count: runs.value.length,
          status_counts: statusCounts,
          templates: templates.value.map((template) => ({
            template_id: template.template_id ?? null,
            name: template.name ?? null,
            kind: template.kind ?? null,
            version: template.version ?? null,
            source_kind: template.source_kind ?? null,
          })),
          template_count: templates.value.length,
          connectors: connectors.value.map((install) => ({
            install_id: install.install_id ?? null,
            kind: install.kind ?? null,
            status: install.status ?? null,
            last_sync_at: install.last_sync_at ?? null,
          })),
          connector_count: connectors.value.length,
          // Per panel, not one flag for the page: the screen can say which of
          // the three it is missing rather than implying all of them are empty.
          upstream_available: {
            runs: runs.available,
            templates: templates.available,
            connectors: connectors.available,
          },
          tenant_id: tenantId() ?? null,
        },
      });
    },
  )),
);

/* ------------------------------------------------------------ run detail */

/**
 * GET /api/leadflow/imports/runs/:run_id — the drill-in.
 *
 * Lineage summarised, verdicts verbatim, exceptions counted.
 */
importsRoutes.get(
  '/runs/:run_id',
  asyncHandler(governed(
    {
      action: PERMISSIONS.IMPORT_RUN_READ,
      event: AUDIT_EVENTS.IMPORT_RUN_INSPECTED,
      purpose: 'lead_management',
      resourceType: 'import_run',
      resourceId: runIdOf,
      metadata: (req) => ({ run_id: runIdOf(req) }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const runId = runIdOf(req);
      const [detail, exceptions] = await Promise.all([getRun(runId), listExceptions(runId)]);
      assertFound(detail.value.run, detail.available, runId);

      const run = detail.value.run;
      res.status(200).json({
        success: true,
        data: {
          run_id: runId,
          run,
          lineage: summariseLineage(detail.value.lineage),
          governance: verdictsOf(run),
          // The run's own counter when it has one, else what we could count.
          // Not defaulted to zero from an unreachable store: "no exceptions" is
          // the most reassuring thing this screen can say and the most
          // dangerous thing to say while blind.
          exception_count: run?.exception_count ?? (exceptions.available ? exceptions.value.length : null),
          rollback: rollbackState(run),
          upstream_available: { run: detail.available, exceptions: exceptions.available },
          tenant_id: tenantId() ?? null,
        },
      });
    },
  )),
);

/* ---------------------------------------------------------------- report */

/**
 * POST /api/leadflow/imports/runs/:run_id/report — the completed-run report.
 *
 * POST because composing it fans out across three reads and is recorded as a
 * disclosure; 200 because it creates no addressable resource, so a 201 would
 * promise a Location nobody can follow.
 */
importsRoutes.post(
  '/runs/:run_id/report',
  asyncHandler(governed(
    {
      action: PERMISSIONS.IMPORT_RUN_READ,
      event: AUDIT_EVENTS.IMPORT_RUN_INSPECTED,
      purpose: 'lead_management',
      resourceType: 'import_run',
      resourceId: runIdOf,
      metadata: (req) => ({ run_id: runIdOf(req), surface: 'completed_run_report' }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const runId = runIdOf(req);
      const [detail, exceptions] = await Promise.all([getRun(runId), listExceptions(runId)]);
      assertFound(detail.value.run, detail.available, runId);

      const run = detail.value.run;
      const read = run?.row_count ?? null;
      const committed = run?.committed_row_count ?? null;
      const excepted = run?.exception_count ?? (exceptions.available ? exceptions.value.length : null);

      res.status(200).json({
        success: true,
        data: {
          report: {
            run_id: runId,
            status: run?.status ?? null,
            source: { kind: run?.source_kind ?? null, file_name: run?.file_name ?? null },
            rows: {
              read,
              committed,
              excepted,
              // Stated rather than left to the reader. A report whose three
              // numbers do not add up is the first thing anybody asks about,
              // and answering it here is cheaper than answering it in support.
              unaccounted:
                read !== null && committed !== null && excepted !== null
                  ? Math.max(0, read - committed - excepted)
                  : null,
            },
            lineage: summariseLineage(detail.value.lineage),
            governance: verdictsOf(run),
            rollback: rollbackState(run),
            committed_at: run?.committed_at ?? null,
            started_by: run?.started_by ?? null,
            correlation_id: run?.correlation_id ?? null,
          },
          upstream_available: { run: detail.available, exceptions: exceptions.available },
          tenant_id: tenantId() ?? null,
        },
      });
    },
  )),
);

/* -------------------------------------------------------------- evidence */

/**
 * GET /api/leadflow/imports/runs/:run_id/evidence — the attestation bundle.
 *
 * A NARROWER GRANT than the rest of the feature, which is why it is its own
 * endpoint: `import.evidence_read` is held by the Data Steward and the Privacy
 * Officer and by nobody else. Folding it into the run detail would have handed
 * the rights attestation to every viewer of the register.
 */
importsRoutes.get(
  '/runs/:run_id/evidence',
  asyncHandler(governed(
    {
      action: PERMISSIONS.IMPORT_EVIDENCE_READ,
      // Its OWN event. "Somebody looked at the import queue" and "somebody read
      // the attestation naming who swore this data was lawfully obtained" are
      // different disclosures, and an audit that spells them the same way
      // cannot answer the second question.
      event: AUDIT_EVENTS.IMPORT_EVIDENCE_EXPORTED,
      purpose: 'lead_management',
      resourceType: 'import_run',
      resourceId: runIdOf,
      metadata: (req) => ({ run_id: runIdOf(req), disclosure: 'rights_attestation' }),
      obligations: NOT_AN_OWNED_RECORD,
    },
    async (req: GovernedRequest, res: Response): Promise<void> => {
      const runId = runIdOf(req);
      const detail = await getRun(runId);
      assertFound(detail.value.run, detail.available, runId);

      const run = detail.value.run;
      const attestationId = run?.attestation_id ?? null;

      // Only fetched when the run actually names one. A run with no attestation
      // is the ordinary first-party case, not an error — asking anyway would
      // turn "we collected this ourselves" into a spurious upstream failure.
      const [attestation, permittedUse] = attestationId
        ? await Promise.all([getAttestation(attestationId), getPermittedUse(attestationId)])
        : [
            { value: null as Record<string, unknown> | null, available: true },
            { value: null as Record<string, unknown> | null, available: true },
          ];

      res.status(200).json({
        success: true,
        data: {
          run_id: runId,
          attestation_id: attestationId,
          attestation: attestation.value,
          permitted_use: permittedUse.value,
          governance: verdictsOf(run),
          evidence: {
            source_kind: run?.source_kind ?? null,
            source_ref: run?.source_ref ?? null,
            correlation_id: run?.correlation_id ?? null,
            committed_at: run?.committed_at ?? null,
            // Says plainly why there is nothing to show, so an empty panel is
            // never mistaken for a missing record.
            basis: attestationId
              ? 'third_party_attested'
              : 'first_party — this run declares no rights attestation',
          },
          upstream_available: {
            run: detail.available,
            attestation: attestation.available,
            permitted_use: permittedUse.available,
          },
          tenant_id: tenantId() ?? null,
        },
      });
    },
  )),
);

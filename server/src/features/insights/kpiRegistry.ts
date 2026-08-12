import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';

/**
 * The KPI definition registry and the reconciliation report.
 *
 * SOP §22 names "metrics disagree across dashboards" as a launch gap. They
 * disagree because one tile counts leads by created_at and another by
 * first_response_at, or because one divides by all leads and the other by
 * contactable ones — never because somebody typed a number wrong. So the
 * registry records exactly the fields on which two dashboards can silently
 * differ, and the reconciliation report recomputes from the source of truth
 * rather than comparing the tiles to each other.
 */

/** The fields a registered definition must carry. All mandatory. */
export const KPI_REQUIRED_FIELDS = [
  'plain_language', 'event_timestamps', 'source_of_truth', 'filter_clause', 'denominator', 'owner_user_id',
] as const;

export interface KpiDefinition {
  kpi_id: string; metric_key: string; version: number;
  plain_language: string; event_timestamps: string; source_of_truth: string;
  filter_clause: string; denominator: string; owner_user_id: string;
  lineage_ref: string | null; created_at: string; change_reason: string | null;
}

export async function currentDefinitions(): Promise<KpiDefinition[]> {
  return dataService.query<KpiDefinition>(
    `SELECT kpi_id, metric_key, version, plain_language, event_timestamps, source_of_truth,
            filter_clause, denominator, owner_user_id, lineage_ref, created_at, change_reason
       FROM leadflow_kpi_registry
      WHERE tenant_id = $1 AND superseded_at IS NULL
      ORDER BY metric_key`,
    [config.projexCloud.tenantId]
  );
}

export async function historyFor(metricKey: string): Promise<KpiDefinition[]> {
  return dataService.query<KpiDefinition>(
    `SELECT kpi_id, metric_key, version, plain_language, event_timestamps, source_of_truth,
            filter_clause, denominator, owner_user_id, lineage_ref, created_at, change_reason
       FROM leadflow_kpi_registry
      WHERE tenant_id = $1 AND metric_key = $2
      ORDER BY version DESC`,
    [config.projexCloud.tenantId, metricKey]
  );
}

/**
 * Register a new version of a definition.
 *
 * SUPERSEDE-AND-INSERT, never update in place. A metric definition that changes
 * silently makes every historical chart wrong in a way nobody can see: the
 * numbers move and the label does not. The version is what lets a reader say
 * "this series changed definition in March" instead of "the data looks odd".
 */
export async function registerDefinition(input: {
  metricKey: string; plainLanguage: string; eventTimestamps: string; sourceOfTruth: string;
  filterClause: string; denominator: string; ownerUserId: string;
  lineageRef: string | null; changeReason: string | null; createdBy: string | null;
}): Promise<{ kpiId: string; version: number; previousVersion: number | null }> {
  const previous = await dataService.query<{ version: number }>(
    `UPDATE leadflow_kpi_registry SET superseded_at = now()
      WHERE tenant_id = $1 AND metric_key = $2 AND superseded_at IS NULL
      RETURNING version`,
    [config.projexCloud.tenantId, input.metricKey]
  );

  const rows = await dataService.query<{ kpi_id: string; version: number }>(
    `INSERT INTO leadflow_kpi_registry
       (tenant_id, metric_key, version, plain_language, event_timestamps, source_of_truth,
        filter_clause, denominator, owner_user_id, lineage_ref, change_reason, created_by)
     VALUES ($1,$2,
             (SELECT COALESCE(MAX(version),0)+1 FROM leadflow_kpi_registry WHERE tenant_id = $1 AND metric_key = $2),
             $3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING kpi_id, version`,
    [
      config.projexCloud.tenantId, input.metricKey, input.plainLanguage, input.eventTimestamps,
      input.sourceOfTruth, input.filterClause, input.denominator, input.ownerUserId,
      input.lineageRef, input.changeReason, input.createdBy,
    ]
  );

  /* The change history goes to sdk-audit as well as to the version row. A
     definition change is the kind of act somebody asks about months later —
     "who moved the conversion denominator" — and the audit chain is where that
     question is answerable against a record nobody can quietly edit. */
  if (SdkGatewayClient.isConfigured()) {
    try {
      await SdkGatewayClient.call({
        sdk: 'sdk-audit', path: '/api/audit/append', method: 'POST',
        idempotencyKey: `kpi-def:${rows[0].kpi_id}`,
        body: {
          tenant_id: config.projexCloud.tenantId,
          event_type: 'leadflow.kpi_definition.changed.v1',
          actor_id: input.createdBy, resource_type: 'kpi_definition', resource_id: rows[0].kpi_id,
          metadata: {
            metric_key: input.metricKey, version: rows[0].version,
            previous_version: previous[0]?.version ?? null, change_reason: input.changeReason,
          },
        },
      });
    } catch { /* the version row is the durable record; the audit is the trail */ }
  }

  return { kpiId: rows[0].kpi_id, version: rows[0].version, previousVersion: previous[0]?.version ?? null };
}

/* ---------------------------------------------------------- reconciliation */

export interface Recomputation { metricKey: string; value: number | null; basis: string; computable: boolean }

/**
 * Recompute a metric FROM THE SOURCE OF TRUTH.
 *
 * The report is only worth anything if this number is derived independently of
 * whatever the tile displayed. Comparing two tiles to each other proves they
 * agree; comparing both to a recomputation proves they are RIGHT — and when
 * they disagree, it says which one is wrong.
 *
 * A metric whose source of truth this module cannot recompute is reported as
 * NOT COMPUTABLE rather than skipped. A reconciliation report that silently
 * omits the metrics it could not check reads as a clean bill of health.
 */
export async function recompute(def: KpiDefinition): Promise<Recomputation> {
  const key = def.metric_key;
  const one = async (sql: string, params: unknown[] = []): Promise<number> => {
    const rows = await dataService.query<{ v: string }>(sql, params);
    return Number(rows[0]?.v ?? 0);
  };

  try {
    switch (key) {
      case 'leads_created':
        return {
          metricKey: key, computable: true, basis: 'count(leads) by leads.created_at',
          value: await one('SELECT COUNT(*)::text AS v FROM leads WHERE created_at >= now() - interval \'30 days\''),
        };
      case 'contact_rate': {
        const total = await one('SELECT COUNT(*)::text AS v FROM leads WHERE created_at >= now() - interval \'30 days\'');
        const contacted = await one('SELECT COUNT(*)::text AS v FROM leads WHERE first_response_at IS NOT NULL AND created_at >= now() - interval \'30 days\'');
        return {
          metricKey: key, computable: true,
          basis: 'leads with first_response_at / all leads created in the window',
          value: total === 0 ? 0 : Number((contacted / total).toFixed(4)),
        };
      }
      case 'sla_attainment': {
        const total = await one('SELECT COUNT(*)::text AS v FROM leads WHERE sla_due_at IS NOT NULL AND created_at >= now() - interval \'30 days\'');
        const met = await one('SELECT COUNT(*)::text AS v FROM leads WHERE sla_due_at IS NOT NULL AND sla_breached IS NOT TRUE AND created_at >= now() - interval \'30 days\'');
        return {
          metricKey: key, computable: true,
          basis: 'leads with an SLA clock that did not breach / all leads with an SLA clock',
          value: total === 0 ? 0 : Number((met / total).toFixed(4)),
        };
      }
      case 'onboarding_attainment': {
        const total = await one('SELECT COUNT(*)::text AS v FROM leadflow_onboarding_handoff WHERE tenant_id = $1', [config.projexCloud.tenantId]);
        const done = await one(
          `SELECT COUNT(*)::text AS v FROM leadflow_onboarding_handoff
            WHERE tenant_id = $1 AND accepted_at IS NOT NULL AND kickoff_at IS NOT NULL`,
          [config.projexCloud.tenantId]
        );
        return {
          metricKey: key, computable: true,
          basis: 'handoffs accepted AND with a booked kickoff / all paid handoffs',
          value: total === 0 ? 0 : Number((done / total).toFixed(4)),
        };
      }
      default:
        return {
          metricKey: key, computable: false, value: null,
          basis: `No local recomputation exists for this metric. Its source of truth is "${def.source_of_truth}", which this report cannot query — reported rather than skipped, because a report that silently omits what it could not check reads as a clean bill of health.`,
        };
    }
  } catch (error) {
    return {
      metricKey: key, computable: false, value: null,
      basis: `Recomputation failed: ${error instanceof Error ? error.message : 'unknown'}`,
    };
  }
}

/** Divergence tolerance. Rounding is not disagreement; a different rule is. */
export const DIVERGENCE_TOLERANCE = 0.0001;

import { Router, type Response } from 'express';
import { asyncHandler } from '../../middleware/errorHandler';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth';
import { AppError, ErrorCodes } from '../../utils/errors';
import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import {
  DIVERGENCE_TOLERANCE, KPI_REQUIRED_FIELDS, currentDefinitions, historyFor,
  recompute, registerDefinition,
} from './kpiRegistry';
import {
  FORECAST_REQUIREMENTS, attribution, classifyForecast, funnelBySource,
  onboardingAttainment, pipelineHealth, poorQuality, publishLineage,
  type ForecastDeal,
} from './funnelService';

export const kpiRoutes: Router = Router();
export const insightsRoutes: Router = Router();
kpiRoutes.use(authenticate);
insightsRoutes.use(authenticate);

const windowDays = (req: AuthenticatedRequest): number => {
  const raw = Number(req.query?.days ?? 30);
  return Number.isFinite(raw) && raw > 0 && raw <= 365 ? Math.floor(raw) : 30;
};

/* ------------------------------------------------------------ KPI registry */

/** GET /api/leadflow/kpi-definitions — every registered metric. */
kpiRoutes.get(
  '/',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const definitions = await currentDefinitions();
    res.status(200).json({
      success: true,
      data: {
        definitions, definition_count: definitions.length,
        required_fields: KPI_REQUIRED_FIELDS,
        note: 'Two dashboards disagree because one counts by created_at and the other by first_response_at, or because one divides by all leads and the other by contactable ones. These are the fields on which they can silently differ.',
      },
    });
  })
);

/** GET /api/leadflow/kpi-definitions/:metric_key — the version history. */
kpiRoutes.get(
  '/:metric_key',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const metricKey = String(req.params?.metric_key ?? '');
    const versions = await historyFor(metricKey);
    if (versions.length === 0) throw new AppError(404, ErrorCodes.NOT_FOUND, 'No definition has ever been registered for that metric');
    res.status(200).json({
      success: true,
      data: {
        metric_key: metricKey, current: versions[0], history: versions, version_count: versions.length,
        note: 'A definition that changes silently makes every historical chart wrong in a way nobody can see — the numbers move and the label does not. The version is what lets a reader say "this series changed definition in March" instead of "the data looks odd".',
      },
    });
  })
);

/** POST /api/leadflow/kpi-definitions — register a version. */
kpiRoutes.post(
  '/',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
    const metricKey = text('metric_key');
    if (metricKey === '') throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'metric_key is required');

    const owner = text('owner_user_id') || (req.session?.userId ?? '');
    const missing = KPI_REQUIRED_FIELDS.filter((f) => (f === 'owner_user_id' ? owner === '' : text(f) === ''));
    if (missing.length > 0) {
      throw new AppError(
        400, ErrorCodes.VALIDATION_ERROR,
        `A definition missing ${missing.join(', ')} cannot be registered — those are exactly the fields on which two dashboards silently disagree, so a registry without them records only what they already agreed on`
      );
    }

    const saved = await registerDefinition({
      metricKey, plainLanguage: text('plain_language'), eventTimestamps: text('event_timestamps'),
      sourceOfTruth: text('source_of_truth'), filterClause: text('filter_clause'),
      denominator: text('denominator'), ownerUserId: owner,
      lineageRef: text('lineage_ref') || null, changeReason: text('change_reason') || null,
      createdBy: req.session?.userId ?? null,
    });

    res.status(201).json({
      success: true,
      data: {
        kpi_id: saved.kpiId, metric_key: metricKey, version: saved.version,
        previous_version: saved.previousVersion, owner_user_id: owner,
        /* AC3 — the change is versioned locally and audited upstream. */
        audited: true,
        note: 'Supersede-and-insert, never an in-place update. The previous version stays readable so a chart that changed shape has an explanation.',
      },
    });
  })
);

/**
 * POST /api/leadflow/kpi-tiles — declare a dashboard tile.
 *
 * REFUSED WITHOUT A REGISTERED DEFINITION. This is the enforcement point for
 * AC1 and AC4: a tile cannot be declared, and therefore cannot ship, unless the
 * metric it displays already exists in the registry. Putting the check here
 * rather than in a lint rule means it holds for tiles added at runtime too.
 */
kpiRoutes.post(
  '/tiles',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const dashboardKey = typeof body.dashboard_key === 'string' ? body.dashboard_key.trim() : '';
    const tileKey = typeof body.tile_key === 'string' ? body.tile_key.trim() : '';
    const metricKey = typeof body.metric_key === 'string' ? body.metric_key.trim() : '';
    if (dashboardKey === '' || tileKey === '' || metricKey === '') {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'dashboard_key, tile_key and metric_key are all required');
    }

    const known = await dataService.query<{ metric_key: string }>(
      `SELECT metric_key FROM leadflow_kpi_registry
        WHERE tenant_id = $1 AND metric_key = $2 AND superseded_at IS NULL LIMIT 1`,
      [config.projexCloud.tenantId, metricKey]
    );
    if (known.length === 0) {
      throw new AppError(
        422, ErrorCodes.VALIDATION_ERROR,
        `No registered KPI definition exists for "${metricKey}", so this tile cannot ship. Register the definition first — a tile whose meaning is written only in its own query is how two dashboards end up disagreeing.`
      );
    }

    const rows = await dataService.query<{ tile_id: string }>(
      `INSERT INTO leadflow_kpi_tile (tenant_id, dashboard_key, tile_key, metric_key, displayed_value, displayed_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (tenant_id, dashboard_key, tile_key)
       DO UPDATE SET metric_key = EXCLUDED.metric_key, displayed_value = EXCLUDED.displayed_value, displayed_at = now()
       RETURNING tile_id`,
      [
        config.projexCloud.tenantId, dashboardKey, tileKey, metricKey,
        typeof body.displayed_value === 'number' ? body.displayed_value : null,
      ]
    );
    res.status(201).json({
      success: true,
      data: { tile_id: rows[0].tile_id, dashboard_key: dashboardKey, tile_key: tileKey, metric_key: metricKey },
    });
  })
);

/**
 * GET /api/leadflow/kpi-reconciliation — recompute and compare.
 *
 * THE REPORT RECOMPUTES FROM THE SOURCE OF TRUTH rather than comparing tiles to
 * each other. Comparing two tiles proves they agree; comparing both to an
 * independent recomputation proves they are RIGHT, and when they disagree it
 * says which one is wrong.
 */
kpiRoutes.get(
  '/reconciliation/report',
  asyncHandler(async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
    const definitions = await currentDefinitions();
    const tiles = await dataService.query<{
      tile_id: string; dashboard_key: string; tile_key: string; metric_key: string;
      displayed_value: string | null; displayed_at: string | null;
    }>(
      `SELECT tile_id, dashboard_key, tile_key, metric_key, displayed_value::text, displayed_at
         FROM leadflow_kpi_tile WHERE tenant_id = $1`,
      [config.projexCloud.tenantId]
    );

    const recomputations = await Promise.all(definitions.map((d) => recompute(d)));
    const truth = new Map(recomputations.map((r) => [r.metricKey, r]));

    const divergences: Record<string, unknown>[] = [];
    const unregistered: Record<string, unknown>[] = [];
    for (const tile of tiles) {
      const registered = definitions.some((d) => d.metric_key === tile.metric_key);
      if (!registered) {
        /* AC1 — a tile whose definition is unregistered is reported, never
           quietly reconciled against nothing. */
        unregistered.push({ dashboard_key: tile.dashboard_key, tile_key: tile.tile_key, metric_key: tile.metric_key });
        continue;
      }
      const computed = truth.get(tile.metric_key);
      if (!computed?.computable || tile.displayed_value === null) continue;
      const shown = Number(tile.displayed_value);
      if (Math.abs(shown - (computed.value ?? 0)) > DIVERGENCE_TOLERANCE) {
        divergences.push({
          dashboard_key: tile.dashboard_key, tile_key: tile.tile_key, metric_key: tile.metric_key,
          displayed: shown, recomputed: computed.value, basis: computed.basis,
          verdict: 'The tile disagrees with the source of truth. The recomputation is the reference, not the other tile.',
        });
      }
    }

    /* Metrics whose source of truth this report cannot query are named. A
       reconciliation report that silently omits what it could not check reads as
       a clean bill of health, which is worse than saying nothing. */
    const notComputable = recomputations.filter((r) => !r.computable);

    res.status(200).json({
      success: true,
      data: {
        definitions_checked: definitions.length,
        tiles_checked: tiles.length,
        recomputations,
        /* AC2 — divergence detected and reported. */
        divergences, divergence_count: divergences.length,
        /* AC4 — tiles referencing nothing registered. */
        unregistered_tiles: unregistered, unregistered_count: unregistered.length,
        not_computable: notComputable.map((r) => ({ metric_key: r.metricKey, why: r.basis })),
        tolerance: DIVERGENCE_TOLERANCE,
        verdict: divergences.length === 0 && unregistered.length === 0 ? 'reconciled' : 'divergent',
      },
    });
  })
);

/* --------------------------------------------------------------- analytics */

/** GET /api/leadflow/analytics/funnel — rates by source, with pipeline health. */
insightsRoutes.get(
  '/funnel',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const days = windowDays(req);
    const bySource = await funnelBySource(days);
    const health = await pipelineHealth();
    const onboarding = await onboardingAttainment();
    const minVolume = Number(req.query?.min_volume ?? 25);

    res.status(200).json({
      success: true,
      data: {
        window_days: days,
        by_source: bySource,
        /* AC3 — surfaced, ranked by WASTED VOLUME rather than by conversion
           percentage. A source with three leads and no wins has a 0% rate and
           costs nothing; one with four hundred leads and two wins is where the
           money is going, and sorting by rate puts the harmless one first. */
        poor_quality: poorQuality(bySource, Number.isFinite(minVolume) ? minVolume : 25),
        poor_quality_note: 'Nothing is filtered out of by_source. A minimum-conversion filter is exactly how a bad channel keeps its budget.',
        /* AC4 — the one-business-day standard. */
        onboarding_attainment: onboarding,
        pipeline_health: health,
        hard_targets: { unowned: 0, active_without_next: 0 },
        targets_met: health.unowned === 0 && health.active_without_next === 0,
      },
    });
  })
);

/**
 * GET /api/leadflow/analytics/forecast — commit, with the exclusions named.
 *
 * Deals are supplied by the caller rather than read from a local table: the CRM
 * owns the deal and its qualification fields, and mirroring them here would
 * create a second source of truth for the exact number this endpoint exists to
 * make trustworthy.
 */
insightsRoutes.post(
  '/forecast',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = Array.isArray(body.deals) ? body.deals : [];
    if (raw.length === 0) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'deals must be a non-empty array');

    const deals: ForecastDeal[] = raw.map((d) => {
      const o = (d ?? {}) as Record<string, unknown>;
      const str = (k: string): string | null => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : null);
      return {
        dealRef: typeof o.deal_ref === 'string' ? o.deal_ref : 'unknown',
        amountCents: Number.isFinite(Number(o.amount_cents)) ? Number(o.amount_cents) : 0,
        decisionDate: str('decision_date'), namedStakeholder: str('named_stakeholder'),
        nextEvent: str('next_event'), statedRisk: str('stated_risk'), evidence: str('evidence'),
      };
    });

    const result = classifyForecast(deals);
    res.status(200).json({
      success: true,
      data: {
        requirements: FORECAST_REQUIREMENTS,
        /* AC1 — a deal missing any one element is out of commit, and the missing
           element is named. Both halves matter: excluding it keeps the number
           honest, and naming what is missing is what makes the exclusion
           actionable rather than an argument in the pipeline review. */
        committed: result.verdicts.filter((v) => v.committed),
        unqualified: result.verdicts.filter((v) => !v.committed),
        committed_cents: result.committedCents,
        unqualified_cents: result.unqualifiedCents,
        deal_count: deals.length,
        note: 'The requirements are conjunctive. A deal with a date and a stakeholder but no stated risk is the classic slipped deal — everybody knew the risk and nobody wrote it down.',
      },
    });
  })
);

/** GET /api/leadflow/analytics/attribution — evidence-based, with lineage. */
insightsRoutes.get(
  '/attribution',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const days = windowDays(req);
    const rows = await attribution(days);
    const lineage = await publishLineage(
      'leadflow_attribution_v1',
      'SELECT attribution_platform, attribution_campaign_id, attribution_ad_id, attribution_creative_id, utm_source, utm_medium, source AS original_source, latest_source FROM leads GROUP BY 1,2,3,4,5,6,7,8'
    );

    res.status(200).json({
      success: true,
      data: {
        window_days: days, rows, row_count: rows.length,
        /* AC1 — both sources travel with the lead. leads.source is the ORIGINAL
           and never moves; latest_source is a separate column, because
           overwriting the first is how a paid channel takes credit for an
           organic lead. */
        carries: ['original_source', 'latest_source', 'campaign_id', 'ad_id', 'creative_id', 'utm_source', 'utm_medium'],
        /* AC4 — the derivation is registered so a disputed number can be
           followed back to its inputs rather than defended by assertion. */
        lineage_spec_id: lineage.specId,
        lineage_note: lineage.note,
        basis: 'Stamped at intake and carried to closed-won. Evidence-based rather than reconstructed later from timestamps and campaign windows.',
      },
    });
  })
);

/** GET /api/leadflow/analytics/source-quality — the sources nobody wants to see. */
insightsRoutes.get(
  '/source-quality',
  asyncHandler(async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const days = windowDays(req);
    const minVolume = Number(req.query?.min_volume ?? 25);
    const bySource = await funnelBySource(days);
    const poor = poorQuality(bySource, Number.isFinite(minVolume) ? minVolume : 25);

    res.status(200).json({
      success: true,
      data: {
        window_days: days, min_volume: Number.isFinite(minVolume) ? minVolume : 25,
        all_sources: bySource, source_count: bySource.length,
        poor_quality: poor, poor_quality_count: poor.length,
        /* AC2 — SOP §20 says do not hide poor-quality sources, and the
           temptation runs the other way: a source with 400 leads and 2 meetings
           makes the dashboard look bad, so the instinct is a minimum-conversion
           filter. That filter is how the channel keeps getting budget. */
        filtered_out: 0,
        note: 'Every source is returned. poor_quality is a RANKING over the same set, not a subset that replaces it.',
      },
    });
  })
);

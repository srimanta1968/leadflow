import { dataService } from '../../services/DataService';
import { readEmpiMetrics } from './identityGateway';
import { readActiveProfile } from './riskProfile';

/**
 * The daily dedup audit required by SOP §22, and the calibration it feeds.
 *
 * WHAT DRIFT MEANS HERE. Not "the number changed" — every number changes. Drift
 * is a measure moving further than a threshold AGAINST THE SAME POLICY VERSION.
 * That qualifier is the whole value: rates move when somebody raises the
 * auto-link threshold, and reporting that as resolver drift would send a steward
 * hunting a model problem that is really a policy change they made themselves.
 * So a run whose profile_version_id differs from the previous run's reports no
 * drift and says why.
 */

/** How far a rate may move day-on-day before it is worth somebody's attention. */
const DRIFT_TOLERANCE = 0.1;

/** ECE above this is a calibration problem regardless of movement. */
const ECE_CEILING = 0.15;

export interface AuditRun {
  run_id: string;
  tenant_id: string;
  profile_version_id: string | null;
  auto_link_rate: number | null;
  false_link_rate: number | null;
  kept_separate_rate: number | null;
  high_risk_precision: number | null;
  calibration_ece: number | null;
  drift_detected: boolean;
  drift_detail: Record<string, unknown>;
  case_link_id: string | null;
  upstream_available: boolean;
  ran_at: string;
  ran_on: string;
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
};

function toRun(row: Record<string, unknown>): AuditRun {
  return {
    run_id: String(row.run_id),
    tenant_id: String(row.tenant_id),
    profile_version_id: row.profile_version_id ? String(row.profile_version_id) : null,
    auto_link_rate: num(row.auto_link_rate),
    false_link_rate: num(row.false_link_rate),
    kept_separate_rate: num(row.kept_separate_rate),
    high_risk_precision: num(row.high_risk_precision),
    calibration_ece: num(row.calibration_ece),
    drift_detected: row.drift_detected === true,
    drift_detail: (row.drift_detail ?? {}) as Record<string, unknown>,
    case_link_id: row.case_link_id ? String(row.case_link_id) : null,
    upstream_available: row.upstream_available === true,
    ran_at: row.ran_at instanceof Date ? row.ran_at.toISOString() : String(row.ran_at),
    ran_on: row.ran_on instanceof Date ? row.ran_on.toISOString().slice(0, 10) : String(row.ran_on),
  };
}

/** Audit runs newest first, for the calibration report's trend. */
export async function listAuditRuns(tenantId: string, days: number): Promise<AuditRun[]> {
  const rows = await dataService.query<Record<string, unknown>>(
    `SELECT * FROM leadflow_dedup_audit_run
      WHERE tenant_id = $1 AND ran_at >= now() - ($2 || ' days')::interval
      ORDER BY ran_at DESC`,
    [tenantId, String(days)]
  );
  return rows.map(toRun);
}

/**
 * Compare today's measures against the previous run.
 *
 * @returns Which measures drifted and by how much. Empty when nothing did, or
 *          when the comparison would be meaningless.
 */
function detectDrift(
  current: { false_link_rate: number | null; high_risk_precision: number | null; calibration_ece: number | null; profile_version_id: string | null },
  previous: AuditRun | null
): Record<string, unknown> {
  const detail: Record<string, unknown> = {};

  // ECE stands alone: a badly calibrated resolver is a problem at ANY movement,
  // and on the very first run there is nothing to compare against but this.
  if (current.calibration_ece !== null && current.calibration_ece > ECE_CEILING) {
    detail.calibration_ece = {
      value: current.calibration_ece,
      ceiling: ECE_CEILING,
      why: 'Expected calibration error is above the ceiling, so the confidence scores do not mean what they claim.',
    };
  }

  if (!previous) {
    return detail;
  }

  /*
   * A POLICY CHANGE IS NOT DRIFT, and conflating them is the most likely wrong
   * conclusion this report could produce. Rates move when somebody raises the
   * auto-link threshold; that is the policy working, not the model degrading.
   */
  if (previous.profile_version_id !== current.profile_version_id) {
    detail.not_compared = {
      why: 'The risk profile changed since the previous audit, so a movement in these rates is the new policy taking effect rather than the resolver drifting.',
      previous_version: previous.profile_version_id,
      current_version: current.profile_version_id,
    };
    return detail;
  }

  const moved = (name: string, now: number | null, before: number | null) => {
    if (now === null || before === null) return;
    const delta = now - before;
    if (Math.abs(delta) >= DRIFT_TOLERANCE) {
      detail[name] = { previous: before, current: now, delta: Number(delta.toFixed(4)), tolerance: DRIFT_TOLERANCE };
    }
  };

  moved('false_link_rate', current.false_link_rate, previous.false_link_rate);
  moved('high_risk_precision', current.high_risk_precision, previous.high_risk_precision);

  return detail;
}

/**
 * Run the daily audit for one tenant.
 *
 * IDEMPOTENT ON THE UTC DAY. The unique index on (tenant_id, ran_on) means a
 * retry after a crash updates the day's row rather than opening a second Data
 * Review case for the same drift — an audit that cries twice is one a steward
 * learns to ignore.
 *
 * @returns The run as recorded, drift verdict included.
 */
export async function runDailyDedupAudit(tenantId: string): Promise<AuditRun> {
  const [metrics, profile] = await Promise.all([readEmpiMetrics(), readActiveProfile(tenantId)]);

  const m = metrics.value;
  const total = num(m?.unresolved_candidate_links);
  const merges = num(m?.total_merges);
  const reversals = num(m?.merge_reversals);

  /*
   * FALSE-LINK RATE IS REVERSALS OVER MERGES, and it is the closest thing to
   * ground truth available: a human went back and undid a link the system made,
   * which is the definition of a false link that somebody noticed. It is a
   * FLOOR, not the true rate — nobody counts the bad links never spotted — and
   * that is worth knowing before anyone treats a low number as reassurance.
   */
  const falseLinkRate = merges !== null && merges > 0 && reversals !== null
    ? Number((reversals / merges).toFixed(4))
    : null;

  const previous = (await listAuditRuns(tenantId, 30)).find((run) => run.ran_on !== todayUtc());

  const measures = {
    // NOT MEASURED rather than zero. The auto-link and kept-separate rates need
    // per-decision outcomes EMPI does not expose; inventing them from the
    // counters it does expose would be arithmetic dressed as measurement.
    auto_link_rate: null as number | null,
    kept_separate_rate: null as number | null,
    false_link_rate: metrics.available ? falseLinkRate : null,
    high_risk_precision: null as number | null,
    calibration_ece: metrics.available ? num(m?.calibration_ece) : null,
    profile_version_id: profile?.version_id ?? null,
  };

  const detail = detectDrift(measures, previous ?? null);
  const drift = Object.keys(detail).filter((k) => k !== 'not_compared').length > 0;

  const inserted = await dataService.queryOne<Record<string, unknown>>(
    `INSERT INTO leadflow_dedup_audit_run
       (tenant_id, profile_version_id, auto_link_rate, false_link_rate,
        kept_separate_rate, high_risk_precision, calibration_ece,
        drift_detected, drift_detail, upstream_available)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
     ON CONFLICT (tenant_id, ran_on) DO UPDATE SET
       profile_version_id = EXCLUDED.profile_version_id,
       false_link_rate    = EXCLUDED.false_link_rate,
       calibration_ece    = EXCLUDED.calibration_ece,
       drift_detected     = EXCLUDED.drift_detected,
       drift_detail       = EXCLUDED.drift_detail,
       upstream_available = EXCLUDED.upstream_available,
       ran_at             = now()
     RETURNING *`,
    [
      tenantId,
      measures.profile_version_id,
      measures.auto_link_rate,
      measures.false_link_rate,
      measures.kept_separate_rate,
      measures.high_risk_precision,
      measures.calibration_ece,
      drift,
      JSON.stringify(detail),
      metrics.available,
    ]
  );

  if (!inserted) {
    throw new Error('dedup audit run could not be recorded');
  }
  return toRun(inserted);
}

/** The audit day, in UTC — matching the column's own default. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

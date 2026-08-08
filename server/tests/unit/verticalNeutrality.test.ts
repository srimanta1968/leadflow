import fs from 'fs';
import path from 'path';
import { dataService } from '../../src/services/DataService';
import {
  BRAND,
  CLOSE_REASONS,
  DISPOSITION_CODES,
  KPI_DEFINITIONS,
  PRIORITY_BANDS,
  STAGES,
  canMoveStage,
} from '../../src/config/verticalProfile';

/**
 * The two boundaries this schema is built around.
 *
 *   AC3 — no SDK-owned domain table is duplicated locally.
 *   AC4 — every vertical-specific value lives in config, not in code.
 *
 * Both are asserted mechanically because both are the kind of rule that holds
 * for exactly as long as somebody is watching. "Don't add a contacts table" and
 * "don't hardcode the customer's name" are obvious in review and invisible six
 * files into a feature.
 */

const SRC = path.resolve(__dirname, '../../src');
const CONFIG = path.join(SRC, 'config');
const MIGRATIONS = path.join(SRC, 'db', 'migrations');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, '/');

/** Every table this codebase creates, read from the migrations themselves. */
function declaredTables(): string[] {
  const sql = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
    .join('\n');
  return [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? ([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
}

/* ------------------------------------------- AC3: the SDK owns the domain */

describe('no SDK-owned domain table is duplicated locally', () => {
  /**
   * Concepts ProjexCloud is the system of record for. A local table that OWNS
   * one of these is the defect: two systems of record drift, and the drift is
   * discovered when a consent revocation is honoured in one and not the other.
   */
  const SDK_OWNED = [
    { concept: 'contact', sdk: 'sdk-source-record / sdk-projection', pattern: /^(contacts?|persons?|people|accounts?|companies|organisations?)$/ },
    { concept: 'consent', sdk: 'sdk-consent', pattern: /^(consents?|consent_records?|consent_receipts?|purposes?)$/ },
    { concept: 'assignment', sdk: 'sdk-assignment', pattern: /^(assignments?|ownership|territories)$/ },
    { concept: 'sequence', sdk: 'sdk-sequence', pattern: /^(sequences?|cadences?|sequence_steps?|enrolments?|enrollments?)$/ },
    { concept: 'appointment', sdk: 'sdk-scheduling', pattern: /^(appointments?|meetings?|bookings?|calendar_events?)$/ },
    { concept: 'payment', sdk: 'sdk-billing', pattern: /^(payments?|invoices?|charges?|subscriptions?|transactions?)$/ },
    { concept: 'audit', sdk: 'sdk-audit', pattern: /^(audit_logs?|audit_events?|audit_trail|event_log)$/ },
  ];

  const tables = declaredTables();

  it('creates no table that owns an SDK concept', () => {
    const offenders = SDK_OWNED.flatMap(({ concept, sdk, pattern }) =>
      tables.filter((t) => pattern.test(t)).map((t) => `${t} duplicates ${concept}, owned by ${sdk}`),
    );
    expect(offenders.join('\n')).toBe('');
  });

  /**
   * Tables that TOUCH an SDK concept without owning it, and the reason.
   *
   * A blanket name ban would be wrong and this is where the nuance goes. A
   * projection is not a duplicate — it is a read cache the screens serve from so
   * a queue does not fan out into one SDK call per row — and local operating
   * configuration is genuinely LeadFlow's to hold. What must never happen is a
   * local table becoming the AUTHORITY, and the test below checks precisely
   * that: for every entry here, the SDK must still be consulted in code.
   */
  const NOT_THE_AUTHORITY = [
    {
      table: 'leads',
      sdk: 'sdk-lead-capture',
      consultedBy: 'services/LeadCaptureService.ts',
      proof: 'SdkGatewayClient',
      why: 'Read projection for the Capture Inbox and dashboards. The canonical record, its provenance assertions and its consent state live upstream.',
    },
    {
      table: 'users',
      sdk: 'sdk-identity',
      consultedBy: 'platform/auth/jwksCache.ts',
      // NOT SdkGatewayClient, and that is the point of making the proof
      // per-entry rather than uniform. Deference here is token VERIFICATION
      // against the issuer's published keys, which cannot route through the
      // gateway — a gateway call needs a verified token, and verifying one needs
      // this document. Asserting "calls SdkGatewayClient" everywhere would have
      // forced either a false claim or a weakened rule.
      proof: 'jwksUri',
      why: 'Session-bound identity projection plus the local credential material the auth adapter uses. ProjexCloud issues and signs the session tokens; LeadFlow verifies them against its JWKS.',
    },
    {
      table: 'sla_policies',
      sdk: 'sdk-sla',
      consultedBy: 'services/SlaMonitorService.ts',
      proof: 'SdkGatewayClient',
      why: 'The tenant TARGET an operator edits, not the verdict. Evaluation runs upstream on the business calendar LeadFlow does not hold; a past deadline stays explainable after the target changes, which needs a durable retirable row.',
    },
    {
      table: 'sla_alerts',
      sdk: 'sdk-notification',
      consultedBy: 'services/SlaAlertService.ts',
      proof: 'SdkGatewayClient',
      why: 'Local escalation state so an alert can be retried after a gateway outage and answered later ("was Priya actually told?"). The delivery itself is upstream.',
    },
  ];

  it.each(NOT_THE_AUTHORITY)('$table still defers to $sdk', ({ table, sdk, consultedBy, proof }) => {
    expect(tables).toContain(table);
    const source = fs.readFileSync(path.join(SRC, consultedBy), 'utf8');
    // The claim "this is a projection, not the authority" is only true if the
    // authority is actually asked. Without this the exception list would be a
    // place to write comfortable sentences. Writing these from memory got three
    // of the four SDK names wrong; the test is what caught that.
    expect(source).toContain(proof);
    expect(source).toContain(sdk);
  });

  it('keeps the projection list honest', () => {
    const stale = NOT_THE_AUTHORITY.filter((e) => !tables.includes(e.table)).map((e) => e.table);
    expect(stale.join('\n')).toBe('');
  });

  it('names every LeadFlow-owned table with the leadflow_ prefix', () => {
    // The boundary should be visible in a `\dt` listing rather than needing this
    // file to explain it.
    const expected = [
      'leadflow_stage_config', 'leadflow_disposition_code', 'leadflow_close_reason',
      'leadflow_template_library', 'leadflow_saved_view', 'leadflow_dashboard_rollup',
      'leadflow_kpi_definition', 'leadflow_certification_score',
      'leadflow_operating_rhythm_digest', 'leadflow_purpose_taxonomy_map',
      'leadflow_routing_config', 'leadflow_outbox',
      // 016 — the event log and what is derived from it.
      'leadflow_event_log', 'leadflow_projection_checkpoint',
      'leadflow_event_dead_letter', 'leadflow_pipeline_projection',
      // 017 — the intake saga and the channel-decision ledger.
      'leadflow_saga_run', 'leadflow_saga_step', 'leadflow_channel_decision',
      // 018 — the escalation ledger and its systemic-incident dedupe.
      'leadflow_escalation_event', 'leadflow_escalation_incident',
    ];
    const missing = expected.filter((t) => !tables.includes(t));
    expect(missing.join('\n')).toBe('');
  });
});

/* --------------------------------------- AC4: the vertical lives in config */

describe('every vertical-specific value lives in config', () => {
  /** Application code — everything outside src/config. */
  const applicationFiles = sourceFiles(SRC).filter((f) => !f.startsWith(CONFIG));

  it('mentions the customer nowhere outside config', () => {
    // Caught three real occurrences in sdrQualifyService: the trading name was
    // baked into an SMS body, an email subject and a fallback phrase, so
    // re-templating for the next vertical would have sent the previous
    // customer's name to a stranger.
    const offenders = applicationFiles
      .filter((f) => /Lynked[\s-]?Up|LUP-/i.test(fs.readFileSync(f, 'utf8')))
      .map(rel)
      // Comments explaining the tenant hierarchy legitimately name the customer;
      // what matters is that no VALUE does. Filter to non-comment lines.
      .filter((r) => {
        const lines = fs.readFileSync(path.join(SRC, r), 'utf8').split('\n');
        return lines.some(
          (l) => /Lynked[\s-]?Up|LUP-/i.test(l) && !/^\s*(\*|\/\/|\/\*)/.test(l),
        );
      });
    expect(offenders.join('\n')).toBe('');
  });

  it('CAN fail — the detector matches a real hardcoded brand', () => {
    // Without this the test above could pass because the regex is broken.
    const line = "      body: `Hi ${name}, this is Lynked Up Pro following up`,";
    expect(/Lynked[\s-]?Up|LUP-/i.test(line) && !/^\s*(\*|\/\/)/.test(line)).toBe(true);
  });

  it('declares all ten SOP §06 stages, in order, with evidence', () => {
    expect(STAGES).toHaveLength(10);
    expect(STAGES.map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const s of STAGES) {
      // Entry evidence is what makes the guard possible. A stage with none can
      // be entered from anywhere, which is the incumbent system's behaviour.
      expect(s.entryEvidence.length).toBeGreaterThan(0);
      // Terminal stages are the only ones allowed to lead nowhere.
      expect(s.allowedNext.length === 0).toBe(s.terminal && s.key !== 'CLOSED_LOST');
    }
  });

  it('refuses an invalid stage move, and says what IS allowed', () => {
    // The defect this replaces: updateDealStage permitted any stage to any
    // stage, so a record could reach Closed Won having never been contacted.
    const jump = canMoveStage('NEW_UNWORKED', 'CLOSED_WON_ONBOARDING_PENDING');
    expect(jump.allowed).toBe(false);
    expect(jump.reason).toContain('Attempting Contact');

    expect(canMoveStage('NEW_UNWORKED', 'ATTEMPTING_CONTACT').allowed).toBe(true);
    // An unknown stage is refused rather than waved through.
    expect(canMoveStage('NEW_UNWORKED', 'MADE_UP').allowed).toBe(false);
    // Won is terminal; reviving goes through Nurture so it carries a reason.
    expect(canMoveStage('CLOSED_WON_ONBOARDING_PENDING', 'NURTURE').allowed).toBe(false);
    expect(canMoveStage('CLOSED_LOST', 'NURTURE').allowed).toBe(true);
  });

  it('keeps every vertical list internally consistent', () => {
    const unique = (xs: string[]) => new Set(xs).size === xs.length;
    expect(unique(STAGES.map((s) => s.key))).toBe(true);
    expect(unique(DISPOSITION_CODES.map((d) => d.key))).toBe(true);
    expect(unique(CLOSE_REASONS.map((r) => r.key))).toBe(true);
    expect(unique(KPI_DEFINITIONS.map((k) => k.key))).toBe(true);
    expect(unique(PRIORITY_BANDS.map((p) => p.key))).toBe(true);

    // Every allowedNext must name a stage that exists, or the guard sends
    // records somewhere undefined.
    const keys = new Set(STAGES.map((s) => s.key));
    for (const s of STAGES) {
      for (const next of s.allowedNext) expect(keys.has(next)).toBe(true);
    }
    // Escalation must come AFTER the response target, or every lead escalates
    // before anyone could have answered it.
    for (const band of PRIORITY_BANDS) {
      expect(band.escalateAfterMinutes).toBeGreaterThan(band.firstResponseMinutes);
    }
    // At least one close reason per outcome, or a record cannot be closed.
    expect(CLOSE_REASONS.some((r) => r.outcome === 'won')).toBe(true);
    expect(CLOSE_REASONS.some((r) => r.outcome === 'lost')).toBe(true);
    // A connection is also an attempt. The reverse is not true, and treating it
    // as true would let a voicemail satisfy "two-way contact confirmed".
    for (const d of DISPOSITION_CODES) {
      if (d.countsAsConnection) expect(d.countsAsAttempt).toBe(true);
    }
  });

  it('exposes the brand and calendar as data rather than literals', () => {
    expect(BRAND.tradingName.length).toBeGreaterThan(0);
    expect(BRAND.accountReferencePrefix).toMatch(/^[A-Z]{2,5}$/);
    expect(BRAND.timezone).toContain('/');
  });
});

/* ---------------------------- AC1 + AC2: the schema provisions and re-runs */

describe('the schema self-provisions and is safe to re-run', () => {
  it('created every leadflow_ table in the live database', async () => {
    // The suite's own beforeAll ran the migrations against a real Postgres, so
    // this asserts the runner actually provisioned rather than that the SQL
    // parses. A fresh environment takes exactly this path at first boot.
    const rows = await dataService.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'leadflow\\_%'`,
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      'leadflow_certification_score',
      'leadflow_channel_decision',
      'leadflow_close_reason',
      'leadflow_dashboard_rollup',
      'leadflow_disposition_code',
      'leadflow_escalation_event',
      'leadflow_escalation_incident',
      'leadflow_event_dead_letter',
      'leadflow_event_log',
      'leadflow_kpi_definition',
      'leadflow_operating_rhythm_digest',
      'leadflow_outbox',
      'leadflow_pipeline_projection',
      'leadflow_projection_checkpoint',
      'leadflow_purpose_taxonomy_map',
      'leadflow_routing_config',
      'leadflow_saga_run',
      'leadflow_saga_step',
      'leadflow_saved_view',
      'leadflow_stage_config',
      'leadflow_template_library',
    ]);
  });

  it('writes only additive, idempotent DDL', () => {
    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    const problems: string[] = [];
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
      // Comments legitimately discuss DROP; statements must not perform one.
      const statements = sql
        .split('\n')
        .filter((l) => !/^\s*--/.test(l))
        .join('\n');
      // Forward-only: a migration that drops or truncates cannot be re-run, and
      // on a partially-applied environment it destroys what the previous run made.
      if (/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i.test(statements)) problems.push(`${file}: DROP`);
      if (/\bTRUNCATE\b/i.test(statements)) problems.push(`${file}: TRUNCATE`);
      // Every CREATE must be guarded, or a re-run raises rather than no-ops.
      for (const m of statements.matchAll(/CREATE (?:UNIQUE )?(TABLE|INDEX)\s+(?!IF NOT EXISTS)/gi)) {
        problems.push(`${file}: unguarded CREATE ${m[1]}`);
      }
    }
    expect(problems.join('\n')).toBe('');
  });

  it('never runs DDL on module import', async () => {
    // bootstrap() migrates, seeds and provisions. At module scope, merely
    // importing app.ts would do all three against whatever database the
    // environment points at.
    const app = fs.readFileSync(path.join(SRC, 'app.ts'), 'utf8');
    expect(app).toContain('if (require.main === module)');
    expect(app.indexOf('if (require.main === module)')).toBeLessThan(app.indexOf('bootstrap().catch'));

    // And DDL lives in exactly one place.
    const ddlOutsideMigrations = sourceFiles(SRC)
      .filter((f) => !f.endsWith('migrationRunner.ts'))
      .filter((f) => /\b(CREATE TABLE|ALTER TABLE|DROP TABLE)\b/i.test(fs.readFileSync(f, 'utf8')))
      .map(rel);
    expect(ddlOutsideMigrations.join('\n')).toBe('');
  });
});

import { dataService } from '../services/DataService';
import { CONSENT_PURPOSES } from '../config/consentPurposes';
import {
  CLOSE_REASONS,
  DISPOSITION_CODES,
  KPI_DEFINITIONS,
  STAGES,
} from '../config/verticalProfile';

/**
 * Projects the vertical profile into the config tables, at boot.
 *
 * WHY THE VALUES ARE NOT IN THE MIGRATION. A migration is applied once and never
 * edited; the vertical profile is edited whenever the customer renames a stage
 * or retires a disposition code. Seeding INSERTs into DDL would make every such
 * change a new migration file, and re-templating for the next vertical a schema
 * rewrite — which is precisely the coupling this task exists to remove.
 *
 * WHY A TABLE AT ALL, if the file is the source of truth. Two reasons, and
 * neither is redundancy: SQL that reports on stages needs to JOIN against them
 * rather than have the application post-filter, and an operator changing a
 * target at 2am needs a row to change. The file remains authoritative — this
 * runs on every boot and overwrites drift.
 *
 * UPSERT, NEVER DELETE-AND-INSERT. A stage key is referenced by live records; a
 * truncate would break those references for the length of the transaction and,
 * on a failure partway, permanently. Rows the profile no longer names are marked
 * retired where the table supports it and otherwise left alone — removing a
 * disposition code that history refers to would orphan the history.
 */

export interface VerticalSeedResult {
  stages: number;
  dispositions: number;
  closeReasons: number;
  kpis: number;
  purposes: number;
  retired: number;
}

export async function seedVerticalProfile(): Promise<VerticalSeedResult> {
  const result: VerticalSeedResult = {
    stages: 0,
    dispositions: 0,
    closeReasons: 0,
    kpis: 0,
    purposes: 0,
    retired: 0,
  };

  for (const s of STAGES) {
    await dataService.query(
      `INSERT INTO leadflow_stage_config
         (stage_key, position, label, entry_evidence, exit_evidence,
          stale_after_business_days, allowed_next, terminal, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8, NOW())
       ON CONFLICT (stage_key) DO UPDATE SET
         position = EXCLUDED.position,
         label = EXCLUDED.label,
         entry_evidence = EXCLUDED.entry_evidence,
         exit_evidence = EXCLUDED.exit_evidence,
         stale_after_business_days = EXCLUDED.stale_after_business_days,
         allowed_next = EXCLUDED.allowed_next,
         terminal = EXCLUDED.terminal,
         updated_at = NOW()`,
      [
        s.key,
        s.position,
        s.label,
        JSON.stringify(s.entryEvidence),
        JSON.stringify(s.exitEvidence),
        s.staleAfterBusinessDays,
        JSON.stringify(s.allowedNext),
        s.terminal,
      ],
    );
    result.stages += 1;
  }

  for (const d of DISPOSITION_CODES) {
    await dataService.query(
      `INSERT INTO leadflow_disposition_code
         (code_key, label, channel, counts_as_attempt, counts_as_connection, retired_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, NOW())
       ON CONFLICT (code_key) DO UPDATE SET
         label = EXCLUDED.label,
         channel = EXCLUDED.channel,
         counts_as_attempt = EXCLUDED.counts_as_attempt,
         counts_as_connection = EXCLUDED.counts_as_connection,
         -- Un-retires a code the profile has brought back, which is the only
         -- way to reverse a retirement without a manual UPDATE.
         retired_at = NULL,
         updated_at = NOW()`,
      [d.key, d.label, d.channel, d.countsAsAttempt, d.countsAsConnection],
    );
    result.dispositions += 1;
  }

  // Retire, do not delete. History refers to these codes, and a deleted row
  // turns a past disposition into an unreadable key.
  const retiredDispositions = await dataService.query<{ code_key: string }>(
    `UPDATE leadflow_disposition_code
        SET retired_at = NOW()
      WHERE retired_at IS NULL
        AND code_key <> ALL($1::text[])
      RETURNING code_key`,
    [DISPOSITION_CODES.map((d) => d.key)],
  );
  result.retired += retiredDispositions.length;

  for (const r of CLOSE_REASONS) {
    await dataService.query(
      `INSERT INTO leadflow_close_reason
         (reason_key, label, outcome, revisitable, retired_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, NOW())
       ON CONFLICT (reason_key) DO UPDATE SET
         label = EXCLUDED.label,
         outcome = EXCLUDED.outcome,
         revisitable = EXCLUDED.revisitable,
         retired_at = NULL,
         updated_at = NOW()`,
      [r.key, r.label, r.outcome, r.revisitable],
    );
    result.closeReasons += 1;
  }

  const retiredReasons = await dataService.query<{ reason_key: string }>(
    `UPDATE leadflow_close_reason
        SET retired_at = NOW()
      WHERE retired_at IS NULL
        AND reason_key <> ALL($1::text[])
      RETURNING reason_key`,
    [CLOSE_REASONS.map((r) => r.key)],
  );
  result.retired += retiredReasons.length;

  for (const k of KPI_DEFINITIONS) {
    await dataService.query(
      `INSERT INTO leadflow_kpi_definition
         (kpi_key, label, unit, higher_is_better, target, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (kpi_key) DO UPDATE SET
         label = EXCLUDED.label,
         unit = EXCLUDED.unit,
         higher_is_better = EXCLUDED.higher_is_better,
         target = EXCLUDED.target,
         updated_at = NOW()`,
      [k.key, k.label, k.unit, k.higherIsBetter, k.target],
    );
    result.kpis += 1;
  }

  // Labels come straight from CONSENT_PURPOSES rather than a second list in
  // verticalProfile. A purpose's wording already has a home, and the copy that
  // would have lost a drift is the one on the consent screen.
  for (const purpose of CONSENT_PURPOSES) {
    await dataService.query(
      `INSERT INTO leadflow_purpose_taxonomy_map (purpose_key, display_label, elective, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (purpose_key) DO UPDATE SET
         display_label = EXCLUDED.display_label,
         elective = EXCLUDED.elective,
         updated_at = NOW()`,
      // elective is the inverse of service-necessary: a purpose needed to
      // deliver what the person asked for is not an optional extra.
      [purpose.key, purpose.label, !purpose.serviceNecessary],
    );
    result.purposes += 1;
  }

  return result;
}

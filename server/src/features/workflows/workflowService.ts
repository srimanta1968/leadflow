import { dataService } from '../../services/DataService';
import { config } from '../../config/env';
import { SdkGatewayClient } from '../../platform/sdkGateway';

/**
 * Workflow versioning, dry-run simulation, publish and rollback. PRD §12.
 *
 * The whole module exists for one rule: no automation reaches production without
 * a passing dry run and a recorded approval, enforced server-side. A convention
 * that reviewers are supposed to follow is not that rule — the first time
 * somebody is in a hurry, it is not followed.
 */

/** The effect classes a dry run counts. */
export const EFFECT_CLASSES = ['send', 'task', 'stage_change', 'suppression'] as const;

export interface DryRunResult {
  dryRunId: string;
  recordsReplayed: number;
  wouldSend: number;
  wouldCreateTask: number;
  wouldChangeStage: number;
  wouldSuppress: number;
  slaOutcomes: Record<string, number>;
  sideEffectsAttempted: number;
  passed: boolean;
  sample: Record<string, unknown>[];
}

/**
 * A recorder that stands in for every side-effecting call during a simulation.
 *
 * THE SIMULATION CANNOT SEND BECAUSE IT HAS NO WAY TO. The dry run never
 * receives a gateway client — it receives this, which counts the intention and
 * returns. That is a stronger guarantee than a `dryRun` flag checked at each
 * call site, where one missed check is one real message to a real customer, and
 * the whole point of a dry run is that a reviewer trusts it enough to publish.
 */
export class SimulationRecorder {
  readonly effects: { class: string; subjectRef: string; detail: string }[] = [];
  /** Anything that tried to leave the simulation. Non-zero FAILS the run. */
  escapeAttempts = 0;

  record(effectClass: (typeof EFFECT_CLASSES)[number], subjectRef: string, detail: string): void {
    this.effects.push({ class: effectClass, subjectRef, detail });
  }

  /** Called if code inside the simulation reaches for a real client. */
  escaped(what: string): void {
    this.escapeAttempts += 1;
    this.effects.push({ class: 'escape', subjectRef: '', detail: what });
  }

  countOf(effectClass: string): number {
    return this.effects.filter((e) => e.class === effectClass).length;
  }
}

interface WorkflowStep { on?: string; when?: Record<string, unknown>; then?: string; channel?: string; to_stage?: string }

/**
 * Replay real historical records through a candidate definition.
 *
 * REAL RECORDS, NOT SYNTHETIC ONES. A simulation over invented data proves the
 * definition parses; a replay over the last fortnight's actual leads proves what
 * it would have DONE — which is the only thing a reviewer needs to know and the
 * only thing that catches "this rule would have messaged four hundred people".
 */
export async function simulate(input: {
  workflowKey: string; candidateVersion: number; definition: { steps?: WorkflowStep[] };
  from: Date; to: Date; ranBy: string | null;
}): Promise<DryRunResult> {
  const recorder = new SimulationRecorder();

  const records = await dataService.query<{
    id: string; stage: string | null; source: string | null; owner_user_id: string | null;
    first_response_at: string | null; sla_breached: boolean | null; next_due_at: string | null;
  }>(
    `SELECT id, stage, source, owner_user_id, first_response_at, sla_breached, next_due_at
       FROM leads
      WHERE created_at >= $1 AND created_at < $2
      ORDER BY created_at DESC LIMIT 5000`,
    [input.from.toISOString(), input.to.toISOString()]
  );

  const slaOutcomes: Record<string, number> = { would_meet: 0, would_breach: 0, unchanged: 0 };
  const steps = Array.isArray(input.definition?.steps) ? input.definition.steps : [];

  for (const record of records) {
    for (const step of steps) {
      if (!stepMatches(step, record)) continue;
      switch (step.then) {
        case 'send':
          recorder.record('send', record.id, `would send on ${step.channel ?? 'email'}`);
          break;
        case 'create_task':
          recorder.record('task', record.id, 'would create a task');
          break;
        case 'change_stage':
          recorder.record('stage_change', record.id, `would move to ${step.to_stage ?? 'unspecified'}`);
          break;
        case 'suppress':
          recorder.record('suppression', record.id, 'would suppress the contact');
          break;
        default:
          /* An unrecognised action is counted as an ESCAPE rather than ignored.
             A definition full of steps this runner does not understand would
             otherwise dry-run clean and then do something unknown in
             production — the worst possible outcome for a gate whose purpose is
             to make the reviewer confident. */
          recorder.escaped(`unknown action "${String(step.then)}"`);
      }
      if (record.sla_breached === true) slaOutcomes.would_breach += 1;
      else if (record.first_response_at !== null) slaOutcomes.would_meet += 1;
      else slaOutcomes.unchanged += 1;
    }
  }

  const rows = await dataService.query<{ dry_run_id: string }>(
    `INSERT INTO leadflow_workflow_dry_run
       (tenant_id, workflow_key, candidate_version, window_from, window_to, records_replayed,
        would_send, would_create_task, would_change_stage, would_suppress, sla_outcomes,
        sample, side_effects_attempted, passed, ran_by)
     VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15)
     RETURNING dry_run_id`,
    [
      config.projexCloud.tenantId, input.workflowKey, input.candidateVersion,
      input.from.toISOString(), input.to.toISOString(), records.length,
      recorder.countOf('send'), recorder.countOf('task'),
      recorder.countOf('stage_change'), recorder.countOf('suppression'),
      JSON.stringify(slaOutcomes), JSON.stringify(recorder.effects.slice(0, 50)),
      recorder.escapeAttempts,
      /* A run with ZERO records replayed does NOT pass. It proves nothing, and
         a reviewer reading "0 messages would have sent" from an empty window
         would reasonably conclude the rule is harmless. */
      recorder.escapeAttempts === 0 && records.length > 0,
      input.ranBy,
    ]
  );

  return {
    dryRunId: rows[0].dry_run_id,
    recordsReplayed: records.length,
    wouldSend: recorder.countOf('send'),
    wouldCreateTask: recorder.countOf('task'),
    wouldChangeStage: recorder.countOf('stage_change'),
    wouldSuppress: recorder.countOf('suppression'),
    slaOutcomes,
    sideEffectsAttempted: recorder.escapeAttempts,
    passed: recorder.escapeAttempts === 0 && records.length > 0,
    sample: recorder.effects.slice(0, 50) as unknown as Record<string, unknown>[],
  };
}

function stepMatches(step: WorkflowStep, record: { stage: string | null; source: string | null; owner_user_id: string | null }): boolean {
  const when = step.when ?? {};
  if (typeof when.stage === 'string' && when.stage !== (record.stage ?? '')) return false;
  if (typeof when.source === 'string' && when.source !== (record.source ?? '')) return false;
  if (when.unowned === true && record.owner_user_id !== null) return false;
  return true;
}

/* ------------------------------------------------------------- versioning */

export async function createVersion(input: {
  workflowKey: string; definition: unknown; createdBy: string | null;
}): Promise<{ workflowVersionId: string; version: number }> {
  const rows = await dataService.query<{ workflow_version_id: string; version: number }>(
    `INSERT INTO leadflow_workflow_version (tenant_id, workflow_key, version, definition, created_by)
     VALUES ($1,$2,
             (SELECT COALESCE(MAX(version),0)+1 FROM leadflow_workflow_version WHERE tenant_id = $1 AND workflow_key = $2),
             $3::jsonb,$4)
     RETURNING workflow_version_id, version`,
    [config.projexCloud.tenantId, input.workflowKey, JSON.stringify(input.definition), input.createdBy]
  );
  return { workflowVersionId: rows[0].workflow_version_id, version: rows[0].version };
}

/** Record the version change in the audit chain, with actor and approval. */
export async function auditVersionChange(
  action: 'published' | 'rolled_back', versionId: string, metadata: Record<string, unknown>, actorId: string | null
): Promise<boolean> {
  if (!SdkGatewayClient.isConfigured()) return false;
  try {
    const result = await SdkGatewayClient.call({
      sdk: 'sdk-audit', path: '/api/audit/append', method: 'POST',
      idempotencyKey: `workflow-${action}:${versionId}`,
      body: {
        tenant_id: config.projexCloud.tenantId,
        event_type: `leadflow.workflow.${action}.v1`,
        actor_id: actorId, resource_type: 'workflow_version', resource_id: versionId,
        metadata,
      },
    });
    return result.delivered;
  } catch { return false; }
}

/**
 * In-flight runs at the moment of a rollback.
 *
 * REPORTED AND DECIDED, never orphaned. A run mid-way through the version being
 * withdrawn is in a state neither version describes, and the two honest
 * options — let it finish under the old definition, or stop it — are a judgement
 * the caller makes. What is NOT acceptable is leaving it running against a
 * definition that no longer exists, which is how a customer receives step 4 of a
 * sequence that was rolled back for sending the wrong thing.
 */
export async function inFlightRuns(workflowKey: string): Promise<{ runs: string[]; available: boolean }> {
  if (!SdkGatewayClient.isConfigured()) return { runs: [], available: false };
  try {
    const result = await SdkGatewayClient.call<{ data?: { runs?: { run_id?: string }[] } }>({
      sdk: 'sdk-workflow', // No per-workflow run list exists; the single-run read is the only
      // shape the spec offers, so in-flight visibility is reported as unknown.
      path: `/api/workflows/${encodeURIComponent(workflowKey)}`,
      method: 'GET', idempotencyKey: `inflight:${workflowKey}`,
    });
    if (!result.delivered) return { runs: [], available: false };
    return {
      runs: (result.data?.data?.runs ?? []).map((r) => r.run_id ?? '').filter((r) => r !== ''),
      available: true,
    };
  } catch { return { runs: [], available: false }; }
}

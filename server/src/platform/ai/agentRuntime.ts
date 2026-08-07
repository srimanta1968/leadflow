import { randomUUID } from 'crypto';
import { AiAgentDefinition, agentByKey, agentHasCapability } from '../../config/aiAgents';
import { dataService } from '../../services/DataService';
import { SdkGatewayClient } from '../../platform/sdkGateway';
import { AppError, ErrorCodes } from '../../utils/errors';
import { appendAuditEntry } from '../audit/auditLog';
import { AUDIT_EVENTS } from '../audit/vocabulary';
import { engageKillSwitch, killSwitchState } from './killSwitch';

/**
 * The agent runtime — starting runs, minting the capability tokens they act
 * through, and halting everything when the switch is pulled.
 *
 * sdk-agent-runtime holds the runs; this holds LeadFlow's own record of them.
 * THE DUPLICATION IS THE POINT, and it is worth being explicit about: the kill
 * switch has to halt every run immediately, and the moment the switch is pulled
 * is the moment you least want to depend on the availability and honesty of the
 * service being halted. Halting from the local table works even when the runtime
 * does not answer.
 *
 * A CAPABILITY TOKEN IS MINTED PER RUN, NEVER PER AGENT. A long-lived token
 * scoped to an agent is a standing grant: it outlives the work it was for, and
 * whoever holds a copy keeps the access. Per-run means the grant expires with
 * the thing it was needed for.
 */

/** How long an issued capability token is valid. */
function tokenTtlMs(): number {
  // Fifteen minutes. Long enough for any run this application starts, short
  // enough that a leaked token is worth little by the time anybody notices.
  return parseInt(process.env.AI_CAPABILITY_TOKEN_TTL_MS || '900000', 10);
}

export interface AgentRun {
  id: string;
  agentKey: string;
  upstreamRunId: string | null;
  status: 'running' | 'completed' | 'halted' | 'failed';
  traceId: string;
  startedAt: string;
}

export interface CapabilityToken {
  id: string;
  runId: string;
  agentKey: string;
  /** EXACTLY the capabilities the agent is registered with, never more. */
  capabilities: string[];
  expiresAt: string;
  /**
   * The credential, when the runtime issued one.
   *
   * RETURNED, NEVER STORED. The caller passes it to the agent for the duration
   * of the run; the row in `ai_capability_token` keeps the scope and the
   * lifecycle so a later question about reach is answerable without the secret
   * being at rest anywhere.
   */
  secret: string | null;
}

interface RunRow {
  id: string;
  agent_key: string;
  upstream_run_id: string | null;
  status: AgentRun['status'];
  trace_id: string;
  started_at: Date;
}

function toRun(row: RunRow): AgentRun {
  return {
    id: row.id,
    agentKey: row.agent_key,
    upstreamRunId: row.upstream_run_id,
    status: row.status,
    traceId: row.trace_id,
    startedAt: row.started_at.toISOString(),
  };
}

/**
 * Start a run.
 *
 * @throws AppError(503 AI_HALTED) when the kill switch is engaged.
 */
export async function startRun(input: {
  agentKey: string;
  startedBy?: string | null;
}): Promise<AgentRun> {
  const agent = agentByKey(input.agentKey);
  if (!agent) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `No AI agent is registered under '${input.agentKey}'`
    );
  }

  // Checked HERE as well as inside `complete`, and not only there. A run that
  // starts while halted would sit in the table looking live, and the operator
  // watching the queue drain would see it grow.
  const state = await killSwitchState();
  if (state.engaged) {
    throw new AppError(
      503,
      ErrorCodes.AI_HALTED,
      state.reason ?? 'AI generation is halted by the global kill switch'
    );
  }

  const traceId = `tr_${randomUUID()}`;
  const row = await dataService.queryOne<RunRow>(
    `INSERT INTO ai_agent_run (agent_key, status, trace_id, started_by)
     VALUES ($1, 'running', $2, $3)
     RETURNING id, agent_key, upstream_run_id, status, trace_id, started_at`,
    [agent.key, traceId, input.startedBy ?? null]
  );

  const run = toRun(row!);

  if (SdkGatewayClient.isConfigured()) {
    try {
      const result = await SdkGatewayClient.call<{ data?: { run_id?: string } }>({
        sdk: 'sdk-agent-runtime',
        path: '/api/agent-runtime/runs',
        method: 'POST',
        idempotencyKey: run.id,
        correlationId: traceId,
        body: { agent: agent.key, trace_id: traceId, local_run_id: run.id },
      });
      const upstreamRunId = result.data?.data?.run_id ?? null;
      if (upstreamRunId) {
        await dataService.query('UPDATE ai_agent_run SET upstream_run_id = $2 WHERE id = $1', [
          run.id,
          upstreamRunId,
        ]);
        run.upstreamRunId = upstreamRunId;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The local run stands. An unreachable runtime means the agent cannot do
      // upstream work, which its capability token would have gated anyway — and
      // failing the whole run here would lose the record that it was attempted.
      console.error(`[agentRuntime] could not register run ${run.id} upstream:`, message);
    }
  }

  await appendAuditEntry({
    event: AUDIT_EVENTS.AI_RUN_STARTED,
    actor: input.startedBy ?? 'system',
    personaRole: 'system',
    purpose: agent.consentPurpose,
    decisionRef: `agent:${agent.key}`,
    evidenceRef: `run:${run.id}`,
    causationId: traceId,
    idempotencyRef: `run-start:${run.id}`,
    subjectId: run.id,
    subjectType: 'ai_agent_run',
  });

  return run;
}

/**
 * Mint the capability token a run acts through.
 *
 * REFUSES ANY CAPABILITY THE AGENT IS NOT REGISTERED WITH. This is the entire
 * mechanism behind "minimum necessary access": the registry is the ceiling, and
 * a call site asking for more gets an error rather than a wider token. Asking
 * for FEWER is fine and encouraged — a run that only reads should not carry the
 * write capability its agent is allowed.
 *
 * @param requested Subset of the agent's registered capabilities. Omit for all.
 * @throws AppError(403 AI_CAPABILITY_NOT_DECLARED) for anything outside the registry.
 */
export async function mintCapabilityToken(input: {
  runId: string;
  agentKey: string;
  requested?: string[];
}): Promise<CapabilityToken> {
  const agent = agentByKey(input.agentKey);
  if (!agent) {
    throw new AppError(
      400,
      ErrorCodes.VALIDATION_ERROR,
      `No AI agent is registered under '${input.agentKey}'`
    );
  }

  const capabilities = input.requested ?? [...agent.capabilities];
  const undeclared = capabilities.filter((capability) => !agentHasCapability(agent, capability));

  if (undeclared.length > 0) {
    throw new AppError(
      403,
      ErrorCodes.AI_CAPABILITY_NOT_DECLARED,
      `Agent '${agent.key}' is not registered for: ${undeclared.join(', ')}. Add it to config/aiAgents.ts if it is genuinely needed.`
    );
  }

  const expiresAt = new Date(Date.now() + tokenTtlMs()).toISOString();
  const upstream = await issueUpstreamToken(agent, input.runId, capabilities, expiresAt);

  const row = await dataService.queryOne<{ id: string }>(
    `INSERT INTO ai_capability_token (run_id, agent_key, upstream_token_id, capabilities, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.runId, agent.key, upstream.tokenId, JSON.stringify(capabilities), expiresAt]
  );

  await appendAuditEntry({
    event: AUDIT_EVENTS.AI_CAPABILITY_TOKEN_ISSUED,
    actor: 'system',
    personaRole: 'system',
    purpose: agent.consentPurpose,
    decisionRef: `agent-capabilities:${capabilities.join(',')}`,
    evidenceRef: `capability_token:${row!.id}`,
    causationId: input.runId,
    idempotencyRef: `capability-token:${row!.id}`,
    subjectId: row!.id,
    subjectType: 'ai_capability_token',
    // The SCOPE in the ledger, never the credential. "What was this agent
    // allowed to touch" has to survive the token's expiry.
    metadata: { capabilities, run_id: input.runId },
  });

  return {
    id: row!.id,
    runId: input.runId,
    agentKey: agent.key,
    capabilities,
    expiresAt,
    secret: upstream.secret,
  };
}

/** Ask sdk-agent-runtime for the credential, when it is reachable. */
async function issueUpstreamToken(
  agent: AiAgentDefinition,
  runId: string,
  capabilities: string[],
  expiresAt: string
): Promise<{ tokenId: string | null; secret: string | null }> {
  if (!SdkGatewayClient.isConfigured()) {
    return { tokenId: null, secret: null };
  }

  try {
    const result = await SdkGatewayClient.call<{
      data?: { token_id?: string; token?: string };
    }>({
      sdk: 'sdk-agent-runtime',
      path: '/api/agent-runtime/tokens',
      method: 'POST',
      idempotencyKey: `capability:${runId}:${capabilities.join(',')}`,
      body: {
        agent: agent.key,
        run_id: runId,
        capabilities,
        expires_at: expiresAt,
      },
    });
    return {
      tokenId: result.data?.data?.token_id ?? null,
      secret: result.data?.data?.token ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // No token means the agent can do no upstream work, which is the correct
    // outcome of an unreachable runtime — a locally-invented credential would be
    // worse than none, because it would look like authority.
    console.error(`[agentRuntime] could not mint a capability token for run ${runId}:`, message);
    return { tokenId: null, secret: null };
  }
}

/** Revoke one token before its expiry. */
export async function revokeCapabilityToken(tokenId: string, reason: string): Promise<void> {
  const row = await dataService.queryOne<{
    id: string;
    upstream_token_id: string | null;
    agent_key: string;
  }>(
    `UPDATE ai_capability_token
        SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id, upstream_token_id, agent_key`,
    [tokenId, reason.slice(0, 128)]
  );

  if (!row) {
    return;
  }

  if (row.upstream_token_id && SdkGatewayClient.isConfigured()) {
    try {
      await SdkGatewayClient.call({
        sdk: 'sdk-agent-runtime',
        path: `/api/agent-runtime/tokens/${encodeURIComponent(row.upstream_token_id)}/revoke`,
        method: 'POST',
        idempotencyKey: `revoke:${row.id}`,
        body: { reason },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Locally revoked, upstream still live. Loud, because the token is still
      // usable by anyone holding it until it expires.
      console.error(`[agentRuntime] token ${row.id} REVOKED LOCALLY ONLY:`, message);
    }
  }

  await appendAuditEntry({
    event: AUDIT_EVENTS.AI_CAPABILITY_TOKEN_REVOKED,
    actor: 'system',
    personaRole: 'system',
    purpose: 'security_operations',
    decisionRef: `revoke:${reason}`,
    evidenceRef: `capability_token:${row.id}`,
    causationId: row.id,
    idempotencyRef: `capability-revoke:${row.id}`,
    subjectId: row.id,
    subjectType: 'ai_capability_token',
    metadata: { reason },
  });
}

/** Close a run that finished on its own. */
export async function endRun(runId: string, status: 'completed' | 'failed'): Promise<void> {
  await dataService.query(
    `UPDATE ai_agent_run SET status = $2, ended_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'running'`,
    [runId, status]
  );
  await revokeRunTokens(runId, `run_${status}`);
}

/** Revoke every live token issued for a run. */
async function revokeRunTokens(runId: string, reason: string): Promise<void> {
  const tokens = await dataService.query<{ id: string }>(
    'SELECT id FROM ai_capability_token WHERE run_id = $1 AND revoked_at IS NULL',
    [runId]
  );
  for (const token of tokens) {
    await revokeCapabilityToken(token.id, reason);
  }
}

export interface HaltSummary {
  runsHalted: number;
  tokensRevoked: number;
  /** Whether the switch also reached sdk-feature-flags. */
  propagated: boolean;
}

/**
 * Pull the kill switch and halt everything.
 *
 * THE LOCAL HALT COMES FIRST AND DOES NOT DEPEND ON ANY REMOTE CALL. Every
 * running row is marked halted and every live capability token revoked using
 * this database alone, so an agent whose token is checked upstream loses its
 * access even if the runtime never hears from us. Only then does it try to tell
 * the runtime and the flag service.
 *
 * REVOKING THE TOKENS IS WHAT MAKES IT IMMEDIATE, not marking the rows. A run
 * with a live capability token can keep acting until somebody stops it; a run
 * whose token has been revoked is refused at the next thing it touches.
 */
export async function haltAllRuns(reason: string): Promise<HaltSummary> {
  const { propagated } = await engageKillSwitch(reason);

  const halted = await dataService.query<{ id: string; upstream_run_id: string | null }>(
    `UPDATE ai_agent_run
        SET status = 'halted', ended_at = CURRENT_TIMESTAMP, halted_reason = $1
      WHERE status = 'running'
      RETURNING id, upstream_run_id`,
    [reason.slice(0, 128)]
  );

  const tokens = await dataService.query<{ id: string }>(
    `UPDATE ai_capability_token
        SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'kill_switch'
      WHERE revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
      RETURNING id`,
    []
  );

  for (const run of halted) {
    if (run.upstream_run_id && SdkGatewayClient.isConfigured()) {
      try {
        await SdkGatewayClient.call({
          sdk: 'sdk-agent-runtime',
          path: `/api/agent-runtime/runs/${encodeURIComponent(run.upstream_run_id)}/rollback`,
          method: 'POST',
          idempotencyKey: `halt:${run.id}`,
          body: { reason },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[agentRuntime] run ${run.id} halted locally, not upstream:`, message);
      }
    }
  }

  await appendAuditEntry({
    event: AUDIT_EVENTS.AI_KILL_SWITCH_ENGAGED,
    actor: 'system',
    personaRole: 'system',
    purpose: 'security_operations',
    decisionRef: `kill-switch:${reason}`,
    evidenceRef: `runs-halted:${halted.length}`,
    causationId: randomUUID(),
    idempotencyRef: `kill-switch:${Date.now()}`,
    metadata: {
      reason,
      runs_halted: halted.length,
      tokens_revoked: tokens.length,
      propagated,
    },
  });

  return { runsHalted: halted.length, tokensRevoked: tokens.length, propagated };
}

/** Runs still marked running. The queue an operator watches. */
export async function activeRuns(): Promise<AgentRun[]> {
  const rows = await dataService.query<RunRow>(
    `SELECT id, agent_key, upstream_run_id, status, trace_id, started_at
       FROM ai_agent_run WHERE status = 'running' ORDER BY started_at`,
    []
  );
  return rows.map(toRun);
}

/**
 * Replay a run against sdk-agent-runtime.
 *
 * Available only for a run the runtime knows about — a run that was never
 * registered upstream has nothing to replay from, and pretending otherwise would
 * produce a "replayed" result generated from scratch, which is the opposite of
 * what a replay is for.
 */
export async function replayRun(runId: string): Promise<{ replayed: boolean; detail: string }> {
  const run = await dataService.queryOne<RunRow>(
    `SELECT id, agent_key, upstream_run_id, status, trace_id, started_at
       FROM ai_agent_run WHERE id = $1`,
    [runId]
  );

  if (!run) {
    throw new AppError(404, ErrorCodes.NOT_FOUND, 'Agent run not found');
  }
  if (!run.upstream_run_id || !SdkGatewayClient.isConfigured()) {
    return { replayed: false, detail: 'This run was never registered with the agent runtime.' };
  }

  const state = await killSwitchState();
  if (state.engaged) {
    throw new AppError(503, ErrorCodes.AI_HALTED, state.reason ?? 'AI generation is halted');
  }

  await SdkGatewayClient.call({
    sdk: 'sdk-agent-runtime',
    path: `/api/agent-runtime/runs/${encodeURIComponent(run.upstream_run_id)}/replay`,
    method: 'POST',
    idempotencyKey: `replay:${run.id}`,
    body: { trace_id: run.trace_id },
  });

  return { replayed: true, detail: `Replay requested for upstream run ${run.upstream_run_id}` };
}

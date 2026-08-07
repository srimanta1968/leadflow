import { SdkGatewayClient } from '../../platform/sdkGateway';
import { AppError, ErrorCodes } from '../../utils/errors';

/**
 * The global AI kill switch.
 *
 * ONE FLAG, CHECKED BY EVERY ENTRY POINT. Not a per-agent disable and not a
 * config redeploy: the situation this exists for is "the model is saying
 * something it must not, and we do not yet know which agent" — and in that
 * situation the operator needs one control that stops all of it, not a list to
 * work through.
 *
 * The flag lives in sdk-feature-flags so that pulling it halts every process,
 * not just the one the operator happened to reach. `AI_KILL_SWITCH` is the local
 * equivalent for a deployment with no flag service.
 */

/** Where the current answer came from. */
export type KillSwitchSource =
  /** Read from sdk-feature-flags just now. */
  | 'flag_service'
  /** Cached from a recent read of the flag service. */
  | 'cached'
  /** The local environment variable, used when no flag service is configured. */
  | 'local_env'
  /** The flag service is configured and could not be read. See `engagedOnUnreadable`. */
  | 'unreadable';

export interface KillSwitchState {
  engaged: boolean;
  source: KillSwitchSource;
  /** Why it is engaged, when it is. */
  reason: string | null;
  checkedAt: string;
}

/**
 * The flag this reads.
 *
 * A CONFIGURED ID, not a hardcoded name, for the same reason the capture domain
 * policy is configured: the flag has to exist in the tenant's flag service, and
 * a name this code invents would silently resolve to nothing.
 */
function flagId(): string {
  return process.env.AI_KILL_SWITCH_FLAG_ID || '';
}

/** Whether the local override is pulled. */
function localEngaged(): boolean {
  return process.env.AI_KILL_SWITCH === 'engaged';
}

/**
 * How long a read of the flag service is trusted.
 *
 * THIS IS THE HONEST COST OF "IMMEDIATELY". Checking the flag service on every
 * completion would make the switch instant and would also put a network call in
 * front of every token, so a flag-service slowdown becomes an AI outage. Five
 * seconds is the compromise: an operator pulling the switch stops generation
 * across the fleet within one cache window, and the process where they pulled it
 * stops in the same tick (see `engageKillSwitch`, which writes the local state
 * before it returns).
 */
function cacheTtlMs(): number {
  return parseInt(process.env.AI_KILL_SWITCH_TTL_MS || '5000', 10);
}

let cached: { state: KillSwitchState; readAt: number } | null = null;

/** Drop the cached read. For tests, and for an operator forcing a re-check. */
export function resetKillSwitchCache(): void {
  cached = null;
}

/**
 * Whether an unreadable flag service counts as engaged.
 *
 * IT DOES, AND THAT IS THE OPPOSITE OF THE CAPTURE DOMAIN POLICY. The rule this
 * codebase follows is: fail closed only where the restriction exists
 * independently of our ability to check it. For capture domains it does not — no
 * configured policy means the tenant wrote no restriction, so denying would
 * invent one. Here it does: the switch exists precisely for the emergency in
 * which infrastructure is degraded, and "we could not read whether we were told
 * to stop" is not a licence to continue generating. A deployment with no flag
 * service configured is a different case entirely and falls through to the local
 * variable, because you cannot fail closed against a switch nobody installed.
 */
function engagedOnUnreadable(): boolean {
  return true;
}

/** The current state, cached briefly. */
export async function killSwitchState(): Promise<KillSwitchState> {
  const checkedAt = new Date().toISOString();

  if (localEngaged()) {
    // The local override wins outright. An operator who has set it has made a
    // deliberate statement about THIS process, and a flag service saying
    // otherwise must not quietly overrule them.
    return {
      engaged: true,
      source: 'local_env',
      reason: 'AI_KILL_SWITCH is engaged in this environment',
      checkedAt,
    };
  }

  if (!flagId() || !SdkGatewayClient.isConfigured()) {
    return { engaged: false, source: 'local_env', reason: null, checkedAt };
  }

  if (cached && Date.now() - cached.readAt < cacheTtlMs()) {
    return { ...cached.state, source: 'cached', checkedAt };
  }

  try {
    const result = await SdkGatewayClient.call<{
      data?: { kill_switch?: { engaged?: boolean; reason?: string } };
    }>({
      sdk: 'sdk-feature-flags',
      path: `/api/flags/${encodeURIComponent(flagId())}/kill-switch`,
      method: 'GET',
    });

    const switchState = result.data?.data?.kill_switch;
    // `=== true`, so a malformed response reads as NOT engaged rather than as a
    // fleet-wide halt caused by a missing field.
    const engaged = switchState?.engaged === true;
    const state: KillSwitchState = {
      engaged,
      source: 'flag_service',
      reason: engaged ? (switchState?.reason ?? 'Engaged in sdk-feature-flags') : null,
      checkedAt,
    };
    cached = { state, readAt: Date.now() };
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[killSwitch] could not read the flag service:', message);
    return {
      engaged: engagedOnUnreadable(),
      source: 'unreadable',
      reason: `The AI kill switch could not be read: ${message}`,
      checkedAt,
    };
  }
}

/**
 * Refuse the caller when AI is halted.
 *
 * 503, not 403. The caller is not unauthorised — the capability is switched off
 * for everyone, and a client told 403 will offer the user a way to get
 * permission for something no permission can currently unlock.
 */
export async function assertAiPermitted(): Promise<KillSwitchState> {
  const state = await killSwitchState();
  if (state.engaged) {
    throw new AppError(
      503,
      ErrorCodes.AI_HALTED,
      state.reason ?? 'AI generation is halted by the global kill switch'
    );
  }
  return state;
}

/**
 * Engage the switch in this process immediately, and upstream if it can.
 *
 * LOCAL STATE FIRST, UPSTREAM SECOND, and the ordering is the guarantee. If the
 * upstream write were first, an operator pulling the switch during exactly the
 * outage it exists for would get an error and this process would carry on
 * generating. Writing the cache first means the process handling the request
 * stops in the same tick regardless of what the flag service does; the upstream
 * write is what propagates it to the rest of the fleet.
 *
 * @returns whether the upstream flag service also recorded it.
 */
export async function engageKillSwitch(reason: string): Promise<{ propagated: boolean }> {
  cached = {
    state: {
      engaged: true,
      source: 'flag_service',
      reason,
      checkedAt: new Date().toISOString(),
    },
    // Dated NOW so the entry survives a full TTL, then is re-read from the
    // service — which is what makes DISENGAGING possible without a restart.
    readAt: Date.now(),
  };

  if (!flagId() || !SdkGatewayClient.isConfigured()) {
    return { propagated: false };
  }

  try {
    await SdkGatewayClient.call({
      sdk: 'sdk-feature-flags',
      path: `/api/flags/${encodeURIComponent(flagId())}/kill-switch`,
      method: 'POST',
      idempotencyKey: `ai-kill-switch:${flagId()}`,
      body: { engaged: true, reason },
    });
    return { propagated: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Loud: this process is halted, the rest of the fleet may not be.
    console.error('[killSwitch] ENGAGED LOCALLY BUT NOT PROPAGATED:', message);
    return { propagated: false };
  }
}

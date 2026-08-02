import { useEffect, useMemo, useState } from 'react';
import { api } from '../../services/api';

/** What the PDP concluded for one action. */
export type PolicyEffect = 'permit' | 'deny' | 'requires_approval';

export interface PolicyObligation {
  type: string;
  detail: string;
}

export interface PolicyDecision {
  action: string;
  effect: PolicyEffect;
  reason: string;
  obligations: PolicyObligation[];
  decision_ref: string;
}

/** One action a screen wants a verdict on. */
export interface PermissionQuery {
  action: string;
  resourceType: string;
  resourceId?: string;
}

export interface PermissionState {
  loading: boolean;
  /** Verdicts keyed by action, for O(1) lookup from a control. */
  decisions: Map<string, PolicyDecision>;
  /** Non-null when the PDP could not be reached. */
  error: string | null;
}

/**
 * The verdict for one action, or a safe default while unknown.
 *
 * FAILS CLOSED. Before the answer arrives, and if it never arrives, the caller
 * is treated as not permitted. The alternative — assume permit until told
 * otherwise — flashes an enabled control that then refuses, which is both a
 * worse experience and a way to leak what exists to someone who may not act on
 * it.
 */
export function decisionFor(state: PermissionState, action: string): PolicyDecision {
  const found = state.decisions.get(action);
  if (found) {
    return found;
  }
  return {
    action,
    effect: 'deny',
    reason: state.loading
      ? 'Checking your permissions…'
      : state.error ?? 'No decision available for this action.',
    obligations: [],
    decision_ref: '',
  };
}

/** True only for an unconditional permit. */
export function isAllowed(state: PermissionState, action: string): boolean {
  const decision = decisionFor(state, action);
  // An obligation the client cannot satisfy is not a permit. `own_record_only`
  // and `business_unit_scope` are resolved server side against the actual row,
  // so the UI treats a conditional permit as allowed-to-attempt and lets the
  // server make the final call — which it must anyway.
  return decision.effect === 'permit';
}

/**
 * Ask the PDP about a screen's whole action set in ONE call.
 *
 * The queries are serialised into the dependency key rather than passed as a
 * raw array, because a caller almost always builds the array inline and a new
 * array identity every render would re-fetch forever.
 *
 * @param queries Every action this screen gates a control on.
 */
export function usePermissions(queries: PermissionQuery[]): PermissionState {
  const key = JSON.stringify(queries);
  const [state, setState] = useState<PermissionState>({
    loading: true,
    decisions: new Map(),
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    const parsed = JSON.parse(key) as PermissionQuery[];

    if (parsed.length === 0) {
      setState({ loading: false, decisions: new Map(), error: null });
      return;
    }

    setState((current) => ({ ...current, loading: true }));

    void (async () => {
      try {
        const result = await api.evaluatePermissions(parsed);
        if (cancelled) {
          return;
        }
        setState({
          loading: false,
          decisions: new Map(result.decisions.map((decision) => [decision.action, decision])),
          error: null,
        });
      } catch {
        if (cancelled) {
          return;
        }
        // Deliberately keeps an EMPTY decision map, so every control falls back
        // to denied. A permissions outage must not open the UI up.
        setState({
          loading: false,
          decisions: new Map(),
          error: 'Your permissions could not be checked.',
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [key]);

  return state;
}

/** Build the query list for a screen without repeating the resource type. */
export function actionsOn(resourceType: string, actions: string[]): PermissionQuery[] {
  return useMemoisedQueries(resourceType, actions);
}

function useMemoisedQueries(resourceType: string, actions: string[]): PermissionQuery[] {
  const key = actions.join('|');
  return useMemo(
    () => key.split('|').filter(Boolean).map((action) => ({ action, resourceType })),
    [key, resourceType]
  );
}

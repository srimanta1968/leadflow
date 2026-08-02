import { ReactNode } from 'react';
import { decisionFor, PermissionState, PolicyDecision } from './usePermissions';

interface DeniedReasonProps {
  decision: PolicyDecision;
}

/**
 * Why a control is unavailable.
 *
 * The whole point of the pattern: a disabled control with no explanation is
 * indistinguishable from a broken one, and the person's next move is to file a
 * bug or ask a colleague. Saying "your role needs approval for this" turns a
 * dead end into a next step.
 */
export function DeniedReason({ decision }: DeniedReasonProps) {
  const needsApproval = decision.effect === 'requires_approval';

  return (
    <p className={`mt-1.5 text-xs leading-relaxed ${needsApproval ? 'text-gold' : 'text-soft'}`}>
      {decision.reason}
      {decision.obligations.length > 0 && (
        <>
          {' '}
          {decision.obligations.map((obligation) => obligation.detail).join(' ')}
        </>
      )}
    </p>
  );
}

interface RequirePermissionProps {
  state: PermissionState;
  /** Action this control performs. */
  action: string;
  /**
   * The control, given whether it should be interactive.
   *
   * A render prop rather than a wrapper so the DISABLED state belongs to the
   * control itself. Wrapping in a div that swallows clicks leaves a button that
   * still looks and focuses like a button, which is worse than a disabled one —
   * a keyboard user tabs to it, presses Enter, and nothing happens.
   */
  children: (allowed: boolean, decision: PolicyDecision) => ReactNode;
  /** Hide entirely rather than explain. Use sparingly — see below. */
  hideWhenDenied?: boolean;
}

/**
 * Gate one control on a PDP verdict, explaining any refusal.
 *
 * DEFAULT IS TO EXPLAIN, NOT TO HIDE. Hiding is available but opt-in, because a
 * vanishing control teaches people the product is inconsistent — the button was
 * there yesterday on someone else's screen — and it makes support conversations
 * impossible. It is the right choice only where the control's mere existence
 * would disclose something, which is rare inside an authenticated workspace.
 *
 * THIS IS NOT A SECURITY BOUNDARY. It decides what to render, nothing more. The
 * server evaluates the same policy on the write, because anyone can call the API
 * directly and a hidden button stops precisely nobody.
 */
export function RequirePermission({
  state,
  action,
  children,
  hideWhenDenied = false,
}: RequirePermissionProps) {
  const decision = decisionFor(state, action);
  const allowed = decision.effect === 'permit';

  if (!allowed && hideWhenDenied) {
    return null;
  }

  return (
    <>
      {children(allowed, decision)}
      {!allowed && !state.loading && <DeniedReason decision={decision} />}
    </>
  );
}

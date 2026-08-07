import { toneClass } from '../tokens';
import { TRUST_RAIL_NODES, type RailState, type TrustRailNodeKey } from './assertions';

/**
 * The .statusrail — P0 through P4 plus Consent.
 *
 * ALL SIX NODES ALWAYS RENDER. A rail that hides the rungs a record has not
 * reached looks complete at every stage, which is the opposite of what a trust
 * ladder is for: the operator needs to see how far there is left to go, not just
 * where they are.
 *
 * CONSENT IS NOT THE SIXTH RUNG, it is a parallel track drawn alongside. A record
 * can be fully verified at P4 and still carry no permission to contact. Rendering
 * consent as the top of the identity ladder would let a confident-looking rail
 * imply a permission nobody granted — which is the one mistake in this component
 * that reaches a customer.
 */

export interface TrustRailProps {
  /** State per node. A node absent from the map renders as pending. */
  states: Partial<Record<TrustRailNodeKey, RailState>>;
  /**
   * What the record actually has at each rung, in the words of the evidence.
   * Absent is fine — the node then shows its generic hint instead.
   */
  evidence?: Partial<Record<TrustRailNodeKey, string>>;
  onSelect?: (node: TrustRailNodeKey) => void;
}

const STATE_STYLE: Record<RailState, { dot: string; label: string }> = {
  reached: { dot: 'bg-green border-green', label: 'text-text' },
  current: { dot: 'bg-blue border-blue', label: 'text-text' },
  pending: { dot: 'bg-transparent border-line2', label: 'text-soft' },
  // Blocked is not pending. A rung that CANNOT be reached — consent refused, say
  // — must not look like one that simply has not been reached yet.
  blocked: { dot: 'bg-red border-red', label: toneClass('blocked') },
};

export function TrustStateRail({ states, evidence, onSelect }: TrustRailProps) {
  return (
    <ol className="flex flex-col gap-0 sm:flex-row sm:gap-0" aria-label="Trust state">
      {TRUST_RAIL_NODES.map((node, index) => {
        const state = states[node.key] ?? 'pending';
        const style = STATE_STYLE[state];
        const detail = evidence?.[node.key] ?? node.hint;
        const isConsent = node.key === 'CONSENT';

        return (
          <li
            key={node.key}
            className={`relative flex flex-1 gap-3 sm:flex-col sm:gap-2 ${
              // The visual break before Consent says it is a separate track
              // rather than the next rung up.
              isConsent ? 'sm:ml-4 sm:border-l sm:border-dashed sm:border-line sm:pl-4' : ''
            }`}
          >
            <div className="flex items-center sm:w-full">
              <span
                aria-hidden="true"
                className={`h-3 w-3 shrink-0 rounded-full border-2 ${style.dot}`}
              />
              {/* Connector, omitted after the last node and before Consent. */}
              {index < TRUST_RAIL_NODES.length - 1 && !isConsent && (
                <span aria-hidden="true" className="hidden h-px flex-1 bg-line sm:block" />
              )}
            </div>

            <div className="min-w-0 pb-4 sm:pb-0">
              {onSelect ? (
                <button
                  type="button"
                  onClick={() => onSelect(node.key)}
                  className={`text-left text-xs font-semibold ${style.label} hover:underline`}
                >
                  {node.label}
                </button>
              ) : (
                <p className={`text-xs font-semibold ${style.label}`}>{node.label}</p>
              )}
              <p className="mt-0.5 text-[11px] leading-snug text-soft">{detail}</p>
              <span className="sr-only">{state}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

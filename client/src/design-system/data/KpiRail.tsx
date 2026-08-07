import type { ReactNode } from 'react';
import { SEMANTIC, toneClass, type SemanticRole } from '../tokens';

/**
 * The mockup's .kpis rail.
 *
 * ONE COMPONENT FOR EVERY RAIL IN THE APPLICATION. The Capture Inbox, Analytics,
 * SLA and Routing screens each grew their own tile — same shape, subtly different
 * padding, and each picking a colour by hand. That is how a design system becomes
 * a suggestion. Colour here is a SEMANTIC ROLE, never a token and never a class:
 * a tile cannot be "the gold one", it is a warning, and gold follows.
 */

export interface KpiTileProps {
  /** The .kt eyebrow. */
  label: string;
  /** The .kv numeral. Rendered in --cond, which is what makes the rail read. */
  value: ReactNode;
  /** The caption under the numeral. */
  detail?: string;
  /** Meaning, not colour. */
  role?: SemanticRole;
  /** The .delta trend. Positive is not automatically good — see below. */
  delta?: { value: string; direction: 'up' | 'down' | 'flat' };
  /**
   * Whether a rising number is good. Response time going UP is bad; captures
   * going up is good. Without this the arrow colours lie on half the rails, and
   * a green arrow on a worsening metric is worse than no arrow.
   */
  higherIsBetter?: boolean;
  active?: boolean;
  onSelect?: () => void;
}

function DeltaChip({ delta, higherIsBetter = true }: Pick<KpiTileProps, 'delta' | 'higherIsBetter'>) {
  if (!delta) return null;
  const good =
    delta.direction === 'flat' ? null : (delta.direction === 'up') === higherIsBetter;
  const tone = good === null ? 'text-soft' : toneClass(good ? 'success' : 'blocked');
  const arrow = delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : '→';
  return (
    <span className={`text-xs font-semibold tabular-nums ${tone}`}>
      {arrow} {delta.value}
    </span>
  );
}

export function KpiTile({
  label,
  value,
  detail,
  role,
  delta,
  higherIsBetter,
  active,
  onSelect,
}: KpiTileProps) {
  const tone = role ? toneClass(role) : 'text-text';
  const body = (
    <>
      <p className="lf-eyebrow">{label}</p>
      <div className="mt-2 flex items-baseline gap-2">
        <p className={`font-cond text-3xl font-bold tabular-nums ${tone}`}>{value}</p>
        <DeltaChip delta={delta} higherIsBetter={higherIsBetter} />
      </div>
      {detail && <p className="mt-1 text-xs leading-relaxed text-soft">{detail}</p>}
    </>
  );

  // A tile that does nothing is not a button. Rendering every tile as one puts
  // dead controls in the tab order, which is worse for a keyboard user than the
  // markup being inconsistent.
  if (!onSelect) {
    return <div className="lf-panel p-5">{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      title={role ? SEMANTIC[role].means : undefined}
      className={`lf-panel p-5 text-left transition-colors hover:border-line2 ${
        active ? 'border-blue/60 bg-panel2' : ''
      }`}
    >
      {body}
    </button>
  );
}

/** The rail. Column count follows the tile count rather than being passed in. */
export function KpiRail({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">{children}</div>
  );
}

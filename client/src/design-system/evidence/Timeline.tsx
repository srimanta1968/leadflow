import { toneClass, type SemanticRole } from '../tokens';

/**
 * The .timeline — evidence and audit entries.
 *
 * EVERY ENTRY CARRIES ITS ACTOR, REFERENCE AND DECISION, not just a sentence.
 * A timeline that reads "Record promoted · 2 hours ago" answers none of the
 * questions actually asked afterwards: by whom, under what authority, and which
 * record can I quote. Those fields are required by the type for that reason.
 */

export interface TimelineEntry {
  id: string;
  /** What happened, in one line. */
  summary: string;
  /** The persona who did it. Never a bare user id — an id is not accountability. */
  actor: string;
  /** The audit or trace reference an operator can quote to support. */
  reference: string;
  at: string;
  /** The policy verdict, where the act was governed. */
  decision?: { effect: 'permit' | 'deny' | 'requires_approval'; reason?: string };
  role?: SemanticRole;
}

const EFFECT_ROLE: Record<NonNullable<TimelineEntry['decision']>['effect'], SemanticRole> = {
  permit: 'success',
  deny: 'blocked',
  requires_approval: 'warning',
};

export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-soft">
        Nothing recorded yet. An empty history means no governed act has touched this
        record — not that its history is unavailable.
      </p>
    );
  }

  return (
    <ol className="relative space-y-0">
      {entries.map((entry, index) => (
        <li key={entry.id} className="relative flex gap-3 pb-5 last:pb-0">
          <div className="flex flex-col items-center">
            <span
              aria-hidden="true"
              className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full border-2 ${
                entry.role ? `${toneClass(entry.role)} border-current` : 'border-line2'
              }`}
            />
            {/* The rail between dots, omitted after the last so the list does not
                trail into nothing. */}
            {index < entries.length - 1 && <span aria-hidden="true" className="w-px flex-1 bg-line" />}
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-sm text-text">{entry.summary}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-soft">
              <span>{entry.actor}</span>
              <span aria-hidden="true">·</span>
              <time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
              <span aria-hidden="true">·</span>
              <span className="font-mono">{entry.reference}</span>
            </p>
            {entry.decision && (
              <p className={`mt-1 text-[11px] ${toneClass(EFFECT_ROLE[entry.decision.effect])}`}>
                {entry.decision.effect}
                {/* The REASON, when the verdict was not a plain permit. A refusal
                    with no stated grounds is the audit-trail equivalent of a bare
                    status word. */}
                {entry.decision.reason && <span className="text-soft"> — {entry.decision.reason}</span>}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The .kv correlation block — canonical entity, trace, policy bundle, consent epoch. */
export function CorrelationContext({
  pairs,
  onSelect,
}: {
  pairs: { label: string; value: string; href?: string }[];
  onSelect?: (label: string, value: string) => void;
}) {
  return (
    <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
      {pairs.map((pair) => (
        <div key={pair.label} className="flex items-baseline justify-between gap-3 border-b border-line/60 pb-1.5">
          <dt className="text-[11px] uppercase tracking-wider text-soft">{pair.label}</dt>
          <dd className="min-w-0 truncate font-mono text-xs text-text">
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(pair.label, pair.value)}
                className="hover:text-blue hover:underline"
              >
                {pair.value}
              </button>
            ) : (
              pair.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

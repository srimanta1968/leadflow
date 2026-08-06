import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  CaptureInbox as CaptureInboxData,
  CaptureInboxItem,
  TrustState,
} from '../../services/api';
import { useToast } from '../../components/feedback/ToastProvider';
import { failureFor } from '../../content/messages';
import { CAPTURE_ORIGIN_OPTIONS } from '../../content/captureOriginClasses';
import { QuickContactModal } from '../../components/app/QuickContactModal';
import { ResolveCaptureModal } from '../../components/app/ResolveCaptureModal';
import { ExtensionPreviewModal } from '../../components/app/ExtensionPreviewModal';
import { outstandingCount, readQueue, QueueItem } from '../../features/capture/offlineQueue';

/** Human labels for the origin vocabulary, from the shared content module. */
const ORIGIN_LABELS = new Map(CAPTURE_ORIGIN_OPTIONS.map((option) => [option.value as string, option.label]));

/** When a capture counts as at risk — the SLA Risk tile's own caption. */
const SLA_RISK_MINUTES = 24 * 60;

/**
 * What the operator is looking at.
 *
 * A TRUST lens is re-fetched from the server, because the trust ladder is the
 * one dimension the endpoint filters on and a server-side filter reaches past
 * the loaded page. The others are lenses over the page already in hand: the
 * endpoint has no parameter for them, and pretending otherwise by silently
 * narrowing a request the server did not honour would show a filtered heading
 * over an unfiltered list.
 */
type Lens =
  | { kind: 'all' }
  | { kind: 'trust'; state: TrustState; label: string }
  | { kind: 'source'; source: string; label: string }
  | { kind: 'age'; minutes: number; label: string }
  | { kind: 'offline'; label: string };

const ALL: Lens = { kind: 'all' };

/** A lens's identity, so clicking the tile already applied clears it. */
function lensKey(lens: Lens): string {
  switch (lens.kind) {
    case 'trust':
      return `trust:${lens.state}`;
    case 'source':
      return `source:${lens.source}`;
    case 'age':
      return `age:${lens.minutes}`;
    default:
      return lens.kind;
  }
}

/** The badge for a trust state, with the mockup's accent for each rung. */
const TRUST_BADGE: Record<TrustState, { short: string; className: string }> = {
  P0_CAPTURED: { short: 'P0', className: 'border-gold/40 bg-gold/10 text-gold' },
  P1_NORMALIZED: { short: 'P1', className: 'border-blue/40 bg-blue/10 text-blue' },
  P2_CANDIDATE: { short: 'P2', className: 'border-purple/40 bg-purple/10 text-purple' },
  P3_LINKED: { short: 'P3', className: 'border-cyan/40 bg-cyan/10 text-cyan' },
  P4_DIRECT: { short: 'P4', className: 'border-green/40 bg-green/10 text-green' },
};

/** The accent each capture source carries in the breakdown panel. */
const SOURCE_TONE: Record<string, string> = {
  quick_add: 'bg-blue',
  browser_extension: 'bg-cyan',
  mobile_contacts: 'bg-green',
  email_signature: 'bg-purple',
  business_card: 'bg-gold',
};

/** Relative age, in the mockup's own shorthand. */
function ageLabel(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'Yesterday' : `${days} days`;
}

/**
 * The one action this row offers, and how it reads.
 *
 * DERIVED FROM THE SERVER'S `availableActions`, which is already the
 * intersection of what the trust state allows and what policy permits this
 * caller. Re-deriving it from the trust state alone here would put back the
 * buttons the server deliberately withheld, and the operator would discover
 * their authority by being refused on click.
 *
 * The P1/P3 split between Promote and Review is the origin class: a record
 * resting on first-party direct evidence can be promoted outright, while one
 * parsed out of a signature still needs a person to look at it first.
 */
export function actionFor(item: CaptureInboxItem): {
  label: string;
  className: string;
  title: string;
} {
  const can = (action: string): boolean => item.availableActions.includes(action as never);

  if (can('identity.link.verify')) {
    return {
      label: 'Compare',
      className: 'border-purple/50 text-purple hover:bg-purple/10',
      title: 'Compare the evidence on both records before linking',
    };
  }
  if (can('source_record.normalize')) {
    return {
      label: 'Resolve',
      className: 'border-blue/50 text-blue hover:bg-blue/10',
      title: 'Parse this capture into fields',
    };
  }
  if (can('source_record.promote')) {
    if (item.originClass === 'FIRST_PARTY_DIRECT') {
      return {
        label: 'Promote',
        className: 'border-green/50 text-green hover:bg-green/10',
        title: 'Direct interaction evidence — promote without further review',
      };
    }
    return {
      label: 'Review',
      className: 'border-blue/50 text-blue hover:bg-blue/10',
      title: 'Check the parse before promoting',
    };
  }
  // Nothing to advance: either the ladder is finished or this caller may not
  // advance it. Clearing the row from the queue is all that is left.
  return {
    label: 'Dismiss',
    className: 'border-line2 text-muted hover:bg-panel3',
    title: 'Hide this capture from your queue',
  };
}

interface TileProps {
  label: string;
  value: number;
  detail: string;
  tone: string;
  active: boolean;
  onSelect: () => void;
}

/** One KPI tile. A button, because every one of them drills in. */
function Tile({ label, value, detail, tone, active, onSelect }: TileProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`lf-panel p-5 text-left transition-colors hover:border-line2 ${
        active ? 'border-blue/60 bg-panel2' : ''
      }`}
    >
      <p className="lf-eyebrow">{label}</p>
      <p className={`mt-2 font-cond text-3xl font-bold tabular-nums ${tone}`}>{value}</p>
      <p className="mt-1 text-xs leading-relaxed text-soft">{detail}</p>
    </button>
  );
}

/**
 * The Capture Inbox.
 *
 * THE PRE-PROJECTION QUEUE. Every quick add, browser capture, business-card
 * scan, signature parse or mobile selection lands here first as a source record
 * with its evidence intact — before it is anybody's lead, and before anything
 * has been decided about who it is. The Lead queue one rung later works the
 * routed, owned record; this works the provenance.
 *
 * ONE CALL POPULATES THE WHOLE SCREEN — tiles, rows and the source breakdown
 * come back together, so a tile that says 27 cannot sit above a queue of 24.
 * The single exception is the Offline Queue tile, which counts what is still on
 * THIS DEVICE and unsynced: no server can see a capture that has not reached
 * it, and reporting the server's zero there would tell a rep with five queued
 * contacts that they had none.
 */
export default function CaptureInbox() {
  const { notify } = useToast();
  const [inbox, setInbox] = useState<CaptureInboxData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lens, setLens] = useState<Lens>(ALL);
  /** Rows the operator has cleared from their own view this session. */
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [inspecting, setInspecting] = useState<CaptureInboxItem | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [offline, setOffline] = useState<QueueItem[]>([]);

  const trustFilter = lens.kind === 'trust' ? lens.state : undefined;

  const load = useCallback(
    async (options: { trustState?: TrustState; announce?: boolean } = {}): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.captureInbox({ trust_state: options.trustState, limit: 50 });
        setInbox(result);
      } catch (loadError) {
        const code = loadError instanceof ApiError ? loadError.code : 'INTERNAL_ERROR';
        const message = failureFor(code);
        setError(message.detail ? `${message.title}. ${message.detail}` : message.title);
        if (options.announce) {
          notify(message);
        }
      } finally {
        setLoading(false);
      }
    },
    [notify]
  );

  useEffect(() => {
    void load({ trustState: trustFilter });
  }, [load, trustFilter]);

  useEffect(() => {
    // The device queue, read from the store the offline capture path writes to.
    // Re-read whenever the screen reloads so a sync that drained it is reflected.
    if (typeof window !== 'undefined') {
      setOffline(readQueue(window.localStorage));
    }
  }, [inbox]);

  const counts = inbox?.counts;
  const offlinePending = outstandingCount(offline);

  /** The rows after the lens and the operator's own dismissals. */
  const rows = useMemo((): CaptureInboxItem[] => {
    const items = (inbox?.items ?? []).filter((item) => !dismissed.includes(item.sourceRecordId));
    switch (lens.kind) {
      case 'source':
        return items.filter((item) => item.captureSource === lens.source);
      case 'age':
        return items.filter((item) => item.ageMinutes >= lens.minutes);
      case 'offline':
        // The device queue is not made of source records — it is rendered on
        // its own below rather than squeezed into this list.
        return [];
      default:
        return items;
    }
  }, [inbox, dismissed, lens]);

  const sources = inbox?.sources ?? [];
  const maxSource = sources.reduce((most, source) => Math.max(most, source.count), 0);

  /** Toggle a tile: clicking the active one returns to the whole queue. */
  const select = (next: Lens): void => {
    setLens((current) => (lensKey(current) === lensKey(next) ? ALL : next));
  };

  const dismiss = (item: CaptureInboxItem): void => {
    setDismissed((current) => [...current, item.sourceRecordId]);
    notify({
      tone: 'info',
      title: 'Hidden from your queue',
      detail:
        'Cleared from this view only. The source record and its evidence are untouched, and it returns on reload.',
    });
  };

  return (
    <div className="mx-auto max-w-6xl">
      {/* Hero */}
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-3xl">
          <p className="lf-eyebrow">Universal Quick Capture</p>
          <h1 className="mt-1.5 text-2xl font-bold text-text">Capture Inbox</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Every quick add, smart paste, browser capture, business-card scan, email signature,
            mobile contact selection, or API event first lands as a source record with immutable
            evidence.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            name="extensionPreview"
            onClick={() => setPreviewOpen(true)}
            className="lf-btn-secondary px-4 py-2"
          >
            Extension Preview
          </button>
          <button
            type="button"
            name="newCapture"
            onClick={() => setQuickOpen(true)}
            className="lf-btn-primary px-4 py-2"
          >
            New Capture
          </button>
        </div>
      </header>

      {/* The state of the read itself, stated rather than implied by an empty
          list. "Nothing is waiting" and "we could not ask" look identical
          otherwise, and they call for opposite actions. */}
      {inbox && !inbox.upstream_available && (
        <p
          className="mt-6 rounded-xl border border-gold/40 bg-gold/10 px-4 py-3 text-sm text-gold"
          role="status"
        >
          The provenance store could not be reached, so the queue below is empty because nothing
          could be read — not because nothing is waiting.
        </p>
      )}

      {error && (
        <div
          className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-red/40 bg-red/10 px-4 py-3"
          role="alert"
        >
          <p className="text-sm text-red">{error}</p>
          <button
            type="button"
            onClick={() => void load({ trustState: trustFilter, announce: true })}
            className="lf-btn-secondary px-4 py-2"
          >
            Retry
          </button>
        </div>
      )}

      {/* KPI rail */}
      <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Tile
          label="New P0"
          value={counts?.newP0 ?? 0}
          detail="Not yet normalized"
          tone="text-gold"
          active={lens.kind === 'trust' && lens.state === 'P0_CAPTURED'}
          onSelect={() => select({ kind: 'trust', state: 'P0_CAPTURED', label: 'New P0' })}
        />
        <Tile
          label="Parsed P1"
          value={counts?.parsedP1 ?? 0}
          detail="Ready for candidate search"
          tone="text-blue"
          active={lens.kind === 'trust' && lens.state === 'P1_NORMALIZED'}
          onSelect={() => select({ kind: 'trust', state: 'P1_NORMALIZED', label: 'Parsed P1' })}
        />
        <Tile
          label="Candidate P2"
          value={counts?.candidateP2 ?? 0}
          detail="Need review"
          tone="text-purple"
          active={lens.kind === 'trust' && lens.state === 'P2_CANDIDATE'}
          onSelect={() => select({ kind: 'trust', state: 'P2_CANDIDATE', label: 'Candidate P2' })}
        />
        <Tile
          label="Offline Queue"
          value={offlinePending}
          detail="Mobile sync pending"
          tone="text-cyan"
          active={lens.kind === 'offline'}
          onSelect={() => select({ kind: 'offline', label: 'Offline Queue' })}
        />
        <Tile
          label="Browser Captures"
          value={counts?.browserCaptures ?? 0}
          detail="This week"
          tone="text-green"
          active={lens.kind === 'source' && lens.source === 'browser_extension'}
          onSelect={() =>
            select({ kind: 'source', source: 'browser_extension', label: 'Browser Captures' })
          }
        />
        <Tile
          label="SLA Risk"
          value={counts?.slaRisk ?? 0}
          detail="Older than 24 hours"
          tone="text-red"
          active={lens.kind === 'age'}
          onSelect={() => select({ kind: 'age', minutes: SLA_RISK_MINUTES, label: 'SLA Risk' })}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* Unresolved Captures */}
        <section className="lf-panel p-5" aria-label="Unresolved Captures">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-text">Unresolved Captures</h2>
              <p className="mt-1 text-xs text-soft">
                Click a record to inspect parsing and match evidence
              </p>
            </div>
            {lens.kind !== 'all' && (
              <div className="flex items-center gap-3">
                {/* The filter is named in TEXT rather than only in the button,
                    so the button can be called one unambiguous thing. A control
                    labelled "New P0 clear filter" collides with the tile that
                    set it, for a person scanning and for a test selector. */}
                <span className="lf-pill border-blue/40 bg-blue/10 text-blue">
                  Filtered to {lens.label}
                </span>
                <button
                  type="button"
                  name="clearFilter"
                  onClick={() => setLens(ALL)}
                  className="lf-btn-secondary px-3 py-1.5 text-xs"
                >
                  Show all captures
                </button>
              </div>
            )}
          </div>

          {lens.kind === 'offline' ? (
            <div className="mt-5 space-y-2">
              {offline.length === 0 ? (
                <p className="py-8 text-center text-sm text-soft">
                  Nothing is queued on this device. Captures taken with no signal appear here until
                  they sync.
                </p>
              ) : (
                offline.map((item) => (
                  <div
                    key={item.clientCaptureId}
                    className="flex items-center gap-4 rounded-xl border border-line bg-panel2 px-4 py-3"
                  >
                    <span className="lf-pill border-cyan/40 bg-cyan/10 text-cyan">
                      {item.syncState}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-text">{item.rawInput}</p>
                      <p className="mt-0.5 text-xs text-soft">
                        {item.captureKind.replace('_', ' ')} · captured on this device ·{' '}
                        {item.attempts} sync {item.attempts === 1 ? 'attempt' : 'attempts'}
                        {item.error ? ` · ${item.error}` : ''}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : loading && !inbox ? (
            <p className="py-10 text-center text-sm text-muted">Loading captures…</p>
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-soft">
              {lens.kind === 'all'
                ? 'No unresolved captures. Everything that arrived has been resolved.'
                : 'No captures match this filter.'}
            </p>
          ) : (
            <ul className="mt-5 space-y-2">
              {rows.map((item) => {
                const badge = TRUST_BADGE[item.trustState] ?? TRUST_BADGE.P0_CAPTURED;
                const action = actionFor(item);
                return (
                  <li key={item.sourceRecordId}>
                    <div className="flex items-center gap-4 rounded-xl border border-line bg-panel2 px-4 py-3 transition-colors hover:border-line2">
                      <span className={`lf-pill shrink-0 ${badge.className}`}>{badge.short}</span>
                      {/* The row itself inspects. A button rather than a click
                          handler on the div so it is reachable by keyboard and
                          announced as the control it is. */}
                      <button
                        type="button"
                        onClick={() => setInspecting(item)}
                        className="min-w-0 flex-1 text-left"
                        title="Inspect parsing and match evidence"
                      >
                        <p className="truncate text-sm font-semibold text-text">
                          {item.primaryEvidence ?? 'Capture with no readable evidence line'}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-soft">
                          {ORIGIN_LABELS.get(item.originClass) ?? item.originClass} ·{' '}
                          {item.explanation}
                        </p>
                      </button>
                      <span
                        className={`shrink-0 text-xs ${
                          item.ageMinutes >= SLA_RISK_MINUTES ? 'text-red' : 'text-muted'
                        }`}
                      >
                        {ageLabel(item.ageMinutes)}
                      </span>
                      <button
                        type="button"
                        title={action.title}
                        onClick={() =>
                          action.label === 'Dismiss' ? dismiss(item) : setInspecting(item)
                        }
                        className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${action.className}`}
                      >
                        {action.label}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="space-y-6">
          {/* Capture Sources */}
          <section className="lf-panel p-5" aria-label="Capture Sources">
            <h2 className="text-base font-bold text-text">Capture Sources</h2>
            <div className="mt-4 space-y-3">
              {sources.map((source) => (
                <div key={source.key}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted">{source.label}</span>
                    <b className="font-cond text-sm tabular-nums text-text">{source.count}</b>
                  </div>
                  <div
                    className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-panel3"
                    aria-hidden="true"
                  >
                    <div
                      className={`h-full rounded-full ${SOURCE_TONE[source.key] ?? 'bg-blue'}`}
                      style={{
                        width: `${maxSource === 0 ? 0 : Math.round((source.count / maxSource) * 100)}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
              {sources.length === 0 && (
                <p className="text-xs text-soft">No captures to break down yet.</p>
              )}
            </div>
          </section>

          {/* Capture Rules — the governance the screen operates under, stated
              where the work happens rather than in a policy document nobody
              opens while triaging. */}
          <section className="lf-panel p-5" aria-label="Capture Rules">
            <h2 className="text-base font-bold text-text">Capture Rules</h2>
            <div className="mt-4 space-y-3">
              <div className="rounded-xl border border-green/40 bg-green/10 p-4">
                <p className="text-sm font-bold text-green">No automatic enrichment</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Quick capture never consumes Data Credits until an authorized user selects or
                  approves a capability.
                </p>
              </div>
              <div className="rounded-xl border border-line bg-panel2 p-4">
                <p className="text-sm font-bold text-text">Source first, entity later</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  P0 keeps the exact evidence. P1 normalizes it. P2 proposes candidates. Only a
                  governed action establishes P3/P4.
                </p>
              </div>
              <div className="rounded-xl border border-gold/40 bg-gold/10 p-4">
                <p className="text-sm font-bold text-gold">Restricted sites</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Capture mode can be disabled by tenant policy; manual entry remains available
                  where permitted.
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>

      <QuickContactModal
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        onCaptured={() => {
          notify({
            tone: 'success',
            title: 'Capture stored',
            detail: 'It is in the queue below as a P0 source record with its evidence kept.',
          });
          void load({ trustState: trustFilter });
        }}
      />

      <ExtensionPreviewModal open={previewOpen} onClose={() => setPreviewOpen(false)} />

      {inspecting && (
        <ResolveCaptureModal
          open
          captureId={inspecting.sourceRecordId}
          rawEvidence={inspecting.primaryEvidence ?? ''}
          sourceContext={ORIGIN_LABELS.get(inspecting.originClass) ?? inspecting.originClass}
          capturedAt={ageLabel(inspecting.ageMinutes)}
          proposal={[]}
          onClose={() => setInspecting(null)}
          onResolved={() => {
            void load({ trustState: trustFilter });
          }}
        />
      )}
    </div>
  );
}

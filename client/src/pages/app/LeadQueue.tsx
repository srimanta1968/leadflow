import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DataTable } from '../../design-system/data/DataTable';
import { api, ApiError, Lead } from '../../services/api';
import { useToast } from '../../components/feedback/ToastProvider';
import { failureFor } from '../../content/messages';
import { SOURCE_OPTIONS } from '../../content/leadFields';
import { subscribeToEvents } from '../../services/eventStream';
import { ContactEnrichmentModal } from '../../components/app/ContactEnrichmentModal';
import { DataCreditsDrawer } from '../../components/app/DataCreditsDrawer';

/** Human labels for the source channel enum, from the shared vocabulary. */
const SOURCE_LABELS = new Map(SOURCE_OPTIONS.map((option) => [option.value as string, option.label]));

/** The response window the SLA policy enforces, in minutes. */
const SLA_WINDOW_MINUTES = 30;
/** When the clock enters its warning band. */
const SLA_WARNING_MINUTES = 15;

/** Minutes elapsed since an ISO timestamp. */
function minutesSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 60000;
}

/** Render an elapsed duration as a short human age. */
function age(iso: string): string {
  const minutes = Math.floor(minutesSince(iso));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The Lead queue.
 *
 * THE PROJECTION, NOT THE LADDER. This screen works LEADS — records that have
 * already become owned, routed, SLA-tracked work. The Capture Inbox one rung
 * earlier works SOURCE RECORDS, which are provenance and have no owner yet. The
 * two were one screen until the trust ladder arrived, and keeping them one
 * would have meant a queue whose rows answered to two different lifecycles.
 *
 * Reads the local lead projection rather than fanning out to ProjexCloud per
 * row. The response-clock column states the elapsed time against the 30-minute
 * window and colours it green, gold or red, so the queue reads by urgency the
 * moment it loads.
 *
 * A failed load offers a retry rather than leaving a dead end — the most likely
 * cause is a transient network fault, and forcing a page reload to recover from
 * that is a worse experience than a button.
 */
export default function LeadQueue() {
  const { notify } = useToast();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Lead currently being routed, so only that row's button shows progress. */
  const [routingId, setRoutingId] = useState<string | null>(null);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [enrichId, setEnrichId] = useState<string | null>(null);
  /** True once a pushed event has arrived, proving the stream is delivering. */
  const [live, setLive] = useState(false);

  const load = useCallback(
    async (options: { announce?: boolean } = {}): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const result = await api.listLeads(50, 0);
        setLeads(result.leads);
        setTotal(result.total);
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
    // The first load renders its failure inline, so it does not also raise a
    // toast — two copies of the same message is noise.
    void load();
  }, [load]);

  useEffect(() => {
    // Live updates. A lead captured or routed by a colleague now appears without
    // anyone pressing Refresh. The event carries no state — it means "re-read" —
    // so the projection stays the single source of truth.
    //
    // Reloads are coalesced: a burst (a zero-orphan sweep routing fifty leads
    // emits fifty events) would otherwise trigger fifty overlapping fetches.
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = subscribeToEvents(() => {
      setLive(true);
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 250);
    });

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      unsubscribe();
    };
  }, [load]);

  /** Colour the clock cell against the SLA window. */
  function slaTone(iso: string): string {
    const minutes = minutesSince(iso);
    if (minutes >= SLA_WINDOW_MINUTES) return 'text-red';
    if (minutes >= SLA_WARNING_MINUTES) return 'text-gold';
    return 'text-green';
  }

  /** Words for the clock state, so the status is not carried by colour alone. */
  function slaLabel(iso: string): string {
    const minutes = minutesSince(iso);
    if (minutes >= SLA_WINDOW_MINUTES) return 'breached';
    if (minutes >= SLA_WARNING_MINUTES) return 'at risk';
    return 'within SLA';
  }

  /**
   * Route one lead, then refresh so the row shows its new owner and clock.
   *
   * The button is disabled while in flight rather than relying on the endpoint's
   * idempotency — the endpoint would answer correctly either way, but a
   * double-click that appears to do nothing is confusing.
   */
  async function routeOne(leadId: string): Promise<void> {
    setRoutingId(leadId);
    try {
      const result = await api.routeLead(leadId);
      const { decision, already_routed: alreadyRouted } = result;
      notify(
        alreadyRouted
          ? {
              tone: 'info',
              title: 'Already routed',
              detail: 'This lead already has an owner, so nothing was changed.',
            }
          : {
              tone: 'success',
              title: 'Lead routed',
              detail:
                decision.routing_reason ??
                'An owner was assigned and the response clock has started.',
            }
      );
      await load();
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
      notify(failureFor(code, error instanceof ApiError ? error.message : undefined));
    } finally {
      setRoutingId(null);
    }
  }

  const enriching = leads.find((lead) => lead.id === enrichId) ?? null;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">Lead queue</h1>
          <p className="mt-1.5 text-sm text-muted">
            Every captured lead, newest first. Nothing is silently discarded.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="lf-pill border-line2 bg-panel2 text-muted">{total} captured</span>
          {live && (
            <span className="lf-pill border-green/40 bg-green/10 text-green" title="Updating automatically as changes happen">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-green" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green" />
              </span>
              Live
            </span>
          )}
          <button
            type="button"
            onClick={() => void load({ announce: true })}
            className="lf-btn-secondary px-4 py-2"
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button
            type="button"
            name="credits_and_budgets"
            onClick={() => setCreditsOpen(true)}
            className="lf-btn-secondary px-4 py-2"
          >
            Credits &amp; Budgets
          </button>
          <Link to="/app/capture" className="lf-btn-primary px-4 py-2">
            Quick Capture
          </Link>
        </div>
      </div>

      {error && (
        <div
          className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-red/40 bg-red/10 px-4 py-3"
          role="alert"
        >
          <p className="text-sm text-red">{error}</p>
          <button
            type="button"
            onClick={() => void load({ announce: true })}
            className="lf-btn-secondary px-4 py-2"
          >
            Retry
          </button>
        </div>
      )}

      {loading && leads.length === 0 ? (
        <p className="mt-10 text-sm text-muted">Loading captures…</p>
      ) : !error && leads.length === 0 ? (
        <div className="lf-panel mt-8 p-12 text-center">
          <h2 className="text-lg font-bold text-text">No captures yet</h2>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted">
            Enter one with Quick Capture, submit the form on the marketing site, or POST to{' '}
            <code className="rounded bg-panel2 px-1.5 py-0.5 font-mono text-xs text-cyan">
              /api/public/leads
            </code>
            .
          </p>
          <Link to="/app/capture" className="lf-btn-primary mt-7">
            Capture a lead
          </Link>
        </div>
      ) : leads.length > 0 ? (
        <div className="mt-8">
          <DataTable
            rows={leads}
            rowKey={(lead) => lead.id}
            caption="Captured leads, newest first, with elapsed time against the 30-minute response window"
            columns={[
              {
                key: 'name', header: 'Name', width: '18%',
                sortValue: (lead) => lead.name ?? null,
                cell: (lead) => <span className="font-semibold text-text">{lead.name ?? '—'}</span>,
              },
              {
                key: 'email', header: 'Email', width: '20%',
                sortValue: (lead) => lead.email ?? null,
                cell: (lead) => lead.email ?? '—',
              },
              {
                key: 'source', header: 'Source',
                sortValue: (lead) => lead.source ?? null,
                cell: (lead) => (
                  <span className="lf-pill border-line2 bg-panel2 text-muted">
                    {SOURCE_LABELS.get(lead.source ?? '') ?? lead.source ?? 'Unknown'}
                  </span>
                ),
              },
              {
                key: 'captured', header: 'Captured',
                // Sorts on the INSTANT, renders the elapsed shorthand. Sorting the
                // rendered string puts "3 hr" after "12 min".
                sortValue: (lead) => (lead.created_at ? Date.parse(lead.created_at) : null),
                cell: (lead) => age(lead.created_at),
              },
              {
                key: 'owner', header: 'Owner',
                sortValue: (lead) => lead.owner_name ?? null,
                cell: (lead) => (lead.owner_user_id ? (
                  <span className="text-text">
                    {lead.owner_name ?? 'Assigned'}
                    {lead.routing_method && (
                      <span className="ml-2 font-mono text-[11px] text-soft">{lead.routing_method}</span>
                    )}
                  </span>
                ) : (
                  <span className="lf-pill border-orange/40 bg-orange/10 text-orange">Unowned</span>
                )),
              },
              {
                key: 'clock', header: 'Response clock',
                sortValue: (lead) => (lead.assigned_at ? Date.parse(lead.assigned_at) : null),
                // The clock only means anything once a lead has an owner — an
                // unrouted lead has no deadline to be measured against.
                cell: (lead) => (lead.assigned_at ? (
                  <span className={`font-mono font-semibold ${slaTone(lead.assigned_at)}`}>
                    {age(lead.assigned_at)}
                    <span className="ml-2 font-sans text-xs font-medium">{slaLabel(lead.assigned_at)}</span>
                  </span>
                ) : (
                  <span className="text-xs text-soft">not started</span>
                )),
              },
            ]}
            rowActions={(lead) => (
              <span className="flex items-center gap-2">
                {!lead.owner_user_id && (
                  <button
                    type="button"
                    onClick={() => void routeOne(lead.id)}
                    className="lf-btn-secondary px-3 py-1.5 text-xs"
                    disabled={routingId === lead.id}
                  >
                    {routingId === lead.id ? 'Routing…' : 'Route'}
                  </button>
                )}
                <button
                  type="button"
                  name="request_enrichment"
                  onClick={() => setEnrichId(lead.id)}
                  className="lf-btn-secondary px-3 py-1.5 text-xs"
                >
                  Enrich
                </button>
              </span>
            )}
          />
        </div>
      ) : null}

      <DataCreditsDrawer open={creditsOpen} onClose={() => setCreditsOpen(false)} />

      {enriching && (
        <ContactEnrichmentModal
          open
          onClose={() => setEnrichId(null)}
          subjectRef={enriching.id}
          contactLabel={enriching.name ?? enriching.email ?? enriching.id}
          contactContext={enriching.email ?? undefined}
        />
      )}
    </div>
  );
}

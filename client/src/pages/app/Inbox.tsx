import { useEffect, useState } from 'react';
import { api, ApiError, type UnifiedInbox } from '../../services/api';
import { DataTable, type Column } from '../../design-system/data/DataTable';
import type { InboxThread } from '../../services/api';
import { formatWhen, ownerLabel } from '../../utils/display';

/**
 * The unified inbox — one chronological timeline (SOP P0).
 *
 * ORDERING IS THE PRODUCT, AND IT IS THE SERVER'S JOB. Messages arrive out of
 * order from different providers: an email webhook can land seconds after the
 * SMS reply that answers it, and a voicemail transcript minutes after both. The
 * thread is therefore ordered on a NORMALIZED occurrence time computed upstream,
 * never on arrival and never on a provider's own timestamp — provider clocks
 * disagree, and sorting on them is how a reply appears above the message it
 * answers. Nothing in this screen re-sorts.
 *
 * ONE THREAD, EVERY CHANNEL. Email, SMS, call, voicemail, social DM, web chat,
 * internal note and meeting share one timeline rather than one tab each. Tabs
 * per channel are how a rep answers an email that a text message already
 * answered an hour earlier.
 *
 * AN INBOUND REPLY LANDS ON THE OWNER WITH AN URGENT TASK. A reply that arrives
 * into a shared queue and belongs to nobody is the exact leak the operating
 * model exists to close.
 */

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'awaiting_reply', label: 'Awaiting reply' },
  { key: 'my_leads', label: 'My leads' },
  { key: 'sla_at_risk', label: 'SLA at risk' },
  { key: 'needs_review', label: 'Needs review' },
];

const shown = (value: string | null): string => (value && value.trim() !== '' ? value : '--');

export default function Inbox() {
  const [filter, setFilter] = useState('all');
  const [data, setData] = useState<UnifiedInbox | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        setData(await api.inbox(filter, controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(caught instanceof ApiError ? caught.message : 'The inbox could not be read.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [filter]);

  const columns: Column<InboxThread>[] = [
    {
      key: 'contact',
      header: 'Contact',
      width: '22%',
      cell: (r) => (
        <div>
          <p className={r.unread ? 'font-semibold text-text' : 'text-text'}>{shown(r.contact)}</p>
          <p className="text-[11px] text-soft">{shown(r.channel)}</p>
        </div>
      ),
    },
    { key: 'subject', header: 'Subject', cell: (r) => shown(r.subject), width: '32%' },
    { key: 'owner', header: 'Owner', cell: (r) => ownerLabel(r.owner), width: '16%' },
    {
      key: 'state',
      header: 'State',
      width: '18%',
      cell: (r) => (
        <span className={r.sla_at_risk ? 'text-gold' : 'text-muted'}>
          {r.sla_at_risk
            ? 'SLA at risk'
            : r.awaiting_reply
              ? 'Awaiting reply'
              : r.needs_review
                ? 'Needs review'
                : 'Open'}
        </span>
      ),
    },
    {
      key: 'last',
      header: 'Last message',
      width: '12%',
      // Sorted on the normalized occurrence time the server supplies.
      sortValue: (r) => r.last_message_at,
      cell: (r) => formatWhen(r.last_message_at),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-text">Inbox</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-muted">
          Email, SMS, call, voicemail, social DM, web chat, internal note and meeting in one
          chronological thread. A channel per tab is how a rep answers an email that a text
          message already answered an hour ago.
        </p>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {FILTERS.map((option) => {
          const count = data?.filters.find((f) => f.key === option.key)?.count;
          return (
            <button
              key={option.key}
              type="button"
              name={`filter_${option.key}`}
              onClick={() => setFilter(option.key)}
              className={`lf-pill px-3 py-1.5 ${
                filter === option.key ? 'border-blue bg-blue/10 text-blue' : 'border-line2 text-muted'
              }`}
            >
              {option.label}
              {count !== null && count !== undefined && <span className="ml-2">{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="lf-panel mt-4 p-5">
        <DataTable
          rows={data?.threads ?? []}
          columns={columns}
          rowKey={(r) => r.thread_id}
          loading={loading}
          density="dense"
          height={560}
          caption="Unified inbox"
          error={error ? <span>{error}</span> : undefined}
          empty={<span>No threads match this filter.</span>}
        />
      </div>

      <section className="lf-panel mt-4 p-5" aria-label="Ordering">
        <h2 className="lf-eyebrow">How the thread is ordered</h2>
        <p className="mt-1 text-sm text-muted">
          Messages are ordered on a normalized occurrence time computed upstream, never on when
          they arrived here and never on a provider's own clock. Provider clocks disagree, and
          sorting on them is how a reply appears above the message it answers.
        </p>
        <p className="mt-2 text-sm text-muted">
          An inbound reply is assigned to the record owner and raises an urgent task. A reply that
          lands in a shared queue and belongs to nobody is the leak the operating model exists to
          close.
        </p>
      </section>
    </div>
  );
}

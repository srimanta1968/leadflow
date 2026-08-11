import { useEffect, useState } from 'react';
import { api, ApiError, type TemplateList, type TemplateRow } from '../../services/api';
import { DataTable, type Column } from '../../design-system/data/DataTable';
import { isAllowed, usePermissions } from '../../platform/permissions';
import { chipClass } from '../../design-system/tokens';

/**
 * The approved message template library (SOP, "SMS TEMPLATE LIBRARY").
 *
 * ONE TEMPLATE, ONE ACTION. The playbook's standard is "short, conversational,
 * permission-aware, and tied to one action", and the last clause is the one
 * that gets lost. A message that asks the customer to both pick a time AND
 * answer a qualifying question gets neither: the reply rate collapses because
 * the recipient has to decide which question to answer first. The register
 * therefore records the intended action as a FIELD, so a template with two of
 * them is visible as a defect rather than as prose somebody has to read
 * carefully.
 *
 * AN UNAPPROVED TEMPLATE IS NOT REACHABLE FROM COMPOSE. That is the entire
 * point of an approved library — if a rep can improvise the wording of a
 * governed message, the library documents what we intended to send rather than
 * what we sent. Publishing is gated on message.publish_template, a grant that
 * already exists in the policy set and, until this screen, nothing used.
 *
 * THE OPT-OUT AFFORDANCE IS PART OF THE TEMPLATE, not of the sender. Every SMS
 * body in the playbook ends "Reply STOP to opt out", and a template missing it
 * cannot publish: attaching the opt-out at send time means one code path away
 * from a compliant message becoming a non-compliant one.
 *
 * EDITING CREATES A VERSION. A dispute six months from now is about what was
 * actually sent, and a template edited in place cannot answer that.
 */

const VERDICT_ROLE = { allow: 'success', review: 'warning', deny: 'blocked' } as const;

/** The ten triggers the playbook requires an approved template for. */
const REQUIRED_TRIGGERS = [
  'immediate_inbound', 'after_hours', 'no_answer', 'callback_confirmed',
  'demo_booked', 'two_hour_reminder', 'no_show', 'decision_checkout',
  'closed_won', 'breakup',
];

const shown = (value: string | null): string => (value && value.trim() !== '' ? value : '--');

export default function Templates() {
  const [data, setData] = useState<TemplateList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const permissions = usePermissions([
    { action: 'message.publish_template', resourceType: 'template' },
  ]);
  const mayPublish = isAllowed(permissions, 'message.publish_template');

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setData(await api.templates(controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(caught instanceof ApiError ? caught.message : 'Templates could not be read.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  /** Triggers with no approved template. The gap the register exists to show. */
  const covered = new Set((data?.templates ?? []).map((t) => t.trigger).filter(Boolean));
  const missing = REQUIRED_TRIGGERS.filter((t) => !covered.has(t as never));

  const columns: Column<TemplateRow>[] = [
    { key: 'trigger', header: 'Trigger', cell: (r) => shown(r.trigger), width: '14%' },
    { key: 'channel', header: 'Channel', cell: (r) => r.channel, width: '9%' },
    {
      key: 'body',
      header: 'Approved template',
      width: '34%',
      cell: (r) => <span className="text-text">{r.body}</span>,
    },
    {
      key: 'action',
      header: 'Intended action',
      width: '14%',
      // One. See the module comment.
      cell: (r) => shown(r.intended_action),
    },
    {
      key: 'optout',
      header: 'Opt-out',
      width: '11%',
      cell: (r) =>
        r.opt_out_affordance ? (
          <span className="text-green">{r.opt_out_affordance}</span>
        ) : (
          <span className="text-red">Absent - cannot publish</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '10%',
      cell: (r) => (
        <span className={`lf-pill ${chipClass(r.status === 'published' ? 'success' : 'warning')}`}>
          {r.status ?? 'unknown'}
          {r.version !== null ? ` v${r.version}` : ''}
        </span>
      ),
    },
    {
      key: 'gate',
      header: 'Gate',
      width: '8%',
      cell: (r) =>
        r.gate ? (
          <span className={`lf-pill ${chipClass(VERDICT_ROLE[r.gate.verdict])}`}>
            {r.gate.verdict}
          </span>
        ) : (
          '--'
        ),
    },
  ];

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">Message Templates</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-muted">
            Short, conversational, permission-aware and tied to one action. A rep cannot improvise
            the wording of a governed message, so what we intended to send and what we sent are
            the same thing.
          </p>
        </div>
        <button
          type="button"
          name="new_template"
          disabled={!mayPublish}
          title={mayPublish ? undefined : 'Publishing requires message.publish_template'}
          className="lf-btn-primary px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          New template
        </button>
      </div>

      {!mayPublish && (
        <p className="mt-4 rounded border border-gold/40 bg-gold/10 px-3 py-2 text-sm text-gold">
          You may read the library but not publish to it. Publishing requires
          message.publish_template.
        </p>
      )}

      {/* --------------------------------------------------- the SMS gate */}
      <section className="lf-panel mt-6 p-5" aria-label="The SMS gate">
        <h2 className="lf-eyebrow">The SMS gate</h2>
        <p className="mt-1 text-sm text-muted">
          Automated texts run only when the record has an approved eligibility or consent basis
          AND is inside allowed hours. STOP, unsubscribe, complaint, invalid number or
          do-not-contact suppresses queued sales texts immediately.
        </p>
        <p className="mt-2 text-xs text-soft">
          {data?.gate_owner ?? 'Legal and Compliance'} owns the final rules. This screen reports
          them; it does not let a sender vary them.
        </p>
      </section>

      {/* -------------------------------------------- uncovered triggers */}
      {!loading && missing.length > 0 && (
        <section className="lf-panel mt-4 border-gold/40 p-5" aria-label="Triggers with no template">
          <h2 className="lf-eyebrow text-gold">Triggers with no approved template</h2>
          <p className="mt-1 text-xs text-soft">
            A trigger with no approved template is a moment the playbook expects a message and
            none can be sent - or worse, one gets improvised.
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {missing.map((trigger) => (
              <li key={trigger} className="lf-pill border-gold/50 text-gold">
                {trigger}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="lf-panel mt-4 p-5">
        <DataTable
          rows={data?.templates ?? []}
          columns={columns}
          rowKey={(r) => r.template_id}
          loading={loading}
          density="dense"
          height={520}
          caption="Approved message templates"
          error={error ? <span>{error}</span> : undefined}
          empty={<span>No approved templates are registered.</span>}
        />
      </div>

      <section className="lf-panel mt-4 p-5" aria-label="Versioning">
        <h2 className="lf-eyebrow">Versioning</h2>
        <p className="mt-1 text-sm text-muted">
          An edited template becomes a new version, and a message already sent keeps referencing
          the version it was sent under. A template edited in place cannot answer what was
          actually sent, which is the only question a dispute ever asks.
        </p>
      </section>
    </div>
  );
}

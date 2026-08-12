import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type ContactConversations } from '../../../services/api';
import { useContactRecord } from '../ContactRecordContext';
import { chipClass } from '../../../design-system/tokens';

/**
 * Contact 360 Conversations (#c-conversations) — the unified thread and the
 * compose guardrails.
 *
 * COMPOSE IS BLOCKED BEFORE THE SEND, NOT AT IT. That is the acceptance
 * condition and the entire reason the guardrail panel is rendered next to the
 * control it governs. The alternative that every messaging UI reaches for first
 * — let the operator write the message, then fail on dispatch — wastes the work
 * and, worse, teaches them that the refusal is a transient error to retry. A
 * disabled control with the reason beside it is a rule; a failed send is a bug
 * report.
 *
 * THE VERDICT TEXT IS RENDERED VERBATIM. The decision engine's sentences are
 * specific in ways a UI cannot reproduce — "purpose-specific receipt valid;
 * sender registration healthy; local-time window open" names three independent
 * conditions, and a paraphrase that dropped any one of them would tell an
 * operator the wrong thing about what to fix. Nothing here composes, shortens or
 * re-cases that string.
 *
 * INTERNAL NOTES ARE DISTINCT SEMANTICALLY, NOT ONLY VISUALLY. Colour alone
 * fails exactly the operator who most needs the distinction, so an internal note
 * also carries its own label and is announced as internal. The criterion is that
 * an internal note cannot be ACCIDENTALLY sent to the customer, and a note that
 * merely looks different is one mis-click away from being sent.
 *
 * ORDERING IS THE SERVER'S. Messages arrive out of order from different
 * providers and are sorted on their normalized occurrence time, never on
 * arrival. Sorting in the browser on a provider timestamp is how an SMS reply
 * ends up above the message it answers.
 */

const FRAMING =
  'Every interaction is scoped to channel, purpose, property, lead/project, sender identity and current eligibility.';

const VERDICT_ROLE = { allow: 'success', review: 'warning', deny: 'blocked' } as const;
const VERDICT_LABEL = { allow: 'Allow', review: 'Review', deny: 'Deny' } as const;

export default function ConversationsTab() {
  const { contactId } = useContactRecord();
  const [data, setData] = useState<ContactConversations | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        setData(await api.contactConversations(contactId, controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setData(null);
        setError(caught instanceof ApiError ? caught.message : 'The thread could not be read.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [contactId]);

  /**
   * Whether Compose may be used at all.
   *
   * FAILS CLOSED, and deliberately not on "no deny present": before the verdicts
   * arrive there are no denies either, and treating that as permission would
   * flash an enabled control on every load. Compose opens only on an explicit
   * allow.
   */
  const composable = useMemo(
    () => (data?.compose_guardrails ?? []).some((decision) => decision.verdict === 'allow'),
    [data],
  );

  return (
    <section aria-label="Conversations">
      <div className="lf-panel p-5">
        <h2 className="text-lg font-semibold text-text">Unified Conversations</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">{FRAMING}</p>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {/* ------------------------------------------------- the thread */}
        <div className="lf-panel p-5 lg:col-span-2">
          {error && (
            <p className="mb-3 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
              {error}
            </p>
          )}

          {loading && (
            <p role="status" className="py-8 text-center text-sm text-muted">
              Reading the thread...
            </p>
          )}

          <ol className="space-y-3">
            {(data?.messages ?? []).map((message) => (
              <li
                key={message.message_id}
                className={`rounded-lg border p-3 ${
                  message.customer_visible
                    ? 'border-line bg-panel2'
                    : // An internal note is a different KIND of thing, not a
                      // differently-coloured message.
                      'border-dashed border-line2 bg-panel3'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="lf-pill">{message.channel ?? 'Unknown channel'}</span>
                  {message.direction && <span className="text-soft">{message.direction}</span>}
                  {!message.customer_visible && (
                    <span className={`lf-pill ${chipClass('info')}`}>Internal note</span>
                  )}
                  {message.purpose && <span className="text-soft">{message.purpose}</span>}
                  {message.property_context && (
                    <span className="text-soft">{message.property_context}</span>
                  )}
                  <span className="ml-auto text-soft">{message.occurred_at ?? '--'}</span>
                </div>

                {message.quoted_body && (
                  <blockquote className="mt-2 border-l-2 border-line2 pl-3 text-xs text-soft">
                    {message.quoted_body}
                  </blockquote>
                )}

                <p className="mt-2 text-sm text-text">{message.body}</p>

                <p className="mt-1.5 text-[11px] text-soft">
                  {message.customer_visible
                    ? `Customer visible · ${message.delivery_state ?? 'delivery state unknown'}${
                        message.read_state ? ` · ${message.read_state}` : ''
                      }`
                    : 'Not customer visible - internal only'}
                </p>
              </li>
            ))}
          </ol>

          {!loading && (data?.messages ?? []).length === 0 && !error && (
            <p className="py-8 text-center text-sm text-soft">
              No interactions are recorded on this thread.
            </p>
          )}
        </div>

        {/* -------------------------------------- the guardrails + compose */}
        <aside className="lf-panel p-5" aria-label="Compose Guardrails">
          <h3 className="lf-eyebrow">Compose Guardrails</h3>
          <p className="mt-1 text-xs text-soft">
            The channel decision as the engine returned it. Compose is disabled here rather than
            failing at send time.
          </p>

          <ul className="mt-3 space-y-3">
            {(data?.compose_guardrails ?? []).map((decision) => (
              <li key={`${decision.purpose}:${decision.channel}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`lf-pill ${chipClass(VERDICT_ROLE[decision.verdict])}`}>
                    {VERDICT_LABEL[decision.verdict]}
                  </span>
                  <span className="text-sm text-text">
                    {decision.purpose} · {decision.channel}
                  </span>
                </div>
                {/* Verbatim. See the header comment. */}
                <p className="mt-1 text-xs text-soft">{decision.reason}</p>
              </li>
            ))}
            {!loading && (data?.compose_guardrails ?? []).length === 0 && (
              <li className="text-sm text-muted">
                No channel decision was returned, so composing stays closed.
              </li>
            )}
          </ul>

          <button
            type="button"
            name="compose"
            disabled={!composable}
            className="lf-btn-primary mt-4 w-full px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Compose
          </button>

          {!composable && (
            <p className="mt-2 text-xs text-soft">
              Compose is unavailable because no channel currently carries an allow verdict.
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}

import { useEffect, useState } from 'react';
import { api, ApiError, type RoutingConfig, type RoutingTrace } from '../../services/api';
import { Drawer } from '../../design-system/overlays/Drawer';

/**
 * Routing rule configuration and the six-step decision engine (SOP §30).
 *
 * THE DECISION TRACE IS THE FEATURE. Routing is the part of the system a
 * manager is most often asked to defend — "why did this lead go to her and not
 * to him" — and a router that cannot answer gets overridden until it is not
 * really routing any more. Each of the six steps therefore explains itself in
 * PLAIN LANGUAGE and reports how many candidates it removed, because "step 4
 * filtered" is not an explanation and a manager cannot repeat it to a rep.
 *
 * AN AMBIGUOUS LEAD GOES TO REVIEW, NEVER TO A FORCED ASSIGNMENT. Assigning a
 * lead the rules could not resolve produces an owner who does not know why they
 * own it and a queue nobody audits; sending it to a review queue produces one
 * visible decision. The trace panel says which of the two happened, so a review
 * queue that is filling up is discoverable rather than silent.
 *
 * THE CONFIG IS VERSIONED AND PUBLISHING NEEDS AN APPROVAL. A routing change is
 * one of the few edits here that silently redirects revenue, and the person best
 * placed to catch a mistake is not the person making it.
 */

/**
 * The six steps, in evaluation order, worded as the SOP words them.
 *
 * Rendered from a constant rather than from the response so the screen can show
 * WHAT the engine does even when it cannot reach the engine — an operator
 * opening this during an outage still needs to know the order.
 */
const SIX_STEPS = [
  { step: 1, name: 'Eligibility', detail: 'Who may receive this lead at all, by policy.' },
  { step: 2, name: 'Priority band', detail: 'P0 to P3, from the verified signal rather than from a guess.' },
  { step: 3, name: 'Coverage', detail: 'Who is actually available in this window, by name.' },
  { step: 4, name: 'Specialty match', detail: 'Segment, geography, language, partner, product and conflicts.' },
  { step: 5, name: 'Capacity', detail: 'Who has room, so a match is not made into an overload.' },
  { step: 6, name: 'Rotation', detail: 'Fair share among everyone still standing after the five above.' },
];

/** The SOP's four bands. Re-interpreting these locally is how P0 stops meaning anything. */
const BANDS = [
  { band: 'P0', definition: 'Verified purchase' },
  { band: 'P1', definition: 'Form, demo, pricing or checkout intent' },
  { band: 'P2', definition: 'Active social engagement or referral' },
  { band: 'P3', definition: 'Nurture or content' },
];

const SPECIALTY_DIMENSIONS = [
  'Segment',
  'Geography',
  'Language',
  'Partner',
  'Account owner',
  'Product need',
  'Conflict rules',
];

export default function RoutingConfiguration() {
  const [config, setConfig] = useState<RoutingConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);
  const [leadId, setLeadId] = useState('');
  const [trace, setTrace] = useState<RoutingTrace | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setConfig(await api.routingConfig(controller.signal));
        setError(null);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setConfig(null);
        setError(
          caught instanceof ApiError ? caught.message : 'The routing configuration could not be read.',
        );
      }
    })();
    return () => controller.abort();
  }, []);

  const readTrace = async () => {
    setTraceError(null);
    setTrace(null);
    try {
      setTrace(await api.routingTrace(leadId));
    } catch (caught) {
      setTraceError(caught instanceof ApiError ? caught.message : 'The trace could not be read.');
    }
  };

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">Routing Configuration</h1>
          <p className="mt-1.5 max-w-3xl text-sm text-muted">
            Six steps in a fixed order. Every assignment can be explained back to a rep in the
            words below, and a lead the rules cannot resolve goes to review rather than to
            somebody who will not know why they have it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            name="open_decision_trace"
            onClick={() => setTraceOpen(true)}
            className="lf-btn-secondary px-4 py-2"
          >
            Decision trace
          </button>
          <button
            type="button"
            name="publish_config"
            className="lf-btn-primary px-4 py-2"
          >
            Request publish approval
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}

      <div className="lf-panel mt-6 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="lf-eyebrow">Version</h2>
          <p className="text-sm text-muted">
            {config
              ? `Version ${config.version ?? '--'} · ${config.status ?? 'unknown status'}`
              : 'Version not read'}
          </p>
        </div>
        <p className="mt-2 text-xs text-soft">
          Publishing requires an approval and is rollback-able. A routing change silently
          redirects revenue, and the person best placed to catch a mistake is not the one making
          it.
        </p>
      </div>

      {/* ------------------------------------------------- the six steps */}
      <section className="lf-panel mt-4 p-5" aria-label="The six-step decision engine">
        <h2 className="lf-eyebrow">The six-step decision engine</h2>
        <ol className="mt-3 space-y-3">
          {SIX_STEPS.map((step) => (
            <li key={step.step} className="lf-card p-3">
              <p className="text-sm font-semibold text-text">
                Step {step.step}. {step.name}
              </p>
              <p className="mt-0.5 text-xs text-soft">{step.detail}</p>
            </li>
          ))}
        </ol>
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* ------------------------------------------------ priority bands */}
        <section className="lf-panel p-5" aria-label="Priority bands">
          <h2 className="lf-eyebrow">Priority bands</h2>
          <p className="mt-1 text-xs text-soft">
            Mapped to the SOP definitions exactly. A local re-interpretation is how P0 stops
            meaning a verified purchase and starts meaning whatever felt urgent.
          </p>
          <ul className="mt-3 space-y-2">
            {BANDS.map((band) => (
              <li key={band.band} className="flex items-baseline gap-3 text-sm">
                <span className="lf-pill border-line2 text-text">{band.band}</span>
                <span className="text-muted">{band.definition}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* -------------------------------------------- specialty matchers */}
        <section className="lf-panel p-5" aria-label="Specialty matchers">
          <h2 className="lf-eyebrow">Specialty matchers</h2>
          <p className="mt-1 text-xs text-soft">
            Each narrows the candidate set at step 4. A matcher nobody can turn off is a rule
            nobody can audit.
          </p>
          <ul className="mt-3 space-y-2">
            {SPECIALTY_DIMENSIONS.map((dimension) => {
              const configured = config?.specialty_matchers.find((m) => m.dimension === dimension);
              return (
                <li key={dimension} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-text">{dimension}</span>
                  <span className="text-xs text-soft">
                    {configured ? (configured.enabled ? 'Enabled' : 'Disabled') : 'Not read'}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {/* -------------------------------------------- the review queue rule */}
      <section className="lf-panel mt-4 p-5" aria-label="Review queue">
        <h2 className="lf-eyebrow">Review queue</h2>
        <p className="mt-1 text-sm text-muted">
          A lead the six steps cannot resolve is sent to review and never force-assigned. A forced
          assignment produces an owner who does not know why they own it; a review queue produces
          one visible decision.
        </p>
      </section>

      {/* ------------------------------------------------ the trace drawer */}
      <Drawer
        open={traceOpen}
        onClose={() => setTraceOpen(false)}
        title="Decision trace"
        subtitle="Why this lead went to this rep, one step at a time."
      >
        <div className="space-y-4">
          <div>
            <label className="lf-label" htmlFor="trace_lead_id">
              Lead reference
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="trace_lead_id"
                name="trace_lead_id"
                className="lf-input flex-1"
                value={leadId}
                onChange={(event) => setLeadId(event.target.value)}
              />
              <button
                type="button"
                name="read_trace"
                onClick={() => void readTrace()}
                disabled={leadId.trim() === ''}
                className="lf-btn-secondary px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Read trace
              </button>
            </div>
          </div>

          {traceError && (
            <p className="rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">
              {traceError}
            </p>
          )}

          {trace?.sent_to_review_queue && (
            <p className="rounded border border-gold/40 bg-gold/10 px-3 py-2 text-sm text-gold">
              This lead was sent to the review queue rather than assigned.{' '}
              {trace.review_reason ?? 'No reason was recorded.'}
            </p>
          )}

          <ol className="space-y-3">
            {(trace?.steps ?? []).map((step) => (
              <li key={step.step} className="lf-card p-3">
                <p className="text-sm font-semibold text-text">
                  Step {step.step}. {step.name}
                </p>
                {/* Plain language, because a manager has to repeat this to a rep. */}
                <p className="mt-1 text-xs text-muted">{step.explanation}</p>
                <p className="mt-1 text-[11px] text-soft">
                  {step.candidates_before === null || step.candidates_after === null
                    ? step.outcome
                    : `${step.candidates_before} candidates in, ${step.candidates_after} out - ${step.outcome}`}
                </p>
              </li>
            ))}
          </ol>

          {trace === null && !traceError && (
            <p className="text-sm text-soft">
              Name a lead above to read the six steps that placed it.
            </p>
          )}
        </div>
      </Drawer>
    </div>
  );
}

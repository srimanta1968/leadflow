import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type CertificationRecord,
  type GoLiveStatus,
} from '../../services/api';
import { useToast } from '../../components/feedback/ToastProvider';

/**
 * Post-mortem workflow, rep certification and launch governance
 * (SOP §23, §49 and §50).
 *
 * THE CERTIFICATION GATE IS AN INPUT TO ROUTING, NOT A REPORT ABOUT IT. An
 * uncertified rep receives no live P0 or P1 lead — enforced where assignment
 * happens, so it holds whether the lead arrives through the console, an
 * automation or an API call. A screen that merely DISPLAYS certification while
 * routing ignores it is worse than none: it tells a manager the control exists.
 *
 * EVERY CORRECTIVE ACTION BECOMES A TRACKED OWNED TASK. This is what separates a
 * post-mortem from a meeting. Actions recorded as prose in a document are
 * completed at roughly the rate they are re-read, which is once; an action with
 * an owner and a due date is in somebody's queue on Monday. The form therefore
 * refuses an action with no owner or no date rather than accepting it and hoping.
 *
 * NO-BLAME IS STRUCTURAL. The Root cause section names people, process, system,
 * data, third-party, training and policy as SEVEN CATEGORIES, because a form
 * with one free-text "cause" box collects the name of whoever was on shift.
 *
 * GO-LIVE NEEDS ALL TWELVE GATES AND ALL FIVE SIGNATURES, and the record is
 * immutable in the audit chain. A governance record that can be edited after the
 * fact is a record of what people currently wish they had approved.
 */

/** The five post-mortem sections, per §50. */
const POST_MORTEM_SECTIONS = [
  {
    key: 'facts',
    label: 'Facts',
    fields: ['Timeline', 'Affected leads', 'Customer impact', 'System and user events', 'Current containment'],
  },
  {
    key: 'detection',
    label: 'Detection',
    fields: ['How it was found', 'Why monitoring did or did not catch it sooner'],
  },
  {
    key: 'root_cause',
    label: 'Root cause',
    fields: ['People', 'Process', 'System', 'Data', 'Third-party', 'Training', 'Policy'],
  },
  {
    key: 'corrective_action',
    label: 'Corrective action',
    fields: ['Immediate fix', 'Permanent control'],
  },
  {
    key: 'verification',
    label: 'Verification',
    fields: ['Acceptance test', 'Metric', 'Retest date', 'SOP or template version update', 'Affected-lead recovery'],
  },
];

/** The eight certification stations, per §49. */
const STATIONS = [
  { key: 'crm_hygiene', label: 'CRM hygiene' },
  { key: 'speed_to_lead', label: 'Speed to lead' },
  { key: 'first_call', label: 'First call' },
  { key: 'discovery', label: 'Discovery' },
  { key: 'demo', label: 'Demo' },
  { key: 'objections', label: 'Objections' },
  { key: 'close_and_payment', label: 'Close and payment' },
  { key: 'calendar_and_onboarding', label: 'Calendar and onboarding' },
];

/** The five signatures the go-live record requires. */

interface CorrectiveAction {
  text: string;
  owner: string;
  due: string;
}

export default function Governance() {
  const [certification, setCertification] = useState<CertificationRecord | null>(null);
  const [goLive, setGoLive] = useState<GoLiveStatus | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [actions, setActions] = useState<CorrectiveAction[]>([]);
  const [draft, setDraft] = useState<CorrectiveAction>({ text: '', owner: '', due: '' });
  const { notify } = useToast();

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setCertification(await api.certification('current', controller.signal));
      } catch {
        if (!controller.signal.aborted) setCertification(null);
      }
      try {
        setGoLive(await api.goLiveStatus(controller.signal));
      } catch (caught) {
        if (!controller.signal.aborted && caught instanceof ApiError) setGoLive(null);
      }
    })();
    return () => controller.abort();
  }, []);

  // An action with no owner or no date is a wish. The form refuses it here
  // rather than accepting it and quietly producing an untracked item.
  const actionComplete =
    draft.text.trim() !== '' && draft.owner.trim() !== '' && draft.due !== '';

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold text-text">Governance</h1>
        <p className="mt-1.5 max-w-3xl text-sm text-muted">
          The 30-minute no-blame post-mortem, the rep certification gate, and the go-live record
          that needs all twelve gates and all five signatures.
        </p>
      </div>

      {/* ------------------------------------------------- the post-mortem */}
      <h2 className="mt-8 text-lg font-semibold text-text">Post-mortem</h2>
      <p className="mt-1 text-sm text-muted">
        Thirty minutes, five sections, no blame. Root cause is seven categories rather than one
        box, because one box collects the name of whoever was on shift.
      </p>

      {POST_MORTEM_SECTIONS.map((section) => (
        <section key={section.key} className="lf-panel mt-4 p-5" aria-label={section.label}>
          <h3 className="lf-eyebrow">{section.label}</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {section.fields.map((field) => {
              const key = `${section.key}:${field}`;
              return (
                <div key={key}>
                  <label className="lf-label" htmlFor={key}>
                    {field}
                  </label>
                  <input
                    id={key}
                    name={key}
                    className="lf-input mt-1 w-full"
                    value={values[key] ?? ''}
                    onChange={(event) =>
                      setValues((current) => ({ ...current, [key]: event.target.value }))
                    }
                  />
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {/* ------------------------------------- corrective actions as tasks */}
      <section className="lf-panel mt-4 p-5" aria-label="Corrective actions">
        <h3 className="lf-eyebrow">Corrective actions</h3>
        <p className="mt-1 text-xs text-soft">
          Each becomes a tracked task with one owner and one due date. Actions recorded as prose
          are completed at roughly the rate they are re-read.
        </p>

        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          <input
            id="action_text"
            name="action_text"
            className="lf-input sm:col-span-2"
            placeholder="What will be done"
            value={draft.text}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          />
          <input
            id="action_owner"
            name="action_owner"
            className="lf-input"
            placeholder="Owner"
            value={draft.owner}
            onChange={(event) => setDraft({ ...draft, owner: event.target.value })}
          />
          <input
            id="action_due"
            name="action_due"
            type="date"
            className="lf-input"
            value={draft.due}
            onChange={(event) => setDraft({ ...draft, due: event.target.value })}
          />
        </div>

        <button
          type="button"
          name="add_corrective_action"
          disabled={!actionComplete}
          onClick={() => {
            setActions((current) => [...current, draft]);
            setDraft({ text: '', owner: '', due: '' });
          }}
          className="lf-btn-secondary mt-3 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add corrective action
        </button>

        {!actionComplete && (draft.text !== '' || draft.owner !== '' || draft.due !== '') && (
          <p className="mt-2 text-xs text-gold">
            An action needs one owner and one due date. Without both it is a wish, not a task.
          </p>
        )}

        <ul className="mt-3 space-y-2">
          {actions.map((action, index) => (
            <li key={`${action.text}:${index}`} className="lf-card p-3 text-sm">
              <p className="text-text">{action.text}</p>
              <p className="mt-0.5 text-xs text-soft">
                {action.owner} · due {action.due}
              </p>
            </li>
          ))}
          {actions.length === 0 && (
            <li className="text-sm text-muted">No corrective actions recorded yet.</li>
          )}
        </ul>

        <button
          type="button"
          name="submit_post_mortem"
          disabled={actions.length === 0}
          onClick={() =>
            notify({
              tone: 'success',
              title: 'Post-mortem recorded',
              detail: `${actions.length} corrective actions are now tracked tasks.`,
            })
          }
          className="lf-btn-primary mt-3 px-4 py-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Record post-mortem
        </button>
      </section>

      {/* ------------------------------------------------- certification */}
      <h2 className="mt-8 text-lg font-semibold text-text">Rep certification</h2>
      <section className="lf-panel mt-4 p-5" aria-label="Certification">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="lf-eyebrow">The eight stations</h3>
          <p className="text-sm text-muted">
            Score {certification?.score === null || certification?.score === undefined ? '--' : certification.score}
          </p>
        </div>

        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {STATIONS.map((station) => {
            const live = certification?.stations?.find((s) => s.key === station.key);
            return (
              <li key={station.key} className="lf-card p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm text-text">{station.label}</span>
                  <span
                    className={`text-xs ${
                      live?.passed === true ? 'text-green' : live?.passed === false ? 'text-red' : 'text-soft'
                    }`}
                  >
                    {live?.passed === true ? 'Passed' : live?.passed === false ? 'Failed' : 'Not assessed'}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-soft">
                  {live?.pass_standard ?? 'Pass standard not read'}
                </p>
              </li>
            );
          })}
        </ul>

        {/* The gate, in the words that matter to a manager. */}
        <p
          className={`mt-4 rounded border px-3 py-2 text-sm ${
            certification?.gate?.passed
              ? 'border-green/40 bg-green/10 text-green'
              : 'border-gold/40 bg-gold/10 text-gold'
          }`}
        >
          {certification?.gate?.passed
            ? 'Certification gate passed. This rep may receive live P0 and P1 leads.'
            : `Certification gate not passed. This rep receives no live P0 or P1 leads. ${
                certification?.gate?.reason ?? 'The certification record could not be read.'
              }`}
        </p>
      </section>

      {/* ---------------------------------------------------- go-live */}
      <h2 className="mt-8 text-lg font-semibold text-text">Go-live governance record</h2>
      <section className="lf-panel mt-4 p-5" aria-label="Go live">
        <h3 className="lf-eyebrow">Checks</h3>
        {/* THE SERVER'S OWN CHECK LIST, not a fixed grid of twelve. The endpoint
            returns whichever checks it evaluated; rendering exactly twelve slots
            invented four that were never assessed and hid any thirteenth. */}
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(goLive?.checks ?? []).map((check) => (
            <li key={check.key} className="lf-card p-3">
              <p className="text-sm text-text">{check.key}</p>
              <p className={`mt-0.5 text-xs ${check.passed ? 'text-green' : 'text-red'}`}>
                {check.passed ? 'Passed' : 'Failed'}
              </p>
              <p className="mt-0.5 text-[11px] text-soft">{check.detail}</p>
            </li>
          ))}
          {(goLive?.checks ?? []).length === 0 && (
            <li className="text-sm text-muted">The governance record could not be read.</li>
          )}
        </ul>

        {/* Signatures are not part of this response. Claiming "Not signed" for
            five named roles would assert something the server never said. */}

        <p
          className={`mt-4 rounded border px-3 py-2 text-sm ${
            goLive?.ready ? 'border-green/40 bg-green/10 text-green' : 'border-gold/40 bg-gold/10 text-gold'
          }`}
        >
          {goLive?.ready
            ? `Every check passed. Go-live is approved. Basis: ${goLive.basis}`
            : (goLive?.blocking ?? []).length > 0
              ? `Not ready for go-live. Blocking: ${goLive?.blocking.join('; ')}`
              : 'Not ready for go-live. The governance record could not be read.'}
        </p>

        {goLive?.evaluated_at && (
          <p className="mt-1 text-xs text-soft">Evaluated {goLive.evaluated_at}.</p>
        )}

        <p className="mt-2 text-xs text-soft">
          The record is written to the audit chain and cannot be edited afterwards. A governance
          record that can be changed later is a record of what people currently wish they had
          approved.
        </p>
      </section>
    </div>
  );
}

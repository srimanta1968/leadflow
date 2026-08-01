import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, ApiError, LeadSource, SlaPolicy } from '../../services/api';
import { Field, FormError } from '../../components/forms/Field';
import { useToast } from '../../components/feedback/ToastProvider';
import { failureFor } from '../../content/messages';
import { SOURCE_GROUPS, SOURCE_OPTIONS } from '../../content/leadFields';
import { subscribeToEvents } from '../../services/eventStream';
import {
  FieldErrors,
  mapApiError,
  validateFields,
  validateRequiredText,
} from '../../utils/validation';

/** Bounds mirrored from the server validator and migration 005's CHECK. */
const MIN_TARGET_MINUTES = 1;
const MAX_TARGET_MINUTES = 10080;

/**
 * Render a target as something a human reads at a glance.
 *
 * "480 minutes" is technically correct and useless on a settings screen — an
 * operator setting a working-day SLA needs to see that it is eight hours.
 */
function describeTarget(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = minutes / 60;
  if (minutes % 60 === 0) {
    return hours === 24 ? '1 day' : `${hours} hr`;
  }
  return `${Math.floor(hours)} hr ${minutes % 60} min`;
}

/**
 * SLA target configuration.
 *
 * The screen that makes "different lead types get different SLAs" an operator's
 * decision rather than a deploy. Before it, every lead got a flat thirty minutes
 * regardless of how it arrived, which is wrong in both directions: a live-chat
 * prospect is waiting in the window right now, while a CSV-imported row is not
 * waiting at all.
 *
 * The list is ordered exactly as the matcher walks it — ascending
 * `evaluation_order`, first match wins — and says so on screen, because that is
 * the only way a shadowing mistake is visible: a catch-all sitting at a low
 * order silently overrides every policy below it.
 */
export default function SlaSettings() {
  const { notify } = useToast();
  const [policies, setPolicies] = useState<SlaPolicy[]>([]);
  const [defaultMinutes, setDefaultMinutes] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Policy currently open for inline editing. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editMinutes, setEditMinutes] = useState('');
  /** Policy with a mutation in flight, so only its own buttons disable. */
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.listSlaPolicies(false);
      setPolicies(result.policies);
      setDefaultMinutes(result.effective_default_minutes);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
      const message = failureFor(code);
      setLoadError(message.detail ? `${message.title}. ${message.detail}` : message.title);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // Keep the list current when a colleague changes a target. Only policy
    // events matter here — a lead being captured does not change this screen.
    const unsubscribe = subscribeToEvents((event) => {
      if (event.type === 'sla_policy.changed') {
        void load();
      }
    });
    return unsubscribe;
  }, [load]);

  /** Report a failed mutation consistently. */
  function reportFailure(error: unknown): void {
    const mapped = mapApiError(error);
    notify(
      failureFor(
        error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
        mapped.formError ?? undefined
      )
    );
  }

  /** Validate a minutes value, returning an error message or null. */
  function checkMinutes(raw: string): string | null {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < MIN_TARGET_MINUTES || parsed > MAX_TARGET_MINUTES) {
      return `Target must be a whole number of minutes between ${MIN_TARGET_MINUTES} and ${MAX_TARGET_MINUTES}.`;
    }
    return null;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    const form = new FormData(event.currentTarget);
    const values: Record<string, string> = {
      name: String(form.get('name') ?? ''),
      source_channel: String(form.get('source_channel') ?? ''),
      first_response_minutes: String(form.get('first_response_minutes') ?? ''),
      evaluation_order: String(form.get('evaluation_order') ?? ''),
    };
    const businessHoursOnly = form.get('business_hours_only') === 'on';

    const errors = validateFields(values, [
      { field: 'name', validate: (v) => validateRequiredText('name', v) },
      { field: 'first_response_minutes', validate: (v) => checkMinutes(v) },
      {
        field: 'evaluation_order',
        validate: (v) => {
          if (v.trim().length === 0) return null;
          const parsed = Number(v);
          if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100000) {
            return 'Order must be a whole number between 0 and 100000.';
          }
          return null;
        },
      },
    ]);

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSubmitting(true);
    try {
      const created = await api.createSlaPolicy({
        name: values.name.trim(),
        source_channel: values.source_channel ? (values.source_channel as LeadSource) : null,
        first_response_minutes: Number(values.first_response_minutes),
        business_hours_only: businessHoursOnly,
        evaluation_order: values.evaluation_order ? Number(values.evaluation_order) : undefined,
        is_active: true,
      });
      notify({
        tone: 'success',
        title: 'SLA target saved',
        detail: `"${created.policy.name}" gives ${describeTarget(
          created.policy.first_response_minutes
        )} for a first response.`,
      });
      event.currentTarget.reset();
      setFieldErrors({});
      await load();
    } catch (error) {
      const mapped = mapApiError(error);
      setFieldErrors(mapped.fieldErrors);
      setFormError(mapped.formError);
      if (Object.keys(mapped.fieldErrors).length === 0) {
        notify(
          failureFor(
            error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
            mapped.formError ?? undefined
          )
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  /** Begin editing a policy inline. */
  function startEdit(policy: SlaPolicy): void {
    setEditingId(policy.id);
    setEditName(policy.name);
    setEditMinutes(String(policy.first_response_minutes));
    setFieldErrors({});
  }

  /** Abandon an inline edit without saving. */
  function cancelEdit(): void {
    setEditingId(null);
    setFieldErrors({});
  }

  /**
   * Save an inline edit.
   *
   * Sends only what actually changed, so an untouched field cannot be
   * overwritten by a stale value read at the moment editing began.
   */
  async function saveEdit(policy: SlaPolicy): Promise<void> {
    const errors: FieldErrors = {};
    const name = editName.trim();
    if (name.length === 0) {
      errors[`edit-${policy.id}-name`] = 'Policy name is required.';
    } else if (name.length > 160) {
      errors[`edit-${policy.id}-name`] = 'Policy name must be at most 160 characters.';
    }

    const minutesError = checkMinutes(editMinutes);
    if (minutesError) {
      errors[`edit-${policy.id}-minutes`] = minutesError;
    }

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    const changes: Parameters<typeof api.updateSlaPolicy>[1] = {};
    if (name !== policy.name) changes.name = name;
    if (Number(editMinutes) !== policy.first_response_minutes) {
      changes.first_response_minutes = Number(editMinutes);
    }

    if (Object.keys(changes).length === 0) {
      cancelEdit();
      return;
    }

    setBusyId(policy.id);
    try {
      await api.updateSlaPolicy(policy.id, changes);
      notify({
        tone: 'success',
        title: 'SLA target updated',
        detail: 'Leads already in flight keep the deadline they were given.',
      });
      cancelEdit();
      await load();
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusyId(null);
    }
  }

  /** Flip a policy between active and inactive. */
  async function toggleActive(policy: SlaPolicy): Promise<void> {
    setBusyId(policy.id);
    try {
      await api.updateSlaPolicy(policy.id, { is_active: !policy.is_active });
      notify({
        tone: policy.is_active ? 'info' : 'success',
        title: policy.is_active ? 'SLA target deactivated' : 'SLA target reactivated',
        detail: policy.is_active
          ? 'Leads of this type fall through to the next matching target.'
          : 'It is back in the evaluation order.',
      });
      await load();
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusyId(null);
    }
  }

  /** Retire a policy via the soft-delete endpoint. */
  async function retire(policy: SlaPolicy): Promise<void> {
    setBusyId(policy.id);
    try {
      const result = await api.retireSlaPolicy(policy.id);
      notify(
        result.already_inactive
          ? { tone: 'info', title: 'Target was already retired' }
          : {
              tone: 'success',
              title: 'SLA target retired',
              detail:
                'The target is kept as an inactive record so a past deadline stays explainable.',
            }
      );
      await load();
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusyId(null);
    }
  }

  /** Channel label for a policy, naming the catch-all case explicitly. */
  function channelLabel(policy: SlaPolicy): string {
    if (!policy.source_channel) {
      return 'Any lead type';
    }
    return (
      SOURCE_OPTIONS.find((option) => option.value === policy.source_channel)?.label ??
      policy.source_channel
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-8">
        <p className="lf-eyebrow">Response Commitments by Lead Type</p>
        <h1 className="mt-1.5 text-2xl font-bold text-text">SLA targets</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          How long a lead of each type has for its first human response. Evaluated top to bottom by
          order — the first target that matches wins, and a target with no lead type is a catch-all.
          {defaultMinutes !== null && (
            <>
              {' '}
              A lead no target matches gets{' '}
              <span className="text-text">{describeTarget(defaultMinutes)}</span>.
            </>
          )}
        </p>
      </div>

      {loadError && (
        <div
          className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-red/40 bg-red/10 px-4 py-3"
          role="alert"
        >
          <p className="text-sm text-red">{loadError}</p>
          <button type="button" onClick={() => void load()} className="lf-btn-secondary px-4 py-2">
            Retry
          </button>
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[1.3fr_1fr]">
        <section aria-labelledby="targets-heading">
          <h2 id="targets-heading" className="lf-eyebrow mb-4">
            Evaluation order
          </h2>

          {loading ? (
            <p className="text-sm text-muted">Loading SLA targets…</p>
          ) : policies.length === 0 ? (
            <div className="lf-panel p-10 text-center">
              <h3 className="text-base font-bold text-text">No SLA targets yet</h3>
              <p className="mx-auto mt-2.5 max-w-sm text-sm leading-relaxed text-muted">
                Every lead currently gets the same{' '}
                {defaultMinutes !== null ? describeTarget(defaultMinutes) : 'default'} window. Add a
                target to give a channel its own deadline.
              </p>
            </div>
          ) : (
            <ol className="space-y-3">
              {policies.map((policy) => (
                <li key={policy.id} className="lf-panel p-5">
                  {editingId === policy.id ? (
                    <div className="space-y-4">
                      <Field
                        id={`edit-sla-name-${policy.id}`}
                        label="Target name"
                        required
                        error={fieldErrors[`edit-${policy.id}-name`]}
                      >
                        {(wiring) => (
                          <input
                            {...wiring}
                            type="text"
                            defaultValue={policy.name}
                            onChange={(event) => setEditName(event.target.value)}
                          />
                        )}
                      </Field>

                      <Field
                        id={`edit-sla-minutes-${policy.id}`}
                        label="First response within (minutes)"
                        hint="Leads already in flight keep the deadline they were given."
                        error={fieldErrors[`edit-${policy.id}-minutes`]}
                      >
                        {(wiring) => (
                          <input
                            {...wiring}
                            type="number"
                            min={MIN_TARGET_MINUTES}
                            max={MAX_TARGET_MINUTES}
                            defaultValue={policy.first_response_minutes}
                            onChange={(event) => setEditMinutes(event.target.value)}
                          />
                        )}
                      </Field>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void saveEdit(policy)}
                          className="lf-btn-primary px-4 py-2 text-xs"
                          disabled={busyId === policy.id}
                        >
                          {busyId === policy.id ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="lf-btn-secondary px-4 py-2 text-xs"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-text">{policy.name}</p>
                        <p className="mt-1.5 text-xs text-muted">
                          {channelLabel(policy)} →{' '}
                          <span className="text-text">
                            {describeTarget(policy.first_response_minutes)}
                          </span>
                        </p>
                        {policy.business_hours_only && (
                          <p className="mt-1.5 text-[11px] text-soft">
                            Business hours only — applied by ProjexCloud sdk-sla; the local
                            wall-clock fallback cannot honour it.
                          </p>
                        )}

                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => startEdit(policy)}
                            className="lf-btn-secondary px-3 py-1.5 text-xs"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => void toggleActive(policy)}
                            className="lf-btn-secondary px-3 py-1.5 text-xs"
                            disabled={busyId === policy.id}
                          >
                            {policy.is_active ? 'Deactivate' : 'Reactivate'}
                          </button>
                          {policy.is_active && (
                            <button
                              type="button"
                              onClick={() => void retire(policy)}
                              className="lf-btn-secondary px-3 py-1.5 text-xs hover:border-red/60 hover:text-red"
                              disabled={busyId === policy.id}
                              title="Retires the target. The row is kept so a past deadline stays explainable."
                            >
                              Retire
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <span className="lf-pill border-line2 bg-panel2 font-mono text-muted">
                          {policy.evaluation_order}
                        </span>
                        <span
                          className={`lf-pill ${
                            policy.is_active
                              ? 'border-green/40 bg-green/10 text-green'
                              : 'border-line2 bg-panel2 text-soft'
                          }`}
                        >
                          {policy.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>

        <section aria-labelledby="new-target-heading">
          <h2 id="new-target-heading" className="lf-eyebrow mb-4">
            Add an SLA target
          </h2>

          <form onSubmit={handleSubmit} className="lf-panel p-6" noValidate>
            <div className="grid gap-5">
              <Field id="sla-name" label="Target name" required error={fieldErrors.name}>
                {(wiring) => (
                  <input
                    {...wiring}
                    name="name"
                    type="text"
                    autoComplete="off"
                    placeholder="Live chat — 5 minutes"
                  />
                )}
              </Field>

              <Field
                id="sla-channel"
                label="Lead type"
                hint="Leave blank for a catch-all that governs every lead type nothing else claims."
                error={fieldErrors.source_channel}
              >
                {(wiring) => (
                  <select {...wiring} name="source_channel" defaultValue="">
                    <option value="">Any lead type</option>
                    {SOURCE_GROUPS.map((group) => (
                      <optgroup key={group} label={group}>
                        {SOURCE_OPTIONS.filter((option) => option.group === group).map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                )}
              </Field>

              <Field
                id="sla-minutes"
                label="First response within (minutes)"
                required
                hint="Between 1 minute and 7 days. A live-chat prospect is waiting now; a CSV import is not."
                error={fieldErrors.first_response_minutes}
              >
                {(wiring) => (
                  <input
                    {...wiring}
                    name="first_response_minutes"
                    type="number"
                    min={MIN_TARGET_MINUTES}
                    max={MAX_TARGET_MINUTES}
                    placeholder="30"
                  />
                )}
              </Field>

              <Field
                id="sla-order"
                label="Evaluation order"
                hint="Lower runs first. Defaults to 100."
                error={fieldErrors.evaluation_order}
              >
                {(wiring) => (
                  <input
                    {...wiring}
                    name="evaluation_order"
                    type="number"
                    min={0}
                    max={100000}
                    placeholder="100"
                  />
                )}
              </Field>

              <label className="flex items-start gap-3 text-sm text-muted">
                <input
                  type="checkbox"
                  name="business_hours_only"
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-line bg-panel2 accent-blue"
                />
                <span>
                  Count business hours only
                  <span className="mt-1 block text-xs text-soft">
                    Honoured by ProjexCloud sdk-sla. The local wall-clock fallback cannot apply it,
                    so the setting is stored and takes effect once the gateway is connected.
                  </span>
                </span>
              </label>
            </div>

            <FormError error={formError} />

            <button type="submit" className="lf-btn-primary mt-6 w-full" disabled={submitting}>
              {submitting ? 'Saving…' : 'Save SLA target'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}

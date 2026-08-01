import { FormEvent, useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  LeadSource,
  RoutingRule,
  SessionUser,
} from '../../services/api';
import { Field, FormError } from '../../components/forms/Field';
import { useToast } from '../../components/feedback/ToastProvider';
import { useSession } from '../../context/SessionContext';
import { failureFor } from '../../content/messages';
import { SOURCE_GROUPS, SOURCE_OPTIONS } from '../../content/leadFields';
import { subscribeToEvents } from '../../services/eventStream';
import {
  FieldErrors,
  mapApiError,
  validateFields,
  validateOptionalText,
  validateRequiredText,
} from '../../utils/validation';

/** Display name for a user, falling back to their email. */
function displayName(user: SessionUser): string {
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full.length > 0 ? full : user.email;
}

/**
 * Routing rule administration.
 *
 * The list is ordered exactly as the engine evaluates it — ascending
 * `evaluation_order`, first match wins — and says so on screen. A rules screen
 * that displays a different order from the one the engine uses is actively
 * misleading, because the whole point of the number is precedence.
 *
 * A rule must name an owner, so the owner picker is populated from the team
 * roster rather than asking anybody to paste a UUID.
 */
export default function RoutingRules() {
  const { notify } = useToast();
  const { user } = useSession();
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Rule currently open for inline editing. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editOrder, setEditOrder] = useState('');
  /** Rule with a mutation in flight, so only its own buttons disable. */
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      // Both are needed before the form is usable, so fetch them together
      // rather than serially.
      const [ruleResult, userResult] = await Promise.all([
        api.listRoutingRules(false),
        api.listUsers(true),
      ]);
      setRules(ruleResult.rules);
      setUsers(userResult.users);
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
    // Keep the list current when a colleague changes a rule. Only rule events
    // matter here — a lead being captured does not change this screen.
    const unsubscribe = subscribeToEvents((event) => {
      if (event.type === 'routing_rule.changed') {
        void load();
      }
    });
    return unsubscribe;
  }, [load]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    const form = new FormData(event.currentTarget);
    const values: Record<string, string> = {
      name: String(form.get('name') ?? ''),
      assigned_user_id: String(form.get('assigned_user_id') ?? ''),
      source_channel: String(form.get('source_channel') ?? ''),
      criteria: String(form.get('criteria') ?? ''),
      evaluation_order: String(form.get('evaluation_order') ?? ''),
    };

    const errors = validateFields(values, [
      { field: 'name', validate: (v) => validateRequiredText('name', v) },
      {
        field: 'assigned_user_id',
        validate: (v) => (v.trim().length === 0 ? 'Choose who this rule routes to.' : null),
      },
      { field: 'criteria', validate: (v) => validateOptionalText('criteria', v) },
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
      const created = await api.createRoutingRule({
        name: values.name.trim(),
        assigned_user_id: values.assigned_user_id,
        source_channel: values.source_channel
          ? (values.source_channel as LeadSource)
          : undefined,
        criteria: values.criteria.trim() || undefined,
        evaluation_order: values.evaluation_order ? Number(values.evaluation_order) : undefined,
        is_active: true,
      });
      notify({
        tone: 'success',
        title: 'Routing rule created',
        detail: `"${created.rule.name}" now evaluates at order ${created.rule.evaluation_order}.`,
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

  /** Begin editing a rule inline. */
  function startEdit(rule: RoutingRule): void {
    setEditingId(rule.id);
    setEditName(rule.name ?? '');
    setEditOrder(String(rule.evaluation_order));
    setFieldErrors({});
  }

  /** Abandon an inline edit without saving. */
  function cancelEdit(): void {
    setEditingId(null);
    setFieldErrors({});
  }

  /** Report a failed rule mutation consistently. */
  function reportFailure(error: unknown): void {
    const mapped = mapApiError(error);
    notify(
      failureFor(
        error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
        mapped.formError ?? undefined
      )
    );
  }

  /**
   * Save an inline edit.
   *
   * Sends only what actually changed, so an untouched field cannot be
   * overwritten by a stale value read at the moment editing began.
   */
  async function saveEdit(rule: RoutingRule): Promise<void> {
    const errors: FieldErrors = {};
    const name = editName.trim();
    if (name.length === 0) {
      errors[`edit-${rule.id}-name`] = 'Rule name is required.';
    } else if (name.length > 160) {
      errors[`edit-${rule.id}-name`] = 'Rule name must be at most 160 characters.';
    }

    const order = Number(editOrder);
    if (!Number.isInteger(order) || order < 0 || order > 100000) {
      errors[`edit-${rule.id}-order`] = 'Order must be a whole number between 0 and 100000.';
    }

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    const changes: Parameters<typeof api.updateRoutingRule>[1] = {};
    if (name !== (rule.name ?? '')) changes.name = name;
    if (order !== rule.evaluation_order) changes.evaluation_order = order;

    if (Object.keys(changes).length === 0) {
      cancelEdit();
      return;
    }

    setBusyId(rule.id);
    try {
      await api.updateRoutingRule(rule.id, changes);
      notify({ tone: 'success', title: 'Rule updated' });
      cancelEdit();
      await load();
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusyId(null);
    }
  }

  /** Flip a rule between active and inactive. */
  async function toggleActive(rule: RoutingRule): Promise<void> {
    setBusyId(rule.id);
    try {
      await api.updateRoutingRule(rule.id, { is_active: !rule.is_active });
      notify({
        tone: rule.is_active ? 'info' : 'success',
        title: rule.is_active ? 'Rule deactivated' : 'Rule reactivated',
        detail: rule.is_active
          ? 'It no longer takes part in routing decisions.'
          : 'It is back in the evaluation order.',
      });
      await load();
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusyId(null);
    }
  }

  /** Retire a rule via the soft-delete endpoint. */
  async function retire(rule: RoutingRule): Promise<void> {
    setBusyId(rule.id);
    try {
      const result = await api.retireRoutingRule(rule.id);
      notify(
        result.already_inactive
          ? { tone: 'info', title: 'Rule was already retired' }
          : {
              tone: 'success',
              title: 'Rule retired',
              detail:
                'The rule is kept as an inactive record so past routing decisions stay explainable.',
            }
      );
      await load();
    } catch (error) {
      reportFailure(error);
    } finally {
      setBusyId(null);
    }
  }

  /** Channel label for a rule, naming the catch-all case explicitly. */
  function channelLabel(rule: RoutingRule): string {
    if (!rule.source_channel) {
      return 'Any channel';
    }
    return (
      SOURCE_OPTIONS.find((option) => option.value === rule.source_channel)?.label ??
      rule.source_channel
    );
  }

  /** Owner name for a rule, from the roster. */
  function ownerLabel(rule: RoutingRule): string {
    const owner = users.find((user) => user.id === rule.assigned_user_id);
    return owner ? displayName(owner) : 'Unknown user';
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text">Routing rules</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Evaluated top to bottom by order — the first rule that matches wins. A rule with no
          channel is a catch-all. When the ProjexCloud assignment SDK is configured it decides
          instead, using live coverage; these rules are the fallback that keeps every lead owned.
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
        <section aria-labelledby="rules-heading">
          <h2 id="rules-heading" className="lf-eyebrow mb-4">
            Evaluation order
          </h2>

          {loading ? (
            <p className="text-sm text-muted">Loading rules…</p>
          ) : rules.length === 0 ? (
            <div className="lf-panel p-10 text-center">
              <h3 className="text-base font-bold text-text">No rules yet</h3>
              <p className="mx-auto mt-2.5 max-w-sm text-sm leading-relaxed text-muted">
                Without a rule, leads route by round-robin to the active user holding the fewest
                open leads. Add a rule to send a channel to a specific owner.
              </p>
            </div>
          ) : (
            <ol className="space-y-3">
              {rules.map((rule) => (
                <li key={rule.id} className="lf-panel p-5">
                  {editingId === rule.id ? (
                    <div className="space-y-4">
                      <Field
                        id={`edit-name-${rule.id}`}
                        label="Rule name"
                        required
                        error={fieldErrors[`edit-${rule.id}-name`]}
                      >
                        {(wiring) => (
                          <input
                            {...wiring}
                            type="text"
                            defaultValue={rule.name ?? ''}
                            onChange={(event) => setEditName(event.target.value)}
                          />
                        )}
                      </Field>

                      <Field
                        id={`edit-order-${rule.id}`}
                        label="Evaluation order"
                        hint="Lower runs first."
                        error={fieldErrors[`edit-${rule.id}-order`]}
                      >
                        {(wiring) => (
                          <input
                            {...wiring}
                            type="number"
                            min={0}
                            max={100000}
                            defaultValue={rule.evaluation_order}
                            onChange={(event) => setEditOrder(event.target.value)}
                          />
                        )}
                      </Field>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void saveEdit(rule)}
                          className="lf-btn-primary px-4 py-2 text-xs"
                          disabled={busyId === rule.id}
                        >
                          {busyId === rule.id ? 'Saving…' : 'Save'}
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
                        <p className="text-sm font-bold text-text">{rule.name ?? 'Unnamed rule'}</p>
                        <p className="mt-1.5 text-xs text-muted">
                          {channelLabel(rule)} →{' '}
                          <span className="text-text">{ownerLabel(rule)}</span>
                        </p>
                        {rule.criteria && (
                          <p className="mt-1.5 font-mono text-[11px] text-soft">{rule.criteria}</p>
                        )}

                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => startEdit(rule)}
                            className="lf-btn-secondary px-3 py-1.5 text-xs"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => void toggleActive(rule)}
                            className="lf-btn-secondary px-3 py-1.5 text-xs"
                            disabled={busyId === rule.id}
                          >
                            {rule.is_active ? 'Deactivate' : 'Reactivate'}
                          </button>
                          {rule.is_active && (
                            <button
                              type="button"
                              onClick={() => void retire(rule)}
                              className="lf-btn-secondary px-3 py-1.5 text-xs hover:border-red/60 hover:text-red"
                              disabled={busyId === rule.id}
                              title="Retires the rule. The row is kept so past routing decisions stay explainable."
                            >
                              Retire
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <span className="lf-pill border-line2 bg-panel2 font-mono text-muted">
                          {rule.evaluation_order}
                        </span>
                        <span
                          className={`lf-pill ${
                            rule.is_active
                              ? 'border-green/40 bg-green/10 text-green'
                              : 'border-line2 bg-panel2 text-soft'
                          }`}
                        >
                          {rule.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>

        <section aria-labelledby="new-rule-heading">
          <h2 id="new-rule-heading" className="lf-eyebrow mb-4">
            Add a rule
          </h2>

          <form onSubmit={handleSubmit} className="lf-panel p-6" noValidate>
            <div className="grid gap-5">
              <Field id="rule-name" label="Rule name" required error={fieldErrors.name}>
                {(wiring) => (
                  <input
                    {...wiring}
                    name="name"
                    type="text"
                    autoComplete="off"
                    placeholder="LinkedIn to enterprise team"
                  />
                )}
              </Field>

              <Field
                id="rule-channel"
                label="Source channel"
                hint="Leave blank for a catch-all that matches every channel."
                error={fieldErrors.source_channel}
              >
                {(wiring) => (
                  <select {...wiring} name="source_channel" defaultValue="">
                    <option value="">Any channel</option>
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
                id="rule-owner"
                label="Route to"
                required
                error={fieldErrors.assigned_user_id}
                hint="Matching leads are assigned to this person. Defaults to you."
              >
                {(wiring) => (
                  // Defaults to the signed-in operator: routing to yourself is the
                  // commonest first rule, and an empty select that silently blocks
                  // submission is a worse starting point than a sensible default.
                  // `key` forces a remount once the roster arrives, so the default
                  // applies to the loaded options rather than an empty list.
                  <select
                    {...wiring}
                    key={user?.id ?? 'loading'}
                    name="assigned_user_id"
                    defaultValue={user?.id ?? ''}
                  >
                    <option value="">Choose an owner…</option>
                    {users.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {displayName(candidate)}
                        {candidate.id === user?.id ? ' (you)' : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              <Field
                id="rule-order"
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

              <Field
                id="rule-criteria"
                label="Criteria note"
                hint="Free text for the humans reading this list."
                error={fieldErrors.criteria}
              >
                {(wiring) => (
                  <input
                    {...wiring}
                    name="criteria"
                    type="text"
                    autoComplete="off"
                    placeholder="source=linkedin and company size > 500"
                  />
                )}
              </Field>
            </div>

            <FormError error={formError} />

            <button
              type="submit"
              className="lf-btn-primary mt-6 w-full"
              disabled={submitting || users.length === 0}
            >
              {submitting ? 'Creating…' : 'Create rule'}
            </button>

            {users.length === 0 && !loading && (
              <p className="mt-3 text-center text-xs text-soft">
                No active users to route to yet.
              </p>
            )}
          </form>
        </section>
      </div>
    </div>
  );
}

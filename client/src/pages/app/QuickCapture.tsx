import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, CaptureResult, LeadOriginClass, LeadSource } from '../../services/api';
import { Field, FormError } from '../../components/forms/Field';
import { useToast } from '../../components/feedback/ToastProvider';
import { SUCCESS, failureFor } from '../../content/messages';
import {
  ORIGIN_OPTIONS,
  SOURCE_GROUPS,
  SOURCE_OPTIONS,
} from '../../content/leadFields';
import {
  FieldErrors,
  mapApiError,
  validateEmail,
  validateEnum,
  validateFields,
  validateOptionalText,
  validateRequiredText,
} from '../../utils/validation';

type Status = 'idle' | 'submitting' | 'captured';

const SOURCE_VALUES = SOURCE_OPTIONS.map((option) => option.value);
const ORIGIN_VALUES = ORIGIN_OPTIONS.map((option) => option.value);

/**
 * Quick Capture — the operator-facing lead entry form.
 *
 * The marketing form is the prospect's door; this is the operator's. It posts to
 * the authenticated `POST /api/leads` and exposes the full field set the handler
 * accepts, including the source channel and the origin class, because an
 * operator entering a lead by hand is making a provenance claim on the
 * organisation's behalf and should be doing so deliberately.
 *
 * Validation runs through the shared mirror of the server validators, so a
 * rejection appears under the field that caused it — including a rejection the
 * client's mirror missed, which `mapApiError` places from the server's
 * `details.field`.
 *
 * The confirmation reports `asserted_upstream` honestly. A capture whose
 * ProjexCloud assertion has not yet landed is still durable locally and will
 * reconcile — telling the operator it succeeded upstream when it has not is
 * exactly the kind of quiet lie this product exists to prevent.
 */
export default function QuickCapture() {
  const { notify } = useToast();
  const [status, setStatus] = useState<Status>('idle');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [consent, setConsent] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    const form = new FormData(event.currentTarget);
    const values: Record<string, string> = {
      name: String(form.get('name') ?? ''),
      email: String(form.get('email') ?? ''),
      company: String(form.get('company') ?? ''),
      phone: String(form.get('phone') ?? ''),
      message: String(form.get('message') ?? ''),
      source: String(form.get('source') ?? ''),
      origin_class: String(form.get('origin_class') ?? ''),
    };

    const errors = validateFields(values, [
      { field: 'name', validate: (v) => validateRequiredText('name', v) },
      { field: 'email', validate: (v) => validateEmail(v) },
      { field: 'company', validate: (v) => validateOptionalText('company', v) },
      { field: 'phone', validate: (v) => validateOptionalText('phone', v) },
      { field: 'message', validate: (v) => validateOptionalText('message', v) },
      { field: 'source', validate: (v) => validateEnum('source', v, SOURCE_VALUES) },
      { field: 'origin_class', validate: (v) => validateEnum('origin_class', v, ORIGIN_VALUES) },
    ]);

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setStatus('submitting');
    try {
      const captured = await api.captureLead({
        name: values.name.trim(),
        email: values.email.trim(),
        source: values.source as LeadSource,
        phone: values.phone.trim() || undefined,
        company: values.company.trim() || undefined,
        message: values.message.trim() || undefined,
        origin_class: values.origin_class as LeadOriginClass,
        consent_granted: consent,
      });
      setResult(captured);
      setStatus('captured');

      // The confirmation panel carries the full detail; the toast is what an
      // operator sees if they navigate straight on to the next capture. Its tone
      // reflects whether the upstream assertion actually landed.
      const capturedName = captured.lead.name ?? values.name.trim();
      notify(
        captured.asserted_upstream
          ? SUCCESS.leadCaptured(capturedName)
          : SUCCESS.leadCapturedDeferred(capturedName)
      );
    } catch (captureError) {
      setStatus('idle');
      const mapped = mapApiError(captureError);
      setFieldErrors(mapped.fieldErrors);
      setFormError(mapped.formError);

      // Field-level rejections are already shown against their inputs, so a
      // toast would be redundant noise. Anything else gets one.
      if (Object.keys(mapped.fieldErrors).length === 0) {
        notify(
          failureFor(
            captureError instanceof ApiError ? captureError.code : 'INTERNAL_ERROR',
            mapped.formError ?? undefined
          )
        );
      }
    }
  }

  /** Reset back to an empty form for the next capture. */
  function captureAnother(): void {
    setResult(null);
    setConsent(false);
    setFieldErrors({});
    setFormError(null);
    setStatus('idle');
  }

  if (status === 'captured' && result) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="lf-panel p-8">
          <div className="flex items-start gap-4">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green/15">
              <svg width="20" height="20" viewBox="0 0 22 22" fill="none" aria-hidden="true">
                <path
                  d="M5 11.5l4 4 8-9"
                  stroke="var(--green)"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-text">Lead captured</h1>
              <p className="mt-1.5 text-sm text-muted">
                {result.lead.name} · {result.lead.email}
              </p>
            </div>
          </div>

          <dl className="mt-7 space-y-3 border-t border-line pt-6 text-sm">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Lead id</dt>
              <dd className="font-mono text-xs text-text">{result.lead.id}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Source channel</dt>
              <dd className="font-semibold text-text">{result.lead.source}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Routed to</dt>
              <dd
                className={`font-semibold ${result.lead.owner_user_id ? 'text-green' : 'text-orange'}`}
              >
                {result.lead.owner_name ??
                  (result.lead.owner_user_id ? 'Assigned' : 'Unowned — needs routing')}
                {result.lead.routing_method && (
                  <span className="ml-2 font-mono text-xs font-normal text-soft">
                    {result.lead.routing_method}
                  </span>
                )}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Response due</dt>
              <dd className="font-mono text-xs text-text">
                {result.lead.sla_due_at
                  ? new Date(result.lead.sla_due_at).toLocaleTimeString()
                  : 'clock not started'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Correlation id</dt>
              <dd className="font-mono text-xs text-cyan">{result.correlation_id}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted">Upstream assertion</dt>
              <dd
                className={`font-semibold ${result.asserted_upstream ? 'text-green' : 'text-gold'}`}
              >
                {result.asserted_upstream ? 'Delivered' : 'Deferred'}
              </dd>
            </div>
          </dl>

          {!result.asserted_upstream && (
            <p className="mt-5 rounded-xl border border-gold/30 bg-gold/[0.06] px-4 py-3 text-xs leading-relaxed text-muted">
              The capture is durable locally and appears in the Capture Inbox now. Its ProjexCloud
              provenance assertion has not landed yet and will be reconciled — the correlation id
              above is how that reconciliation is traced.
            </p>
          )}

          <div className="mt-7 flex flex-wrap gap-3">
            <button type="button" onClick={captureAnother} className="lf-btn-primary">
              Capture another
            </button>
            <Link to="/app" className="lf-btn-secondary">
              Back to Capture Inbox
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text">Quick Capture</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Enter a lead by hand. It joins the same intake as every other channel — routed to a named
          owner with a response clock against it.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="lf-panel p-7 sm:p-8" noValidate>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="capture-name" label="Full name" required error={fieldErrors.name}>
            {(wiring) => (
              <input
                {...wiring}
                name="name"
                type="text"
                autoComplete="off"
                placeholder="Priya Raman"
              />
            )}
          </Field>

          <Field id="capture-email" label="Email" required error={fieldErrors.email}>
            {(wiring) => (
              <input
                {...wiring}
                name="email"
                type="email"
                autoComplete="off"
                placeholder="priya@northwind.io"
              />
            )}
          </Field>

          <Field id="capture-company" label="Company" error={fieldErrors.company}>
            {(wiring) => (
              <input
                {...wiring}
                name="company"
                type="text"
                autoComplete="off"
                placeholder="Northwind Logistics"
              />
            )}
          </Field>

          <Field id="capture-phone" label="Phone" error={fieldErrors.phone}>
            {(wiring) => (
              <input
                {...wiring}
                name="phone"
                type="tel"
                autoComplete="off"
                placeholder="+44 20 7123 4567"
              />
            )}
          </Field>

          <Field
            id="capture-source"
            label="Source channel"
            required
            error={fieldErrors.source}
            hint="Where this lead actually came from."
          >
            {(wiring) => (
              <select {...wiring} name="source" defaultValue="phone">
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
            id="capture-origin"
            label="Origin class"
            required
            error={fieldErrors.origin_class}
            hint="What you are willing to assert about where this came from."
          >
            {(wiring) => (
              <select {...wiring} name="origin_class" defaultValue="user_asserted">
                {ORIGIN_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value} title={option.meaning}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field id="capture-message" label="Context" wide error={fieldErrors.message}>
            {(wiring) => (
              <textarea
                {...wiring}
                name="message"
                rows={3}
                className={`${wiring.className} resize-y`}
                placeholder="What did they ask for? What did you promise?"
              />
            )}
          </Field>
        </div>

        <label className="mt-6 flex cursor-pointer items-start gap-3 text-sm text-muted">
          <input
            id="capture-consent"
            name="consent"
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-line2 bg-panel2 accent-blue"
          />
          <span>
            This person gave consent to be contacted. Leave unticked if you are unsure — an
            unrecorded consent is recoverable, a fabricated one is not.
          </span>
        </label>

        <FormError error={formError} />

        <div className="mt-7 flex flex-wrap gap-3">
          <button type="submit" className="lf-btn-primary" disabled={status === 'submitting'}>
            {status === 'submitting' ? 'Capturing…' : 'Capture lead'}
          </button>
          <Link to="/app" className="lf-btn-secondary">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

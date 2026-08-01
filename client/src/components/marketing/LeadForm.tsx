import { FormEvent, useId, useState } from 'react';
import { api, LeadSource } from '../../services/api';
import { Field, FormError } from '../forms/Field';
import {
  FieldErrors,
  mapApiError,
  validateEmail,
  validateFields,
  validateOptionalText,
  validateRequiredText,
} from '../../utils/validation';

interface LeadFormProps {
  /** Which channel this instance represents, for attribution. */
  source: LeadSource;
  /** Shown above the fields. */
  heading?: string;
  /** Label on the submit button. */
  submitLabel?: string;
  /** Render the longer form with company, phone and message fields. */
  detailed?: boolean;
}

type Status = 'idle' | 'submitting' | 'done';

/**
 * The public lead capture form.
 *
 * Posts to the unauthenticated `/api/public/leads` endpoint — the one public
 * write in LeadFlow. Consent is an explicit opt-in checkbox rather than a
 * pre-ticked box or an implied consent notice: the capture carries
 * `consent_granted` through to the upstream assertion, and a consent record
 * that nobody actively gave is worthless as evidence.
 *
 * Validation runs through the shared mirror of the server validators, so an
 * error appears under the field that caused it. The server remains authoritative
 * — anything its mirror here misses still lands on the right field, placed from
 * the server's own `details.field`.
 */
export function LeadForm({
  source,
  heading,
  submitLabel = 'Book a working demo',
  detailed = false,
}: LeadFormProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);

  // A page can render this form more than once (hero and closing CTA), so ids
  // are scoped per instance. Duplicate ids would break every label association
  // on the page and make the second form unaddressable to assistive tech.
  //
  // React hands back an id of the form `:r1:`. That is legal in an HTML id
  // attribute but NOT in an unescaped CSS id selector — `#lead-name-:r1:` parses
  // as a pseudo-class and matches nothing, so any tool that addresses fields by
  // `#id` (the BDD runner among them) silently falls through to fuzzier
  // strategies. Stripping the delimiters keeps the per-instance uniqueness while
  // leaving the id selectable.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const fieldId = (field: string): string => `lead-${field}-${uid}`;

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
    };

    const rules = [
      { field: 'name', validate: (v: string) => validateRequiredText('name', v) },
      { field: 'email', validate: (v: string) => validateEmail(v) },
    ];
    if (detailed) {
      rules.push(
        { field: 'company', validate: (v: string) => validateOptionalText('company', v) },
        { field: 'phone', validate: (v: string) => validateOptionalText('phone', v) },
        { field: 'message', validate: (v: string) => validateOptionalText('message', v) }
      );
    }

    const errors = validateFields(values, rules);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setStatus('submitting');
    try {
      await api.submitPublicLead({
        name: values.name.trim(),
        email: values.email.trim(),
        source,
        company: values.company.trim() || undefined,
        phone: values.phone.trim() || undefined,
        message: values.message.trim() || undefined,
        consent_granted: consent,
      });
      setStatus('done');
    } catch (submitError) {
      setStatus('idle');
      const mapped = mapApiError(submitError);
      setFieldErrors(mapped.fieldErrors);
      setFormError(mapped.formError);
    }
  }

  if (status === 'done') {
    return (
      <div className="lf-panel-raised p-8 text-center" role="status">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green/15">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
            <path
              d="M5 11.5l4 4 8-9"
              stroke="#00d59a"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h3 className="mt-5 text-xl font-bold">You are in the queue — and the clock is running.</h3>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Your request was captured, routed to a named owner, and a 30-minute response clock started
          against it. That is not a marketing line: it is the same capture, routing and SLA path
          every one of your leads will take.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="lf-panel-raised p-7 sm:p-8" noValidate>
      {heading && <h3 className="mb-6 text-lg font-bold">{heading}</h3>}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field id={fieldId('name')} label="Full name" required error={fieldErrors.name}>
          {(wiring) => (
            <input
              {...wiring}
              name="name"
              type="text"
              autoComplete="name"
              placeholder="Ada Lovelace"
            />
          )}
        </Field>

        <Field id={fieldId('email')} label="Work email" required error={fieldErrors.email}>
          {(wiring) => (
            <input
              {...wiring}
              name="email"
              type="email"
              autoComplete="email"
              // Same trap as the company field below: this previously read
              // "ada@company.com", which made it the best placeholder match for
              // a lookup of "company" — so the company value was typed into the
              // email box and the submission failed email validation. Every
              // placeholder on this form is now an example value that contains
              // no other field's name.
              placeholder="ada@northwind.io"
            />
          )}
        </Field>

        {detailed && (
          <>
            <Field id={fieldId('company')} label="Company" error={fieldErrors.company}>
              {(wiring) => (
                <input
                  {...wiring}
                  name="company"
                  type="text"
                  autoComplete="organization"
                  // An example company, matching the example person in the full
                  // name field above. It previously read "Company name", which
                  // was the only placeholder on the form containing the word
                  // "name" — so a placeholder-based lookup for the "name" field
                  // resolved here instead of to Full name, and the form was
                  // submitted with the name missing and the company wrong.
                  placeholder="Northwind Traders"
                />
              )}
            </Field>

            <Field id={fieldId('phone')} label="Phone" error={fieldErrors.phone}>
              {(wiring) => (
                <input
                  {...wiring}
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  placeholder="+1 555 000 0000"
                />
              )}
            </Field>

            <Field
              id={fieldId('message')}
              label="What are you trying to fix?"
              wide
              error={fieldErrors.message}
            >
              {(wiring) => (
                <textarea
                  {...wiring}
                  name="message"
                  rows={4}
                  className={`${wiring.className} resize-y`}
                  placeholder="Speed to lead, routing, import governance, consent evidence…"
                />
              )}
            </Field>
          </>
        )}
      </div>

      <label className="mt-6 flex cursor-pointer items-start gap-3 text-sm text-muted">
        <input
          id={fieldId('consent')}
          name="consent"
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-line2 bg-panel2 accent-blue"
        />
        <span>
          I agree to be contacted about LeadFlow. Consent is recorded as a receipt against this
          submission and can be withdrawn at any time.
        </span>
      </label>

      <FormError error={formError} />

      <button type="submit" className="lf-btn-primary mt-6 w-full" disabled={status === 'submitting'}>
        {status === 'submitting' ? 'Submitting…' : submitLabel}
      </button>

      <p className="mt-4 text-center text-xs leading-relaxed text-soft">
        This form is the product. Your submission runs through the same capture, routing and SLA
        path as every lead LeadFlow handles.
      </p>
    </form>
  );
}

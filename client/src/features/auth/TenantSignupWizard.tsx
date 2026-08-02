import { FormEvent, useState } from 'react';
import { Field, FormError } from '../../components/forms/Field';
import { Callout } from './AuthCard';
import { FieldErrors, validateEmail, validateFields, validateRequiredText } from '../../utils/validation';

/** The wizard's steps, in order. */
export const SIGNUP_STEPS = ['workspace', 'owner', 'confirm'] as const;
export type SignupStep = (typeof SIGNUP_STEPS)[number];

/** What a completed wizard submits. */
export interface TenantSignupInput {
  workspaceName: string;
  businessUnit: string;
  ownerName: string;
  ownerEmail: string;
}

/** Human label per step, used for the heading and the progress line. */
export const STEP_LABELS: Record<SignupStep, string> = {
  workspace: 'Your workspace',
  owner: 'Your details',
  confirm: 'Confirm',
};

/**
 * The step after this one, or null at the end.
 *
 * Pure, and exported, because "which step comes next" is the whole control flow
 * of the wizard and is far easier to assert directly than by driving a browser
 * through three screens.
 */
export function nextStep(current: SignupStep): SignupStep | null {
  const index = SIGNUP_STEPS.indexOf(current);
  return index >= 0 && index < SIGNUP_STEPS.length - 1 ? SIGNUP_STEPS[index + 1] : null;
}

/** The step before this one, or null at the start. */
export function previousStep(current: SignupStep): SignupStep | null {
  const index = SIGNUP_STEPS.indexOf(current);
  return index > 0 ? SIGNUP_STEPS[index - 1] : null;
}

/**
 * Validate only the fields belonging to one step.
 *
 * Per step rather than all at once, so moving forward cannot be blocked by a
 * field the person has not reached yet — being told the owner email is required
 * while still naming the workspace is how a wizard makes someone feel stuck.
 */
export function validateStep(step: SignupStep, values: Partial<TenantSignupInput>): FieldErrors {
  if (step === 'workspace') {
    return validateFields({ workspaceName: values.workspaceName ?? '' }, [
      { field: 'workspaceName', validate: (v) => validateRequiredText('workspace name', v) },
    ]);
  }
  if (step === 'owner') {
    return validateFields(
      { ownerName: values.ownerName ?? '', ownerEmail: values.ownerEmail ?? '' },
      [
        { field: 'ownerName', validate: (v) => validateRequiredText('your name', v) },
        { field: 'ownerEmail', validate: (v) => validateEmail(v) },
      ]
    );
  }
  return {};
}

interface TenantSignupWizardProps {
  /** Create the tenant. Rejects with an ApiError the caller maps. */
  onSubmit: (input: TenantSignupInput) => Promise<void>;
}

/**
 * Self-serve tenant signup, three steps.
 *
 * Split into steps because the alternative — one form asking for a workspace
 * name, a business unit, a personal name and an email at once — reads as a
 * contract rather than a sign-up, and it is the first thing a prospective
 * customer sees.
 *
 * Every step is a real `<form>` whose submit button advances it, so Enter moves
 * forward from any field without reaching for the mouse, and Back is a button
 * rather than reliance on browser history, which would lose what was typed.
 */
export function TenantSignupWizard({ onSubmit }: TenantSignupWizardProps) {
  const [step, setStep] = useState<SignupStep>('workspace');
  const [values, setValues] = useState<Partial<TenantSignupInput>>({});
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update(field: keyof TenantSignupInput, value: string): void {
    setValues((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    const errors = validateStep(step, values);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    const following = nextStep(step);
    if (following) {
      setStep(following);
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        workspaceName: (values.workspaceName ?? '').trim(),
        businessUnit: (values.businessUnit ?? '').trim(),
        ownerName: (values.ownerName ?? '').trim(),
        ownerEmail: (values.ownerEmail ?? '').trim(),
      });
    } catch (submitError) {
      setSubmitting(false);
      setFormError(
        submitError instanceof Error && submitError.message
          ? submitError.message
          : 'We could not create the workspace. Try again.'
      );
    }
  }

  function goBack(): void {
    const previous = previousStep(step);
    if (previous) {
      setFieldErrors({});
      setStep(previous);
    }
  }

  const stepNumber = SIGNUP_STEPS.indexOf(step) + 1;

  return (
    <form onSubmit={handleSubmit} noValidate>
      {/*
        aria-live so the step change is announced. Without it a keyboard user
        submits and hears nothing, because the heading above the panel has not
        moved and focus is still on the button they just pressed.
      */}
      <p className="lf-eyebrow" aria-live="polite">
        Step {stepNumber} of {SIGNUP_STEPS.length} · {STEP_LABELS[step]}
      </p>

      <div className="mt-5 grid gap-5">
        {step === 'workspace' && (
          <>
            <Field
              id="signup-workspace"
              label="Workspace name"
              required
              error={fieldErrors.workspaceName}
            >
              {(wiring) => (
                <input
                  {...wiring}
                  name="workspaceName"
                  autoFocus
                  value={values.workspaceName ?? ''}
                  onChange={(event) => update('workspaceName', event.target.value)}
                  placeholder="Lynked-Up Pro"
                />
              )}
            </Field>

            <Field
              id="signup-bu"
              label="Business unit"
              hint="Optional. Add more once the workspace exists."
              error={fieldErrors.businessUnit}
            >
              {(wiring) => (
                <input
                  {...wiring}
                  name="businessUnit"
                  value={values.businessUnit ?? ''}
                  onChange={(event) => update('businessUnit', event.target.value)}
                  placeholder="North region"
                />
              )}
            </Field>
          </>
        )}

        {step === 'owner' && (
          <>
            <Field id="signup-owner-name" label="Your name" required error={fieldErrors.ownerName}>
              {(wiring) => (
                <input
                  {...wiring}
                  name="ownerName"
                  autoComplete="name"
                  autoFocus
                  value={values.ownerName ?? ''}
                  onChange={(event) => update('ownerName', event.target.value)}
                  placeholder="Ada Lovelace"
                />
              )}
            </Field>

            <Field
              id="signup-owner-email"
              label="Work email"
              required
              error={fieldErrors.ownerEmail}
            >
              {(wiring) => (
                <input
                  {...wiring}
                  name="ownerEmail"
                  type="email"
                  autoComplete="email"
                  value={values.ownerEmail ?? ''}
                  onChange={(event) => update('ownerEmail', event.target.value)}
                  placeholder="you@company.com"
                />
              )}
            </Field>
          </>
        )}

        {step === 'confirm' && (
          <Callout tone="info">
            Creating <strong className="text-text">{values.workspaceName}</strong> with{' '}
            <strong className="text-text">{values.ownerEmail}</strong> as its owner. You can invite
            the rest of the team once it exists.
          </Callout>
        )}
      </div>

      <FormError error={formError} />

      <button type="submit" className="lf-btn-primary mt-7 w-full" disabled={submitting}>
        {step === 'confirm'
          ? submitting
            ? 'Creating workspace…'
            : 'Create workspace'
          : 'Continue'}
      </button>

      {previousStep(step) && (
        <button
          type="button"
          className="lf-btn-ghost mt-3 w-full text-sm"
          onClick={goBack}
          disabled={submitting}
        >
          Back
        </button>
      )}
    </form>
  );
}

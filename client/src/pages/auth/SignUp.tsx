import { FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Logo } from '../../components/marketing/Logo';
import { Field, FormError } from '../../components/forms/Field';
import { useSession } from '../../context/SessionContext';
import {
  FieldErrors,
  MIN_PASSWORD_LENGTH,
  mapApiError,
  validateEmail,
  validateFields,
  validateOptionalText,
  validatePassword,
} from '../../utils/validation';

/**
 * Account creation screen.
 *
 * Validation mirrors `server/src/validators/authValidators.ts` through the shared
 * module, so the password minimum and the email pattern cannot drift from the
 * server's. A conflict the client cannot know about — an email already
 * registered — is placed on the email field by `mapApiError`.
 */
export default function SignUp() {
  const { signUp } = useSession();
  const navigate = useNavigate();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    const form = new FormData(event.currentTarget);
    const values: Record<string, string> = {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      first_name: String(form.get('first_name') ?? ''),
      last_name: String(form.get('last_name') ?? ''),
    };

    const errors = validateFields(values, [
      { field: 'email', validate: (v) => validateEmail(v) },
      { field: 'password', validate: (v) => validatePassword(v) },
      { field: 'first_name', validate: (v) => validateOptionalText('first_name', v) },
      { field: 'last_name', validate: (v) => validateOptionalText('last_name', v) },
    ]);

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSubmitting(true);
    try {
      await signUp({
        email: values.email.trim(),
        password: values.password,
        first_name: values.first_name.trim() || undefined,
        last_name: values.last_name.trim() || undefined,
      });
      navigate('/app', { replace: true });
    } catch (signUpError) {
      setSubmitting(false);
      const mapped = mapApiError(signUpError);
      setFieldErrors(mapped.fieldErrors);
      setFormError(mapped.formError);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6 py-16">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="inline-flex">
            <Logo />
          </div>
          <h1 className="mt-7 text-2xl font-bold text-text">Create your workspace</h1>
          <p className="mt-2 text-sm text-muted">
            Capture, routing and the response clock, running in minutes.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="lf-panel-raised p-8" noValidate>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field id="signup-first" label="First name" error={fieldErrors.first_name}>
              {(wiring) => (
                <input
                  {...wiring}
                  name="first_name"
                  type="text"
                  autoComplete="given-name"
                  placeholder="Ada"
                />
              )}
            </Field>

            <Field id="signup-last" label="Last name" error={fieldErrors.last_name}>
              {(wiring) => (
                <input
                  {...wiring}
                  name="last_name"
                  type="text"
                  autoComplete="family-name"
                  placeholder="Lovelace"
                />
              )}
            </Field>

            <Field id="signup-email" label="Work email" required wide error={fieldErrors.email}>
              {(wiring) => (
                <input
                  {...wiring}
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                />
              )}
            </Field>

            <Field
              id="signup-password"
              label="Password"
              required
              wide
              error={fieldErrors.password}
              hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
            >
              {(wiring) => (
                <input
                  {...wiring}
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                />
              )}
            </Field>
          </div>

          <FormError error={formError} />

          <button type="submit" className="lf-btn-primary mt-7 w-full" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create account'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-muted">
          Already have an account?{' '}
          <Link to="/signin" className="font-semibold text-blue hover:text-blue/80">
            Sign in
          </Link>
        </p>
        <p className="mt-3 text-center text-sm">
          <Link to="/" className="text-soft hover:text-muted">
            ← Back to leadflow.com
          </Link>
        </p>
      </div>
    </div>
  );
}

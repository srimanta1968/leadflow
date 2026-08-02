import { FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Field, FormError } from '../../components/forms/Field';
import { AuthCard } from '../../features/auth';
import { useSession } from '../../context/SessionContext';
import { FieldErrors, mapApiError, validateFields, validateRequiredText } from '../../utils/validation';

/**
 * Sign-in screen.
 *
 * Validation here is deliberately thinner than sign-up: both fields are checked
 * for presence, but the email is NOT pattern-checked and the password is NOT
 * length-checked. Telling someone their existing password is "too short" or
 * their long-standing address is "invalid" is both wrong and a disclosure about
 * what is stored — the server answers INVALID_CREDENTIALS either way, and that
 * single message is the correct response.
 */
export default function SignIn() {
  const { signIn } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /** Where to land after signing in — back to the gated page if there was one. */
  const returnTo = (location.state as { from?: string } | null)?.from ?? '/app';

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormError(null);

    const form = new FormData(event.currentTarget);
    const values: Record<string, string> = {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
    };

    const errors = validateFields(values, [
      { field: 'email', validate: (v) => validateRequiredText('email', v) },
      { field: 'password', validate: (v) => validateRequiredText('password', v) },
    ]);

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    setSubmitting(true);
    try {
      await signIn(values.email.trim(), values.password);
      navigate(returnTo, { replace: true });
    } catch (signInError) {
      setSubmitting(false);
      const mapped = mapApiError(signInError);
      setFieldErrors(mapped.fieldErrors);
      setFormError(mapped.formError);
    }
  }

  return (
    <AuthCard
      title="Sign in to LeadFlow"
      subtitle="Your workspace, your leads, your clock."
      footer={
        <>
          <p>
            No account yet?{' '}
            <Link to="/signup" className="font-semibold text-blue hover:text-blue/80">
              Create one
            </Link>
          </p>
          <p className="mt-3">
            <Link to="/" className="text-soft hover:text-muted">
              ← Back to leadflow.com
            </Link>
          </p>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate>
          <div className="grid gap-5">
            <Field id="signin-email" label="Work email" required error={fieldErrors.email}>
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

            <Field id="signin-password" label="Password" required error={fieldErrors.password}>
              {(wiring) => (
                <input
                  {...wiring}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                />
              )}
            </Field>
          </div>

          <FormError error={formError} />

          <button type="submit" className="lf-btn-primary mt-7 w-full" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
      </form>
    </AuthCard>
  );
}

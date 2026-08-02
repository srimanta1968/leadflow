import { ReactNode } from 'react';
import { Logo } from '../../components/marketing/Logo';

interface AuthCardProps {
  /** Heading, e.g. "Sign in to LeadFlow". */
  title: string;
  /** One line under the heading. */
  subtitle?: string;
  /** The form itself. */
  children: ReactNode;
  /** Links below the panel — "create an account", "back to site". */
  footer?: ReactNode;
}

/**
 * The shell every authentication screen sits in.
 *
 * Extracted rather than written fresh: sign-in and sign-up already carried the
 * same centred column, brand lock-up, heading and raised panel, and MFA, SSO
 * and tenant signup would have made five copies of it. Five copies is five
 * places for the spacing above the brandmark to drift, and the lock-up is the
 * first thing a person sees when deciding whether they are on the real site.
 *
 * Colour comes entirely from the token classes — `bg-bg`, `text-text`,
 * `text-muted` — which resolve to the design system's custom properties. No
 * literal colour appears here, which is what the design-system rule checks for.
 */
export function AuthCard({ title, subtitle, children, footer }: AuthCardProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6 py-16">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="inline-flex">
            <Logo />
          </div>
          <h1 className="mt-7 text-2xl font-bold text-text">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-muted">{subtitle}</p>}
        </div>

        <div className="lf-panel-raised p-8">{children}</div>

        {footer && <div className="mt-6 text-center text-sm text-muted">{footer}</div>}
      </div>
    </div>
  );
}

interface CalloutProps {
  /** `error` for a refusal, `info` for context the person needs to proceed. */
  tone?: 'error' | 'info';
  children: ReactNode;
}

/**
 * A bordered notice inside a panel — the design system's `.callout`.
 *
 * `role="alert"` only on the error tone. An alert interrupts a screen reader
 * mid-sentence, which is right for "that code was wrong" and actively rude for
 * "we sent you a code": the informational tone is announced when the reader
 * reaches it, in the order the sighted user reads it too.
 */
export function Callout({ tone = 'error', children }: CalloutProps) {
  const toneClass =
    tone === 'error' ? 'border-red/40 bg-red/10 text-red' : 'border-line bg-panel2 text-muted';

  return (
    <p
      className={`mt-5 rounded-xl border px-4 py-3 text-sm ${toneClass}`}
      role={tone === 'error' ? 'alert' : undefined}
    >
      {children}
    </p>
  );
}

/**
 * External providers LeadFlow talks to, and the SecretRef that stands in for
 * each credential.
 *
 * A SECRETREF IS NOT A SECRET. It is an opaque pointer that sdk-secrets
 * exchanges for a credential at the moment of use, for a caller it has
 * authenticated. Storing the ref in config, logs or the database discloses
 * nothing; storing the credential there discloses everything, and does so
 * durably, in places nobody remembers to scrub — a log aggregator, a database
 * backup, a developer's terminal history.
 *
 * So this file names WHICH providers exist and WHERE their credentials live.
 * It must never hold a credential, and the repository scan in
 * tests/unit/secretCustody.test.ts fails the build if one appears here or
 * anywhere else under src/.
 */

export type ProviderKind = 'email' | 'sms' | 'payment' | 'calendar' | 'enrichment';

export interface ProviderCredential {
  /** Stable key used in the registry screen and the rotation runbook. */
  key: string;
  label: string;
  kind: ProviderKind;
  /**
   * Environment variable holding the sdk-secrets REFERENCE, not the secret.
   *
   * Named `*_SECRET_REF` throughout so a reviewer scanning an env file can tell
   * at a glance whether a value is a pointer or a credential — a variable
   * called SENDGRID_API_KEY invites somebody to paste the real key into it.
   */
  refEnvVar: string;
  /** What breaks when this credential is missing or expired. */
  impactIfUnavailable: string;
}

export const PROVIDER_CREDENTIALS: ProviderCredential[] = [
  {
    key: 'sendgrid',
    label: 'SendGrid',
    kind: 'email',
    refEnvVar: 'SENDGRID_SECRET_REF',
    impactIfUnavailable: 'Outbound email stops; SLA alerts fall back to in-app only.',
  },
  {
    key: 'twilio',
    label: 'Twilio',
    kind: 'sms',
    refEnvVar: 'TWILIO_SECRET_REF',
    impactIfUnavailable: 'SMS notification and call tracking stop.',
  },
  {
    key: 'stripe',
    label: 'Stripe',
    kind: 'payment',
    refEnvVar: 'STRIPE_SECRET_REF',
    impactIfUnavailable: 'Payment verification stops; Closed Won cannot be confirmed.',
  },
  {
    key: 'google_workspace',
    label: 'Google Workspace',
    kind: 'calendar',
    refEnvVar: 'GOOGLE_WORKSPACE_SECRET_REF',
    impactIfUnavailable: 'Calendar sync and meeting booking stop.',
  },
  {
    key: 'microsoft_365',
    label: 'Microsoft 365',
    kind: 'calendar',
    refEnvVar: 'MICROSOFT_365_SECRET_REF',
    impactIfUnavailable: 'Calendar sync and meeting booking stop for M365 tenants.',
  },
  {
    key: 'enrichment_vendor',
    label: 'Enrichment vendor',
    kind: 'enrichment',
    refEnvVar: 'ENRICHMENT_SECRET_REF',
    impactIfUnavailable: 'Enrichment requests are refused rather than queued.',
  },
];

/** The SecretRef for a provider, or null when it is not configured. */
export function secretRefFor(providerKey: string): string | null {
  const provider = PROVIDER_CREDENTIALS.find((entry) => entry.key === providerKey);
  if (!provider) {
    return null;
  }
  const ref = process.env[provider.refEnvVar];
  return ref && ref.length > 0 ? ref : null;
}

/**
 * What the registry screen renders: configured or not, and never the value.
 *
 * Returns a BOOLEAN rather than a masked string. A mask like `sk_live_****4821`
 * still leaks the prefix and the last four, which is enough to confirm a guess
 * and to tell an attacker which product tier the key belongs to. "Configured"
 * is the entire fact an operator needs.
 */
export function providerRegistryView(): {
  key: string;
  label: string;
  kind: ProviderKind;
  configured: boolean;
  impactIfUnavailable: string;
}[] {
  return PROVIDER_CREDENTIALS.map((provider) => ({
    key: provider.key,
    label: provider.label,
    kind: provider.kind,
    configured: secretRefFor(provider.key) !== null,
    impactIfUnavailable: provider.impactIfUnavailable,
  }));
}

/**
 * Authentication screens and their primitives.
 *
 * Everything here composes the EP-02 design system — token classes and the
 * shared `Field` / `lf-*` controls — and adds no colour or form control of its
 * own.
 */
export { AuthCard, Callout } from './AuthCard';
export { ProfileChip, initialsFor, secondaryLine } from './ProfileChip';
export type { ProfileIdentity } from './ProfileChip';
export { MfaChallenge, isSubmittableCode, normaliseCode, MFA_CODE_LENGTH } from './MfaChallenge';
export {
  TenantSignupWizard,
  nextStep,
  previousStep,
  validateStep,
  SIGNUP_STEPS,
  STEP_LABELS,
} from './TenantSignupWizard';
export type { SignupStep, TenantSignupInput } from './TenantSignupWizard';

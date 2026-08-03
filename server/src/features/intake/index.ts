/**
 * Universal intake — the normalized signal envelope and the webhook receivers.
 */
export { IntakeController } from './intakeController';
export { IntakeService, INTAKE_PLATFORMS, SIGNAL_KINDS } from './intakeService';
export type { IntakeSignal, IntakePlatform, SignalKind, IntakeResult } from './intakeService';
export { verifySignature, signPayload } from './signatureVerifier';
export type { SignatureState, VerificationResult } from './signatureVerifier';
export { default as intakeRoutes } from './intakeRoutes';

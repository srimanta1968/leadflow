/**
 * Platform secrets — credential custody by reference, and PII envelope crypto.
 *
 * LeadFlow holds no provider credential and no encryption key. It holds
 * REFERENCES, which disclose nothing if they leak, and exchanges them for a
 * credential at the moment of use.
 */
export { encryptPii, revealPii, rotateVaultKey } from './piiVault';
export type { RevealContext, RevealResult } from './piiVault';
export { PROVIDER_CREDENTIALS, secretRefFor, providerRegistryView } from '../../config/providers';
export type { ProviderCredential, ProviderKind } from '../../config/providers';

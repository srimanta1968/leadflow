/**
 * Platform authentication — session verification against ProjexCloud sdk-identity.
 *
 * LeadFlow stores no identity of its own here. A request arrives with a token
 * the platform minted, this module decides whether to believe it, and every
 * handler downstream reads the answer rather than re-deciding it.
 */
export { JwksCache, ALLOWED_ALGORITHMS } from './jwksCache';
export { OidcDiscovery } from './oidcDiscovery';
export { toPlatformSession } from './sessionContext';
export type { PlatformSession, PlatformRequest } from './sessionContext';
export { platformSession, requirePlatformRole, verifyPlatformToken } from './sessionMiddleware';

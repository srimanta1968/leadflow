import { config } from '../../src/config/env';
import { AuthService } from '../../src/services/AuthService';

/**
 * The local credential store must stand down when ProjexCloud takes over.
 *
 * Two stores that both answer "yes" is how a revoked user keeps working:
 * revocation happens upstream and the local bcrypt hash never hears about it.
 * The failure is silent — the user logs in successfully — so nothing surfaces it
 * except a test that asserts the local path is closed.
 */

const ORIGINAL_ISSUER = config.projexCloud.identity.issuerUrl;

afterEach(() => {
  config.projexCloud.identity.issuerUrl = ORIGINAL_ISSUER;
});

describe('local credential handover', () => {
  describe('while no identity issuer is configured', () => {
    beforeEach(() => {
      config.projexCloud.identity.issuerUrl = '';
    });

    it('still allows login, because something has to mint a token', async () => {
      // Bootstrap reality: every api_definition in the project chains from an
      // auth producer, so removing this before the spine is reachable would
      // take the whole contract suite down with it.
      await expect(
        AuthService.login({ email: 'nobody@example.com', password: 'wrong-password' })
      ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    });
  });

  describe('once an identity issuer is configured', () => {
    beforeEach(() => {
      config.projexCloud.identity.issuerUrl = 'https://identity.projexcloud.test';
    });

    it('refuses login rather than checking the local hash', async () => {
      await expect(
        AuthService.login({ email: 'someone@example.com', password: 'any-password' })
      ).rejects.toMatchObject({ statusCode: 501, code: 'NOT_IMPLEMENTED' });
    });

    it('refuses registration, so no new local credential is ever created', async () => {
      await expect(
        AuthService.register({ email: 'new@example.com', password: 'Password123!' })
      ).rejects.toMatchObject({ statusCode: 501, code: 'NOT_IMPLEMENTED' });
    });

    it('does not answer INVALID_CREDENTIALS for a disabled store', async () => {
      // The distinction matters to a client: 401 invites a retry with a better
      // password, which can never succeed here. It has to go to the issuer.
      await expect(
        AuthService.login({ email: 'someone@example.com', password: 'any-password' })
      ).rejects.not.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    });

    it('keeps the projection READABLE, since that is all it is now', async () => {
      // Turning off credentials must not turn off "who is user X" — the row is
      // still the local projection every lead and SLA record points at.
      await expect(
        AuthService.getById('00000000-0000-0000-0000-000000000000')
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});

import { config } from '../../src/config/env';
import {
  ROLE_DEFINITIONS,
  PERMISSIONS,
  allGrantedPermissions,
  canDoUnaided,
  needsApproval,
  roleByKey,
} from '../../src/config/roles';
import {
  provisionRoles,
  assignPersonaToBusinessUnit,
} from '../../src/platform/identity/roleProvisioner';
import { SdkGatewayClient } from '../../src/services/projexcloud/SdkGatewayClient';
import { AppError, ErrorCodes } from '../../src/utils/errors';

/**
 * The role catalogue and its provisioning.
 *
 * Unit tests because none of this has an HTTP surface of its own — the
 * provisioner runs at boot and talks outward. The gateway is stubbed at the
 * client boundary, so the idempotency logic under test is the real code.
 */

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the role catalogue', () => {
  it('defines all nine SOP actors', () => {
    expect(ROLE_DEFINITIONS).toHaveLength(9);
    expect(ROLE_DEFINITIONS.map((role) => role.key)).toEqual([
      'sales_rep',
      'backup_rep',
      'sales_manager',
      'revenue_operations',
      'leadership',
      'client_success',
      'data_steward',
      'privacy_officer',
      'marketing_ops',
    ]);
  });

  it('gives every role a purpose, a grant list and its SOP provenance', () => {
    for (const role of ROLE_DEFINITIONS) {
      expect(role.label.length).toBeGreaterThan(0);
      expect(role.purpose.length).toBeGreaterThan(0);
      // Provenance is not decoration: it is how a reviewer tells a quoted
      // permission from an invented one.
      expect(role.sopBasis.length).toBeGreaterThan(0);
      expect(role.canDo.length).toBeGreaterThan(0);
    }
  });

  it('never lists the same permission as both granted and approval-gated', () => {
    // A permission in both lists is a contradiction: the role would hold it
    // unaided and need approval for it at the same time.
    for (const role of ROLE_DEFINITIONS) {
      const overlap = role.canDo.filter((permission) =>
        role.requiresApproval.includes(permission)
      );
      expect(overlap).toEqual([]);
    }
  });

  it('keeps the backup rep exactly as capable as the rep', () => {
    // The save gate requires owner + backup on every open record. A backup who
    // cannot do what the owner can is not cover, so these two must not drift.
    const rep = roleByKey('sales_rep');
    const backup = roleByKey('backup_rep');

    expect(backup?.canDo).toEqual(rep?.canDo);
    expect(backup?.requiresApproval).toEqual(rep?.requiresApproval);
  });

  it('lets only the privacy officer override suppression unaided', () => {
    const unaided = ROLE_DEFINITIONS.filter((role) =>
      role.canDo.includes(PERMISSIONS.SUPPRESSION_OVERRIDE)
    ).map((role) => role.key);

    expect(unaided).toEqual(['privacy_officer']);
  });

  it('lets nobody delete an audit event unaided', () => {
    // The record of an action must outlive the person who took it — including
    // the privacy officer, who may erase personal data but not the proof.
    const unaided = ROLE_DEFINITIONS.filter((role) =>
      role.canDo.includes(PERMISSIONS.AUDIT_DELETE_EVENT)
    );

    expect(unaided).toEqual([]);
  });

  it('answers can-do and needs-approval per role', () => {
    expect(canDoUnaided('sales_rep', PERMISSIONS.MEETING_BOOK)).toBe(true);
    expect(canDoUnaided('sales_rep', PERMISSIONS.OFFER_CHANGE_TERMS)).toBe(false);
    expect(needsApproval('sales_rep', PERMISSIONS.OFFER_CHANGE_TERMS)).toBe(true);
    // An unknown role grants nothing rather than defaulting open.
    expect(canDoUnaided('no_such_role', PERMISSIONS.MEETING_BOOK)).toBe(false);
  });

  it('derives the granted-permission set rather than keeping a second list', () => {
    const all = allGrantedPermissions();

    expect(all).toEqual([...all].sort());
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain(PERMISSIONS.IMPORT_COMMIT);
  });
});

describe('provisioning', () => {
  it('does nothing and says so when no gateway is configured', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(false);

    const summary = await provisionRoles();

    expect(summary.attempted).toBe(false);
    expect(summary.results.every((r) => r.outcome === 'skipped')).toBe(true);
  });

  it('creates one template per role, sending only the unaided grants', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    const call = jest
      .spyOn(SdkGatewayClient, 'call')
      .mockResolvedValue({ delivered: true, status: 201, data: null });

    const summary = await provisionRoles();

    expect(summary.created).toBe(9);
    expect(summary.failed).toBe(0);
    expect(call).toHaveBeenCalledTimes(9);

    const repCall = call.mock.calls.find(
      (args) => (args[0].body as { name?: string })?.name === 'sales_rep'
    );
    const body = repCall?.[0].body as { permissions: string[] };
    // The approval-gated actions must NOT be sent as permissions — doing so
    // would grant the very thing the SOP says needs a second party.
    expect(body.permissions).toContain(PERMISSIONS.MEETING_BOOK);
    expect(body.permissions).not.toContain(PERMISSIONS.OFFER_CHANGE_TERMS);
  });

  it('is idempotent across a restart: a second run creates nothing', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    // What the gateway answers once the templates exist.
    jest
      .spyOn(SdkGatewayClient, 'call')
      .mockRejectedValue(
        new AppError(502, ErrorCodes.UPSTREAM_UNAVAILABLE, 'ProjexCloud sdk-rebac returned 409')
      );

    const summary = await provisionRoles();

    expect(summary.alreadyPresent).toBe(9);
    expect(summary.created).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('sends a stable idempotency key per role, so a retry cannot duplicate', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    const call = jest
      .spyOn(SdkGatewayClient, 'call')
      .mockResolvedValue({ delivered: true, status: 201, data: null });

    await provisionRoles();
    const first = call.mock.calls.map((args) => args[0].idempotencyKey);
    call.mockClear();
    await provisionRoles();
    const second = call.mock.calls.map((args) => args[0].idempotencyKey);

    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(9);
  });

  it('reports a genuine failure without throwing, so the app still boots', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest
      .spyOn(SdkGatewayClient, 'call')
      .mockRejectedValue(
        new AppError(502, ErrorCodes.UPSTREAM_UNAVAILABLE, 'ProjexCloud sdk-rebac returned 500')
      );

    const summary = await provisionRoles();

    // An identity-provider outage must not become a total outage.
    expect(summary.failed).toBe(9);
    expect(summary.created).toBe(0);
  });
});

describe('business-unit assignment', () => {
  it('scopes a persona to a unit — the North Dallas Sales case', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    const call = jest
      .spyOn(SdkGatewayClient, 'call')
      .mockResolvedValue({ delivered: true, status: 201, data: null });
    config.projexCloud.tenantId = 'tenant-lup';

    const assigned = await assignPersonaToBusinessUnit('persona-42', 'bu-north-dallas-sales');

    expect(assigned).toBe(true);
    expect(call.mock.calls[0][0]).toMatchObject({
      sdk: 'sdk-persona',
      path: '/api/personas/persona-42/bu',
      body: { business_unit_id: 'bu-north-dallas-sales' },
    });
  });

  it('treats an already-assigned persona as success, not as a failure', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    jest
      .spyOn(SdkGatewayClient, 'call')
      .mockRejectedValue(
        new AppError(502, ErrorCodes.UPSTREAM_UNAVAILABLE, 'ProjexCloud sdk-persona returned 409')
      );

    await expect(assignPersonaToBusinessUnit('persona-42', 'bu-north')).resolves.toBe(true);
  });

  it('encodes a persona id that would otherwise break the path', async () => {
    jest.spyOn(SdkGatewayClient, 'isConfigured').mockReturnValue(true);
    const call = jest
      .spyOn(SdkGatewayClient, 'call')
      .mockResolvedValue({ delivered: true, status: 201, data: null });

    await assignPersonaToBusinessUnit('person/42', 'bu-north');

    expect(call.mock.calls[0][0].path).toBe('/api/personas/person%2F42/bu');
  });
});

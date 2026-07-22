import { describe, expect, it, vi } from 'vitest';
import type {
  MembershipRepository,
  SessionVerifier,
  TenantSessionRequest,
} from './tenant-session.js';
import {
  IdentityServiceUnavailableError,
  AuthenticationRequiredError,
  TenantMembershipRequiredError,
  TenantOverrideForbiddenError,
  TenantSessionResolver,
} from './tenant-session.js';
import { SessionVerificationUnavailableError } from './better-auth-session-verifier.js';

const TENANT_ID = '01890f3e-b6e8-7cc2-98c0-7c9a2fe4f5d1';
const OTHER_TENANT_ID = '01890f3e-b6e8-7d37-a839-3f11a9ca1b79';
const USER_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a2';
const MEMBERSHIP_ID = '01890f3e-b6e8-7a12-8d98-5b82e8cc46a2';
const SESSION_ID = '01890f3e-b6e8-7a13-8d98-5b82e8cc46a2';

const request: TenantSessionRequest = {
  authorization: 'Bearer verified-session',
  cookie: 'session=verified-session',
};

function createDependencies() {
  const verifier: SessionVerifier = {
    verify: vi.fn(async () => ({
      id: SESSION_ID,
      userId: USER_ID,
      activeTenantId: TENANT_ID,
    })),
  };
  const memberships: MembershipRepository = {
    findActive: vi.fn(async () => ({
      id: MEMBERSHIP_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      status: 'active' as const,
      deletedAt: null,
    })),
  };
  return { verifier, memberships };
}

describe('TenantSessionResolver', () => {
  it('derives the tenant only from a verified session and rechecks membership', async () => {
    const { verifier, memberships } = createDependencies();
    const resolver = new TenantSessionResolver(verifier, memberships);

    await expect(resolver.resolve(request)).resolves.toEqual({
      tenantId: TENANT_ID,
      userId: USER_ID,
      membershipId: MEMBERSHIP_ID,
      sessionId: SESSION_ID,
    });
    expect(verifier.verify).toHaveBeenCalledWith({
      authorization: request.authorization,
      cookie: request.cookie,
    });
    expect(memberships.findActive).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      userId: USER_ID,
    });
  });

  it('rejects case-insensitive header and body attempts to forge a tenant', async () => {
    const { verifier, memberships } = createDependencies();
    const resolver = new TenantSessionResolver(verifier, memberships);
    const forgedRequests: TenantSessionRequest[] = [
      { ...request, headers: { 'X-TENANT-ID': OTHER_TENANT_ID } },
      { ...request, body: { tenantId: OTHER_TENANT_ID, name: 'forged' } },
      { ...request, body: { active_tenant_id: OTHER_TENANT_ID } },
    ];

    for (const forged of forgedRequests) {
      await expect(resolver.resolve(forged)).rejects.toMatchObject({
        status: 400,
        code: 'TENANT_OVERRIDE_FORBIDDEN',
      });
    }
    expect(verifier.verify).toHaveBeenCalledTimes(forgedRequests.length);
    expect(memberships.findActive).not.toHaveBeenCalled();
    expect(() => {
      throw new TenantOverrideForbiddenError();
    }).toThrow(TenantOverrideForbiddenError);
  });

  it('returns the same non-disclosing 403 for missing and revoked membership', async () => {
    const { verifier } = createDependencies();
    const missing: MembershipRepository = {
      findActive: vi.fn(async () => null),
    };
    const revoked: MembershipRepository = {
      findActive: vi.fn(async () => ({
        id: MEMBERSHIP_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        status: 'revoked' as const,
        deletedAt: null,
      })),
    };

    for (const memberships of [missing, revoked]) {
      const resolver = new TenantSessionResolver(verifier, memberships);
      await expect(resolver.resolve(request)).rejects.toEqual(
        expect.objectContaining({
          status: 403,
          code: 'TENANT_MEMBERSHIP_REQUIRED',
          message: 'An active tenant membership is required',
        }),
      );
    }
    expect(() => {
      throw new TenantMembershipRequiredError();
    }).toThrow(TenantMembershipRequiredError);
  });

  it('maps absent, rejected, and structurally invalid sessions to the same 401', async () => {
    const { memberships } = createDependencies();
    const invalidVerifiers: SessionVerifier[] = [
      { verify: vi.fn(async () => null) },
      { verify: vi.fn(async () => Promise.reject(new Error('bad signature'))) },
      {
        verify: vi.fn(async () => ({
          id: 'not-a-uuid',
          userId: USER_ID,
          activeTenantId: TENANT_ID,
        })),
      },
    ];

    for (const verifier of invalidVerifiers) {
      const resolver = new TenantSessionResolver(verifier, memberships);
      await expect(resolver.resolve({})).rejects.toMatchObject({
        status: 401,
        code: 'AUTH_REQUIRED',
        message: 'Authentication is required',
      });
    }
    expect(() => {
      throw new AuthenticationRequiredError();
    }).toThrow(AuthenticationRequiredError);
  });

  it('treats malformed or mismatched membership records as the same 403', async () => {
    const { verifier } = createDependencies();
    const invalidMemberships = [
      {
        id: 'not-a-uuid',
        tenantId: TENANT_ID,
        userId: USER_ID,
        status: 'active' as const,
        deletedAt: null,
      },
      {
        id: MEMBERSHIP_ID,
        tenantId: OTHER_TENANT_ID,
        userId: USER_ID,
        status: 'active' as const,
        deletedAt: null,
      },
      {
        id: MEMBERSHIP_ID,
        tenantId: TENANT_ID,
        userId: USER_ID,
        status: 'active' as const,
        deletedAt: '2026-07-23T10:00:00.000Z',
      },
    ];

    for (const membership of invalidMemberships) {
      const memberships: MembershipRepository = {
        findActive: vi.fn(async () => membership),
      };
      await expect(
        new TenantSessionResolver(verifier, memberships).resolve(request),
      ).rejects.toMatchObject({
        status: 403,
        code: 'TENANT_MEMBERSHIP_REQUIRED',
      });
    }
  });

  it('verifies the session and current membership on every request', async () => {
    const { verifier, memberships } = createDependencies();
    const resolver = new TenantSessionResolver(verifier, memberships);

    await resolver.resolve(request);
    await resolver.resolve(request);

    expect(verifier.verify).toHaveBeenCalledTimes(2);
    expect(memberships.findActive).toHaveBeenCalledTimes(2);
  });

  it('fails closed with a retryable service error when membership storage is unavailable', async () => {
    const { verifier } = createDependencies();
    const memberships: MembershipRepository = {
      findActive: vi.fn(async () => {
        throw new Error('postgres://user:secret@example.test/membership');
      }),
    };

    const operation = new TenantSessionResolver(verifier, memberships).resolve(
      request,
    );
    await expect(operation).rejects.toMatchObject({
      status: 503,
      code: 'IDENTITY_SERVICE_UNAVAILABLE',
      message: 'Identity verification is temporarily unavailable',
    });
    await expect(operation).rejects.toBeInstanceOf(
      IdentityServiceUnavailableError,
    );
    await expect(operation).rejects.not.toHaveProperty('cause');
  });

  it('fails closed with the same service error when session storage is unavailable', async () => {
    const verifier: SessionVerifier = {
      verify: vi.fn(async () => {
        throw new SessionVerificationUnavailableError();
      }),
    };
    const { memberships } = createDependencies();

    const operation = new TenantSessionResolver(verifier, memberships).resolve(
      request,
    );
    await expect(operation).rejects.toMatchObject({
      status: 503,
      code: 'IDENTITY_SERVICE_UNAVAILABLE',
    });
    expect(memberships.findActive).not.toHaveBeenCalled();
  });
});

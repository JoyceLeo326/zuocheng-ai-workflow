import { describe, expect, it, vi } from 'vitest';
import {
  BetterAuthSessionVerifier,
  PRODUCTION_SESSION_COOKIE,
  SessionVerificationUnavailableError,
  type BetterAuthSessionApi,
} from './better-auth-session-verifier.js';
import type { SessionVerificationInput } from './tenant-session.js';

const TENANT_ID = '01890f3e-b6e8-7cc2-98c0-7c9a2fe4f5d1';
const USER_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a2';
const SESSION_ID = '01890f3e-b6e8-7a13-8d98-5b82e8cc46a2';
const NOW = new Date('2026-07-23T10:00:00.000Z');

function activeSession() {
  return {
    session: {
      id: SESSION_ID,
      userId: USER_ID,
      activeTenantId: TENANT_ID,
      expiresAt: new Date('2026-07-23T11:00:00.000Z'),
    },
    user: {
      id: USER_ID,
      accountStatus: 'active',
    },
  };
}

function createVerifier(result: unknown = activeSession()) {
  const api: BetterAuthSessionApi = {
    getSession: vi.fn(async () => result),
  };
  return {
    api,
    verifier: new BetterAuthSessionVerifier(api, () => NOW),
  };
}

describe('BetterAuthSessionVerifier', () => {
  it('accepts only a server-validated active cookie session', async () => {
    const { api, verifier } = createVerifier();

    await expect(
      verifier.verify({
        authorization: 'Bearer must-not-be-forwarded',
        cookie: '__Host-zuocheng.session_token=opaque-value',
      }),
    ).resolves.toEqual({
      id: SESSION_ID,
      userId: USER_ID,
      activeTenantId: TENANT_ID,
    });

    expect(api.getSession).toHaveBeenCalledOnce();
    const call = vi.mocked(api.getSession).mock.calls[0]?.[0];
    expect(call?.headers.get('cookie')).toBe(
      '__Host-zuocheng.session_token=opaque-value',
    );
    expect(call?.headers.has('authorization')).toBe(false);
  });

  const rejectedInputs: ReadonlyArray<{
    input: SessionVerificationInput;
    reason: string;
  }> = [
    { input: {}, reason: 'missing cookie' },
    {
      input: { authorization: 'Bearer long-lived-token' },
      reason: 'bearer-only request',
    },
    {
      input: { cookie: 'session=one\nsession=two' },
      reason: 'control character',
    },
    {
      input: { cookie: `session=${'x'.repeat(8_193)}` },
      reason: 'oversized header',
    },
    {
      input: {
        cookie:
          '__Host-zuocheng.session_token=one; __Host-zuocheng.session_token=two',
      },
      reason: 'duplicate session cookie',
    },
  ];

  it.each(rejectedInputs)(
    'rejects $reason without consulting the identity API',
    async ({ input }) => {
    const { api, verifier } = createVerifier();

    await expect(verifier.verify(input)).resolves.toBeNull();
    expect(api.getSession).not.toHaveBeenCalled();
    },
  );

  const rejectedResults: ReadonlyArray<{ result: unknown; reason: string }> = [
    { result: null, reason: 'missing session' },
    {
      result: {
        ...activeSession(),
        session: {
          ...activeSession().session,
          expiresAt: NOW,
        },
      },
      reason: 'expired session',
    },
    {
      result: {
        ...activeSession(),
        user: {
          id: '01890f3e-b6e8-7b11-8d98-5b82e8cc46a2',
          accountStatus: 'active',
        },
      },
      reason: 'mismatched user',
    },
    {
      result: {
        ...activeSession(),
        user: { id: USER_ID, accountStatus: 'suspended' },
      },
      reason: 'suspended user',
    },
    {
      result: {
        ...activeSession(),
        session: { ...activeSession().session, activeTenantId: undefined },
      },
      reason: 'missing tenant binding',
    },
  ];

  it.each(rejectedResults)('fails closed for $reason', async ({ result }) => {
    const { verifier } = createVerifier(result);

    await expect(
      verifier.verify({
        cookie: '__Host-zuocheng.session_token=opaque-value',
      }),
    ).resolves.toBeNull();
  });

  it('distinguishes identity-store failure from invalid credentials without leaking the cause', async () => {
    const api: BetterAuthSessionApi = {
      getSession: vi.fn(async () => {
        throw new Error('postgres://user:secret@example.test/auth');
      }),
    };
    const verifier = new BetterAuthSessionVerifier(api, () => NOW);

    const operation = verifier.verify({
      cookie: '__Host-zuocheng.session_token=opaque-value',
    });
    await expect(operation).rejects.toEqual(
      expect.objectContaining({
        name: 'SessionVerificationUnavailableError',
        message: 'Identity session verification is unavailable',
      }),
    );
    await expect(operation).rejects.not.toHaveProperty('cause');
    await expect(operation).rejects.toBeInstanceOf(
      SessionVerificationUnavailableError,
    );
  });

  it('defines a host-only production cookie contract', () => {
    expect(PRODUCTION_SESSION_COOKIE).toEqual({
      name: '__Host-zuocheng.session_token',
      attributes: {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
      },
    });
    expect(PRODUCTION_SESSION_COOKIE.attributes).not.toHaveProperty('domain');
  });
});

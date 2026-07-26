import { ProblemDetailsSchema, type UUIDv7 } from '@zuocheng/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import {
  IdentityLifecycleError,
  type IdentityHttpSecurityPort,
  type IdentityLifecycleService,
  type IdentityRateLimiter,
} from './identity-lifecycle-service.js';

const REQUEST_ID = '01900000-0000-7000-8000-000000000001';
const USER_ID = '01900000-0000-7000-8000-000000000002' as UUIDv7;
const SESSION_ID = '01900000-0000-7000-8000-000000000003' as UUIDv7;
const OTHER_SESSION_ID = '01900000-0000-7000-8000-000000000004' as UUIDv7;
const DEVICE_ID = '01900000-0000-7000-8000-000000000005' as UUIDv7;
const CREDENTIAL_ID = '01900000-0000-7000-8000-000000000006' as UUIDv7;
const CHALLENGE_ID = '01900000-0000-7000-8000-000000000007' as UUIDv7;
const EXPORT_ID = '01900000-0000-7000-8000-000000000008' as UUIDv7;
const DELETION_ID = '01900000-0000-7000-8000-000000000009' as UUIDv7;
const IDEMPOTENCY_KEY = 'identity-route-key-0001';

const principal = { userId: USER_ID, sessionId: SESSION_ID };
const session = {
  id: SESSION_ID,
  userId: USER_ID,
  deviceId: DEVICE_ID,
  createdAt: '2026-07-26T08:00:00.000Z',
  lastSeenAt: '2026-07-26T08:30:00.000Z',
  expiresAt: '2026-08-02T08:00:00.000Z',
  current: true,
  revokedAt: null,
};
const otherSession = {
  ...session,
  id: OTHER_SESSION_ID,
  current: false,
};
const device = {
  id: DEVICE_ID,
  displayName: 'Firefox on Windows',
  platform: 'Windows',
  lastSeenAt: '2026-07-26T08:30:00.000Z',
  current: true,
};
const exportRequest = {
  id: EXPORT_ID,
  status: 'pending' as const,
  requestedAt: '2026-07-26T08:30:00.000Z',
  completedAt: null,
  expiresAt: null,
  downloadUrl: null,
  sha256: null,
};
const deletionRequest = {
  id: DELETION_ID,
  status: 'pending' as const,
  requestedAt: '2026-07-26T08:30:00.000Z',
  cancellableUntil: '2026-07-27T08:30:00.000Z',
  irreversibleAt: null,
  completedAt: null,
};

function createService(
  events: string[] = [],
): IdentityLifecycleService & Record<string, ReturnType<typeof vi.fn>> {
  return {
    authenticate: vi.fn(async () => {
      events.push('authenticate');
      return principal;
    }),
    registerPassword: vi.fn(async () => {
      events.push('registerPassword');
      return { status: 'verification_required' as const };
    }),
    completeEmailVerification: vi.fn(async () => ({
      status: 'verified' as const,
      redirectTo: '/login?verified=1',
    })),
    loginPassword: vi.fn(async () => {
      events.push('loginPassword');
      return {
        sessionToken: 'opaque.session-token_1',
        session,
      };
    }),
    createPasskeyRegistrationOptions: vi.fn(async () => ({
      challengeId: CHALLENGE_ID,
      expiresAt: '2026-07-26T08:35:00.000Z',
      publicKey: { challenge: 'registration-challenge' },
    })),
    verifyPasskeyRegistration: vi.fn(async () => ({
      id: CREDENTIAL_ID,
      displayName: 'Work laptop',
      createdAt: '2026-07-26T08:30:00.000Z',
    })),
    createPasskeyAuthenticationOptions: vi.fn(async () => ({
      challengeId: CHALLENGE_ID,
      expiresAt: '2026-07-26T08:35:00.000Z',
      publicKey: { challenge: 'authentication-challenge' },
    })),
    verifyPasskeyAuthentication: vi.fn(async () => ({
      sessionToken: 'opaque.passkey-session_1',
      session,
    })),
    startOAuth: vi.fn(async () => ({
      authorizationUrl:
        'https://accounts.example.test/authorize?state=opaque-state',
    })),
    completeOAuth: vi.fn(async () => ({
      sessionToken: 'opaque.oauth-session_1',
      session,
      redirectTo: '/account/security',
    })),
    getCurrentSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => [session, otherSession]),
    listDevices: vi.fn(async () => [device]),
    revokeSession: vi.fn(async () => ({
      revokedSessionIds: [OTHER_SESSION_ID],
    })),
    revokeOtherSessions: vi.fn(async () => ({
      revokedSessionIds: [OTHER_SESSION_ID],
    })),
    revokeAllSessions: vi.fn(async () => ({
      revokedSessionIds: [SESSION_ID, OTHER_SESSION_ID],
    })),
    logout: vi.fn(async () => undefined),
    requestPasswordRecovery: vi.fn(async () => undefined),
    completePasswordRecovery: vi.fn(async () => ({
      status: 'password_updated' as const,
    })),
    createRecentAuthProofWithPassword: vi.fn(async () => ({
      recentAuthToken: 'opaque.recent-auth-token_1',
      expiresAt: '2026-07-26T08:35:00.000Z',
    })),
    requestAccountExport: vi.fn(async () => exportRequest),
    getAccountExport: vi.fn(async () => exportRequest),
    requestAccountDeletion: vi.fn(async () => ({
      deletion: deletionRequest,
      confirmationDelivery: {
        channel: 'email' as const,
        status: 'sent' as const,
      },
    })),
    getAccountDeletion: vi.fn(async () => deletionRequest),
    cancelAccountDeletion: vi.fn(async () => ({
      ...deletionRequest,
      status: 'cancelled' as const,
    })),
    confirmAccountDeletion: vi.fn(async () => ({
      ...deletionRequest,
      status: 'processing' as const,
      cancellableUntil: null,
      irreversibleAt: '2026-07-26T08:31:00.000Z',
    })),
  };
}

function createSecurity(
  implementation?: IdentityHttpSecurityPort['enforce'],
): IdentityHttpSecurityPort & { enforce: ReturnType<typeof vi.fn> } {
  return {
    enforce: vi.fn(implementation ?? (async () => undefined)),
  };
}

function createRateLimiter(
  implementation?: IdentityRateLimiter['consume'],
): IdentityRateLimiter & { consume: ReturnType<typeof vi.fn> } {
  return {
    consume: vi.fn(
      implementation ?? (async () => ({ allowed: true as const })),
    ),
  };
}

function testApp(
  service: IdentityLifecycleService = createService(),
  security: IdentityHttpSecurityPort = createSecurity(),
  rateLimiter: IdentityRateLimiter = createRateLimiter(),
) {
  return createApp('local', {
    clock: () => new Date('2026-07-26T08:30:00.000Z'),
    createRequestId: () => REQUEST_ID,
    identityLifecycleService: service,
    identityHttpSecurity: security,
    identityRateLimiter: rateLimiter,
  });
}

const publicMutationHeaders = {
  'Content-Type': 'application/json',
  'Idempotency-Key': IDEMPOTENCY_KEY,
  Origin: 'https://zuocheng.example',
  'X-CSRF-Token': 'csrf-token',
};
const protectedMutationHeaders = {
  ...publicMutationHeaders,
  Cookie: '__Host-zuocheng.session_token=existing-session',
};

describe('identity lifecycle HTTP routes', () => {
  it('wires every required lifecycle operation to the injected service with canonical statuses', async () => {
    const service = createService();
    const app = testApp(service);

    const responses = await Promise.all([
      app.request('/v1/auth/password/register', {
        method: 'POST',
        headers: publicMutationHeaders,
        body: JSON.stringify({
          email: 'person@example.test',
          password: 'correct horse battery staple',
          displayName: 'Person',
        }),
      }),
      app.request('/v1/auth/password/login', {
        method: 'POST',
        headers: publicMutationHeaders,
        body: JSON.stringify({
          identifier: 'person@example.test',
          password: 'correct horse battery staple',
        }),
      }),
      app.request(
        '/v1/auth/email-verification/complete?token=opaque-email-verification-token',
      ),
      app.request('/v1/auth/passkeys/registration/options', {
        method: 'POST',
        headers: protectedMutationHeaders,
        body: JSON.stringify({ displayName: 'Work laptop' }),
      }),
      app.request('/v1/auth/passkeys/registration/verify', {
        method: 'POST',
        headers: protectedMutationHeaders,
        body: JSON.stringify({
          challengeId: CHALLENGE_ID,
          response: { id: 'credential-response' },
          displayName: 'Work laptop',
        }),
      }),
      app.request('/v1/auth/passkeys/authentication/options', {
        method: 'POST',
        headers: publicMutationHeaders,
        body: JSON.stringify({ identifier: 'person@example.test' }),
      }),
      app.request('/v1/auth/passkeys/authentication/verify', {
        method: 'POST',
        headers: publicMutationHeaders,
        body: JSON.stringify({
          challengeId: CHALLENGE_ID,
          response: { id: 'credential-response' },
        }),
      }),
      app.request('/v1/auth/oauth/google/start', {
        method: 'POST',
        headers: publicMutationHeaders,
        body: JSON.stringify({ returnTo: '/account/security' }),
      }),
      app.request(
        '/v1/auth/oauth/google/callback?code=opaque-code&state=opaque-state',
      ),
      app.request('/v1/auth/session/current', {
        headers: { Cookie: protectedMutationHeaders.Cookie },
      }),
      app.request('/v1/auth/sessions', {
        headers: { Cookie: protectedMutationHeaders.Cookie },
      }),
      app.request('/v1/auth/devices', {
        headers: { Cookie: protectedMutationHeaders.Cookie },
      }),
      app.request(`/v1/auth/sessions/${OTHER_SESSION_ID}`, {
        method: 'DELETE',
        headers: protectedMutationHeaders,
      }),
      app.request('/v1/auth/sessions/revoke-others', {
        method: 'POST',
        headers: protectedMutationHeaders,
        body: '{}',
      }),
      app.request('/v1/auth/sessions/revoke-all', {
        method: 'POST',
        headers: protectedMutationHeaders,
        body: '{}',
      }),
      app.request('/v1/auth/logout', {
        method: 'POST',
        headers: protectedMutationHeaders,
        body: '{}',
      }),
      app.request('/v1/auth/password-recovery/request', {
        method: 'POST',
        headers: publicMutationHeaders,
        body: JSON.stringify({ email: 'person@example.test' }),
      }),
      app.request('/v1/auth/password-recovery/complete', {
        method: 'POST',
        headers: publicMutationHeaders,
        body: JSON.stringify({
          token: 'opaque-single-use-recovery-token',
          newPassword: 'new correct horse battery staple',
        }),
      }),
      app.request('/v1/auth/recent-auth/password', {
        method: 'POST',
        headers: protectedMutationHeaders,
        body: JSON.stringify({
          password: 'correct horse battery staple',
        }),
      }),
      app.request('/v1/account/exports', {
        method: 'POST',
        headers: protectedMutationHeaders,
        body: '{}',
      }),
      app.request(`/v1/account/exports/${EXPORT_ID}`, {
        headers: { Cookie: protectedMutationHeaders.Cookie },
      }),
      app.request('/v1/account/deletion', {
        method: 'POST',
        headers: protectedMutationHeaders,
        body: JSON.stringify({
          recentAuthToken: 'opaque-recent-auth-proof',
        }),
      }),
      app.request('/v1/account/deletion', {
        headers: { Cookie: protectedMutationHeaders.Cookie },
      }),
      app.request('/v1/account/deletion', {
        method: 'DELETE',
        headers: protectedMutationHeaders,
      }),
      app.request('/v1/account/deletion/confirm', {
        method: 'POST',
        headers: protectedMutationHeaders,
        body: JSON.stringify({
          deletionRequestId: DELETION_ID,
          confirmationToken: 'opaque-deletion-confirmation',
        }),
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      202, 200, 303, 200, 201, 200, 200, 200, 303, 200, 200, 200, 200,
      200, 200, 204, 202, 200, 200, 202, 200, 202, 200, 200, 202,
    ]);

    expect(responses[1]?.headers.get('set-cookie')).toBe(
      '__Host-zuocheng.session_token=opaque.session-token_1; Path=/; HttpOnly; Secure; SameSite=Lax',
    );
    expect(responses[2]?.headers.get('location')).toBe('/login?verified=1');
    expect(responses[8]?.headers.get('location')).toBe('/account/security');
    expect(responses[8]?.headers.get('set-cookie')).toContain(
      'HttpOnly; Secure; SameSite=Lax',
    );
    expect(responses[19]?.headers.get('location')).toBe(
      `/v1/account/exports/${EXPORT_ID}`,
    );
    expect(responses[21]?.headers.get('location')).toBe(
      '/v1/account/deletion',
    );
    expect(responses[14]?.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(responses[15]?.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(responses[17]?.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(responses[24]?.headers.get('set-cookie')).toContain('Max-Age=0');
    await expect(responses[21]?.json()).resolves.toMatchObject({
      deletion: deletionRequest,
      confirmationDelivery: {
        channel: 'email',
        status: 'sent',
      },
    });

    expect(service.registerPassword).toHaveBeenCalledWith(
      {
        email: 'person@example.test',
        password: 'correct horse battery staple',
        displayName: 'Person',
      },
      IDEMPOTENCY_KEY,
    );
    expect(service.startOAuth).toHaveBeenCalledWith(
      {
        provider: 'google',
        returnTo: '/account/security',
      },
      IDEMPOTENCY_KEY,
    );
    expect(service.completeOAuth).toHaveBeenCalledWith({
      provider: 'google',
      code: 'opaque-code',
      state: 'opaque-state',
    });
    expect(service.completeEmailVerification).toHaveBeenCalledWith({
      token: 'opaque-email-verification-token',
    });
    expect(service.revokeSession).toHaveBeenCalledWith(
      principal,
      OTHER_SESSION_ID,
      IDEMPOTENCY_KEY,
    );
    expect(service.requestAccountExport).toHaveBeenCalledWith(
      principal,
      IDEMPOTENCY_KEY,
    );
    expect(service.createRecentAuthProofWithPassword).toHaveBeenCalledWith(
      principal,
      {
        password: 'correct horse battery staple',
        purpose: 'account-deletion',
      },
      IDEMPOTENCY_KEY,
    );
    expect(service.confirmAccountDeletion).toHaveBeenCalledWith(
      principal,
      {
        deletionRequestId: DELETION_ID,
        confirmationToken: 'opaque-deletion-confirmation',
      },
      IDEMPOTENCY_KEY,
    );

    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('vary')).toContain('Cookie');
    }
  });

  it('consumes email verification tokens once and never exposes token state', async () => {
    const service = createService();
    const app = testApp(service);
    const verified = await app.request(
      '/v1/auth/email-verification/complete?token=opaque-email-verification-token',
    );
    expect(verified.status).toBe(303);
    expect(verified.headers.get('location')).toBe('/login?verified=1');

    vi.mocked(service.completeEmailVerification).mockRejectedValue(
      new IdentityLifecycleError('VERIFICATION_TOKEN_INVALID'),
    );
    const replayed = await app.request(
      '/v1/auth/email-verification/complete?token=opaque-email-verification-token',
    );
    expect(replayed.status).toBe(400);
    const serialized = JSON.stringify(await replayed.json());
    expect(serialized).toContain('VERIFICATION_TOKEN_INVALID');
    expect(serialized).not.toContain('opaque-email-verification-token');
  });

  it('issues a short-lived recent-auth proof through a protected password verification flow', async () => {
    const service = createService();
    const security = createSecurity();
    const rateLimiter = createRateLimiter();
    const response = await testApp(
      service,
      security,
      rateLimiter,
    ).request('/v1/auth/recent-auth/password', {
      method: 'POST',
      headers: protectedMutationHeaders,
      body: JSON.stringify({
        password: 'correct horse battery staple',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      recentAuthToken: 'opaque.recent-auth-token_1',
      expiresAt: '2026-07-26T08:35:00.000Z',
    });
    expect(service.authenticate).toHaveBeenCalledOnce();
    expect(security.enforce).toHaveBeenCalledOnce();
    expect(rateLimiter.consume).toHaveBeenCalledOnce();
  });

  it('enforces authentication, Origin/CSRF, idempotency and persistent rate limiting before body parsing or business handling', async () => {
    const events: string[] = [];
    const service = createService(events);
    const security = createSecurity(async () => {
      events.push('security');
    });
    const rateLimiter = createRateLimiter(async () => {
      events.push('rate-limit');
      return { allowed: true };
    });
    const app = testApp(service, security, rateLimiter);

    const response = await app.request('/v1/account/deletion', {
      method: 'POST',
      headers: protectedMutationHeaders,
      body: JSON.stringify({
        recentAuthToken: 'opaque-recent-auth-proof',
      }),
    });

    expect(response.status).toBe(202);
    expect(events.slice(0, 3)).toEqual([
      'authenticate',
      'security',
      'rate-limit',
    ]);
    expect(service.requestAccountDeletion).toHaveBeenCalledOnce();

    const noKey = await app.request('/v1/auth/password/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://zuocheng.example',
      },
      body: '{"identifier":',
    });
    expect(noKey.status).toBe(428);
    await expect(noKey.json()).resolves.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    expect(service.loginPassword).not.toHaveBeenCalled();
  });

  it('fails closed when Origin/CSRF or rate-limit enforcement is unavailable or denies the request', async () => {
    const service = createService();
    const originDenied = await testApp(
      service,
      createSecurity(async () => {
        throw new IdentityLifecycleError('ORIGIN_FORBIDDEN');
      }),
    ).request('/v1/auth/password/login', {
      method: 'POST',
      headers: publicMutationHeaders,
      body: '{"identifier":',
    });
    expect(originDenied.status).toBe(403);
    await expect(originDenied.json()).resolves.toMatchObject({
      code: 'ORIGIN_FORBIDDEN',
    });

    const securityUnavailable = await testApp(
      service,
      createSecurity(async () => {
        throw new Error('redis password and internal topology');
      }),
    ).request('/v1/auth/password/login', {
      method: 'POST',
      headers: publicMutationHeaders,
      body: JSON.stringify({
        identifier: 'person@example.test',
        password: 'correct horse battery staple',
      }),
    });
    expect(securityUnavailable.status).toBe(503);
    expect(JSON.stringify(await securityUnavailable.json())).not.toContain(
      'redis password',
    );

    const rateStoreUnavailable = await testApp(
      service,
      createSecurity(),
      createRateLimiter(async () => {
        throw new Error('postgres://secret@customer.invalid/identity');
      }),
    ).request('/v1/auth/password/login', {
      method: 'POST',
      headers: publicMutationHeaders,
      body: JSON.stringify({
        identifier: 'person@example.test',
        password: 'correct horse battery staple',
      }),
    });
    expect(rateStoreUnavailable.status).toBe(503);
    await expect(rateStoreUnavailable.json()).resolves.toMatchObject({
      code: 'RATE_LIMIT_UNAVAILABLE',
      retryable: true,
    });

    const rateLimited = await testApp(
      service,
      createSecurity(),
      createRateLimiter(async () => ({ allowed: false })),
    ).request('/v1/auth/password/login', {
      method: 'POST',
      headers: publicMutationHeaders,
      body: JSON.stringify({
        identifier: 'person@example.test',
        password: 'correct horse battery staple',
      }),
    });
    expect(rateLimited.status).toBe(429);
    await expect(rateLimited.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    expect(service.loginPassword).not.toHaveBeenCalled();
  });

  it('rejects unsupported, oversized and invalid JSON before the service sees credentials', async () => {
    const service = createService();
    const app = testApp(service);
    const requests = [
      app.request('/v1/auth/password/login', {
        method: 'POST',
        headers: {
          ...publicMutationHeaders,
          'Content-Type': 'text/plain',
        },
        body: '{}',
      }),
      app.request('/v1/auth/password/login', {
        method: 'POST',
        headers: {
          ...publicMutationHeaders,
          'Content-Length': '999999999',
        },
        body: '{}',
      }),
      app.request('/v1/auth/password/login', {
        method: 'POST',
        headers: publicMutationHeaders,
        body: '{"identifier":',
      }),
    ];
    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.status)).toEqual([
      415, 413, 422,
    ]);
    expect(service.loginPassword).not.toHaveBeenCalled();
  });

  it('returns explicit provider and email unavailability instead of fake redirects or fake sends', async () => {
    const service = createService();
    vi.mocked(service.startOAuth).mockRejectedValue(
      new IdentityLifecycleError('OAUTH_PROVIDER_UNAVAILABLE'),
    );
    vi.mocked(service.requestPasswordRecovery).mockRejectedValue(
      new IdentityLifecycleError('EMAIL_PROVIDER_UNAVAILABLE'),
    );
    const app = testApp(service);

    const oauth = await app.request('/v1/auth/oauth/microsoft/start', {
      method: 'POST',
      headers: publicMutationHeaders,
      body: JSON.stringify({ returnTo: '/account' }),
    });
    expect(oauth.status).toBe(503);
    await expect(oauth.json()).resolves.toMatchObject({
      code: 'OAUTH_PROVIDER_UNAVAILABLE',
      retryable: false,
    });

    const recovery = await app.request(
      '/v1/auth/password-recovery/request',
      {
        method: 'POST',
        headers: publicMutationHeaders,
        body: JSON.stringify({ email: 'person@example.test' }),
      },
    );
    expect(recovery.status).toBe(503);
    await expect(recovery.json()).resolves.toMatchObject({
      code: 'EMAIL_PROVIDER_UNAVAILABLE',
      retryable: false,
    });
  });

  it('keeps recovery acceptance enumeration-safe and identity failures opaque', async () => {
    const acceptedService = createService();
    const accepted = await testApp(acceptedService).request(
      '/v1/auth/password-recovery/request',
      {
        method: 'POST',
        headers: publicMutationHeaders,
        body: JSON.stringify({ email: 'unknown@example.test' }),
      },
    );
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toEqual({ status: 'accepted' });

    const loginService = createService();
    vi.mocked(loginService.loginPassword).mockRejectedValue(
      new IdentityLifecycleError('INVALID_CREDENTIALS'),
    );
    const app = testApp(loginService);
    const [unknown, known] = await Promise.all([
      app.request('/v1/auth/password/login', {
        method: 'POST',
        headers: publicMutationHeaders,
        body: JSON.stringify({
          identifier: 'unknown@example.test',
          password: 'incorrect password',
        }),
      }),
      app.request('/v1/auth/password/login', {
        method: 'POST',
        headers: publicMutationHeaders,
        body: JSON.stringify({
          identifier: 'known@example.test',
          password: 'incorrect password',
        }),
      }),
    ]);
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(await known.json());
  });

  it('validates provider allowlists and UUID resource ids without invoking adapters', async () => {
    const service = createService();
    const app = testApp(service);

    const provider = await app.request('/v1/auth/oauth/custom/start', {
      method: 'POST',
      headers: publicMutationHeaders,
      body: JSON.stringify({ returnTo: '/account' }),
    });
    expect(provider.status).toBe(404);

    const sessionId = await app.request('/v1/auth/sessions/not-a-uuid', {
      method: 'DELETE',
      headers: protectedMutationHeaders,
    });
    expect(sessionId.status).toBe(422);
    expect(service.startOAuth).not.toHaveBeenCalled();
    expect(service.revokeSession).not.toHaveBeenCalled();
  });

  it('exposes a non-success problem when the lifecycle or security ports are not composed', async () => {
    const app = createApp('local', {
      clock: () => new Date('2026-07-26T08:30:00.000Z'),
      createRequestId: () => REQUEST_ID,
    });
    const response = await app.request('/v1/auth/session/current');

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(
      ProblemDetailsSchema.parse(await response.json()),
    ).toMatchObject({
      code: 'IDENTITY_LIFECYCLE_NOT_CONFIGURED',
      retryable: false,
    });
  });
});

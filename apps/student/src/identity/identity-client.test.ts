import { describe, expect, it, vi } from 'vitest';
import {
  IdentityApiError,
  createIdentityClient,
  type IdentityFetch,
} from './identity-client.js';

const API_ORIGIN = 'https://api.zuocheng.example';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

describe('identity API client', () => {
  it('uses credentials, a fresh idempotency key and the canonical registration route', async () => {
    const fetcher = vi.fn<IdentityFetch>(async () =>
      jsonResponse(202, { status: 'verification_required' }),
    );
    const client = createIdentityClient({
      apiOrigin: API_ORIGIN,
      fetcher,
      createIdempotencyKey: () => 'identity-key-0001',
    });

    await expect(
      client.registerPassword({
        email: 'student@example.test',
        password: 'correct horse battery staple',
        displayName: '林同学',
      }),
    ).resolves.toEqual({ status: 'verification_required' });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://api.zuocheng.example/v1/auth/password/register',
    );
    expect(request).toMatchObject({
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      body: JSON.stringify({
        email: 'student@example.test',
        password: 'correct horse battery staple',
        displayName: '林同学',
      }),
    });
    const headers = new Headers(request?.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Idempotency-Key')).toBe('identity-key-0001');
  });

  it('covers password, OAuth, sessions, export and deletion without exposing a token API', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn<IdentityFetch>(async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (url.endsWith('/oauth/google/start')) {
        return jsonResponse(200, {
          authorizationUrl: 'https://accounts.google.test/authorize',
        });
      }
      if (url.endsWith('/sessions')) {
        return jsonResponse(200, []);
      }
      if (url.endsWith('/devices')) {
        return jsonResponse(200, []);
      }
      if (url.endsWith('/exports')) {
        return jsonResponse(202, {
          id: '01900000-0000-7000-8000-000000000008',
          status: 'pending',
          requestedAt: '2026-07-26T08:30:00.000Z',
          completedAt: null,
          expiresAt: null,
          downloadUrl: null,
          sha256: null,
        });
      }
      if (url.endsWith('/recent-auth/password')) {
        return jsonResponse(200, {
          recentAuthToken: 'opaque-recent-auth-proof',
          expiresAt: '2026-07-26T08:35:00.000Z',
        });
      }
      if (url.endsWith('/deletion')) {
        return jsonResponse(202, {
          deletion: {
            id: '01900000-0000-7000-8000-000000000009',
            status: 'pending',
            requestedAt: '2026-07-26T08:30:00.000Z',
            cancellableUntil: '2026-07-27T08:30:00.000Z',
            irreversibleAt: null,
            completedAt: null,
          },
          confirmationDelivery: { channel: 'email', status: 'sent' },
        });
      }
      if (url.endsWith('/deletion/confirm')) {
        return jsonResponse(202, {
          id: '01900000-0000-7000-8000-000000000009',
          status: 'processing',
          requestedAt: '2026-07-26T08:30:00.000Z',
          cancellableUntil: null,
          irreversibleAt: '2026-07-26T08:31:00.000Z',
          completedAt: null,
        });
      }
      return jsonResponse(200, {
        session: {
          id: '01900000-0000-7000-8000-000000000003',
          userId: '01900000-0000-7000-8000-000000000002',
          deviceId: '01900000-0000-7000-8000-000000000005',
          createdAt: '2026-07-26T08:00:00.000Z',
          lastSeenAt: '2026-07-26T08:30:00.000Z',
          expiresAt: '2026-08-02T08:00:00.000Z',
          current: true,
          revokedAt: null,
        },
      });
    });
    const client = createIdentityClient({
      apiOrigin: API_ORIGIN,
      fetcher,
      createIdempotencyKey: () => 'identity-key-0002',
    });

    await client.loginPassword({
      identifier: 'student@example.test',
      password: 'correct horse battery staple',
    });
    await client.startOAuth('google', { returnTo: '/account/security' });
    await client.listSessions();
    await client.listDevices();
    const recentAuth = await client.verifyRecentPassword({
      password: 'correct horse battery staple',
    });
    await client.requestAccountExport();
    await client.requestAccountDeletion({
      recentAuthToken: recentAuth.recentAuthToken,
    });
    await client.confirmAccountDeletion({
      deletionRequestId: '01900000-0000-7000-8000-000000000009',
      confirmationToken: 'opaque-confirmation',
    });

    expect(calls).toEqual([
      'POST /v1/auth/password/login',
      'POST /v1/auth/oauth/google/start',
      'GET /v1/auth/sessions',
      'GET /v1/auth/devices',
      'POST /v1/auth/recent-auth/password',
      'POST /v1/account/exports',
      'POST /v1/account/deletion',
      'POST /v1/account/deletion/confirm',
    ]);
    expect(Object.keys(client)).not.toContain('getSessionToken');
    for (const call of fetcher.mock.calls) {
      expect(call[1]?.credentials).toBe('include');
    }
  });

  it('returns structured Problem Details and Retry-After without account enumeration text synthesis', async () => {
    const fetcher = vi.fn<IdentityFetch>(async () =>
      jsonResponse(
        429,
        {
          type: 'https://zuocheng.example/problems/rate-limited',
          title: 'Too many requests',
          status: 429,
          code: 'RATE_LIMITED',
          detail: 'Try again later.',
          requestId: '01900000-0000-7000-8000-000000000001',
        },
        { 'Retry-After': '60' },
      ),
    );
    const client = createIdentityClient({
      apiOrigin: API_ORIGIN,
      fetcher,
      createIdempotencyKey: () => 'identity-key-0003',
    });

    const error = await client
      .requestPasswordRecovery({ email: 'unknown@example.test' })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(IdentityApiError);
    expect(error).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 60,
      requestId: '01900000-0000-7000-8000-000000000001',
    });
    expect(String(error)).not.toContain('unknown@example.test');
  });

  it('fails closed for a non-HTTPS cross-origin production API', () => {
    expect(() =>
      createIdentityClient({
        apiOrigin: 'http://api.zuocheng.example',
        fetcher: vi.fn<IdentityFetch>(),
        createIdempotencyKey: () => 'identity-key-0004',
      }),
    ).toThrow(/HTTPS/);
  });
});

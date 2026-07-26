import { parseRuntimeEnvironment } from '@zuocheng/config';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { BetterAuthSessionApi } from './auth/better-auth-session-verifier.js';
import {
  IdentityLifecycleError,
  type IdentityLifecycleService,
} from './auth/http/identity-lifecycle-service.js';
import type {
  BetterAuthRuntime,
  CustomerManagedIdentityRuntimeConfig,
} from './auth/runtime/better-auth-runtime.js';
import {
  ProductionCompositionError,
  composeApiRuntime,
  type CustomerManagedRuntimeAdapter,
} from './production-composition.js';

const TENANT_ID = '01890f3e-b6e8-7cc2-98c0-7c9a2fe4f5d1';
const USER_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a2';
const MEMBERSHIP_ID = '01890f3e-b6e8-7a12-8d98-5b82e8cc46a2';
const SESSION_ID = '01890f3e-b6e8-7a13-8d98-5b82e8cc46a2';
const REQUEST_ID = '01900000-0000-7000-8000-000000000001';

function createCustomerAdapter(): {
  adapter: CustomerManagedRuntimeAdapter;
  sessionApi: BetterAuthSessionApi;
  queries: Array<{ sql: string; values: readonly unknown[] }>;
  close: ReturnType<typeof vi.fn>;
} {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      queries.push({ sql, values });
      if (sql.includes('current_session_tenant_id')) {
        return {
          rows: [{ tenant_id: TENANT_ID, user_id: USER_ID }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM zuocheng.project AS project')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM zuocheng.membership')) {
        return {
          rows: [
            {
              id: MEMBERSHIP_ID,
              tenant_id: TENANT_ID,
              user_id: USER_ID,
              status: 'active',
              deleted_at: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: null };
    },
    release: vi.fn(),
  };
  const close = vi.fn(async () => undefined);
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  const sessionApi = {
    getSession: vi.fn(
      async (input: Readonly<{ headers: Headers }>) => {
        void input;
        return {
          session: {
            id: SESSION_ID,
            userId: USER_ID,
            activeTenantId: TENANT_ID,
            expiresAt: new Date('2026-07-24T00:00:00.000Z'),
          },
          user: { id: USER_ID, accountStatus: 'active' },
        };
      },
    ),
  };
  return {
    queries,
    close,
    sessionApi,
    adapter: {
      kind: 'customer-managed-production',
      identity: createCustomerIdentityConfig(),
      identityLifecycleService: createIdentityLifecycleService(),
      identityHttpSecurity: {
        enforce: vi.fn(async () => undefined),
      },
      identityRateLimiter: {
        consume: vi.fn(async () => ({ allowed: true as const })),
      },
      principalPoolForContext: vi.fn(() => pool),
      checkReadiness: vi.fn(async () => ({
        identity: 'ready' as const,
        database: 'ready' as const,
      })),
      close,
    },
  };
}

function createIdentityLifecycleService(): IdentityLifecycleService {
  const methodNames = [
    'authenticate',
    'registerPassword',
    'completeEmailVerification',
    'loginPassword',
    'createPasskeyRegistrationOptions',
    'verifyPasskeyRegistration',
    'createPasskeyAuthenticationOptions',
    'verifyPasskeyAuthentication',
    'startOAuth',
    'completeOAuth',
    'getCurrentSession',
    'listSessions',
    'listDevices',
    'revokeSession',
    'revokeOtherSessions',
    'revokeAllSessions',
    'logout',
    'requestPasswordRecovery',
    'completePasswordRecovery',
    'createRecentAuthProofWithPassword',
    'requestAccountExport',
    'getAccountExport',
    'requestAccountDeletion',
    'getAccountDeletion',
    'cancelAccountDeletion',
    'confirmAccountDeletion',
  ] as const;
  return Object.fromEntries(
    methodNames.map((name) => [name, vi.fn(async () => undefined)]),
  ) as unknown as IdentityLifecycleService;
}

function createCustomerIdentityConfig(): CustomerManagedIdentityRuntimeConfig {
  return {
    kind: 'customer-managed-identity',
    publicConfig: {
      baseURL: 'https://api.example.edu',
      trustedOrigins: [
        'https://api.example.edu',
        'https://student.example.edu',
      ],
      passkey: { rpId: 'example.edu', rpName: '做成' },
    },
    database: {
      kind: 'customer-managed-better-auth-database',
      adapter: { create: vi.fn() } as never,
      capabilities: {
        profile: 'better-auth-1.6.25',
        databaseGeneratedIds: 'uuidv7',
        sessionStorage: 'database',
        verificationIdentifiers: 'sha256-base64url-43',
        verificationConsume: 'atomic',
        oauthTokenStorage:
          'better-auth-encrypted-customer-aad-envelope',
        oauthTokenEnvelope:
          '$ba$<positive-key-version>$<lowercase-even-hex>',
        oauthTokenKeyVersion: 'positive-integer',
        oauthTokenAadBinding: 'purpose-provider-user-tenant',
        passkeyStorage: 'public-key-only',
      },
    },
    secrets: {
      kind: 'customer-managed-secret-rotation',
      values: [
        { version: 2, value: 'c'.repeat(48) },
        { version: 1, value: 'p'.repeat(48) },
      ],
    },
    mailer: {
      kind: 'customer-managed-email-delivery',
      sendVerificationEmail: vi.fn(async () => ({
        status: 'sent' as const,
        deliveryId: 'verification-delivery-id',
      })),
      sendPasswordResetEmail: vi.fn(async () => ({
        status: 'sent' as const,
        deliveryId: 'reset-delivery-id',
      })),
    },
    providers: {
      google: {
        clientId: 'customer-google-client',
        clientSecret: 'customer-google-secret',
      },
      github: {
        clientId: 'customer-github-client',
        clientSecret: 'customer-github-secret',
      },
      microsoft: {
        clientId: 'customer-microsoft-client',
        clientSecret: 'customer-microsoft-secret',
        tenantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      },
    },
  };
}

function createIdentityRuntime(
  sessionApi: BetterAuthSessionApi,
): BetterAuthRuntime {
  return {
    api: sessionApi,
    handler: vi.fn(async (request: Request) => {
      void request;
      return new Response(null, { status: 404 });
    }),
  };
}

function productionConfiguration(module = '@customer/zuocheng-runtime') {
  return parseRuntimeEnvironment({
    DEPLOYMENT_MODE: 'tenant-managed-production',
    TENANT_RUNTIME_ADAPTER_MODULE: module,
  });
}

describe('tenant-managed production composition', () => {
  it('refuses startup without a customer runtime adapter module', async () => {
    await expect(
      composeApiRuntime(
        parseRuntimeEnvironment({
          DEPLOYMENT_MODE: 'tenant-managed-production',
        }),
      ),
    ).rejects.toBeInstanceOf(ProductionCompositionError);
  });

  it('loads real customer boundaries and exposes authenticated project routes', async () => {
    const { adapter, queries, sessionApi } = createCustomerAdapter();
    const importer = vi.fn(async () => ({
      createCustomerManagedRuntimeAdapter: vi.fn(async () => adapter),
    }));
    const runtime = await composeApiRuntime(productionConfiguration(), {
      importer,
      identityRuntimeFactory: () => createIdentityRuntime(sessionApi),
      clock: () => new Date('2026-07-23T10:00:00.000Z'),
      createRequestId: () => REQUEST_ID,
    });

    const response = await runtime.app.request('/v1/projects', {
      headers: {
        cookie: '__Host-zuocheng.session_token=opaque-customer-session',
      },
    });

    expect(importer).toHaveBeenCalledWith('@customer/zuocheng-runtime');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: [] });
    expect(queries.some(({ sql }) => sql.includes('FROM zuocheng.membership'))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes('FROM zuocheng.project AS project'))).toBe(true);
  });

  it('uses only the customer adapter readiness result and closes its resources once', async () => {
    const { adapter, close, sessionApi } = createCustomerAdapter();
    const runtime = await composeApiRuntime(productionConfiguration(), {
      importer: async () => ({
        createCustomerManagedRuntimeAdapter: async () => adapter,
      }),
      identityRuntimeFactory: () => createIdentityRuntime(sessionApi),
      clock: () => new Date('2026-07-23T10:00:00.000Z'),
      createRequestId: () => REQUEST_ID,
    });

    const ready = await runtime.app.request('/readyz');
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      status: 'ok',
      dependencies: { identity: 'ready', database: 'ready' },
    });

    await runtime.close();
    await runtime.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects malformed customer readiness claims instead of claiming ready', async () => {
    const { adapter, sessionApi } = createCustomerAdapter();
    const malformed = {
      ...adapter,
      checkReadiness: async () => ({
        identity: 'ready',
        database: 'unknown',
      }),
    } as unknown as CustomerManagedRuntimeAdapter;
    const runtime = await composeApiRuntime(productionConfiguration(), {
      importer: async () => ({
        createCustomerManagedRuntimeAdapter: async () => malformed,
      }),
      identityRuntimeFactory: () => createIdentityRuntime(sessionApi),
      clock: () => new Date('2026-07-23T10:00:00.000Z'),
      createRequestId: () => REQUEST_ID,
    });

    expect((await runtime.app.request('/readyz')).status).toBe(503);
  });

  it('rejects an invalid adapter export instead of installing production mocks', async () => {
    await expect(
      composeApiRuntime(productionConfiguration(), {
        importer: async () => ({ default: { mock: true } }),
      }),
    ).rejects.toMatchObject({
      name: 'ProductionCompositionError',
      code: 'INVALID_CUSTOMER_RUNTIME_ADAPTER',
    });
  });

  it('rejects an identity lifecycle boundary without one-time verification or recent-auth proof', async () => {
    const { adapter } = createCustomerAdapter();
    const incompleteLifecycle = {
      authenticate: vi.fn(async () => undefined),
    } as unknown as IdentityLifecycleService;

    await expect(
      composeApiRuntime(productionConfiguration(), {
        importer: async () => ({
          createCustomerManagedRuntimeAdapter: async () => ({
            ...adapter,
            identityLifecycleService: incompleteLifecycle,
          }),
        }),
      }),
    ).rejects.toMatchObject({
      name: 'ProductionCompositionError',
      code: 'INVALID_CUSTOMER_RUNTIME_ADAPTER',
    });
  });

  it('mounts the real Better Auth handler surface', async () => {
    const { adapter, sessionApi } = createCustomerAdapter();
    const authHandler = vi.fn(async (request: Request) => {
      void request;
      return new Response(null, { status: 204 });
    });
    const runtime = await composeApiRuntime(productionConfiguration(), {
      importer: async () => ({
        createCustomerManagedRuntimeAdapter: async () => adapter,
      }),
      identityRuntimeFactory: vi.fn(() => ({
        api: sessionApi,
        handler: authHandler,
      })),
      clock: () => new Date('2026-07-23T10:00:00.000Z'),
      createRequestId: () => REQUEST_ID,
    });

    const response = await runtime.app.request(
      '/api/auth/get-session',
    );

    expect(response.status).toBe(204);
    expect(authHandler).toHaveBeenCalledOnce();
    expect(authHandler.mock.calls[0]?.[0]).toBeInstanceOf(Request);
  });

  it('composes the customer one-time email verification completion and rejects replay', async () => {
    const { adapter, sessionApi } = createCustomerAdapter();
    const completeEmailVerification = vi.fn(async () => ({
      status: 'verified' as const,
      redirectTo: '/account/security',
    }));
    const runtime = await composeApiRuntime(productionConfiguration(), {
      importer: async () => ({
        createCustomerManagedRuntimeAdapter: async () => ({
          ...adapter,
          identityLifecycleService: {
            ...adapter.identityLifecycleService,
            completeEmailVerification,
          },
        }),
      }),
      identityRuntimeFactory: () => createIdentityRuntime(sessionApi),
      clock: () => new Date('2026-07-23T10:00:00.000Z'),
      createRequestId: () => REQUEST_ID,
    });
    const path =
      '/v1/auth/email-verification/complete?token=opaque-single-use-token';

    const first = await runtime.app.request(path);
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toBe('/account/security');

    completeEmailVerification.mockRejectedValueOnce(
      new IdentityLifecycleError('VERIFICATION_TOKEN_INVALID'),
    );
    const replay = await runtime.app.request(path);
    expect(replay.status).toBe(400);
    expect(JSON.stringify(await replay.json())).not.toContain(
      'opaque-single-use-token',
    );
  });
});

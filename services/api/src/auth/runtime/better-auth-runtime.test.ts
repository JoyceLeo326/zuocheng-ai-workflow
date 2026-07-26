import { describe, expect, it, vi } from 'vitest';
import type { BetterAuthOptions } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import {
  IdentityRuntimeConfigurationError,
  createBetterAuthRuntime,
  type CustomerManagedIdentityRuntimeConfig,
} from './better-auth-runtime.js';

const USER_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a2';
const CURRENT_SECRET = 'c'.repeat(48);
const PREVIOUS_SECRET = 'p'.repeat(48);

function customerIdentityConfig(): CustomerManagedIdentityRuntimeConfig {
  return {
    kind: 'customer-managed-identity',
    publicConfig: {
      baseURL: 'https://api.example.edu',
      trustedOrigins: [
        'https://api.example.edu',
        'https://student.example.edu',
      ],
      passkey: {
        rpId: 'example.edu',
        rpName: '做成',
      },
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
        { version: 2, value: CURRENT_SECRET },
        { version: 1, value: PREVIOUS_SECRET },
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

function createFactory() {
  const handler = vi.fn(async () => new Response('auth-handler'));
  const getSession = vi.fn(async () => null);
  const factory = vi.fn(
    (configuration: BetterAuthOptions) => {
      void configuration;
      return {
        handler,
        api: { getSession },
      } as const;
    },
  );
  return { factory, getSession, handler };
}

describe('Better Auth production runtime', () => {
  it('creates a real Better Auth server handler backed by the supplied adapter', async () => {
    const source = customerIdentityConfig();
    const config: CustomerManagedIdentityRuntimeConfig = {
      ...source,
      database: {
        ...source.database,
        adapter: memoryAdapter({
          user: [],
          session: [],
          account: [],
          verification: [],
          passkey: [],
          rateLimit: [],
        }),
      },
    };

    const runtime = createBetterAuthRuntime(config);
    const response = await runtime.handler(
      new Request('https://api.example.edu/api/auth/get-session', {
        headers: { Origin: 'https://student.example.edu' },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBeNull();
  });

  it('assembles the database-backed secure runtime from customer boundaries', () => {
    const config = customerIdentityConfig();
    const { factory, getSession, handler } = createFactory();

    const runtime = createBetterAuthRuntime(config, { factory });

    expect(runtime).toEqual({ api: { getSession }, handler });
    expect(factory).toHaveBeenCalledOnce();
    const options = factory.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      appName: '做成',
      baseURL: 'https://api.example.edu',
      basePath: '/api/auth',
      database: config.database.adapter,
      secrets: config.secrets.values,
      trustedOrigins: config.publicConfig.trustedOrigins,
      emailAndPassword: {
        enabled: true,
        autoSignIn: false,
        requireEmailVerification: true,
        revokeSessionsOnPasswordReset: true,
      },
      emailVerification: {
        sendOnSignUp: true,
        sendOnSignIn: true,
        autoSignInAfterVerification: false,
      },
      session: {
        expiresIn: 604_800,
        updateAge: 86_400,
        freshAge: 600,
        storeSessionInDatabase: true,
        preserveSessionInDatabase: false,
        cookieCache: { enabled: false },
        additionalFields: {
          activeTenantId: {
            type: 'string',
            required: false,
            input: false,
            returned: true,
          },
        },
      },
      user: {
        additionalFields: {
          accountStatus: {
            type: ['active', 'suspended', 'deletion_pending', 'deleted'],
            required: true,
            defaultValue: 'active',
            input: false,
            returned: true,
          },
        },
      },
      account: {
        encryptOAuthTokens: true,
        storeStateStrategy: 'database',
        storeAccountCookie: false,
        skipStateCookieCheck: false,
        updateAccountOnSignIn: true,
        accountLinking: {
          enabled: true,
          disableImplicitLinking: true,
          allowDifferentEmails: false,
          allowUnlinkingAll: false,
        },
      },
      verification: {
        storeIdentifier: 'hashed',
        storeInDatabase: true,
        disableCleanup: false,
      },
      advanced: {
        useSecureCookies: true,
        disableCSRFCheck: false,
        disableOriginCheck: false,
        crossSubDomainCookies: { enabled: false },
        cookies: {
          session_token: {
            name: '__Host-zuocheng.session_token',
            attributes: {
              httpOnly: true,
              secure: true,
              sameSite: 'lax',
              path: '/',
            },
          },
        },
      },
      telemetry: { enabled: false, debug: false },
      logger: { disabled: true },
    });
    expect(options).not.toHaveProperty('secret');
    expect(options?.advanced?.cookies?.session_token?.attributes).not
      .toHaveProperty('domain');

    expect(options?.socialProviders).toEqual({
      google: {
        clientId: 'customer-google-client',
        clientSecret: 'customer-google-secret',
        disableImplicitSignUp: true,
      },
      github: {
        clientId: 'customer-github-client',
        clientSecret: 'customer-github-secret',
        disableImplicitSignUp: true,
      },
    });

    const pluginOptions = (options?.plugins ?? []).map((plugin) => ({
      id: plugin.id,
      options: plugin.options,
    }));
    expect(pluginOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'passkey',
          options: expect.objectContaining({
            rpID: 'example.edu',
            rpName: '做成',
            origin: config.publicConfig.trustedOrigins,
            registration: { requireSession: true },
          }),
        }),
        expect.objectContaining({
          id: 'generic-oauth',
          options: {
            config: [
              expect.objectContaining({
                providerId: 'microsoft',
                clientId: 'customer-microsoft-client',
                clientSecret: 'customer-microsoft-secret',
                pkce: true,
                issuer:
                  'https://login.microsoftonline.com/3f2504e0-4f89-41d3-9a0c-0305e82c3301/v2.0',
                requireIssuerValidation: true,
              }),
            ],
          },
        }),
      ]),
    );
  });

  it('delegates verification and password-reset delivery without exposing raw tokens', async () => {
    const config = customerIdentityConfig();
    const { factory } = createFactory();
    createBetterAuthRuntime(config, { factory });
    const options = factory.mock.calls[0]?.[0];

    await options?.emailVerification?.sendVerificationEmail?.({
      user: {
        id: USER_ID,
        email: 'student@example.edu',
        emailVerified: false,
        name: 'Student',
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      url: 'https://api.example.edu/verify?token=opaque',
      token: 'raw-verification-token',
    });
    await options?.emailAndPassword?.sendResetPassword?.({
      user: {
        id: USER_ID,
        email: 'student@example.edu',
        emailVerified: true,
        name: 'Student',
        image: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      url: 'https://api.example.edu/reset?token=opaque',
      token: 'raw-reset-token',
    });

    expect(config.mailer.sendVerificationEmail).toHaveBeenCalledWith({
      userId: USER_ID,
      email: 'student@example.edu',
      url: 'https://api.example.edu/verify?token=opaque',
    });
    expect(config.mailer.sendPasswordResetEmail).toHaveBeenCalledWith({
      userId: USER_ID,
      email: 'student@example.edu',
      url: 'https://api.example.edu/reset?token=opaque',
    });
  });

  it.each([
    ['undefined', undefined],
    ['unknown status', { status: 'unknown', deliveryId: 'not-sent' }],
  ])(
    'fails closed when customer email delivery returns %s',
    async (_reason, deliveryResult) => {
      const source = customerIdentityConfig();
      const config: CustomerManagedIdentityRuntimeConfig = {
        ...source,
        mailer: {
          ...source.mailer,
          sendVerificationEmail: vi.fn(
            async () => deliveryResult as never,
          ),
        },
      };
      const { factory } = createFactory();
      createBetterAuthRuntime(config, { factory });
      const sendVerificationEmail =
        factory.mock.calls[0]?.[0].emailVerification
          ?.sendVerificationEmail;

      await expect(
        sendVerificationEmail?.({
          user: {
            id: USER_ID,
            email: 'student@example.edu',
            emailVerified: false,
            name: 'Student',
            image: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          url: 'https://api.example.edu/verify?token=opaque',
          token: 'raw-verification-token',
        }),
      ).rejects.toThrow(
        'Customer identity email delivery was not confirmed',
      );
    },
  );

  it('fails closed when password-reset delivery is not confirmed', async () => {
    const source = customerIdentityConfig();
    const config: CustomerManagedIdentityRuntimeConfig = {
      ...source,
      mailer: {
        ...source.mailer,
        sendPasswordResetEmail: vi.fn(
          async () => undefined as never,
        ),
      },
    };
    const { factory } = createFactory();
    createBetterAuthRuntime(config, { factory });
    const sendResetPassword =
      factory.mock.calls[0]?.[0].emailAndPassword
        ?.sendResetPassword;

    await expect(
      sendResetPassword?.({
        user: {
          id: USER_ID,
          email: 'student@example.edu',
          emailVerified: true,
          name: 'Student',
          image: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        url: 'https://api.example.edu/reset?token=opaque',
        token: 'raw-reset-token',
      }),
    ).rejects.toThrow(
      'Customer identity email delivery was not confirmed',
    );
  });

  it.each([
    {
      reason: 'missing database adapter',
      mutate: (config: Record<string, unknown>) => {
        config.database = undefined;
      },
    },
    {
      reason: 'missing email delivery',
      mutate: (config: Record<string, unknown>) => {
        config.mailer = undefined;
      },
    },
    {
      reason: 'missing OAuth provider',
      mutate: (config: Record<string, unknown>) => {
        const providers = config.providers as Record<string, unknown>;
        delete providers.google;
      },
    },
    {
      reason: 'a short rotation secret',
      mutate: (config: Record<string, unknown>) => {
        const secrets = config.secrets as {
          values: Array<{ version: number; value: string }>;
        };
        secrets.values[0] = { version: 2, value: 'test-secret' };
      },
    },
    {
      reason: 'a non-HTTPS or untrusted origin',
      mutate: (config: Record<string, unknown>) => {
        const publicConfig = config.publicConfig as Record<string, unknown>;
        publicConfig.baseURL = 'http://localhost:3000';
      },
    },
  ])('fails closed before factory invocation for $reason', ({ mutate }) => {
    const config = customerIdentityConfig() as unknown as Record<
      string,
      unknown
    >;
    mutate(config);
    const { factory } = createFactory();

    expect(() =>
      createBetterAuthRuntime(
        config as unknown as CustomerManagedIdentityRuntimeConfig,
        { factory },
      ),
    ).toThrow(IdentityRuntimeConfigurationError);
    expect(factory).not.toHaveBeenCalled();
  });

  it('never includes customer secrets in validation errors', () => {
    const source = customerIdentityConfig();
    const config = {
      ...source,
      providers: {
        ...source.providers,
        github: {
          clientId: '',
          clientSecret: 'leak-marker',
        },
      },
    };

    expect(() => createBetterAuthRuntime(config)).toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('leak-marker'),
      }),
    );
  });
});

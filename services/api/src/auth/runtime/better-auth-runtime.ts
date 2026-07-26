import {
  parseIdentityProviderConfiguration,
  type IdentityProviderConfiguration,
} from '@zuocheng/config';
import { passkey } from '@better-auth/passkey';
import {
  betterAuth,
  type BetterAuthOptions,
} from 'better-auth';
import {
  genericOAuth,
  microsoftEntraId,
  type GenericOAuthConfig,
} from 'better-auth/plugins/generic-oauth';
import type { BetterAuthSessionApi } from '../better-auth-session-verifier.js';

const SESSION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;
const SESSION_ROTATION_AGE_SECONDS = 24 * 60 * 60;
const RECENT_AUTH_AGE_SECONDS = 10 * 60;
const VERIFICATION_EXPIRES_IN_SECONDS = 60 * 60;
const RESET_EXPIRES_IN_SECONDS = 60 * 60;
const MINIMUM_SECRET_BYTES = 32;
const MINIMUM_OAUTH_CLIENT_ID_BYTES = 8;
const MINIMUM_OAUTH_CLIENT_SECRET_BYTES = 20;
const MINIMUM_DISTINCT_SECRET_CHARACTERS = 8;
const MAXIMUM_ROTATION_KEYS = 8;
const MICROSOFT_TENANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type BetterAuthDatabase = NonNullable<BetterAuthOptions['database']>;

export type CustomerSecretRotation = Readonly<{
  kind: 'customer-managed-secret-rotation';
  values: readonly Readonly<{
    version: number;
    value: string;
  }>[];
}>;

export type CustomerEmailDelivery = Readonly<{
  kind: 'customer-managed-email-delivery';
  sendVerificationEmail(input: Readonly<{
    userId: string;
    email: string;
    url: string;
  }>): Promise<CustomerEmailDeliveryReceipt>;
  sendPasswordResetEmail(input: Readonly<{
    userId: string;
    email: string;
    url: string;
  }>): Promise<CustomerEmailDeliveryReceipt>;
}>;

export type CustomerEmailDeliveryReceipt = Readonly<{
  status: 'sent';
  deliveryId: string;
}>;

type OAuthClientCredentials = Readonly<{
  clientId: string;
  clientSecret: string;
}>;

export type CustomerManagedIdentityRuntimeConfig = Readonly<{
  kind: 'customer-managed-identity';
  publicConfig: IdentityProviderConfiguration;
  database: Readonly<{
    kind: 'customer-managed-better-auth-database';
    adapter: BetterAuthDatabase;
    capabilities: Readonly<{
      profile: 'better-auth-1.6.25';
      databaseGeneratedIds: 'uuidv7';
      sessionStorage: 'database';
      verificationIdentifiers: 'sha256-base64url-43';
      verificationConsume: 'atomic';
      oauthTokenStorage:
        'better-auth-encrypted-customer-aad-envelope';
      oauthTokenEnvelope:
        '$ba$<positive-key-version>$<lowercase-even-hex>';
      oauthTokenKeyVersion: 'positive-integer';
      oauthTokenAadBinding: 'purpose-provider-user-tenant';
      passkeyStorage: 'public-key-only';
    }>;
  }>;
  secrets: CustomerSecretRotation;
  mailer: CustomerEmailDelivery;
  providers: Readonly<{
    google: OAuthClientCredentials;
    github: OAuthClientCredentials;
    microsoft: OAuthClientCredentials &
      Readonly<{
        tenantId: string;
      }>;
  }>;
}>;

export type BetterAuthRuntime = Readonly<{
  api: BetterAuthSessionApi;
  handler: (request: Request) => Promise<Response>;
}>;

type BetterAuthFactoryResult = Readonly<{
  api: BetterAuthSessionApi;
  handler: (request: Request) => Promise<Response>;
}>;

type CreateBetterAuthRuntimeOptions = Readonly<{
  factory?: (options: BetterAuthOptions) => BetterAuthFactoryResult;
}>;

export type IdentityRuntimeConfigurationErrorCode =
  | 'CUSTOMER_IDENTITY_ADAPTER_REQUIRED'
  | 'CUSTOMER_DATABASE_REQUIRED'
  | 'CUSTOMER_SECRET_ROTATION_REQUIRED'
  | 'CUSTOMER_EMAIL_DELIVERY_REQUIRED'
  | 'CUSTOMER_OAUTH_PROVIDER_REQUIRED'
  | 'CUSTOMER_PUBLIC_CONFIGURATION_INVALID';

export class IdentityRuntimeConfigurationError extends Error {
  constructor(readonly code: IdentityRuntimeConfigurationErrorCode) {
    super(`Customer identity runtime is unavailable: ${code}`);
    this.name = 'IdentityRuntimeConfigurationError';
  }
}

export class IdentityEmailDeliveryError extends Error {
  constructor() {
    super('Customer identity email delivery was not confirmed');
    this.name = 'IdentityEmailDeliveryError';
  }
}

export function createBetterAuthRuntime(
  input: CustomerManagedIdentityRuntimeConfig,
  runtimeOptions: CreateBetterAuthRuntimeOptions = {},
): BetterAuthRuntime {
  const config = parseCustomerIdentityRuntime(input);
  const microsoft = createMicrosoftProvider(config);
  const options = createBetterAuthOptions(config, microsoft);
  const auth =
    runtimeOptions.factory === undefined
      ? betterAuth(options)
      : runtimeOptions.factory(options);

  return {
    api: auth.api,
    handler: auth.handler,
  };
}

export function isCustomerManagedIdentityRuntimeConfig(
  input: unknown,
): input is CustomerManagedIdentityRuntimeConfig {
  try {
    parseCustomerIdentityRuntime(input);
    return true;
  } catch {
    return false;
  }
}

function createBetterAuthOptions(
  config: CustomerManagedIdentityRuntimeConfig,
  microsoft: GenericOAuthConfig,
): BetterAuthOptions {
  return {
    appName: '做成',
    baseURL: config.publicConfig.baseURL,
    basePath: '/api/auth',
    database: config.database.adapter,
    secrets: config.secrets.values.map(({ version, value }) => ({
      version,
      value,
    })),
    trustedOrigins: [...config.publicConfig.trustedOrigins],
    emailAndPassword: {
      enabled: true,
      disableSignUp: false,
      autoSignIn: false,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      resetPasswordTokenExpiresIn: RESET_EXPIRES_IN_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        const receipt =
          await config.mailer.sendPasswordResetEmail({
          userId: user.id,
          email: user.email,
          url,
          });
        assertEmailDeliveryReceipt(receipt);
      },
    },
    emailVerification: {
      expiresIn: VERIFICATION_EXPIRES_IN_SECONDS,
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        const receipt =
          await config.mailer.sendVerificationEmail({
          userId: user.id,
          email: user.email,
          url,
          });
        assertEmailDeliveryReceipt(receipt);
      },
    },
    socialProviders: {
      google: {
        clientId: config.providers.google.clientId,
        clientSecret: config.providers.google.clientSecret,
        disableImplicitSignUp: true,
      },
      github: {
        clientId: config.providers.github.clientId,
        clientSecret: config.providers.github.clientSecret,
        disableImplicitSignUp: true,
      },
    },
    user: {
      additionalFields: {
        accountStatus: {
          type: [
            'active',
            'suspended',
            'deletion_pending',
            'deleted',
          ],
          required: true,
          defaultValue: 'active',
          input: false,
          returned: true,
        },
      },
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_ROTATION_AGE_SECONDS,
      freshAge: RECENT_AUTH_AGE_SECONDS,
      disableSessionRefresh: false,
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
    account: {
      updateAccountOnSignIn: true,
      // Better Auth performs this inner encryption before it calls the
      // database adapter. The adapter capability handshake above requires a
      // second customer-managed envelope with key version and tenant-bound AAD.
      encryptOAuthTokens: true,
      storeStateStrategy: 'database',
      storeAccountCookie: false,
      skipStateCookieCheck: false,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
        updateUserInfoOnLink: false,
      },
    },
    verification: {
      storeIdentifier: 'hashed',
      storeInDatabase: true,
      disableCleanup: false,
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 5 },
      },
    },
    advanced: {
      useSecureCookies: true,
      disableCSRFCheck: false,
      disableOriginCheck: false,
      crossSubDomainCookies: { enabled: false },
      database: { generateId: false },
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
    plugins: [
      passkey({
        rpID: config.publicConfig.passkey.rpId,
        rpName: config.publicConfig.passkey.rpName,
        origin: [...config.publicConfig.trustedOrigins],
        registration: { requireSession: true },
        advanced: {
          webAuthnChallengeCookie: '__Host-zuocheng.passkey_challenge',
        },
      }),
      genericOAuth({ config: [microsoft] }),
    ],
    logger: { disabled: true },
    telemetry: { enabled: false, debug: false },
  };
}

function createMicrosoftProvider(
  config: CustomerManagedIdentityRuntimeConfig,
): GenericOAuthConfig {
  const provider = microsoftEntraId({
    clientId: config.providers.microsoft.clientId,
    clientSecret: config.providers.microsoft.clientSecret,
    tenantId: config.providers.microsoft.tenantId,
    pkce: true,
    disableImplicitSignUp: true,
  });
  return {
    ...provider,
    providerId: 'microsoft',
    issuer: `https://login.microsoftonline.com/${config.providers.microsoft.tenantId}/v2.0`,
    pkce: true,
    requireIssuerValidation: true,
  };
}

function parseCustomerIdentityRuntime(
  input: unknown,
): CustomerManagedIdentityRuntimeConfig {
  if (
    !isRecord(input) ||
    input.kind !== 'customer-managed-identity' ||
    !hasExactKeys(input, [
      'kind',
      'publicConfig',
      'database',
      'secrets',
      'mailer',
      'providers',
    ])
  ) {
    throw new IdentityRuntimeConfigurationError(
      'CUSTOMER_IDENTITY_ADAPTER_REQUIRED',
    );
  }

  let publicConfig: IdentityProviderConfiguration;
  try {
    publicConfig = parseIdentityProviderConfiguration(input.publicConfig);
  } catch {
    throw new IdentityRuntimeConfigurationError(
      'CUSTOMER_PUBLIC_CONFIGURATION_INVALID',
    );
  }

  const database = parseDatabase(input.database);
  const secrets = parseSecrets(input.secrets);
  const mailer = parseMailer(input.mailer);
  const providers = parseProviders(input.providers);

  return {
    kind: 'customer-managed-identity',
    publicConfig,
    database,
    secrets,
    mailer,
    providers,
  };
}

function parseDatabase(
  input: unknown,
): CustomerManagedIdentityRuntimeConfig['database'] {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['kind', 'adapter', 'capabilities']) ||
    input.kind !== 'customer-managed-better-auth-database' ||
    input.adapter === null ||
    (typeof input.adapter !== 'object' &&
      typeof input.adapter !== 'function') ||
    !hasDatabaseCapabilities(input.capabilities)
  ) {
    throw new IdentityRuntimeConfigurationError(
      'CUSTOMER_DATABASE_REQUIRED',
    );
  }
  return input as CustomerManagedIdentityRuntimeConfig['database'];
}

function hasDatabaseCapabilities(input: unknown): boolean {
  return (
    isRecord(input) &&
    hasExactKeys(input, [
      'profile',
      'databaseGeneratedIds',
      'sessionStorage',
      'verificationIdentifiers',
      'verificationConsume',
      'oauthTokenStorage',
      'oauthTokenEnvelope',
      'oauthTokenKeyVersion',
      'oauthTokenAadBinding',
      'passkeyStorage',
    ]) &&
    input.profile === 'better-auth-1.6.25' &&
    input.databaseGeneratedIds === 'uuidv7' &&
    input.sessionStorage === 'database' &&
    input.verificationIdentifiers === 'sha256-base64url-43' &&
    input.verificationConsume === 'atomic' &&
    input.oauthTokenStorage ===
      'better-auth-encrypted-customer-aad-envelope' &&
    input.oauthTokenEnvelope ===
      '$ba$<positive-key-version>$<lowercase-even-hex>' &&
    input.oauthTokenKeyVersion === 'positive-integer' &&
    input.oauthTokenAadBinding ===
      'purpose-provider-user-tenant' &&
    input.passkeyStorage === 'public-key-only'
  );
}

function assertEmailDeliveryReceipt(
  input: unknown,
): asserts input is CustomerEmailDeliveryReceipt {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['status', 'deliveryId']) ||
    input.status !== 'sent' ||
    typeof input.deliveryId !== 'string' ||
    input.deliveryId.trim().length === 0 ||
    input.deliveryId.length > 1_024
  ) {
    throw new IdentityEmailDeliveryError();
  }
}

function parseSecrets(input: unknown): CustomerSecretRotation {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['kind', 'values']) ||
    input.kind !== 'customer-managed-secret-rotation' ||
    !Array.isArray(input.values) ||
    input.values.length === 0 ||
    input.values.length > MAXIMUM_ROTATION_KEYS
  ) {
    throw new IdentityRuntimeConfigurationError(
      'CUSTOMER_SECRET_ROTATION_REQUIRED',
    );
  }

  let previousVersion = Number.POSITIVE_INFINITY;
  const seenValues = new Set<string>();
  const values: Array<{ version: number; value: string }> = [];
  for (const candidate of input.values) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['version', 'value']) ||
      !Number.isSafeInteger(candidate.version) ||
      (candidate.version as number) <= 0 ||
      (candidate.version as number) >= previousVersion ||
      typeof candidate.value !== 'string' ||
      !isStrongSecret(candidate.value, MINIMUM_SECRET_BYTES) ||
      seenValues.has(candidate.value)
    ) {
      throw new IdentityRuntimeConfigurationError(
        'CUSTOMER_SECRET_ROTATION_REQUIRED',
      );
    }
    previousVersion = candidate.version as number;
    seenValues.add(candidate.value);
    values.push({
      version: candidate.version as number,
      value: candidate.value,
    });
  }

  return {
    kind: 'customer-managed-secret-rotation',
    values,
  };
}

function parseMailer(input: unknown): CustomerEmailDelivery {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'kind',
      'sendVerificationEmail',
      'sendPasswordResetEmail',
    ]) ||
    input.kind !== 'customer-managed-email-delivery' ||
    typeof input.sendVerificationEmail !== 'function' ||
    typeof input.sendPasswordResetEmail !== 'function'
  ) {
    throw new IdentityRuntimeConfigurationError(
      'CUSTOMER_EMAIL_DELIVERY_REQUIRED',
    );
  }
  return input as unknown as CustomerEmailDelivery;
}

function parseProviders(
  input: unknown,
): CustomerManagedIdentityRuntimeConfig['providers'] {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['google', 'github', 'microsoft'])
  ) {
    throw new IdentityRuntimeConfigurationError(
      'CUSTOMER_OAUTH_PROVIDER_REQUIRED',
    );
  }

  const google = parseProvider(input.google);
  const github = parseProvider(input.github);
  const microsoft = parseProvider(input.microsoft, true);
  return {
    google,
    github,
    microsoft: microsoft as OAuthClientCredentials & {
      tenantId: string;
    },
  };
}

function parseProvider(
  input: unknown,
  microsoft = false,
): OAuthClientCredentials | (OAuthClientCredentials & { tenantId: string }) {
  const keys = microsoft
    ? ['clientId', 'clientSecret', 'tenantId']
    : ['clientId', 'clientSecret'];
  if (
    !isRecord(input) ||
    !hasExactKeys(input, keys) ||
    !isValidClientId(input.clientId) ||
    !isStrongSecret(
      input.clientSecret,
      MINIMUM_OAUTH_CLIENT_SECRET_BYTES,
    ) ||
    (microsoft &&
      (typeof input.tenantId !== 'string' ||
        !MICROSOFT_TENANT_ID.test(input.tenantId)))
  ) {
    throw new IdentityRuntimeConfigurationError(
      'CUSTOMER_OAUTH_PROVIDER_REQUIRED',
    );
  }
  return microsoft
    ? {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        tenantId: input.tenantId as string,
      }
    : {
        clientId: input.clientId,
        clientSecret: input.clientSecret,
      };
}

function isValidClientId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    Buffer.byteLength(value, 'utf8') >= MINIMUM_OAUTH_CLIENT_ID_BYTES &&
    value.length <= 512 &&
    !containsObviousPlaceholder(value)
  );
}

function isStrongSecret(
  value: unknown,
  minimumBytes: number,
): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    Buffer.byteLength(value, 'utf8') >= minimumBytes &&
    value.length <= 4_096 &&
    new Set(value).size >= MINIMUM_DISTINCT_SECRET_CHARACTERS &&
    !containsObviousPlaceholder(value)
  );
}

function containsObviousPlaceholder(value: string): boolean {
  const normalized = value.toLowerCase();
  const compact = normalized.replace(/[^a-z0-9]+/gu, '');
  const tokens = normalized
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0);
  const placeholders = new Set([
    'changeme',
    'default',
    'dummy',
    'example',
    'placeholder',
    'replace',
    'sample',
    'test',
    'todo',
  ]);
  return (
    /^x+$/u.test(compact) ||
    compact === 'changeme' ||
    compact === 'replaceme' ||
    tokens.some((token) => placeholders.has(token)) ||
    tokens.some(
      (token, index) =>
        (token === 'change' || token === 'replace') &&
        tokens[index + 1] === 'me',
    ) ||
    /^(?:your|my)(?:client|oauth|provider)?(?:id|secret|key)$/u.test(
      compact,
    )
  );
}

function hasExactKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(input);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(input, key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

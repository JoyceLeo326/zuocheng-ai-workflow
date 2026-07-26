import { UUIDv7Schema, type UUIDv7 } from '@zuocheng/contracts';
import type { Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { PRODUCTION_SESSION_COOKIE } from '../better-auth-session-verifier.js';
import { parseRequiredIdempotencyKey } from '../../http/preconditions.js';
import {
  HttpRequestError,
  readBoundedJsonBody,
} from '../../http/request-body.js';
import {
  IdentityLifecycleError,
  OAUTH_PROVIDERS,
  type IdentityHttpSecurityPort,
  type IdentityLifecycleService,
  type IdentityPrincipal,
  type IdentityRateLimiter,
  type IdentityRateLimitOperation,
  type OAuthProvider,
  type SessionEstablishment,
} from './identity-lifecycle-service.js';

type IdentityRouteEnvironment = {
  Variables: {
    requestId: string;
  };
};

export type IdentityRouteDependencies = Readonly<{
  service: IdentityLifecycleService;
  security: IdentityHttpSecurityPort;
  rateLimiter: IdentityRateLimiter;
}>;

const EmailSchema = z.email().max(320);
const PasswordSchema = z.string().min(12).max(256);
const IdentifierSchema = z.string().trim().min(1).max(320);
const DisplayNameSchema = z.string().trim().min(1).max(120);
const OpaqueTokenSchema = z.string().min(8).max(4_096);
const EmptyBodySchema = z.strictObject({});
const WebAuthnResponseSchema = z
  .unknown()
  .refine(
    (value) =>
      value !== null && typeof value === 'object' && !Array.isArray(value),
  );
const ReturnToSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(isSafeLocalPath);
const RegisterPasswordSchema = z.strictObject({
  email: EmailSchema,
  password: PasswordSchema,
  displayName: DisplayNameSchema,
});
const LoginPasswordSchema = z.strictObject({
  identifier: IdentifierSchema,
  password: PasswordSchema,
});
const EmailVerificationSchema = z.strictObject({
  token: OpaqueTokenSchema,
});
const PasskeyRegistrationOptionsSchema = z.strictObject({
  displayName: DisplayNameSchema.optional(),
});
const PasskeyRegistrationVerifySchema = z.strictObject({
  challengeId: UUIDv7Schema,
  response: WebAuthnResponseSchema,
  displayName: DisplayNameSchema.optional(),
});
const PasskeyAuthenticationOptionsSchema = z.strictObject({
  identifier: IdentifierSchema.optional(),
});
const PasskeyAuthenticationVerifySchema = z.strictObject({
  challengeId: UUIDv7Schema,
  response: WebAuthnResponseSchema,
});
const OAuthStartSchema = z.strictObject({
  returnTo: ReturnToSchema,
});
const OAuthCallbackSchema = z.strictObject({
  code: OpaqueTokenSchema,
  state: OpaqueTokenSchema,
});
const PasswordRecoveryRequestSchema = z.strictObject({
  email: EmailSchema,
});
const PasswordRecoveryCompleteSchema = z.strictObject({
  token: OpaqueTokenSchema,
  newPassword: PasswordSchema,
});
const RecentAuthPasswordSchema = z.strictObject({
  password: PasswordSchema,
});
const AccountDeletionRequestSchema = z.strictObject({
  recentAuthToken: OpaqueTokenSchema,
});
const AccountDeletionConfirmSchema = z.strictObject({
  deletionRequestId: UUIDv7Schema,
  confirmationToken: OpaqueTokenSchema,
});

export function registerIdentityRoutes(
  app: Hono<IdentityRouteEnvironment>,
  dependencies: IdentityRouteDependencies,
): void {
  const privateIdentityResponse: MiddlewareHandler<IdentityRouteEnvironment> =
    async (routeContext, next) => {
      try {
        await next();
      } finally {
        routeContext.header('Cache-Control', 'private, no-store');
        routeContext.header('Pragma', 'no-cache');
        routeContext.header('Referrer-Policy', 'no-referrer');
        routeContext.header('Vary', 'Cookie, Authorization, Origin');
      }
    };

  app.use('/v1/auth', privateIdentityResponse);
  app.use('/v1/auth/*', privateIdentityResponse);
  app.use('/v1/account', privateIdentityResponse);
  app.use('/v1/account/*', privateIdentityResponse);

  app.post('/v1/auth/password/register', async (routeContext) => {
    const mutation = await prepareMutation(
      routeContext.req.raw,
      dependencies,
      'password-register',
      false,
    );
    const body = await parseJsonBody(
      routeContext.req.raw,
      RegisterPasswordSchema,
    );
    const result = await invokeIdentity(() =>
      dependencies.service.registerPassword(body, mutation.idempotencyKey),
    );
    return routeContext.json(result, 202);
  });

  app.post('/v1/auth/password/login', async (routeContext) => {
    const mutation = await prepareMutation(
      routeContext.req.raw,
      dependencies,
      'password-login',
      false,
    );
    const body = await parseJsonBody(
      routeContext.req.raw,
      LoginPasswordSchema,
    );
    const result = await invokeIdentity(() =>
      dependencies.service.loginPassword(body, mutation.idempotencyKey),
    );
    setSessionCookie(routeContext, result);
    return routeContext.json({ session: result.session });
  });

  app.get(
    '/v1/auth/email-verification/complete',
    async (routeContext) => {
      await enforceRateLimit(
        routeContext.req.raw,
        dependencies.rateLimiter,
        'email-verification-complete',
      );
      const query = parseUnknown(
        { token: routeContext.req.query('token') },
        EmailVerificationSchema,
      );
      const result = await invokeIdentity(() =>
        dependencies.service.completeEmailVerification(query),
      );
      if (!isSafeLocalPath(result.redirectTo)) {
        throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
      }
      return routeContext.redirect(result.redirectTo, 303);
    },
  );

  app.post(
    '/v1/auth/passkeys/registration/options',
    async (routeContext) => {
      const mutation = await prepareMutation(
        routeContext.req.raw,
        dependencies,
        'passkey-registration-options',
        true,
      );
      const body = await parseJsonBody(
        routeContext.req.raw,
        PasskeyRegistrationOptionsSchema,
      );
      const result = await invokeIdentity(() =>
        dependencies.service.createPasskeyRegistrationOptions(
          requiredPrincipal(mutation),
          body,
          mutation.idempotencyKey,
        ),
      );
      return routeContext.json(result);
    },
  );

  app.post(
    '/v1/auth/passkeys/registration/verify',
    async (routeContext) => {
      const mutation = await prepareMutation(
        routeContext.req.raw,
        dependencies,
        'passkey-registration-verify',
        true,
      );
      const body = await parseJsonBody(
        routeContext.req.raw,
        PasskeyRegistrationVerifySchema,
      );
      const result = await invokeIdentity(() =>
        dependencies.service.verifyPasskeyRegistration(
          requiredPrincipal(mutation),
          body,
          mutation.idempotencyKey,
        ),
      );
      return routeContext.json(result, 201);
    },
  );

  app.post(
    '/v1/auth/passkeys/authentication/options',
    async (routeContext) => {
      const mutation = await prepareMutation(
        routeContext.req.raw,
        dependencies,
        'passkey-authentication-options',
        false,
      );
      const body = await parseJsonBody(
        routeContext.req.raw,
        PasskeyAuthenticationOptionsSchema,
      );
      const result = await invokeIdentity(() =>
        dependencies.service.createPasskeyAuthenticationOptions(
          body,
          mutation.idempotencyKey,
        ),
      );
      return routeContext.json(result);
    },
  );

  app.post(
    '/v1/auth/passkeys/authentication/verify',
    async (routeContext) => {
      const mutation = await prepareMutation(
        routeContext.req.raw,
        dependencies,
        'passkey-authentication-verify',
        false,
      );
      const body = await parseJsonBody(
        routeContext.req.raw,
        PasskeyAuthenticationVerifySchema,
      );
      const result = await invokeIdentity(() =>
        dependencies.service.verifyPasskeyAuthentication(
          body,
          mutation.idempotencyKey,
        ),
      );
      setSessionCookie(routeContext, result);
      return routeContext.json({ session: result.session });
    },
  );

  for (const provider of OAUTH_PROVIDERS) {
    registerOAuthProviderRoutes(app, dependencies, provider);
  }

  app.get('/v1/auth/session/current', async (routeContext) => {
    const principal = await authenticate(
      routeContext.req.raw,
      dependencies.service,
    );
    return routeContext.json(
      await invokeIdentity(() =>
        dependencies.service.getCurrentSession(principal),
      ),
    );
  });

  app.get('/v1/auth/sessions', async (routeContext) => {
    const principal = await authenticate(
      routeContext.req.raw,
      dependencies.service,
    );
    return routeContext.json({
      data: await invokeIdentity(() =>
        dependencies.service.listSessions(principal),
      ),
    });
  });

  app.get('/v1/auth/devices', async (routeContext) => {
    const principal = await authenticate(
      routeContext.req.raw,
      dependencies.service,
    );
    return routeContext.json({
      data: await invokeIdentity(() =>
        dependencies.service.listDevices(principal),
      ),
    });
  });

  app.delete('/v1/auth/sessions/:sessionId', async (routeContext) => {
    const mutation = await prepareMutation(
      routeContext.req.raw,
      dependencies,
      'session-revoke',
      true,
    );
    const sessionId = parseUuid(routeContext.req.param('sessionId'));
    const result = await invokeIdentity(() =>
      dependencies.service.revokeSession(
        requiredPrincipal(mutation),
        sessionId,
        mutation.idempotencyKey,
      ),
    );
    if (sessionId === requiredPrincipal(mutation).sessionId) {
      clearSessionCookie(routeContext);
    }
    return routeContext.json(result);
  });

  app.post('/v1/auth/sessions/revoke-others', async (routeContext) => {
    const mutation = await prepareMutation(
      routeContext.req.raw,
      dependencies,
      'session-revoke-others',
      true,
    );
    await parseJsonBody(routeContext.req.raw, EmptyBodySchema);
    return routeContext.json(
      await invokeIdentity(() =>
        dependencies.service.revokeOtherSessions(
          requiredPrincipal(mutation),
          mutation.idempotencyKey,
        ),
      ),
    );
  });

  app.post('/v1/auth/sessions/revoke-all', async (routeContext) => {
    const mutation = await prepareMutation(
      routeContext.req.raw,
      dependencies,
      'session-revoke-all',
      true,
    );
    await parseJsonBody(routeContext.req.raw, EmptyBodySchema);
    const result = await invokeIdentity(() =>
      dependencies.service.revokeAllSessions(
        requiredPrincipal(mutation),
        mutation.idempotencyKey,
      ),
    );
    clearSessionCookie(routeContext);
    return routeContext.json(result);
  });

  app.post('/v1/auth/logout', async (routeContext) => {
    const mutation = await prepareMutation(
      routeContext.req.raw,
      dependencies,
      'logout',
      true,
    );
    await parseJsonBody(routeContext.req.raw, EmptyBodySchema);
    await invokeIdentity(() =>
      dependencies.service.logout(
        requiredPrincipal(mutation),
        mutation.idempotencyKey,
      ),
    );
    clearSessionCookie(routeContext);
    return routeContext.body(null, 204);
  });

  app.post('/v1/auth/password-recovery/request', async (routeContext) => {
    const mutation = await prepareMutation(
      routeContext.req.raw,
      dependencies,
      'password-recovery-request',
      false,
    );
    const body = await parseJsonBody(
      routeContext.req.raw,
      PasswordRecoveryRequestSchema,
    );
    await invokeIdentity(() =>
      dependencies.service.requestPasswordRecovery(
        body,
        mutation.idempotencyKey,
      ),
    );
    return routeContext.json({ status: 'accepted' }, 202);
  });

  app.post('/v1/auth/password-recovery/complete', async (routeContext) => {
    const mutation = await prepareMutation(
      routeContext.req.raw,
      dependencies,
      'password-recovery-complete',
      false,
    );
    const body = await parseJsonBody(
      routeContext.req.raw,
      PasswordRecoveryCompleteSchema,
    );
    const result = await invokeIdentity(() =>
      dependencies.service.completePasswordRecovery(
        body,
        mutation.idempotencyKey,
      ),
    );
    clearSessionCookie(routeContext);
    return routeContext.json(result);
  });

  app.post('/v1/auth/recent-auth/password', async (routeContext) => {
    const mutation = await prepareMutation(
      routeContext.req.raw,
      dependencies,
      'recent-auth-password',
      true,
    );
    const body = await parseJsonBody(
      routeContext.req.raw,
      RecentAuthPasswordSchema,
    );
    return routeContext.json(
      await invokeIdentity(() =>
        dependencies.service.createRecentAuthProofWithPassword(
          requiredPrincipal(mutation),
          {
            password: body.password,
            purpose: 'account-deletion',
          },
          mutation.idempotencyKey,
        ),
      ),
    );
  });

  app.post('/v1/account/exports', async (routeContext) => {
    const mutation = await prepareMutation(
      routeContext.req.raw,
      dependencies,
      'account-export-request',
      true,
    );
    await parseJsonBody(routeContext.req.raw, EmptyBodySchema);
    const result = await invokeIdentity(() =>
      dependencies.service.requestAccountExport(
        requiredPrincipal(mutation),
        mutation.idempotencyKey,
      ),
    );
    return routeContext.json(result, 202, {
      Location: `/v1/account/exports/${result.id}`,
    });
  });

  app.get('/v1/account/exports/:exportId', async (routeContext) => {
    const principal = await authenticate(
      routeContext.req.raw,
      dependencies.service,
    );
    const exportId = parseUuid(routeContext.req.param('exportId'));
    return routeContext.json(
      await invokeIdentity(() =>
        dependencies.service.getAccountExport(principal, exportId),
      ),
    );
  });

  app.post('/v1/account/deletion', async (routeContext) => {
    const mutation = await prepareMutation(
      routeContext.req.raw,
      dependencies,
      'account-deletion-request',
      true,
    );
    const body = await parseJsonBody(
      routeContext.req.raw,
      AccountDeletionRequestSchema,
    );
    const result = await invokeIdentity(() =>
      dependencies.service.requestAccountDeletion(
        requiredPrincipal(mutation),
        body,
        mutation.idempotencyKey,
      ),
    );
    return routeContext.json(result, 202, {
      Location: '/v1/account/deletion',
    });
  });

  app.get('/v1/account/deletion', async (routeContext) => {
    const principal = await authenticate(
      routeContext.req.raw,
      dependencies.service,
    );
    return routeContext.json(
      await invokeIdentity(() =>
        dependencies.service.getAccountDeletion(principal),
      ),
    );
  });

  app.delete('/v1/account/deletion', async (routeContext) => {
    const mutation = await prepareMutation(
      routeContext.req.raw,
      dependencies,
      'account-deletion-cancel',
      true,
    );
    return routeContext.json(
      await invokeIdentity(() =>
        dependencies.service.cancelAccountDeletion(
          requiredPrincipal(mutation),
          mutation.idempotencyKey,
        ),
      ),
    );
  });

  app.post('/v1/account/deletion/confirm', async (routeContext) => {
    const mutation = await prepareMutation(
      routeContext.req.raw,
      dependencies,
      'account-deletion-confirm',
      true,
    );
    const body = await parseJsonBody(
      routeContext.req.raw,
      AccountDeletionConfirmSchema,
    );
    const result = await invokeIdentity(() =>
      dependencies.service.confirmAccountDeletion(
        requiredPrincipal(mutation),
        body,
        mutation.idempotencyKey,
      ),
    );
    clearSessionCookie(routeContext);
    return routeContext.json(result, 202);
  });
}

function registerOAuthProviderRoutes(
  app: Hono<IdentityRouteEnvironment>,
  dependencies: IdentityRouteDependencies,
  provider: OAuthProvider,
): void {
  app.post(`/v1/auth/oauth/${provider}/start`, async (routeContext) => {
    const mutation = await prepareMutation(
      routeContext.req.raw,
      dependencies,
      'oauth-start',
      false,
    );
    const body = await parseJsonBody(routeContext.req.raw, OAuthStartSchema);
    const result = await invokeIdentity(() =>
      dependencies.service.startOAuth(
        { provider, returnTo: body.returnTo },
        mutation.idempotencyKey,
      ),
    );
    if (!isSafeAuthorizationUrl(result.authorizationUrl)) {
      throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
    }
    return routeContext.json(result);
  });

  app.get(`/v1/auth/oauth/${provider}/callback`, async (routeContext) => {
    await enforceRateLimit(
      routeContext.req.raw,
      dependencies.rateLimiter,
      'oauth-callback',
    );
    const query = parseUnknown(
      {
        code: routeContext.req.query('code'),
        state: routeContext.req.query('state'),
      },
      OAuthCallbackSchema,
    );
    const result = await invokeIdentity(() =>
      dependencies.service.completeOAuth({ provider, ...query }),
    );
    if (!isSafeLocalPath(result.redirectTo)) {
      throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
    }
    setSessionCookie(routeContext, result);
    return routeContext.redirect(result.redirectTo, 303);
  });
}

type PreparedMutation = Readonly<{
  idempotencyKey: string;
  principal?: IdentityPrincipal;
}>;

async function prepareMutation(
  request: Request,
  dependencies: IdentityRouteDependencies,
  operation: IdentityRateLimitOperation,
  requiresAuthentication: boolean,
): Promise<PreparedMutation> {
  const principal = requiresAuthentication
    ? await authenticate(request, dependencies.service)
    : undefined;
  await enforceHttpSecurity(
    request,
    dependencies.security,
    operation,
    principal,
  );
  const idempotencyKey = parseRequiredIdempotencyKey(
    request.headers.get('idempotency-key') ?? undefined,
  );
  await enforceRateLimit(
    request,
    dependencies.rateLimiter,
    operation,
    principal,
  );
  return {
    idempotencyKey,
    ...(principal === undefined ? {} : { principal }),
  };
}

async function authenticate(
  request: Request,
  service: IdentityLifecycleService,
): Promise<IdentityPrincipal> {
  const cookie = request.headers.get('cookie');
  const authorization = request.headers.get('authorization');
  return invokeIdentity(() =>
    service.authenticate({
      ...(cookie === null ? {} : { cookie }),
      ...(authorization === null ? {} : { authorization }),
    }),
  );
}

async function enforceHttpSecurity(
  request: Request,
  security: IdentityHttpSecurityPort,
  operation: IdentityRateLimitOperation,
  principal?: IdentityPrincipal,
): Promise<void> {
  try {
    await security.enforce({
      operation,
      request,
      ...(principal === undefined ? {} : { principal }),
    });
  } catch (error) {
    if (error instanceof IdentityLifecycleError) {
      throw error;
    }
    throw new IdentityLifecycleError('SECURITY_CONTROL_UNAVAILABLE');
  }
}

async function enforceRateLimit(
  request: Request,
  rateLimiter: IdentityRateLimiter,
  operation: IdentityRateLimitOperation,
  principal?: IdentityPrincipal,
): Promise<void> {
  let decision: unknown;
  try {
    decision = await rateLimiter.consume({
      operation,
      request,
      ...(principal === undefined ? {} : { principal }),
    });
  } catch (error) {
    if (error instanceof IdentityLifecycleError) {
      throw error;
    }
    throw new IdentityLifecycleError('RATE_LIMIT_UNAVAILABLE');
  }
  if (
    decision === null ||
    typeof decision !== 'object' ||
    !('allowed' in decision) ||
    typeof decision.allowed !== 'boolean'
  ) {
    throw new IdentityLifecycleError('RATE_LIMIT_UNAVAILABLE');
  }
  if (!decision.allowed) {
    throw new IdentityLifecycleError('RATE_LIMITED');
  }
}

async function invokeIdentity<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof IdentityLifecycleError) {
      throw error;
    }
    throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
  }
}

async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  return parseUnknown(await readBoundedJsonBody(request), schema);
}

function parseUnknown<T>(value: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpRequestError(
      422,
      'VALIDATION_FAILED',
      'The request payload is invalid',
    );
  }
  return parsed.data;
}

function parseUuid(value: string): UUIDv7 {
  return parseUnknown(value, UUIDv7Schema);
}

function requiredPrincipal(mutation: PreparedMutation): IdentityPrincipal {
  if (mutation.principal === undefined) {
    throw new IdentityLifecycleError('AUTH_REQUIRED');
  }
  return mutation.principal;
}

function setSessionCookie(
  context: {
    header(name: string, value: string): void;
  },
  result: SessionEstablishment,
): void {
  if (
    result.sessionToken.length < 8 ||
    result.sessionToken.length > 2_048 ||
    !/^[!#$%&'*+\-.0-9A-Z^_`a-z|~/:=]+$/u.test(result.sessionToken)
  ) {
    throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
  }
  context.header(
    'Set-Cookie',
    `${PRODUCTION_SESSION_COOKIE.name}=${result.sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax`,
  );
}

function clearSessionCookie(context: {
  header(name: string, value: string): void;
}): void {
  context.header(
    'Set-Cookie',
    `${PRODUCTION_SESSION_COOKIE.name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  );
}

function isSafeLocalPath(value: string): boolean {
  return (
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !containsControlCharacter(value)
  );
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= 0x1f || codePoint === 0x7f)
    );
  });
}

function isSafeAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  } catch {
    return false;
  }
}

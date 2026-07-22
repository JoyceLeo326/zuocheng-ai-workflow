import { UUIDv7Schema, type UUIDv7 } from '@zuocheng/contracts';
import { z } from 'zod';
import { SessionVerificationUnavailableError } from './better-auth-session-verifier.js';

export type SessionVerificationInput = Readonly<{
  authorization?: string;
  cookie?: string;
}>;

export interface SessionVerifier {
  verify(input: SessionVerificationInput): Promise<unknown>;
}

export interface MembershipRepository {
  findActive(input: Readonly<{ tenantId: UUIDv7; userId: UUIDv7 }>): Promise<unknown>;
}

export type TenantSessionRequest = Readonly<{
  authorization?: string;
  cookie?: string;
  headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  body?: unknown;
}>;

export type TenantSessionContext = Readonly<{
  tenantId: UUIDv7;
  userId: UUIDv7;
  membershipId: UUIDv7;
  sessionId: UUIDv7;
}>;

export type TenantSessionErrorCode =
  | 'AUTH_REQUIRED'
  | 'IDENTITY_SERVICE_UNAVAILABLE'
  | 'TENANT_MEMBERSHIP_REQUIRED'
  | 'TENANT_OVERRIDE_FORBIDDEN';

export class TenantSessionError extends Error {
  readonly status: 400 | 401 | 403 | 503;
  readonly code: TenantSessionErrorCode;

  protected constructor(
    status: 400 | 401 | 403 | 503,
    code: TenantSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TenantSessionError';
    this.status = status;
    this.code = code;
  }
}

export class AuthenticationRequiredError extends TenantSessionError {
  constructor() {
    super(401, 'AUTH_REQUIRED', 'Authentication is required');
    this.name = 'AuthenticationRequiredError';
  }
}

export class IdentityServiceUnavailableError extends TenantSessionError {
  constructor() {
    super(
      503,
      'IDENTITY_SERVICE_UNAVAILABLE',
      'Identity verification is temporarily unavailable',
    );
    this.name = 'IdentityServiceUnavailableError';
  }
}

export class TenantMembershipRequiredError extends TenantSessionError {
  constructor() {
    super(
      403,
      'TENANT_MEMBERSHIP_REQUIRED',
      'An active tenant membership is required',
    );
    this.name = 'TenantMembershipRequiredError';
  }
}

export class TenantOverrideForbiddenError extends TenantSessionError {
  constructor() {
    super(
      400,
      'TENANT_OVERRIDE_FORBIDDEN',
      'Tenant context cannot be supplied by the client',
    );
    this.name = 'TenantOverrideForbiddenError';
  }
}

const VerifiedSessionSchema = z.object({
  id: UUIDv7Schema,
  userId: UUIDv7Schema,
  activeTenantId: UUIDv7Schema,
});

const ActiveMembershipSchema = z.object({
  id: UUIDv7Schema,
  tenantId: UUIDv7Schema,
  userId: UUIDv7Schema,
  status: z.literal('active'),
  deletedAt: z.null(),
});

const FORBIDDEN_BODY_TENANT_KEYS = new Set([
  'tenantId',
  'tenant_id',
  'activeTenantId',
  'active_tenant_id',
]);

export class TenantSessionResolver {
  constructor(
    private readonly verifier: SessionVerifier,
    private readonly memberships: MembershipRepository,
  ) {}

  async resolve(request: TenantSessionRequest): Promise<TenantSessionContext> {
    const session = await this.verifySession({
      ...(request.authorization === undefined
        ? {}
        : { authorization: request.authorization }),
      ...(request.cookie === undefined ? {} : { cookie: request.cookie }),
    });

    assertNoClientTenantOverride(request);

    let membershipResult: unknown;
    try {
      membershipResult = await this.memberships.findActive({
        tenantId: session.activeTenantId,
        userId: session.userId,
      });
    } catch {
      throw new IdentityServiceUnavailableError();
    }
    const membership = ActiveMembershipSchema.safeParse(membershipResult);
    if (
      !membership.success ||
      membership.data.tenantId !== session.activeTenantId ||
      membership.data.userId !== session.userId
    ) {
      throw new TenantMembershipRequiredError();
    }

    return {
      tenantId: session.activeTenantId,
      userId: session.userId,
      membershipId: membership.data.id,
      sessionId: session.id,
    };
  }

  private async verifySession(input: SessionVerificationInput) {
    let result: unknown;
    try {
      result = await this.verifier.verify(input);
    } catch (error) {
      if (error instanceof SessionVerificationUnavailableError) {
        throw new IdentityServiceUnavailableError();
      }
      throw new AuthenticationRequiredError();
    }

    const session = VerifiedSessionSchema.safeParse(result);
    if (!session.success) {
      throw new AuthenticationRequiredError();
    }
    return session.data;
  }
}

export function assertNoClientTenantOverride(
  request: TenantSessionRequest,
): void {
  if (
    Object.entries(request.headers ?? {}).some(
      ([name, value]) =>
        value !== undefined &&
        (name.toLowerCase() === 'x-tenant-id' ||
          name.toLowerCase() === 'x-active-tenant-id'),
    )
  ) {
    throw new TenantOverrideForbiddenError();
  }

  if (request.body === null || typeof request.body !== 'object') {
    return;
  }

  if (
    [...FORBIDDEN_BODY_TENANT_KEYS].some((key) =>
      Object.prototype.hasOwnProperty.call(request.body, key),
    )
  ) {
    throw new TenantOverrideForbiddenError();
  }
}

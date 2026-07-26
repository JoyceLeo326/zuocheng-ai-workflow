import {
  createHash,
  randomBytes,
} from 'node:crypto';
import type { UUIDv7 } from '@zuocheng/contracts';
import type { Pool } from 'pg';
import {
  IdentityLifecycleError,
  type AccountDeletionRequestResult,
  type AccountDeletionView,
  type AccountExportView,
  type IdentityDeviceView,
  type IdentityLifecycleService,
  type IdentityPrincipal,
  type IdentitySessionView,
  type OAuthProvider,
  type PasskeyCredentialView,
  type PasskeyOptions,
  type RecentAuthProof,
  type SessionEstablishment,
  type SessionRevocationResult,
} from '../http/identity-lifecycle-service.js';
import { PostgresIdentityLifecycleRepository } from './postgres-identity-lifecycle-repository.js';

const RECENT_AUTH_TTL_MS = 5 * 60 * 1_000;
const EXPORT_CONTENT_TYPE = 'application/json';
const DIGEST_HEX = /^[0-9a-f]{64}$/u;
const HTTPS_URL = /^https:\/\//u;

export type IdentityCoreGatewayCapabilities = Readonly<{
  profile: 'better-auth-1.6.25';
  runtimeBoundary: 'same-runtime-internal-v1-only';
  databaseBinding: 'shared-customer-postgres-identity-schema';
  accountStatusGate: 'active-only';
  sessions: 'database-persisted-signed-host-cookie';
  emailVerification: 'persisted-sha256-digest-atomic-consume';
  passwordRecovery: 'persisted-sha256-digest-atomic-consume';
  passkeys: 'webauthn-verified-public-key-only';
  oauth:
    'state-pkce-issuer-validated-customer-kms-encrypted-token-revocation';
  externalRevocation: 'idempotent';
}>;

type GatewaySession = Readonly<{
  signedSessionCookieValue: string;
  session: IdentitySessionView;
}>;

/**
 * The customer boundary is a Better Auth gateway, not another implementation
 * of the public 29-method lifecycle service. Its capability handshake makes
 * stateless verification, unsigned cookies and plaintext OAuth storage
 * impossible to compose accidentally.
 */
export interface IdentityCoreGateway {
  readonly kind: 'customer-managed-better-auth-gateway';
  readonly capabilities: IdentityCoreGatewayCapabilities;

  authenticate(
    input: Readonly<{ cookie?: string; authorization?: string }>,
  ): Promise<IdentityPrincipal>;
  registerPassword(input: Readonly<{
    email: string;
    password: string;
    displayName: string;
  }>): Promise<Readonly<{ status: 'verification_required' }>>;
  completeEmailVerification(input: Readonly<{
    token: string;
  }>): Promise<Readonly<{ status: 'verified' }>>;
  loginPassword(input: Readonly<{
    identifier: string;
    password: string;
  }>): Promise<GatewaySession>;
  createPasskeyRegistrationOptions(
    principal: IdentityPrincipal,
    input: Readonly<{ displayName?: string | undefined }>,
  ): Promise<PasskeyOptions>;
  verifyPasskeyRegistration(
    principal: IdentityPrincipal,
    input: Readonly<{
      challengeId: UUIDv7;
      response: unknown;
      displayName?: string | undefined;
    }>,
  ): Promise<PasskeyCredentialView>;
  createPasskeyAuthenticationOptions(input: Readonly<{
    identifier?: string | undefined;
  }>): Promise<PasskeyOptions>;
  verifyPasskeyAuthentication(input: Readonly<{
    challengeId: UUIDv7;
    response: unknown;
  }>): Promise<GatewaySession>;
  startOAuth(input: Readonly<{
    provider: OAuthProvider;
    returnTo: string;
  }>): Promise<Readonly<{ authorizationUrl: string }>>;
  completeOAuth(input: Readonly<{
    provider: OAuthProvider;
    code: string;
    state: string;
  }>): Promise<GatewaySession & Readonly<{ returnTo: string }>>;
  requestPasswordRecovery(input: Readonly<{
    email: string;
  }>): Promise<Readonly<{ status: 'accepted' }>>;
  completePasswordRecovery(input: Readonly<{
    token: string;
    newPassword: string;
  }>): Promise<Readonly<{ status: 'password_updated' }>>;
  verifyPassword(
    principal: IdentityPrincipal,
    input: Readonly<{ password: string }>,
  ): Promise<Readonly<{ verified: true }>>;
  revokeAllExternalCredentials(input: Readonly<{
    userId: UUIDv7;
    reason: 'account-deletion';
  }>): Promise<Readonly<{ status: 'revoked' }>>;
}

export type IdentityIdempotencyClaim =
  | Readonly<{ kind: 'claimed' }>
  | Readonly<{ kind: 'replay' }>
  | Readonly<{ kind: 'conflict' }>;

export type AccountExportSnapshot = Readonly<{
  account: Readonly<{
    id: UUIDv7;
    email: string;
    displayName: string;
    accountStatus?: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
  memberships: readonly unknown[];
  projects: readonly unknown[];
  versions: readonly unknown[];
  audit: readonly unknown[];
  courses: readonly unknown[];
  usage: readonly unknown[];
  ledger: readonly unknown[];
}>;

type AuditInput = Readonly<{
  principal?: IdentityPrincipal;
  userId?: UUIDv7;
  eventType: string;
  payload?: Readonly<Record<string, unknown>>;
}>;

/**
 * Implemented by PostgresIdentityLifecycleRepository below. This narrower
 * seam exists so the orchestration can be unit-tested without pretending that
 * a fake database is production.
 */
export interface IdentityLifecycleRepository {
  readonly kind: 'customer-managed-postgres-identity-repository';
  claimIdempotency(input: Readonly<{
    actorScope: string;
    operation: string;
    keyDigest: string;
    requestDigest: string;
  }>): Promise<IdentityIdempotencyClaim>;
  completeIdempotency(input: Readonly<{
    actorScope: string;
    operation: string;
    keyDigest: string;
  }>): Promise<void>;
  abandonIdempotency(input: Readonly<{
    actorScope: string;
    operation: string;
    keyDigest: string;
  }>): Promise<void>;
  getCurrentSession(
    principal: IdentityPrincipal,
  ): Promise<IdentitySessionView | null>;
  listSessions(
    principal: IdentityPrincipal,
  ): Promise<readonly IdentitySessionView[]>;
  listDevices(
    principal: IdentityPrincipal,
  ): Promise<readonly IdentityDeviceView[]>;
  revokeSession(
    principal: IdentityPrincipal,
    sessionId: UUIDv7,
  ): Promise<readonly UUIDv7[]>;
  revokeOtherSessions(
    principal: IdentityPrincipal,
  ): Promise<readonly UUIDv7[]>;
  revokeAllSessions(
    principal: IdentityPrincipal,
  ): Promise<readonly UUIDv7[]>;
  appendAudit(input: AuditInput): Promise<void>;
  createRecentAuthProof(
    principal: IdentityPrincipal,
    tokenDigest: string,
    expiresAt: string,
    purpose: 'account-deletion',
  ): Promise<void>;
  createAccountExport(
    principal: IdentityPrincipal,
  ): Promise<AccountExportView>;
  captureAccountExport(
    principal: IdentityPrincipal,
  ): Promise<AccountExportSnapshot>;
  completeAccountExport(
    principal: IdentityPrincipal,
    exportId: UUIDv7,
    artifact: Readonly<{
      downloadUrl: string;
      expiresAt: string;
      sha256: string;
      manifest: unknown;
    }>,
  ): Promise<AccountExportView>;
  failAccountExport(
    principal: IdentityPrincipal,
    exportId: UUIDv7,
  ): Promise<void>;
  getAccountExport(
    principal: IdentityPrincipal,
    exportId: UUIDv7,
  ): Promise<AccountExportView | null>;
  consumeRecentAuthAndCreateDeletion(
    principal: IdentityPrincipal,
    recentAuthDigest: string,
    confirmationDigest: string,
  ): Promise<Readonly<{
    deletion: AccountDeletionView;
    email: string;
    confirmationDigest: string;
  }> | null>;
  abortAccountDeletion(
    principal: IdentityPrincipal,
    deletionId: UUIDv7,
  ): Promise<void>;
  getAccountDeletion(
    principal: IdentityPrincipal,
  ): Promise<AccountDeletionView | null>;
  cancelAccountDeletion(
    principal: IdentityPrincipal,
  ): Promise<AccountDeletionView | null>;
  confirmAccountDeletionAndRevoke(
    principal: IdentityPrincipal,
    deletionId: UUIDv7,
    confirmationDigest: string,
  ): Promise<Readonly<{
    deletion: AccountDeletionView;
    revokedSessionIds: readonly UUIDv7[];
  }> | null>;
}

type CustomerResourceCapabilities = Readonly<{
  billingOwner: 'customer-or-tenant';
  quotaPolicy: 'known-available-or-fail-closed';
}>;

export interface AccountExportObjectStore {
  readonly kind: 'customer-managed-byos-account-export';
  readonly capabilities: CustomerResourceCapabilities &
    Readonly<{ integrityReceipt: 'sha256-required' }>;
  checkCapacity(input: Readonly<{
    userId: UUIDv7;
    maximumBytes: number;
  }>): Promise<Readonly<{ available: true } | { available: false }>>;
  put(input: Readonly<{
    exportId: UUIDv7;
    userId: UUIDv7;
    contentType: typeof EXPORT_CONTENT_TYPE;
    bytes: Uint8Array;
    sha256: string;
  }>): Promise<Readonly<{
    status: 'stored';
    downloadUrl: string;
    expiresAt: string;
    sha256: string;
  }>>;
}

export interface AccountDeletionMailer {
  readonly kind: 'customer-managed-account-email-delivery';
  readonly capabilities: CustomerResourceCapabilities &
    Readonly<{ deliveryReceipt: 'required' }>;
  checkCapacity(input: Readonly<{
    operation: 'account-deletion-confirmation';
  }>): Promise<Readonly<{ available: true } | { available: false }>>;
  sendConfirmation(input: Readonly<{
    userId: UUIDv7;
    email: string;
    confirmationUrl: string;
  }>): Promise<Readonly<{
    status: 'sent';
    deliveryId: string;
  }>>;
}

type ProductionServiceResources = Readonly<{
  gateway: IdentityCoreGateway;
  repository: IdentityLifecycleRepository;
  exportStore: AccountExportObjectStore;
  deletionMailer: AccountDeletionMailer;
  publicBaseUrl: string;
  clock?: () => Date;
  randomToken?: () => string;
}>;

export type ProductionIdentityLifecycleInput = Readonly<{
  gateway: IdentityCoreGateway;
  pool: Pool;
  exportStore: AccountExportObjectStore;
  deletionMailer: AccountDeletionMailer;
  publicBaseUrl: string;
  clock?: () => Date;
  randomToken?: () => string;
}>;

type TestableProductionIdentityLifecycleInput =
  | ProductionIdentityLifecycleInput
  | Omit<ProductionServiceResources, 'pool'>;

export function createPostgresIdentityLifecycleService(
  input: TestableProductionIdentityLifecycleInput,
): IdentityLifecycleService {
  const resources: ProductionServiceResources =
    'repository' in input
      ? input
      : {
          ...input,
          repository: new PostgresIdentityLifecycleRepository(input.pool),
        };
  assertProductionResources(resources);
  return new PostgresIdentityLifecycleService(
    resources,
    resources.clock ?? (() => new Date()),
    resources.randomToken ??
      (() => randomBytes(32).toString('base64url')),
  );
}

class PostgresIdentityLifecycleService implements IdentityLifecycleService {
  constructor(
    private readonly resources: ProductionServiceResources,
    private readonly clock: () => Date,
    private readonly randomToken: () => string,
  ) {}

  authenticate(
    input: Readonly<{ cookie?: string; authorization?: string }>,
  ): Promise<IdentityPrincipal> {
    return this.gatewayCall(
      () => this.resources.gateway.authenticate(input),
      'IDENTITY_SERVICE_UNAVAILABLE',
    );
  }

  registerPassword(
    input: Readonly<{
      email: string;
      password: string;
      displayName: string;
    }>,
    idempotencyKey: string,
  ): Promise<Readonly<{ status: 'verification_required' }>> {
    return this.mutate(
      anonymousScope(input.email),
      'password-register',
      idempotencyKey,
      input,
      () => this.resources.gateway.registerPassword(input),
    );
  }

  async completeEmailVerification(
    input: Readonly<{ token: string }>,
  ): Promise<Readonly<{ status: 'verified'; redirectTo: string }>> {
    await this.gatewayCall(
      () => this.resources.gateway.completeEmailVerification(input),
      'VERIFICATION_TOKEN_INVALID',
    );
    return { status: 'verified', redirectTo: '/login?verified=1' };
  }

  loginPassword(
    input: Readonly<{ identifier: string; password: string }>,
    idempotencyKey: string,
  ): Promise<SessionEstablishment> {
    return this.mutate(
      anonymousScope(input.identifier),
      'password-login',
      idempotencyKey,
      input,
      async () =>
        sessionEstablishment(
          await this.resources.gateway.loginPassword(input),
        ),
    );
  }

  createPasskeyRegistrationOptions(
    principal: IdentityPrincipal,
    input: Readonly<{ displayName?: string | undefined }>,
    idempotencyKey: string,
  ): Promise<PasskeyOptions> {
    return this.mutate(
      principal.userId,
      'passkey-registration-options',
      idempotencyKey,
      input,
      () =>
        this.resources.gateway.createPasskeyRegistrationOptions(
          principal,
          input,
        ),
    );
  }

  verifyPasskeyRegistration(
    principal: IdentityPrincipal,
    input: Readonly<{
      challengeId: UUIDv7;
      response: unknown;
      displayName?: string | undefined;
    }>,
    idempotencyKey: string,
  ): Promise<PasskeyCredentialView> {
    return this.mutate(
      principal.userId,
      'passkey-registration-verify',
      idempotencyKey,
      input,
      () =>
        this.resources.gateway.verifyPasskeyRegistration(principal, input),
    );
  }

  createPasskeyAuthenticationOptions(
    input: Readonly<{ identifier?: string | undefined }>,
    idempotencyKey: string,
  ): Promise<PasskeyOptions> {
    return this.mutate(
      anonymousScope(input.identifier ?? 'anonymous-passkey'),
      'passkey-authentication-options',
      idempotencyKey,
      input,
      () =>
        this.resources.gateway.createPasskeyAuthenticationOptions(input),
    );
  }

  verifyPasskeyAuthentication(
    input: Readonly<{ challengeId: UUIDv7; response: unknown }>,
    idempotencyKey: string,
  ): Promise<SessionEstablishment> {
    return this.mutate(
      `passkey:${input.challengeId}`,
      'passkey-authentication-verify',
      idempotencyKey,
      input,
      async () =>
        sessionEstablishment(
          await this.resources.gateway.verifyPasskeyAuthentication(input),
        ),
    );
  }

  startOAuth(
    input: Readonly<{ provider: OAuthProvider; returnTo: string }>,
    idempotencyKey: string,
  ): Promise<Readonly<{ authorizationUrl: string }>> {
    return this.mutate(
      `oauth:${input.provider}`,
      'oauth-start',
      idempotencyKey,
      input,
      async () => {
        const result = await this.resources.gateway.startOAuth(input);
        if (!isHttpsUrl(result.authorizationUrl)) {
          throw new IdentityLifecycleError('OAUTH_PROVIDER_UNAVAILABLE');
        }
        return result;
      },
    );
  }

  async completeOAuth(
    input: Readonly<{
      provider: OAuthProvider;
      code: string;
      state: string;
    }>,
  ): Promise<SessionEstablishment & Readonly<{ redirectTo: string }>> {
    const result = await this.gatewayCall(
      () => this.resources.gateway.completeOAuth(input),
      'OAUTH_CALLBACK_INVALID',
    );
    if (!isSafeLocalPath(result.returnTo)) {
      throw new IdentityLifecycleError('OAUTH_CALLBACK_INVALID');
    }
    return {
      ...sessionEstablishment(result),
      redirectTo: result.returnTo,
    };
  }

  async getCurrentSession(
    principal: IdentityPrincipal,
  ): Promise<IdentitySessionView> {
    const result =
      await this.resources.repository.getCurrentSession(principal);
    if (result === null) {
      throw new IdentityLifecycleError('RESOURCE_NOT_FOUND');
    }
    return result;
  }

  listSessions(
    principal: IdentityPrincipal,
  ): Promise<readonly IdentitySessionView[]> {
    return this.resources.repository.listSessions(principal);
  }

  listDevices(
    principal: IdentityPrincipal,
  ): Promise<readonly IdentityDeviceView[]> {
    return this.resources.repository.listDevices(principal);
  }

  async revokeSession(
    principal: IdentityPrincipal,
    sessionId: UUIDv7,
    idempotencyKey: string,
  ): Promise<SessionRevocationResult> {
    const revokedSessionIds = await this.mutate(
      principal.userId,
      'session-revoke',
      idempotencyKey,
      { sessionId },
      () => this.resources.repository.revokeSession(principal, sessionId),
    );
    return { revokedSessionIds };
  }

  async revokeOtherSessions(
    principal: IdentityPrincipal,
    idempotencyKey: string,
  ): Promise<SessionRevocationResult> {
    const revokedSessionIds = await this.mutate(
      principal.userId,
      'session-revoke-others',
      idempotencyKey,
      {},
      () => this.resources.repository.revokeOtherSessions(principal),
    );
    return { revokedSessionIds };
  }

  async revokeAllSessions(
    principal: IdentityPrincipal,
    idempotencyKey: string,
  ): Promise<SessionRevocationResult> {
    const revokedSessionIds = await this.mutate(
      principal.userId,
      'session-revoke-all',
      idempotencyKey,
      {},
      () => this.resources.repository.revokeAllSessions(principal),
    );
    return { revokedSessionIds };
  }

  async logout(
    principal: IdentityPrincipal,
    idempotencyKey: string,
  ): Promise<void> {
    await this.mutate(
      principal.userId,
      'logout',
      idempotencyKey,
      { sessionId: principal.sessionId },
      () =>
        this.resources.repository.revokeSession(
          principal,
          principal.sessionId,
        ),
    );
  }

  async requestPasswordRecovery(
    input: Readonly<{ email: string }>,
    idempotencyKey: string,
  ): Promise<void> {
    await this.mutate(
      anonymousScope(input.email),
      'password-recovery-request',
      idempotencyKey,
      input,
      () => this.resources.gateway.requestPasswordRecovery(input),
    );
  }

  completePasswordRecovery(
    input: Readonly<{ token: string; newPassword: string }>,
    idempotencyKey: string,
  ): Promise<Readonly<{ status: 'password_updated' }>> {
    return this.mutate(
      `recovery:${sha256Base64Url(input.token)}`,
      'password-recovery-complete',
      idempotencyKey,
      input,
      () => this.resources.gateway.completePasswordRecovery(input),
    );
  }

  createRecentAuthProofWithPassword(
    principal: IdentityPrincipal,
    input: Readonly<{
      password: string;
      purpose: 'account-deletion';
    }>,
    idempotencyKey: string,
  ): Promise<RecentAuthProof> {
    return this.mutate(
      principal.userId,
      'recent-auth-password',
      idempotencyKey,
      input,
      async () => {
        await this.gatewayCall(
          () =>
            this.resources.gateway.verifyPassword(principal, {
              password: input.password,
            }),
          'INVALID_CREDENTIALS',
        );
        const recentAuthToken = requiredOpaqueToken(this.randomToken());
        const expiresAt = new Date(
          this.clock().getTime() + RECENT_AUTH_TTL_MS,
        ).toISOString();
        await this.resources.repository.createRecentAuthProof(
          principal,
          sha256Base64Url(recentAuthToken),
          expiresAt,
          input.purpose,
        );
        await this.audit(principal, 'recent_auth.created', {
          purpose: input.purpose,
          expiresAt,
        });
        return { recentAuthToken, expiresAt };
      },
    );
  }

  requestAccountExport(
    principal: IdentityPrincipal,
    idempotencyKey: string,
  ): Promise<AccountExportView> {
    return this.mutate(
      principal.userId,
      'account-export-request',
      idempotencyKey,
      {},
      () => this.createExport(principal),
    );
  }

  async getAccountExport(
    principal: IdentityPrincipal,
    exportId: UUIDv7,
  ): Promise<AccountExportView> {
    const result = await this.resources.repository.getAccountExport(
      principal,
      exportId,
    );
    if (result === null) {
      throw new IdentityLifecycleError('RESOURCE_NOT_FOUND');
    }
    return result;
  }

  requestAccountDeletion(
    principal: IdentityPrincipal,
    input: Readonly<{ recentAuthToken: string }>,
    idempotencyKey: string,
  ): Promise<AccountDeletionRequestResult> {
    return this.mutate(
      principal.userId,
      'account-deletion-request',
      idempotencyKey,
      { recentAuthDigest: sha256Base64Url(input.recentAuthToken) },
      () => this.createDeletion(principal, input.recentAuthToken),
    );
  }

  async getAccountDeletion(
    principal: IdentityPrincipal,
  ): Promise<AccountDeletionView> {
    const result =
      await this.resources.repository.getAccountDeletion(principal);
    if (result === null) {
      throw new IdentityLifecycleError('RESOURCE_NOT_FOUND');
    }
    return result;
  }

  async cancelAccountDeletion(
    principal: IdentityPrincipal,
    idempotencyKey: string,
  ): Promise<AccountDeletionView> {
    return this.mutate(
      principal.userId,
      'account-deletion-cancel',
      idempotencyKey,
      {},
      async () => {
        const result =
          await this.resources.repository.cancelAccountDeletion(principal);
        if (result === null) {
          throw new IdentityLifecycleError(
            'ACCOUNT_DELETION_NOT_CANCELLABLE',
          );
        }
        await this.audit(principal, 'account_deletion.cancelled', {
          deletionId: result.id,
        });
        return result;
      },
    );
  }

  confirmAccountDeletion(
    principal: IdentityPrincipal,
    input: Readonly<{
      deletionRequestId: UUIDv7;
      confirmationToken: string;
    }>,
    idempotencyKey: string,
  ): Promise<AccountDeletionView> {
    return this.mutate(
      principal.userId,
      'account-deletion-confirm',
      idempotencyKey,
      {
        deletionRequestId: input.deletionRequestId,
        confirmationDigest: sha256Hex(input.confirmationToken),
      },
      async () => {
        const result =
          await this.resources.repository.confirmAccountDeletionAndRevoke(
            principal,
            input.deletionRequestId,
            sha256Hex(input.confirmationToken),
          );
        if (result === null) {
          throw new IdentityLifecycleError(
            'ACCOUNT_DELETION_ALREADY_IRREVERSIBLE',
          );
        }

        // Local cookies, Passkeys and persisted OAuth credentials are already
        // revoked atomically. External provider revocation must also be
        // confirmed before the public operation reports progress.
        await this.gatewayCall(
          () =>
            this.resources.gateway.revokeAllExternalCredentials({
              userId: principal.userId,
              reason: 'account-deletion',
            }),
          'IDENTITY_SERVICE_UNAVAILABLE',
        );
        await this.audit(principal, 'account_deletion.confirmed', {
          deletionId: result.deletion.id,
          revokedSessionCount: result.revokedSessionIds.length,
        });
        return result.deletion;
      },
    );
  }

  private async createExport(
    principal: IdentityPrincipal,
  ): Promise<AccountExportView> {
    const capacity = await this.resourceCall(() =>
      this.resources.exportStore.checkCapacity({
        userId: principal.userId,
        maximumBytes: 64 * 1_024 * 1_024,
      }),
    );
    if (!capacity.available) {
      throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
    }

    const pending =
      await this.resources.repository.createAccountExport(principal);
    try {
      const snapshot =
        await this.resources.repository.captureAccountExport(principal);
      assertExportContainsNoSecrets(snapshot);
      const manifest = {
        schemaVersion: 1,
        userId: principal.userId,
        generatedAt: this.clock().toISOString(),
        resources: snapshot,
      };
      const bytes = new TextEncoder().encode(canonicalJson(manifest));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const receipt = await this.resourceCall(() =>
        this.resources.exportStore.put({
          exportId: pending.id,
          userId: principal.userId,
          contentType: EXPORT_CONTENT_TYPE,
          bytes,
          sha256,
        }),
      );
      if (
        receipt.status !== 'stored' ||
        receipt.sha256 !== sha256 ||
        !isHttpsUrl(receipt.downloadUrl) ||
        !isFutureIso(receipt.expiresAt, this.clock())
      ) {
        throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
      }
      const ready =
        await this.resources.repository.completeAccountExport(
          principal,
          pending.id,
          {
            downloadUrl: receipt.downloadUrl,
            expiresAt: receipt.expiresAt,
            sha256,
            manifest,
          },
        );
      await this.audit(principal, 'account_export.ready', {
        exportId: ready.id,
        sha256,
      });
      return ready;
    } catch (error) {
      await this.resources.repository
        .failAccountExport(principal, pending.id)
        .catch(() => undefined);
      if (error instanceof IdentityLifecycleError) throw error;
      throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
    }
  }

  private async createDeletion(
    principal: IdentityPrincipal,
    recentAuthToken: string,
  ): Promise<AccountDeletionRequestResult> {
    let capacity: Readonly<{ available: true } | { available: false }>;
    try {
      capacity = await this.resources.deletionMailer.checkCapacity({
        operation: 'account-deletion-confirmation',
      });
    } catch {
      throw new IdentityLifecycleError('EMAIL_PROVIDER_UNAVAILABLE');
    }
    if (!capacity.available) {
      throw new IdentityLifecycleError('EMAIL_PROVIDER_UNAVAILABLE');
    }
    const confirmationToken = requiredOpaqueToken(this.randomToken());
    const creation =
      await this.resources.repository.consumeRecentAuthAndCreateDeletion(
        principal,
        sha256Base64Url(recentAuthToken),
        sha256Hex(confirmationToken),
      );
    if (creation === null) {
      throw new IdentityLifecycleError('RECENT_AUTH_REQUIRED');
    }
    const confirmationUrl = new URL(
      '/v1/account/deletion/confirmation',
      this.resources.publicBaseUrl,
    );
    confirmationUrl.searchParams.set(
      'request',
      creation.deletion.id,
    );
    confirmationUrl.searchParams.set('token', confirmationToken);

    try {
      const receipt = await this.resourceCall(() =>
        this.resources.deletionMailer.sendConfirmation({
          userId: principal.userId,
          email: creation.email,
          confirmationUrl: confirmationUrl.toString(),
        }),
      );
      if (
        receipt.status !== 'sent' ||
        typeof receipt.deliveryId !== 'string' ||
        receipt.deliveryId.trim().length === 0 ||
        receipt.deliveryId.length > 1_024
      ) {
        throw new IdentityLifecycleError('EMAIL_PROVIDER_UNAVAILABLE');
      }
    } catch {
      await this.resources.repository
        .abortAccountDeletion(principal, creation.deletion.id)
        .catch(() => undefined);
      throw new IdentityLifecycleError('EMAIL_PROVIDER_UNAVAILABLE');
    }
    await this.audit(principal, 'account_deletion.requested', {
      deletionId: creation.deletion.id,
      confirmationDelivery: 'sent',
    });
    return {
      deletion: creation.deletion,
      confirmationDelivery: { channel: 'email', status: 'sent' },
    };
  }

  private async mutate<Result>(
    actorScope: string,
    operation: string,
    idempotencyKey: string,
    request: unknown,
    effect: () => Promise<Result>,
  ): Promise<Result> {
    const keyDigest = sha256Hex(idempotencyKey);
    const requestDigest = sha256Hex(canonicalJson(request));
    let claim: IdentityIdempotencyClaim;
    try {
      claim = await this.resources.repository.claimIdempotency({
        actorScope,
        operation,
        keyDigest,
        requestDigest,
      });
    } catch {
      throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
    }
    if (claim.kind !== 'claimed') {
      throw new IdentityLifecycleError('IDEMPOTENCY_KEY_REUSED');
    }

    let value: Result;
    try {
      value = await effect();
    } catch (error) {
      // A customer gateway or BYOS call can fail after committing its own
      // side effect. Retaining the processing claim is the conservative
      // at-most-once choice; callers can inspect state or use a deliberate new
      // key instead of silently repeating a credential mutation.
      if (error instanceof IdentityLifecycleError) throw error;
      throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
    }
    try {
      await this.resources.repository.completeIdempotency({
        actorScope,
        operation,
        keyDigest,
      });
      return value;
    } catch {
      throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
    }
  }

  private async audit(
    principal: IdentityPrincipal,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    try {
      await this.resources.repository.appendAudit({
        principal,
        eventType,
        payload,
      });
    } catch {
      throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
    }
  }

  private async gatewayCall<Result>(
    operation: () => Promise<Result>,
    fallbackCode:
      | 'AUTH_REQUIRED'
      | 'INVALID_CREDENTIALS'
      | 'VERIFICATION_TOKEN_INVALID'
      | 'OAUTH_CALLBACK_INVALID'
      | 'IDENTITY_SERVICE_UNAVAILABLE',
  ): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof IdentityLifecycleError) throw error;
      throw new IdentityLifecycleError(fallbackCode);
    }
  }

  private async resourceCall<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await operation();
    } catch {
      throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
    }
  }
}

function assertProductionResources(
  input: ProductionServiceResources,
): void {
  if (
    input.gateway?.kind !== 'customer-managed-better-auth-gateway' ||
    !hasExactGatewayCapabilities(input.gateway.capabilities) ||
    input.repository?.kind !==
      'customer-managed-postgres-identity-repository' ||
    input.exportStore?.kind !== 'customer-managed-byos-account-export' ||
    input.exportStore.capabilities.billingOwner !== 'customer-or-tenant' ||
    input.exportStore.capabilities.quotaPolicy !==
      'known-available-or-fail-closed' ||
    input.exportStore.capabilities.integrityReceipt !== 'sha256-required' ||
    input.deletionMailer?.kind !==
      'customer-managed-account-email-delivery' ||
    input.deletionMailer.capabilities.billingOwner !==
      'customer-or-tenant' ||
    input.deletionMailer.capabilities.quotaPolicy !==
      'known-available-or-fail-closed' ||
    input.deletionMailer.capabilities.deliveryReceipt !== 'required' ||
    !isProductionBaseUrl(input.publicBaseUrl)
  ) {
    throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
  }
}

function hasExactGatewayCapabilities(
  input: IdentityCoreGatewayCapabilities,
): boolean {
  return (
    input?.profile === 'better-auth-1.6.25' &&
    input.runtimeBoundary === 'same-runtime-internal-v1-only' &&
    input.databaseBinding ===
      'shared-customer-postgres-identity-schema' &&
    input.accountStatusGate === 'active-only' &&
    input.sessions === 'database-persisted-signed-host-cookie' &&
    input.emailVerification ===
      'persisted-sha256-digest-atomic-consume' &&
    input.passwordRecovery ===
      'persisted-sha256-digest-atomic-consume' &&
    input.passkeys === 'webauthn-verified-public-key-only' &&
    input.oauth ===
      'state-pkce-issuer-validated-customer-kms-encrypted-token-revocation' &&
    input.externalRevocation === 'idempotent'
  );
}

function sessionEstablishment(result: GatewaySession): SessionEstablishment {
  if (
    typeof result.signedSessionCookieValue !== 'string' ||
    result.signedSessionCookieValue.length < 16 ||
    result.signedSessionCookieValue.length > 4_096 ||
    result.signedSessionCookieValue.includes(';') ||
    Array.from(result.signedSessionCookieValue).some(
      (character) =>
        /\s/u.test(character) || isControlCharacter(character),
    )
  ) {
    throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
  }
  return {
    sessionToken: result.signedSessionCookieValue,
    session: result.session,
  };
}

function anonymousScope(identifier: string): string {
  return `anonymous:${sha256Hex(identifier.trim().toLowerCase())}`;
}

function requiredOpaqueToken(token: string): string {
  if (
    typeof token !== 'string' ||
    token.length < 24 ||
    token.length > 512 ||
    !/^[A-Za-z0-9._~-]+$/u.test(token)
  ) {
    throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
  }
  return token;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
}

function assertExportContainsNoSecrets(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertExportContainsNoSecrets(item, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    if (
      /(?:^|_)(?:password|secret|token|credential|private_key|ciphertext|key_version|aad_hash)(?:$|_)/iu.test(
        key,
      )
    ) {
      throw new IdentityLifecycleError('IDENTITY_SERVICE_UNAVAILABLE');
    }
    assertExportContainsNoSecrets(item, `${path}.${key}`);
  }
}

function isProductionBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.hostname !== 'localhost' &&
      !url.hostname.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      HTTPS_URL.test(value) &&
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

function isSafeLocalPath(value: string): boolean {
  return (
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !Array.from(value).some(isControlCharacter)
  );
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return (
    codePoint !== undefined &&
    (codePoint <= 0x1f || codePoint === 0x7f)
  );
}

function isFutureIso(value: string, now: Date): boolean {
  const date = new Date(value);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString() === value &&
    date.getTime() > now.getTime()
  );
}

export const identityDigest = Object.freeze({
  hex: sha256Hex,
  base64Url: sha256Base64Url,
  isHex: (value: string) => DIGEST_HEX.test(value),
});

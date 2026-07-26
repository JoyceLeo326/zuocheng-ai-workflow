import type { UUIDv7 } from '@zuocheng/contracts';

export const OAUTH_PROVIDERS = [
  'google',
  'github',
  'microsoft',
] as const;

export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export type IdentityPrincipal = Readonly<{
  userId: UUIDv7;
  sessionId: UUIDv7;
}>;

export type IdentitySessionView = Readonly<{
  id: UUIDv7;
  userId: UUIDv7;
  deviceId: UUIDv7;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
  revokedAt: string | null;
}>;

export type IdentityDeviceView = Readonly<{
  id: UUIDv7;
  displayName: string;
  platform: string;
  lastSeenAt: string;
  current: boolean;
}>;

export type SessionEstablishment = Readonly<{
  sessionToken: string;
  session: IdentitySessionView;
}>;

export type PasskeyOptions = Readonly<{
  challengeId: UUIDv7;
  expiresAt: string;
  publicKey: unknown;
}>;

export type PasskeyCredentialView = Readonly<{
  id: UUIDv7;
  displayName: string;
  createdAt: string;
}>;

export type SessionRevocationResult = Readonly<{
  revokedSessionIds: readonly UUIDv7[];
}>;

export type AccountExportStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'expired';

export type AccountExportView = Readonly<{
  id: UUIDv7;
  status: AccountExportStatus;
  requestedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  downloadUrl: string | null;
  sha256: string | null;
}>;

export type AccountDeletionStatus =
  | 'pending'
  | 'cancelled'
  | 'processing'
  | 'completed'
  | 'failed';

export type AccountDeletionView = Readonly<{
  id: UUIDv7;
  status: AccountDeletionStatus;
  requestedAt: string;
  cancellableUntil: string | null;
  irreversibleAt: string | null;
  completedAt: string | null;
}>;

export type RecentAuthProof = Readonly<{
  recentAuthToken: string;
  expiresAt: string;
}>;

export type AccountDeletionRequestResult = Readonly<{
  deletion: AccountDeletionView;
  confirmationDelivery: Readonly<{
    channel: 'email';
    status: 'sent';
  }>;
}>;

export type IdentityLifecycleErrorCode =
  | 'AUTH_REQUIRED'
  | 'INVALID_CREDENTIALS'
  | 'RECENT_AUTH_REQUIRED'
  | 'ORIGIN_FORBIDDEN'
  | 'CSRF_FAILED'
  | 'SECURITY_CONTROL_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'RATE_LIMIT_UNAVAILABLE'
  | 'OAUTH_PROVIDER_UNAVAILABLE'
  | 'EMAIL_PROVIDER_UNAVAILABLE'
  | 'IDENTITY_SERVICE_UNAVAILABLE'
  | 'VERIFICATION_TOKEN_INVALID'
  | 'OAUTH_CALLBACK_INVALID'
  | 'PASSKEY_VERIFICATION_FAILED'
  | 'RECOVERY_TOKEN_INVALID'
  | 'RESOURCE_NOT_FOUND'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'ACCOUNT_DELETION_NOT_CANCELLABLE'
  | 'ACCOUNT_DELETION_ALREADY_IRREVERSIBLE';

export class IdentityLifecycleError extends Error {
  readonly code: IdentityLifecycleErrorCode;

  constructor(code: IdentityLifecycleErrorCode) {
    super(code);
    this.name = 'IdentityLifecycleError';
    this.code = code;
  }
}

export type IdentityRateLimitOperation =
  | 'password-register'
  | 'password-login'
  | 'email-verification-complete'
  | 'passkey-registration-options'
  | 'passkey-registration-verify'
  | 'passkey-authentication-options'
  | 'passkey-authentication-verify'
  | 'oauth-start'
  | 'oauth-callback'
  | 'session-revoke'
  | 'session-revoke-others'
  | 'session-revoke-all'
  | 'logout'
  | 'password-recovery-request'
  | 'password-recovery-complete'
  | 'recent-auth-password'
  | 'account-export-request'
  | 'account-deletion-request'
  | 'account-deletion-cancel'
  | 'account-deletion-confirm';

export type IdentitySecurityInput = Readonly<{
  operation: IdentityRateLimitOperation;
  request: Request;
  principal?: IdentityPrincipal;
}>;

/**
 * Customer-composed Origin and CSRF enforcement. Implementations must reject
 * untrusted origins and invalid CSRF proofs with IdentityLifecycleError. A
 * dependency outage is treated as SECURITY_CONTROL_UNAVAILABLE by the routes.
 * Implementations must inspect headers only and must not consume the body.
 */
export interface IdentityHttpSecurityPort {
  enforce(input: IdentitySecurityInput): Promise<void>;
}

export type IdentityRateLimitDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false }>;

/**
 * A persistent, shared rate-limit port. In-memory process-local counters are
 * not production implementations of this contract. Implementations must not
 * consume the request body.
 */
export interface IdentityRateLimiter {
  consume(input: IdentitySecurityInput): Promise<IdentityRateLimitDecision>;
}

export interface IdentityLifecycleService {
  authenticate(
    input: Readonly<{ cookie?: string; authorization?: string }>,
  ): Promise<IdentityPrincipal>;

  registerPassword(
    input: Readonly<{
      email: string;
      password: string;
      displayName: string;
    }>,
    idempotencyKey: string,
  ): Promise<Readonly<{ status: 'verification_required' }>>;

  /** Atomically consumes one persisted verification-token digest. */
  completeEmailVerification(
    input: Readonly<{ token: string }>,
  ): Promise<Readonly<{ status: 'verified'; redirectTo: string }>>;

  loginPassword(
    input: Readonly<{ identifier: string; password: string }>,
    idempotencyKey: string,
  ): Promise<SessionEstablishment>;

  createPasskeyRegistrationOptions(
    principal: IdentityPrincipal,
    input: Readonly<{ displayName?: string | undefined }>,
    idempotencyKey: string,
  ): Promise<PasskeyOptions>;

  verifyPasskeyRegistration(
    principal: IdentityPrincipal,
    input: Readonly<{
      challengeId: UUIDv7;
      response: unknown;
      displayName?: string | undefined;
    }>,
    idempotencyKey: string,
  ): Promise<PasskeyCredentialView>;

  createPasskeyAuthenticationOptions(
    input: Readonly<{ identifier?: string | undefined }>,
    idempotencyKey: string,
  ): Promise<PasskeyOptions>;

  verifyPasskeyAuthentication(
    input: Readonly<{ challengeId: UUIDv7; response: unknown }>,
    idempotencyKey: string,
  ): Promise<SessionEstablishment>;

  startOAuth(
    input: Readonly<{ provider: OAuthProvider; returnTo: string }>,
    idempotencyKey: string,
  ): Promise<Readonly<{ authorizationUrl: string }>>;

  /** Atomically consumes persisted OAuth state after PKCE/issuer validation. */
  completeOAuth(
    input: Readonly<{
      provider: OAuthProvider;
      code: string;
      state: string;
    }>,
  ): Promise<SessionEstablishment & Readonly<{ redirectTo: string }>>;

  getCurrentSession(
    principal: IdentityPrincipal,
  ): Promise<IdentitySessionView>;
  listSessions(
    principal: IdentityPrincipal,
  ): Promise<readonly IdentitySessionView[]>;
  listDevices(
    principal: IdentityPrincipal,
  ): Promise<readonly IdentityDeviceView[]>;

  revokeSession(
    principal: IdentityPrincipal,
    sessionId: UUIDv7,
    idempotencyKey: string,
  ): Promise<SessionRevocationResult>;
  revokeOtherSessions(
    principal: IdentityPrincipal,
    idempotencyKey: string,
  ): Promise<SessionRevocationResult>;
  revokeAllSessions(
    principal: IdentityPrincipal,
    idempotencyKey: string,
  ): Promise<SessionRevocationResult>;
  logout(
    principal: IdentityPrincipal,
    idempotencyKey: string,
  ): Promise<void>;

  requestPasswordRecovery(
    input: Readonly<{ email: string }>,
    idempotencyKey: string,
  ): Promise<void>;
  /** Atomically consumes one persisted recovery-token digest. */
  completePasswordRecovery(
    input: Readonly<{ token: string; newPassword: string }>,
    idempotencyKey: string,
  ): Promise<Readonly<{ status: 'password_updated' }>>;

  createRecentAuthProofWithPassword(
    principal: IdentityPrincipal,
    input: Readonly<{
      password: string;
      purpose: 'account-deletion';
    }>,
    idempotencyKey: string,
  ): Promise<RecentAuthProof>;

  requestAccountExport(
    principal: IdentityPrincipal,
    idempotencyKey: string,
  ): Promise<AccountExportView>;
  getAccountExport(
    principal: IdentityPrincipal,
    exportId: UUIDv7,
  ): Promise<AccountExportView>;

  /**
   * Atomically persists the deletion request, signs a single-use confirmation
   * token, stores only its digest, and confirms customer-email delivery. The
   * raw confirmation token is deliberately absent from the HTTP result.
   */
  requestAccountDeletion(
    principal: IdentityPrincipal,
    input: Readonly<{ recentAuthToken: string }>,
    idempotencyKey: string,
  ): Promise<AccountDeletionRequestResult>;
  getAccountDeletion(
    principal: IdentityPrincipal,
  ): Promise<AccountDeletionView>;
  cancelAccountDeletion(
    principal: IdentityPrincipal,
    idempotencyKey: string,
  ): Promise<AccountDeletionView>;
  /** Atomically consumes the delivered confirmation-token digest. */
  confirmAccountDeletion(
    principal: IdentityPrincipal,
    input: Readonly<{
      deletionRequestId: UUIDv7;
      confirmationToken: string;
    }>,
    idempotencyKey: string,
  ): Promise<AccountDeletionView>;
}

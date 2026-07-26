import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  IdentityLifecycleError,
  type AccountDeletionView,
  type IdentityPrincipal,
} from '../http/identity-lifecycle-service.js';
import {
  createPostgresIdentityLifecycleService,
  type AccountDeletionMailer,
  type AccountExportObjectStore,
  type IdentityCoreGateway,
  type IdentityLifecycleRepository,
} from './postgres-identity-lifecycle-service.js';

const USER_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a2';
const SESSION_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a3';
const OTHER_SESSION_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a4';
const DEVICE_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a5';
const EXPORT_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a6';
const DELETION_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a7';
const CHALLENGE_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a8';
const PASSKEY_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a9';
const NOW = new Date('2026-07-26T08:30:00.000Z');
const principal: IdentityPrincipal = {
  userId: USER_ID,
  sessionId: SESSION_ID,
};

const session = {
  id: SESSION_ID,
  userId: USER_ID,
  deviceId: DEVICE_ID,
  createdAt: '2026-07-26T07:30:00.000Z',
  lastSeenAt: NOW.toISOString(),
  expiresAt: '2026-08-02T08:30:00.000Z',
  current: true,
  revokedAt: null,
} as const;

function gateway(): IdentityCoreGateway {
  return {
    kind: 'customer-managed-better-auth-gateway',
    capabilities: {
      profile: 'better-auth-1.6.25',
      runtimeBoundary: 'same-runtime-internal-v1-only',
      databaseBinding: 'shared-customer-postgres-identity-schema',
      accountStatusGate: 'active-only',
      sessions: 'database-persisted-signed-host-cookie',
      emailVerification: 'persisted-sha256-digest-atomic-consume',
      passwordRecovery: 'persisted-sha256-digest-atomic-consume',
      passkeys: 'webauthn-verified-public-key-only',
      oauth:
        'state-pkce-issuer-validated-customer-kms-encrypted-token-revocation',
      externalRevocation: 'idempotent',
    },
    authenticate: vi.fn(async () => principal),
    registerPassword: vi.fn(async () => ({
      status: 'verification_required' as const,
    })),
    completeEmailVerification: vi.fn(async () => ({
      status: 'verified' as const,
    })),
    loginPassword: vi.fn(async () => ({
      signedSessionCookieValue: 'signed.session-cookie-value',
      session,
    })),
    createPasskeyRegistrationOptions: vi.fn(async () => ({
      challengeId: CHALLENGE_ID,
      expiresAt: '2026-07-26T08:35:00.000Z',
      publicKey: { challenge: 'opaque' },
    })),
    verifyPasskeyRegistration: vi.fn(async () => ({
      id: PASSKEY_ID,
      displayName: 'Work laptop',
      createdAt: NOW.toISOString(),
    })),
    createPasskeyAuthenticationOptions: vi.fn(async () => ({
      challengeId: CHALLENGE_ID,
      expiresAt: '2026-07-26T08:35:00.000Z',
      publicKey: { challenge: 'opaque' },
    })),
    verifyPasskeyAuthentication: vi.fn(async () => ({
      signedSessionCookieValue: 'signed.passkey-session-cookie-value',
      session,
    })),
    startOAuth: vi.fn(async () => ({
      authorizationUrl:
        'https://accounts.example.test/authorize?state=opaque&code_challenge=opaque',
    })),
    completeOAuth: vi.fn(async () => ({
      signedSessionCookieValue: 'signed.oauth-session-cookie-value',
      session,
      returnTo: '/account/security',
    })),
    requestPasswordRecovery: vi.fn(async () => ({
      status: 'accepted' as const,
    })),
    completePasswordRecovery: vi.fn(async () => ({
      status: 'password_updated' as const,
    })),
    verifyPassword: vi.fn(async () => ({ verified: true as const })),
    revokeAllExternalCredentials: vi.fn(async () => ({
      status: 'revoked' as const,
    })),
  };
}

function repository(): IdentityLifecycleRepository {
  let deletion: AccountDeletionView = {
    id: DELETION_ID,
    status: 'pending' as const,
    requestedAt: NOW.toISOString(),
    cancellableUntil: '2026-08-02T08:30:00.000Z',
    irreversibleAt: null,
    completedAt: null,
  };
  return {
    kind: 'customer-managed-postgres-identity-repository',
    claimIdempotency: vi.fn(async () => ({ kind: 'claimed' as const })),
    completeIdempotency: vi.fn(async () => undefined),
    abandonIdempotency: vi.fn(async () => undefined),
    getCurrentSession: vi.fn(async () => session),
    listSessions: vi.fn(async () => [
      session,
      {
        ...session,
        id: OTHER_SESSION_ID,
        current: false,
      },
    ]),
    listDevices: vi.fn(async () => [
      {
        id: DEVICE_ID,
        displayName: 'Work laptop',
        platform: 'Windows',
        lastSeenAt: NOW.toISOString(),
        current: true,
      },
    ]),
    revokeSession: vi.fn(async (_principal, sessionId: string) => [
      sessionId,
    ]),
    revokeOtherSessions: vi.fn(async () => [OTHER_SESSION_ID]),
    revokeAllSessions: vi.fn(async () => [SESSION_ID, OTHER_SESSION_ID]),
    appendAudit: vi.fn(async () => undefined),
    createRecentAuthProof: vi.fn(async () => undefined),
    createAccountExport: vi.fn(async () => ({
      id: EXPORT_ID,
      status: 'processing' as const,
      requestedAt: NOW.toISOString(),
      completedAt: null,
      expiresAt: null,
      downloadUrl: null,
      sha256: null,
    })),
    captureAccountExport: vi.fn(async () => ({
      account: {
        id: USER_ID,
        email: 'person@example.test',
        displayName: 'Person',
      },
      memberships: [],
      projects: [],
      versions: [],
      audit: [],
      courses: [],
      usage: [],
      ledger: [],
    })),
    completeAccountExport: vi.fn(
      async (_principal, _exportId, artifact) => ({
        id: EXPORT_ID,
        status: 'ready' as const,
        requestedAt: NOW.toISOString(),
        completedAt: NOW.toISOString(),
        expiresAt: artifact.expiresAt,
        downloadUrl: artifact.downloadUrl,
        sha256: artifact.sha256,
      }),
    ),
    failAccountExport: vi.fn(async () => undefined),
    getAccountExport: vi.fn(async () => ({
      id: EXPORT_ID,
      status: 'ready' as const,
      requestedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      expiresAt: '2026-07-27T08:30:00.000Z',
      downloadUrl: 'https://customer-storage.example/export.json',
      sha256: 'a'.repeat(64),
    })),
    consumeRecentAuthAndCreateDeletion: vi.fn(
      async (_principal, _recentDigest, confirmationDigest) => ({
        deletion,
        confirmationDigest,
        email: 'person@example.test',
      }),
    ),
    abortAccountDeletion: vi.fn(async () => undefined),
    getAccountDeletion: vi.fn(async () => deletion),
    cancelAccountDeletion: vi.fn(async () => {
      deletion = { ...deletion, status: 'cancelled' as const };
      return deletion;
    }),
    confirmAccountDeletionAndRevoke: vi.fn(async () => {
      deletion = {
        ...deletion,
        status: 'processing' as const,
        cancellableUntil: null,
        irreversibleAt: NOW.toISOString(),
      };
      return {
        deletion,
        revokedSessionIds: [SESSION_ID, OTHER_SESSION_ID],
      };
    }),
  };
}

function exportStore(): AccountExportObjectStore & {
  checkCapacity: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
} {
  return {
    kind: 'customer-managed-byos-account-export',
    capabilities: {
      billingOwner: 'customer-or-tenant',
      quotaPolicy: 'known-available-or-fail-closed',
      integrityReceipt: 'sha256-required',
    },
    checkCapacity: vi.fn(async () => ({ available: true as const })),
    put: vi.fn(async ({ sha256 }) => ({
      status: 'stored' as const,
      downloadUrl: 'https://customer-storage.example/export.json',
      expiresAt: '2026-07-27T08:30:00.000Z',
      sha256,
    })),
  };
}

function deletionMailer(): AccountDeletionMailer & {
  checkCapacity: ReturnType<typeof vi.fn>;
  sendConfirmation: ReturnType<typeof vi.fn>;
} {
  return {
    kind: 'customer-managed-account-email-delivery',
    capabilities: {
      billingOwner: 'customer-or-tenant',
      quotaPolicy: 'known-available-or-fail-closed',
      deliveryReceipt: 'required',
    },
    checkCapacity: vi.fn(async () => ({ available: true as const })),
    sendConfirmation: vi.fn(async () => ({
      status: 'sent' as const,
      deliveryId: 'customer-delivery-1',
    })),
  };
}

function service(
  overrides: Partial<{
    gateway: IdentityCoreGateway;
    repository: IdentityLifecycleRepository;
    exportStore: AccountExportObjectStore;
    deletionMailer: AccountDeletionMailer;
  }> = {},
) {
  return createPostgresIdentityLifecycleService({
    gateway: overrides.gateway ?? gateway(),
    repository: overrides.repository ?? repository(),
    exportStore: overrides.exportStore ?? exportStore(),
    deletionMailer: overrides.deletionMailer ?? deletionMailer(),
    publicBaseUrl: 'https://api.example.edu',
    clock: () => NOW,
    randomToken: () => 'customer-generated-single-use-token',
  });
}

describe('Postgres identity lifecycle production service', () => {
  it('orchestrates Better Auth without asking the customer for the 29 route methods', async () => {
    const core = gateway();
    const value = service({ gateway: core });

    await expect(
      value.registerPassword(
        {
          email: 'person@example.test',
          password: 'correct horse battery staple',
          displayName: 'Person',
        },
        'register-key-0001',
      ),
    ).resolves.toEqual({ status: 'verification_required' });
    await expect(
      value.loginPassword(
        {
          identifier: 'person@example.test',
          password: 'correct horse battery staple',
        },
        'login-key-000001',
      ),
    ).resolves.toMatchObject({
      sessionToken: 'signed.session-cookie-value',
      session,
    });
    await expect(
      value.completeEmailVerification({ token: 'persisted-token' }),
    ).resolves.toEqual({
      status: 'verified',
      redirectTo: '/login?verified=1',
    });
    await expect(
      value.createPasskeyRegistrationOptions(
        principal,
        { displayName: 'Work laptop' },
        'passkey-key-0001',
      ),
    ).resolves.toMatchObject({ challengeId: CHALLENGE_ID });
    await expect(
      value.startOAuth(
        { provider: 'microsoft', returnTo: '/account/security' },
        'oauth-key-000001',
      ),
    ).resolves.toMatchObject({
      authorizationUrl: expect.stringContaining('code_challenge='),
    });
    await expect(
      value.requestPasswordRecovery(
        { email: 'person@example.test' },
        'recovery-key-01',
      ),
    ).resolves.toBeUndefined();

    expect(core.registerPassword).toHaveBeenCalledOnce();
    expect(vi.mocked(core.loginPassword)).toHaveBeenCalledOnce();
    expect(
      vi.mocked(core.completeEmailVerification),
    ).toHaveBeenCalledOnce();
    expect(
      vi.mocked(core.createPasskeyRegistrationOptions),
    ).toHaveBeenCalledOnce();
    expect(vi.mocked(core.startOAuth)).toHaveBeenCalledOnce();
    expect(
      vi.mocked(core.requestPasswordRecovery),
    ).toHaveBeenCalledOnce();
  });

  it('fails closed when the gateway lacks persisted single-use verification or signed-cookie capability', () => {
    const source = gateway();
    const core: IdentityCoreGateway = {
      ...source,
      capabilities: {
        ...source.capabilities,
        emailVerification: 'signed-stateless-token' as never,
      },
    };

    expect(() => service({ gateway: core })).toThrow(
      expect.objectContaining({
        code: 'IDENTITY_SERVICE_UNAVAILABLE',
      }),
    );
  });

  it('writes a real export manifest and verifies the customer BYOS integrity receipt', async () => {
    const database = repository();
    const storage = exportStore();
    const value = service({ repository: database, exportStore: storage });

    const result = await value.requestAccountExport(
      principal,
      'export-key-00001',
    );

    expect(result).toMatchObject({
      id: EXPORT_ID,
      status: 'ready',
      downloadUrl: 'https://customer-storage.example/export.json',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    const putInput = storage.put.mock.calls[0]?.[0];
    expect(putInput).toMatchObject({
      exportId: EXPORT_ID,
      userId: USER_ID,
      contentType: 'application/json',
      sha256: result.sha256,
    });
    const parsed = JSON.parse(
      new TextDecoder().decode(putInput?.bytes as Uint8Array),
    ) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      userId: USER_ID,
      generatedAt: NOW.toISOString(),
    });
    expect(
      createHash('sha256')
        .update(putInput?.bytes as Uint8Array)
        .digest('hex'),
    ).toBe(result.sha256);
    expect(
      vi.mocked(database.completeAccountExport),
    ).toHaveBeenCalledOnce();
  });

  it('does not claim an export succeeded when BYOS quota is unknown or the receipt hash differs', async () => {
    const unknownQuota = exportStore();
    unknownQuota.checkCapacity.mockResolvedValue({ available: false });
    await expect(
      service({ exportStore: unknownQuota }).requestAccountExport(
        principal,
        'export-key-00002',
      ),
    ).rejects.toMatchObject({
      code: 'IDENTITY_SERVICE_UNAVAILABLE',
    });
    expect(unknownQuota.put).not.toHaveBeenCalled();

    const badReceipt = exportStore();
    badReceipt.put.mockResolvedValue({
      status: 'stored',
      downloadUrl: 'https://customer-storage.example/export.json',
      expiresAt: '2026-07-27T08:30:00.000Z',
      sha256: '0'.repeat(64),
    });
    await expect(
      service({ exportStore: badReceipt }).requestAccountExport(
        principal,
        'export-key-00003',
      ),
    ).rejects.toMatchObject({
      code: 'IDENTITY_SERVICE_UNAVAILABLE',
    });
  });

  it('fails the export before BYOS upload when a projection contains a credential-shaped field', async () => {
    const database = repository();
    vi.mocked(database.captureAccountExport).mockResolvedValue({
      account: {
        id: USER_ID,
        email: 'person@example.test',
        displayName: 'Person',
      },
      memberships: [],
      projects: [{ id: 'project-1', access_token: 'must-not-export' }],
      versions: [],
      audit: [],
      courses: [],
      usage: [],
      ledger: [],
    });
    const storage = exportStore();

    await expect(
      service({ repository: database, exportStore: storage })
        .requestAccountExport(principal, 'export-key-00004'),
    ).rejects.toMatchObject({
      code: 'IDENTITY_SERVICE_UNAVAILABLE',
    });
    expect(storage.put).not.toHaveBeenCalled();
    expect(database.failAccountExport).toHaveBeenCalledWith(
      principal,
      EXPORT_ID,
    );
  });

  it('rejects a replayed idempotency digest without repeating the gateway side effect', async () => {
    const database = repository();
    vi.mocked(database.claimIdempotency).mockResolvedValue({
      kind: 'replay',
    });
    const core = gateway();

    await expect(
      service({ repository: database, gateway: core }).loginPassword(
        {
          identifier: 'person@example.test',
          password: 'correct horse battery staple',
        },
        'login-key-replay',
      ),
    ).rejects.toEqual(
      new IdentityLifecycleError('IDEMPOTENCY_KEY_REUSED'),
    );
    expect(core.loginPassword).not.toHaveBeenCalled();
  });

  it('requires recent auth, stores only token digests, requires a real email receipt, then revokes every credential', async () => {
    const core = gateway();
    const database = repository();
    const mailer = deletionMailer();
    const value = service({
      gateway: core,
      repository: database,
      deletionMailer: mailer,
    });

    const recent = await value.createRecentAuthProofWithPassword(
      principal,
      {
        password: 'correct horse battery staple',
        purpose: 'account-deletion',
      },
      'recent-key-0001',
    );
    const requested = await value.requestAccountDeletion(
      principal,
      { recentAuthToken: recent.recentAuthToken },
      'delete-key-0001',
    );
    expect(requested.confirmationDelivery).toEqual({
      channel: 'email',
      status: 'sent',
    });

    const creationMock = vi.mocked(
      database.consumeRecentAuthAndCreateDeletion,
    );
    const recentDigest = creationMock.mock.calls[0]?.[1];
    const confirmationDigest = creationMock.mock.calls[0]?.[2];
    expect(recentDigest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(confirmationDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(creationMock.mock.calls)).not.toContain(
      recent.recentAuthToken,
    );
    expect(mailer.sendConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        email: 'person@example.test',
        confirmationUrl: expect.stringContaining(
          'customer-generated-single-use-token',
        ),
      }),
    );

    const confirmed = await value.confirmAccountDeletion(
      principal,
      {
        deletionRequestId: DELETION_ID,
        confirmationToken: 'customer-generated-single-use-token',
      },
      'confirm-key-001',
    );
    expect(confirmed).toMatchObject({
      status: 'processing',
      irreversibleAt: NOW.toISOString(),
    });
    expect(core.revokeAllExternalCredentials).toHaveBeenCalledWith({
      userId: USER_ID,
      reason: 'account-deletion',
    });
    expect(database.confirmAccountDeletionAndRevoke).toHaveBeenCalledWith(
      principal,
      DELETION_ID,
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
  });

  it('rolls back the pending deletion and returns no fake sent status when email delivery is unconfirmed', async () => {
    const database = repository();
    const mailer = deletionMailer();
    mailer.sendConfirmation.mockResolvedValue(undefined);
    const value = service({ repository: database, deletionMailer: mailer });

    await expect(
      value.requestAccountDeletion(
        principal,
        { recentAuthToken: 'opaque-recent-proof' },
        'delete-key-0002',
      ),
    ).rejects.toEqual(
      new IdentityLifecycleError('EMAIL_PROVIDER_UNAVAILABLE'),
    );
    expect(database.abortAccountDeletion).toHaveBeenCalledWith(
      principal,
      DELETION_ID,
    );
  });

  it('does not consume recent auth when customer email quota is unknown or exhausted', async () => {
    const database = repository();
    const mailer = deletionMailer();
    mailer.checkCapacity.mockResolvedValue({ available: false });

    await expect(
      service({ repository: database, deletionMailer: mailer })
        .requestAccountDeletion(
          principal,
          { recentAuthToken: 'opaque-recent-proof' },
          'delete-key-0003',
        ),
    ).rejects.toEqual(
      new IdentityLifecycleError('EMAIL_PROVIDER_UNAVAILABLE'),
    );
    expect(
      database.consumeRecentAuthAndCreateDeletion,
    ).not.toHaveBeenCalled();
    expect(mailer.sendConfirmation).not.toHaveBeenCalled();
  });
});

export type IdentityFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type OAuthProvider = 'google' | 'github' | 'microsoft';

export interface IdentitySession {
  id: string;
  userId: string;
  deviceId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
  revokedAt: string | null;
}

export interface IdentityDevice {
  id: string;
  displayName: string;
  platform: string;
  lastSeenAt: string;
  current: boolean;
}

export interface AccountExport {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'expired';
  requestedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  downloadUrl: string | null;
  sha256: string | null;
}

export interface AccountDeletion {
  id: string;
  status: 'pending' | 'processing' | 'cancelled' | 'completed' | 'failed';
  requestedAt: string;
  cancellableUntil: string | null;
  irreversibleAt: string | null;
  completedAt: string | null;
}

export interface PasskeyOptions {
  challengeId: string;
  expiresAt: string;
  publicKey: Record<string, unknown>;
}

export interface IdentityProblem {
  type?: string;
  title?: string;
  status?: number;
  code?: string;
  detail?: string;
  requestId?: string;
}

export class IdentityApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    response: Response,
    problem: IdentityProblem,
    retryAfterSeconds: number | undefined,
  ) {
    super(problem.detail ?? problem.title ?? `Identity request failed (${response.status})`);
    this.name = 'IdentityApiError';
    this.status = response.status;
    this.code = problem.code ?? 'IDENTITY_REQUEST_FAILED';
    this.type = problem.type;
    this.requestId = problem.requestId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface IdentityClientOptions {
  apiOrigin: string;
  fetcher?: IdentityFetch;
  createIdempotencyKey?: () => string;
}

export interface IdentityClient {
  registerPassword(input: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<{ status: 'verification_required' }>;
  loginPassword(input: {
    identifier: string;
    password: string;
  }): Promise<{ session: IdentitySession }>;
  createPasskeyRegistrationOptions(input: {
    displayName?: string;
  }): Promise<PasskeyOptions>;
  verifyPasskeyRegistration(input: {
    challengeId: string;
    response: Record<string, unknown>;
    displayName?: string;
  }): Promise<{ id: string; displayName: string; createdAt: string }>;
  createPasskeyAuthenticationOptions(input: {
    identifier?: string;
  }): Promise<PasskeyOptions>;
  verifyPasskeyAuthentication(input: {
    challengeId: string;
    response: Record<string, unknown>;
  }): Promise<{ session: IdentitySession }>;
  startOAuth(
    provider: OAuthProvider,
    input: { returnTo: string },
  ): Promise<{ authorizationUrl: string }>;
  getCurrentSession(): Promise<IdentitySession>;
  listSessions(): Promise<IdentitySession[]>;
  listDevices(): Promise<IdentityDevice[]>;
  revokeSession(sessionId: string): Promise<{ revokedSessionIds: string[] }>;
  revokeOtherSessions(): Promise<{ revokedSessionIds: string[] }>;
  revokeAllSessions(): Promise<{ revokedSessionIds: string[] }>;
  logout(): Promise<void>;
  requestPasswordRecovery(input: {
    email: string;
  }): Promise<{ status: 'accepted' }>;
  completePasswordRecovery(input: {
    token: string;
    newPassword: string;
  }): Promise<{ status: 'password_updated' }>;
  verifyRecentPassword(input: {
    password: string;
  }): Promise<{ recentAuthToken: string; expiresAt: string }>;
  requestAccountExport(): Promise<AccountExport>;
  getAccountExport(exportId: string): Promise<AccountExport>;
  requestAccountDeletion(input: {
    recentAuthToken: string;
  }): Promise<{
    deletion: AccountDeletion;
    confirmationDelivery: { channel: 'email'; status: 'sent' };
  }>;
  getAccountDeletion(): Promise<AccountDeletion>;
  cancelAccountDeletion(): Promise<AccountDeletion>;
  confirmAccountDeletion(input: {
    deletionRequestId: string;
    confirmationToken: string;
  }): Promise<AccountDeletion>;
}

function normalizedApiOrigin(rawOrigin: string) {
  const origin = new URL(rawOrigin);
  const local =
    origin.hostname === 'localhost' ||
    origin.hostname === '127.0.0.1' ||
    origin.hostname === '[::1]';
  if (origin.protocol !== 'https:' && !local) {
    throw new Error('The production identity API must use HTTPS.');
  }
  origin.pathname = origin.pathname.replace(/\/+$/, '');
  origin.search = '';
  origin.hash = '';
  return origin.toString().replace(/\/$/, '');
}

function parseRetryAfter(rawValue: string | null) {
  if (rawValue === null) {
    return undefined;
  }
  const seconds = Number.parseInt(rawValue, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function parseProblem(response: Response) {
  let problem: IdentityProblem = {};
  try {
    const body: unknown = await response.json();
    if (isRecord(body)) {
      problem = {
        ...(typeof body.type === 'string' ? { type: body.type } : {}),
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        ...(typeof body.status === 'number' ? { status: body.status } : {}),
        ...(typeof body.code === 'string' ? { code: body.code } : {}),
        ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
        ...(typeof body.requestId === 'string'
          ? { requestId: body.requestId }
          : {}),
      };
    }
  } catch {
    // A deliberately generic error avoids reflecting an upstream HTML body.
  }
  return new IdentityApiError(
    response,
    problem,
    parseRetryAfter(response.headers.get('Retry-After')),
  );
}

export function createIdentityClient(
  options: IdentityClientOptions,
): IdentityClient {
  const apiOrigin = normalizedApiOrigin(options.apiOrigin);
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  const createIdempotencyKey =
    options.createIdempotencyKey ?? (() => crypto.randomUUID());

  async function request<T>(
    path: string,
    init: {
      method?: 'GET' | 'POST' | 'DELETE';
      body?: unknown;
      mutation?: boolean;
    } = {},
  ): Promise<T> {
    const headers = new Headers({ Accept: 'application/json' });
    let body: string | undefined;

    if (init.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(init.body);
    }
    if (init.mutation === true) {
      const idempotencyKey = createIdempotencyKey();
      if (idempotencyKey.trim().length === 0) {
        throw new Error('A non-empty idempotency key is required.');
      }
      headers.set('Idempotency-Key', idempotencyKey);
    }

    const response = await fetcher(`${apiOrigin}${path}`, {
      method: init.method ?? 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'manual',
      headers,
      ...(body === undefined ? {} : { body }),
    });

    if (!response.ok) {
      throw await parseProblem(response);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  const client: IdentityClient = {
    registerPassword: (input) =>
      request('/v1/auth/password/register', {
        method: 'POST',
        body: input,
        mutation: true,
      }),
    loginPassword: (input) =>
      request('/v1/auth/password/login', {
        method: 'POST',
        body: input,
        mutation: true,
      }),
    createPasskeyRegistrationOptions: (input) =>
      request('/v1/auth/passkeys/registration/options', {
        method: 'POST',
        body: input,
        mutation: true,
      }),
    verifyPasskeyRegistration: (input) =>
      request('/v1/auth/passkeys/registration/verify', {
        method: 'POST',
        body: input,
        mutation: true,
      }),
    createPasskeyAuthenticationOptions: (input) =>
      request('/v1/auth/passkeys/authentication/options', {
        method: 'POST',
        body: input,
        mutation: true,
      }),
    verifyPasskeyAuthentication: (input) =>
      request('/v1/auth/passkeys/authentication/verify', {
        method: 'POST',
        body: input,
        mutation: true,
      }),
    startOAuth: (provider, input) =>
      request(`/v1/auth/oauth/${provider}/start`, {
        method: 'POST',
        body: input,
        mutation: true,
      }),
    getCurrentSession: () => request('/v1/auth/session/current'),
    listSessions: () => request('/v1/auth/sessions'),
    listDevices: () => request('/v1/auth/devices'),
    revokeSession: (sessionId) =>
      request(`/v1/auth/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        mutation: true,
      }),
    revokeOtherSessions: () =>
      request('/v1/auth/sessions/revoke-others', {
        method: 'POST',
        body: {},
        mutation: true,
      }),
    revokeAllSessions: () =>
      request('/v1/auth/sessions/revoke-all', {
        method: 'POST',
        body: {},
        mutation: true,
      }),
    logout: () =>
      request('/v1/auth/logout', {
        method: 'POST',
        body: {},
        mutation: true,
      }),
    requestPasswordRecovery: (input) =>
      request('/v1/auth/password-recovery/request', {
        method: 'POST',
        body: input,
        mutation: true,
      }),
    completePasswordRecovery: (input) =>
      request('/v1/auth/password-recovery/complete', {
        method: 'POST',
        body: input,
        mutation: true,
      }),
    verifyRecentPassword: (input) =>
      request('/v1/auth/recent-auth/password', {
        method: 'POST',
        body: input,
        mutation: true,
      }),
    requestAccountExport: () =>
      request('/v1/account/exports', {
        method: 'POST',
        body: {},
        mutation: true,
      }),
    getAccountExport: (exportId) =>
      request(`/v1/account/exports/${encodeURIComponent(exportId)}`),
    requestAccountDeletion: (input) =>
      request('/v1/account/deletion', {
        method: 'POST',
        body: input,
        mutation: true,
      }),
    getAccountDeletion: () => request('/v1/account/deletion'),
    cancelAccountDeletion: () =>
      request('/v1/account/deletion', {
        method: 'DELETE',
        mutation: true,
      }),
    confirmAccountDeletion: (input) =>
      request('/v1/account/deletion/confirm', {
        method: 'POST',
        body: input,
        mutation: true,
      }),
  };
  return Object.freeze(client);
}

import { UUIDv7Schema } from '@zuocheng/contracts';
import { z } from 'zod';
import type {
  SessionVerificationInput,
  SessionVerifier,
} from './tenant-session.js';

const MAX_COOKIE_HEADER_BYTES = 8_192;

const BetterAuthSessionResultSchema = z.object({
  session: z.object({
    id: UUIDv7Schema,
    userId: UUIDv7Schema,
    activeTenantId: UUIDv7Schema,
    expiresAt: z.union([z.date(), z.iso.datetime()]),
  }),
  user: z.object({
    id: UUIDv7Schema,
    accountStatus: z.literal('active'),
  }),
});

export interface BetterAuthSessionApi {
  getSession(input: Readonly<{ headers: Headers }>): Promise<unknown>;
}

export class SessionVerificationUnavailableError extends Error {
  constructor() {
    super('Identity session verification is unavailable');
    this.name = 'SessionVerificationUnavailableError';
  }
}

export const PRODUCTION_SESSION_COOKIE = Object.freeze({
  name: '__Host-zuocheng.session_token',
  attributes: Object.freeze({
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  }),
} as const);

/**
 * Bridges the API authorization boundary to Better Auth's server-side
 * `getSession` API. Browser bearer credentials are deliberately unsupported:
 * the only accepted browser credential is Better Auth's host-only cookie.
 */
export class BetterAuthSessionVerifier implements SessionVerifier {
  constructor(
    private readonly api: BetterAuthSessionApi,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async verify(input: SessionVerificationInput): Promise<unknown> {
    const cookie = validCookieHeader(input.cookie);
    if (cookie === undefined) {
      return null;
    }

    let candidate: unknown;
    try {
      candidate = await this.api.getSession({
        headers: new Headers({ cookie }),
      });
    } catch {
      throw new SessionVerificationUnavailableError();
    }

    const result = BetterAuthSessionResultSchema.safeParse(candidate);
    if (!result.success) {
      return null;
    }

    const expiresAt =
      result.data.session.expiresAt instanceof Date
        ? result.data.session.expiresAt
        : new Date(result.data.session.expiresAt);
    if (
      expiresAt.getTime() <= this.clock().getTime() ||
      result.data.session.userId !== result.data.user.id
    ) {
      return null;
    }

    return {
      id: result.data.session.id,
      userId: result.data.session.userId,
      activeTenantId: result.data.session.activeTenantId,
    };
  }
}

function validCookieHeader(cookie: string | undefined): string | undefined {
  if (
    cookie === undefined ||
    cookie.length === 0 ||
    Buffer.byteLength(cookie, 'utf8') > MAX_COOKIE_HEADER_BYTES ||
    containsControlCharacter(cookie)
  ) {
    return undefined;
  }

  const sessionCookies = cookie
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) =>
      entry.startsWith(`${PRODUCTION_SESSION_COOKIE.name}=`),
    );
  if (sessionCookies.length !== 1) {
    return undefined;
  }

  const value = sessionCookies[0]?.slice(
    PRODUCTION_SESSION_COOKIE.name.length + 1,
  );
  return value === undefined || value.length === 0 ? undefined : cookie;
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

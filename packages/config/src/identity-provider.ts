import { z } from 'zod';

const MAX_TRUSTED_ORIGINS = 16;

const IdentityProviderPublicConfigurationSchema = z
  .object({
    baseURL: z.url().trim(),
    trustedOrigins: z
      .array(z.url().trim())
      .min(1)
      .max(MAX_TRUSTED_ORIGINS),
    passkey: z
      .object({
        rpId: z.string().trim().min(1),
        rpName: z.string().trim().min(1).max(128),
      })
      .strict(),
  })
  .strict();

export type IdentityProviderConfiguration = Readonly<{
  baseURL: string;
  trustedOrigins: readonly string[];
  passkey: Readonly<{
    rpId: string;
    rpName: string;
  }>;
}>;

export class IdentityProviderConfigurationError extends Error {
  constructor() {
    super('Customer identity provider public configuration is invalid');
    this.name = 'IdentityProviderConfigurationError';
  }
}

/**
 * Parses only non-secret identity metadata. OAuth, SMTP and Better Auth
 * credentials deliberately do not belong in this object.
 */
export function parseIdentityProviderConfiguration(
  input: unknown,
): IdentityProviderConfiguration {
  const parsed = IdentityProviderPublicConfigurationSchema.safeParse(input);
  if (!parsed.success) {
    throw new IdentityProviderConfigurationError();
  }

  const baseURL = parseProductionOrigin(parsed.data.baseURL);
  const trustedOrigins = parsed.data.trustedOrigins.map((origin) =>
    parseProductionOrigin(origin),
  );
  if (
    new Set(trustedOrigins).size !== trustedOrigins.length ||
    !trustedOrigins.includes(baseURL)
  ) {
    throw new IdentityProviderConfigurationError();
  }

  const rpId = parsed.data.passkey.rpId.toLowerCase();
  if (
    !isValidRelyingPartyId(rpId) ||
    !trustedOrigins.every((origin) =>
      hostnameBelongsToRelyingParty(originHostname(origin), rpId),
    )
  ) {
    throw new IdentityProviderConfigurationError();
  }

  return {
    baseURL,
    trustedOrigins,
    passkey: {
      rpId,
      rpName: parsed.data.passkey.rpName,
    },
  };
}

function parseProductionOrigin(value: string): string {
  const match = /^https:\/\/([^/?#]+)$/iu.exec(value);
  const authority = match?.[1];
  if (
    authority === undefined ||
    authority.includes('@') ||
    authority.includes('*') ||
    isLocalHostname(originHostname(value))
  ) {
    throw new IdentityProviderConfigurationError();
  }
  return value;
}

function isValidRelyingPartyId(value: string): boolean {
  if (
    value.includes('*') ||
    value.includes('/') ||
    value.includes(':') ||
    isLocalHostname(value)
  ) {
    return false;
  }
  return value
    .split('.')
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    );
}

function hostnameBelongsToRelyingParty(
  hostname: string,
  rpId: string,
): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === rpId || normalized.endsWith(`.${rpId}`);
}

function originHostname(origin: string): string {
  const authority = /^https:\/\/([^/?#]+)$/iu.exec(origin)?.[1];
  if (authority === undefined) {
    throw new IdentityProviderConfigurationError();
  }
  const bracketed = /^\[([0-9a-f:]+)\](?::\d+)?$/iu.exec(authority);
  if (bracketed?.[1] !== undefined) {
    return bracketed[1];
  }
  const hostname = /^([^:]+)(?::\d+)?$/u.exec(authority)?.[1];
  if (hostname === undefined) {
    throw new IdentityProviderConfigurationError();
  }
  return hostname;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

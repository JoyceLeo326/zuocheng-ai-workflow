export type BYOKCredentialPersistence = 'session' | 'local';

export type BYOKCredentialStoreErrorCode =
  | 'INVALID_CREDENTIAL'
  | 'STORAGE_UNAVAILABLE';

export class BYOKCredentialStoreError extends Error {
  constructor(readonly code: BYOKCredentialStoreErrorCode) {
    super(`BYOK credential operation rejected: ${code}`);
    this.name = 'BYOKCredentialStoreError';
  }
}

export type SaveBYOKCredentialInput = Readonly<{
  providerId: string;
  apiKey: string;
  persistence?: BYOKCredentialPersistence;
}>;

export interface BYOKCredentialStore {
  save(input: SaveBYOKCredentialInput): void;
  resolve(providerId: string): string | null;
  has(providerId: string): boolean;
  persistenceOf(providerId: string): BYOKCredentialPersistence | null;
  remove(providerId: string): void;
}

export type BYOKCredentialStoreOptions = Readonly<{
  sessionStorage?: Storage | null;
  localStorage?: Storage | null;
}>;

const STORAGE_PREFIX = 'zuocheng:byok:v1:';

export function createBYOKCredentialStore(
  options: BYOKCredentialStoreOptions = {},
): BYOKCredentialStore {
  const session =
    options.sessionStorage === undefined
      ? browserStorage('sessionStorage')
      : options.sessionStorage;
  const local =
    options.localStorage === undefined
      ? browserStorage('localStorage')
      : options.localStorage;

  return Object.freeze({
    save(input: SaveBYOKCredentialInput): void {
      const providerId = providerIdAt(input.providerId);
      const apiKey = apiKeyAt(input.apiKey);
      const persistence = input.persistence ?? 'session';
      if (persistence !== 'session' && persistence !== 'local') {
        throw new BYOKCredentialStoreError('INVALID_CREDENTIAL');
      }
      const target = persistence === 'session' ? session : local;
      const previous = persistence === 'session' ? local : session;
      if (target === null) {
        throw new BYOKCredentialStoreError('STORAGE_UNAVAILABLE');
      }
      const key = storageKey(providerId);
      try {
        previous?.removeItem(key);
        target.setItem(key, apiKey);
      } catch {
        throw new BYOKCredentialStoreError('STORAGE_UNAVAILABLE');
      }
    },

    resolve(providerId: string): string | null {
      const key = storageKey(providerIdAt(providerId));
      const fromSession = readCredential(session, key);
      return fromSession ?? readCredential(local, key);
    },

    has(providerId: string): boolean {
      const key = storageKey(providerIdAt(providerId));
      return (
        readCredential(session, key) !== null ||
        readCredential(local, key) !== null
      );
    },

    persistenceOf(
      providerId: string,
    ): BYOKCredentialPersistence | null {
      const key = storageKey(providerIdAt(providerId));
      if (readCredential(session, key) !== null) {
        return 'session';
      }
      return readCredential(local, key) === null ? null : 'local';
    },

    remove(providerId: string): void {
      const key = storageKey(providerIdAt(providerId));
      let failed = false;
      for (const storage of [session, local]) {
        if (storage === null) {
          continue;
        }
        try {
          storage.removeItem(key);
        } catch {
          failed = true;
        }
      }
      if (failed) {
        throw new BYOKCredentialStoreError('STORAGE_UNAVAILABLE');
      }
    },
  });
}

function browserStorage(
  name: 'sessionStorage' | 'localStorage',
): Storage | null {
  try {
    return globalThis[name] ?? null;
  } catch {
    return null;
  }
}

function readCredential(
  storage: Storage | null,
  key: string,
): string | null {
  if (storage === null) {
    return null;
  }
  let value: string | null;
  try {
    value = storage.getItem(key);
  } catch {
    throw new BYOKCredentialStoreError('STORAGE_UNAVAILABLE');
  }
  return value === null || value.length === 0 ? null : value;
}

function providerIdAt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    hasControlCharacters(value)
  ) {
    throw new BYOKCredentialStoreError('INVALID_CREDENTIAL');
  }
  return value;
}

function apiKeyAt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 16_384 ||
    value !== value.trim() ||
    hasControlCharacters(value)
  ) {
    throw new BYOKCredentialStoreError('INVALID_CREDENTIAL');
  }
  return value;
}

function storageKey(providerId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(providerId)}`;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

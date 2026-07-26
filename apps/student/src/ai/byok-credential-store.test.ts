import { describe, expect, it } from 'vitest';
import {
  BYOKCredentialStoreError,
  createBYOKCredentialStore,
} from './byok-credential-store.js';

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

describe('current-device BYOK credential store', () => {
  it('does not write until explicit save and defaults to sessionStorage', () => {
    const session = new MemoryStorage();
    const local = new MemoryStorage();
    const store = createBYOKCredentialStore({
      sessionStorage: session,
      localStorage: local,
    });
    const apiKey = 'sk-session-only';

    expect(session.length).toBe(0);
    expect(local.length).toBe(0);
    expect(store.resolve('provider-1')).toBeNull();
    expect(store.persistenceOf('provider-1')).toBeNull();

    store.save({
      providerId: 'provider-1',
      apiKey,
    });

    expect(store.resolve('provider-1')).toBe(apiKey);
    expect(store.has('provider-1')).toBe(true);
    expect(store.persistenceOf('provider-1')).toBe('session');
    expect(session.length).toBe(1);
    expect(local.length).toBe(0);
    expect(JSON.stringify(store)).not.toContain(apiKey);
  });

  it('uses localStorage only when selected and removes the previous session copy', () => {
    const session = new MemoryStorage();
    const local = new MemoryStorage();
    const store = createBYOKCredentialStore({
      sessionStorage: session,
      localStorage: local,
    });

    store.save({
      providerId: 'provider-1',
      apiKey: 'sk-first-session',
    });
    store.save({
      providerId: 'provider-1',
      apiKey: 'sk-explicit-local',
      persistence: 'local',
    });

    expect(session.length).toBe(0);
    expect(local.length).toBe(1);
    expect(store.resolve('provider-1')).toBe('sk-explicit-local');
    expect(store.persistenceOf('provider-1')).toBe('local');

    store.remove('provider-1');
    expect(store.resolve('provider-1')).toBeNull();
    expect(session.length).toBe(0);
    expect(local.length).toBe(0);
  });

  it('models session credentials as tab-scoped while explicit local credentials survive a new store', () => {
    const local = new MemoryStorage();
    const firstSession = new MemoryStorage();
    const first = createBYOKCredentialStore({
      sessionStorage: firstSession,
      localStorage: local,
    });
    first.save({
      providerId: 'session-provider',
      apiKey: 'sk-tab',
    });
    first.save({
      providerId: 'local-provider',
      apiKey: 'sk-device',
      persistence: 'local',
    });

    const nextTab = createBYOKCredentialStore({
      sessionStorage: new MemoryStorage(),
      localStorage: local,
    });

    expect(nextTab.resolve('session-provider')).toBeNull();
    expect(nextTab.resolve('local-provider')).toBe('sk-device');
  });

  it('fails closed when storage is unavailable without echoing the credential', () => {
    const apiKey = 'sk-never-in-error';
    const failingStorage: Storage = {
      get length() {
        return 0;
      },
      clear() {
        throw new Error('unavailable');
      },
      getItem() {
        throw new Error('unavailable');
      },
      key() {
        return null;
      },
      removeItem() {
        throw new Error('unavailable');
      },
      setItem() {
        throw new Error('unavailable');
      },
    };
    const store = createBYOKCredentialStore({
      sessionStorage: failingStorage,
      localStorage: null,
    });

    const sessionError = (() => {
      try {
        store.save({ providerId: 'provider-1', apiKey });
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(sessionError).toBeInstanceOf(BYOKCredentialStoreError);
    expect(sessionError).toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    expect(String(sessionError)).not.toContain(apiKey);

    expect(() =>
      store.save({
        providerId: 'provider-1',
        apiKey,
        persistence: 'local',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<BYOKCredentialStoreError>>({
        code: 'STORAGE_UNAVAILABLE',
      }),
    );
  });
});

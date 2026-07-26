import { describe, expect, it } from 'vitest';
import {
  createGitHubSyncCredentialStore,
  type KeyValueStorage,
} from './sync-credential-store.js';

function storage(): KeyValueStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe('GitHub sync credential store', () => {
  it('keeps tokens only in session storage and never serializes a passphrase', () => {
    const session = storage();
    const credentials = createGitHubSyncCredentialStore({
      sessionStorage: session,
    });

    credentials.saveToken('test-session-token-value-1234567890');
    expect(credentials.resolveToken()).toBe(
      'test-session-token-value-1234567890',
    );
    expect([...session.values.values()]).toEqual([
      'test-session-token-value-1234567890',
    ]);
    expect(JSON.stringify([...session.values])).not.toContain('passphrase');

    credentials.removeToken();
    expect(credentials.resolveToken()).toBeNull();
  });

  it('falls back to volatile memory when session storage is unavailable', () => {
    const first = createGitHubSyncCredentialStore({
      sessionStorage: null,
    });
    first.saveToken('test-memory-token-value-1234567890');
    expect(first.resolveToken()).toBe(
      'test-memory-token-value-1234567890',
    );

    const nextSession = createGitHubSyncCredentialStore({
      sessionStorage: null,
    });
    expect(nextSession.resolveToken()).toBeNull();
  });
});

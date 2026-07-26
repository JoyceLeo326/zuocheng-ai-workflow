import { SyncError } from './sync-domain.js';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface GitHubSyncCredentialStore {
  saveToken(token: string): void;
  resolveToken(): string | null;
  removeToken(): void;
}

export interface GitHubSyncCredentialStoreOptions {
  sessionStorage?: KeyValueStorage | null;
}

const TOKEN_KEY = 'zuocheng:sync:github-token:v1';

export function createGitHubSyncCredentialStore(
  options: GitHubSyncCredentialStoreOptions = {},
): GitHubSyncCredentialStore {
  const session =
    options.sessionStorage === undefined
      ? browserSessionStorage()
      : options.sessionStorage;
  let volatileToken: string | null = null;

  return Object.freeze({
    saveToken(token: string): void {
      const valid = tokenAt(token);
      if (session === null) {
        volatileToken = valid;
        return;
      }
      try {
        session.setItem(TOKEN_KEY, valid);
      } catch {
        throw new SyncError(
          'STORAGE_UNAVAILABLE',
          '无法保存本次连接，请检查浏览器存储权限。',
        );
      }
    },

    resolveToken(): string | null {
      if (session === null) {
        return volatileToken;
      }
      try {
        const token = session.getItem(TOKEN_KEY);
        return token === null ? null : tokenAt(token);
      } catch {
        throw new SyncError(
          'STORAGE_UNAVAILABLE',
          '无法读取本次连接，请重新连接。',
        );
      }
    },

    removeToken(): void {
      volatileToken = null;
      if (session === null) {
        return;
      }
      try {
        session.removeItem(TOKEN_KEY);
      } catch {
        throw new SyncError(
          'STORAGE_UNAVAILABLE',
          '无法清除本次连接，请关闭当前标签页。',
        );
      }
    },
  });
}

function tokenAt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 20 ||
    value.length > 512 ||
    value !== value.trim() ||
    hasControl(value)
  ) {
    throw new SyncError('INVALID_CREDENTIAL', '访问令牌格式无效。');
  }
  return value;
}

function browserSessionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

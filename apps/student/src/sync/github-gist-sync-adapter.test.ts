import { describe, expect, it, vi } from 'vitest';
import type { EncryptedSyncBundle } from './sync-domain.js';
import {
  GitHubGistSyncAdapter,
  SYNC_DESCRIPTOR_FILE,
} from './github-gist-sync-adapter.js';

const descriptor = {
  format: 'zuocheng-encrypted-sync' as const,
  formatVersion: 1 as const,
  revision: 'e0f1a2b3c4d5e6f7',
  projectId: '01900000-0000-7000-8000-000000000901',
  projectVersion: 4,
  projectUpdatedAt: '2026-07-27T10:00:00.000Z',
  encryptedAt: '2026-07-27T10:01:00.000Z',
  algorithm: {
    name: 'AES-GCM' as const,
    kdf: 'PBKDF2' as const,
    hash: 'SHA-256' as const,
    iterations: 310_000,
    salt: 'c2FsdA',
    iv: 'aW5pdGlhbGl6ZXI',
  },
  payload: {
    encoding: 'base64url' as const,
    chunkPaths: ['payload-0001.txt'],
    ciphertextBytes: 12,
    ciphertextSha256:
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
};

const bundle: EncryptedSyncBundle = {
  descriptor,
  encryptedFiles: {
    'payload-0001.txt': 'ZW5jcnlwdGVk',
  },
};

function response(
  body: unknown,
  init: ResponseInit & { headers?: HeadersInit } = {},
): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  });
}

describe('GitHubGistSyncAdapter', () => {
  it('verifies the token with a real authenticated GitHub request format', async () => {
    const fetcher = vi.fn(async () =>
      response({ login: 'sync-owner', id: 123 }),
    );
    const adapter = new GitHubGistSyncAdapter({ fetcher });

    await expect(
      adapter.verifyConnection(
        'test-session-token-value-1234567890',
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      login: 'sync-owner',
      userId: 123,
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer test-session-token-value-1234567890',
          'X-GitHub-Api-Version': '2022-11-28',
        }),
      }),
    );
  });

  it('creates a secret gist with the descriptor and encrypted chunks', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response(
        {
          id: 'gist-created',
          updated_at: '2026-07-27T10:02:00Z',
          files: payload.files,
        },
        { status: 201, headers: { etag: '"created-etag"' } },
      );
    });
    const adapter = new GitHubGistSyncAdapter({ fetcher });
    const uploaded = await adapter.uploadProject({
      token: 'test-session-token-value-1234567890',
      bundle,
      signal: new AbortController().signal,
    });

    expect(uploaded).toMatchObject({
      gistId: 'gist-created',
      revision: descriptor.revision,
      projectId: descriptor.projectId,
      etag: '"created-etag"',
    });
    const [, init] = fetcher.mock.calls[0]!;
    const payload = JSON.parse(String(init?.body)) as {
      public: boolean;
      files: Record<string, { content: string }>;
    };
    expect(payload.public).toBe(false);
    expect(payload.files[SYNC_DESCRIPTOR_FILE]?.content).toBe(
      `${JSON.stringify(descriptor, null, 2)}\n`,
    );
    expect(payload.files['payload-0001.txt']?.content).toBe(
      'ZW5jcnlwdGVk',
    );
    expect(JSON.stringify(payload)).not.toContain('real_token');
  });

  it('checks the current remote revision before update and sends If-Match', async () => {
    const currentDescriptor = {
      ...descriptor,
      revision: 'remote-revision-01',
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          {
            id: 'gist-existing',
            updated_at: '2026-07-27T10:02:00Z',
            files: {
              [SYNC_DESCRIPTOR_FILE]: {
                filename: SYNC_DESCRIPTOR_FILE,
                content: JSON.stringify(currentDescriptor),
                truncated: false,
              },
              'payload-old.txt': {
                filename: 'payload-old.txt',
                content: 'b2xk',
                truncated: false,
              },
            },
          },
          { headers: { etag: '"remote-etag"' } },
        ),
      )
      .mockResolvedValueOnce(
        response(
          {
            id: 'gist-existing',
            updated_at: '2026-07-27T10:03:00Z',
            files: {
              [SYNC_DESCRIPTOR_FILE]: {
                filename: SYNC_DESCRIPTOR_FILE,
                content: JSON.stringify(descriptor),
                truncated: false,
              },
            },
          },
          { headers: { etag: '"next-etag"' } },
        ),
      );
    const adapter = new GitHubGistSyncAdapter({ fetcher });

    await adapter.uploadProject({
      token: 'test-session-token-value-1234567890',
      bundle,
      gistId: 'gist-existing',
      expectedRevision: 'remote-revision-01',
      signal: new AbortController().signal,
    });

    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/gists/gist-existing',
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({
          'If-Match': '"remote-etag"',
        }),
      }),
    );
    const update = JSON.parse(
      String(fetcher.mock.calls[1]?.[1]?.body),
    ) as { files: Record<string, { content: string } | null> };
    expect(update.files['payload-old.txt']).toBeNull();
    expect(update.files['payload-0001.txt']).toEqual({
      content: 'ZW5jcnlwdGVk',
    });
  });

  it('maps authentication, rate limit, cancellation and revision failures to safe stable errors', async () => {
    const auth = new GitHubGistSyncAdapter({
      fetcher: vi.fn(async () =>
        response({ message: 'token github_pat_do_not_echo' }, { status: 401 }),
      ),
    });
    await expect(
      auth.verifyConnection(
        'test-session-token-value-1234567890',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });

    const limited = new GitHubGistSyncAdapter({
      fetcher: vi.fn(async () =>
        response(
          { message: 'limit' },
          {
            status: 403,
            headers: {
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': '1785150000',
            },
          },
        ),
      ),
    });
    await expect(
      limited.verifyConnection(
        'test-session-token-value-1234567890',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = new GitHubGistSyncAdapter({
      fetcher: vi.fn(async () => {
        throw new DOMException('aborted secret', 'AbortError');
      }),
    });
    await expect(
      cancelled.verifyConnection(
        'test-session-token-value-1234567890',
        aborted.signal,
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    const changed = new GitHubGistSyncAdapter({
      fetcher: vi.fn(async () =>
        response({
          id: 'gist-existing',
          updated_at: '2026-07-27T10:02:00Z',
          files: {
            [SYNC_DESCRIPTOR_FILE]: {
              filename: SYNC_DESCRIPTOR_FILE,
              content: JSON.stringify({
                ...descriptor,
                revision: 'changed-remotely',
              }),
              truncated: false,
            },
          },
        }),
      ),
    });
    await expect(
      changed.uploadProject({
        token: 'test-session-token-value-1234567890',
        bundle,
        gistId: 'gist-existing',
        expectedRevision: 'older-revision',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

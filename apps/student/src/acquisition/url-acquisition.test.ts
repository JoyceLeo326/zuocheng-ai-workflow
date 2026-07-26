import { describe, expect, it, vi } from 'vitest';
import {
  UrlAcquisitionService,
  createManualUrlAcquisition,
} from './url-acquisition.js';

const NOW = '2026-07-27T12:00:00.000Z';

describe('URL acquisition', () => {
  it('performs a bounded direct browser request and records source metadata, body and hash', async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        '<html><head><title>真实网页</title></head><body><main>正文内容</main></body></html>',
        {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-length': '88',
          },
        },
      ),
    );
    const service = new UrlAcquisitionService({
      fetcher,
      now: () => new Date(NOW),
      htmlExtractor: () => ({
        title: '真实网页',
        text: '正文内容',
      }),
    });

    const result = await service.acquireDirect(
      'https://example.com/article#part',
      new AbortController().signal,
    );

    expect(fetcher).toHaveBeenCalledWith(
      'https://example.com/article',
      expect.objectContaining({
        method: 'GET',
        mode: 'cors',
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: {
          Accept: 'text/html, application/xhtml+xml, text/plain;q=0.9',
        },
      }),
    );
    expect(result).toMatchObject({
      kind: 'url',
      method: 'direct',
      sourceUrl: 'https://example.com/article',
      fetchedAt: NOW,
      title: '真实网页',
      originalText: '正文内容',
      safeText: '正文内容',
    });
    expect(result.contentSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('reports CORS/network failure without returning a fabricated result', async () => {
    const service = new UrlAcquisitionService({
      fetcher: vi.fn(async () => {
        throw new TypeError('Failed to fetch private details');
      }),
    });

    await expect(
      service.acquireDirect(
        'https://example.com/article',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: 'AcquisitionError',
      code: 'CORS_OR_NETWORK',
    });
  });

  it('calls a user-configured reader endpoint with the validated URL and bearer token', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        title: 'Reader 标题',
        text: 'Reader 返回的真实正文',
      }),
    );
    const service = new UrlAcquisitionService({
      fetcher,
      now: () => new Date(NOW),
    });

    const result = await service.acquireWithReader(
      'https://example.com/article',
      {
        endpoint: 'https://reader.example.net/v1/read',
        apiKey: 'reader-user-token',
      },
      new AbortController().signal,
    );

    expect(fetcher).toHaveBeenCalledWith(
      'https://reader.example.net/v1/read',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer reader-user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://example.com/article',
        }),
      }),
    );
    expect(result).toMatchObject({
      method: 'reader',
      title: 'Reader 标题',
      originalText: 'Reader 返回的真实正文',
    });
  });

  it('creates a truthful manual fallback only from text the user supplied', async () => {
    const result = await createManualUrlAcquisition({
      url: 'https://example.com/article',
      title: '手动正文',
      text: '用户粘贴的原始内容',
      capturedAt: NOW,
      cryptoProvider: globalThis.crypto,
    });
    expect(result).toMatchObject({
      kind: 'url',
      method: 'manual',
      sourceUrl: 'https://example.com/article',
      fetchedAt: NOW,
      title: '手动正文',
      originalText: '用户粘贴的原始内容',
    });

    await expect(
      createManualUrlAcquisition({
        url: 'https://example.com/article',
        title: '',
        text: '   ',
        capturedAt: NOW,
      }),
    ).rejects.toMatchObject({ code: 'EMPTY_CONTENT' });
  });
});

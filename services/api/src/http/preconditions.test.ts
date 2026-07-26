import { describe, expect, it } from 'vitest';
import {
  HttpPreconditionError,
  createRequestFingerprint,
  formatStrongEtag,
  parseRequiredIdempotencyKey,
  parseRequiredIfMatch,
} from './preconditions.js';

describe('HTTP mutation preconditions', () => {
  it('requires a strong If-Match value and parses its version', () => {
    expect(parseRequiredIfMatch('"7"')).toBe(7);
    for (const value of [undefined, '', '*', 'W/"7"', '7', '"0"', '"01"']) {
      expect(() => parseRequiredIfMatch(value)).toThrow(HttpPreconditionError);
    }
  });

  it('distinguishes a missing precondition from an invalid value', () => {
    try {
      parseRequiredIfMatch(undefined);
      expect.unreachable('missing If-Match must fail');
    } catch (error) {
      expect(error).toMatchObject({
        status: 428,
        code: 'PRECONDITION_REQUIRED',
      });
    }

    try {
      parseRequiredIfMatch('W/"2"');
      expect.unreachable('weak If-Match must fail');
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: 'INVALID_IF_MATCH' });
    }
  });

  it('formats resource versions as strong ETags', () => {
    expect(formatStrongEtag(1)).toBe('"1"');
    expect(formatStrongEtag(42)).toBe('"42"');
    expect(() => formatStrongEtag(0)).toThrow();
  });

  it('requires bounded printable Idempotency-Key values', () => {
    expect(parseRequiredIdempotencyKey('project-create-001')).toBe(
      'project-create-001',
    );
    for (const value of [undefined, '', 'short', 'contains space', 'x'.repeat(129)]) {
      expect(() => parseRequiredIdempotencyKey(value)).toThrow(
        HttpPreconditionError,
      );
    }
  });

  it('canonicalizes object key order but binds method, path, body, and version', () => {
    const first = createRequestFingerprint({
      method: 'PATCH',
      path: '/v1/projects/01900000-0000-7000-8000-000000000001',
      ifMatch: 3,
      body: { name: '研究汇报', description: '三页' },
    });
    const reordered = createRequestFingerprint({
      method: 'PATCH',
      path: '/v1/projects/01900000-0000-7000-8000-000000000001',
      ifMatch: 3,
      body: { description: '三页', name: '研究汇报' },
    });
    const changedVersion = createRequestFingerprint({
      method: 'PATCH',
      path: '/v1/projects/01900000-0000-7000-8000-000000000001',
      ifMatch: 4,
      body: { name: '研究汇报', description: '三页' },
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(reordered).toBe(first);
    expect(changedVersion).not.toBe(first);
  });
});

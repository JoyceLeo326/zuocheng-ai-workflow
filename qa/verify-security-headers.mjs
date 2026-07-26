import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const config = JSON.parse(
  await readFile(new URL('../vercel.json', import.meta.url), 'utf8'),
);
const headers = new Map(
  config.headers
    .flatMap((rule) => rule.headers)
    .map((header) => [header.key.toLowerCase(), header.value]),
);

test('production headers block script injection and unsafe embedding', () => {
  const policy = headers.get('content-security-policy');
  assert.equal(typeof policy, 'string');
  assert.match(policy, /default-src 'self'/u);
  assert.match(policy, /script-src 'self'(?:;|$)/u);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/u);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-eval/u);
  assert.match(policy, /object-src 'none'/u);
  assert.match(policy, /frame-ancestors 'self'/u);
  assert.match(policy, /worker-src 'self' blob:/u);
});

test('production headers retain baseline transport and content protections', () => {
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(
    headers.get('referrer-policy'),
    'strict-origin-when-cross-origin',
  );
  assert.match(
    headers.get('strict-transport-security') ?? '',
    /max-age=31536000/u,
  );
});

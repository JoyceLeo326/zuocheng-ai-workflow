import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('../apps/student/public/sw.js', import.meta.url),
  'utf8',
);

test('service worker caches only the explicit app shell and static asset paths', () => {
  assert.match(source, /STATIC_PATH_PREFIXES/u);
  assert.match(source, /assets\//u);
  assert.match(source, /ocr\//u);
  assert.doesNotMatch(
    source,
    /cache\.put\(SHELL_FALLBACK,\s*response\.clone\(\)\)/u,
  );
});

test('service worker excludes private and non-cacheable requests', () => {
  for (const required of [
    "'/api/'",
    "'/v1/'",
    "'/admin/'",
    "request.cache === 'no-store'",
    "request.headers.has('Authorization')",
    'no-store|private',
  ]) {
    assert.ok(
      source.includes(required),
      `missing service worker safety rule: ${required}`,
    );
  }
});

test('service worker removes only its own previous cache versions', () => {
  assert.match(source, /key\.startsWith\(CACHE_PREFIX\)/u);
  assert.doesNotMatch(
    source,
    /\.filter\(\(key\)\s*=>\s*key\s*!==\s*SHELL_CACHE\)/u,
  );
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { scanText } from '../scripts/check-secret-shapes.mjs';

test('detects credential-shaped fixtures without flagging ordinary CSS', () => {
  const credentialShape = ['s', 'k', '-', 'fixture', '-', 'credential'].join('');
  assert.deepEqual(scanText(`token=${credentialShape}`), ['openai-compatible']);
  assert.deepEqual(scanText('mask-image: linear-gradient(#000, transparent)'), []);
});

test('tracked source contains no credential-shaped values', () => {
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['scripts/check-secret-shapes.mjs'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      stdio: 'pipe',
    });
  });
});

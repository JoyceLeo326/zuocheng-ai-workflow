import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const sourceRoot = resolve('apps/marketing');
const outputRoot = join(sourceRoot, 'dist');

const preservedHashes = {
  'styles.css': '4E2AD7E54165899F67FC22BDF6FAC90D175A40FD9C903FB1388DF6B1542937C7',
  'script.js': 'C33B6A626E93ADA4A16893DB30D0E7EABAE27FB35DDC5A1817D667F579118F3B',
  'planner.js': '55BF95685C418B34B4FA22FC8D1F8DF69753990FA9B44013ED339007C279095C',
  'cost-policy.js': '2BB073EE93BE1EDB9BEE2103D9D243054A22C177C482FA99736B44A25B2C3CD4',
};

for (const [relativePath, expectedHash] of Object.entries(preservedHashes)) {
  test(`${relativePath} 无损迁入营销应用`, async () => {
    const contents = await readFile(join(sourceRoot, relativePath));
    const actualHash = createHash('sha256').update(contents).digest('hex').toUpperCase();
    assert.equal(actualHash, expectedHash);
  });
}

test('课程手册改为同源真实下载且构建产物保留文件', async () => {
  const html = await readFile(join(sourceRoot, 'index.html'), 'utf8');
  assert.ok(html.includes('href="assets/做成-AI学习工作流.pdf"'));
  assert.doesNotMatch(html, /raw\.githubusercontent\.com[^"']+\.pdf/u);
  const sourcePdf = await readFile(join(sourceRoot, 'assets', '做成-AI学习工作流.pdf'));
  const outputPdf = await readFile(join(outputRoot, 'assets', '做成-AI学习工作流.pdf'));
  assert.deepEqual(outputPdf, sourcePdf);
});

test('公开构建采用 allowlist，不泄露 ADR、审计、计划或需求台账', async () => {
  const expectedRootFiles = [
    'assets',
    'cost-policy.js',
    'docs',
    'index.html',
    'planner.js',
    'script.js',
    'styles.css',
  ];
  assert.deepEqual((await readdir(outputRoot)).sort(), expectedRootFiles);
  assert.deepEqual((await readdir(join(outputRoot, 'docs'))).sort(), [
    'content-system.md',
    'launch-playbook.md',
    'measurement.md',
    'product-architecture.md',
    'zero-owner-cost.md',
  ]);
  await assert.rejects(access(join(outputRoot, 'docs', 'adr')));
  await assert.rejects(access(join(outputRoot, 'docs', 'audit')));
  await assert.rejects(access(join(outputRoot, 'docs', 'plans')));
  await assert.rejects(access(join(outputRoot, 'docs', 'requirements')));
});

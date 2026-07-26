import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

const sourceRoot = resolve('apps/marketing');
const outputRoot = join(sourceRoot, 'dist');

for (const relativePath of ['planner.js', 'cost-policy.js']) {
  test(`${relativePath} 无损迁入营销应用`, async () => {
    const original = await readFile(resolve(relativePath));
    const migrated = await readFile(join(sourceRoot, relativePath));
    assert.deepEqual(migrated, original);
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
    'index.html',
    'planner.js',
    'script.js',
    'styles.css',
  ];
  assert.deepEqual((await readdir(outputRoot)).sort(), expectedRootFiles);
  await assert.rejects(access(join(outputRoot, 'cost-policy.js')));
  await assert.rejects(access(join(outputRoot, 'docs')));
});

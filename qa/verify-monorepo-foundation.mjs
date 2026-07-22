import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const packagePaths = [
  'apps/marketing/package.json',
  'apps/student/package.json',
  'apps/admin/package.json',
  'services/api/package.json',
  'services/worker/package.json',
  'packages/config/package.json',
  'packages/contracts/package.json',
];

test('根工作区是锁定包管理器的私有 pnpm monorepo', async () => {
  const root = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(root.private, true);
  assert.match(root.packageManager, /^pnpm@\d+\.\d+\.\d+$/u);
  for (const script of ['build', 'lint', 'typecheck', 'test', 'verify']) {
    assert.equal(typeof root.scripts?.[script], 'string', `缺少根脚本 ${script}`);
  }

  const workspace = await readFile('pnpm-workspace.yaml', 'utf8');
  for (const pattern of ['apps/*', 'services/*', 'packages/*']) {
    assert.ok(workspace.includes(pattern), `workspace 缺少 ${pattern}`);
  }
  await access('pnpm-lock.yaml');
});

for (const path of packagePaths) {
  test(`${path} 是可构建、可类型检查的独立包`, async () => {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(manifest.private, true);
    assert.match(manifest.name, /^@zuocheng\//u);
    assert.equal(typeof manifest.scripts?.build, 'string');
    assert.equal(typeof manifest.scripts?.typecheck, 'string');
  });
}

test('共享契约导出部署模式与零成本硬门禁', async () => {
  const contracts = await readFile('packages/contracts/src/index.ts', 'utf8');
  assert.match(contracts, /local.*hosted-beta.*tenant-managed-production/su);
  assert.match(contracts, /COST_MODE/u);
  assert.match(contracts, /zero_owner_cost/u);
  assert.match(contracts, /REMOTE_UNKNOWN_QUOTA/u);
});

test('旧线上制品回写工作流被移除，CI 只读源码并运行门禁', async () => {
  await assert.rejects(access('.github/workflows/bootstrap.yml'));
  const ci = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(ci, /permissions:\s*\n\s*contents:\s*read/u);
  assert.doesNotMatch(ci, /git\s+push|contents:\s*write/u);
  for (const command of ['pnpm install --frozen-lockfile', 'pnpm verify']) {
    assert.ok(ci.includes(command), `CI 缺少 ${command}`);
  }
});

test('正式运行骨架提供健康检查、自托管和客户资源示例', async () => {
  const compose = await readFile('deploy/compose.yaml', 'utf8');
  assert.match(compose, /api:/u);
  assert.match(compose, /worker:/u);
  assert.match(compose, /postgres:/u);
  assert.match(compose, /healthcheck:/u);
  assert.match(compose, /OWNER_BILLING_MODE/u);
  await access('deploy/.env.production.example');
  await access('Dockerfile');
});

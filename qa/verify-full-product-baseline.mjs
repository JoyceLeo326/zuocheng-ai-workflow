import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const requiredDocuments = {
  'docs/audit/2026-07-23-baseline.md': [
    '# 做成■正式产品基线审计',
    '## 已验证的现状',
    '## 当前功能矩阵',
    '## 基线命令与结果',
    '## 不得冒充完成的内容',
  ],
  'docs/requirements/zuocheng-requirements.md': [
    '# 做成■需求—证据台账',
    '6B2E645ED4A3B10EBF1E40C2A56A3E8EFC3F98C0E16E6C158D60807AA7D30DD9',
    'ZC-R01',
    'ZC-R13',
    '未满足',
    '部分满足',
    '生产证据',
  ],
  'docs/adr/0001-zero-owner-cost-production.md': [
    '# ADR-0001：零所有者固定成本的正式产品架构',
    'COST_MODE=zero_owner_cost',
    'fail-closed',
    'BYOK',
    'BYOS',
    'BYOI',
    '不自动超额',
    '商业生产边界',
  ],
};

for (const [path, markers] of Object.entries(requiredDocuments)) {
  test(`${path} 存在且包含不可省略的基线内容`, async () => {
    const document = await readFile(path, 'utf8');
    for (const marker of markers) {
      assert.ok(document.includes(marker), `${path} 缺少：${marker}`);
    }
  });
}

test('需求台账覆盖终极规格的 13 个一级交付域且没有虚报完成', async () => {
  const ledger = await readFile('docs/requirements/zuocheng-requirements.md', 'utf8');
  for (let index = 1; index <= 13; index += 1) {
    const id = `ZC-R${String(index).padStart(2, '0')}`;
    assert.ok(ledger.includes(id), `缺少一级交付域 ${id}`);
  }
  assert.doesNotMatch(ledger, /\|\s*已满足\s*\|/u);
});

test('ADR 明确免费托管不等于商业 SLA，并提供正式自托管路径', async () => {
  const adr = await readFile('docs/adr/0001-zero-owner-cost-production.md', 'utf8');
  assert.match(adr, /免费托管[^\n]*不[^\n]*(商业 SLA|关键生产)/u);
  assert.match(adr, /自托管|用户组织托管/u);
  assert.match(adr, /额度[^\n]*(未知|耗尽)[^\n]*(拒绝|阻断|停止)/u);
});

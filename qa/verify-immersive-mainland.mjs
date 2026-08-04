import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const planner = require(resolve(root, 'apps/marketing/planner.js'));

const base = {
  taskName: '学院创新赛答辩',
  deadline: '2026-08-20',
  deliverable: '5 页答辩稿',
  constraints: '每天最多 35 分钟，只用已核验资料',
};

const undergraduate = planner.normalizeInput({
  ...base,
  learnerRole: 'undergraduate',
  priority: 'evidence',
  dailyMinutes: '35',
});
const postgraduate = planner.normalizeInput({
  ...base,
  learnerRole: 'postgraduate',
  priority: 'delivery',
  dailyMinutes: '60',
});

assert.equal(undergraduate.dailyMinutes, 35);
assert.notDeepEqual(
  planner.createPlan(undergraduate, { referenceDate: '2026-08-10' }),
  planner.createPlan(postgraduate, { referenceDate: '2026-08-10' }),
  'role, priority, and available time must change the plan',
);

const journey = planner.createJourney(undergraduate, [true, false, false, false, false, false, false]);
assert.deepEqual(journey.map((beat) => beat.stage), ['起点', '冲突', '选择', '结果']);
assert.match(journey.map((beat) => beat.copy).join(' '), /学院创新赛答辩/);

const markdown = planner.createMarkdown(
  undergraduate,
  planner.createPlan(undergraduate, { referenceDate: '2026-08-10' }),
  [true, false, false, false, false, false, false],
);
assert.match(markdown, /学习阶段：本科生/);
assert.match(markdown, /当前重点：证据可信/);
assert.match(markdown, /每天可投入：35 分钟/);
assert.match(markdown, /## 任务故事/);

const html = await readFile(resolve(root, 'apps/marketing/index.html'), 'utf8');
const script = await readFile(resolve(root, 'apps/marketing/script.js'), 'utf8');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const workflow = await readFile(resolve(root, '.github/workflows/deploy-pages.yml'), 'utf8');

for (const marker of ['name="learnerRole"', 'name="priority"', 'name="dailyMinutes"', 'data-task-journey']) {
  assert.match(html, new RegExp(marker));
}
assert.match(script, /createJourney/);
assert.equal(typeof pkg.scripts['build:pages'], 'string');
assert.match(workflow, /actions\/deploy-pages/);
assert.match(workflow, /dist\/pages/);

const publicUi = `${html}\n${script}`;
assert.doesNotMatch(publicUi, /零成本|0 成本|无需登录|评委|MVP|教学演示|成本与演示边界/);
assert.doesNotMatch(publicUi, /fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com/);

console.log('做成沉浸式与 Pages 契约通过');

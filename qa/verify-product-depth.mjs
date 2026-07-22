import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const qaDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(qaDir, "..");
const indexHtml = readFileSync(path.join(rootDir, "index.html"), "utf8");
const script = readFileSync(path.join(rootDir, "script.js"), "utf8");
const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
const plannerPath = path.join(rootDir, "planner.js");
const require = createRequire(import.meta.url);

function countClass(html, className) {
  const attributes = html.match(/\bclass\s*=\s*["'][^"']*["']/gi) ?? [];
  return attributes.filter((attribute) => {
    const value = attribute.replace(/^\bclass\s*=\s*["']|["']$/gi, "");
    return value.split(/\s+/).includes(className);
  }).length;
}

function countAttribute(html, attributeName) {
  return (html.match(new RegExp(`\\b${attributeName}(?:\\s*=|\\s|>)`, "gi")) ?? []).length;
}

test("hero leads with a complete local-first task launchpad", () => {
  const launchpadIndex = indexHtml.indexOf("data-task-launchpad");
  const marketingCopyIndex = indexHtml.indexOf('class="hero-copy');

  assert.ok(launchpadIndex > -1, "hero should include the task launchpad");
  assert.ok(
    launchpadIndex < marketingCopyIndex,
    "interactive launchpad should precede the marketing-led hero copy",
  );
  assert.match(indexHtml, /<form\b[^>]*\bdata-task-form\b/i);

  for (const [name, label] of [
    ["taskName", "任务名称"],
    ["deadline", "截止日期"],
    ["deliverable", "交付形式"],
    ["constraints", "关键约束"],
  ]) {
    assert.match(indexHtml, new RegExp(`name=["']${name}["']`, "i"), `missing ${label} field`);
  }

  assert.match(indexHtml, /data-task-plan/i, "launchpad needs a rendered plan region");
  assert.equal(countAttribute(indexHtml, "data-task-day"), 7, "launchpad needs seven day rows");
  assert.match(indexHtml, /data-export-plan/i, "launchpad needs Markdown export");
  assert.match(indexHtml, /data-reset-task/i, "launchpad needs a reset action");
  assert.match(
    indexHtml,
    /本地规则[^。；<]*(?:生成|规划)[^。；<]*(?:不是|并非)\s*AI/i,
    "launchpad must visibly disclose that the plan is generated locally by rules, not AI",
  );
});

test("planning engine produces a deterministic deadline-aware seven-day plan", () => {
  assert.ok(existsSync(plannerPath), "planner.js should provide testable local planning rules");
  const { createPlan, createMarkdown } = require(plannerPath);
  const input = {
    taskName: "院赛答辩",
    deadline: "2026-08-12",
    deliverable: "5 页答辩稿",
    constraints: "只用一手材料；每天 45 分钟",
  };

  const options = { referenceDate: "2026-08-06" };
  const firstPlan = createPlan(input, options);
  const secondPlan = createPlan(input, options);
  assert.deepEqual(firstPlan, secondPlan, "the same inputs must always create the same plan");
  assert.equal(firstPlan.length, 7);
  assert.deepEqual(firstPlan.map((day) => day.date), [
    "2026-08-06",
    "2026-08-07",
    "2026-08-08",
    "2026-08-09",
    "2026-08-10",
    "2026-08-11",
    "2026-08-12",
  ]);
  assert.ok(firstPlan.every((day) => day.title && day.action && day.output));
  assert.match(firstPlan[0].action, /院赛答辩/);
  assert.match(firstPlan.at(-1).output, /5 页答辩稿/);

  const markdown = createMarkdown(input, firstPlan, [true, false, true, false, false, false, false]);
  assert.match(markdown, /^# 院赛答辩｜7 天行动计划$/m);
  assert.match(markdown, /截止日期：2026-08-12/);
  assert.match(markdown, /交付形式：5 页答辩稿/);
  assert.match(markdown, /关键约束：只用一手材料；每天 45 分钟/);
  assert.equal((markdown.match(/^- \[[ x]\] 第 \d 天/gm) ?? []).length, 7);
  assert.equal((markdown.match(/^- \[x\]/gm) ?? []).length, 2);
  assert.match(markdown, /本计划由浏览器本地规则生成，并非 AI 模型输出/);
});

test("urgent deadlines keep every step between today and the deadline", () => {
  const { createPlan } = require(plannerPath);
  const input = {
    taskName: "周三答辩",
    deadline: "2026-08-12",
    deliverable: "答辩稿",
    constraints: "每天最多 45 分钟",
  };
  const plan = createPlan(input, { referenceDate: "2026-08-10" });

  assert.deepEqual(plan.map((day) => day.date), [
    "2026-08-10",
    "2026-08-10",
    "2026-08-11",
    "2026-08-11",
    "2026-08-11",
    "2026-08-12",
    "2026-08-12",
  ]);
  assert.ok(plan.every((day) => day.date >= "2026-08-10"));
  assert.equal(plan.at(-1).date, input.deadline);
});

test("past deadlines are rejected relative to the reference date", () => {
  const { createPlan } = require(plannerPath);
  assert.throws(
    () => createPlan({
      taskName: "过期任务",
      deadline: "2026-08-09",
      deliverable: "一份报告",
      constraints: "仅使用已核验资料",
    }, { referenceDate: "2026-08-10" }),
    /截止日期不能早于今天/,
  );
});

test("launchpad persists per-day progress and supports download plus reset", () => {
  assert.match(script, /zuocheng-task-v1/, "task state needs a versioned localStorage key");
  assert.match(script, /localStorage\.getItem\(/);
  assert.match(script, /localStorage\.setItem\(/);
  assert.match(script, /localStorage\.removeItem\(/);
  assert.match(script, /\$\$\(['"]\[data-task-day\]['"]\)/, "each task day needs event wiring");
  assert.match(script, /new Blob\(/, "Markdown export should create a downloadable blob");
  assert.match(script, /URL\.createObjectURL\(/);
  assert.match(script, /\.md["'`]/, "download should use a Markdown filename");
});

test("legacy authenticity and interactions remain intact", () => {
  assert.match(indexHtml, /个人作品案例/);
  assert.match(indexHtml, /教学演示/);
  assert.match(
    indexHtml,
    /问卷、访谈、反馈(?:与|和)漏斗数字[^。；]*不代表真实用户数据(?:或|，也不代表)既有运营成绩/,
  );
  assert.equal(countClass(indexHtml, "day-tab"), 7);
  assert.equal(countAttribute(indexHtml, "data-machine-button"), 1);
  assert.equal(countClass(indexHtml, "work-step"), 5);
  assert.equal(countAttribute(indexHtml, "data-work-view"), 5);
  assert.equal(countAttribute(indexHtml, "data-source"), 3);
  assert.equal(countClass(indexHtml, "slide-thumb"), 3);
  assert.equal(countAttribute(indexHtml, "data-launch-day"), 14);
  assert.equal(countClass(indexHtml, "poster"), 3);
  assert.equal(countClass(indexHtml, "story-frame"), 6);
  assert.equal(countClass(indexHtml, "copy-tab"), 3);
  assert.equal(countClass(indexHtml, "experiment-button"), 2);
  assert.equal(countAttribute(indexHtml, "data-feedback"), 3);
  assert.equal(countClass(indexHtml, "curriculum-card"), 6);
  assert.equal((indexHtml.match(/<details\b/gi) ?? []).length, 5);
});

test("README documents local planning, persistence, export, reset, and boundaries", () => {
  assert.match(readme, /^#{1,6}\s+真实性边界\s*$/m);
  assert.match(readme, /^#{1,6}\s+本地任务启动台\s*$/m);
  assert.match(readme, /7 天/);
  assert.match(readme, /localStorage/);
  assert.match(readme, /Markdown/);
  assert.match(readme, /重置/);
  assert.match(readme, /本地规则[^。；\n]*(?:不是|并非)\s*AI/);
});

import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const qaDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(qaDir, "..");
const marketing = path.join(root, "apps", "marketing");
const storyDir = path.join(marketing, "assets", "story");
const require = createRequire(import.meta.url);
const planner = require(path.join(marketing, "planner.js"));

const baseInput = {
  taskName: "学院课程答辩",
  deadline: "2026-08-20",
  deliverable: "五页答辩稿",
  constraints: "只使用已经核验的课程材料",
  learnerRole: "undergraduate",
  priority: "evidence",
  dailyMinutes: "35",
};

test("24 local WebP scenes form the visual product baseline", async () => {
  const files = (await readdir(storyDir)).filter((name) => name.endsWith(".webp")).sort();
  assert.equal(files.length, 24);
  assert.deepEqual(files.map((name) => Number(name.slice(0, 2))), Array.from({ length: 24 }, (_, index) => index + 1));
  for (const file of files) {
    const filePath = path.join(storyDir, file);
    const bytes = await readFile(filePath);
    const details = await stat(filePath);
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF", `${file} must be RIFF WebP`);
    assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP", `${file} must be WebP`);
    assert.ok(details.size >= 30_000 && details.size <= 160_000, `${file} should stay mobile-sized`);
  }
});

test("story manifest keeps a prompt, alt text, caption, and state for every scene", async () => {
  const source = await readFile(path.join(marketing, "story.js"), "utf8");
  assert.equal((source.match(/\bid:\s*\d+,/gu) ?? []).length, 24);
  assert.equal((source.match(/\bsrc:\s*"assets\/story\//gu) ?? []).length, 24);
  assert.equal((source.match(/\balt:\s*"/gu) ?? []).length, 24);
  assert.equal((source.match(/\bcaption:\s*"/gu) ?? []).length, 24);
  assert.equal((source.match(/\bprompt:\s*`/gu) ?? []).length, 24);
  assert.match(source, /undergraduate/);
  assert.match(source, /postgraduate/);
  assert.match(source, /early-career/);
  assert.match(source, /feedback/);
  assert.match(source, /rerank/);
});

test("user attributes and feedback causally reorder candidates", () => {
  const evidenceFirst = planner.createCandidates(baseInput);
  assert.equal(evidenceFirst[0].id, "evidence");

  const structureFirst = planner.createCandidates({
    ...baseInput,
    priority: "structure",
  });
  assert.equal(structureFirst[0].id, "structure");

  const deliveryFirst = planner.createCandidates({
    ...baseInput,
    learnerRole: "early-career",
    priority: "delivery",
    dailyMinutes: "20",
  });
  assert.equal(deliveryFirst[0].id, "delivery");

  const afterSlowFeedback = planner.createCandidates(baseInput, [{ type: "too-slow" }]);
  assert.equal(afterSlowFeedback[0].id, "delivery");
  const afterDenseFeedback = planner.createCandidates(baseInput, [{ type: "too-dense" }]);
  assert.equal(afterDenseFeedback[0].id, "structure");
  const afterEvidenceFeedback = planner.createCandidates(
    { ...baseInput, priority: "structure" },
    [{ type: "not-enough-evidence" }],
  );
  assert.equal(afterEvidenceFeedback[0].id, "evidence");
});

test("confirmed route creates a real, personalized handoff", () => {
  const plan = planner.createPlan(baseInput, { referenceDate: "2026-08-10" });
  const handoff = planner.createHandoffMarkdown(
    baseInput,
    plan,
    [true, false, false, false, false, false, false],
    "evidence",
    [{ type: "not-enough-evidence" }],
  );
  assert.match(handoff, /^# 学院课程答辩｜任务交付单$/mu);
  assert.match(handoff, /已确认路线/u);
  assert.match(handoff, /证据先行/u);
  assert.match(handoff, /关键判断证据不足/u);
  assert.match(handoff, /同尺候选/u);
  assert.equal((handoff.match(/匹配度/gu) ?? []).length, 4);
});

test("public UI exposes compare-confirm-download-feedback without account gating", async () => {
  const html = await readFile(path.join(marketing, "index.html"), "utf8");
  const script = await readFile(path.join(marketing, "script.js"), "utf8");
  const css = await readFile(path.join(marketing, "styles.css"), "utf8");
  const build = await readFile(path.join(marketing, "scripts", "build.mjs"), "utf8");
  const publicUi = `${html}\n${script}`;

  for (const marker of [
    "data-decision-studio",
    "data-candidate-list",
    "data-confirm-route",
    "data-download-handoff",
    "data-feedback-form",
    "data-story-image",
  ]) {
    assert.match(html, new RegExp(marker, "u"));
  }
  assert.match(script, /createCandidates/u);
  assert.match(script, /createHandoffMarkdown/u);
  assert.match(script, /new Blob/u);
  assert.match(script, /taskState\.round \+= 1/u);
  assert.match(build, /assets\/story/u);
  assert.match(build, /assets\/brand/u);
  assert.match(css, /@media \(max-width: 390px\)/u);
  assert.match(css, /env\(safe-area-inset-bottom\)/u);
  assert.match(css, /min-height:\s*44px/u);
  assert.doesNotMatch(publicUi, /零成本|0 成本|无需登录|账号稍后再说|本地起步|按需同步|评委模式|MVP|演示版/u);
  assert.doesNotMatch(publicUi, /fonts\.(?:googleapis|gstatic)\.com|cdnjs\.cloudflare\.com/u);
});

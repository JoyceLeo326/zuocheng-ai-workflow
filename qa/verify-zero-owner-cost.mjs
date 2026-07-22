import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const qaDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(qaDir, "..");
const require = createRequire(import.meta.url);
const indexHtml = readFileSync(path.join(rootDir, "index.html"), "utf8");
const script = readFileSync(path.join(rootDir, "script.js"), "utf8");
const readme = readFileSync(path.join(rootDir, "README.md"), "utf8");
const envPath = path.join(rootDir, ".env.example");
const policyPath = path.join(rootDir, "cost-policy.js");
const docsPath = path.join(rootDir, "docs", "zero-owner-cost.md");

test("zero owner cost is the real default configuration", () => {
  assert.ok(existsSync(envPath), ".env.example should declare the deployment-safe defaults");
  const envExample = readFileSync(envPath, "utf8");
  assert.match(envExample, /^COST_MODE=zero_owner_cost$/m);
  assert.match(envExample, /^ALLOW_AUTOMATIC_BILLING=false$/m);

  assert.ok(existsSync(policyPath), "cost-policy.js should expose the runtime default");
  const { DEFAULT_COST_CONFIG } = require(policyPath);
  assert.equal(DEFAULT_COST_CONFIG.COST_MODE, "zero_owner_cost");
  assert.equal(DEFAULT_COST_CONFIG.ALLOW_AUTOMATIC_BILLING, false);
  assert.deepEqual(DEFAULT_COST_CONFIG.REMOTE_PROVIDERS, []);
  assert.deepEqual(DEFAULT_COST_CONFIG.CORE_CAPABILITIES, [
    "task_planning",
    "progress_storage",
    "markdown_export",
    "task_reset",
  ]);
});

test("zero mode allows local work and refuses future paid providers", () => {
  assert.ok(existsSync(policyPath));
  const { createCostPolicy } = require(policyPath);
  const policy = createCostPolicy();

  assert.deepEqual(policy.authorize({ execution: "local", capability: "task_planning" }), {
    allowed: true,
    code: "local_zero_cost",
    ownerCost: 0,
    usage: "not_applicable",
  });
  assert.deepEqual(policy.authorize({
    execution: "remote",
    provider: "future-paid-api",
    billing: "paid",
    remainingQuota: 100,
  }), {
    allowed: false,
    code: "paid_provider_blocked",
    ownerCost: 0,
    usage: "not_applicable",
  });
});

test("remote quota is fail-closed when exhausted or unverifiable", () => {
  const { createCostPolicy } = require(policyPath);
  const policy = createCostPolicy();

  assert.equal(policy.authorize({
    execution: "remote",
    provider: "future-free-quota-api",
    billing: "free_quota",
    remainingQuota: 0,
  }).code, "quota_exhausted");
  assert.equal(policy.authorize({
    execution: "remote",
    provider: "future-free-quota-api",
    billing: "free_quota",
  }).code, "quota_unverified");
  assert.equal(policy.authorize({
    execution: "remote",
    provider: "future-free-quota-api",
    billing: "free_quota",
    remainingQuota: 1,
  }).allowed, true);
});

test("public UI visibly states cost and demonstration boundaries without fake usage", () => {
  const boundaryIndex = indexHtml.indexOf("data-cost-boundary");
  const formIndex = indexHtml.indexOf("data-task-form");
  assert.ok(boundaryIndex > -1 && boundaryIndex < formIndex, "cost boundary should precede the product form");
  assert.match(indexHtml, /项目所有者[^。<]*(?:固定成本\s*0|零固定成本)/);
  assert.match(indexHtml, /(?:零自动账单|不启用自动账单)/);
  assert.match(indexHtml, /本地\s*0\s*成本/);
  assert.match(indexHtml, /用量[^。<]*不适用/);
  assert.match(indexHtml, /个人非商业作品演示/);
  assert.match(indexHtml, /<script\s+src=["']cost-policy\.js["']><\/script>/i);
  assert.match(script, /window\.ZuochengCostPolicy/);
  assert.match(script, /createCostPolicy\(/);
  assert.doesNotMatch(script, /\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(/);
});

test("zero owner cost operations are documented with official, changeable limits", () => {
  assert.ok(existsSync(docsPath));
  const docs = readFileSync(docsPath, "utf8");
  assert.match(readme, /docs\/zero-owner-cost\.md/);
  assert.match(docs, /Vercel[^。\n]*个人[^。\n]*非商业[^。\n]*(?:作品|演示)/i);
  assert.match(docs, /商业[^。\n]*(?:Cloudflare Pages|自托管)/i);
  assert.match(docs, /配额[^。\n]*(?:变化|变更)/);
  assert.match(docs, /https:\/\/vercel\.com\/docs\/plans\/hobby/);
  assert.match(docs, /https:\/\/developers\.cloudflare\.com\/pages\/platform\/limits\//);
  assert.match(docs, /额度耗尽[^。\n]*(?:拒绝|停止|关闭)/);
  assert.doesNotMatch(docs, /真实用量[^。\n]*(?:\d+[.,]?\d*\s*(?:次|MB|GB|%))/);
});

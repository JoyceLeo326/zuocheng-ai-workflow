import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const qaDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(qaDir, "..");
const marketingDir = path.join(rootDir, "apps", "marketing");
const indexPath = path.join(marketingDir, "index.html");
const readmePath = path.join(rootDir, "README.md");
const scriptPath = path.join(marketingDir, "script.js");

const indexHtml = readFileSync(indexPath, "utf8");
const readme = readFileSync(readmePath, "utf8");
const script = readFileSync(scriptPath, "utf8");

function visibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function countClass(html, className) {
  const classAttributes = html.match(/\bclass\s*=\s*["'][^"']*["']/gi) ?? [];
  return classAttributes.filter((attribute) => {
    const value = attribute.replace(/^\bclass\s*=\s*["']|["']$/gi, "");
    return value.split(/\s+/).includes(className);
  }).length;
}

function countAttribute(html, attributeName) {
  return (html.match(new RegExp(`\\b${attributeName}(?:\\s*=|\\s|>)`, "gi")) ?? []).length;
}

function countTagWithClass(html, tagName, className) {
  const openingTags = html.match(new RegExp(`<${tagName}\\b[^>]*>`, "gi")) ?? [];
  return openingTags.filter((tag) => countClass(tag, className) === 1).length;
}

const publicPageText = visibleText(indexHtml);

assert.match(publicPageText, /独立作品/, "首页需如实说明这是独立作品");
assert.match(publicPageText, /可直接使用/, "首页需明确产品可以直接使用");
assert.match(
  publicPageText,
  /课程反馈与运营数字[^。；]*不计入真实统计/,
  "首页需明确说明示例反馈与运营数字不计入真实统计",
);
assert.doesNotMatch(
  publicPageText,
  /(?:项目所有者|固定成本|零自动账单|成本策略)/,
  "面向用户的首页不得展示内部成本约束",
);
assert.match(readme, /^#{1,6}\s+真实性边界\s*$/m, "README 需包含“真实性边界”章节");

assert.equal(countClass(indexHtml, "day-tab"), 7, "应保留 7 个 .day-tab");
assert.equal(countAttribute(indexHtml, "data-launch-day"), 14, "应保留 14 个 data-launch-day");
assert.equal(countTagWithClass(indexHtml, "article", "poster"), 3, "应保留 3 个 poster article");
assert.equal(countClass(indexHtml, "story-frame"), 6, "应保留 6 个 .story-frame");
assert.equal(countClass(indexHtml, "copy-tab"), 3, "应保留 3 个 .copy-tab");
assert.equal(countClass(indexHtml, "curriculum-card"), 6, "应保留 6 个 .curriculum-card");

const localReferences = [...indexHtml.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
  .map((match) => match[1].trim())
  .filter((reference) =>
    reference &&
    reference !== "/app/" &&
    !reference.startsWith("#") &&
    !/^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(reference) &&
    !/^(?:data|mailto|tel|javascript):/i.test(reference)
  );

for (const reference of new Set(localReferences)) {
  const cleanReference = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
  const localPath = path.resolve(marketingDir, cleanReference.replace(/^[/\\]+/, ""));
  assert.ok(
    localPath === marketingDir || localPath.startsWith(`${marketingDir}${path.sep}`),
    `本地资源引用不可越出项目目录：${reference}`,
  );
  assert.ok(existsSync(localPath), `index.html 引用的本地文件不存在：${reference}`);
}

const publicText = `${indexHtml}\n${readme}\n${script}`;
const forbiddenPatterns = [
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, "邮箱"],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/, "中国手机号"],
  [/(?<!\d)\d{17}[\dXx](?!\d)/, "身份证号"],
  [/刘佳锐/, "姓名“刘佳锐”"],
];

for (const [pattern, label] of forbiddenPatterns) {
  assert.doesNotMatch(publicText, pattern, `公开文本不得包含${label}`);
}

console.log(`Authenticity verification passed (${localReferences.length} local references checked).`);

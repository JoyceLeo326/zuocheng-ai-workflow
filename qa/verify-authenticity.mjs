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

assert.match(publicPageText, /开始一项真实任务/, "首页首屏需提供直接开始任务的入口");
assert.match(publicPageText, /进入工作台/, "首页需提供真实工作台入口");
assert.match(publicPageText, /登录/, "页头需保留可选登录入口");
assert.match(publicPageText, /注册/, "页头需保留可选注册入口");
assert.match(publicPageText, /7 天起步/, "首页需提供 7 天课程入口");
assert.match(publicPageText, /18 课/, "首页需提供 18 课课程入口");
assert.match(publicPageText, /常见问题/, "首页需提供常见问题");

for (const [pattern, label] of [
  [/传播物料/, "传播物料"],
  [/上线计划|14\s*天上线/, "上线计划"],
  [/增长与迭代|增长验证|目标漏斗/, "增长与迭代"],
  [/真实性(?:审计|边界)|独立作品|产品说明/, "作品复盘说明"],
  [/本地优先|无需登录|账号稍后再说/, "实现或账号解释"],
  [/项目所有者|固定成本|零自动账单|成本策略|零成本/, "内部成本约束"],
  [/内部架构|产品架构/, "内部架构"],
  [/课程反馈|运营数字|真实统计/, "运营复盘"],
]) {
  assert.doesNotMatch(publicPageText, pattern, `面向学生的首页不得展示${label}`);
}
assert.match(readme, /^#{1,6}\s+真实性边界\s*$/m, "README 需包含“真实性边界”章节");

assert.equal(countClass(indexHtml, "day-tab"), 7, "应保留 7 个 .day-tab");
assert.equal(countAttribute(indexHtml, "data-workflow-stage"), 6, "应展示完整六阶段工作流");
assert.ok(countAttribute(indexHtml, "data-preview-tab") >= 4, "应提供至少四个可交互功能预览");
assert.equal(countClass(indexHtml, "curriculum-card"), 6, "应保留 6 个 .curriculum-card");
assert.ok((indexHtml.match(/<details\b/gi) ?? []).length >= 5, "应至少提供五项常见问题");

const localReferences = [...indexHtml.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
  .map((match) => match[1].trim())
  .filter((reference) =>
    reference &&
    !reference.startsWith("/app/") &&
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

(function exposePlanner(root, factory) {
  const planner = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = planner;
  } else {
    root.ZuochengPlanner = planner;
  }
})(typeof globalThis === "object" ? globalThis : this, function createPlanner() {
  "use strict";

  const DAY_MS = 24 * 60 * 60 * 1000;

  function clean(value) {
    return String(value ?? "").trim().replace(/\s+/g, " ");
  }

  function parseDate(value, label) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label}格式无效`);
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
      throw new Error(`${label}无效`);
    }
    return date;
  }

  function currentLocalDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function normalizeInput(input) {
    const normalized = {
      taskName: clean(input?.taskName),
      deadline: clean(input?.deadline),
      deliverable: clean(input?.deliverable),
      constraints: clean(input?.constraints),
    };
    const missing = Object.entries(normalized)
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missing.length) throw new Error(`缺少任务字段：${missing.join(", ")}`);
    parseDate(normalized.deadline, "截止日期");
    return normalized;
  }

  function addDays(dateString, offset) {
    const date = new Date(`${dateString}T00:00:00Z`);
    return new Date(date.valueOf() + offset * DAY_MS).toISOString().slice(0, 10);
  }

  function createPlan(input, options = {}) {
    const task = normalizeInput(input);
    const referenceDate = clean(options?.referenceDate) || currentLocalDate();
    const referenceTime = parseDate(referenceDate, "参考日期").valueOf();
    const deadlineTime = parseDate(task.deadline, "截止日期").valueOf();
    const availableDays = Math.round((deadlineTime - referenceTime) / DAY_MS);
    if (availableDays < 0) throw new Error("截止日期不能早于今天");
    const rules = [
      {
        title: "定义交付标准",
        action: `把“${task.taskName}”写成可验收任务：确认使用场景、接收者与“${task.deliverable}”的完成标准。`,
        output: "一张任务定义卡",
      },
      {
        title: "收齐必要输入",
        action: `列出完成“${task.taskName}”必须使用的资料，并逐项标记来源；全程遵守：${task.constraints}。`,
        output: "一份输入与证据清单",
      },
      {
        title: "搭建交付骨架",
        action: `先安排“${task.deliverable}”的内容顺序，让每个部分只回答一个关键问题。`,
        output: "一版可复述的结构",
      },
      {
        title: "完成可检查初稿",
        action: "按骨架填入必要信息；先保证内容完整、证据可追溯，再处理表达与样式。",
        output: `${task.deliverable}初稿`,
      },
      {
        title: "逐项核验与删改",
        action: `回查数字、引用、逻辑和格式，删除不满足“${task.constraints}”的内容。`,
        output: "一张核验记录",
      },
      {
        title: "模拟真实使用",
        action: `按真实提交场景完整检查一次“${task.deliverable}”，记录卡点并完成最后修改。`,
        output: "一版候选终稿",
      },
      {
        title: "提交并沉淀模板",
        action: `在 ${task.deadline} 前完成提交，记录有效步骤与下一次可直接复用的结构。`,
        output: `可提交的${task.deliverable}`,
      },
    ];

    return rules.map((rule, index) => ({
      day: index + 1,
      date: addDays(referenceDate, Math.round((index * availableDays) / 6)),
      ...rule,
    }));
  }

  function createMarkdown(input, plan, completed = []) {
    const task = normalizeInput(input);
    if (!Array.isArray(plan) || plan.length !== 7) throw new Error("行动计划必须包含 7 天");
    const progress = Array.from({ length: 7 }, (_, index) => Boolean(completed[index]));
    const lines = [
      `# ${task.taskName}｜7 天行动计划`,
      "",
      `- 截止日期：${task.deadline}`,
      `- 交付形式：${task.deliverable}`,
      `- 关键约束：${task.constraints}`,
      `- 当前进度：${progress.filter(Boolean).length} / 7`,
      "",
      "> 本计划由浏览器本地规则生成，并非 AI 模型输出。请结合真实任务自行核验与调整。",
      "",
      "## 每日行动",
      "",
    ];

    plan.forEach((day, index) => {
      lines.push(`- [${progress[index] ? "x" : " "}] 第 ${day.day} 天｜${day.date}｜${day.title}`);
      lines.push(`  - 行动：${day.action}`);
      lines.push(`  - 当日产出：${day.output}`);
    });
    lines.push("");
    return lines.join("\n");
  }

  return Object.freeze({ createMarkdown, createPlan, normalizeInput });
});

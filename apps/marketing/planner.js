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
  const ROLE_LABELS = Object.freeze({
    undergraduate: "本科生",
    postgraduate: "研究生",
    "early-career": "初入职场",
  });
  const PRIORITY_LABELS = Object.freeze({
    evidence: "证据可信",
    structure: "结构清晰",
    delivery: "按时交付",
  });

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
    const learnerRole = ROLE_LABELS[input?.learnerRole]
      ? input.learnerRole
      : "undergraduate";
    const priority = PRIORITY_LABELS[input?.priority]
      ? input.priority
      : "evidence";
    const requestedMinutes = Number(input?.dailyMinutes || 35);
    const normalized = {
      taskName: clean(input?.taskName),
      deadline: clean(input?.deadline),
      deliverable: clean(input?.deliverable),
      constraints: clean(input?.constraints),
      learnerRole,
      priority,
      dailyMinutes: Number.isFinite(requestedMinutes)
        ? Math.min(180, Math.max(15, Math.round(requestedMinutes)))
        : 35,
    };
    const missing = ["taskName", "deadline", "deliverable", "constraints"]
      .filter((key) => !normalized[key]);
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
    const roleOpeners = {
      undergraduate: "先对照课程要求、评分点和听众期待",
      postgraduate: "先限定研究问题、论证边界和证据口径",
      "early-career": "先对齐业务目标、决策人和使用场景",
    };
    const priorityMoves = {
      evidence: "优先保留能够回到原文的位置与来源",
      structure: "优先让每一部分只回答一个关键问题",
      delivery: "优先锁定最小可交版本并控制返工范围",
    };
    const timebox = `本次控制在 ${task.dailyMinutes} 分钟内。`;
    const rules = [
      {
        title: "定义交付标准",
        action: `${roleOpeners[task.learnerRole]}，把“${task.taskName}”写成可验收任务：确认“${task.deliverable}”的完成标准。${timebox}`,
        output: "一张任务定义卡",
      },
      {
        title: "收齐必要输入",
        action: `列出完成“${task.taskName}”必须使用的资料，并逐项标记来源；${priorityMoves[task.priority]}。全程遵守：${task.constraints}。${timebox}`,
        output: "一份输入与证据清单",
      },
      {
        title: "搭建交付骨架",
        action: `先安排“${task.deliverable}”的内容顺序，${priorityMoves[task.priority]}。${timebox}`,
        output: "一版可复述的结构",
      },
      {
        title: "完成可检查初稿",
        action: `按骨架填入必要信息；先保证内容完整、证据可追溯，再处理表达与样式。${timebox}`,
        output: `${task.deliverable}初稿`,
      },
      {
        title: "逐项核验与删改",
        action: `回查数字、引用、逻辑和格式，删除不满足“${task.constraints}”的内容；${priorityMoves[task.priority]}。${timebox}`,
        output: "一张核验记录",
      },
      {
        title: "模拟真实使用",
        action: `按真实提交场景完整检查一次“${task.deliverable}”，记录卡点并完成最后修改。${timebox}`,
        output: "一版候选终稿",
      },
      {
        title: "提交并沉淀模板",
        action: `在 ${task.deadline} 前完成提交，记录有效步骤与下一次可直接复用的结构。${timebox}`,
        output: `可提交的${task.deliverable}`,
      },
    ];

    return rules.map((rule, index) => ({
      day: index + 1,
      date: addDays(referenceDate, Math.round((index * availableDays) / 6)),
      ...rule,
    }));
  }

  function createJourney(input, completed = []) {
    const task = normalizeInput(input);
    const done = Array.from({ length: 7 }, (_, index) => Boolean(completed[index]));
    const completedCount = done.filter(Boolean).length;
    const nextDay = Math.min(completedCount + 1, 7);
    return [
      {
        stage: "起点",
        title: `${ROLE_LABELS[task.learnerRole]}的真实任务`,
        copy: `要在 ${task.deadline} 前完成“${task.taskName}”，最终交付${task.deliverable}。`,
      },
      {
        stage: "冲突",
        title: `当前最需要守住${PRIORITY_LABELS[task.priority]}`,
        copy: `${task.constraints}；每天只有 ${task.dailyMinutes} 分钟可投入。`,
      },
      {
        stage: "选择",
        title: completedCount ? `继续推进第 ${nextDay} 天` : "先把完成标准写清楚",
        copy: completedCount
          ? `已经完成 ${completedCount} 个阶段，下一步只处理一项可检查产出。`
          : "把任务拆成七个可检查结果，先完成今天这一格。",
      },
      {
        stage: "结果",
        title: completedCount === 7 ? "成果已经可以带走" : "交付正在逐格成形",
        copy: completedCount === 7
          ? `${task.deliverable}已完成七步推进，可以进入最终提交。`
          : `当前完成 ${completedCount}/7；走完后得到可核验、可提交的${task.deliverable}。`,
      },
    ];
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
      `- 学习阶段：${ROLE_LABELS[task.learnerRole]}`,
      `- 当前重点：${PRIORITY_LABELS[task.priority]}`,
      `- 每天可投入：${task.dailyMinutes} 分钟`,
      `- 当前进度：${progress.filter(Boolean).length} / 7`,
      "",
      "> 交付前请回到原始资料核验事实、引用与最终格式。",
      "",
      "## 任务故事",
      "",
    ];

    createJourney(task, progress).forEach((beat) => {
      lines.push(`- **${beat.stage}｜${beat.title}**：${beat.copy}`);
    });
    lines.push("", "## 每日行动", "");

    plan.forEach((day, index) => {
      lines.push(`- [${progress[index] ? "x" : " "}] 第 ${day.day} 天｜${day.date}｜${day.title}`);
      lines.push(`  - 行动：${day.action}`);
      lines.push(`  - 当日产出：${day.output}`);
    });
    lines.push("");
    return lines.join("\n");
  }

  return Object.freeze({ createJourney, createMarkdown, createPlan, normalizeInput });
});

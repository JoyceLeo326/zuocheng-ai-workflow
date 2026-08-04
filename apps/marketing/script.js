(() => {
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const toast = (message) => {
    const node = $('[data-toast]');
    if (!node) return;
    node.textContent = message;
    node.classList.add('show');
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => node.classList.remove('show'), 2000);
  };

  const header = $('[data-header]');
  const progress = $('.scroll-progress span');
  const updateScroll = () => {
    const y = window.scrollY;
    header?.classList.toggle('scrolled', y > 24);
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (progress) progress.style.width = `${max > 0 ? (y / max) * 100 : 0}%`;
  };
  updateScroll();
  window.addEventListener('scroll', updateScroll, { passive: true });

  const menuButton = $('[data-menu-button]');
  const mobileMenu = $('[data-mobile-menu]');
  const setMenuOpen = (open) => {
    if (!menuButton || !mobileMenu) return;
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? '关闭导航' : '打开导航');
    mobileMenu.hidden = !open;
    document.body.classList.toggle('menu-open', open);
  };
  menuButton?.addEventListener('click', () => setMenuOpen(menuButton.getAttribute('aria-expanded') !== 'true'));
  $$('a', mobileMenu || document.createElement('nav')).forEach((link) => link.addEventListener('click', () => setMenuOpen(false)));
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menuButton?.getAttribute('aria-expanded') === 'true') {
      setMenuOpen(false);
      menuButton.focus();
    }
  });

  const revealNodes = $$('.reveal');
  revealNodes.forEach((node) => {
    node.style.transitionDelay = `${Number(node.dataset.delay || 0)}ms`;
  });
  if (reducedMotion || !('IntersectionObserver' in window)) {
    revealNodes.forEach((node) => node.classList.add('visible'));
  } else {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: .08, rootMargin: '0px 0px -32px' });
    revealNodes.forEach((node) => observer.observe(node));
  }

  const TASK_STORAGE_KEY = 'zuocheng-task-v1';
  const taskForm = $('[data-task-form]');
  const taskDayButtons = $$('[data-task-day]');
  const taskStatus = $('[data-task-status]');
  const exportPlanButton = $('[data-export-plan]');
  const deadlineInput = taskForm?.elements.namedItem('deadline');
  const initialTaskRows = taskDayButtons.map((button) => ({
    date: $('[data-task-date]', button)?.textContent || '',
    title: $('[data-task-day-title]', button)?.textContent || '',
    action: $('[data-task-day-action]', button)?.textContent || '',
    output: $('[data-task-day-output]', button)?.textContent || '',
  }));
  const initialJourneyRows = $$('[data-journey-beat]').map((beat) => ({
    stage: $('span', beat)?.textContent || '',
    title: $('strong', beat)?.textContent || '',
    copy: $('p', beat)?.textContent || '',
  }));
  let taskState = null;

  const localToday = () => {
    const now = new Date();
    return new Date(now.valueOf() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  if (deadlineInput) deadlineInput.min = localToday();

  const getTaskInput = () => ({
    taskName: taskForm.elements.namedItem('taskName').value,
    deadline: taskForm.elements.namedItem('deadline').value,
    deliverable: taskForm.elements.namedItem('deliverable').value,
    constraints: taskForm.elements.namedItem('constraints').value,
    learnerRole: taskForm.elements.namedItem('learnerRole').value,
    priority: taskForm.elements.namedItem('priority').value,
    dailyMinutes: taskForm.elements.namedItem('dailyMinutes').value,
  });

  const fillTaskInput = (input) => {
    Object.entries(input).forEach(([name, value]) => {
      const field = taskForm?.elements.namedItem(name);
      if (field) field.value = value;
    });
  };

  const saveTaskState = () => {
    if (!taskState) return;
    try {
      localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(taskState));
    } catch {
      if (taskStatus) taskStatus.textContent = '计划可以继续使用，但当前浏览器未能保存进度。';
    }
  };

  const renderTaskJourney = (input, completed) => {
    if (!window.ZuochengPlanner?.createJourney) return;
    const journey = window.ZuochengPlanner.createJourney(input, completed);
    $$('[data-journey-beat]').forEach((beat, index) => {
      const story = journey[index];
      if (!story) return;
      $('span', beat).textContent = story.stage;
      $('strong', beat).textContent = story.title;
      $('p', beat).textContent = story.copy;
      beat.classList.toggle('is-current', story.stage === '选择');
      beat.classList.toggle('is-complete', story.stage === '结果' && completed.every(Boolean));
    });
  };

  const renderEmptyTask = () => {
    taskDayButtons.forEach((button, index) => {
      const row = initialTaskRows[index];
      button.disabled = true;
      button.classList.remove('complete');
      button.setAttribute('aria-pressed', 'false');
      $('b', button).textContent = '□';
      $('[data-task-date]', button).textContent = row.date;
      $('[data-task-day-title]', button).textContent = row.title;
      $('[data-task-day-action]', button).textContent = row.action;
      $('[data-task-day-output]', button).textContent = row.output;
    });
    $('[data-task-plan-title]').textContent = '你的 7 天推进路径';
    $('[data-task-progress]').textContent = '0 / 7';
    $('[data-task-progress-bar]').style.width = '0%';
    $$('[data-journey-beat]').forEach((beat, index) => {
      const story = initialJourneyRows[index];
      $('span', beat).textContent = story.stage;
      $('strong', beat).textContent = story.title;
      $('p', beat).textContent = story.copy;
      beat.classList.remove('is-current', 'is-complete');
    });
    if (exportPlanButton) exportPlanButton.disabled = true;
  };

  const renderTaskState = (message) => {
    if (!taskState || !window.ZuochengPlanner) return;
    const plan = window.ZuochengPlanner.createPlan(taskState.input);
    taskDayButtons.forEach((button, index) => {
      const day = plan[index];
      const done = Boolean(taskState.completed[index]);
      button.disabled = false;
      button.classList.toggle('complete', done);
      button.setAttribute('aria-pressed', String(done));
      button.setAttribute('aria-label', `第 ${day.day} 天，${day.title}，${done ? '已完成' : '未完成'}`);
      $('b', button).textContent = done ? '■' : '□';
      $('[data-task-date]', button).textContent = `第 ${day.day} 天 · ${day.date}`;
      $('[data-task-day-title]', button).textContent = day.title;
      $('[data-task-day-action]', button).textContent = day.action;
      $('[data-task-day-output]', button).textContent = `产出：${day.output}`;
    });
    const completedCount = taskState.completed.filter(Boolean).length;
    $('[data-task-plan-title]').textContent = `${taskState.input.taskName} · 7 天计划`;
    $('[data-task-progress]').textContent = `${completedCount} / 7`;
    $('[data-task-progress-bar]').style.width = `${(completedCount / 7) * 100}%`;
    renderTaskJourney(taskState.input, taskState.completed);
    if (exportPlanButton) exportPlanButton.disabled = false;
    if (taskStatus && message) taskStatus.textContent = message;
  };

  taskForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!window.ZuochengPlanner) {
      taskStatus.textContent = '计划规则加载失败，请刷新页面后重试。';
      return;
    }
    try {
      const input = window.ZuochengPlanner.normalizeInput(getTaskInput());
      window.ZuochengPlanner.createPlan(input);
      taskState = { input, completed: Array(7).fill(false) };
      saveTaskState();
      renderTaskState('计划已生成。点击每天的任务可以记录完成状态。');
      toast('7 天行动计划已生成');
    } catch (error) {
      taskStatus.textContent = error.message || '请检查任务信息后重试。';
    }
  });

  taskDayButtons.forEach((button, index) => button.addEventListener('click', () => {
    if (!taskState) return;
    taskState.completed[index] = !taskState.completed[index];
    saveTaskState();
    renderTaskState(taskState.completed[index] ? `第 ${index + 1} 天已完成。` : `第 ${index + 1} 天已恢复为未完成。`);
  }));

  exportPlanButton?.addEventListener('click', () => {
    if (!taskState || !window.ZuochengPlanner) return;
    const plan = window.ZuochengPlanner.createPlan(taskState.input);
    const markdown = window.ZuochengPlanner.createMarkdown(taskState.input, plan, taskState.completed);
    const blob = new Blob([`\ufeff${markdown}`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeName = taskState.input.taskName.replace(/[\\/:*?"<>|]/g, '-').slice(0, 50) || '做成任务计划';
    link.href = url;
    link.download = `${safeName}-7天行动计划.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    toast('Markdown 行动计划已下载');
  });

  $('[data-reset-task]')?.addEventListener('click', () => {
    taskState = null;
    try { localStorage.removeItem(TASK_STORAGE_KEY); } catch {}
    taskForm?.reset();
    if (deadlineInput) deadlineInput.min = localToday();
    renderEmptyTask();
    if (taskStatus) taskStatus.textContent = '当前任务已重置。';
    taskForm?.elements.namedItem('taskName')?.focus();
    toast('当前任务已重置');
  });

  try {
    const savedTask = JSON.parse(localStorage.getItem(TASK_STORAGE_KEY) || 'null');
    if (savedTask?.input && Array.isArray(savedTask.completed) && savedTask.completed.length === 7) {
      const input = window.ZuochengPlanner.normalizeInput(savedTask.input);
      window.ZuochengPlanner.createPlan(input);
      taskState = { input, completed: savedTask.completed.map(Boolean) };
      fillTaskInput(input);
      renderTaskState('已恢复上次的任务和完成状态。');
    }
  } catch {
    taskState = null;
    try { localStorage.removeItem(TASK_STORAGE_KEY); } catch {}
    renderEmptyTask();
    if (taskStatus) taskStatus.textContent = '旧任务记录无法读取，已安全重置。';
  }

  const connectTabs = ({ tabSelector, panelSelector, keyOfTab, keyOfPanel, activate }) => {
    const tabs = $$(tabSelector);
    const panels = $$(panelSelector);
    const show = (key, shouldFocus = false) => {
      tabs.forEach((tab) => {
        const active = keyOfTab(tab) === key;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        if (active && shouldFocus) tab.focus();
      });
      panels.forEach((panel) => {
        const active = keyOfPanel(panel) === key;
        panel.classList.toggle('active', active);
        panel.hidden = !active;
      });
      activate?.(key);
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => show(keyOfTab(tab)));
      tab.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const nextIndex = event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        show(keyOfTab(tabs[nextIndex]), true);
      });
    });
    return show;
  };

  connectTabs({
    tabSelector: '[data-preview-tab]',
    panelSelector: '[data-preview-panel]',
    keyOfTab: (tab) => tab.dataset.previewTab,
    keyOfPanel: (panel) => panel.dataset.previewPanel,
  });

  const courseDays = [
    ['第 1 天', '把模糊待办改成可验收任务', '明确听众、形式、截止日期和必备内容，让后续所有工作都有判断标准。', '一张任务定义卡', '完成标准：其他人读完后，能准确复述你要交什么。'],
    ['第 2 天', '收齐完成任务所需的材料', '整理已有文件、课程要求和参考内容，先确认输入是否完整。', '一份材料清单', '完成标准：每份材料都有用途，缺失内容有明确补充方式。'],
    ['第 3 天', '选择能够支撑结论的原文', '从材料中圈出关键内容，记录出处和使用说明。', '一组已确认依据', '完成标准：每个核心判断至少连接一条可回查的原文。'],
    ['第 4 天', '用听众问题组织内容结构', '比较不同方案，只保留与交付目标有关的内容。', '一份锁定大纲', '完成标准：只看标题也能理解完整的讲述顺序。'],
    ['第 5 天', '完成一版可以检查的初稿', '逐页写出结论、说明、依据和讲稿，不在空白页面上反复犹豫。', '一版完整初稿', '完成标准：所有必备内容已出现，页面之间没有明显断点。'],
    ['第 6 天', '逐项检查事实、结构与表达', '回查引用、删去无依据内容，并按使用场景演练。', '一份核验记录', '完成标准：问题有处理结果，提醒项不被忽略。'],
    ['第 7 天', '导出成果并留下可复用记录', '选择需要的格式完成交付，同时保存有效结构与工作过程。', '最终交付包', '完成标准：文件可打开、可提交，关键结论能回到来源。'],
  ];

  connectTabs({
    tabSelector: '.day-tab',
    panelSelector: '[data-course-day-panel]',
    keyOfTab: (tab) => tab.dataset.day,
    keyOfPanel: () => 'shared',
    activate: (key) => {
      const day = courseDays[Number(key)];
      if (!day) return;
      $('[data-day-badge]').textContent = day[0];
      $('[data-day-title]').textContent = day[1];
      $('[data-day-description]').textContent = day[2];
      $('[data-day-output]').textContent = day[3];
      $('[data-day-proof]').textContent = day[4];
    },
  });

  $$('details', $('.faq-list') || document.createElement('div')).forEach((detail) => {
    detail.addEventListener('toggle', () => {
      if (!detail.open) return;
      $$('details', $('.faq-list')).forEach((other) => {
        if (other !== detail) other.open = false;
      });
    });
  });

  const year = $('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());
})();

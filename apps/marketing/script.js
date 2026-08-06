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
  const candidateList = $('[data-candidate-list]');
  const routeSelection = $('[data-route-selection]');
  const confirmRouteButton = $('[data-confirm-route]');
  const downloadHandoffButton = $('[data-download-handoff]');
  const decisionRound = $('[data-decision-round]');
  const feedbackForm = $('[data-feedback-form]');
  const feedbackFieldset = $('[data-feedback-fieldset]');
  const feedbackStatus = $('[data-feedback-status]');
  const storyImage = $('[data-story-image]');
  const storyCaption = $('[data-story-caption]');
  const storyChapter = $('[data-story-chapter]');
  const storyTitle = $('[data-story-title]');
  const storyIndexLabel = $('[data-story-index]');
  const storyProgress = $('[data-story-progress]');
  const heroStoryImage = $('[data-hero-story-image]');
  const heroStoryKicker = $('[data-hero-story-kicker]');
  const heroStoryCaption = $('[data-hero-story-caption]');
  const storyChapterTitles = {
    起点: '一项真实任务从冲突开始',
    定向: '你的属性会改变推进方式',
    取证: '先看清材料，再开始生成',
    比较: '每条路线都有明确代价',
    抉择: '推荐之后仍需人工确认',
    成形: '让成果逐步变得可检查',
    反馈: '让真实使用改变下一轮',
    交付: '把成果、来源与过程一起带走',
  };
  let activeStoryIndex = 0;
  let taskState = null;

  const localToday = () => {
    const now = new Date();
    return new Date(now.valueOf() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  };
  if (deadlineInput) deadlineInput.min = localToday();

  $('[data-story-previous]')?.addEventListener('click', () => {
    const scenes = window.ZuochengStory?.scenes || [];
    if (!scenes.length) return;
    const next = (activeStoryIndex - 1 + scenes.length) % scenes.length;
    renderStory(scenes[next].id);
  });
  $('[data-story-next]')?.addEventListener('click', () => {
    const scenes = window.ZuochengStory?.scenes || [];
    if (!scenes.length) return;
    const next = (activeStoryIndex + 1) % scenes.length;
    renderStory(scenes[next].id);
  });
  taskForm?.elements.namedItem('learnerRole')?.addEventListener('change', (event) => {
    renderHeroStory(roleSceneId(event.currentTarget.value));
  });
  taskForm?.elements.namedItem('priority')?.addEventListener('change', (event) => {
    renderStory(prioritySceneId(event.currentTarget.value));
  });

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

  const sceneFor = (id) => window.ZuochengStory?.get(id);

  const renderStory = (sceneId) => {
    const scenes = window.ZuochengStory?.scenes || [];
    const scene = sceneFor(sceneId);
    if (!scene || !storyImage) return;
    const index = scenes.findIndex((item) => item.id === scene.id);
    activeStoryIndex = index < 0 ? 0 : index;
    storyImage.src = scene.src;
    storyImage.alt = scene.alt;
    if (storyCaption) storyCaption.textContent = scene.caption;
    if (storyChapter) storyChapter.textContent = scene.chapter;
    if (storyTitle) storyTitle.textContent = storyChapterTitles[scene.chapter] || scene.caption;
    if (storyIndexLabel) storyIndexLabel.textContent = String(scene.id).padStart(2, '0');
    if (storyProgress) storyProgress.style.width = `${((activeStoryIndex + 1) / scenes.length) * 100}%`;
  };

  const renderHeroStory = (sceneId) => {
    const scene = sceneFor(sceneId);
    if (!scene || !heroStoryImage) return;
    heroStoryImage.src = scene.src;
    heroStoryImage.alt = scene.alt;
    if (heroStoryKicker) heroStoryKicker.textContent = `真实任务 · ${scene.chapter}`;
    if (heroStoryCaption) heroStoryCaption.textContent = scene.caption;
  };

  const roleSceneId = (role) => ({
    undergraduate: 2,
    postgraduate: 3,
    'early-career': 4,
  })[role] || 1;

  const prioritySceneId = (priority) => ({
    evidence: 5,
    structure: 6,
    delivery: 7,
  })[priority] || 8;

  const resetDecision = () => {
    if (candidateList) {
      candidateList.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'candidate-empty';
      const title = document.createElement('b');
      title.textContent = '先完成上方任务输入';
      const copy = document.createElement('p');
      copy.textContent = '系统会给出三条有明确价值和代价的候选路线。';
      empty.append(title, copy);
      candidateList.append(empty);
    }
    if (routeSelection) routeSelection.textContent = '尚未选择路线。';
    if (confirmRouteButton) confirmRouteButton.disabled = true;
    if (downloadHandoffButton) downloadHandoffButton.disabled = true;
    if (feedbackFieldset) feedbackFieldset.disabled = true;
    if (feedbackStatus) feedbackStatus.textContent = '确认路线后即可记录反馈。';
    if (decisionRound) decisionRound.textContent = '第 1 轮';
  };

  const selectRoute = (routeId) => {
    if (!taskState || !window.ZuochengPlanner) return;
    const candidates = window.ZuochengPlanner.createCandidates(taskState.input, taskState.feedback);
    const selected = candidates.find((candidate) => candidate.id === routeId);
    if (!selected) return;
    taskState.selectedRouteId = selected.id;
    taskState.confirmed = false;
    $$('[data-route-id]', candidateList || document).forEach((card) => {
      card.classList.toggle('is-selected', card.dataset.routeId === selected.id);
    });
    if (routeSelection) routeSelection.textContent = `已选择“${selected.label}”，请确认后生成交付单。`;
    if (confirmRouteButton) confirmRouteButton.disabled = false;
    if (downloadHandoffButton) downloadHandoffButton.disabled = true;
    if (feedbackFieldset) feedbackFieldset.disabled = true;
    renderStory(selected.sceneIds[0]);
    saveTaskState();
  };

  const createCandidateCard = (candidate) => {
    const card = document.createElement('label');
    card.className = 'candidate-card';
    card.dataset.routeId = candidate.id;
    if (taskState?.selectedRouteId === candidate.id) card.classList.add('is-selected');

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'routeCandidate';
    input.value = candidate.id;
    input.checked = taskState?.selectedRouteId === candidate.id;
    input.setAttribute('aria-label', `选择${candidate.label}`);

    const copy = document.createElement('span');
    copy.className = 'candidate-card__copy';
    const title = document.createElement('b');
    title.textContent = `${candidate.rank}. ${candidate.label}`;
    const promise = document.createElement('p');
    promise.textContent = candidate.promise;
    const tradeoff = document.createElement('p');
    tradeoff.textContent = `代价：${candidate.tradeoff}`;
    const reason = document.createElement('small');
    reason.textContent = candidate.reason;
    copy.append(title, promise, tradeoff, reason);

    const score = document.createElement('span');
    score.className = 'candidate-card__score';
    score.textContent = `匹配 ${candidate.fit}`;
    card.append(input, copy, score);

    if (candidate.recommended) {
      const badge = document.createElement('span');
      badge.className = 'candidate-card__badge';
      badge.textContent = '当前推荐';
      card.append(badge);
    }

    input.addEventListener('change', () => selectRoute(candidate.id));
    input.addEventListener('focus', () => renderStory(candidate.sceneIds[0]));
    card.addEventListener('pointerenter', () => renderStory(candidate.sceneIds[0]));
    return card;
  };

  const renderDecision = (message = '') => {
    if (!taskState || !window.ZuochengPlanner || !candidateList) {
      resetDecision();
      return;
    }
    taskState.feedback = Array.isArray(taskState.feedback) ? taskState.feedback : [];
    taskState.round = Number.isSafeInteger(taskState.round) && taskState.round > 0 ? taskState.round : 1;
    taskState.selectedRouteId = typeof taskState.selectedRouteId === 'string' ? taskState.selectedRouteId : null;
    taskState.confirmed = Boolean(taskState.confirmed && taskState.selectedRouteId);
    const candidates = window.ZuochengPlanner.createCandidates(taskState.input, taskState.feedback);
    candidateList.replaceChildren(...candidates.map(createCandidateCard));
    if (decisionRound) decisionRound.textContent = `第 ${taskState.round} 轮`;
    const selected = candidates.find((candidate) => candidate.id === taskState.selectedRouteId);
    if (selected) {
      if (routeSelection) {
        routeSelection.textContent = taskState.confirmed
          ? `已确认“${selected.label}”：${selected.firstMove}`
          : `已选择“${selected.label}”，请确认后生成交付单。`;
      }
      renderStory(taskState.confirmed ? 18 : selected.sceneIds[0]);
    } else {
      taskState.confirmed = false;
      taskState.selectedRouteId = null;
      if (routeSelection) routeSelection.textContent = `当前推荐“${candidates[0].label}”，仍需由你选择并确认。`;
      renderStory(taskState.feedback.length ? 23 : 17);
    }
    if (confirmRouteButton) confirmRouteButton.disabled = !selected || taskState.confirmed;
    if (downloadHandoffButton) downloadHandoffButton.disabled = !taskState.confirmed;
    if (feedbackFieldset) feedbackFieldset.disabled = !taskState.confirmed;
    if (feedbackStatus) {
      feedbackStatus.textContent = message || (taskState.confirmed
        ? '已确认。演练后可把一项具体反馈送入下一轮。'
        : '选择并确认路线后，才能生成本轮交付单。');
    }
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
    resetDecision();
    renderStory(1);
    renderHeroStory(1);
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
    renderHeroStory(prioritySceneId(taskState.input.priority));
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
      taskState = {
        input,
        completed: Array(7).fill(false),
        selectedRouteId: null,
        confirmed: false,
        feedback: [],
        round: 1,
      };
      saveTaskState();
      renderTaskState('计划已生成。点击每天的任务可以记录完成状态。');
      renderDecision('三条路线已按你的阶段、重点与时间重新排序。');
      renderStory(prioritySceneId(input.priority));
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
    const completedCount = taskState.completed.filter(Boolean).length;
    const progressScenes = [
      prioritySceneId(taskState.input.priority),
      9,
      10,
      17,
      taskState.confirmed ? 18 : 17,
      19,
      20,
      24,
    ];
    renderStory(progressScenes[completedCount]);
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

  confirmRouteButton?.addEventListener('click', () => {
    if (!taskState?.selectedRouteId) return;
    taskState.confirmed = true;
    saveTaskState();
    renderDecision('路线已确认。任务交付单已可下载；演练后可继续反馈。');
    renderStory(18);
    toast('推进路线已确认');
  });

  downloadHandoffButton?.addEventListener('click', () => {
    if (!taskState?.confirmed || !taskState.selectedRouteId || !window.ZuochengPlanner) return;
    const plan = window.ZuochengPlanner.createPlan(taskState.input);
    const markdown = window.ZuochengPlanner.createHandoffMarkdown(
      taskState.input,
      plan,
      taskState.completed,
      taskState.selectedRouteId,
      taskState.feedback,
    );
    const blob = new Blob([`\ufeff${markdown}`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeName = taskState.input.taskName.replace(/[\\/:*?"<>|]/g, '-').slice(0, 50) || '做成任务';
    link.href = url;
    link.download = `${safeName}-任务交付单.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    renderStory(19);
    toast('任务交付单已下载');
  });

  feedbackForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!taskState?.confirmed) return;
    const feedbackType = new FormData(feedbackForm).get('feedbackType');
    if (typeof feedbackType !== 'string' || !feedbackType) {
      if (feedbackStatus) feedbackStatus.textContent = '请选择一项具体反馈。';
      return;
    }
    taskState.feedback = [...(taskState.feedback || []), { type: feedbackType, round: taskState.round }];
    taskState.round += 1;
    taskState.selectedRouteId = null;
    taskState.confirmed = false;
    feedbackForm.reset();
    saveTaskState();
    renderDecision('反馈已进入下一轮：推荐、理由和匹配度都已重排，请重新选择。');
    renderStory(23);
    toast('下一轮路线已重排');
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
      taskState = {
        input,
        completed: savedTask.completed.map(Boolean),
        selectedRouteId: typeof savedTask.selectedRouteId === 'string' ? savedTask.selectedRouteId : null,
        confirmed: Boolean(savedTask.confirmed),
        feedback: Array.isArray(savedTask.feedback) ? savedTask.feedback : [],
        round: Number.isSafeInteger(savedTask.round) && savedTask.round > 0 ? savedTask.round : 1,
      };
      fillTaskInput(input);
      renderTaskState('已恢复上次的任务和完成状态。');
      renderDecision('已恢复上次确认、反馈与候选排序。');
    } else {
      renderEmptyTask();
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

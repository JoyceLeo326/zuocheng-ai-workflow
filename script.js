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
    toast.timer = window.setTimeout(() => node.classList.remove('show'), 1800);
  };

  // Page chrome
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
  menuButton?.addEventListener('click', () => {
    const open = menuButton.getAttribute('aria-expanded') === 'true';
    menuButton.setAttribute('aria-expanded', String(!open));
    menuButton.setAttribute('aria-label', open ? '打开导航' : '关闭导航');
    mobileMenu.hidden = open;
  });
  $$('a', mobileMenu || document.createElement('div')).forEach(link => link.addEventListener('click', () => {
    mobileMenu.hidden = true;
    menuButton?.setAttribute('aria-expanded', 'false');
  }));

  // Scroll reveal
  const revealNodes = $$('.reveal');
  revealNodes.forEach(node => {
    const delay = Number(node.dataset.delay || 0);
    node.style.transitionDelay = `${delay}ms`;
  });
  if (reducedMotion || !('IntersectionObserver' in window)) {
    revealNodes.forEach(node => node.classList.add('visible'));
  } else {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: .11, rootMargin: '0px 0px -40px' });
    revealNodes.forEach(node => observer.observe(node));
  }

  // Hero machine
  const machineButton = $('[data-machine-button]');
  machineButton?.addEventListener('click', () => {
    if (machineButton.classList.contains('running')) return;
    const label = $('[data-machine-label]', machineButton);
    const symbol = $('.button-square', machineButton);
    machineButton.classList.remove('done');
    machineButton.classList.add('running');
    label.textContent = '正在拆解任务…';
    symbol.textContent = '□';
    window.setTimeout(() => { label.textContent = '正在绑定依据…'; }, reducedMotion ? 0 : 650);
    window.setTimeout(() => { label.textContent = '正在组装页面…'; }, reducedMotion ? 0 : 1250);
    window.setTimeout(() => {
      machineButton.classList.remove('running');
      machineButton.classList.add('done');
      label.textContent = '已得到 3 页可讲版本';
      symbol.textContent = '■';
      toast('任务已从 □ 推进到 ■');
    }, reducedMotion ? 20 : 1900);
  });

  // 7-day path
  const days = [
    {
      badge: '第一天', time: '预计 35 分钟', title: '把“做个汇报”改写成可验收的任务',
      desc: '确认听众、时长、页数和老师评分点。任务越具体，AI 的输出越不容易跑偏。',
      output: '一张任务定义卡', proof: '完成标准：其他人看卡片后，能复述你要交什么。',
      steps: ['写下原始任务', '补齐四个约束', '生成验收清单']
    },
    {
      badge: '第二天', time: '预计 40 分钟', title: '只留下能支撑结论的资料',
      desc: '不追求“搜得多”，而是区分一手数据、可信解释与待核验观点，并记录每条内容的原始位置。',
      output: '六张证据卡', proof: '完成标准：每条核心观点至少绑定一处可追溯来源。',
      steps: ['列检索问题', '筛选可信来源', '绑定原文位置']
    },
    {
      badge: '第三天', time: '预计 35 分钟', title: '让听众的问题决定内容顺序',
      desc: '把资料重新排列为“发生了什么—为什么重要—可以怎么做”，删除与主线无关的信息。',
      output: '一张三段式叙事图', proof: '完成标准：只看标题就能理解完整故事。',
      steps: ['写三个听众问题', '每题匹配证据', '删掉旁支信息']
    },
    {
      badge: '第四天', time: '预计 45 分钟', title: '先出能讲的版本，再做漂亮的版本',
      desc: '用明确字段让 AI 生成页面初稿：页面结论、支撑证据、图形建议和讲述备注，避免一句话让它“做个 PPT”。',
      output: '三页内容初稿', proof: '完成标准：每一页只有一个结论，且能在 60 秒内讲清。',
      steps: ['填写页面字段', '生成两个备选', '保留更清楚版本']
    },
    {
      badge: '第五天', time: '预计 30 分钟', title: '把流畅的内容重新当成可疑内容检查',
      desc: '逐项核对数字、因果、引用和措辞。AI 负责提醒遗漏，人负责决定什么可以进入最终版本。',
      output: '一张核验记录', proof: '完成标准：所有数字、引用和关键判断都有处理结果。',
      steps: ['回查数字来源', '区分相关与因果', '删掉无依据表达']
    },
    {
      badge: '第六天', time: '预计 35 分钟', title: '真的讲一次，找到页面里藏着的卡点',
      desc: '计时演练并录音，标记超过 20 秒仍讲不清的页面。根据口语反馈调整标题、信息量和转场。',
      output: '一次计时演练', proof: '完成标准：在规定时间内讲完，且不需要逐字读屏幕。',
      steps: ['完整计时一遍', '标记卡顿位置', '重写转场句']
    },
    {
      badge: '第七天', time: '预计 40 分钟', title: '交出去，并把这次路径留给下一次',
      desc: '导出汇报、讲稿与来源索引；复盘哪个步骤最耗时，将有效做法沉淀为可复制的个人任务模板。',
      output: '一个完整交付包', proof: '完成标准：能提交、能讲述、能说明依据、能再次复用。',
      steps: ['完成最终导出', '记录老师反馈', '保存任务模板']
    }
  ];

  let selectedDay = 0;
  let completedDays;
  try {
    completedDays = new Set(JSON.parse(localStorage.getItem('zuocheng-days') || '[0]'));
  } catch (_) {
    completedDays = new Set([0]);
  }
  if (!completedDays.size) completedDays.add(0);

  const renderPathProgress = () => {
    $$('.day-tab').forEach((tab, index) => {
      const icon = $('i', tab);
      if (icon) icon.textContent = completedDays.has(index) ? '■' : '□';
    });
    const count = completedDays.size;
    const bar = $('[data-path-progress]');
    const label = $('[data-path-count]');
    if (bar) bar.style.width = `${(count / 7) * 100}%`;
    if (label) label.textContent = `${count} / 7`;
    const completeButton = $('[data-complete-day]');
    const isDone = completedDays.has(selectedDay);
    completeButton?.classList.toggle('done', isDone);
    if (completeButton) {
      $('span', completeButton).textContent = isDone ? '今天已完成' : '标记今天完成';
      $('b', completeButton).textContent = isDone ? '■' : '□';
    }
  };

  const selectDay = (index) => {
    selectedDay = index;
    const day = days[index];
    $$('.day-tab').forEach((tab, tabIndex) => {
      const active = tabIndex === index;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    $('[data-day-badge]').textContent = day.badge;
    $('[data-day-time]').textContent = day.time;
    $('[data-day-title]').textContent = day.title;
    $('[data-day-desc]').textContent = day.desc;
    $('[data-day-output]').textContent = day.output;
    $('[data-day-proof]').textContent = day.proof;
    const stepNodes = $$('[data-day-steps] div span');
    stepNodes.forEach((node, stepIndex) => { node.textContent = day.steps[stepIndex]; });
    renderPathProgress();
  };

  $$('.day-tab').forEach(tab => tab.addEventListener('click', () => selectDay(Number(tab.dataset.day))));
  $('[data-complete-day]')?.addEventListener('click', () => {
    if (completedDays.has(selectedDay)) {
      completedDays.delete(selectedDay);
    } else {
      completedDays.add(selectedDay);
    }
    try { localStorage.setItem('zuocheng-days', JSON.stringify([...completedDays])); } catch (_) {}
    renderPathProgress();
    toast(completedDays.has(selectedDay) ? `${days[selectedDay].badge}已完成` : `${days[selectedDay].badge}已取消完成`);
  });
  selectDay(0);

  // Lesson workbench
  const workMeta = [
    ['交付定义', '这 3 页需要让同学记住什么？', '一 / 五', '先定义结果，避免边做边换方向。'],
    ['证据标记', '哪些内容真的能支撑你的判断？', '二 / 五', '点选资料页签，保留数字与观点的原始位置。'],
    ['叙事结构', '先讲什么，听众才愿意继续听？', '三 / 五', '让三个页面回答三个连续问题。'],
    ['页面组装', '把证据压成一页一个结论', '四 / 五', '切换页面，检查标题是否表达清楚结论。'],
    ['核验导出', '最后一次检查：正确、清楚、讲得完', '五 / 五', '所有待确认项处理完，再导出交付包。']
  ];
  let workIndex = 0;
  const renderWorkStep = (index) => {
    workIndex = Math.max(0, Math.min(4, index));
    $$('[data-work-step]').forEach((button, buttonIndex) => {
      button.classList.toggle('active', buttonIndex === workIndex);
      button.classList.toggle('complete', buttonIndex < workIndex);
      const icon = $('b', button);
      if (icon) icon.textContent = buttonIndex <= workIndex ? '■' : '□';
    });
    $$('[data-work-view]').forEach((view, viewIndex) => {
      const active = viewIndex === workIndex;
      view.hidden = !active;
      view.classList.toggle('active', active);
    });
    $('[data-work-kicker]').textContent = workMeta[workIndex][0];
    $('[data-work-title]').textContent = workMeta[workIndex][1];
    $('[data-work-count]').textContent = workMeta[workIndex][2];
    $('[data-work-hint]').textContent = workMeta[workIndex][3];
    const prev = $('[data-work-prev]');
    const next = $('[data-work-next]');
    if (prev) prev.disabled = workIndex === 0;
    if (next) next.textContent = workIndex === 4 ? '完成这一课 ■' : '保存并继续 →';
  };
  $$('[data-work-step]').forEach(button => button.addEventListener('click', () => renderWorkStep(Number(button.dataset.workStep))));
  $('[data-work-prev]')?.addEventListener('click', () => renderWorkStep(workIndex - 1));
  $('[data-work-next]')?.addEventListener('click', () => {
    if (workIndex === 4) {
      toast('第一课已从 □ 推进到 ■');
      return;
    }
    renderWorkStep(workIndex + 1);
  });

  const sourceContent = {
    report: {
      title: '《大学生睡眠状况调研》', page: '第 8–12 页',
      body: '<p>样本中，<mark>63.4% 的学生工作日睡眠不足 7 小时</mark>；晚间使用电子设备超过 2 小时的群体，次日主观疲劳评分显著更高。</p><p>受访者将“任务拖延”“临睡前刷短视频”“宿舍作息不同步”列为最常见的三个干扰因素。</p>'
    },
    interview: {
      title: '半结构访谈记录', page: '访谈 07 / 12',
      body: '<p>“白天课程和社团排得很满，晚上终于有自己的时间，<mark>不是不困，是舍不得结束今天</mark>。”</p><p>访谈记录提示：比“自律不足”更具体的切口，是晚间补偿行为与任务拖延。</p>'
    },
    survey: {
      title: '校园睡眠问卷', page: '有效样本 428',
      body: '<p>工作日平均入睡时间为 00:47。<mark>72% 的受访者尝试过“强迫自己早睡”</mark>，但只有 18% 连续坚持超过一周。</p><p>相比泛化目标，固定一个可观察的“屏幕下线时间”更适合作为起点。</p>'
    }
  };
  $$('[data-source]').forEach(button => button.addEventListener('click', () => {
    $$('[data-source]').forEach(item => item.classList.toggle('active', item === button));
    const content = sourceContent[button.dataset.source];
    const documentNode = $('[data-source-document]');
    documentNode.innerHTML = `<div class="doc-meta"><span>${content.title}</span><small>${content.page}</small></div>${content.body}<button class="evidence-button" type="button" data-evidence-add>+ 加入证据卡</button>`;
    $('[data-evidence-add]', documentNode).addEventListener('click', addEvidence);
  }));
  function addEvidence(event) {
    event.currentTarget.textContent = '✓ 已加入证据卡';
    event.currentTarget.disabled = true;
    const label = $('.evidence-stack > span');
    const bar = $('.evidence-stack i');
    if (label) label.textContent = '已标记 6 / 6';
    if (bar) bar.style.width = '100%';
    toast('证据已绑定原始位置');
  }
  $('[data-evidence-add]')?.addEventListener('click', addEvidence);

  $$('[data-slide-thumb]').forEach(button => button.addEventListener('click', () => {
    const index = Number(button.dataset.slideThumb);
    $$('[data-slide-thumb]').forEach(item => item.classList.toggle('active', item === button));
    $$('[data-slide]').forEach(slide => { slide.hidden = Number(slide.dataset.slide) !== index; });
  }));
  $('[data-export]')?.addEventListener('click', () => toast('交付包已整理：3 页汇报 + 讲稿 + 来源索引'));

  // Storyboard playback
  let storyTimer = null;
  let storyFrame = 0;
  const setStoryFrame = (index) => {
    storyFrame = index;
    $$('[data-frame]').forEach(frame => frame.classList.toggle('active', Number(frame.dataset.frame) === index));
    const bar = $('[data-story-progress]');
    if (bar) bar.style.width = `${((index + 1) / 6) * 100}%`;
  };
  $$('[data-frame]').forEach(frame => frame.addEventListener('click', () => setStoryFrame(Number(frame.dataset.frame))));
  $('[data-story-play]')?.addEventListener('click', event => {
    const button = event.currentTarget;
    if (storyTimer) {
      window.clearInterval(storyTimer);
      storyTimer = null;
      button.textContent = '▶ 播放分镜';
      return;
    }
    storyFrame = 0;
    setStoryFrame(0);
    button.textContent = 'Ⅱ 暂停';
    storyTimer = window.setInterval(() => {
      storyFrame += 1;
      if (storyFrame > 5) {
        window.clearInterval(storyTimer);
        storyTimer = null;
        button.textContent = '↻ 重新播放';
        return;
      }
      setStoryFrame(storyFrame);
    }, reducedMotion ? 250 : 1250);
  });

  // Community copy
  const communityCopy = [
    {
      title: '先别自我介绍，发一张“你最想做完的任务”截图。',
      body: '论文选题、课堂汇报、商赛分析都可以。今晚 22:00 前完成任务卡，我们会帮你检查：听众、时长、格式、完成标准是否齐全。',
      action: '今天只做一件事：把模糊待办改写成可交付任务。'
    },
    {
      title: '第三天不催进度，只做一次“结构急诊”。',
      body: '把你的三个页面标题直接发进群里，不用解释背景。其他同学只回答一件事：看完标题，我能不能复述你的完整故事？',
      action: '今晚 21:30 前发三行标题，收到两条反馈后再改结构。'
    },
    {
      title: '不晒学习时长，晒一个真正能交出去的结果。',
      body: '请用“原任务 □ → 最终交付 ■ → 我保留的方法”三句话发布。可以遮掉敏感信息，但要保留一处你亲自核验过的修改。',
      action: '完成发布后，领取同任务类型的下一张复用卡。'
    }
  ];
  const renderCommunity = (index) => {
    $$('.copy-tab').forEach((tab, tabIndex) => tab.classList.toggle('active', tabIndex === index));
    const card = $('[data-copy-content]');
    const copy = communityCopy[index];
    card.innerHTML = `<strong>${copy.title}</strong><p>${copy.body}</p><span>${copy.action}</span>`;
  };
  $$('.copy-tab').forEach((tab, index) => tab.addEventListener('click', () => renderCommunity(index)));
  $('[data-copy-button]')?.addEventListener('click', async () => {
    const text = $('[data-copy-content]')?.innerText || '';
    try {
      await navigator.clipboard.writeText(text);
      toast('社群文案已复制');
    } catch (_) {
      toast('请长按文案复制');
    }
  });

  // 14-day launch calendar
  const launchDays = [
    ['第一天', '先听 12 个真实任务，不急着讲课程', '记录最近 14 天内必须提交的任务、卡住位置、现在的解决方式和愿意投入的时间。只收具体事件，不问泛泛的“你想学什么”。', '产出：任务机会表', '判断：同一任务是否出现 ≥ 5 次'],
    ['第二天', '把高频需求切成 3 个可以完成的任务', '将访谈中的“大词”改写为具体交付：25 页资料做成 3 页汇报、10 篇文献压成研究框架、杂乱问卷变成结论页。', '产出：三张任务卡', '判断：参与者能否在 10 秒内选中一张'],
    ['第三天', '用两种首屏验证“工具”还是“任务”更有吸引力', '版本 A 强调模型与功能，版本 B 直接展示输入和交付结果。除首屏外，其余页面、渠道与预算保持一致。', '产出：A / B 落地页', '指标：访问→领取任务卡'],
    ['第四天', '招募 30 个手上真有任务的人', '通过校园社群、班级群和内容账号发布招募，只接受未来两周内有明确截止时间的任务。', '产出：首批种子名单', '门槛：任务明确率 ≥ 80%'],
    ['第五天', '开营第一晚，只完成任务定义', '不做长介绍。所有人现场填写听众、时长、格式与评分标准，导师逐条检查能否验收。', '产出：30 张任务定义卡', '指标：首晚完成率 ≥ 70%'],
    ['第六天', '围绕真实卡点做小范围答疑', '按“资料太多、不会提问、结果不可信”分桌答疑，记录提问原句，不提前增加新课程。', '产出：卡点原话库', '判断：前三问题覆盖率 ≥ 60%'],
    ['第七天', '第一次复盘只看“有没有开始”', '对比报名、入群、任务卡填写与第一课开始四层数据，定位最大流失层，只选择一个变量进入下周。', '产出：第一周漏斗', '决策：保留 / 改写 / 删除'],
    ['第八天', '把最卡的一步砍到原来一半', '如果多数人在长提示词前放弃，就拆成四个选项；如果资料整理太慢，就提供证据卡。优先减负，不急着加功能。', '产出：第一课简化版', '指标：步骤完成时长下降 30%'],
    ['第九天', '上线三个高频任务模板', '分别覆盖课堂汇报、文献梳理和用户调研。模板只保留不可缺少的字段，并附一份真实填写结果。', '产出：三套任务模板', '指标：模板启用率 ≥ 50%'],
    ['第十天', '发起一次 48 小时完成挑战', '选择“25 页资料→3 页汇报”作为统一任务，按定义、证据、结构、核验四次打卡推进。', '产出：挑战任务板', '指标：48h 首次交付率'],
    ['第十一天', '让过程成为最可信的传播内容', '邀请完成者展示一处关键修改：删掉了什么、核验了什么、如何从空白到能讲。避免只晒漂亮结果。', '产出：过程型 UGC', '指标：收藏→报名转化'],
    ['第十二天', '逐份收作业，并记录为什么能完成', '按交付清晰度、证据完整度、时间控制和复用价值评分；同时记录未完成者停在哪一步。', '产出：交付评分表', '指标：可提交结果占比 ≥ 45%'],
    ['第十三天', '把三条不同路径写成可迁移故事', '选择起点、任务类型和卡点不同的三名参与者，呈现真实输入、关键决策与最终结果。', '产出：三条任务故事', '判断：读者能否对号入座'],
    ['第十四天', '用数据决定扩量，不靠兴奋感', '综合开始率、首次交付率、分享率与反馈成本，确认下一批扩大渠道、优化课程，或暂停某类任务。', '产出：扩量决策表', '门槛：完成率与分享率同时达标']
  ];
  const selectLaunchDay = (index) => {
    $$('.calendar-day').forEach((button, buttonIndex) => button.classList.toggle('active', buttonIndex === index));
    const data = launchDays[index];
    $('[data-launch-badge]').textContent = data[0];
    $('[data-launch-title]').textContent = data[1];
    $('[data-launch-desc]').textContent = data[2];
    $('[data-launch-output]').textContent = data[3];
    $('[data-launch-metric]').textContent = data[4];
  };
  $$('.calendar-day').forEach(button => button.addEventListener('click', () => selectLaunchDay(Number(button.dataset.launchDay))));

  // Funnel experiment
  const experiments = {
    a: {
      values: ['10,000', '1,180', '366', '201', '92', '27'], widths: [100, 74, 55, 38, 25, 17],
      insight: '大家点进来了，但还不知道第一步要做什么。',
      test: '把“领取课程大纲”改为“领取 25 页→3 页任务卡”', rate: '31.0%'
    },
    b: {
      values: ['10,000', '1,460', '555', '338', '171', '61'], widths: [100, 80, 62, 46, 31, 21],
      insight: '任务表达提高了领取率，下一处流失转移到首次交付。',
      test: '首课只保留 4 个必填字段，并增加一份完整填写结果', rate: '38.0%'
    }
  };
  const renderExperiment = (key) => {
    $$('.experiment-button').forEach(button => button.classList.toggle('active', button.dataset.exp === key));
    const data = experiments[key];
    $$('.funnel-row').forEach((row, index) => { row.style.setProperty('--funnel-width', `${data.widths[index]}%`); });
    $$('[data-funnel-value]').forEach((node, index) => { node.textContent = data.values[index]; });
    $('[data-funnel-insight]').textContent = data.insight;
    $('[data-funnel-test]').textContent = data.test;
    $('[data-key-rate]').textContent = data.rate;
  };
  $$('.experiment-button').forEach(button => button.addEventListener('click', () => renderExperiment(button.dataset.exp)));

  // Feedback iteration
  const feedback = [
    ['给一段 600 字通用提示词', '拆成 4 个可选字段，并在每个字段旁放真实输入', '任务卡填写完成率', '目标：从 54% 提升到 70%'],
    ['让 AI 直接总结整份资料', '先标记 6 条证据卡，再允许生成结构', '有出处结论占比', '目标：从 62% 提升到 90%'],
    ['完成后只提供一份导出文件', '同步保存任务定义、证据卡与核验表为个人模板', '第二项任务启动率', '目标：7 天内达到 35%']
  ];
  $$('[data-feedback]').forEach(button => button.addEventListener('click', () => {
    const index = Number(button.dataset.feedback);
    $$('[data-feedback]').forEach(item => item.classList.toggle('active', item === button));
    $('[data-feedback-before]').textContent = feedback[index][0];
    $('[data-feedback-after]').textContent = feedback[index][1];
    $('[data-feedback-metric]').textContent = feedback[index][2];
    $('[data-feedback-target]').textContent = feedback[index][3];
  }));

  // Keep FAQ focused
  $$('.faq-list details').forEach(detail => detail.addEventListener('toggle', () => {
    if (!detail.open) return;
    $$('.faq-list details').forEach(other => { if (other !== detail) other.open = false; });
  }));
})();

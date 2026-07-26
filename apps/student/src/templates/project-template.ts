import type {
  WorkbenchOutputFormatInput,
  WorkbenchProjectFormInput,
  WorkbenchRubricFormInput,
} from '../workbench/workbench-service.js';

export type ProjectTemplateCategory =
  | 'learning'
  | 'research'
  | 'business'
  | 'career'
  | 'custom';

export type ProjectTemplateCategoryFilter =
  | 'all'
  | ProjectTemplateCategory;

export interface ProjectTemplateCategoryOption {
  id: ProjectTemplateCategoryFilter;
  label: string;
}

export interface ProjectTemplateStructureItem {
  title: string;
  purpose: string;
}

export interface ProjectTemplateTaskDefaults {
  taskName: string;
  audience: string;
  scope: string;
  durationMinutes: string;
  outputFormat: WorkbenchOutputFormatInput;
  tone: string;
  rubric: readonly WorkbenchRubricFormInput[];
  requiredContent: readonly string[];
  forbiddenContent: readonly string[];
}

export interface ProjectTemplate {
  id: string;
  name: string;
  category: ProjectTemplateCategory;
  summary: string;
  useFor: string;
  tags: readonly string[];
  taskDefaults: ProjectTemplateTaskDefaults;
  acceptanceChecklist: readonly string[];
  suggestedStructure: readonly ProjectTemplateStructureItem[];
  requiredUserInputs: readonly string[];
}

export interface ApplyProjectTemplateOverrides {
  projectTitle?: string;
  taskName?: string;
  deadline?: string;
}

export const templateCategories: readonly ProjectTemplateCategoryOption[] =
  Object.freeze([
    { id: 'all', label: '全部' },
    { id: 'learning', label: '课程学习' },
    { id: 'research', label: '研究调研' },
    { id: 'business', label: '商业分析' },
    { id: 'career', label: '求职展示' },
    { id: 'custom', label: '自定义' },
  ]);

const commonRequiredInputs = Object.freeze([
  '具体主题',
  '截止时间',
  '任务材料',
] as const);

export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = Object.freeze([
  {
    id: 'class-presentation',
    name: '课堂汇报',
    category: 'learning',
    summary: '把课程主题整理成适合讲解、能够追溯来源的课堂演示。',
    useFor: '课程展示、读书分享、小组汇报',
    tags: ['课程', '演示', '小组作业', '讲稿'],
    taskDefaults: {
      taskName: '课堂主题汇报',
      audience: '任课教师与同学',
      scope: '8 页',
      durationMinutes: '8',
      outputFormat: 'presentation',
      tone: '清晰、简洁、适合课堂讲解',
      rubric: [
        {
          title: '任务回应',
          description: '准确回应课程要求与汇报主题',
          weightPercent: 30,
        },
        {
          title: '论证与证据',
          description: '核心判断由可追溯材料支持',
          weightPercent: 35,
        },
        {
          title: '结构表达',
          description: '信息层次清楚，讲解顺序连贯',
          weightPercent: 20,
        },
        {
          title: '呈现质量',
          description: '页面清晰，讲稿与时间安排合理',
          weightPercent: 15,
        },
      ],
      requiredContent: [
        '课程主题与核心问题',
        '有来源支撑的核心结论',
        '引用与来源页',
      ],
      forbiddenContent: [
        '没有来源的事实、数据与引文',
        '材料无法支持的结论',
      ],
    },
    acceptanceChecklist: [
      '开场明确主题、范围与汇报目标',
      '每个核心结论都能回到原始材料',
      '页面数量与讲解时长符合要求',
      '结尾包含结论、限制与来源',
    ],
    suggestedStructure: [
      { title: '任务与问题', purpose: '说明主题、范围与本次要回答的问题' },
      { title: '背景与概念', purpose: '建立理解主题所需的共同信息' },
      { title: '核心发现', purpose: '按观点组织已核对的材料与证据' },
      { title: '结论与启发', purpose: '回应问题并说明限制或下一步' },
      { title: '来源', purpose: '集中列出正文实际引用的材料' },
    ],
    requiredUserInputs: commonRequiredInputs,
  },
  {
    id: 'literature-review',
    name: '文献综述',
    category: 'research',
    summary: '梳理研究脉络、主要观点、分歧与仍待回答的问题。',
    useFor: '课程论文、开题准备、专题综述',
    tags: ['文献', '论文', '研究脉络', '开题'],
    taskDefaults: {
      taskName: '专题文献综述',
      audience: '课程教师与研究同伴',
      scope: '3000 字',
      durationMinutes: '',
      outputFormat: 'document',
      tone: '严谨、客观、概念一致',
      rubric: [
        {
          title: '检索与范围',
          description: '说明检索边界、筛选标准与文献范围',
          weightPercent: 25,
        },
        {
          title: '综合分析',
          description: '比较观点、方法、证据与研究结论',
          weightPercent: 35,
        },
        {
          title: '问题意识',
          description: '识别分歧、限制与可继续研究的问题',
          weightPercent: 25,
        },
        {
          title: '引用规范',
          description: '引文和参考文献完整且可追溯',
          weightPercent: 15,
        },
      ],
      requiredContent: [
        '检索范围与筛选标准',
        '主题分类或研究脉络',
        '主要分歧与研究空白',
        '参考文献',
      ],
      forbiddenContent: [
        '未阅读文献的观点或结论',
        '无法对应原文的引文与页码',
      ],
    },
    acceptanceChecklist: [
      '交代检索时间、范围与筛选方式',
      '不是逐篇摘要，而是按问题或主题综合',
      '每项观点能定位到实际阅读的文献',
      '结论区分已有共识、分歧与研究空白',
    ],
    suggestedStructure: [
      { title: '综述范围', purpose: '定义问题、关键词与纳入标准' },
      { title: '研究脉络', purpose: '按时间、主题或理论组织文献' },
      { title: '比较与分歧', purpose: '对照方法、证据和主要结论' },
      { title: '限制与空白', purpose: '指出现有研究尚未解决的问题' },
      { title: '参考文献', purpose: '列出正文实际使用的文献' },
    ],
    requiredUserInputs: [
      ...commonRequiredInputs,
      '检索范围与引用格式',
    ],
  },
  {
    id: 'user-research',
    name: '用户调研',
    category: 'research',
    summary: '从实际访谈、问卷或观察材料中整理需求、问题与机会。',
    useFor: '产品研究、体验调研、服务设计',
    tags: ['访谈', '问卷', '观察', '用户洞察'],
    taskDefaults: {
      taskName: '用户需求调研',
      audience: '产品与项目团队',
      scope: '2500 字',
      durationMinutes: '',
      outputFormat: 'report',
      tone: '具体、克制、区分事实与判断',
      rubric: [
        {
          title: '研究设计',
          description: '问题、对象与方法能够回应调研目标',
          weightPercent: 25,
        },
        {
          title: '材料质量',
          description: '记录完整，样本与限制交代清楚',
          weightPercent: 30,
        },
        {
          title: '洞察推导',
          description: '发现来自材料，并区分观察与解释',
          weightPercent: 30,
        },
        {
          title: '行动建议',
          description: '建议对应问题，优先级和依据明确',
          weightPercent: 15,
        },
      ],
      requiredContent: [
        '调研问题与目标用户',
        '实际采用的方法与样本说明',
        '原始记录支持的发现',
        '限制与后续验证计划',
      ],
      forbiddenContent: [
        '未实际发生的访谈、问卷或观察',
        '把单个样本直接表述为全部用户',
      ],
    },
    acceptanceChecklist: [
      '研究问题与目标用户定义清楚',
      '样本、时间和方法与实际执行一致',
      '每条主要发现都能回到调研记录',
      '明确样本限制，不作超出材料的推断',
      '建议与发现逐项对应',
    ],
    suggestedStructure: [
      { title: '目标与问题', purpose: '说明为什么调研以及需要回答什么' },
      { title: '对象与方法', purpose: '记录实际样本、过程和分析方式' },
      { title: '关键发现', purpose: '用调研材料组织模式、差异与问题' },
      { title: '机会与建议', purpose: '把发现转成可讨论的行动方向' },
      { title: '限制与附录', purpose: '说明边界并保留原始记录索引' },
    ],
    requiredUserInputs: [
      ...commonRequiredInputs,
      '实际调研记录',
    ],
  },
  {
    id: 'business-competition',
    name: '商赛分析',
    category: 'business',
    summary: '围绕赛题、市场、方案与验证计划形成完整商业论证。',
    useFor: '创新创业比赛、商业案例分析、项目路演',
    tags: ['商赛', '市场', '方案', '路演'],
    taskDefaults: {
      taskName: '商业项目分析',
      audience: '赛事评委与项目导师',
      scope: '12 页',
      durationMinutes: '10',
      outputFormat: 'presentation',
      tone: '专业、直接、以可核对信息为基础',
      rubric: [
        {
          title: '问题价值',
          description: '目标问题、用户与场景界定清晰',
          weightPercent: 25,
        },
        {
          title: '方案逻辑',
          description: '方案与问题对应，关键假设明确',
          weightPercent: 30,
        },
        {
          title: '市场与可行性',
          description: '分析有来源，实施条件与风险具体',
          weightPercent: 30,
        },
        {
          title: '路演表达',
          description: '重点突出，页面和讲解适配评审时间',
          weightPercent: 15,
        },
      ],
      requiredContent: [
        '赛题要求与目标问题',
        '目标用户与使用场景',
        '方案机制与关键假设',
        '市场依据、风险与验证计划',
      ],
      forbiddenContent: [
        '没有出处的市场规模或竞品数据',
        '尚未验证却写成既成事实的效果',
      ],
    },
    acceptanceChecklist: [
      '每项赛题要求都有明确回应位置',
      '市场和竞品数据注明来源与时间',
      '方案能力、假设和待验证事项清楚区分',
      '商业路径包含前提、风险与验证办法',
      '路演内容能在规定时间内讲完',
    ],
    suggestedStructure: [
      { title: '问题与机会', purpose: '界定场景、用户和问题价值' },
      { title: '方案与机制', purpose: '说明方案如何回应核心问题' },
      { title: '市场与竞品', purpose: '基于来源分析空间与差异' },
      { title: '实施与验证', purpose: '列出路径、关键假设与验证方式' },
      { title: '风险与计划', purpose: '说明边界、风险和下一阶段安排' },
    ],
    requiredUserInputs: [
      ...commonRequiredInputs,
      '赛题要求与评审规则',
    ],
  },
  {
    id: 'defense',
    name: '项目答辩',
    category: 'learning',
    summary: '把项目过程、个人贡献、已有成果和限制组织成答辩材料。',
    useFor: '课程项目答辩、毕业设计答辩、结项评审',
    tags: ['答辩', '结项', '项目过程', '问答'],
    taskDefaults: {
      taskName: '项目成果答辩',
      audience: '答辩评委与指导教师',
      scope: '15 页',
      durationMinutes: '12',
      outputFormat: 'presentation',
      tone: '准确、自信、主动说明边界',
      rubric: [
        {
          title: '目标与过程',
          description: '目标、方法和关键决策交代完整',
          weightPercent: 25,
        },
        {
          title: '成果证据',
          description: '成果、测试与反馈均有可核对记录',
          weightPercent: 35,
        },
        {
          title: '贡献与反思',
          description: '个人贡献、限制与改进方向清楚',
          weightPercent: 25,
        },
        {
          title: '答辩表达',
          description: '重点和时间安排合理，能够回应追问',
          weightPercent: 15,
        },
      ],
      requiredContent: [
        '项目目标与验收要求',
        '实施过程与关键决策',
        '已有成果及对应材料',
        '个人贡献、限制与下一步',
      ],
      forbiddenContent: [
        '未完成却表述为已完成的成果',
        '无法证明的个人贡献或项目效果',
      ],
    },
    acceptanceChecklist: [
      '项目目标与验收标准前后一致',
      '过程、成果和结论均有材料对应',
      '团队工作与个人贡献区分明确',
      '主动说明不足、限制与未完成事项',
      '准备可能追问及对应材料位置',
    ],
    suggestedStructure: [
      { title: '项目目标', purpose: '说明问题、任务要求与验收标准' },
      { title: '方法与过程', purpose: '呈现关键步骤、选择与依据' },
      { title: '成果与验证', purpose: '展示实际完成内容和核对记录' },
      { title: '贡献与复盘', purpose: '区分个人工作并总结限制' },
      { title: '结论与问答', purpose: '收束价值并准备追问入口' },
    ],
    requiredUserInputs: [
      ...commonRequiredInputs,
      '答辩规则与实际项目记录',
    ],
  },
  {
    id: 'job-showcase',
    name: '求职展示',
    category: 'career',
    summary: '用清楚的项目案例呈现职责、过程、能力与可核对成果。',
    useFor: '作品集、面试展示、岗位申请',
    tags: ['作品集', '面试', '求职', '项目案例'],
    taskDefaults: {
      taskName: '求职项目展示',
      audience: '招聘方与面试官',
      scope: '10 页',
      durationMinutes: '8',
      outputFormat: 'presentation',
      tone: '专业、具体、突出与岗位相关的能力',
      rubric: [
        {
          title: '岗位相关',
          description: '案例选择与目标岗位能力要求匹配',
          weightPercent: 25,
        },
        {
          title: '职责清楚',
          description: '背景、团队边界和个人职责表述准确',
          weightPercent: 30,
        },
        {
          title: '过程与成果',
          description: '关键行动和成果由可展示材料支持',
          weightPercent: 30,
        },
        {
          title: '表达设计',
          description: '信息易扫读，讲解重点和节奏清楚',
          weightPercent: 15,
        },
      ],
      requiredContent: [
        '目标岗位与对应能力',
        '项目背景与职责边界',
        '关键行动与决策过程',
        '可核对的成果、复盘与能力映射',
      ],
      forbiddenContent: [
        '夸大个人职责或团队成果',
        '无法提供材料支持的数字或成绩',
      ],
    },
    acceptanceChecklist: [
      '案例与目标岗位的能力要求相关',
      '项目背景、团队情况和个人职责清楚',
      '关键行动说明问题、选择与执行过程',
      '成果只采用可以核对的记录或作品',
      '结尾给出能力总结与可继续追问的细节',
    ],
    suggestedStructure: [
      { title: '岗位与案例', purpose: '说明目标岗位和案例选择理由' },
      { title: '背景与职责', purpose: '交代项目背景、团队与个人边界' },
      { title: '问题与行动', purpose: '呈现关键挑战、判断和具体工作' },
      { title: '成果与复盘', purpose: '展示已有成果并总结经验限制' },
      { title: '能力映射', purpose: '把案例证据对应到岗位能力' },
    ],
    requiredUserInputs: [
      ...commonRequiredInputs,
      '投递岗位与目标受众',
    ],
  },
  {
    id: 'custom',
    name: '自定义项目',
    category: 'custom',
    summary: '从通用任务框架开始，自行调整交付形式、标准与内容结构。',
    useFor: '不属于预设类型的报告、文档或展示',
    tags: ['自定义', '通用', '报告', '展示'],
    taskDefaults: {
      taskName: '自定义项目',
      audience: '项目评审或协作成员',
      scope: '6 页',
      durationMinutes: '',
      outputFormat: 'report',
      tone: '清楚、直接、适合目标受众',
      rubric: [
        {
          title: '任务完成',
          description: '交付内容完整回应任务要求',
          weightPercent: 35,
        },
        {
          title: '依据充分',
          description: '主要判断能够回到相应材料',
          weightPercent: 35,
        },
        {
          title: '表达质量',
          description: '结构、篇幅和呈现方式适合受众',
          weightPercent: 30,
        },
      ],
      requiredContent: [
        '任务目标与交付边界',
        '有材料支持的核心内容',
        '结论、限制或下一步',
      ],
      forbiddenContent: [
        '未核实的信息、数字与引文',
        '超出任务材料支持范围的结论',
      ],
    },
    acceptanceChecklist: [
      '任务目标、受众和交付形式已经确认',
      '验收标准能够逐项检查',
      '核心内容都有相应材料支持',
      '篇幅、格式与截止时间符合要求',
    ],
    suggestedStructure: [
      { title: '任务说明', purpose: '明确目标、受众和交付范围' },
      { title: '背景信息', purpose: '提供理解主题所需的必要材料' },
      { title: '核心内容', purpose: '围绕任务要求组织观点与依据' },
      { title: '结论与下一步', purpose: '回应目标并说明限制或行动' },
    ],
    requiredUserInputs: [
      ...commonRequiredInputs,
      '具体交付格式与验收标准',
    ],
  },
]);

export function findProjectTemplate(templateId: string): ProjectTemplate {
  const template = PROJECT_TEMPLATES.find(
    (candidate) => candidate.id === templateId.trim(),
  );
  if (template === undefined) {
    throw new Error('找不到这个项目模板');
  }
  return template;
}

export function filterProjectTemplates(
  templates: readonly ProjectTemplate[],
  query: string,
  category: ProjectTemplateCategoryFilter,
): ProjectTemplate[] {
  const terms = normalizeSearch(query).split(' ').filter(Boolean);
  return templates.filter((template) => {
    if (category !== 'all' && template.category !== category) {
      return false;
    }
    if (terms.length === 0) {
      return true;
    }
    const searchable = normalizeSearch(
      [
        template.name,
        template.summary,
        template.useFor,
        ...template.tags,
        ...template.requiredUserInputs,
      ].join(' '),
    );
    return terms.every((term) => searchable.includes(term));
  });
}

export function applyProjectTemplate(
  template: ProjectTemplate,
  overrides: ApplyProjectTemplateOverrides = {},
): WorkbenchProjectFormInput {
  const projectTitle = cleanOptional(overrides.projectTitle);
  return {
    ...(projectTitle === undefined ? {} : { projectTitle }),
    taskName:
      cleanOptional(overrides.taskName) ?? template.taskDefaults.taskName,
    audience: template.taskDefaults.audience,
    deadline: cleanOptional(overrides.deadline) ?? '',
    scope: template.taskDefaults.scope,
    durationMinutes: template.taskDefaults.durationMinutes,
    outputFormat: template.taskDefaults.outputFormat,
    tone: template.taskDefaults.tone,
    rubric: template.taskDefaults.rubric.map((criterion) => ({
      title: criterion.title,
      description: criterion.description,
      weightPercent: criterion.weightPercent,
    })),
    requiredContent: template.taskDefaults.requiredContent.join('\n'),
    forbiddenContent: template.taskDefaults.forbiddenContent.join('\n'),
  };
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned === undefined || cleaned.length === 0 ? undefined : cleaned;
}

function normalizeSearch(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/gu, ' ')
    .trim();
}

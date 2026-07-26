import {
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import type { Project } from './project-model.js';
import {
  EvidenceStage,
  type EvidenceStageCreateInput,
} from './evidence-stage.js';
import {
  OutlineStage,
  type OutlineStageCallbacks,
} from './outline-stage.js';
import type {
  SourceIngestionResult,
  WorkbenchProjectFormInput,
  WorkbenchService,
} from './workbench-service.js';

export type StudentSurface = 'workbench' | 'identity';

export function studentSurfaceForPath(pathname: string): StudentSurface {
  return /^\/(?:account|auth)(?:\/|$)/u.test(pathname)
    ? 'identity'
    : 'workbench';
}

export interface WorkbenchShellProps {
  onLogin(): void;
  onRegister(): void;
  service?: WorkbenchService;
  initialDraft?: WorkbenchDraft;
  initialMaterials?: File[];
}

export interface WorkbenchDraft {
  taskName: string;
  audience: string;
  deadline: string;
  scope: string;
  durationMinutes: string;
  outputFormat: WorkbenchProjectFormInput['outputFormat'] | '';
  tone: string;
  rubric: string;
  requiredContent: string;
  forbiddenContent: string;
}

const emptyWorkbenchDraft: WorkbenchDraft = {
  taskName: '',
  audience: '',
  deadline: '',
  scope: '',
  durationMinutes: '',
  outputFormat: '',
  tone: '',
  rubric: '',
  requiredContent: '',
  forbiddenContent: '',
};

const requiredDraftFields: ReadonlyArray<
  readonly [keyof WorkbenchDraft, string]
> = [
  ['taskName', '任务名称'],
  ['audience', '听众'],
  ['deadline', '截止时间'],
  ['scope', '页面或字数'],
  ['outputFormat', '输出格式'],
  ['rubric', '评分标准'],
];

export function missingTaskFields(
  draft: Readonly<WorkbenchDraft>,
  materialCount: number,
): string[] {
  const missing = requiredDraftFields
    .filter(([field]) => draft[field].trim().length === 0)
    .map(([, label]) => label);
  if (materialCount < 1) {
    missing.push('任务材料');
  }
  return missing;
}

type SavePhase = 'idle' | 'saving' | 'saved' | 'failed';
type MaterialStatus = 'selected' | 'parsing' | SourceIngestionResult['status'];

interface MaterialProgress {
  status: MaterialStatus;
  message: string;
}

function materialKey(file: File): string {
  return [
    file.name,
    String(file.size),
    file.type,
    String(file.lastModified),
  ].join(':');
}

function materialStatusLabel(progress: MaterialProgress | undefined): string {
  switch (progress?.status) {
    case 'parsing':
      return '解析中';
    case 'ready':
      return '已解析';
    case 'failed':
      return '解析失败';
    case 'duplicate':
      return '已存在';
    default:
      return '待解析';
  }
}

function errorMessage(reason: unknown): string {
  if (
    typeof reason === 'object' &&
    reason !== null &&
    'code' in reason &&
    typeof reason.code === 'string'
  ) {
    const messages: Record<string, string> = {
      CORRUPT_PDF: 'PDF 文件已损坏，请更换后重试。',
      CORRUPT_OOXML: 'Office 文件已损坏，请更换后重试。',
      EMPTY_FILE: '文件内容为空，请更换文件。',
      EMPTY_OOXML_TEXT: 'Office 文件中没有可提取的正文。',
      ENCRYPTED_OOXML: '加密的 Office 文件需要解除密码后再添加。',
      FILE_TOO_LARGE: '文件超过 50 MB，请压缩后重试。',
      MIME_EXTENSION_MISMATCH: '文件类型与扩展名不一致。',
      OCR_REQUIRED: '该文件没有可提取文字，需要先完成文字识别。',
      UNSUPPORTED_EXTENSION: '暂不支持这种文件格式。',
      UNSUPPORTED_SOURCE_KIND: '该材料暂时无法解析。',
      INVALID_LENGTH_TARGET: '请按“12 页”或“3000 字”填写篇幅。',
      INVALID_RUBRIC_WEIGHT: '评分标准需要完整内容。',
    };
    return messages[reason.code] ?? '处理失败，请检查输入后重试。';
  }
  return '处理失败，请检查输入后重试。';
}

function localDateTimeValue(isoDateTime: string): string {
  const date = new Date(isoDateTime);
  const local = new Date(
    date.valueOf() - date.getTimezoneOffset() * 60_000,
  );
  return local.toISOString().slice(0, 16);
}

function draftFromProject(project: Project): WorkbenchDraft {
  const task = project.taskDefinition;
  const outputFormat: WorkbenchDraft['outputFormat'] =
    task.outputFormats.includes('pptx')
      ? 'presentation'
      : task.outputFormats.includes('docx')
        ? 'document'
        : task.outputFormats.length === 1 &&
            task.outputFormats[0] !== undefined
          ? task.outputFormats[0]
          : 'report';
  return {
    taskName: task.taskName,
    audience: task.audience,
    deadline: localDateTimeValue(task.dueAt),
    scope: `${String(task.lengthTarget.value)} ${
      task.lengthTarget.unit === 'pages' ? '页' : '字'
    }`,
    durationMinutes:
      task.presentationDurationMinutes === null
        ? ''
        : String(task.presentationDurationMinutes),
    outputFormat,
    tone: task.tone,
    rubric: task.rubric
      .map((criterion) => criterion.description)
      .join('\n'),
    requiredContent: task.mustInclude.join('\n'),
    forbiddenContent: task.mustAvoid.join('\n'),
  };
}

export function hasConfirmedVerifiedEvidence(
  project: Project | null,
): boolean {
  return (
    project?.evidenceCards.some(
      (evidence) =>
        evidence.status === 'verified' &&
        evidence.confirmationStatus === 'confirmed' &&
        evidence.userConfirmedAt !== null &&
        evidence.userConfirmedAt !== undefined,
    ) ?? false
  );
}

export function createOutlineStageCallbacks(
  service: WorkbenchService,
  project: Project,
  onProjectChange: (next: Project) => void,
): OutlineStageCallbacks {
  const persist = async (operation: () => Promise<Project>) => {
    const next = await operation();
    onProjectChange(next);
  };
  return {
    onCreateOutline: ({ title }) =>
      persist(() =>
        service.createOutline(project.id, {
          title,
          nodes: [],
        }),
      ),
    onAddNode: ({
      outlineId,
      title,
      conclusion,
      evidenceCardIds,
      coveredRequirements,
      rubricCriterionIds,
    }) =>
      persist(() =>
        service.addOutlineNode(project.id, outlineId, {
          title,
          conclusion,
          evidenceCardIds,
          coveredRequirements,
          rubricCriterionIds,
        }),
      ),
    onUpdateNode: ({ outlineId, nodeId, patch }) =>
      persist(() =>
        service.updateOutlineNode(
          project.id,
          outlineId,
          nodeId,
          patch,
        ),
      ),
    onDeleteNode: ({ outlineId, nodeId }) =>
      persist(() =>
        service.deleteOutlineNode(project.id, outlineId, nodeId),
      ),
    onReorderNode: ({ outlineId, nodeId, targetPosition }) =>
      persist(() =>
        service.reorderOutlineNode(
          project.id,
          outlineId,
          nodeId,
          targetPosition,
        ),
      ),
    onSelectOutline: ({ outlineId }) =>
      persist(() => service.selectOutline(project.id, outlineId)),
    onLockOutline: ({ outlineId }) =>
      persist(() => service.lockOutline(project.id, outlineId)),
  };
}

interface WorkflowStage {
  number: string;
  label: string;
  description: string;
  prerequisite: string | null;
}

interface StageHeader {
  kicker: string;
  title: string;
  description: string;
}

const workflowStages: WorkflowStage[] = [
  {
    number: '01',
    label: '定义任务',
    description: '交付目标、听众与约束',
    prerequisite: null,
  },
  {
    number: '02',
    label: '材料解析',
    description: '文件、页码与原文锚点',
    prerequisite: '需先添加材料',
  },
  {
    number: '03',
    label: '选择证据',
    description: '原文、备注与引用格式',
    prerequisite: '需先完成任务定义与材料处理',
  },
  {
    number: '04',
    label: '组织结构',
    description: '排序、锁定与证据绑定',
    prerequisite: '需先选择可引用证据',
  },
  {
    number: '05',
    label: '编辑核验',
    description: '逐页编辑与规则检查',
    prerequisite: '需先建立内容结构',
  },
  {
    number: '06',
    label: '正式导出',
    description: '文件、讲稿与来源索引',
    prerequisite: '需先完成编辑核验',
  },
];

const stageHeaders: readonly StageHeader[] = [
  {
    kicker: '01 / DEFINE',
    title: '明确这次要交什么',
    description: '填写任务要求、评分标准和交付限制。',
  },
  {
    kicker: '02 / SOURCES',
    title: '检查材料是否解析完整',
    description: '确认文件、页码和原文片段准确无误。',
  },
  {
    kicker: '03 / EVIDENCE',
    title: '从原文中选取可引用证据',
    description: '核对原文位置、用途和引用格式后再保存。',
  },
  {
    kicker: '04 / OUTLINE',
    title: '组织结论、证据与顺序',
    description: '每个节点都绑定证据，并覆盖任务要求。',
  },
  {
    kicker: '05 / DRAFT',
    title: '逐页编辑并核验',
    description: '修改内容、讲稿与视觉提示，及时修正问题。',
  },
  {
    kicker: '06 / EXPORT',
    title: '生成正式交付文件',
    description: '下载并核对需要提交的文件与项目记录。',
  },
] as const;

function formatFileSize(bytes: number) {
  if (bytes < 1_024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1_048_576) {
    return `${(bytes / 1_024).toFixed(1)} KB`;
  }
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function MaterialIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v5h5M9.5 13h6M9.5 16.5h6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

export function WorkbenchShell({
  onLogin,
  onRegister,
  service,
  initialDraft = emptyWorkbenchDraft,
  initialMaterials = [],
}: WorkbenchShellProps) {
  const [draft, setDraft] = useState<WorkbenchDraft>(initialDraft);
  const [materials, setMaterials] = useState<File[]>(initialMaterials);
  const [materialProgress, setMaterialProgress] = useState<
    Record<string, MaterialProgress>
  >({});
  const [project, setProject] = useState<Project | null>(null);
  const [savePhase, setSavePhase] = useState<SavePhase>('idle');
  const [saveMessage, setSaveMessage] = useState('');
  const [activeStage, setActiveStage] = useState(0);

  useEffect(() => {
    if (service === undefined) {
      return;
    }
    let cancelled = false;
    void service
      .listProjects()
      .then(([latest]) => {
        if (cancelled || latest === undefined) {
          return;
        }
        setProject(latest);
        setDraft(draftFromProject(latest));
        setSavePhase('saved');
        setSaveMessage('任务与材料已保存');
        setActiveStage(latest.sourceFiles.length > 0 ? 1 : 0);
      })
      .catch(() => {
        if (!cancelled) {
          setSavePhase('failed');
          setSaveMessage('无法读取已保存任务，请刷新后重试。');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [service]);

  const materialCount =
    materials.length > 0
      ? materials.length
      : (project?.sourceFiles.length ?? 0);
  const missingFields = missingTaskFields(draft, materialCount);
  const canSave =
    service !== undefined &&
    missingFields.length === 0 &&
    savePhase !== 'saving';
  const outlineStageCallbacks =
    service === undefined || project === null
      ? null
      : createOutlineStageCallbacks(service, project, setProject);
  const activeHeader = stageHeaders[activeStage] ?? stageHeaders[0]!;

  const handleMaterials = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files ?? []);
    setMaterials((current) => {
      const known = new Set(current.map(materialKey));
      return [
        ...current,
        ...selected.filter((file) => !known.has(materialKey(file))),
      ];
    });
    event.currentTarget.value = '';
  };

  const handleDraftChange = (
    event:
      | ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
      | FormEvent<HTMLInputElement>,
  ) => {
    const field = event.currentTarget.name as keyof WorkbenchDraft;
    const value = event.currentTarget.value;
    setDraft((current) => ({
      ...current,
      [field]: value,
    }));
    if (savePhase !== 'idle') {
      setSavePhase('idle');
      setSaveMessage('');
    }
  };

  const setProgress = (file: File, progress: MaterialProgress) => {
    setMaterialProgress((current) => ({
      ...current,
      [materialKey(file)]: progress,
    }));
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const outputFormat = draft.outputFormat;
    if (!canSave || service === undefined || outputFormat === '') {
      return;
    }

    setSavePhase('saving');
    setSaveMessage('正在保存任务并处理材料…');
    try {
      let currentProject = await service.createProject({
        projectTitle: draft.taskName.trim(),
        taskName: draft.taskName.trim(),
        audience: draft.audience.trim(),
        deadline: draft.deadline,
        scope: draft.scope.trim(),
        durationMinutes: draft.durationMinutes.trim(),
        outputFormat,
        tone: draft.tone || 'concise',
        rubric: [
          {
            title: '评分标准',
            description: draft.rubric.trim(),
            weightPercent: 100,
          },
        ],
        requiredContent: draft.requiredContent,
        forbiddenContent: draft.forbiddenContent,
      });
      setProject(currentProject);

      let failedCount = 0;
      for (const file of materials) {
        setProgress(file, {
          status: 'parsing',
          message: '正在读取文件内容',
        });
        try {
          const result = await service.ingestSourceFile(
            currentProject.id,
            file,
          );
          currentProject = result.project;
          setProject(result.project);
          if (result.status === 'failed') {
            failedCount += 1;
            setProgress(file, {
              status: 'failed',
              message: errorMessage({ code: result.errorCode }),
            });
          } else if (result.status === 'duplicate') {
            setProgress(file, {
              status: 'duplicate',
              message: '相同内容已在当前任务中',
            });
          } else {
            setProgress(file, {
              status: 'ready',
              message: `${String(result.chunks.length)} 个可追溯片段`,
            });
          }
        } catch (reason) {
          failedCount += 1;
          setProgress(file, {
            status: 'failed',
            message: errorMessage(reason),
          });
        }
      }

      setSavePhase(failedCount === 0 ? 'saved' : 'failed');
      setSaveMessage(
        failedCount === 0
          ? '任务与材料已保存'
          : `${String(failedCount)} 个材料需要处理`,
      );
      setActiveStage(1);
    } catch (reason) {
      setSavePhase('failed');
      setSaveMessage(errorMessage(reason));
    }
  };

  return (
    <main className="workbench-shell" id="main-content">
      <header className="workbench-topbar">
        <a className="brand-lockup" href="/" aria-label="做成首页">
          <span aria-hidden="true">■</span>
          <b>做成</b>
          <small>STUDENT WORKBENCH</small>
        </a>
        <div className="workbench-topbar__context">
          <span>任务工作台</span>
          <i aria-hidden="true" />
          <strong>
            {project?.title ?? (draft.taskName.trim() || '未命名任务')}
          </strong>
        </div>
        <nav className="workbench-account" aria-label="账号">
          <button
            className="button button--quiet button--compact"
            onClick={onLogin}
            type="button"
          >
            登录
          </button>
          <button
            className="button button--compact"
            onClick={onRegister}
            type="button"
          >
            注册
          </button>
        </nav>
      </header>

      <header className="workbench-project-header">
        <div>
          <p className="eyebrow">{activeHeader.kicker}</p>
          <h1>{activeHeader.title}</h1>
          <p>{activeHeader.description}</p>
        </div>
        <div className="workbench-project-status" role="status">
          <span aria-hidden="true" />
          <div>
            <strong>
              {savePhase === 'saving'
                ? '保存中'
                : savePhase === 'saved'
                  ? '已保存'
                  : savePhase === 'failed'
                    ? '需要处理'
                    : '未保存'}
            </strong>
            <small>
              {saveMessage || '当前填写尚未写入项目'}
            </small>
          </div>
        </div>
      </header>

      <div className="workbench-layout">
        <aside className="workflow-rail">
          <div className="workflow-rail__heading">
            <span>WORKFLOW</span>
            <strong>6 个阶段</strong>
          </div>
          <ol aria-label="任务工作流">
            {workflowStages.map((stage, index) => {
              const active = index === activeStage;
              const available =
                index === 0 ||
                (index === 1 && project !== null) ||
                (index === 2 &&
                  (project?.sourceChunks.length ?? 0) > 0) ||
                (index === 3 &&
                  hasConfirmedVerifiedEvidence(project));
              return (
                <li className={active ? 'is-active' : undefined} key={stage.number}>
                  <button
                    aria-current={active ? 'step' : undefined}
                    disabled={!available}
                    onClick={() => {
                      setActiveStage(index);
                    }}
                    type="button"
                  >
                    <span className="workflow-stage__number">{stage.number}</span>
                    <span className="workflow-stage__copy">
                      <strong>{stage.label}</strong>
                      <small>{stage.description}</small>
                      {available || stage.prerequisite === null ? null : (
                        <em>{stage.prerequisite}</em>
                      )}
                    </span>
                    <span className="workflow-stage__state" aria-hidden="true">
                      {active ? '●' : '○'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>

        <section aria-label="任务工作区" className="workbench-canvas">
          {activeStage < 2 ? (
          <header className="workbench-section-header">
            <div>
              <span className="section-kicker">
                {activeStage === 0 ? '01 / DEFINE' : '02 / SOURCES'}
              </span>
              <h2 id="task-definition-title">
                {activeStage === 0 ? '任务定义与交付约束' : '材料解析与原文锚点'}
              </h2>
              <p>
                {activeStage === 0
                  ? '这些字段将决定后续证据筛选、结构和核验标准。'
                  : '逐项检查解析结果，并从真实页码与原文中继续选择证据。'}
              </p>
            </div>
            <span className="status-pill">
              {activeStage === 0
                ? savePhase === 'saving'
                  ? '保存中'
                  : '填写中'
                : `${String(project?.sourceChunks.length ?? 0)} 个片段`}
            </span>
          </header>
          ) : null}

          {activeStage === 0 ? (
          <form
            className="task-definition-form"
            id="task-definition-form"
            onSubmit={(event) => {
              void handleSave(event);
            }}
          >
            <div className="field field--span-2">
              <label htmlFor="task-name">任务名称</label>
              <input
                id="task-name"
                maxLength={120}
                name="taskName"
                onChange={handleDraftChange}
                placeholder="例如：人工智能课程期末汇报"
                required
                value={draft.taskName}
              />
            </div>
            <div className="field">
              <label htmlFor="task-audience">听众</label>
              <input
                id="task-audience"
                maxLength={160}
                name="audience"
                onChange={handleDraftChange}
                placeholder="老师、同学、评委…"
                required
                value={draft.audience}
              />
            </div>
            <div className="field">
              <label htmlFor="task-deadline">截止时间</label>
              <input
                id="task-deadline"
                name="deadline"
                onInput={handleDraftChange}
                required
                type="datetime-local"
                value={draft.deadline}
              />
            </div>
            <div className="field">
              <label htmlFor="task-scope">页面或字数</label>
              <input
                id="task-scope"
                maxLength={80}
                name="scope"
                onChange={handleDraftChange}
                placeholder="例如：12 页 / 3000 字"
                required
                value={draft.scope}
              />
            </div>
            <div className="field">
              <label htmlFor="task-duration">演讲时长</label>
              <div className="input-with-suffix">
                <input
                  id="task-duration"
                  min={1}
                  name="durationMinutes"
                  onChange={handleDraftChange}
                  placeholder="10"
                  type="number"
                  value={draft.durationMinutes}
                />
                <span>分钟</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="task-format">输出格式</label>
              <select
                id="task-format"
                name="outputFormat"
                onChange={handleDraftChange}
                required
                value={draft.outputFormat}
              >
                <option disabled value="">
                  选择格式
                </option>
                <option value="presentation">演示文稿</option>
                <option value="report">报告</option>
                <option value="document">文档</option>
                <option value="markdown">Markdown</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="task-tone">语气</label>
              <select
                id="task-tone"
                name="tone"
                onChange={handleDraftChange}
                value={draft.tone}
              >
                <option disabled value="">
                  选择语气
                </option>
                <option value="academic">学术严谨</option>
                <option value="concise">清晰简洁</option>
                <option value="persuasive">有说服力</option>
                <option value="narrative">叙事表达</option>
              </select>
            </div>
            <div className="field field--span-2">
              <label htmlFor="task-rubric">评分标准</label>
              <textarea
                id="task-rubric"
                maxLength={2_000}
                name="rubric"
                onChange={handleDraftChange}
                placeholder="粘贴评分表，或写下老师最看重的判断标准"
                rows={3}
                value={draft.rubric}
              />
            </div>
            <div className="field">
              <label htmlFor="task-required">必须包含</label>
              <textarea
                id="task-required"
                maxLength={1_000}
                name="requiredContent"
                onChange={handleDraftChange}
                placeholder="每行一项"
                rows={3}
                value={draft.requiredContent}
              />
            </div>
            <div className="field">
              <label htmlFor="task-forbidden">禁止包含</label>
              <textarea
                id="task-forbidden"
                maxLength={1_000}
                name="forbiddenContent"
                onChange={handleDraftChange}
                placeholder="每行一项"
                rows={3}
                value={draft.forbiddenContent}
              />
            </div>
          </form>
          ) : null}

          {activeStage < 2 ? (
          <section
            aria-labelledby="materials-title"
            className="material-panel"
          >
            <header>
              <div>
                <span className="section-kicker">SOURCE MATERIALS</span>
                <h2 id="materials-title">添加任务材料</h2>
                <p>添加评分标准、课程要求、参考资料或已有草稿，用于选择证据和核对内容。</p>
              </div>
              <span
                aria-atomic="true"
                aria-live="polite"
                className="material-panel__count"
              >
                {String(materialCount)} 个文件
              </span>
            </header>

            {activeStage === 0 ? (
              <div className="material-picker">
                <input
                  accept=".pdf,.docx,.pptx,.txt,.md,image/*"
                  className="sr-only"
                  id="source-files"
                  multiple
                  onChange={handleMaterials}
                  type="file"
                />
                <label htmlFor="source-files">
                  <span className="material-picker__icon">
                    <MaterialIcon />
                  </span>
                  <strong>选择材料文件</strong>
                  <small>PDF、DOCX、PPTX、TXT、Markdown 或图片</small>
                </label>
              </div>
            ) : null}

            {materialCount === 0 ? (
              <div className="material-empty">
                <span aria-hidden="true">◇</span>
                <div>
                  <strong>尚未添加材料</strong>
                  <p>添加材料后，可按文件名、类型和大小逐项检查，状态为待解析。</p>
                </div>
              </div>
            ) : materials.length > 0 ? (
              <ul className="material-list" aria-label="已选择材料">
                {materials.map((file, index) => (
                  <li key={`${file.name}-${String(file.lastModified)}-${String(index)}`}>
                    <span className="material-list__icon">
                      <MaterialIcon />
                    </span>
                    <div>
                      <strong>{file.name}</strong>
                      <small>
                        {file.type || '未知类型'} · {formatFileSize(file.size)}
                      </small>
                    </div>
                    <span className="material-list__result">
                      <span className="status-pill">
                        {materialStatusLabel(materialProgress[materialKey(file)])}
                      </span>
                      {materialProgress[materialKey(file)]?.message ? (
                        <small>
                          {materialProgress[materialKey(file)]?.message}
                        </small>
                      ) : null}
                    </span>
                    {activeStage === 0 ? (
                      <button
                        className="text-action"
                        onClick={() => {
                          setMaterials((current) =>
                            current.filter(
                              (_, materialIndex) => materialIndex !== index,
                            ),
                          );
                        }}
                        type="button"
                      >
                        移除
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="material-list" aria-label="已保存材料">
                {project?.sourceFiles.map((source) => (
                  <li key={source.id}>
                    <span className="material-list__icon">
                      <MaterialIcon />
                    </span>
                    <div>
                      <strong>{source.fileName}</strong>
                      <small>
                        {source.mediaType} · {formatFileSize(source.sizeBytes)}
                      </small>
                    </div>
                    <span className="material-list__result">
                      <span className="status-pill">
                        {source.status === 'ready'
                          ? '已解析'
                          : source.status === 'failed'
                            ? '解析失败'
                            : '处理中'}
                      </span>
                      <small>
                        {source.status === 'ready'
                          ? `${String(source.pageCount ?? 0)} 个可追溯片段`
                          : source.error?.message}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {activeStage === 1 && (project?.sourceChunks.length ?? 0) > 0 ? (
              <ol className="source-chunk-list" aria-label="已解析原文片段">
                {project?.sourceChunks.slice(0, 100).map((chunk) => (
                  <li key={chunk.id}>
                    <span>第 {String(chunk.pageNumber)} 页</span>
                    <p>{chunk.text}</p>
                    <small>
                      字符 {String(chunk.characterStart)}–
                      {String(chunk.characterEnd)}
                    </small>
                  </li>
                ))}
              </ol>
            ) : null}
          </section>
          ) : null}

          {activeStage === 2 && project !== null ? (
            <EvidenceStage
              evidenceCards={project.evidenceCards}
              onCreateEvidence={async (
                input: EvidenceStageCreateInput,
              ) => {
                if (service === undefined) {
                  throw new Error('当前任务无法写入，请刷新后重试。');
                }
                try {
                  const next = await service.createEvidence(
                    project.id,
                    input,
                  );
                  setProject(next);
                  setSavePhase('saved');
                  setSaveMessage(
                    `已保存 ${String(next.evidenceCards.length)} 条证据`,
                  );
                } catch (reason) {
                  throw new Error(errorMessage(reason), {
                    cause: reason,
                  });
                }
              }}
              project={project}
            />
          ) : null}

          {activeStage === 3 &&
          project !== null &&
          outlineStageCallbacks !== null ? (
            <OutlineStage
              {...outlineStageCallbacks}
              outlines={project.outlines}
              project={project}
            />
          ) : null}

          {activeStage === 0 ? (
            <footer className="workbench-canvas__footer">
              <div aria-live="polite">
                <strong>
                  {missingFields.length === 0
                    ? '可以保存任务'
                    : '还缺少必填信息'}
                </strong>
                <span>
                  {missingFields.length === 0
                    ? '保存后将逐项解析材料。'
                    : `请补充：${missingFields.join('、')}。`}
                </span>
              </div>
              <button
                aria-describedby="save-task-requirement"
                className="button button--primary"
                disabled={!canSave}
                form="task-definition-form"
                type="submit"
              >
                {savePhase === 'saving' ? '正在处理…' : '保存并继续'}
              </button>
              <span className="sr-only" id="save-task-requirement">
                {missingFields.length === 0
                  ? '保存任务并处理材料'
                  : `请先补充${missingFields.join('、')}`}
              </span>
            </footer>
          ) : null}
        </section>

        <aside className="workbench-inspector">
          <header>
            <span className="section-kicker">DELIVERY CHECK</span>
            <h2>交付检查</h2>
          </header>
          <ul>
            {[
              {
                label: '任务目标与听众明确',
                complete:
                  draft.taskName.trim().length > 0 &&
                  draft.audience.trim().length > 0,
              },
              {
                label: '截止与篇幅已填写',
                complete:
                  draft.deadline.trim().length > 0 &&
                  draft.scope.trim().length > 0,
              },
              {
                label: '输出格式已选择',
                complete: draft.outputFormat.trim().length > 0,
              },
              {
                label: '评分标准可核对',
                complete: draft.rubric.trim().length > 0,
              },
              {
                label: '至少一份材料可追溯',
                complete: (project?.sourceChunks.length ?? 0) > 0,
              },
            ].map((item) => (
              <li className={item.complete ? 'is-complete' : undefined} key={item.label}>
                <span className="check-placeholder">
                  <CheckIcon />
                </span>
                <span>{item.label}</span>
              </li>
            ))}
          </ul>
          <div className="workbench-inspector__next">
            <span>下一阶段</span>
            <strong>
              {activeStage === 0
                ? '材料解析'
                : activeStage === 1
                  ? '选择证据'
                  : activeStage === 2
                    ? '组织结构'
                    : activeStage === 3
                      ? '编辑核验'
                      : activeStage === 4
                        ? '正式导出'
                        : '完成交付'}
            </strong>
            <p>
              {activeStage === 0
                ? '添加材料并保存任务后开放。'
                : activeStage === 1
                  ? `${String(project?.sourceChunks.length ?? 0)} 个原文片段已保留页码与定位。`
                  : `${String(project?.evidenceCards.length ?? 0)} 条证据已核对并保存。`}
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}

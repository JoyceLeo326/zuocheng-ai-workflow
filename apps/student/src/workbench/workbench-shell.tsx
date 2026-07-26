import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import {
  AISettingsPanel,
  type AISettingsPanelProps,
} from '../ai/ai-settings-panel.js';
import type { WorkflowAssistant } from '../ai/workflow-assistant.js';
import { WorkflowAssistantWorkspace } from '../ai/workflow-assistant-workspace.js';
import {
  AcquisitionPanel,
  type OcrAcquisitionService,
  type UrlAcquisitionService,
} from '../acquisition/index.js';
import {
  ActivityPrivacyPanel,
  type ProductEventLedger,
} from '../analytics/index.js';
import {
  CourseCenter,
  type CourseCenterProps,
} from '../course/index.js';
import { SyncCenter, type SyncCenterProps, type SyncLocalProjectOption } from '../sync/index.js';
import {
  ProjectTemplatePicker,
  type ProjectTemplate,
} from '../templates/index.js';
import type { Artifact, Project } from './project-model.js';
import {
  DraftStage,
  type DraftStageCallbacks,
  type DraftStagePage,
} from './draft-stage.js';
import { verifyDraft } from './draft-verification.js';
import {
  EvidenceStage,
  type EvidenceStageCreateInput,
} from './evidence-stage.js';
import { ExportStage } from './export-stage.js';
import {
  OutlineStage,
  type OutlineStageCallbacks,
} from './outline-stage.js';
import {
  ProjectManager,
  type ManagedProject,
  type ProjectManagerCallbacks,
} from './project-manager.js';
import {
  createProjectManagerController,
  mapManagedProject,
} from './project-manager-controller.js';
import {
  SourceManager,
  type SourceManagerCallbacks,
} from './source-manager.js';
import {
  DRAFT_ARTIFACT_FORMAT,
  readDraftArtifactPayload,
  type DraftArtifactPayload,
  type SourceIngestionResult,
  type WorkbenchProjectFormInput,
  type WorkbenchProjectLifecycleService,
  type WorkbenchService,
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
  aiSettings?: AISettingsPanelProps;
  workflowAssistant?: WorkflowAssistant | undefined;
  acquisition?: Readonly<{
    ocrService: OcrAcquisitionService;
    urlService: UrlAcquisitionService;
  }>;
  activityLedger?: ProductEventLedger;
  courseCenter?: Omit<
    CourseCenterProps,
    'projects' | 'onOpenProjects'
  >;
  syncCenter?: Omit<
    SyncCenterProps,
    'localProjects' | 'onLocalChange'
  >;
  service?: WorkbenchProjectLifecycleService;
  initialDraft?: WorkbenchDraft;
  initialMaterials?: File[];
  initialProject?: Project;
  initialView?: WorkbenchView;
}

export type WorkbenchView =
  | 'workbench'
  | 'projects'
  | 'courses'
  | 'templates'
  | 'sync'
  | 'assistant'
  | 'acquisition'
  | 'activity';

export type WorkbenchViewState = Readonly<{
  activeStage: number;
  aiSettingsOpen: boolean;
}>;

export type WorkbenchViewEvent =
  | Readonly<{ type: 'set-stage'; stage: number }>
  | Readonly<{ type: 'open-ai-settings' }>
  | Readonly<{ type: 'close-ai-settings' }>;

export function workbenchViewReducer(
  state: WorkbenchViewState,
  event: WorkbenchViewEvent,
): WorkbenchViewState {
  if (event.type === 'set-stage') {
    if (
      !Number.isSafeInteger(event.stage) ||
      event.stage < 0 ||
      event.stage >= workflowStages.length
    ) {
      return state;
    }
    return Object.freeze({
      ...state,
      activeStage: event.stage,
    });
  }
  return Object.freeze({
    ...state,
    aiSettingsOpen: event.type === 'open-ai-settings',
  });
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
type DraftPreparationPhase = 'idle' | 'preparing' | 'failed';
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

function rubricFormFromProject(
  project: Project,
): WorkbenchProjectFormInput['rubric'] {
  return project.taskDefinition.rubric.map((criterion) => ({
    title: criterion.title,
    description: criterion.description,
    weightPercent: criterion.weightPercent,
  }));
}

function projectFormFromDraft(
  draft: WorkbenchDraft,
  preparedRubric: WorkbenchProjectFormInput['rubric'] | null,
): WorkbenchProjectFormInput | null {
  if (draft.outputFormat === '') {
    return null;
  }
  return {
    projectTitle: draft.taskName.trim(),
    taskName: draft.taskName.trim(),
    audience: draft.audience.trim(),
    deadline: draft.deadline,
    scope: draft.scope.trim(),
    durationMinutes: draft.durationMinutes.trim(),
    outputFormat: draft.outputFormat,
    tone: draft.tone || 'concise',
    rubric:
      preparedRubric === null
        ? [
            {
              title: '评分标准',
              description: draft.rubric.trim(),
              weightPercent: 100,
            },
          ]
        : preparedRubric,
    requiredContent: draft.requiredContent,
    forbiddenContent: draft.forbiddenContent,
  };
}

function projectDefinitionFingerprint(
  input: WorkbenchProjectFormInput,
): string {
  return JSON.stringify(input);
}

function draftFromTemplateForm(
  form: WorkbenchProjectFormInput,
): WorkbenchDraft {
  return {
    taskName: form.taskName,
    audience: form.audience,
    deadline: form.deadline,
    scope: form.scope,
    durationMinutes: form.durationMinutes,
    outputFormat: form.outputFormat,
    tone: form.tone,
    rubric: form.rubric
      .map(
        (criterion) =>
          `${criterion.title}（${String(criterion.weightPercent)}%）：${criterion.description}`,
      )
      .join('\n'),
    requiredContent: form.requiredContent,
    forbiddenContent: form.forbiddenContent,
  };
}

function syncProjectOption(project: Project): SyncLocalProjectOption {
  return {
    id: project.id,
    title: project.title,
    version: project.version,
    updatedAt: project.updatedAt,
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

export function createSourceManagerCallbacks(
  service: WorkbenchService,
  project: Project,
  onProjectChange: (next: Project) => void,
): SourceManagerCallbacks {
  const persistIngestion = async (
    operation: () => Promise<SourceIngestionResult>,
  ) => {
    const result = await operation();
    onProjectChange(result.project);
  };
  return {
    onAppendFiles: async ({ files }) => {
      for (const file of files) {
        await persistIngestion(() =>
          service.ingestSourceFile(project.id, file),
        );
      }
    },
    onRetrySource: ({ sourceFileId }) =>
      persistIngestion(() =>
        service.retrySourceFile(project.id, sourceFileId),
      ),
    onReplaceSource: ({ sourceFileId, file }) =>
      persistIngestion(() =>
        service.replaceSourceFile(
          project.id,
          sourceFileId,
          file,
        ),
      ),
    onDeleteSource: async ({ sourceFileId }) => {
      const next = await service.deleteSourceFile(
        project.id,
        sourceFileId,
      );
      onProjectChange(next);
    },
  };
}

export interface DraftArtifactView {
  artifact: Artifact;
  payload: DraftArtifactPayload;
  pages: readonly DraftStagePage[];
}

export function findDraftArtifact(
  project: Project | null,
): DraftArtifactView | null {
  if (project === null) {
    return null;
  }
  const activeOutlineId =
    project.activeOutlineId ??
    project.outlines.find(
      (outline) =>
        outline.status === 'selected' || outline.status === 'locked',
    )?.id ??
    null;
  if (activeOutlineId === null) {
    return null;
  }
  for (const artifact of project.artifacts) {
    if (
      artifact.outlineId !== activeOutlineId ||
      typeof artifact.payload !== 'object' ||
      artifact.payload === null ||
      Array.isArray(artifact.payload) ||
      artifact.payload.format !== DRAFT_ARTIFACT_FORMAT
    ) {
      continue;
    }
    try {
      const payload = readDraftArtifactPayload(artifact);
      return {
        artifact,
        payload,
        pages: payload.pages.map((record) => ({
          outlineNodeId: record.outlineNodeId,
          page: record.page,
        })),
      };
    } catch {
      return null;
    }
  }
  return null;
}

export function workbenchStageAvailable(
  index: number,
  project: Project | null,
): boolean {
  if (index === 0) {
    return true;
  }
  if (index === 1) {
    return project !== null;
  }
  if (index === 2) {
    return (project?.sourceChunks.length ?? 0) > 0;
  }
  if (index === 3) {
    return hasConfirmedVerifiedEvidence(project);
  }
  const activeOutline =
    project?.outlines.find(
      (outline) => outline.id === project.activeOutlineId,
    ) ?? null;
  if (index === 4) {
    return (
      activeOutline?.status === 'selected' ||
      activeOutline?.status === 'locked'
    );
  }
  if (index === 5) {
    const draft = findDraftArtifact(project);
    return (
      draft !== null &&
      draft.pages.length > 0 &&
      (project?.verificationResults.some(
        (result) => result.artifactId === draft.artifact.id,
      ) ??
        false)
    );
  }
  return false;
}

export function projectStageFor(project: Project): number {
  if (findDraftArtifact(project) !== null) {
    return 4;
  }
  if (
    project.activeOutlineId !== null &&
    project.outlines.some(
      (outline) =>
        outline.id === project.activeOutlineId &&
        (outline.status === 'selected' ||
          outline.status === 'locked'),
    )
  ) {
    return 3;
  }
  if (project.evidenceCards.length > 0) {
    return 2;
  }
  if (
    project.sourceFiles.length > 0 ||
    project.sourceChunks.length > 0
  ) {
    return 1;
  }
  return 0;
}

export function createDraftStageCallbacks(
  service: WorkbenchService,
  project: Project,
  draft: DraftArtifactView,
  onProjectChange: (next: Project) => void,
): DraftStageCallbacks {
  const persist = async (operation: () => Promise<Project>) => {
    let next = await operation();
    const artifact = next.artifacts.find(
      (candidate) => candidate.id === draft.artifact.id,
    );
    if (artifact !== undefined) {
      const payload = readDraftArtifactPayload(artifact);
      if (payload.pages.length > 0) {
        next = await service.verifyDraftArtifact(
          next.id,
          artifact.id,
        );
      }
    }
    onProjectChange(next);
  };
  return {
    onInsertPage: ({ outlineNodeId, index, page }) =>
      persist(() =>
        service.insertDraftPage(project.id, draft.artifact.id, {
          outlineNodeId,
          index,
          page,
        }),
      ),
    onUpdatePage: ({ pageId, patch }) =>
      persist(() =>
        service.updateDraftPage(
          project.id,
          draft.artifact.id,
          pageId,
          patch,
        ),
      ),
    onDeletePage: ({ pageId }) =>
      persist(() =>
        service.deleteDraftPage(
          project.id,
          draft.artifact.id,
          pageId,
        ),
      ),
    onReorderPage: ({ pageId, targetIndex }) =>
      persist(() =>
        service.reorderDraftPage(
          project.id,
          draft.artifact.id,
          pageId,
          targetIndex,
        ),
      ),
    onSetPageLocked: ({ pageId, locked }) =>
      persist(() =>
        service.setDraftPageLocked(
          project.id,
          draft.artifact.id,
          pageId,
          locked,
        ),
      ),
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
  aiSettings,
  workflowAssistant,
  acquisition,
  activityLedger,
  courseCenter,
  syncCenter,
  service,
  initialDraft,
  initialMaterials = [],
  initialProject,
  initialView = 'workbench',
}: WorkbenchShellProps) {
  const [draft, setDraft] = useState<WorkbenchDraft>(
    initialDraft ??
      (initialProject === undefined
        ? emptyWorkbenchDraft
        : draftFromProject(initialProject)),
  );
  const [materials, setMaterials] = useState<File[]>(initialMaterials);
  const [materialProgress, setMaterialProgress] = useState<
    Record<string, MaterialProgress>
  >({});
  const [project, setProject] = useState<Project | null>(
    initialProject ?? null,
  );
  const [savePhase, setSavePhase] = useState<SavePhase>(
    initialProject === undefined ? 'idle' : 'saved',
  );
  const [saveMessage, setSaveMessage] = useState(
    initialProject === undefined ? '' : '任务与材料已保存',
  );
  const [viewState, setViewState] = useState<WorkbenchViewState>({
    activeStage:
      initialProject === undefined
        ? 0
        : projectStageFor(initialProject),
    aiSettingsOpen: false,
  });
  const { activeStage, aiSettingsOpen } = viewState;
  const [view, setView] = useState<WorkbenchView>(initialView);
  const [managedProjects, setManagedProjects] = useState<
    readonly ManagedProject[]
  >(
    initialProject === undefined
      ? []
      : [mapManagedProject(initialProject)],
  );
  const [projectManagerError, setProjectManagerError] = useState('');
  const [syncProjects, setSyncProjects] = useState<
    readonly SyncLocalProjectOption[]
  >(
    initialProject === undefined
      ? []
      : [syncProjectOption(initialProject)],
  );
  const [preparedRubric, setPreparedRubric] = useState<
    WorkbenchProjectFormInput['rubric'] | null
  >(initialProject === undefined ? null : rubricFormFromProject(initialProject));
  const [draftPreparationPhase, setDraftPreparationPhase] =
    useState<DraftPreparationPhase>('idle');
  const [draftPreparationMessage, setDraftPreparationMessage] =
    useState('');
  const aiSettingsButtonRef = useRef<HTMLButtonElement>(null);
  const autoSaveInFlightRef = useRef(false);
  const lastDefinitionFingerprintRef = useRef<string | null>(
    initialProject === undefined
      ? null
      : projectDefinitionFingerprint({
          ...projectFormFromDraft(
            draftFromProject(initialProject),
            rubricFormFromProject(initialProject),
          )!,
        }),
  );

  const restoreProjectState = useCallback((next: Project) => {
    const nextDraft = draftFromProject(next);
    const nextRubric = rubricFormFromProject(next);
    setProject(next);
    setDraft(nextDraft);
    setPreparedRubric(nextRubric);
    const nextInput = projectFormFromDraft(nextDraft, nextRubric);
    lastDefinitionFingerprintRef.current =
      nextInput === null ? null : projectDefinitionFingerprint(nextInput);
    setMaterials([]);
    setMaterialProgress({});
    setSavePhase('saved');
    setSaveMessage('任务与材料已保存');
    setViewState((current) =>
      workbenchViewReducer(current, {
        type: 'set-stage',
        stage: projectStageFor(next),
      }),
    );
    setDraftPreparationPhase('idle');
    setDraftPreparationMessage('');
  }, []);

  const prepareNewProjectState = useCallback((title: string) => {
    setProject(null);
    setDraft({
      ...emptyWorkbenchDraft,
      taskName: title,
    });
    setPreparedRubric(null);
    lastDefinitionFingerprintRef.current = null;
    setMaterials([]);
    setMaterialProgress({});
    setSavePhase('idle');
    setSaveMessage('');
    setViewState((current) =>
      workbenchViewReducer(current, {
        type: 'set-stage',
        stage: 0,
      }),
    );
    setDraftPreparationPhase('idle');
    setDraftPreparationMessage('');
    setView('workbench');
  }, []);

  const projectManagerController = useMemo(
    () =>
      service === undefined
        ? null
        : createProjectManagerController({
            service,
            openProject: async (next) => {
              restoreProjectState(next);
              setView('workbench');
            },
            prepareNewProject: async (title) => {
              prepareNewProjectState(title);
            },
          }),
    [prepareNewProjectState, restoreProjectState, service],
  );

  useEffect(() => {
    if (service === undefined) {
      return;
    }
    let cancelled = false;
    void service
      .listProjects()
      .then((projects) => {
        if (cancelled) {
          return;
        }
        setManagedProjects(projects.map(mapManagedProject));
        setSyncProjects(projects.map(syncProjectOption));
        if (initialProject !== undefined) {
          return;
        }
        const latest =
          projects.find((candidate) => candidate.status === 'active') ??
          projects.find((candidate) => candidate.status === 'archived');
        if (latest !== undefined) {
          restoreProjectState(latest);
        }
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
  }, [initialProject, restoreProjectState, service]);

  const syncProjectStateAfterMutation = async () => {
    if (service === undefined) {
      return;
    }
    const projects = await service.listProjects();
    setManagedProjects(projects.map(mapManagedProject));
    setSyncProjects(projects.map(syncProjectOption));
    if (project === null) {
      return;
    }
    const current = projects.find(
      (candidate) =>
        candidate.id === project.id &&
        candidate.status === 'active',
    );
    const next =
      current ??
      projects.find((candidate) => candidate.status === 'active') ??
      null;
    if (next === null) {
      setProject(null);
      setDraft(emptyWorkbenchDraft);
      setMaterials([]);
      setMaterialProgress({});
      setSavePhase('idle');
      setSaveMessage('');
      setViewState((current) =>
        workbenchViewReducer(current, {
          type: 'set-stage',
          stage: 0,
        }),
      );
      return;
    }
    restoreProjectState(next);
  };

  const projectManagerCallbacks: ProjectManagerCallbacks | null =
    projectManagerController === null
      ? null
      : {
          onOpen: projectManagerController.onOpen,
          onCreate: projectManagerController.onCreate,
          onDuplicate: async (input) => {
            await projectManagerController.onDuplicate(input);
            await syncProjectStateAfterMutation();
          },
          onArchive: async (input) => {
            await projectManagerController.onArchive(input);
            await syncProjectStateAfterMutation();
          },
          onRestore: async (input) => {
            await projectManagerController.onRestore(input);
            await syncProjectStateAfterMutation();
          },
          onMoveToTrash: async (input) => {
            await projectManagerController.onMoveToTrash(input);
            await syncProjectStateAfterMutation();
          },
          onDeletePermanently: async (input) => {
            await projectManagerController.onDeletePermanently(input);
            await syncProjectStateAfterMutation();
          },
          onExportProjectPackage:
            projectManagerController.onExportProjectPackage,
          onImportProjectPackage: async (input) => {
            await projectManagerController.onImportProjectPackage(input);
            await syncProjectStateAfterMutation();
          },
        };

  const showProjectManager = () => {
    if (projectManagerController === null) {
      return;
    }
    setProjectManagerError('');
    setViewState((current) =>
      workbenchViewReducer(current, {
        type: 'close-ai-settings',
      }),
    );
    setView('projects');
    void projectManagerController
      .refresh()
      .then(setManagedProjects)
      .catch((reason: unknown) => {
        setProjectManagerError(errorMessage(reason));
      });
  };

  const showCourseCenter = () => {
    if (courseCenter === undefined) {
      return;
    }
    setViewState((current) =>
      workbenchViewReducer(current, {
        type: 'close-ai-settings',
      }),
    );
    setView('courses');
    if (service !== undefined) {
      void service
        .listProjects()
        .then((projects) => {
          setManagedProjects(projects.map(mapManagedProject));
          setSyncProjects(projects.map(syncProjectOption));
        })
        .catch(() => {
          // Course content remains available when projects cannot refresh.
        });
    }
  };

  const showTemplatePicker = () => {
    setViewState((current) =>
      workbenchViewReducer(current, {
        type: 'close-ai-settings',
      }),
    );
    setView('templates');
  };

  const showSyncCenter = () => {
    if (syncCenter === undefined) {
      return;
    }
    setViewState((current) =>
      workbenchViewReducer(current, {
        type: 'close-ai-settings',
      }),
    );
    setView('sync');
    if (service !== undefined) {
      void service
        .listProjects()
        .then((projects) => {
          setManagedProjects(projects.map(mapManagedProject));
          setSyncProjects(projects.map(syncProjectOption));
        })
        .catch(() => {
          // The sync center preserves its current list when refresh fails.
        });
    }
  };

  const showWorkflowAssistant = () => {
    setViewState((current) =>
      workbenchViewReducer(current, {
        type: 'close-ai-settings',
      }),
    );
    setView('assistant');
  };

  const showAcquisition = () => {
    if (
      acquisition === undefined ||
      project === null ||
      service?.ingestAcquiredMaterial === undefined
    ) {
      return;
    }
    setViewState((current) =>
      workbenchViewReducer(current, {
        type: 'close-ai-settings',
      }),
    );
    setView('acquisition');
  };

  const showActivity = () => {
    if (activityLedger === undefined) {
      return;
    }
    setViewState((current) =>
      workbenchViewReducer(current, {
        type: 'close-ai-settings',
      }),
    );
    setView('activity');
  };

  const applyTemplate = (
    _template: ProjectTemplate,
    form: WorkbenchProjectFormInput,
  ) => {
    setProject(null);
    setDraft(draftFromTemplateForm(form));
    setPreparedRubric(form.rubric);
    setMaterials([]);
    setMaterialProgress({});
    setSavePhase('idle');
    setSaveMessage('');
    setViewState((current) =>
      workbenchViewReducer(current, {
        type: 'set-stage',
        stage: 0,
      }),
    );
    setDraftPreparationPhase('idle');
    setDraftPreparationMessage('');
    setView('workbench');
  };

  const refreshLocalProjects = async () => {
    if (service === undefined) {
      return;
    }
    const projects = await service.listProjects();
    setManagedProjects(projects.map(mapManagedProject));
    setSyncProjects(projects.map(syncProjectOption));
    if (project !== null) {
      const current = projects.find(
        (candidate) => candidate.id === project.id,
      );
      if (current !== undefined) {
        restoreProjectState(current);
      }
    }
  };

  const materialCount =
    materials.length > 0
      ? materials.length
      : (project?.sourceFiles.length ?? 0);
  const missingFields = missingTaskFields(draft, materialCount);
  const canSave =
    service !== undefined &&
    missingFields.length === 0 &&
    savePhase !== 'saving';
  const projectFormInput = useMemo(
    () => projectFormFromDraft(draft, preparedRubric),
    [draft, preparedRubric],
  );
  useEffect(() => {
    if (
      activeStage !== 0 ||
      project === null ||
      service?.updateProjectDefinition === undefined ||
      projectFormInput === null ||
      missingFields.length > 0 ||
      savePhase === 'saving'
    ) {
      return;
    }
    const fingerprint = projectDefinitionFingerprint(projectFormInput);
    if (fingerprint === lastDefinitionFingerprintRef.current) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      if (autoSaveInFlightRef.current) {
        return;
      }
      autoSaveInFlightRef.current = true;
      setSavePhase('saving');
      setSaveMessage('正在自动保存修改…');
      void service
        .updateProjectDefinition!(project.id, projectFormInput)
        .then((next) => {
          lastDefinitionFingerprintRef.current = fingerprint;
          setProject(next);
          setManagedProjects((current) => [
            mapManagedProject(next),
            ...current.filter((candidate) => candidate.id !== next.id),
          ]);
          setSyncProjects((current) => [
            syncProjectOption(next),
            ...current.filter((candidate) => candidate.id !== next.id),
          ]);
          setSavePhase('saved');
          setSaveMessage('修改已自动保存');
        })
        .catch((reason: unknown) => {
          setSavePhase('failed');
          setSaveMessage(errorMessage(reason));
        })
        .finally(() => {
          autoSaveInFlightRef.current = false;
        });
    }, 800);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    activeStage,
    missingFields.length,
    project,
    projectFormInput,
    savePhase,
    service,
  ]);
  const outlineStageCallbacks =
    service === undefined || project === null
      ? null
      : createOutlineStageCallbacks(service, project, setProject);
  const sourceManagerCallbacks =
    service === undefined || project === null
      ? null
      : createSourceManagerCallbacks(service, project, setProject);
  const draftArtifact = useMemo(
    () => findDraftArtifact(project),
    [project],
  );
  const draftStageCallbacks =
    service === undefined ||
    project === null ||
    draftArtifact === null
      ? null
      : createDraftStageCallbacks(
          service,
          project,
          draftArtifact,
          setProject,
        );
  const draftVerificationChecks = useMemo(
    () =>
      project === null || draftArtifact === null
        ? []
        : verifyDraft({
            pages: draftArtifact.pages.map((record) => record.page),
            taskDefinition: project.taskDefinition,
            evidenceCards: project.evidenceCards,
          }),
    [draftArtifact, project],
  );
  const activeHeader = stageHeaders[activeStage] ?? stageHeaders[0]!;

  const openStage = (index: number) => {
    if (
      index !== 4 ||
      project === null ||
      service === undefined ||
      project.activeOutlineId === null ||
      draftArtifact !== null
    ) {
      setViewState((current) =>
        workbenchViewReducer(current, {
          type: 'set-stage',
          stage: index,
        }),
      );
      return;
    }
    setViewState((current) =>
      workbenchViewReducer(current, {
        type: 'set-stage',
        stage: index,
      }),
    );
    setDraftPreparationPhase('preparing');
    setDraftPreparationMessage('');
    void service
      .ensureDraftArtifact(project.id, project.activeOutlineId)
      .then((next) => {
        setProject(next);
        setDraftPreparationPhase('idle');
        setSavePhase('saved');
        setSaveMessage('初稿已写入当前项目');
      })
      .catch((reason: unknown) => {
        setDraftPreparationPhase('failed');
        setDraftPreparationMessage(errorMessage(reason));
      });
  };

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
    if (field === 'rubric') {
      setPreparedRubric(null);
    }
    if (savePhase !== 'idle' && savePhase !== 'saving') {
      setSavePhase('idle');
      setSaveMessage(project === null ? '' : '有未保存的修改');
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
    if (!canSave || service === undefined || projectFormInput === null) {
      return;
    }

    setSavePhase('saving');
    setSaveMessage('正在保存任务并处理材料…');
    try {
      let currentProject: Project;
      if (project === null) {
        currentProject = await service.createProject(projectFormInput);
      } else {
        if (service.updateProjectDefinition === undefined) {
          throw new Error('当前工作区不支持修改任务定义。');
        }
        currentProject = await service.updateProjectDefinition(
          project.id,
          projectFormInput,
        );
      }
      lastDefinitionFingerprintRef.current =
        projectDefinitionFingerprint(projectFormInput);
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
      const projects = await service.listProjects();
      setManagedProjects(projects.map(mapManagedProject));
      setSyncProjects(projects.map(syncProjectOption));
      setViewState((current) =>
        workbenchViewReducer(current, {
          type: 'set-stage',
          stage: 1,
        }),
      );
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
          <span>
            {aiSettingsOpen
              ? '连接模型'
              : view === 'activity'
                ? '设置'
              : view === 'acquisition'
                ? '添加材料'
              : view === 'assistant'
                ? 'AI 助手'
              : view === 'templates'
                ? '新建项目'
                : view === 'sync'
                  ? '项目同步'
              : view === 'courses'
                ? '课程中心'
                : view === 'projects'
                  ? '项目管理'
                  : '任务工作台'}
          </span>
          <i aria-hidden="true" />
          <strong>
            {aiSettingsOpen
              ? '模型设置'
              : view === 'activity'
                ? '活动记录与隐私'
              : view === 'acquisition'
                ? '扫描件与网页'
              : view === 'assistant'
                ? '审核并应用候选'
              : view === 'templates'
                ? '选择模板'
                : view === 'sync'
                  ? '跨设备继续'
              : view === 'courses'
                ? '7 天完成一份作品'
                : view === 'projects'
                  ? '全部项目'
                  : (project?.title ??
                    (draft.taskName.trim() || '未命名任务'))}
          </strong>
        </div>
        <nav className="workbench-account" aria-label="工作台导航">
          {courseCenter === undefined ? null : (
            <button
              aria-current={view === 'courses' ? 'page' : undefined}
              className="button button--quiet button--compact workbench-secondary"
              onClick={showCourseCenter}
              type="button"
            >
              课程
            </button>
          )}
          <button
            aria-current={view === 'templates' ? 'page' : undefined}
            className="button button--quiet button--compact workbench-secondary"
            onClick={showTemplatePicker}
            type="button"
          >
            新建
          </button>
          {syncCenter === undefined ? null : (
            <button
              aria-current={view === 'sync' ? 'page' : undefined}
              className="button button--quiet button--compact workbench-secondary"
              onClick={showSyncCenter}
              type="button"
            >
              同步
            </button>
          )}
          <button
            aria-current={view === 'assistant' ? 'page' : undefined}
            className="button button--quiet button--compact workbench-secondary"
            onClick={showWorkflowAssistant}
            type="button"
          >
            AI 助手
          </button>
          {aiSettings === undefined ? null : (
            <button
              aria-controls="workbench-ai-settings"
              aria-expanded={aiSettingsOpen}
              className="button button--quiet button--compact workbench-secondary"
              onClick={() => {
                setViewState((current) =>
                  workbenchViewReducer(current, {
                    type: current.aiSettingsOpen
                      ? 'close-ai-settings'
                      : 'open-ai-settings',
                  }),
                );
              }}
              ref={aiSettingsButtonRef}
              type="button"
            >
              连接模型
            </button>
          )}
          <button
            aria-current={view === 'projects' ? 'page' : undefined}
            className="button button--quiet button--compact workbench-secondary"
            disabled={projectManagerController === null}
            onClick={showProjectManager}
            type="button"
          >
            项目
          </button>
          <details className="workbench-more">
            <summary>更多</summary>
            <div>
              {courseCenter === undefined ? null : (
                <button onClick={showCourseCenter} type="button">
                  课程
                </button>
              )}
              <button onClick={showTemplatePicker} type="button">
                新建项目
              </button>
              {syncCenter === undefined ? null : (
                <button onClick={showSyncCenter} type="button">
                  项目同步
                </button>
              )}
              <button onClick={showWorkflowAssistant} type="button">
                AI 助手
              </button>
              {aiSettings === undefined ? null : (
                <button
                  onClick={() => {
                    setViewState((current) =>
                      workbenchViewReducer(current, {
                        type: 'open-ai-settings',
                      }),
                    );
                  }}
                  type="button"
                >
                  连接模型
                </button>
              )}
              <button
                disabled={projectManagerController === null}
                onClick={showProjectManager}
                type="button"
              >
                项目管理
              </button>
              {activityLedger === undefined ? null : (
                <button onClick={showActivity} type="button">
                  活动记录与隐私
                </button>
              )}
            </div>
          </details>
          {activityLedger === undefined ? null : (
            <button
              aria-current={view === 'activity' ? 'page' : undefined}
              className="button button--quiet button--compact workbench-secondary"
              onClick={showActivity}
              type="button"
            >
              记录
            </button>
          )}
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

      {aiSettingsOpen && aiSettings !== undefined ? (
        <section
          aria-label="模型设置"
          className="workbench-ai-settings"
          id="workbench-ai-settings"
        >
          <div className="workbench-ai-settings__toolbar">
            <button
              autoFocus
              className="button button--quiet"
              onClick={() => {
                setViewState((current) =>
                  workbenchViewReducer(current, {
                    type: 'close-ai-settings',
                  }),
                );
                aiSettingsButtonRef.current?.focus();
              }}
              type="button"
            >
              返回原工作区
            </button>
          </div>
          <AISettingsPanel {...aiSettings} />
        </section>
      ) : view === 'activity' && activityLedger !== undefined ? (
        <section className="workbench-utility-view">
          <div className="workbench-utility-view__toolbar">
            <button
              className="button button--quiet"
              onClick={() => setView('workbench')}
              type="button"
            >
              返回当前项目
            </button>
          </div>
          <ActivityPrivacyPanel ledger={activityLedger} />
        </section>
      ) : view === 'acquisition' &&
        acquisition !== undefined &&
        project !== null &&
        service?.ingestAcquiredMaterial !== undefined ? (
        <section className="workbench-utility-view">
          <div className="workbench-utility-view__toolbar">
            <button
              className="button button--quiet"
              onClick={() => {
                setViewState((current) =>
                  workbenchViewReducer(current, {
                    type: 'set-stage',
                    stage: 1,
                  }),
                );
                setView('workbench');
              }}
              type="button"
            >
              返回材料管理
            </button>
          </div>
          <AcquisitionPanel
            ocrService={acquisition.ocrService}
            onAcquired={async (result, originalFile) => {
              const ingested =
                await service.ingestAcquiredMaterial!(
                  project.id,
                  result,
                  originalFile,
                );
              setProject(ingested.project);
              setSavePhase(
                ingested.status === 'failed' ? 'failed' : 'saved',
              );
              setSaveMessage(
                ingested.status === 'duplicate'
                  ? '此材料已在当前项目中'
                  : ingested.status === 'failed'
                    ? '材料未能解析，请检查后重试'
                    : `${String(ingested.chunks.length)} 个片段已加入项目`,
              );
              const projects = await service.listProjects();
              setManagedProjects(projects.map(mapManagedProject));
              setSyncProjects(projects.map(syncProjectOption));
            }}
            urlService={acquisition.urlService}
          />
        </section>
      ) : view === 'assistant' ? (
        <section className="workbench-utility-view">
          <div className="workbench-utility-view__toolbar">
            <button
              className="button button--quiet"
              onClick={() => setView('workbench')}
              type="button"
            >
              {project === null ? '返回任务编辑' : '返回当前项目'}
            </button>
          </div>
          <WorkflowAssistantWorkspace
            assistant={workflowAssistant}
            onOpenSettings={() => {
              setViewState((current) =>
                workbenchViewReducer(current, {
                  type: 'open-ai-settings',
                }),
              );
            }}
            onProjectChange={restoreProjectState}
            onReturnToWorkbench={() => setView('workbench')}
            project={project}
            service={service}
          />
        </section>
      ) : view === 'templates' ? (
        <section className="workbench-utility-view">
          <div className="workbench-utility-view__toolbar">
            <button
              className="button button--quiet"
              onClick={() => setView('workbench')}
              type="button"
            >
              {project === null ? '返回任务编辑' : '返回当前项目'}
            </button>
          </div>
          <ProjectTemplatePicker
            onCancel={() => setView('workbench')}
            onConfirm={applyTemplate}
          />
        </section>
      ) : view === 'sync' && syncCenter !== undefined ? (
        <section className="workbench-utility-view">
          <div className="workbench-utility-view__toolbar">
            <button
              className="button button--quiet"
              onClick={() => {
                void refreshLocalProjects()
                  .catch(() => undefined)
                  .finally(() => setView('workbench'));
              }}
              type="button"
            >
              {project === null ? '返回任务编辑' : '返回当前项目'}
            </button>
          </div>
          <SyncCenter
            {...syncCenter}
            localProjects={syncProjects}
            onLocalChange={refreshLocalProjects}
          />
        </section>
      ) : view === 'courses' && courseCenter !== undefined ? (
        <section className="workbench-course-center">
          <div className="workbench-course-center__toolbar">
            <button
              className="button button--quiet"
              onClick={() => setView('workbench')}
              type="button"
            >
              {project === null ? '返回任务编辑' : '返回当前项目'}
            </button>
          </div>
          <CourseCenter
            {...courseCenter}
            onOpenProjects={async () => {
              showProjectManager();
            }}
            projects={managedProjects
              .filter((candidate) => candidate.status === 'active')
              .map(({ id, title }) => ({ id, title }))}
          />
        </section>
      ) : view === 'projects' && projectManagerCallbacks !== null ? (
        <section className="workbench-project-manager">
          <div className="workbench-project-manager__toolbar">
            <button
              className="button button--quiet"
              onClick={() => setView('workbench')}
              type="button"
            >
              {project === null ? '返回任务编辑' : '返回当前项目'}
            </button>
          </div>
          {projectManagerError.length > 0 ? (
            <div
              className="workbench-project-manager__error"
              role="alert"
            >
              {projectManagerError}
            </div>
          ) : null}
          <ProjectManager
            {...projectManagerCallbacks}
            projects={managedProjects}
          />
        </section>
      ) : (
        <>
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
              const available = workbenchStageAvailable(index, project);
              return (
                <li className={active ? 'is-active' : undefined} key={stage.number}>
                  <button
                    aria-current={active ? 'step' : undefined}
                    disabled={!available}
                    onClick={() => {
                      openStage(index);
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
            <div className="workbench-section-header__actions">
              <span className="status-pill">
                {activeStage === 0
                  ? savePhase === 'saving'
                    ? '保存中'
                    : '填写中'
                  : `${String(project?.sourceChunks.length ?? 0)} 个片段`}
              </span>
              {activeStage === 1 &&
              acquisition !== undefined &&
              project !== null &&
              service?.ingestAcquiredMaterial !== undefined ? (
                <button
                  className="button button--compact"
                  onClick={showAcquisition}
                  type="button"
                >
                  扫描件 / 网页
                </button>
              ) : null}
            </div>
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

          {activeStage === 0 ? (
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

          </section>
          ) : null}

          {activeStage === 1 &&
          project !== null &&
          sourceManagerCallbacks !== null ? (
            <SourceManager
              {...sourceManagerCallbacks}
              project={project}
              sourceChunks={project.sourceChunks}
              sourceFiles={project.sourceFiles}
            />
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

          {activeStage === 4 &&
          project !== null &&
          draftArtifact !== null &&
          draftStageCallbacks !== null ? (
            <DraftStage
              {...draftStageCallbacks}
              pages={draftArtifact.pages}
              project={project}
            />
          ) : null}

          {activeStage === 4 && draftArtifact === null ? (
            <section
              aria-live="polite"
              className="material-empty"
              role={
                draftPreparationPhase === 'failed'
                  ? 'alert'
                  : 'status'
              }
            >
              <span aria-hidden="true">◇</span>
              <div>
                <strong>
                  {draftPreparationPhase === 'failed'
                    ? '初稿工作区未准备好'
                    : '正在准备初稿工作区'}
                </strong>
                <p>
                  {draftPreparationPhase === 'failed'
                    ? draftPreparationMessage
                    : '结构和证据会保留原样，不会自动填入未经确认的内容。'}
                </p>
                {draftPreparationPhase === 'failed' ? (
                  <button
                    className="button button--primary"
                    onClick={() => openStage(4)}
                    type="button"
                  >
                    重试
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          {activeStage === 5 &&
          project !== null &&
          draftArtifact !== null ? (
            <ExportStage
              draftPages={draftArtifact.pages.map(
                (record) => record.page,
              )}
              project={project}
              verificationChecks={draftVerificationChecks}
            />
          ) : null}

          {activeStage === 0 ? (
            <footer className="workbench-canvas__footer">
              <div aria-live="polite">
                <strong>
                  {missingFields.length === 0
                    ? project === null
                      ? '可以创建任务'
                      : savePhase === 'saving'
                        ? '正在保存修改'
                        : savePhase === 'saved'
                          ? '修改已保存'
                          : '可以继续'
                    : '还缺少必填信息'}
                </strong>
                <span>
                  {missingFields.length === 0
                    ? project === null
                      ? '创建后将逐项解析材料。'
                      : saveMessage || '修改会自动保存。'
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
                {savePhase === 'saving'
                  ? '正在处理…'
                  : project === null
                    ? '创建并继续'
                    : '保存并继续'}
              </button>
              <span className="sr-only" id="save-task-requirement">
                {missingFields.length === 0
                  ? project === null
                    ? '创建任务并处理材料'
                    : '保存任务修改并继续'
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
        </>
      )}
    </main>
  );
}

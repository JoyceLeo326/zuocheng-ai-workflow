import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createBYOKCredentialStore } from '../ai/byok-credential-store.js';
import { MemoryCourseStore } from '../course/index.js';
import { executeOutlineStageAction } from './outline-stage.js';
import type { Project } from './project-model.js';
import {
  WorkbenchShell,
  createDraftStageCallbacks,
  createOutlineStageCallbacks,
  createSourceManagerCallbacks,
  findDraftArtifact,
  hasConfirmedVerifiedEvidence,
  missingTaskFields,
  projectStageFor,
  studentSurfaceForPath,
  workbenchViewReducer,
  workbenchStageAvailable,
  type WorkbenchDraft,
  type WorkbenchViewState,
} from './workbench-shell.js';
import type { WorkbenchProjectLifecycleService } from './workbench-service.js';

const PROJECT_ID = '01900000-0000-7000-8000-000000000601';
const TASK_ID = '01900000-0000-7000-8000-000000000602';
const FILE_ID = '01900000-0000-7000-8000-000000000603';
const CHUNK_ID = '01900000-0000-7000-8000-000000000604';
const EVIDENCE_ID = '01900000-0000-7000-8000-000000000605';
const OUTLINE_ID = '01900000-0000-7000-8000-000000000606';
const NODE_ID = '01900000-0000-7000-8000-000000000607';
const ARTIFACT_ID = '01900000-0000-7000-8000-000000000608';
const PAGE_ID = '01900000-0000-7000-8000-000000000609';
const VERIFICATION_ID = '01900000-0000-7000-8000-000000000610';
const CREATED_AT = '2026-07-27T04:00:00.000Z';

function outlineProject(
  overrides: Partial<Project> = {},
): Project {
  return {
    schemaVersion: 1,
    id: PROJECT_ID,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    title: '结构接入测试',
    status: 'active',
    taskDefinition: {
      id: TASK_ID,
      version: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      taskName: '结构接入测试',
      audience: '课程教师',
      dueAt: '2026-08-15T09:00:00.000Z',
      lengthTarget: { unit: 'pages', value: 3 },
      presentationDurationMinutes: 6,
      outputFormats: ['pptx'],
      rubric: [],
      tone: '清晰',
      mustInclude: [],
      mustAvoid: [],
    },
    sourceFiles: [],
    sourceChunks: [],
    evidenceCards: [
      {
        id: EVIDENCE_ID,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        projectId: PROJECT_ID,
        sourceFileId: FILE_ID,
        sourceChunkId: CHUNK_ID,
        sourceFileVersion: 1,
        pageNumber: 1,
        characterStart: 0,
        characterEnd: 5,
        quote: '真实证据',
        kind: 'fact',
        note: '',
        citation: '课程材料，第 1 页',
        status: 'verified',
        stance: 'support',
        confirmationStatus: 'confirmed',
        userConfirmedAt: CREATED_AT,
      },
    ],
    outlines: [],
    activeOutlineId: null,
    artifacts: [],
    verificationResults: [],
    ...overrides,
  };
}

function outlineService(next: Project): WorkbenchProjectLifecycleService {
  return {
    listProjects: vi.fn().mockResolvedValue([]),
    createProject: vi.fn().mockResolvedValue(next),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    createEvidence: vi.fn().mockResolvedValue(next),
    createOutline: vi.fn().mockResolvedValue(next),
    addOutlineNode: vi.fn().mockResolvedValue(next),
    updateOutlineNode: vi.fn().mockResolvedValue(next),
    deleteOutlineNode: vi.fn().mockResolvedValue(next),
    reorderOutlineNode: vi.fn().mockResolvedValue(next),
    selectOutline: vi.fn().mockResolvedValue(next),
    lockOutline: vi.fn().mockResolvedValue(next),
    ensureDraftArtifact: vi.fn().mockResolvedValue(next),
    insertDraftPage: vi.fn().mockResolvedValue(next),
    updateDraftPage: vi.fn().mockResolvedValue(next),
    deleteDraftPage: vi.fn().mockResolvedValue(next),
    reorderDraftPage: vi.fn().mockResolvedValue(next),
    setDraftPageLocked: vi.fn().mockResolvedValue(next),
    verifyDraftArtifact: vi.fn().mockResolvedValue(next),
    ingestSourceFile: vi.fn(),
    retrySourceFile: vi.fn(),
    replaceSourceFile: vi.fn(),
    deleteSourceFile: vi.fn().mockResolvedValue(next),
    copyProject: vi.fn().mockResolvedValue(next),
    archiveProject: vi.fn().mockResolvedValue(next),
    activateProject: vi.fn().mockResolvedValue(next),
    trashProject: vi.fn().mockResolvedValue(next),
    restoreProject: vi.fn().mockResolvedValue(next),
    permanentlyDeleteProject: vi.fn().mockResolvedValue(undefined),
    exportProjectBundle: vi.fn(),
    importProjectBundle: vi.fn().mockResolvedValue(next),
  };
}

function projectWithDraft(
  overrides: Partial<Project> = {},
): Project {
  return outlineProject({
    outlines: [
      {
        id: OUTLINE_ID,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        projectId: PROJECT_ID,
        title: '证据结构',
        status: 'selected',
        lockedAt: null,
        nodes: [
          {
            id: NODE_ID,
            version: 1,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
            position: 0,
            title: '核心结论',
            conclusion: '结论由课程材料支持。',
            evidenceCardIds: [EVIDENCE_ID],
            coveredRequirements: [],
            rubricCriterionIds: [],
            locked: false,
          },
        ],
      },
    ],
    activeOutlineId: OUTLINE_ID,
    artifacts: [
      {
        id: ARTIFACT_ID,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        projectId: PROJECT_ID,
        outlineId: OUTLINE_ID,
        outlineVersion: 1,
        kind: 'presentation',
        status: 'draft',
        payload: {
          format: 'zuocheng-draft-artifact',
          formatVersion: 1,
          id: ARTIFACT_ID,
          version: 1,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          pages: [
            {
              id: PAGE_ID,
              version: 1,
              createdAt: CREATED_AT,
              updatedAt: CREATED_AT,
              outlineNodeId: NODE_ID,
              page: {
                id: PAGE_ID,
                title: '核心结论',
                conclusion: '结论由课程材料支持。',
                body: '课程材料保留了页码和原文位置。',
                evidenceCardIds: [EVIDENCE_ID],
                citations: [
                  {
                    evidenceCardId: EVIDENCE_ID,
                    label: '[1]',
                  },
                ],
                visualNote: '使用证据卡片呈现来源。',
                speakerNotes: '先说明结论，再展示来源。',
                estimatedSeconds: 60,
                locked: false,
                rubricCriterionIds: [],
                claims: [
                  {
                    id: 'claim-1',
                    text: '结论由课程材料支持。',
                    evidenceCardIds: [EVIDENCE_ID],
                    numericFacts: [],
                  },
                ],
              },
            },
          ],
        },
        blobId: null,
        contentSha256: null,
        staleBecause: [],
        errorCode: null,
      },
    ],
    verificationResults: [
      {
        id: VERIFICATION_ID,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        projectId: PROJECT_ID,
        artifactId: ARTIFACT_ID,
        artifactVersion: 1,
        status: 'passed',
        checkedAt: CREATED_AT,
        checks: [],
        summary: {
          passed: 0,
          warnings: 0,
          failed: 0,
          notRun: 0,
        },
      },
    ],
    ...overrides,
  });
}

describe('WB-01 student workbench entry', () => {
  it('routes the product root to the workbench and explicit account paths to identity', () => {
    expect(studentSurfaceForPath('/')).toBe('workbench');
    expect(studentSurfaceForPath('/projects/new')).toBe('workbench');
    expect(studentSurfaceForPath('/account')).toBe('identity');
    expect(studentSurfaceForPath('/account/security')).toBe('identity');
    expect(studentSurfaceForPath('/auth')).toBe('identity');
    expect(studentSurfaceForPath('/auth/recovery')).toBe('identity');
    expect(studentSurfaceForPath('/accounting')).toBe('workbench');
    expect(studentSurfaceForPath('/author')).toBe('workbench');
  });

  it('renders the six-stage core workflow in product order', () => {
    const html = renderToStaticMarkup(
      <WorkbenchShell onLogin={vi.fn()} onRegister={vi.fn()} />,
    );
    const labels = [
      '定义任务',
      '材料解析',
      '选择证据',
      '组织结构',
      '编辑核验',
      '正式导出',
    ];

    expect(html).toContain('做成');
    expect(html).toContain('任务工作台');
    expect(html).toContain('aria-label="任务工作流"');
    for (const label of labels) {
      expect(html).toContain(label);
    }
    for (let index = 1; index < labels.length; index += 1) {
      expect(html.indexOf(labels[index - 1] ?? '')).toBeLessThan(
        html.indexOf(labels[index] ?? ''),
      );
    }
    expect(html).toContain('aria-current="step"');
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(6);
    expect(html).toContain('需先完成任务定义与材料处理');
    expect(html).not.toContain('导出成功');
  });

  it('keeps the recent project open by default and exposes projects only on demand', () => {
    const current = projectWithDraft();
    const service = outlineService(current);
    const workbench = renderToStaticMarkup(
      <WorkbenchShell
        initialProject={current}
        onLogin={vi.fn()}
        onRegister={vi.fn()}
        service={service}
      />,
    );
    const manager = renderToStaticMarkup(
      <WorkbenchShell
        initialProject={current}
        initialView="projects"
        onLogin={vi.fn()}
        onRegister={vi.fn()}
        service={service}
      />,
    );

    expect(workbench).toContain('>项目<');
    expect(workbench).toContain('编辑核验');
    expect(workbench).not.toContain('id="project-manager-title"');
    expect(manager).toContain('id="project-manager-title"');
    expect(manager).toContain(current.title);
  });

  it('opens the course center on demand without replacing the current project', () => {
    const current = projectWithDraft();
    const service = outlineService(current);
    const workbench = renderToStaticMarkup(
      <WorkbenchShell
        courseCenter={{
          enrollmentId: 'course-enrollment-01',
          learnerId: 'learner-01',
          store: new MemoryCourseStore(),
        }}
        initialProject={current}
        onLogin={vi.fn()}
        onRegister={vi.fn()}
        service={service}
      />,
    );
    const courses = renderToStaticMarkup(
      <WorkbenchShell
        courseCenter={{
          enrollmentId: 'course-enrollment-01',
          learnerId: 'learner-01',
          store: new MemoryCourseStore(),
        }}
        initialProject={current}
        initialView="courses"
        onLogin={vi.fn()}
        onRegister={vi.fn()}
        service={service}
      />,
    );

    expect(workbench).toContain('>课程</button>');
    expect(workbench).toContain('编辑核验');
    expect(workbench).not.toContain('正在读取课程记录');
    expect(courses).toContain('正在读取课程记录');
    expect(courses).toContain('7 天');
    expect(courses).not.toContain('无需登录');
    expect(courses).not.toContain('零成本');
  });

  it('restores the furthest editable stage from persisted materials, evidence, outline and draft', () => {
    expect(projectStageFor(outlineProject())).toBe(2);
    expect(
      projectStageFor(
        outlineProject({
          evidenceCards: [],
          sourceFiles: [
            {
              id: FILE_ID,
              version: 1,
              createdAt: CREATED_AT,
              updatedAt: CREATED_AT,
              projectId: PROJECT_ID,
              fileName: 'course.pdf',
              mediaType: 'application/pdf',
              extension: 'pdf',
              sizeBytes: 5,
              contentSha256: 'a'.repeat(64),
              blobId: `source-file:${FILE_ID}`,
              sourceVersion: 1,
              status: 'ready',
              parseProgress: 100,
              pageCount: 1,
              error: null,
              replacedByFileId: null,
            },
          ],
        }),
      ),
    ).toBe(1);
    expect(projectStageFor(projectWithDraft())).toBe(4);
  });

  it('renders a complete editable task definition and a real material file input', () => {
    const html = renderToStaticMarkup(
      <WorkbenchShell onLogin={vi.fn()} onRegister={vi.fn()} />,
    );

    for (const field of [
      '任务名称',
      '听众',
      '截止时间',
      '页面或字数',
      '演讲时长',
      '输出格式',
      '评分标准',
      '语气',
      '必须包含',
      '禁止包含',
    ]) {
      expect(html).toContain(field);
    }
    expect(html).toContain('type="file"');
    expect(html).toContain('multiple=""');
    expect(html).toContain('accept=".pdf,.docx,.pptx,.txt,.md,image/*"');
    expect(html).toContain('尚未添加材料');
    expect(html).toContain('待解析');
    expect(html).toContain('还缺少必填信息');
    expect(html).toContain(
      '请补充：任务名称、听众、截止时间、页面或字数、输出格式、评分标准、任务材料。',
    );
  });

  it('renders SourceManager for a persisted material-stage project instead of the legacy long lists', () => {
    const current = outlineProject({
      evidenceCards: [],
      sourceFiles: [
        {
          id: FILE_ID,
          version: 1,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          projectId: PROJECT_ID,
          fileName: '课程报告.pdf',
          mediaType: 'application/pdf',
          extension: 'pdf',
          sizeBytes: 2_048,
          contentSha256: 'a'.repeat(64),
          blobId: `source-file:${FILE_ID}`,
          sourceVersion: 1,
          status: 'ready',
          parseProgress: 100,
          pageCount: 1,
          error: null,
          replacedByFileId: null,
        },
      ],
      sourceChunks: [
        {
          id: CHUNK_ID,
          version: 1,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          projectId: PROJECT_ID,
          sourceFileId: FILE_ID,
          sourceFileVersion: 1,
          ordinal: 0,
          pageNumber: 1,
          pageLabel: '第 1 页',
          characterStart: 0,
          characterEnd: 5,
          text: '真实证据',
          contentSha256: 'b'.repeat(64),
        },
      ],
    });
    const html = renderToStaticMarkup(
      <WorkbenchShell
        initialProject={current}
        onLogin={vi.fn()}
        onRegister={vi.fn()}
        service={outlineService(current)}
      />,
    );

    expect(html).toContain('材料管理');
    expect(html).toContain('课程报告.pdf');
    expect(html).toContain('拖拽材料到这里');
    expect(html).toContain('查看片段');
    expect(html).not.toContain('class="source-chunk-list"');
    expect(html).not.toContain('class="material-list"');
  });

  it('maps SourceManager callbacks to real material service methods and stores returned projects', async () => {
    const current = outlineProject();
    const next = outlineProject({ version: 2 });
    const readySource = {
      id: FILE_ID,
      version: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      projectId: PROJECT_ID,
      fileName: '课程报告.pdf',
      mediaType: 'application/pdf',
      extension: 'pdf',
      sizeBytes: 4,
      contentSha256: 'a'.repeat(64),
      blobId: `source-file:${FILE_ID}`,
      sourceVersion: 1,
      status: 'ready' as const,
      parseProgress: 100,
      pageCount: 1,
      error: null,
      replacedByFileId: null,
    };
    const ingestion = {
      status: 'ready' as const,
      project: next,
      sourceFile: readySource,
      chunks: [],
    };
    const service = {
      ...outlineService(next),
      ingestSourceFile: vi.fn().mockResolvedValue(ingestion),
      retrySourceFile: vi.fn().mockResolvedValue(ingestion),
      replaceSourceFile: vi.fn().mockResolvedValue(ingestion),
      deleteSourceFile: vi.fn().mockResolvedValue(next),
    };
    const onProjectChange = vi.fn();
    const sourceCallbacks = createSourceManagerCallbacks(
      service,
      current,
      onProjectChange,
    );
    const first = new File(['pdf'], 'first.pdf', {
      type: 'application/pdf',
    });
    const second = new File(['text'], 'second.txt', {
      type: 'text/plain',
    });
    const replacement = new File(['new'], 'replacement.pdf', {
      type: 'application/pdf',
    });

    await sourceCallbacks.onAppendFiles({
      projectId: PROJECT_ID,
      files: [first, second],
    });
    await sourceCallbacks.onRetrySource({
      projectId: PROJECT_ID,
      sourceFileId: FILE_ID,
    });
    await sourceCallbacks.onReplaceSource({
      projectId: PROJECT_ID,
      sourceFileId: FILE_ID,
      file: replacement,
    });
    await sourceCallbacks.onDeleteSource({
      projectId: PROJECT_ID,
      sourceFileId: FILE_ID,
    });

    expect(service.ingestSourceFile).toHaveBeenNthCalledWith(
      1,
      PROJECT_ID,
      first,
    );
    expect(service.ingestSourceFile).toHaveBeenNthCalledWith(
      2,
      PROJECT_ID,
      second,
    );
    expect(service.retrySourceFile).toHaveBeenCalledWith(
      PROJECT_ID,
      FILE_ID,
    );
    expect(service.replaceSourceFile).toHaveBeenCalledWith(
      PROJECT_ID,
      FILE_ID,
      replacement,
    );
    expect(service.deleteSourceFile).toHaveBeenCalledWith(
      PROJECT_ID,
      FILE_ID,
    );
    expect(onProjectChange).toHaveBeenCalledTimes(5);
    for (const [savedProject] of onProjectChange.mock.calls) {
      expect(savedProject).toBe(next);
    }
  });

  it('keeps authentication out of the default DOM and exposes only standard header actions', () => {
    const html = renderToStaticMarkup(
      <WorkbenchShell onLogin={vi.fn()} onRegister={vi.fn()} />,
    );

    expect(html).toContain('>登录</button>');
    expect(html).toContain('>注册</button>');
    expect(html).not.toContain('邮箱或用户名');
    expect(html).not.toContain('设置密码');
    expect(html).not.toContain('使用 Passkey');
  });

  it('adds a non-blocking model connection entry before the existing account actions', () => {
    const credentials = createBYOKCredentialStore({
      sessionStorage: null,
      localStorage: null,
    });
    const html = renderToStaticMarkup(
      <WorkbenchShell
        aiSettings={{
          providerId: 'personal-openai-compatible',
          displayName: '我的模型',
          credentials,
          onSaveConfig: vi.fn(),
          onDeleteConfig: vi.fn(),
          onTestConnection: vi.fn(),
        }}
        onLogin={vi.fn()}
        onRegister={vi.fn()}
      />,
    );

    expect(html).toContain('>连接模型</button>');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('任务工作台');
    expect(html).not.toContain('连接你自己的模型');
    expect(html.indexOf('>连接模型</button>')).toBeLessThan(
      html.indexOf('>登录</button>'),
    );
    expect(html.indexOf('>登录</button>')).toBeLessThan(
      html.indexOf('>注册</button>'),
    );
  });

  it('closes model settings back to the exact workbench stage', () => {
    const stageView: WorkbenchViewState = {
      activeStage: 4,
      aiSettingsOpen: false,
    };

    const settingsView = workbenchViewReducer(stageView, {
      type: 'open-ai-settings',
    });
    expect(settingsView).toEqual({
      activeStage: 4,
      aiSettingsOpen: true,
    });
    expect(
      workbenchViewReducer(settingsView, {
        type: 'close-ai-settings',
      }),
    ).toEqual(stageView);
    expect(
      workbenchViewReducer(settingsView, {
        type: 'set-stage',
        stage: 2,
      }),
    ).toEqual({
      activeStage: 2,
      aiSettingsOpen: true,
    });
  });

  it('opens save only when the deliverable and at least one traceable source are ready', () => {
    const completeDraft: WorkbenchDraft = {
      taskName: '人工智能课程期末汇报',
      audience: '课程老师与同学',
      deadline: '2026-08-15T17:30',
      scope: '3 页',
      durationMinutes: '6',
      outputFormat: 'presentation',
      tone: 'academic',
      rubric: '论证与证据 100%',
      requiredContent: '核心结论',
      forbiddenContent: '无来源数字',
    };

    expect(missingTaskFields(completeDraft, 1)).toEqual([]);
    expect(
      missingTaskFields(
        { ...completeDraft, scope: '', rubric: '   ' },
        0,
      ),
    ).toEqual(['页面或字数', '评分标准', '任务材料']);
  });

  it('opens stage four only for user-confirmed verified evidence', () => {
    const verified = outlineProject();
    const pending = outlineProject({
      evidenceCards: verified.evidenceCards.map((evidence) => ({
        ...evidence,
        status: 'selected',
        confirmationStatus: 'pending',
        userConfirmedAt: null,
      })),
    });
    const missingConfirmation = outlineProject({
      evidenceCards: verified.evidenceCards.map((evidence) => ({
        ...evidence,
        userConfirmedAt: null,
      })),
    });

    expect(hasConfirmedVerifiedEvidence(null)).toBe(false);
    expect(
      hasConfirmedVerifiedEvidence(
        outlineProject({ evidenceCards: [] }),
      ),
    ).toBe(false);
    expect(hasConfirmedVerifiedEvidence(pending)).toBe(false);
    expect(hasConfirmedVerifiedEvidence(missingConfirmation)).toBe(
      false,
    );
    expect(hasConfirmedVerifiedEvidence(verified)).toBe(true);
  });

  it('maps every outline callback to the real service and stores each returned project', async () => {
    const current = outlineProject();
    const next = outlineProject({ version: 2 });
    const service = outlineService(next);
    const onProjectChange = vi.fn();
    const callbacks = createOutlineStageCallbacks(
      service,
      current,
      onProjectChange,
    );

    await callbacks.onCreateOutline({ title: '论证结构' });
    await callbacks.onAddNode({
      outlineId: OUTLINE_ID,
      title: '核心结论',
      conclusion: '真实证据支持核心结论。',
      evidenceCardIds: [EVIDENCE_ID],
      coveredRequirements: [],
      rubricCriterionIds: [],
    });
    await callbacks.onUpdateNode({
      outlineId: OUTLINE_ID,
      nodeId: NODE_ID,
      patch: { conclusion: '更新后的真实结论。' },
    });
    await callbacks.onDeleteNode({
      outlineId: OUTLINE_ID,
      nodeId: NODE_ID,
    });
    await callbacks.onReorderNode({
      outlineId: OUTLINE_ID,
      nodeId: NODE_ID,
      targetPosition: 0,
    });
    await callbacks.onSelectOutline({ outlineId: OUTLINE_ID });
    await callbacks.onLockOutline({ outlineId: OUTLINE_ID });

    expect(service.createOutline).toHaveBeenCalledWith(PROJECT_ID, {
      title: '论证结构',
      nodes: [],
    });
    expect(service.addOutlineNode).toHaveBeenCalledWith(
      PROJECT_ID,
      OUTLINE_ID,
      {
        title: '核心结论',
        conclusion: '真实证据支持核心结论。',
        evidenceCardIds: [EVIDENCE_ID],
        coveredRequirements: [],
        rubricCriterionIds: [],
      },
    );
    expect(service.updateOutlineNode).toHaveBeenCalledWith(
      PROJECT_ID,
      OUTLINE_ID,
      NODE_ID,
      { conclusion: '更新后的真实结论。' },
    );
    expect(service.deleteOutlineNode).toHaveBeenCalledWith(
      PROJECT_ID,
      OUTLINE_ID,
      NODE_ID,
    );
    expect(service.reorderOutlineNode).toHaveBeenCalledWith(
      PROJECT_ID,
      OUTLINE_ID,
      NODE_ID,
      0,
    );
    expect(service.selectOutline).toHaveBeenCalledWith(
      PROJECT_ID,
      OUTLINE_ID,
    );
    expect(service.lockOutline).toHaveBeenCalledWith(
      PROJECT_ID,
      OUTLINE_ID,
    );
    expect(onProjectChange).toHaveBeenCalledTimes(7);
    for (const [savedProject] of onProjectChange.mock.calls) {
      expect(savedProject).toBe(next);
    }
  });

  it('opens draft and export only from persisted outline, page and verification state', () => {
    const current = projectWithDraft();
    const draft = findDraftArtifact(current);

    expect(draft).not.toBeNull();
    expect(draft?.artifact.id).toBe(ARTIFACT_ID);
    expect(draft?.pages).toEqual([
      expect.objectContaining({
        outlineNodeId: NODE_ID,
        page: expect.objectContaining({ id: PAGE_ID }),
      }),
    ]);
    expect(workbenchStageAvailable(4, current)).toBe(true);
    expect(workbenchStageAvailable(5, current)).toBe(true);
    expect(
      workbenchStageAvailable(5, {
        ...current,
        verificationResults: [],
      }),
    ).toBe(false);
    expect(findDraftArtifact(null)).toBeNull();
  });

  it('persists draft callbacks and refreshes deterministic verification after a page write', async () => {
    const current = projectWithDraft();
    const next = projectWithDraft({ version: 2 });
    const service = outlineService(next);
    const onProjectChange = vi.fn();
    const draft = findDraftArtifact(current);
    if (draft === null) {
      throw new Error('expected draft artifact');
    }
    const callbacks = createDraftStageCallbacks(
      service,
      current,
      draft,
      onProjectChange,
    );

    await callbacks.onUpdatePage({
      outlineId: OUTLINE_ID,
      pageId: PAGE_ID,
      patch: { body: '更新后的正文。' },
    });

    expect(service.updateDraftPage).toHaveBeenCalledWith(
      PROJECT_ID,
      ARTIFACT_ID,
      PAGE_ID,
      { body: '更新后的正文。' },
    );
    expect(service.verifyDraftArtifact).toHaveBeenCalledWith(
      PROJECT_ID,
      ARTIFACT_ID,
    );
    expect(onProjectChange).toHaveBeenCalledWith(next);
  });

  it('preserves a real lock rejection for the outline stage alert', async () => {
    const current = outlineProject();
    const service = outlineService(current);
    const lockError = new Error('仍有必须包含项未覆盖');
    service.lockOutline = vi.fn().mockRejectedValue(lockError);
    const callbacks = createOutlineStageCallbacks(
      service,
      current,
      vi.fn(),
    );

    await expect(
      executeOutlineStageAction(callbacks.onLockOutline, {
        outlineId: OUTLINE_ID,
      }),
    ).resolves.toEqual({
      status: 'error',
      actionKey: null,
      message: '仍有必须包含项未覆盖',
    });
  });
});

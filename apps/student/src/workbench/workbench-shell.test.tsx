import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { executeOutlineStageAction } from './outline-stage.js';
import type { Project } from './project-model.js';
import {
  WorkbenchShell,
  createOutlineStageCallbacks,
  hasConfirmedVerifiedEvidence,
  missingTaskFields,
  studentSurfaceForPath,
  type WorkbenchDraft,
} from './workbench-shell.js';
import type { WorkbenchService } from './workbench-service.js';

const PROJECT_ID = '01900000-0000-7000-8000-000000000601';
const TASK_ID = '01900000-0000-7000-8000-000000000602';
const FILE_ID = '01900000-0000-7000-8000-000000000603';
const CHUNK_ID = '01900000-0000-7000-8000-000000000604';
const EVIDENCE_ID = '01900000-0000-7000-8000-000000000605';
const OUTLINE_ID = '01900000-0000-7000-8000-000000000606';
const NODE_ID = '01900000-0000-7000-8000-000000000607';
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

function outlineService(next: Project): WorkbenchService {
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
    ingestSourceFile: vi.fn(),
  };
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

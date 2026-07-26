import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  EvidenceCard,
  Outline,
  Project,
} from './project-model.js';
import {
  OutlineStage,
  executeOutlineStageAction,
  outlineStageActionReducer,
  selectAndLockOutline,
  summarizeOutline,
  type OutlineStageCallbacks,
} from './outline-stage.js';

const PROJECT_ID = '01900000-0000-7000-8000-000000000501';
const TASK_ID = '01900000-0000-7000-8000-000000000502';
const RUBRIC_ID = '01900000-0000-7000-8000-000000000503';
const FILE_ID = '01900000-0000-7000-8000-000000000504';
const CHUNK_A_ID = '01900000-0000-7000-8000-000000000505';
const CHUNK_B_ID = '01900000-0000-7000-8000-000000000506';
const EVIDENCE_A_ID = '01900000-0000-7000-8000-000000000507';
const EVIDENCE_B_ID = '01900000-0000-7000-8000-000000000508';
const OUTLINE_A_ID = '01900000-0000-7000-8000-000000000509';
const OUTLINE_B_ID = '01900000-0000-7000-8000-000000000510';
const NODE_A_ID = '01900000-0000-7000-8000-000000000511';
const NODE_B_ID = '01900000-0000-7000-8000-000000000512';
const NODE_C_ID = '01900000-0000-7000-8000-000000000513';
const CREATED_AT = '2026-07-27T03:00:00.000Z';

function evidenceCards(): EvidenceCard[] {
  return [
    {
      id: EVIDENCE_A_ID,
      version: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      projectId: PROJECT_ID,
      sourceFileId: FILE_ID,
      sourceChunkId: CHUNK_A_ID,
      sourceFileVersion: 1,
      pageNumber: 1,
      characterStart: 0,
      characterEnd: 10,
      quote: '参与度提升了 18%',
      kind: 'statistic',
      note: '支持核心结论',
      citation: '课程报告，第 1 页',
      status: 'verified',
      stance: 'support',
      confirmationStatus: 'confirmed',
      userConfirmedAt: CREATED_AT,
    },
    {
      id: EVIDENCE_B_ID,
      version: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      projectId: PROJECT_ID,
      sourceFileId: FILE_ID,
      sourceChunkId: CHUNK_B_ID,
      sourceFileVersion: 1,
      pageNumber: 2,
      characterStart: 20,
      characterEnd: 32,
      quote: '样本规模有限，结论需谨慎',
      kind: 'fact',
      note: '限制因果解释',
      citation: '课程报告，第 2 页',
      status: 'verified',
      stance: 'oppose',
      confirmationStatus: 'confirmed',
      userConfirmedAt: CREATED_AT,
    },
  ];
}

function outlines(): Outline[] {
  return [
    {
      id: OUTLINE_A_ID,
      version: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      projectId: PROJECT_ID,
      title: '论证优先',
      status: 'selected',
      lockedAt: null,
      nodes: [
        {
          id: NODE_A_ID,
          version: 1,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          position: 0,
          title: '参与度为何重要',
          conclusion: '参与度提升能够改善课程任务完成质量。',
          evidenceCardIds: [EVIDENCE_A_ID],
          coveredRequirements: ['核心结论'],
          rubricCriterionIds: [RUBRIC_ID],
          locked: false,
        },
        {
          id: NODE_B_ID,
          version: 1,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          position: 1,
          title: '结论边界',
          conclusion: '样本限制意味着不能夸大因果关系。',
          evidenceCardIds: [EVIDENCE_B_ID],
          coveredRequirements: ['来源索引'],
          rubricCriterionIds: [],
          locked: false,
        },
      ],
    },
    {
      id: OUTLINE_B_ID,
      version: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      projectId: PROJECT_ID,
      title: '叙事优先',
      status: 'draft',
      lockedAt: null,
      nodes: [
        {
          id: NODE_C_ID,
          version: 1,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          position: 0,
          title: '从学生体验开始',
          conclusion: '先呈现学生参与课程的真实变化。',
          evidenceCardIds: [EVIDENCE_A_ID],
          coveredRequirements: ['核心结论'],
          rubricCriterionIds: [RUBRIC_ID],
          locked: false,
        },
      ],
    },
  ];
}

function project(
  overrides: Partial<Project> = {},
): Project {
  const currentOutlines = outlines();
  return {
    schemaVersion: 1,
    id: PROJECT_ID,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    title: '课程结构项目',
    status: 'active',
    taskDefinition: {
      id: TASK_ID,
      version: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      taskName: '三页课程汇报',
      audience: '课程教师与同学',
      dueAt: '2026-08-15T09:00:00.000Z',
      lengthTarget: { unit: 'pages', value: 3 },
      presentationDurationMinutes: 6,
      outputFormats: ['pptx'],
      rubric: [
        {
          id: RUBRIC_ID,
          version: 1,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          title: '论证与证据',
          description: '每个结论都有来源',
          weightPercent: 100,
        },
      ],
      tone: '清晰克制',
      mustInclude: ['核心结论', '来源索引'],
      mustAvoid: ['无来源数字'],
    },
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
        sizeBytes: 2048,
        contentSha256: 'a'.repeat(64),
        blobId: 'blob:course-report',
        sourceVersion: 1,
        status: 'ready',
        parseProgress: 100,
        pageCount: 2,
        error: null,
        replacedByFileId: null,
      },
    ],
    sourceChunks: [],
    evidenceCards: evidenceCards(),
    outlines: currentOutlines,
    activeOutlineId: OUTLINE_A_ID,
    artifacts: [],
    verificationResults: [],
    ...overrides,
  };
}

function callbacks(): OutlineStageCallbacks {
  return {
    onCreateOutline: vi.fn().mockResolvedValue(undefined),
    onAddNode: vi.fn().mockResolvedValue(undefined),
    onUpdateNode: vi.fn().mockResolvedValue(undefined),
    onDeleteNode: vi.fn().mockResolvedValue(undefined),
    onReorderNode: vi.fn().mockResolvedValue(undefined),
    onLockOutline: vi.fn().mockResolvedValue(undefined),
    onSelectOutline: vi.fn().mockResolvedValue(undefined),
  };
}

describe('outline stage', () => {
  it('renders multiple real plans with comparable node, evidence and coverage counts', () => {
    const currentProject = project();
    const html = renderToStaticMarkup(
      <OutlineStage
        {...callbacks()}
        outlines={currentProject.outlines}
        project={currentProject}
      />,
    );

    expect(html).toContain('方案比较');
    expect(html).toContain('论证优先');
    expect(html).toContain('叙事优先');
    expect(html).toContain('2 个节点');
    expect(html).toContain('2 条证据');
    expect(html).toContain('交付要求 2/2');
    expect(html).toContain('评分标准 1/1');
    expect(html).toContain('查看并编辑');
    expect(html).toContain('新建结构方案');
  });

  it('renders authored conclusions, real evidence choices and requirement/rubric coverage controls', () => {
    const currentProject = project();
    const html = renderToStaticMarkup(
      <OutlineStage
        {...callbacks()}
        outlines={currentProject.outlines}
        project={currentProject}
      />,
    );

    expect(html).toContain('参与度为何重要');
    expect(html).toContain('参与度提升能够改善课程任务完成质量。');
    expect(html).toContain('参与度提升了 18%');
    expect(html).toContain('课程报告.pdf · 第 1 页');
    expect(html).toContain('核心结论');
    expect(html).toContain('来源索引');
    expect(html).toContain('论证与证据');
    expect(html).toContain('上移');
    expect(html).toContain('下移');
    expect(html).toContain('复制');
    expect(html).toContain('删除');
    expect(html).toContain('锁定节点');
    expect(html).toContain('保存节点');
    expect(html).toContain('添加节点');
  });

  it('disables all rewriting controls for a locked active outline', () => {
    const lockedOutlines = outlines();
    lockedOutlines[0] = {
      ...lockedOutlines[0]!,
      status: 'locked',
      lockedAt: CREATED_AT,
      nodes: lockedOutlines[0]!.nodes.map((node) => ({
        ...node,
        locked: true,
      })),
    };
    const currentProject = project({
      outlines: lockedOutlines,
    });
    const html = renderToStaticMarkup(
      <OutlineStage
        {...callbacks()}
        outlines={lockedOutlines}
        project={currentProject}
      />,
    );

    expect(html).toContain('结构已锁定');
    expect(html).toContain('锁定后不可改写');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('>锁定当前方案</button>');
  });

  it('shows truthful empty states when no outline or evidence exists', () => {
    const currentProject = project({
      evidenceCards: [],
      outlines: [],
      activeOutlineId: null,
    });
    const html = renderToStaticMarkup(
      <OutlineStage
        {...callbacks()}
        outlines={[]}
        project={currentProject}
      />,
    );

    expect(html).toContain('尚未创建结构方案');
    expect(html).toContain('项目尚无证据');
    expect(html).not.toContain('示例');
    expect(html).not.toContain('AI 生成');
    expect(html).not.toContain('自动生成');
  });

  it('summarizes unique evidence and complete coverage without inflating repeated references', () => {
    const currentProject = project();
    const repeated = {
      ...currentProject.outlines[0]!,
      nodes: currentProject.outlines[0]!.nodes.map((node) => ({
        ...node,
        evidenceCardIds: [EVIDENCE_A_ID],
      })),
    };

    expect(summarizeOutline(repeated, currentProject)).toEqual({
      nodeCount: 2,
      evidenceCount: 1,
      requirementCovered: 2,
      requirementTotal: 2,
      rubricCovered: 1,
      rubricTotal: 1,
    });
  });

  it('selects a complete draft before locking and locks an already-selected outline directly', async () => {
    const onSelectOutline = vi.fn().mockResolvedValue(undefined);
    const onLockOutline = vi.fn().mockResolvedValue(undefined);
    const draft = {
      ...project().outlines[0]!,
      status: 'draft' as const,
      lockedAt: null,
    };

    await selectAndLockOutline(draft, {
      onSelectOutline,
      onLockOutline,
    });
    expect(onSelectOutline).toHaveBeenCalledWith({
      outlineId: draft.id,
    });
    expect(onLockOutline).toHaveBeenCalledWith({
      outlineId: draft.id,
    });
    expect(onSelectOutline.mock.invocationCallOrder[0]).toBeLessThan(
      onLockOutline.mock.invocationCallOrder[0]!,
    );

    onSelectOutline.mockClear();
    onLockOutline.mockClear();
    await selectAndLockOutline(
      { ...draft, status: 'selected' },
      { onSelectOutline, onLockOutline },
    );
    expect(onSelectOutline).not.toHaveBeenCalled();
    expect(onLockOutline).toHaveBeenCalledTimes(1);
  });

  it('models real pending/error states and forwards exact operation payloads', async () => {
    const input = {
      outlineId: OUTLINE_A_ID,
      nodeId: NODE_A_ID,
      targetPosition: 1,
    };
    const reorder = vi.fn().mockResolvedValue(undefined);

    expect(
      outlineStageActionReducer(
        { status: 'idle', actionKey: null, message: null },
        { type: 'start', actionKey: 'reorder-node' },
      ),
    ).toEqual({
      status: 'saving',
      actionKey: 'reorder-node',
      message: null,
    });
    await expect(
      executeOutlineStageAction(reorder, input),
    ).resolves.toEqual({
      status: 'idle',
      actionKey: null,
      message: null,
    });
    expect(reorder).toHaveBeenCalledWith(input);

    const failed = vi
      .fn()
      .mockRejectedValue(new Error('结构写入失败'));
    await expect(
      executeOutlineStageAction(failed, input),
    ).resolves.toEqual({
      status: 'error',
      actionKey: null,
      message: '结构写入失败',
    });
  });
});

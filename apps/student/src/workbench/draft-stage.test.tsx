import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from './project-model.js';
import {
  createDraftPage,
  type DraftPage,
} from './draft-verification.js';
import {
  DraftStage,
  draftStageActionReducer,
  executeDraftStageAction,
  pageIdForArtifactPath,
  summarizeDraftVerification,
  type DraftStageCallbacks,
  type DraftStagePage,
} from './draft-stage.js';

const PROJECT_ID = '01900000-0000-7000-8000-000000000601';
const TASK_ID = '01900000-0000-7000-8000-000000000602';
const RUBRIC_ID = '01900000-0000-7000-8000-000000000603';
const FILE_ID = '01900000-0000-7000-8000-000000000604';
const CHUNK_A_ID = '01900000-0000-7000-8000-000000000605';
const CHUNK_B_ID = '01900000-0000-7000-8000-000000000606';
const EVIDENCE_A_ID = '01900000-0000-7000-8000-000000000607';
const EVIDENCE_B_ID = '01900000-0000-7000-8000-000000000608';
const OUTLINE_ID = '01900000-0000-7000-8000-000000000609';
const NODE_A_ID = '01900000-0000-7000-8000-000000000610';
const NODE_B_ID = '01900000-0000-7000-8000-000000000611';
const CREATED_AT = '2026-07-27T03:00:00.000Z';

function project(
  overrides: Partial<Project> = {},
): Project {
  return {
    schemaVersion: 1,
    id: PROJECT_ID,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    title: '课程初稿项目',
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
      presentationDurationMinutes: 2,
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
      mustAvoid: ['夸大因果'],
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
    evidenceCards: [
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
        note: '限制结论边界',
        citation: '课程报告，第 2 页',
        status: 'verified',
        stance: 'oppose',
        confirmationStatus: 'confirmed',
        userConfirmedAt: CREATED_AT,
      },
    ],
    outlines: [
      {
        id: OUTLINE_ID,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        projectId: PROJECT_ID,
        title: '论证优先',
        status: 'locked',
        lockedAt: CREATED_AT,
        nodes: [
          {
            id: NODE_A_ID,
            version: 1,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
            position: 0,
            title: '参与度为何重要',
            conclusion: '参与度影响任务完成质量。',
            evidenceCardIds: [EVIDENCE_A_ID],
            coveredRequirements: ['核心结论'],
            rubricCriterionIds: [RUBRIC_ID],
            locked: true,
          },
          {
            id: NODE_B_ID,
            version: 1,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
            position: 1,
            title: '结论边界',
            conclusion: '样本限制意味着需要谨慎解释。',
            evidenceCardIds: [EVIDENCE_B_ID],
            coveredRequirements: ['来源索引'],
            rubricCriterionIds: [],
            locked: true,
          },
        ],
      },
    ],
    activeOutlineId: OUTLINE_ID,
    artifacts: [],
    verificationResults: [],
    ...overrides,
  };
}

function page(
  id: string,
  overrides: Partial<DraftPage> = {},
): DraftPage {
  return createDraftPage({
    id,
    title: '核心结论',
    conclusion: '参与度提升与任务完成质量改善同时出现。',
    body: '核心结论：课程参与度提升了 18%，需要结合样本边界解释。',
    evidenceCardIds: [EVIDENCE_A_ID],
    citations: [
      {
        evidenceCardId: EVIDENCE_A_ID,
        label: '[课程报告，第 1 页]',
      },
    ],
    visualNote: '使用一张对比柱状图，标明样本范围。',
    speakerNotes: '先说明观察结果，再说明不能直接推断因果。',
    estimatedSeconds: 60,
    locked: false,
    rubricCriterionIds: [RUBRIC_ID],
    claims: [
      {
        id: `${id}-claim-1`,
        text: '课程参与度提升了 18%。',
        evidenceCardIds: [EVIDENCE_A_ID],
        numericFacts: [
          {
            metric: '参与度提升',
            value: 18,
            unit: '%',
          },
        ],
      },
    ],
    ...overrides,
  });
}

function pages(): DraftStagePage[] {
  return [
    {
      outlineNodeId: NODE_A_ID,
      page: page('page-1'),
    },
    {
      outlineNodeId: NODE_B_ID,
      page: page('page-2', {
        title: '来源索引',
        conclusion: '样本限制需要单独说明。',
        body: '来源索引列出课程报告第 2 页，并说明样本规模有限。',
        evidenceCardIds: [EVIDENCE_B_ID],
        citations: [
          {
            evidenceCardId: EVIDENCE_B_ID,
            label: '[课程报告，第 2 页]',
          },
        ],
        speakerNotes: '提醒听众区分相关与因果。',
        rubricCriterionIds: [],
        claims: [
          {
            id: 'page-2-claim-1',
            text: '样本规模限制了结论外推。',
            evidenceCardIds: [EVIDENCE_B_ID],
            numericFacts: [],
          },
        ],
      }),
    },
  ];
}

function callbacks(): DraftStageCallbacks {
  return {
    onInsertPage: vi.fn().mockResolvedValue(undefined),
    onUpdatePage: vi.fn().mockResolvedValue(undefined),
    onDeletePage: vi.fn().mockResolvedValue(undefined),
    onReorderPage: vi.fn().mockResolvedValue(undefined),
    onSetPageLocked: vi.fn().mockResolvedValue(undefined),
  };
}

describe('draft stage', () => {
  it('renders the selected outline and every real page editing field', () => {
    const html = renderToStaticMarkup(
      <DraftStage
        {...callbacks()}
        pages={pages()}
        project={project()}
      />,
    );

    expect(html).toContain('论证优先');
    expect(html).toContain('结构已锁定');
    expect(html).toContain('参与度为何重要');
    expect(html).toContain('页面标题');
    expect(html).toContain('正文 / 要点');
    expect(html).toContain('讲述备注');
    expect(html).toContain('视觉说明');
    expect(html).toContain('预计时长');
    expect(html).toContain('结构化主张');
    expect(html).toContain('数值事实');
    expect(html).toContain('论证与证据');
    expect(html).toContain('参与度提升了 18%');
    expect(html).toContain('插入页面');
    expect(html).toContain('保存页面');
    expect(html).toContain('删除页面');
    expect(html).toContain('上移');
    expect(html).toContain('下移');
    expect(html).toContain('锁定页面');
  });

  it('disables rewriting and movement for a locked page while preserving unlock control', () => {
    const lockedPages = pages();
    lockedPages[0] = {
      ...lockedPages[0]!,
      page: page('page-1', { locked: true }),
    };
    const html = renderToStaticMarkup(
      <DraftStage
        {...callbacks()}
        pages={lockedPages}
        project={project()}
      />,
    );

    expect(html).toContain('页面已锁定');
    expect(html).toContain('锁定后不可改写、删除或排序');
    expect(html).toContain('>解锁页面</button>');
    expect(html).toContain('disabled=""');
  });

  it('shows deterministic verification outcomes with exact location and fix guidance', () => {
    const html = renderToStaticMarkup(
      <DraftStage
        {...callbacks()}
        pages={pages()}
        project={project()}
      />,
    );

    expect(html).toContain('确定性核验');
    expect(html).toContain('篇幅目标');
    expect(html).toContain('稿件实际篇幅为 2 pages，目标为 3 pages');
    expect(html).toContain('taskDefinition.lengthTarget');
    expect(html).toContain('补充必要内容直至达到目标篇幅');
    expect(html).toContain('定位问题');
    expect(html).toContain('修复提示');
  });

  it('shows truthful empty states for missing structure and missing evidence', () => {
    const noOutline = project({
      outlines: [],
      activeOutlineId: null,
    });
    const noEvidence = project({
      evidenceCards: [],
    });
    const noOutlineHtml = renderToStaticMarkup(
      <DraftStage
        {...callbacks()}
        pages={[]}
        project={noOutline}
      />,
    );
    const noEvidenceHtml = renderToStaticMarkup(
      <DraftStage
        {...callbacks()}
        pages={[]}
        project={noEvidence}
      />,
    );

    expect(noOutlineHtml).toContain('尚未选择结构方案');
    expect(noEvidenceHtml).toContain('项目尚无证据');
    expect(noEvidenceHtml).not.toContain('示例');
    expect(noEvidenceHtml).not.toContain('自动生成');
  });

  it('summarizes verification outcomes and resolves page locations from artifact paths', () => {
    const checks = [
      {
        outcome: 'pass',
      },
      {
        outcome: 'warning',
      },
      {
        outcome: 'fail',
      },
      {
        outcome: 'not_run',
      },
      {
        outcome: 'fail',
      },
    ] as const;
    const currentPages = pages();

    expect(summarizeDraftVerification(checks)).toEqual({
      passed: 1,
      warnings: 1,
      failed: 2,
      notRun: 1,
    });
    expect(
      pageIdForArtifactPath(
        'draft.pages[1].claims[0].evidenceCardIds',
        currentPages,
      ),
    ).toBe('page-2');
    expect(
      pageIdForArtifactPath(
        'taskDefinition.lengthTarget',
        currentPages,
      ),
    ).toBeNull();
  });

  it('models real pending/error states and forwards exact write payloads', async () => {
    const input = {
      outlineId: OUTLINE_ID,
      pageId: 'page-1',
      targetIndex: 1,
    };
    const reorder = vi.fn().mockResolvedValue(undefined);

    expect(
      draftStageActionReducer(
        { status: 'idle', actionKey: null, message: null },
        { type: 'start', actionKey: 'reorder-page' },
      ),
    ).toEqual({
      status: 'saving',
      actionKey: 'reorder-page',
      message: null,
    });
    await expect(
      executeDraftStageAction(reorder, input),
    ).resolves.toEqual({
      status: 'idle',
      actionKey: null,
      message: null,
    });
    expect(reorder).toHaveBeenCalledWith(input);

    const failed = vi.fn().mockRejectedValue(new Error('初稿写入失败'));
    await expect(
      executeDraftStageAction(failed, input),
    ).resolves.toEqual({
      status: 'error',
      actionKey: null,
      message: '初稿写入失败',
    });
  });
});

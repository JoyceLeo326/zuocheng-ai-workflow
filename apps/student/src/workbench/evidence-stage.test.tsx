import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  EvidenceCard,
  Project,
  SourceChunk,
} from './project-model.js';
import {
  EvidenceStage,
  evidenceStageSaveReducer,
  filterEvidenceChunks,
  selectEvidenceQuote,
  submitEvidenceCreation,
  type EvidenceStageCreateInput,
} from './evidence-stage.js';

const PROJECT_ID = '01900000-0000-7000-8000-000000000401';
const TASK_ID = '01900000-0000-7000-8000-000000000402';
const FILE_A_ID = '01900000-0000-7000-8000-000000000403';
const FILE_B_ID = '01900000-0000-7000-8000-000000000404';
const CHUNK_A_ID = '01900000-0000-7000-8000-000000000405';
const CHUNK_B_ID = '01900000-0000-7000-8000-000000000406';
const CHUNK_C_ID = '01900000-0000-7000-8000-000000000407';
const EVIDENCE_ID = '01900000-0000-7000-8000-000000000408';
const CREATED_AT = '2026-07-27T03:00:00.000Z';

function sourceChunk(
  id: string,
  sourceFileId: string,
  pageNumber: number,
  characterStart: number,
  text: string,
): SourceChunk {
  return {
    id,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    projectId: PROJECT_ID,
    sourceFileId,
    sourceFileVersion: 1,
    ordinal: pageNumber - 1,
    pageNumber,
    pageLabel: String(pageNumber),
    characterStart,
    characterEnd: characterStart + text.length,
    text,
    contentSha256: 'a'.repeat(64),
  };
}

function project(): Project {
  return {
    schemaVersion: 1,
    id: PROJECT_ID,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    title: '课程证据汇报',
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
      rubric: [],
      tone: '清晰克制',
      mustInclude: ['核心结论'],
      mustAvoid: ['无来源数字'],
    },
    sourceFiles: [
      {
        id: FILE_A_ID,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        projectId: PROJECT_ID,
        fileName: '课程报告.pdf',
        mediaType: 'application/pdf',
        extension: 'pdf',
        sizeBytes: 2048,
        contentSha256: 'b'.repeat(64),
        blobId: 'blob:course-report',
        sourceVersion: 1,
        status: 'ready',
        parseProgress: 100,
        pageCount: 2,
        error: null,
        replacedByFileId: null,
      },
      {
        id: FILE_B_ID,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        projectId: PROJECT_ID,
        fileName: '访谈记录.pdf',
        mediaType: 'application/pdf',
        extension: 'pdf',
        sizeBytes: 1024,
        contentSha256: 'c'.repeat(64),
        blobId: 'blob:interview',
        sourceVersion: 1,
        status: 'ready',
        parseProgress: 100,
        pageCount: 1,
        error: null,
        replacedByFileId: null,
      },
    ],
    sourceChunks: [
      sourceChunk(
        CHUNK_A_ID,
        FILE_A_ID,
        1,
        0,
        '课程数据显示，参与度提升了 18%。',
      ),
      sourceChunk(
        CHUNK_B_ID,
        FILE_A_ID,
        2,
        40,
        '样本规模有限，结论仍需谨慎解释。',
      ),
      sourceChunk(
        CHUNK_C_ID,
        FILE_B_ID,
        1,
        0,
        '学生访谈提到分组反馈更及时。',
      ),
    ],
    evidenceCards: [],
    outlines: [],
    activeOutlineId: null,
    artifacts: [],
    verificationResults: [],
  };
}

function selectedEvidence(): EvidenceCard {
  return {
    id: EVIDENCE_ID,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    projectId: PROJECT_ID,
    sourceFileId: FILE_A_ID,
    sourceChunkId: CHUNK_A_ID,
    sourceFileVersion: 1,
    pageNumber: 1,
    characterStart: 7,
    characterEnd: 17,
    quote: '参与度提升了 18%',
    kind: 'statistic',
    note: '支持核心结论',
    citation: '课程报告，第 1 页',
    status: 'selected',
  };
}

describe('evidence selection stage', () => {
  it('renders only real project chunks with searchable page and source anchors', () => {
    const html = renderToStaticMarkup(
      <EvidenceStage
        evidenceCards={[selectedEvidence()]}
        onCreateEvidence={vi.fn()}
        project={project()}
      />,
    );

    expect(html).toContain('搜索原文');
    expect(html).toContain('按页筛选');
    expect(html).toContain('课程报告.pdf');
    expect(html).toContain('访谈记录.pdf');
    expect(html).toContain('第 2 页');
    expect(html).toContain('字符 40–56');
    expect(html).toContain('样本规模有限，结论仍需谨慎解释。');
    expect(html).toContain('选择整段');
    expect(html).toContain('使用所选片段');
    expect(html).toContain('证据类型');
    expect(html).toContain('支持');
    expect(html).toContain('反对');
    expect(html).toContain('中性');
    expect(html).toContain('我已核对原文与定位');
  });

  it('lists only supplied evidence cards and keeps every selected item traceable', () => {
    const html = renderToStaticMarkup(
      <EvidenceStage
        evidenceCards={[selectedEvidence()]}
        onCreateEvidence={vi.fn()}
        project={project()}
      />,
    );
    const emptyHtml = renderToStaticMarkup(
      <EvidenceStage
        evidenceCards={[]}
        onCreateEvidence={vi.fn()}
        project={project()}
      />,
    );

    expect(html).toContain('已选证据 1');
    expect(html).toContain('参与度提升了 18%');
    expect(html).toContain('课程报告.pdf · 第 1 页 · 字符 7–17');
    expect(html).toContain('支持核心结论');
    expect(emptyHtml).toContain('尚未选择证据');
    expect(emptyHtml).not.toContain('示例证据');
  });

  it('filters full text by query, file name and exact page without inventing results', () => {
    const currentProject = project();

    expect(
      filterEvidenceChunks(currentProject, '谨慎', 'all').map(
        ({ chunk }) => chunk.id,
      ),
    ).toEqual([CHUNK_B_ID]);
    expect(
      filterEvidenceChunks(currentProject, '访谈记录', 'all').map(
        ({ chunk }) => chunk.id,
      ),
    ).toEqual([CHUNK_C_ID]);
    expect(
      filterEvidenceChunks(currentProject, '', 2).map(
        ({ chunk }) => chunk.id,
      ),
    ).toEqual([CHUNK_B_ID]);
    expect(filterEvidenceChunks(currentProject, '不存在', 'all')).toEqual(
      [],
    );
  });

  it('renders a truthful empty result for active filters', () => {
    const html = renderToStaticMarkup(
      <EvidenceStage
        evidenceCards={[]}
        initialPageFilter={2}
        initialSearchQuery="访谈"
        onCreateEvidence={vi.fn()}
        project={project()}
      />,
    );

    expect(html).toContain('没有匹配的原文');
    expect(html).not.toContain('课程数据显示，参与度提升了 18%。');
    expect(html).not.toContain('学生访谈提到分组反馈更及时。');
  });

  it('creates whole-chunk and exact-substring selections from source text', () => {
    const chunk = project().sourceChunks[0]!;
    const whole = selectEvidenceQuote(chunk);
    const exactStart = chunk.text.indexOf('参与度');
    const exact = selectEvidenceQuote(
      chunk,
      exactStart,
      exactStart + '参与度提升了 18%'.length,
    );

    expect(whole).toEqual({
      sourceChunkId: CHUNK_A_ID,
      quote: chunk.text,
      characterStart: 0,
      characterEnd: chunk.text.length,
    });
    expect(exact).toEqual({
      sourceChunkId: CHUNK_A_ID,
      quote: '参与度提升了 18%',
      characterStart: 7,
      characterEnd: 17,
    });
    expect(() => selectEvidenceQuote(chunk, 3, 3)).toThrow(
      /精确片段/u,
    );
  });

  it('models real saving and error transitions and forwards the exact submission', async () => {
    const payload: EvidenceStageCreateInput = {
      sourceChunkId: CHUNK_A_ID,
      quote: '参与度提升了 18%',
      kind: 'statistic',
      stance: 'supports',
      note: '支持核心结论',
      citation: '课程报告，第 1 页',
      userConfirmed: true,
    };
    const create = vi.fn().mockResolvedValue(undefined);

    expect(
      evidenceStageSaveReducer(
        { status: 'idle', message: null },
        { type: 'start' },
      ),
    ).toEqual({ status: 'saving', message: null });
    await expect(submitEvidenceCreation(create, payload)).resolves.toEqual({
      status: 'idle',
      message: null,
    });
    expect(create).toHaveBeenCalledWith(payload);

    const failedCreate = vi
      .fn()
      .mockRejectedValue(new Error('项目写入失败'));
    await expect(
      submitEvidenceCreation(failedCreate, payload),
    ).resolves.toEqual({
      status: 'error',
      message: '项目写入失败',
    });
    expect(
      evidenceStageSaveReducer(
        { status: 'saving', message: null },
        { type: 'fail', message: '项目写入失败' },
      ),
    ).toEqual({
      status: 'error',
      message: '项目写入失败',
    });
  });
});

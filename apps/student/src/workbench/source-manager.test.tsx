import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  SourceChunk,
  SourceFile,
} from './project-model.js';
import {
  SourceDeleteConfirmation,
  SourceManager,
  executeSourceManagerAction,
  sourceChunksForFile,
  sourceManagerActionReducer,
  sourceStatusDetails,
  type SourceManagerCallbacks,
} from './source-manager.js';

const PROJECT_ID = 'project-source-manager';
const CREATED_AT = '2026-07-20T08:00:00.000Z';

function source(
  id: string,
  overrides: Partial<SourceFile> = {},
): SourceFile {
  return {
    id,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    projectId: PROJECT_ID,
    fileName: `${id}.pdf`,
    mediaType: 'application/pdf',
    extension: 'pdf',
    sizeBytes: 2_048,
    contentSha256: 'a'.repeat(64),
    blobId: `blob:${id}`,
    sourceVersion: 1,
    status: 'ready',
    parseProgress: 100,
    pageCount: 2,
    error: null,
    replacedByFileId: null,
    ...overrides,
  };
}

function chunk(
  id: string,
  sourceFileId: string,
  ordinal: number,
  overrides: Partial<SourceChunk> = {},
): SourceChunk {
  return {
    id,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    projectId: PROJECT_ID,
    sourceFileId,
    sourceFileVersion: 1,
    ordinal,
    pageNumber: ordinal + 1,
    pageLabel: `第 ${ordinal + 1} 页`,
    characterStart: ordinal * 30,
    characterEnd: ordinal * 30 + 20,
    text: `第 ${ordinal + 1} 个可核对的原文片段。`,
    contentSha256: `${ordinal + 1}`.repeat(64).slice(0, 64),
    ...overrides,
  };
}

const sources: readonly SourceFile[] = [
  source('ready-source', {
    fileName: '课程报告.pdf',
    pageCount: 2,
  }),
  source('parsing-source', {
    fileName: '访谈记录.docx',
    extension: 'docx',
    mediaType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    status: 'parsing',
    parseProgress: 46,
    pageCount: null,
  }),
  source('failed-source', {
    fileName: '损坏材料.pptx',
    extension: 'pptx',
    mediaType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    status: 'failed',
    parseProgress: 18,
    pageCount: null,
    error: {
      code: 'CORRUPT_ARCHIVE',
      message: '文件结构损坏，无法读取幻灯片。',
      retryable: true,
    },
  }),
];

const chunks: readonly SourceChunk[] = [
  chunk('chunk-2', 'ready-source', 1),
  chunk('chunk-other', 'parsing-source', 0),
  chunk('chunk-1', 'ready-source', 0),
  chunk('old-version', 'ready-source', 2, {
    sourceFileVersion: 0,
  }),
];

function callbacks(): SourceManagerCallbacks {
  return {
    onAppendFiles: vi.fn().mockResolvedValue(undefined),
    onRetrySource: vi.fn().mockResolvedValue(undefined),
    onReplaceSource: vi.fn().mockResolvedValue(undefined),
    onDeleteSource: vi.fn().mockResolvedValue(undefined),
  };
}

describe('source manager', () => {
  it('renders material state, page/chunk counts, failures and all real controls', () => {
    const html = renderToStaticMarkup(
      <SourceManager
        {...callbacks()}
        project={{ id: PROJECT_ID, title: '课程成果项目' }}
        sourceChunks={chunks}
        sourceFiles={sources}
      />,
    );

    expect(html).toContain('材料管理');
    expect(html).toContain('课程成果项目');
    expect(html).toContain('拖拽材料到这里');
    expect(html).toContain('选择材料文件');
    expect(html).toContain(
      'accept=".pdf,.docx,.pptx,.txt,.md,image/*"',
    );
    expect(html).toContain('课程报告.pdf');
    expect(html).toContain('2 页');
    expect(html).toContain('2 个片段');
    expect(html).toContain('访谈记录.docx');
    expect(html).toContain('解析中');
    expect(html).toContain('46%');
    expect(html).toContain('损坏材料.pptx');
    expect(html).toContain('文件结构损坏，无法读取幻灯片。');
    expect(html).toContain('重试');
    expect(html).toContain('替换');
    expect(html).toContain('删除');
    expect(html).toContain('查看片段');
    expect(html).toContain('role="progressbar"');
  });

  it('selects only current-version chunks and sorts them by ordinal', () => {
    expect(
      sourceChunksForFile(sources[0]!, chunks).map(
        (sourceChunk) => sourceChunk.id,
      ),
    ).toEqual(['chunk-1', 'chunk-2']);
    expect(
      sourceChunksForFile(sources[1]!, chunks).map(
        (sourceChunk) => sourceChunk.id,
      ),
    ).toEqual(['chunk-other']);
  });

  it('describes every parser status without inventing completion', () => {
    expect(sourceStatusDetails(sources[0]!)).toEqual({
      label: '解析完成',
      tone: 'ready',
      progress: 100,
    });
    expect(sourceStatusDetails(sources[1]!)).toEqual({
      label: '解析中',
      tone: 'working',
      progress: 46,
    });
    expect(sourceStatusDetails(sources[2]!)).toEqual({
      label: '解析失败',
      tone: 'failed',
      progress: 18,
    });
    expect(
      sourceStatusDetails(
        source('queued', {
          status: 'queued',
          parseProgress: 0,
        }),
      ),
    ).toEqual({
      label: '等待解析',
      tone: 'working',
      progress: 0,
    });
  });

  it('requires an explicit second confirmation before deletion', () => {
    const html = renderToStaticMarkup(
      <SourceDeleteConfirmation
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        pending={false}
        source={sources[0]!}
      />,
    );
    const pendingHtml = renderToStaticMarkup(
      <SourceDeleteConfirmation
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        pending
        source={sources[0]!}
      />,
    );

    expect(html).toContain('确认删除材料');
    expect(html).toContain('课程报告.pdf');
    expect(html).toContain('删除后将无法继续查看此材料的原文片段');
    expect(html).toContain('>确认删除</button>');
    expect(pendingHtml).toContain('>正在删除…</button>');
    expect(pendingHtml).toContain('disabled=""');
  });

  it('awaits exact callback payloads and returns real errors', async () => {
    const append = vi.fn().mockResolvedValue({ accepted: 2 });
    const files = [
      new File(['one'], 'one.pdf', {
        type: 'application/pdf',
      }),
      new File(['two'], 'two.md', {
        type: 'text/markdown',
      }),
    ];

    await expect(
      executeSourceManagerAction(append, {
        projectId: PROJECT_ID,
        files,
      }),
    ).resolves.toEqual({
      ok: true,
      result: { accepted: 2 },
      error: null,
    });
    expect(append).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      files,
    });

    const failed = vi
      .fn()
      .mockRejectedValue(new Error('替换材料写入失败'));
    await expect(
      executeSourceManagerAction(failed, {
        projectId: PROJECT_ID,
        sourceFileId: 'ready-source',
      }),
    ).resolves.toEqual({
      ok: false,
      result: null,
      error: '替换材料写入失败',
    });
  });

  it('models pending/error states and a truthful empty state', () => {
    const pending = sourceManagerActionReducer(
      { status: 'idle', actionKey: null, message: null },
      { type: 'start', actionKey: 'retry:failed-source' },
    );
    expect(pending).toEqual({
      status: 'pending',
      actionKey: 'retry:failed-source',
      message: null,
    });
    expect(
      sourceManagerActionReducer(pending, {
        type: 'failure',
        message: '重试失败',
      }),
    ).toEqual({
      status: 'error',
      actionKey: null,
      message: '重试失败',
    });

    const emptyHtml = renderToStaticMarkup(
      <SourceManager
        {...callbacks()}
        project={{ id: PROJECT_ID, title: '空项目' }}
        sourceChunks={[]}
        sourceFiles={[]}
      />,
    );
    expect(emptyHtml).toContain('尚未添加材料');
    expect(emptyHtml).not.toContain('0 成本');
    expect(emptyHtml).not.toContain('架构');
    expect(emptyHtml).not.toContain('登录');
  });
});

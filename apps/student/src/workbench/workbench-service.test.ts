import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MemoryProjectStore } from './project-store.js';
import {
  SourceParserPortError,
  type PdfParserPort,
} from './source-file.js';
import {
  WorkbenchServiceInputError,
  createWorkbenchService,
  type WorkbenchProjectFormInput,
} from './workbench-service.js';

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u;

function form(
  overrides: Partial<WorkbenchProjectFormInput> = {},
): WorkbenchProjectFormInput {
  return {
    projectTitle: '课程路演项目',
    taskName: '三页课程汇报',
    audience: '课程教师与同学',
    deadline: '2026-08-15T09:00:00.000Z',
    scope: '12 页',
    durationMinutes: '8',
    outputFormat: 'presentation',
    tone: 'academic',
    rubric: [
      {
        title: '论证',
        description: '结论必须由材料支持',
        weightPercent: '60',
      },
      {
        title: '表达',
        description: '结构清楚且适合讲述',
        weightPercent: '40',
      },
    ],
    requiredContent: '核心结论\n来源索引',
    forbiddenContent: '无来源数字\n夸大因果',
    ...overrides,
  };
}

function sequentialIds(): () => string {
  let sequence = 1;
  return () => {
    const suffix = String(sequence).padStart(12, '0');
    sequence += 1;
    return `01900000-0000-7000-8000-${suffix}`;
  };
}

function pdfFile(content = '%PDF-real-source'): File {
  return new File([content], 'course.pdf', {
    type: 'application/pdf',
  });
}

function docxFile(): File {
  const bytes = zipSync(
    {
      '[Content_Types].xml': strToU8(`<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`),
      'word/document.xml': strToU8(`<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>课程要求必须保留引用。</w:t></w:r></w:p>
    <w:p><w:r><w:t>结构需要覆盖评分标准。</w:t></w:r></w:p>
  </w:body>
</w:document>`),
    },
    { level: 6 },
  );
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  return new File([owned.buffer], 'requirements.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

describe('WorkbenchService first-stage orchestration', () => {
  it('creates and persists a strict versioned project from UI-ready task input', async () => {
    const store = new MemoryProjectStore();
    const service = createWorkbenchService({
      store,
      idFactory: sequentialIds(),
      now: () => new Date('2026-07-27T01:00:00.000Z'),
    });

    const created = await service.createProject(form());

    expect(created).toMatchObject({
      version: 1,
      title: '课程路演项目',
      status: 'active',
      taskDefinition: {
        taskName: '三页课程汇报',
        audience: '课程教师与同学',
        dueAt: '2026-08-15T09:00:00.000Z',
        lengthTarget: { unit: 'pages', value: 12 },
        presentationDurationMinutes: 8,
        outputFormats: ['pptx', 'pdf'],
        tone: 'academic',
        mustInclude: ['核心结论', '来源索引'],
        mustAvoid: ['无来源数字', '夸大因果'],
        rubric: [
          {
            title: '论证',
            description: '结论必须由材料支持',
            weightPercent: 60,
          },
          {
            title: '表达',
            description: '结构清楚且适合讲述',
            weightPercent: 40,
          },
        ],
      },
      sourceFiles: [],
      sourceChunks: [],
    });
    expect(created.id).toMatch(UUID_V7);
    expect(created.taskDefinition.id).toMatch(UUID_V7);
    expect(created.taskDefinition.rubric.map((item) => item.id)).toEqual([
      expect.stringMatching(UUID_V7),
      expect.stringMatching(UUID_V7),
    ]);
    await expect(store.getProject(created.id)).resolves.toEqual(created);
    await expect(service.listProjects()).resolves.toEqual([created]);
  });

  it('parses word targets and rejects ambiguous targets or rubric totals before persistence', async () => {
    const store = new MemoryProjectStore();
    const service = createWorkbenchService({
      store,
      idFactory: sequentialIds(),
      now: () => new Date('2026-07-27T01:00:00.000Z'),
    });

    const wordProject = await service.createProject(
      form({
        projectTitle: '文字报告',
        taskName: '课程论文',
        scope: '3000 words',
      }),
    );
    expect(wordProject.taskDefinition.lengthTarget).toEqual({
      unit: 'words',
      value: 3000,
    });

    await expect(
      service.createProject(form({ scope: '大约十二页' })),
    ).rejects.toMatchObject({
      name: 'WorkbenchServiceInputError',
      code: 'INVALID_LENGTH_TARGET',
    });
    await expect(
      service.createProject(
        form({
          rubric: [
            {
              title: '论证',
              description: '结论必须由材料支持',
              weightPercent: '80',
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(WorkbenchServiceInputError);
    await expect(store.listProjects()).resolves.toHaveLength(1);
  });

  it('validates, hashes, deduplicates and persists a PDF with real page ranges and hashes', async () => {
    const store = new MemoryProjectStore();
    let parserCalls = 0;
    const parser: PdfParserPort = {
      async parsePdf() {
        parserCalls += 1;
        return {
          pageCount: 2,
          pages: [
            { pageNumber: 1, text: 'Alpha' },
            { pageNumber: 2, text: '人工智能' },
          ],
        };
      },
    };
    const service = createWorkbenchService({
      store,
      pdfParser: parser,
      idFactory: sequentialIds(),
      now: () => new Date('2026-07-27T01:00:00.000Z'),
    });
    const initial = await service.createProject(
      form({
        rubric: [
          {
            title: '证据',
            description: '引用真实材料',
            weightPercent: '100',
          },
        ],
      }),
    );
    const file = pdfFile();

    const ready = await service.ingestSourceFile(initial.id, file);

    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') {
      throw new Error('expected ready ingestion');
    }
    expect(parserCalls).toBe(1);
    expect(ready.project.version).toBe(5);
    expect(ready.sourceFile).toMatchObject({
      projectId: initial.id,
      fileName: 'course.pdf',
      mediaType: 'application/pdf',
      extension: 'pdf',
      sizeBytes: file.size,
      contentSha256: await sha256('%PDF-real-source'),
      sourceVersion: 1,
      status: 'ready',
      parseProgress: 100,
      pageCount: 2,
      error: null,
    });
    expect(ready.chunks).toEqual([
      expect.objectContaining({
        projectId: initial.id,
        sourceFileId: ready.sourceFile.id,
        ordinal: 0,
        pageNumber: 1,
        pageLabel: '1',
        characterStart: 0,
        characterEnd: 5,
        text: 'Alpha',
        contentSha256: await sha256('Alpha'),
      }),
      expect.objectContaining({
        projectId: initial.id,
        sourceFileId: ready.sourceFile.id,
        ordinal: 1,
        pageNumber: 2,
        pageLabel: '2',
        characterStart: 6,
        characterEnd: 10,
        text: '人工智能',
        contentSha256: await sha256('人工智能'),
      }),
    ]);
    await expect(store.getProject(initial.id)).resolves.toEqual(ready.project);
    await expect(
      store.getSourceChunks(initial.id, ready.sourceFile.id),
    ).resolves.toEqual(ready.chunks);
    expect(
      await (
        await store.getSourceBlob(initial.id, ready.sourceFile.id)
      )?.text()
    ).toBe('%PDF-real-source');

    const duplicate = await service.ingestSourceFile(initial.id, file);
    expect(duplicate).toMatchObject({
      status: 'duplicate',
      project: { id: initial.id, version: 5 },
      existingSourceFileId: ready.sourceFile.id,
    });
    expect(parserCalls).toBe(1);
    expect(duplicate.project.sourceFiles).toHaveLength(1);
  });

  it('persists an exact failed parse state and never claims ready or creates chunks', async () => {
    const store = new MemoryProjectStore();
    const parser: PdfParserPort = {
      async parsePdf() {
        throw new SourceParserPortError('CORRUPT_PDF');
      },
    };
    const service = createWorkbenchService({
      store,
      pdfParser: parser,
      idFactory: sequentialIds(),
      now: () => new Date('2026-07-27T01:00:00.000Z'),
    });
    const initial = await service.createProject(
      form({
        rubric: [
          {
            title: '证据',
            description: '引用真实材料',
            weightPercent: '100',
          },
        ],
      }),
    );
    const invalidMime = new File(['not-pdf'], 'course.pdf', {
      type: 'text/plain',
    });
    await expect(
      service.ingestSourceFile(initial.id, invalidMime),
    ).rejects.toMatchObject({
      name: 'SourceFileValidationError',
      code: 'MIME_EXTENSION_MISMATCH',
    });
    await expect(store.getProject(initial.id)).resolves.toEqual(initial);

    const file = pdfFile('%PDF-damaged');
    const failed = await service.ingestSourceFile(initial.id, file);

    expect(failed.status).toBe('failed');
    if (failed.status !== 'failed') {
      throw new Error('expected failed ingestion');
    }
    expect(failed.errorCode).toBe('CORRUPT_PDF');
    expect(failed.project.version).toBe(4);
    expect(failed.sourceFile).toMatchObject({
      status: 'failed',
      parseProgress: 0,
      pageCount: null,
      error: {
        code: 'CORRUPT_PDF',
        retryable: true,
      },
    });
    expect(failed.project.sourceChunks).toEqual([]);
    await expect(
      store.getSourceChunks(initial.id, failed.sourceFile.id),
    ).resolves.toEqual([]);
    await expect(store.getProject(initial.id)).resolves.toEqual(
      failed.project,
    );
    expect(
      await (
        await store.getSourceBlob(initial.id, failed.sourceFile.id)
      )?.text()
    ).toBe('%PDF-damaged');
  });

  it('ingests real browser-decoded text and preserves an image as OCR-required', async () => {
    const store = new MemoryProjectStore();
    const service = createWorkbenchService({
      store,
      idFactory: sequentialIds(),
      now: () => new Date('2026-07-27T01:00:00.000Z'),
    });
    const initial = await service.createProject(
      form({
        rubric: [
          {
            title: '证据',
            description: '引用真实材料',
            weightPercent: '100',
          },
        ],
      }),
    );
    const notes = new File(
      ['第一条课程证据。\n第二条课程证据。'],
      'notes.txt',
      { type: 'text/plain' },
    );

    const textResult = await service.ingestSourceFile(initial.id, notes);

    expect(textResult.status).toBe('ready');
    if (textResult.status !== 'ready') {
      throw new Error('expected text source to be ready');
    }
    expect(textResult.sourceFile).toMatchObject({
      fileName: 'notes.txt',
      status: 'ready',
      pageCount: 1,
    });
    expect(textResult.chunks).toEqual([
      expect.objectContaining({
        pageNumber: 1,
        pageLabel: '1',
        characterStart: 0,
        characterEnd: 17,
        text: '第一条课程证据。\n第二条课程证据。',
      }),
    ]);

    const png = new File(
      [
        new Uint8Array([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
          0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        ]),
      ],
      'scan.png',
      { type: 'image/png' },
    );
    const imageResult = await service.ingestSourceFile(
      textResult.project.id,
      png,
    );

    expect(imageResult).toMatchObject({
      status: 'failed',
      errorCode: 'OCR_REQUIRED',
      sourceFile: {
        fileName: 'scan.png',
        status: 'failed',
        pageCount: null,
        error: {
          code: 'OCR_REQUIRED',
          retryable: true,
        },
      },
      project: {
        sourceChunks: textResult.chunks,
      },
    });
  });

  it('persists only exact, source-backed evidence and records user confirmation', async () => {
    const store = new MemoryProjectStore();
    const parser: PdfParserPort = {
      async parsePdf() {
        return {
          pageCount: 1,
          pages: [
            {
              pageNumber: 1,
              text: '课程数据显示，参与度提升了 18%，但样本规模有限。',
            },
          ],
        };
      },
    };
    const service = createWorkbenchService({
      store,
      pdfParser: parser,
      idFactory: sequentialIds(),
      now: () => new Date('2026-07-27T01:00:00.000Z'),
    });
    const initial = await service.createProject(
      form({
        rubric: [
          {
            title: '证据',
            description: '引用真实材料',
            weightPercent: '100',
          },
        ],
      }),
    );
    const ingested = await service.ingestSourceFile(
      initial.id,
      pdfFile(),
    );
    if (ingested.status !== 'ready') {
      throw new Error('expected ready source');
    }
    const chunk = ingested.chunks[0]!;

    const withEvidence = await service.createEvidence(initial.id, {
      sourceChunkId: chunk.id,
      quote: '参与度提升了 18%',
      kind: 'statistic',
      stance: 'supports',
      note: '支持核心结论',
      citation: '课程材料，第 1 页',
      userConfirmed: true,
    });

    expect(withEvidence.evidenceCards).toEqual([
      expect.objectContaining({
        sourceChunkId: chunk.id,
        sourceFileId: chunk.sourceFileId,
        pageNumber: 1,
        characterStart: 7,
        characterEnd: 17,
        quote: '参与度提升了 18%',
        kind: 'statistic',
        stance: 'support',
        confirmationStatus: 'confirmed',
        userConfirmedAt: expect.any(String),
        status: 'verified',
      }),
    ]);
    await expect(store.getProject(initial.id)).resolves.toEqual(
      withEvidence,
    );

    await expect(
      service.createEvidence(initial.id, {
        sourceChunkId: chunk.id,
        quote: '不存在的引文',
        kind: 'fact',
        stance: 'neutral',
        note: '',
        citation: '课程材料，第 1 页',
        userConfirmed: false,
      }),
    ).rejects.toMatchObject({
      name: 'WorkbenchServiceInputError',
      code: 'SOURCE_QUOTE_MISMATCH',
    });
  });

  it('ingests a real DOCX archive through the workbench pipeline', async () => {
    const store = new MemoryProjectStore();
    const service = createWorkbenchService({
      store,
      idFactory: sequentialIds(),
      now: () => new Date('2026-07-27T01:00:00.000Z'),
    });
    const initial = await service.createProject(
      form({
        rubric: [
          {
            title: '要求',
            description: '覆盖课程要求',
            weightPercent: '100',
          },
        ],
      }),
    );

    const result = await service.ingestSourceFile(
      initial.id,
      docxFile(),
    );

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') {
      throw new Error('expected DOCX source to be ready');
    }
    expect(result.sourceFile).toMatchObject({
      fileName: 'requirements.docx',
      status: 'ready',
      pageCount: 1,
    });
    expect(result.chunks.map((chunk) => chunk.text)).toEqual([
      '课程要求必须保留引用。',
      '结构需要覆盖评分标准。',
    ]);
  });
});

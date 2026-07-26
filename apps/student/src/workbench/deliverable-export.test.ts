import { unzipSync } from 'fflate';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Project } from './project-model.js';
import {
  createDraftPage,
  verifyDraft,
  type DraftPage,
} from './draft-verification.js';
import {
  DELIVERABLE_KINDS,
  exportDeliverable,
  type DeliverableExportInput,
  type DeliverableExportResult,
  type DeliverableKind,
} from './deliverable-export.js';

const CREATED_AT = '2026-07-27T01:00:00.000Z';
const UPDATED_AT = '2026-07-27T02:00:00.000Z';
const EXPORTED_AT = '2026-07-27T03:00:00.000Z';
const PROJECT_ID = '01900000-0000-7000-8000-000000000601';
const EVIDENCE_ID = '01900000-0000-7000-8000-000000000602';
const RUBRIC_ID = '01900000-0000-7000-8000-000000000603';

function project(): Project {
  return {
    schemaVersion: 1,
    id: PROJECT_ID,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    title: 'Demo Project',
    status: 'active',
    taskDefinition: {
      id: '01900000-0000-7000-8000-000000000604',
      version: 1,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      taskName: 'Two-page briefing',
      audience: 'Course instructor',
      dueAt: '2026-08-15T09:00:00.000Z',
      lengthTarget: { unit: 'pages', value: 2 },
      presentationDurationMinutes: 2,
      outputFormats: [
        'pptx',
        'pdf',
        'docx',
        'markdown',
        'script',
        'source-index',
        'task-card',
        'verification-record',
        'project-package',
      ],
      rubric: [
        {
          id: RUBRIC_ID,
          version: 1,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          title: 'Evidence',
          description: 'Claims are supported by evidence.',
          weightPercent: 100,
        },
      ],
      tone: 'Clear and concise',
      mustInclude: ['Core result'],
      mustAvoid: ['Forbidden claim'],
    },
    sourceFiles: [
      {
        id: '01900000-0000-7000-8000-000000000605',
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        projectId: PROJECT_ID,
        fileName: 'source.txt',
        mediaType: 'text/plain',
        extension: 'txt',
        sizeBytes: 20,
        contentSha256: 'a'.repeat(64),
        blobId: 'blob:source',
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
        id: '01900000-0000-7000-8000-000000000606',
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        projectId: PROJECT_ID,
        sourceFileId: '01900000-0000-7000-8000-000000000605',
        sourceFileVersion: 1,
        ordinal: 0,
        pageNumber: 1,
        pageLabel: '1',
        characterStart: 0,
        characterEnd: 20,
        text: 'Verified source text',
        contentSha256: 'b'.repeat(64),
      },
    ],
    evidenceCards: [
      {
        id: EVIDENCE_ID,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        projectId: PROJECT_ID,
        sourceFileId: '01900000-0000-7000-8000-000000000605',
        sourceChunkId: '01900000-0000-7000-8000-000000000606',
        sourceFileVersion: 1,
        pageNumber: 1,
        characterStart: 0,
        characterEnd: 20,
        quote: 'Verified source text',
        kind: 'fact',
        note: 'Primary evidence',
        citation: 'Source, page 1',
        status: 'verified',
        stance: 'support',
        confirmationStatus: 'confirmed',
        userConfirmedAt: UPDATED_AT,
      },
    ],
    outlines: [],
    activeOutlineId: null,
    artifacts: [],
    verificationResults: [],
  };
}

function pages(): readonly DraftPage[] {
  return [
    createDraftPage({
      id: 'page-1',
      title: 'Core result',
      conclusion: 'The pilot reduced waiting time.',
      body: 'The evidence supports a staged rollout.',
      evidenceCardIds: [EVIDENCE_ID],
      citations: [{ evidenceCardId: EVIDENCE_ID, label: '[1]' }],
      visualNote: 'Use a simple before-and-after chart.',
      speakerNotes: 'Explain the result and its source.',
      estimatedSeconds: 60,
      locked: true,
      rubricCriterionIds: [RUBRIC_ID],
      claims: [
        {
          id: 'claim-1',
          text: 'The pilot reduced waiting time.',
          evidenceCardIds: [EVIDENCE_ID],
          numericFacts: [],
        },
      ],
    }),
    createDraftPage({
      id: 'page-2',
      title: 'Recommended action',
      conclusion: 'Start with a controlled rollout.',
      body: 'Measure outcomes before expanding.',
      evidenceCardIds: [EVIDENCE_ID],
      citations: [{ evidenceCardId: EVIDENCE_ID, label: '[1]' }],
      visualNote: 'Show a three-step timeline.',
      speakerNotes: 'Close with the next action.',
      estimatedSeconds: 60,
      locked: false,
      rubricCriterionIds: [RUBRIC_ID],
      claims: [
        {
          id: 'claim-2',
          text: 'Start with a controlled rollout.',
          evidenceCardIds: [EVIDENCE_ID],
          numericFacts: [],
        },
      ],
    }),
  ];
}

function exportInput(): Omit<DeliverableExportInput, 'kind'> {
  const currentProject = project();
  const draftPages = pages();
  return {
    project: currentProject,
    draftPages,
    verificationChecks: verifyDraft({
      pages: draftPages,
      taskDefinition: currentProject.taskDefinition,
      evidenceCards: currentProject.evidenceCards,
    }),
    exportedAt: EXPORTED_AT,
  };
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    await blob.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function xmlText(
  archive: ReturnType<typeof unzipSync>,
  path: string,
): string {
  const bytes = archive[path];
  if (bytes === undefined) {
    throw new Error(`missing archive entry: ${path}`);
  }
  return new TextDecoder().decode(bytes);
}

describe('real browser deliverable exports', () => {
  const results = new Map<DeliverableKind, DeliverableExportResult>();

  beforeAll(async () => {
    const input = exportInput();
    for (const kind of DELIVERABLE_KINDS) {
      results.set(
        kind,
        await exportDeliverable({
          ...input,
          kind,
        }),
      );
    }
  }, 30_000);

  it('returns a non-empty Blob and trustworthy download metadata for every format', async () => {
    expect([...results.keys()]).toEqual(DELIVERABLE_KINDS);
    for (const [kind, result] of results) {
      expect(result.kind).toBe(kind);
      expect(result.blob).toBeInstanceOf(Blob);
      expect(result.sizeBytes).toBe(result.blob.size);
      expect(result.sizeBytes).toBeGreaterThan(20);
      expect(result.mimeType).toBe(result.blob.type);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(result.sha256).toBe(await sha256(result.blob));
      expect(result.fileName).not.toMatch(/[<>:"/\\|?*]/u);
    }
  });

  it('creates a PPTX that can be unzipped and contains slide text and speaker notes', async () => {
    const result = results.get('pptx');
    if (result === undefined) {
      throw new Error('missing PPTX result');
    }
    const archive = unzipSync(
      new Uint8Array(await result.blob.arrayBuffer()),
    );

    expect(Object.keys(archive)).toContain('[Content_Types].xml');
    expect(xmlText(archive, 'ppt/slides/slide1.xml')).toContain(
      'Core result',
    );
    expect(xmlText(archive, 'ppt/slides/slide1.xml')).toContain(
      'The pilot reduced waiting time.',
    );
    expect(xmlText(archive, 'ppt/notesSlides/notesSlide1.xml')).toContain(
      'Explain the result and its source.',
    );
    expect(
      Object.keys(archive).filter((path) =>
        /^ppt\/slides\/slide[0-9]+\.xml$/u.test(path),
      ),
    ).toHaveLength(2);
  });

  it('creates a DOCX that can be unzipped and contains the draft and citations', async () => {
    const result = results.get('docx');
    if (result === undefined) {
      throw new Error('missing DOCX result');
    }
    const archive = unzipSync(
      new Uint8Array(await result.blob.arrayBuffer()),
    );
    const documentXml = xmlText(archive, 'word/document.xml');

    expect(documentXml).toContain('Core result');
    expect(documentXml).toContain('The pilot reduced waiting time.');
    expect(documentXml).toContain('Source, page 1');
    expect(documentXml).toContain('Speaker notes');
  });

  it('creates a PDF that PDF.js can reopen with the expected pages and text', async () => {
    const result = results.get('pdf');
    if (result === undefined) {
      throw new Error('missing PDF result');
    }
    const loadingTask = getDocument({
      data: new Uint8Array(await result.blob.arrayBuffer()),
    });
    const document = await loadingTask.promise;
    try {
      expect(document.numPages).toBe(2);
      const firstPage = await document.getPage(1);
      try {
        const textContent = await firstPage.getTextContent();
        const text = textContent.items
          .flatMap((item) =>
            typeof item === 'object' &&
            item !== null &&
            'str' in item &&
            typeof item.str === 'string'
              ? [item.str]
              : [],
          )
          .join(' ');
        expect(text).toContain('Core result');
        expect(text).toContain('The pilot reduced waiting time.');
      } finally {
        firstPage.cleanup(true);
      }
    } finally {
      await document.cleanup();
      await loadingTask.destroy();
    }
  });

  it('exports readable Markdown, script, source index, task card and verification report', async () => {
    const expected: Readonly<Record<DeliverableKind, string>> = {
      pptx: '',
      pdf: '',
      docx: '',
      markdown: 'The pilot reduced waiting time.',
      script: 'Explain the result and its source.',
      'source-index': 'Verified source text',
      'task-card': 'Two-page briefing',
      'verification-report': 'SOURCE_TRACEABLE',
      'project-json': '',
      'project-package': '',
    };
    for (const kind of [
      'markdown',
      'script',
      'source-index',
      'task-card',
      'verification-report',
    ] as const) {
      const result = results.get(kind);
      if (result === undefined) {
        throw new Error(`missing ${kind} result`);
      }
      expect(await result.blob.text()).toContain(expected[kind]);
    }
  });

  it('exports a complete JSON snapshot and a re-openable project ZIP package', async () => {
    const jsonResult = results.get('project-json');
    const packageResult = results.get('project-package');
    if (jsonResult === undefined || packageResult === undefined) {
      throw new Error('missing project export');
    }
    const snapshot = JSON.parse(await jsonResult.blob.text()) as {
      format: string;
      formatVersion: number;
      project: Project;
      draftPages: DraftPage[];
    };
    expect(snapshot).toMatchObject({
      format: 'zuocheng-project-export',
      formatVersion: 1,
      project: { id: PROJECT_ID, title: 'Demo Project' },
    });
    expect(snapshot.draftPages).toHaveLength(2);

    const archive = unzipSync(
      new Uint8Array(await packageResult.blob.arrayBuffer()),
    );
    expect(Object.keys(archive).sort()).toEqual([
      'draft.json',
      'manifest.json',
      'project.json',
      'reports/draft.md',
      'reports/script.md',
      'reports/source-index.md',
      'reports/task-card.md',
      'reports/verification.md',
      'verification.json',
    ]);
    expect(
      JSON.parse(xmlText(archive, 'project.json')) as Project,
    ).toMatchObject({
      id: PROJECT_ID,
      title: 'Demo Project',
    });
    expect(xmlText(archive, 'reports/source-index.md')).toContain(
      'Verified source text',
    );
  });

  it('embeds an offline font so Chinese PDF content survives a PDF.js round trip', async () => {
    const input = exportInput();
    const firstPage = input.draftPages[0];
    if (firstPage === undefined) {
      throw new Error('missing draft page');
    }
    const chinesePage = createDraftPage({
      ...firstPage,
      title: '中文标题：试点结果',
      conclusion: '试点显著减少了等待时间。',
      body: '证据支持分阶段推广，并持续核验关键指标。',
      citations: [{ evidenceCardId: EVIDENCE_ID, label: '来源一' }],
      speakerNotes: '说明中文结论、正文与引用来源。',
      locked: false,
    });
    const chineseProject: Project = {
      ...input.project,
      title: '中文项目',
      sourceChunks: input.project.sourceChunks.map((chunk) => ({
        ...chunk,
        text: '经过核验的中文来源内容',
      })),
      evidenceCards: input.project.evidenceCards.map((card) => ({
        ...card,
        quote: '经过核验的中文来源内容',
        citation: '中文来源，第 1 页',
      })),
    };

    const result = await exportDeliverable({
      ...input,
      project: chineseProject,
      kind: 'pdf',
      draftPages: [chinesePage],
    });
    expect(result.sizeBytes).toBeGreaterThan(1_000);

    const loadingTask = getDocument({
      data: new Uint8Array(await result.blob.arrayBuffer()),
    });
    const document = await loadingTask.promise;
    try {
      expect(document.numPages).toBe(1);
      const page = await document.getPage(1);
      try {
        const textContent = await page.getTextContent();
        const text = textContent.items
          .flatMap((item) =>
            typeof item === 'object' &&
            item !== null &&
            'str' in item &&
            typeof item.str === 'string'
              ? [item.str]
              : [],
          )
          .join('');
        expect(text).toContain('中文标题：试点结果');
        expect(text).toContain('试点显著减少了等待时间');
        expect(text).toContain('证据支持分阶段推广');
        expect(text).toContain('中文来源，第 1 页');
      } finally {
        page.cleanup(true);
      }
    } finally {
      await document.cleanup();
      await loadingTask.destroy();
    }
  }, 30_000);
});

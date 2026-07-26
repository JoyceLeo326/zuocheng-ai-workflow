import { strToU8, zipSync, type Zippable } from 'fflate';
import type {
  EvidenceCard,
  Project,
} from './project-model.js';
import type {
  DraftPage,
  DraftVerificationCheck,
} from './draft-verification.js';

export const DELIVERABLE_KINDS = [
  'pptx',
  'pdf',
  'docx',
  'markdown',
  'script',
  'source-index',
  'task-card',
  'verification-report',
  'project-json',
  'project-package',
] as const;

export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export type DeliverableExportInput = Readonly<{
  kind: DeliverableKind;
  project: Project;
  draftPages: readonly DraftPage[];
  verificationChecks: readonly DraftVerificationCheck[];
  exportedAt: string;
}>;

export type DeliverableExportResult = Readonly<{
  kind: DeliverableKind;
  blob: Blob;
  fileName: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
}>;

export type DeliverableExportErrorCode =
  | 'INVALID_EXPORTED_AT'
  | 'EMPTY_DRAFT'
  | 'WEB_CRYPTO_UNAVAILABLE'
  | 'UNSUPPORTED_PDF_TEXT'
  | 'EXPORT_FAILED';

export class DeliverableExportError extends Error {
  constructor(readonly code: DeliverableExportErrorCode) {
    super(`Deliverable export failed: ${code}`);
    this.name = 'DeliverableExportError';
  }
}

type FormatDefinition = Readonly<{
  suffix: string;
  mimeType: string;
}>;

const FORMAT_DEFINITIONS: Readonly<
  Record<DeliverableKind, FormatDefinition>
> = {
  pptx: {
    suffix: '.pptx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  pdf: {
    suffix: '.pdf',
    mimeType: 'application/pdf',
  },
  docx: {
    suffix: '.docx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  markdown: {
    suffix: '-draft.md',
    mimeType: 'text/markdown;charset=utf-8',
  },
  script: {
    suffix: '-script.md',
    mimeType: 'text/markdown;charset=utf-8',
  },
  'source-index': {
    suffix: '-source-index.md',
    mimeType: 'text/markdown;charset=utf-8',
  },
  'task-card': {
    suffix: '-task-card.md',
    mimeType: 'text/markdown;charset=utf-8',
  },
  'verification-report': {
    suffix: '-verification.md',
    mimeType: 'text/markdown;charset=utf-8',
  },
  'project-json': {
    suffix: '-project.json',
    mimeType: 'application/json;charset=utf-8',
  },
  'project-package': {
    suffix: '-project.zip',
    mimeType: 'application/zip',
  },
};

const DRAFT_REQUIRED_KINDS = new Set<DeliverableKind>([
  'pptx',
  'pdf',
  'docx',
  'markdown',
  'script',
]);

export async function exportDeliverable(
  input: DeliverableExportInput,
  cryptoProvider: Pick<Crypto, 'subtle'> | undefined = globalThis.crypto,
): Promise<DeliverableExportResult> {
  assertExportedAt(input.exportedAt);
  if (
    DRAFT_REQUIRED_KINDS.has(input.kind) &&
    input.draftPages.length === 0
  ) {
    throw new DeliverableExportError('EMPTY_DRAFT');
  }
  if (cryptoProvider?.subtle === undefined) {
    throw new DeliverableExportError('WEB_CRYPTO_UNAVAILABLE');
  }

  const definition = FORMAT_DEFINITIONS[input.kind];
  let generated: Blob;
  try {
    generated = await generateBlob(input, definition.mimeType);
  } catch (error) {
    if (error instanceof DeliverableExportError) {
      throw error;
    }
    throw new DeliverableExportError('EXPORT_FAILED');
  }
  const blob =
    generated.type === definition.mimeType
      ? generated
      : new Blob([await generated.arrayBuffer()], {
          type: definition.mimeType,
        });
  if (blob.size === 0) {
    throw new DeliverableExportError('EXPORT_FAILED');
  }
  const sha256 = await sha256Blob(blob, cryptoProvider.subtle);
  return Object.freeze({
    kind: input.kind,
    blob,
    fileName:
      `${safeFileBase(input.project.title)}` + definition.suffix,
    mimeType: definition.mimeType,
    sha256,
    sizeBytes: blob.size,
  });
}

async function generateBlob(
  input: DeliverableExportInput,
  mimeType: string,
): Promise<Blob> {
  switch (input.kind) {
    case 'pptx':
      return generatePptx(input, mimeType);
    case 'pdf':
      return generatePdf(input, mimeType);
    case 'docx':
      return generateDocx(input, mimeType);
    case 'markdown':
      return textBlob(draftMarkdown(input), mimeType);
    case 'script':
      return textBlob(scriptMarkdown(input), mimeType);
    case 'source-index':
      return textBlob(sourceIndexMarkdown(input), mimeType);
    case 'task-card':
      return textBlob(taskCardMarkdown(input), mimeType);
    case 'verification-report':
      return textBlob(verificationMarkdown(input), mimeType);
    case 'project-json':
      return textBlob(projectSnapshotJson(input), mimeType);
    case 'project-package':
      return generateProjectPackage(input, mimeType);
  }
}

async function generatePptx(
  input: DeliverableExportInput,
  mimeType: string,
): Promise<Blob> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const presentation = new PptxGenJS();
  presentation.layout = 'LAYOUT_WIDE';
  presentation.author = 'ZuoCheng Workbench';
  presentation.company = 'ZuoCheng';
  presentation.subject = input.project.taskDefinition.taskName;
  presentation.title = input.project.title;
  presentation.theme = {
    headFontFace: 'Aptos Display',
    bodyFontFace: 'Aptos',
  };

  for (const [pageIndex, page] of input.draftPages.entries()) {
    const slide = presentation.addSlide();
    slide.background = { color: 'F7F8FA' };
    slide.addText(page.title, {
      x: 0.6,
      y: 0.35,
      w: 11.8,
      h: 0.55,
      fontFace: 'Aptos Display',
      fontSize: 26,
      bold: true,
      color: '172033',
      margin: 0,
      breakLine: false,
      fit: 'shrink',
    });
    slide.addText(page.conclusion, {
      x: 0.6,
      y: 1.15,
      w: 8.2,
      h: 0.9,
      fontFace: 'Aptos',
      fontSize: 20,
      bold: true,
      color: '174A7E',
      margin: 0.06,
      fit: 'shrink',
    });
    slide.addText(page.body, {
      x: 0.6,
      y: 2.15,
      w: 8.2,
      h: 3.4,
      fontFace: 'Aptos',
      fontSize: 15,
      color: '273349',
      breakLine: false,
      margin: 0.08,
      valign: 'top',
      fit: 'shrink',
    });
    slide.addText(`Visual note\n${page.visualNote}`, {
      x: 9.1,
      y: 1.15,
      w: 3.55,
      h: 2.25,
      fontFace: 'Aptos',
      fontSize: 12,
      color: '53627A',
      fill: { color: 'E8EDF4' },
      margin: 0.15,
      fit: 'shrink',
    });
    slide.addText(citationLines(page, input.project.evidenceCards), {
      x: 0.6,
      y: 5.8,
      w: 12.05,
      h: 0.75,
      fontFace: 'Aptos',
      fontSize: 9,
      color: '5C6678',
      margin: 0.04,
      fit: 'shrink',
    });
    slide.addText(`${pageIndex + 1} / ${input.draftPages.length}`, {
      x: 11.55,
      y: 6.95,
      w: 1,
      h: 0.2,
      fontFace: 'Aptos',
      fontSize: 8,
      color: '7A8496',
      align: 'right',
      margin: 0,
    });
    slide.addNotes(page.speakerNotes);
  }

  const output = await presentation.write({
    outputType: 'arraybuffer',
    compression: true,
  });
  return blobFromUnknownBinary(output, mimeType);
}

async function generateDocx(
  input: DeliverableExportInput,
  mimeType: string,
): Promise<Blob> {
  const {
    Document,
    HeadingLevel,
    PageBreak,
    Packer,
    Paragraph,
    TextRun,
  } = await import('docx');
  const evidenceById = new Map(
    input.project.evidenceCards.map((evidence) => [
      evidence.id,
      evidence,
    ]),
  );
  const children: InstanceType<typeof Paragraph>[] = [];
  for (const [pageIndex, page] of input.draftPages.entries()) {
    if (pageIndex > 0) {
      children.push(
        new Paragraph({
          children: [new PageBreak()],
        }),
      );
    }
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: page.title, bold: true })],
      }),
      new Paragraph({
        children: [
          new TextRun({ text: 'Conclusion: ', bold: true }),
          new TextRun(page.conclusion),
        ],
      }),
    );
    for (const bodyLine of nonEmptyLines(page.body)) {
      children.push(new Paragraph({ text: bodyLine }));
    }
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: 'Visual note: ', bold: true }),
          new TextRun(page.visualNote),
        ],
      }),
      new Paragraph({
        children: [
          new TextRun({ text: 'Speaker notes: ', bold: true }),
          new TextRun(page.speakerNotes),
        ],
      }),
      new Paragraph({
        children: [new TextRun({ text: 'Citations', bold: true })],
      }),
    );
    for (const citation of page.citations) {
      const evidence = evidenceById.get(citation.evidenceCardId);
      children.push(
        new Paragraph({
          text:
            `${citation.label} ` +
            (evidence?.citation ?? `[missing evidence ${citation.evidenceCardId}]`),
        }),
      );
    }
  }
  const document = new Document({
    creator: 'ZuoCheng Workbench',
    title: input.project.title,
    subject: input.project.taskDefinition.taskName,
    description: `Exported ${input.exportedAt}`,
    sections: [{ children }],
  });
  const blob = await Packer.toBlob(document);
  return new Blob([await blob.arrayBuffer()], { type: mimeType });
}

async function generatePdf(
  input: DeliverableExportInput,
  mimeType: string,
): Promise<Blob> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const document = await PDFDocument.create();
  let font = await document.embedFont(StandardFonts.Helvetica);
  let boldFont = await document.embedFont(StandardFonts.HelveticaBold);
  const exportedDate = new Date(input.exportedAt);
  document.setTitle(input.project.title);
  document.setSubject(input.project.taskDefinition.taskName);
  document.setAuthor('ZuoCheng Workbench');
  document.setCreator('ZuoCheng Workbench');
  document.setProducer('pdf-lib');
  document.setCreationDate(exportedDate);
  document.setModificationDate(exportedDate);

  const allText = [
    input.project.title,
    input.project.taskDefinition.taskName,
    ...input.draftPages.flatMap((page) => [
      page.title,
      page.conclusion,
      page.body,
      page.visualNote,
      page.speakerNotes,
      citationLines(page, input.project.evidenceCards),
    ]),
  ];
  try {
    for (const text of allText) {
      font.encodeText(text);
      boldFont.encodeText(text);
    }
  } catch {
    const [
      { default: fontkit },
      { default: notoSansScDataUrl },
    ] = await Promise.all([
      import('@pdf-lib/fontkit'),
      import(
        '@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff?inline'
      ),
    ]);
    document.registerFontkit(fontkit);
    font = await document.embedFont(notoSansScDataUrl, {
      subset: true,
    });
    boldFont = font;
    try {
      for (const text of allText) {
        font.encodeText(text);
      }
    } catch {
      throw new DeliverableExportError('UNSUPPORTED_PDF_TEXT');
    }
  }

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 48;
  const bodySize = 10.5;
  const bodyLineHeight = 14;
  for (const [draftIndex, draftPage] of input.draftPages.entries()) {
    let pdfPage = document.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    const addContinuationPage = () => {
      pdfPage = document.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
      pdfPage.drawText(`${draftPage.title} (continued)`, {
        x: margin,
        y,
        size: 14,
        font: boldFont,
        color: rgb(0.09, 0.13, 0.2),
      });
      y -= 24;
    };
    const drawBlock = (
      label: string,
      text: string,
      options: Readonly<{ bold?: boolean; size?: number }> = {},
    ) => {
      const size = options.size ?? bodySize;
      const selectedFont = options.bold ? boldFont : font;
      const value = label.length > 0 ? `${label}${text}` : text;
      const lines = wrapPdfText(
        value,
        selectedFont,
        size,
        pageWidth - margin * 2,
      );
      for (const line of lines) {
        if (y < margin + bodyLineHeight) {
          addContinuationPage();
        }
        pdfPage.drawText(line, {
          x: margin,
          y,
          size,
          font: selectedFont,
          color: rgb(0.12, 0.17, 0.26),
        });
        y -= Math.max(bodyLineHeight, size * 1.35);
      }
      y -= 5;
    };

    drawBlock('', draftPage.title, { bold: true, size: 19 });
    drawBlock('Conclusion: ', draftPage.conclusion, { bold: true });
    drawBlock('', draftPage.body);
    drawBlock('Visual note: ', draftPage.visualNote);
    drawBlock('Speaker notes: ', draftPage.speakerNotes);
    drawBlock(
      'Citations: ',
      citationLines(draftPage, input.project.evidenceCards),
    );
    pdfPage.drawText(
      `${draftIndex + 1} / ${input.draftPages.length}`,
      {
        x: pageWidth - margin - 28,
        y: 24,
        size: 8,
        font,
        color: rgb(0.42, 0.46, 0.54),
      },
    );
  }
  const bytes = await document.save({ useObjectStreams: false });
  return blobFromBytes(bytes, mimeType);
}

function wrapPdfText(
  value: string,
  font: Readonly<{
    widthOfTextAtSize(text: string, size: number): number;
  }>,
  size: number,
  maxWidth: number,
): readonly string[] {
  const lines: string[] = [];
  for (const sourceLine of value.replace(/\r\n?/gu, '\n').split('\n')) {
    if (sourceLine.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of sourceLine.split(/\s+/u)) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current.length > 0) {
        lines.push(current);
      }
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        current = word;
        continue;
      }
      let fragment = '';
      for (const character of word) {
        const next = fragment + character;
        if (
          fragment.length > 0 &&
          font.widthOfTextAtSize(next, size) > maxWidth
        ) {
          lines.push(fragment);
          fragment = character;
        } else {
          fragment = next;
        }
      }
      current = fragment;
    }
    if (current.length > 0) {
      lines.push(current);
    }
  }
  return Object.freeze(lines);
}

function draftMarkdown(input: DeliverableExportInput): string {
  const sections = input.draftPages.map((page, index) => {
    return [
      `## ${index + 1}. ${page.title}`,
      '',
      `**Conclusion:** ${page.conclusion}`,
      '',
      page.body,
      '',
      `**Visual note:** ${page.visualNote}`,
      '',
      `**Estimated time:** ${page.estimatedSeconds} seconds`,
      '',
      '### Citations',
      citationListMarkdown(page, input.project.evidenceCards),
      '',
      '### Speaker notes',
      page.speakerNotes,
    ].join('\n');
  });
  return [
    `# ${input.project.title}`,
    '',
    `Task: ${input.project.taskDefinition.taskName}`,
    '',
    ...sections,
    '',
  ].join('\n');
}

function scriptMarkdown(input: DeliverableExportInput): string {
  return [
    `# ${input.project.title} — Speaker Script`,
    '',
    ...input.draftPages.map((page, index) =>
      [
        `## ${index + 1}. ${page.title} (${page.estimatedSeconds}s)`,
        '',
        page.speakerNotes || page.body,
        '',
        `Conclusion: ${page.conclusion}`,
        '',
        citationListMarkdown(page, input.project.evidenceCards),
      ].join('\n'),
    ),
    '',
  ].join('\n');
}

function sourceIndexMarkdown(input: DeliverableExportInput): string {
  const filesById = new Map(
    input.project.sourceFiles.map((file) => [file.id, file]),
  );
  const chunksById = new Map(
    input.project.sourceChunks.map((chunk) => [chunk.id, chunk]),
  );
  const rows = input.project.evidenceCards.map((evidence) => {
    const file = filesById.get(evidence.sourceFileId);
    const chunk = chunksById.get(evidence.sourceChunkId);
    return [
      evidence.id,
      file?.fileName ?? evidence.sourceFileId,
      String(evidence.pageNumber),
      chunk?.pageLabel ?? String(evidence.pageNumber),
      evidence.quote,
      evidence.citation,
      evidence.status,
    ]
      .map(markdownTableCell)
      .join(' | ');
  });
  return [
    `# ${input.project.title} — Source Index`,
    '',
    '| Evidence ID | File | Page | Label | Quote | Citation | Status |',
    '| --- | --- | ---: | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row} |`),
    '',
  ].join('\n');
}

function taskCardMarkdown(input: DeliverableExportInput): string {
  const task = input.project.taskDefinition;
  return [
    `# ${task.taskName}`,
    '',
    `- Audience: ${task.audience}`,
    `- Due: ${task.dueAt}`,
    `- Length target: ${task.lengthTarget.value} ${task.lengthTarget.unit}`,
    `- Presentation duration: ${
      task.presentationDurationMinutes === null
        ? 'Not specified'
        : `${task.presentationDurationMinutes} minutes`
    }`,
    `- Tone: ${task.tone}`,
    `- Output formats: ${task.outputFormats.join(', ')}`,
    '',
    '## Must include',
    ...task.mustInclude.map((item) => `- ${item}`),
    '',
    '## Must avoid',
    ...task.mustAvoid.map((item) => `- ${item}`),
    '',
    '## Rubric',
    ...task.rubric.map(
      (criterion) =>
        `- **${criterion.title} (${criterion.weightPercent}%)**: ` +
        criterion.description,
    ),
    '',
  ].join('\n');
}

function verificationMarkdown(input: DeliverableExportInput): string {
  return [
    `# ${input.project.title} — Verification Report`,
    '',
    `Exported: ${input.exportedAt}`,
    '',
    ...input.verificationChecks.flatMap((check, index) => [
      `## ${index + 1}. ${check.code} — ${check.outcome.toUpperCase()}`,
      '',
      `- Severity: ${check.severity}`,
      `- Rule: ${check.rule}`,
      `- Path: ${check.artifactPath}`,
      `- Evidence: ${check.evidenceCardIds.join(', ') || 'None'}`,
      `- Message: ${check.message}`,
      `- Fix: ${check.fixHint}`,
      '',
    ]),
  ].join('\n');
}

function projectSnapshotJson(input: DeliverableExportInput): string {
  return (
    JSON.stringify(
      {
        format: 'zuocheng-project-export',
        formatVersion: 1,
        exportedAt: input.exportedAt,
        project: input.project,
        draftPages: input.draftPages,
        verificationChecks: input.verificationChecks,
      },
      null,
      2,
    ) + '\n'
  );
}

function generateProjectPackage(
  input: DeliverableExportInput,
  mimeType: string,
): Blob {
  const reportFiles = {
    'reports/draft.md': draftMarkdown(input),
    'reports/script.md': scriptMarkdown(input),
    'reports/source-index.md': sourceIndexMarkdown(input),
    'reports/task-card.md': taskCardMarkdown(input),
    'reports/verification.md': verificationMarkdown(input),
  };
  const fileNames = [
    'draft.json',
    'manifest.json',
    'project.json',
    ...Object.keys(reportFiles),
    'verification.json',
  ].sort();
  const manifest = {
    format: 'zuocheng-project-package',
    formatVersion: 1,
    exportedAt: input.exportedAt,
    projectId: input.project.id,
    files: fileNames,
    sourceBlobsIncluded: false,
  };
  const textEntries: Readonly<Record<string, string>> = {
    'draft.json': `${JSON.stringify(input.draftPages, null, 2)}\n`,
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'project.json': `${JSON.stringify(input.project, null, 2)}\n`,
    ...reportFiles,
    'verification.json':
      `${JSON.stringify(input.verificationChecks, null, 2)}\n`,
  };
  const epoch = new Date('1980-01-01T00:00:00.000Z');
  const archive: Zippable = {};
  for (const [path, text] of Object.entries(textEntries)) {
    archive[path] = [
      strToU8(text),
      {
        level: 6,
        mtime: epoch,
      },
    ];
  }
  return blobFromBytes(zipSync(archive), mimeType);
}

function citationLines(
  page: DraftPage,
  evidenceCards: readonly EvidenceCard[],
): string {
  const evidenceById = new Map(
    evidenceCards.map((evidence) => [evidence.id, evidence]),
  );
  return page.citations
    .map((citation) => {
      const evidence = evidenceById.get(citation.evidenceCardId);
      return (
        `${citation.label} ` +
        (evidence?.citation ?? `[missing evidence ${citation.evidenceCardId}]`)
      );
    })
    .join('\n');
}

function citationListMarkdown(
  page: DraftPage,
  evidenceCards: readonly EvidenceCard[],
): string {
  const lines = citationLines(page, evidenceCards);
  return lines.length === 0
    ? '- No citations'
    : lines
        .split('\n')
        .map((line) => `- ${line}`)
        .join('\n');
}

function nonEmptyLines(value: string): readonly string[] {
  const lines = value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? Object.freeze(lines) : Object.freeze(['']);
}

function markdownTableCell(value: string): string {
  return value
    .replace(/\|/gu, '\\|')
    .replace(/\r?\n/gu, '<br>')
    .trim();
}

function textBlob(text: string, mimeType: string): Blob {
  return new Blob([text], { type: mimeType });
}

function blobFromBytes(bytes: Uint8Array, mimeType: string): Blob {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return new Blob([owned.buffer], { type: mimeType });
}

function blobFromUnknownBinary(value: unknown, mimeType: string): Blob {
  if (value instanceof Blob) {
    return new Blob([value], { type: mimeType });
  }
  if (value instanceof ArrayBuffer) {
    return new Blob([value], { type: mimeType });
  }
  if (value instanceof Uint8Array) {
    return blobFromBytes(value, mimeType);
  }
  throw new DeliverableExportError('EXPORT_FAILED');
}

async function sha256Blob(
  blob: Blob,
  subtle: SubtleCrypto,
): Promise<string> {
  const digest = await subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function safeFileBase(value: string): string {
  let result = '';
  for (const character of value.normalize('NFKC')) {
    const codePoint = character.codePointAt(0);
    const unsafe =
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      '<>:"/\\|?*'.includes(character);
    result += unsafe ? '-' : character;
  }
  const normalized = result
    .trim()
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/[. -]+$/gu, '')
    .slice(0, 80);
  return normalized.length > 0 ? normalized : 'project';
}

function assertExportedAt(value: string): void {
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    throw new DeliverableExportError('INVALID_EXPORTED_AT');
  }
}

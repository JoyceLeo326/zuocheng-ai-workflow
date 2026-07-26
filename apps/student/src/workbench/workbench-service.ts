import {
  PROJECT_SCHEMA_VERSION,
  parseProject,
  type OutputFormat,
  type Project,
  type EvidenceKind,
  type RubricCriterion,
  type SourceChunk,
  type SourceFile as ProjectSourceFile,
} from './project-model.js';
import {
  ProjectNotFoundError,
  type ProjectStore,
} from './project-store.js';
import {
  beginSourceParsing,
  computeSourceFileSha256,
  createSourceFile,
  isDuplicateSourceHash,
  runPdfParsing,
  validateSourceUpload,
  type PdfParserPort,
  type SourceParserFailureCode,
  type ValidatedSourceUpload,
} from './source-file.js';
import {
  BrowserSourceParserError,
  parseBrowserSourceFile,
  type BrowserSourceParserErrorCode,
  type TraceableTextChunk,
} from './text-parsers.js';
import type { BrowserOfficeParserErrorCode } from './docx-pptx-parser.js';

export interface WorkbenchRubricFormInput {
  title: string;
  description: string;
  weightPercent: string | number;
}

export type WorkbenchOutputFormatInput =
  | 'presentation'
  | 'report'
  | 'document'
  | OutputFormat;

export interface WorkbenchProjectFormInput {
  projectTitle?: string;
  taskName: string;
  audience: string;
  deadline: string;
  scope: string;
  durationMinutes: string;
  outputFormat: WorkbenchOutputFormatInput;
  tone: string;
  rubric: readonly WorkbenchRubricFormInput[];
  requiredContent: string;
  forbiddenContent: string;
}

export interface WorkbenchEvidenceInput {
  sourceChunkId: string;
  quote: string;
  kind: EvidenceKind;
  stance: 'supports' | 'opposes' | 'neutral';
  note: string;
  citation: string;
  userConfirmed: boolean;
}

export type SourceIngestionFailureCode =
  | SourceParserFailureCode
  | BrowserSourceParserErrorCode
  | BrowserOfficeParserErrorCode
  | 'INVALID_PARSER_OUTPUT';

export type SourceIngestionResult =
  | Readonly<{
      status: 'ready';
      project: Project;
      sourceFile: ProjectSourceFile;
      chunks: SourceChunk[];
    }>
  | Readonly<{
      status: 'failed';
      project: Project;
      sourceFile: ProjectSourceFile;
      errorCode: SourceIngestionFailureCode;
    }>
  | Readonly<{
      status: 'duplicate';
      project: Project;
      existingSourceFileId: string;
    }>;

export interface WorkbenchService {
  listProjects(): Promise<Project[]>;
  createProject(input: WorkbenchProjectFormInput): Promise<Project>;
  createEvidence(
    projectId: string,
    input: WorkbenchEvidenceInput,
  ): Promise<Project>;
  ingestSourceFile(
    projectId: string,
    file: File,
  ): Promise<SourceIngestionResult>;
}

export type WorkbenchServiceInputErrorCode =
  | 'INVALID_LENGTH_TARGET'
  | 'INVALID_DURATION'
  | 'INVALID_RUBRIC_WEIGHT'
  | 'UNSUPPORTED_OUTPUT_FORMAT'
  | 'UNSUPPORTED_SOURCE_KIND'
  | 'INVALID_DEADLINE'
  | 'INVALID_CLOCK'
  | 'INVALID_PARSER_OUTPUT'
  | 'WEB_CRYPTO_UNAVAILABLE'
  | 'SOURCE_CHUNK_NOT_FOUND'
  | 'SOURCE_QUOTE_MISMATCH'
  | 'AMBIGUOUS_SOURCE_QUOTE'
  | 'DUPLICATE_EVIDENCE'
  | 'EVIDENCE_CONFIRMATION_REQUIRED';

export class WorkbenchServiceInputError extends Error {
  constructor(readonly code: WorkbenchServiceInputErrorCode) {
    super(`Workbench input rejected: ${code}`);
    this.name = 'WorkbenchServiceInputError';
  }
}

export interface CreateWorkbenchServiceOptions {
  store: ProjectStore;
  pdfParser?: PdfParserPort;
  now?: () => Date;
  idFactory?: () => string;
  cryptoProvider?: Crypto;
}

export function createWorkbenchService(
  options: CreateWorkbenchServiceOptions,
): WorkbenchService {
  const cryptoProvider = options.cryptoProvider ?? globalThis.crypto;
  const now = options.now ?? (() => new Date());
  const idFactory =
    options.idFactory ??
    (() => createUuidV7(cryptoProvider, now().valueOf()));
  return new DefaultWorkbenchService(
    options.store,
    options.pdfParser ?? lazyPdfJsParser,
    now,
    idFactory,
    cryptoProvider,
  );
}

const lazyPdfJsParser: PdfParserPort = {
  async parsePdf(input) {
    const { PdfJsParser } = await import('./pdfjs-parser.js');
    return new PdfJsParser().parsePdf(input);
  },
};

class DefaultWorkbenchService implements WorkbenchService {
  constructor(
    private readonly store: ProjectStore,
    private readonly pdfParser: PdfParserPort,
    private readonly now: () => Date,
    private readonly idFactory: () => string,
    private readonly cryptoProvider: Crypto | undefined,
  ) {}

  async listProjects(): Promise<Project[]> {
    return this.store.listProjects();
  }

  async createProject(input: WorkbenchProjectFormInput): Promise<Project> {
    const timestamp = this.timestamp();
    const rubric = parseRubric(input.rubric, timestamp, this.idFactory);
    const project = parseProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: this.idFactory(),
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      title: normalizedProjectTitle(input),
      status: 'active',
      taskDefinition: {
        id: this.idFactory(),
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        taskName: input.taskName,
        audience: input.audience,
        dueAt: parseDeadline(input.deadline),
        lengthTarget: parseLengthTarget(input.scope),
        presentationDurationMinutes: parseDuration(input.durationMinutes),
        outputFormats: parseOutputFormats(input.outputFormat),
        rubric,
        tone: input.tone,
        mustInclude: parseLines(input.requiredContent),
        mustAvoid: parseLines(input.forbiddenContent),
      },
      sourceFiles: [],
      sourceChunks: [],
      evidenceCards: [],
      outlines: [],
      activeOutlineId: null,
      artifacts: [],
      verificationResults: [],
    });
    return this.store.createProject(project);
  }

  async createEvidence(
    projectId: string,
    input: WorkbenchEvidenceInput,
  ): Promise<Project> {
    const current = await this.store.getProject(projectId);
    if (current === null) {
      throw new ProjectNotFoundError(projectId);
    }
    const chunk = current.sourceChunks.find(
      (candidate) => candidate.id === input.sourceChunkId,
    );
    if (chunk === undefined) {
      throw new WorkbenchServiceInputError('SOURCE_CHUNK_NOT_FOUND');
    }
    if (input.quote.trim().length === 0) {
      throw new WorkbenchServiceInputError('SOURCE_QUOTE_MISMATCH');
    }
    const relativeStart = chunk.text.indexOf(input.quote);
    if (relativeStart < 0) {
      throw new WorkbenchServiceInputError('SOURCE_QUOTE_MISMATCH');
    }
    if (chunk.text.lastIndexOf(input.quote) !== relativeStart) {
      throw new WorkbenchServiceInputError('AMBIGUOUS_SOURCE_QUOTE');
    }
    const characterStart = chunk.characterStart + relativeStart;
    const characterEnd = characterStart + input.quote.length;
    if (
      current.evidenceCards.some(
        (evidence) =>
          evidence.sourceChunkId === chunk.id &&
          evidence.characterStart === characterStart &&
          evidence.characterEnd === characterEnd,
      )
    ) {
      throw new WorkbenchServiceInputError('DUPLICATE_EVIDENCE');
    }
    if (
      input.userConfirmed &&
      (input.kind === 'unverified' ||
        input.citation.trim().length === 0)
    ) {
      throw new WorkbenchServiceInputError(
        'EVIDENCE_CONFIRMATION_REQUIRED',
      );
    }

    const updatedAt = this.timestampAfter(current.updatedAt);
    const next = parseProject({
      ...current,
      version: current.version + 1,
      updatedAt,
      evidenceCards: [
        ...current.evidenceCards,
        {
          id: this.idFactory(),
          version: 1,
          createdAt: updatedAt,
          updatedAt,
          projectId,
          sourceFileId: chunk.sourceFileId,
          sourceChunkId: chunk.id,
          sourceFileVersion: chunk.sourceFileVersion,
          pageNumber: chunk.pageNumber,
          characterStart,
          characterEnd,
          quote: input.quote,
          kind: input.kind,
          note: input.note.trim(),
          citation: input.citation.trim(),
          status: input.userConfirmed ? 'verified' : 'selected',
          stance: input.stance,
          confirmationStatus: input.userConfirmed
            ? 'confirmed'
            : 'pending',
          userConfirmedAt: input.userConfirmed ? updatedAt : null,
        },
      ],
    });
    return this.store.saveProject(next, current.version);
  }

  async ingestSourceFile(
    projectId: string,
    file: File,
  ): Promise<SourceIngestionResult> {
    const current = await this.store.getProject(projectId);
    if (current === null) {
      throw new ProjectNotFoundError(projectId);
    }
    const upload = validateSourceUpload(file);
    const sha256 = await computeSourceFileSha256(
      file,
      this.cryptoProvider,
    );
    const existing = current.sourceFiles.find(
      (source) => source.contentSha256 === sha256,
    );
    if (
      isDuplicateSourceHash(
        sha256,
        current.sourceFiles.map((source) => ({
          sha256: source.contentSha256,
        })),
      )
    ) {
      if (existing === undefined) {
        throw new Error('duplicate source hash invariant failed');
      }
      return {
        status: 'duplicate',
        project: current,
        existingSourceFileId: existing.id,
      };
    }

    const sourceId = this.idFactory();
    const domainSource = createSourceFile({
      id: sourceId,
      upload,
      sha256,
    });
    const pendingAt = this.timestampAfter(current.updatedAt);
    const pendingSource = createProjectSourceFile({
      id: sourceId,
      projectId,
      upload,
      sha256,
      timestamp: pendingAt,
    });
    const pendingProject = await this.saveSourceState(
      current,
      pendingSource,
      pendingAt,
    );
    await this.store.putSourceBlob(projectId, sourceId, file);

    const parsingDomainSource = beginSourceParsing(domainSource);
    const parsingAt = this.timestampAfter(pendingProject.updatedAt);
    const parsingSource: ProjectSourceFile = {
      ...pendingSource,
      version: pendingSource.version + 1,
      updatedAt: parsingAt,
      status: 'parsing',
      parseProgress: 0,
    };
    const parsingProject = await this.saveSourceState(
      pendingProject,
      parsingSource,
      parsingAt,
    );
    const chunksAt = this.timestampAfter(parsingProject.updatedAt);
    let chunks: SourceChunk[];
    let pageCount: number;
    if (upload.kind === 'pdf') {
      const parsedDomainSource = await runPdfParsing(
        parsingDomainSource,
        file,
        this.pdfParser,
      );
      if (parsedDomainSource.parsing.status === 'failed') {
        return this.persistParseFailure(
          parsingProject,
          parsingSource,
          parsedDomainSource.parsing.code,
        );
      }
      if (parsedDomainSource.parsing.status !== 'parsed') {
        return this.persistParseFailure(
          parsingProject,
          parsingSource,
          'INVALID_PARSER_OUTPUT',
        );
      }
      pageCount = parsedDomainSource.parsing.pageCount;
      try {
        chunks = await this.createProjectChunks(
          parsingProject.id,
          parsingSource,
          parsedDomainSource.parsing.chunks,
          chunksAt,
        );
      } catch (error) {
        if (error instanceof WorkbenchServiceInputError) {
          return this.persistParseFailure(
            parsingProject,
            parsingSource,
            'INVALID_PARSER_OUTPUT',
          );
        }
        throw error;
      }
    } else if (upload.kind === 'docx' || upload.kind === 'pptx') {
      const {
        BrowserOfficeParserError,
        parseBrowserOfficeFile,
      } = await import('./docx-pptx-parser.js');
      try {
        const parsed = await parseBrowserOfficeFile(
          {
            file,
            source: parsingDomainSource,
            sourceFileVersion: parsingSource.sourceVersion,
          },
          this.cryptoProvider,
        );
        chunks = this.createTraceableProjectChunks(
          parsingProject.id,
          parsingSource,
          parsed.chunks,
          chunksAt,
        );
        pageCount = parsed.pageCount;
      } catch (error) {
        if (error instanceof BrowserOfficeParserError) {
          return this.persistParseFailure(
            parsingProject,
            parsingSource,
            error.code,
          );
        }
        throw error;
      }
    } else {
      try {
        const parsed = await parseBrowserSourceFile(
          {
            file,
            source: parsingDomainSource,
            sourceFileVersion: parsingSource.sourceVersion,
          },
          this.cryptoProvider,
        );
        if (parsed.status === 'ocr-required') {
          return this.persistParseFailure(
            parsingProject,
            parsingSource,
            'OCR_REQUIRED',
          );
        }
        chunks = this.createTraceableProjectChunks(
          parsingProject.id,
          parsingSource,
          parsed.chunks,
          chunksAt,
        );
        pageCount = new Set(
          parsed.chunks.map((chunk) => chunk.pageNumber),
        ).size;
      } catch (error) {
        if (error instanceof BrowserSourceParserError) {
          return this.persistParseFailure(
            parsingProject,
            parsingSource,
            error.code,
          );
        }
        throw error;
      }
    }

    const withChunks = await this.store.replaceSourceChunks(
      projectId,
      sourceId,
      chunks,
      parsingProject.version,
      chunksAt,
    );
    const readyAt = this.timestampAfter(withChunks.updatedAt);
    const readySource: ProjectSourceFile = {
      ...parsingSource,
      version: parsingSource.version + 1,
      updatedAt: readyAt,
      status: 'ready',
      parseProgress: 100,
      pageCount,
      error: null,
    };
    const readyProject = await this.saveSourceState(
      withChunks,
      readySource,
      readyAt,
    );
    return {
      status: 'ready',
      project: readyProject,
      sourceFile: findProjectSource(readyProject, sourceId),
      chunks: readyProject.sourceChunks.filter(
        (chunk) => chunk.sourceFileId === sourceId,
      ),
    };
  }

  private async persistParseFailure(
    project: Project,
    source: ProjectSourceFile,
    code: SourceIngestionFailureCode,
  ): Promise<SourceIngestionResult> {
    const failedAt = this.timestampAfter(project.updatedAt);
    const failedSource: ProjectSourceFile = {
      ...source,
      version: source.version + 1,
      updatedAt: failedAt,
      status: 'failed',
      parseProgress: 0,
      pageCount: null,
      error: {
        code,
        message: `Source parsing failed: ${code}`,
        retryable: true,
      },
    };
    const failedProject = await this.saveSourceState(
      project,
      failedSource,
      failedAt,
    );
    return {
      status: 'failed',
      project: failedProject,
      sourceFile: findProjectSource(failedProject, source.id),
      errorCode: code,
    };
  }

  private async saveSourceState(
    current: Project,
    source: ProjectSourceFile,
    updatedAt: string,
  ): Promise<Project> {
    const sourceFiles = current.sourceFiles.filter(
      (candidate) => candidate.id !== source.id,
    );
    const next = parseProject({
      ...current,
      version: current.version + 1,
      updatedAt,
      sourceFiles: [...sourceFiles, source],
    });
    return this.store.saveProject(next, current.version);
  }

  private async createProjectChunks(
    projectId: string,
    source: ProjectSourceFile,
    pages: readonly Readonly<{
      ordinal: number;
      pageNumber: number;
      text: string;
    }>[],
    timestamp: string,
  ): Promise<SourceChunk[]> {
    let characterOffset = 0;
    const chunks: SourceChunk[] = [];
    for (const page of pages) {
      if (page.text.length === 0) {
        throw new WorkbenchServiceInputError('INVALID_PARSER_OUTPUT');
      }
      const characterStart = characterOffset;
      const characterEnd = characterStart + page.text.length;
      chunks.push({
        id: this.idFactory(),
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        projectId,
        sourceFileId: source.id,
        sourceFileVersion: source.sourceVersion,
        ordinal: page.ordinal,
        pageNumber: page.pageNumber,
        pageLabel: String(page.pageNumber),
        characterStart,
        characterEnd,
        text: page.text,
        contentSha256: await this.hashText(page.text),
      });
      characterOffset = characterEnd + 1;
    }
    return chunks;
  }

  private createTraceableProjectChunks(
    projectId: string,
    source: ProjectSourceFile,
    inputs: readonly TraceableTextChunk[],
    timestamp: string,
  ): SourceChunk[] {
    return inputs.map((chunk) => ({
      id: this.idFactory(),
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      projectId,
      sourceFileId: source.id,
      sourceFileVersion: source.sourceVersion,
      ordinal: chunk.ordinal,
      pageNumber: chunk.pageNumber,
      pageLabel: chunk.pageLabel,
      characterStart: chunk.characterStart,
      characterEnd: chunk.characterEnd,
      text: chunk.text,
      contentSha256: chunk.contentSha256,
    }));
  }

  private async hashText(value: string): Promise<string> {
    if (this.cryptoProvider?.subtle === undefined) {
      throw new WorkbenchServiceInputError('WEB_CRYPTO_UNAVAILABLE');
    }
    const digest = await this.cryptoProvider.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value),
    );
    return hexadecimal(new Uint8Array(digest));
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
      throw new WorkbenchServiceInputError('INVALID_CLOCK');
    }
    return value.toISOString();
  }

  private timestampAfter(previous: string): string {
    const candidate = Date.parse(this.timestamp());
    const minimum = Date.parse(previous) + 1;
    return new Date(Math.max(candidate, minimum)).toISOString();
  }
}

function normalizedProjectTitle(input: WorkbenchProjectFormInput): string {
  return input.projectTitle === undefined ||
    input.projectTitle.trim().length === 0
    ? input.taskName
    : input.projectTitle;
}

function parseDeadline(value: string): string {
  const deadline = new Date(value);
  if (!Number.isFinite(deadline.valueOf())) {
    throw new WorkbenchServiceInputError('INVALID_DEADLINE');
  }
  return deadline.toISOString();
}

function parseLengthTarget(
  value: string,
): { unit: 'pages' | 'words'; value: number } {
  const match =
    /^\s*([1-9]\d*)\s*(页|頁|pages?|words?|字|字数)\s*$/iu.exec(value);
  if (match === null) {
    throw new WorkbenchServiceInputError('INVALID_LENGTH_TARGET');
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new WorkbenchServiceInputError('INVALID_LENGTH_TARGET');
  }
  const rawUnit = match[2]?.toLocaleLowerCase();
  return {
    unit:
      rawUnit === '页' ||
      rawUnit === '頁' ||
      rawUnit === 'page' ||
      rawUnit === 'pages'
        ? 'pages'
        : 'words',
    value: amount,
  };
}

function parseDuration(value: string): number | null {
  if (value.trim().length === 0) {
    return null;
  }
  if (!/^[1-9]\d*$/u.test(value.trim())) {
    throw new WorkbenchServiceInputError('INVALID_DURATION');
  }
  const duration = Number(value);
  if (!Number.isSafeInteger(duration) || duration > 24 * 60) {
    throw new WorkbenchServiceInputError('INVALID_DURATION');
  }
  return duration;
}

function parseOutputFormats(
  input: WorkbenchOutputFormatInput,
): OutputFormat[] {
  if (input === 'presentation') {
    return ['pptx', 'pdf'];
  }
  if (input === 'report') {
    return ['pdf'];
  }
  if (input === 'document') {
    return ['docx'];
  }
  const formats: readonly OutputFormat[] = [
    'pptx',
    'pdf',
    'docx',
    'markdown',
    'script',
    'source-index',
    'task-card',
    'verification-record',
    'project-package',
  ];
  if (!formats.includes(input as OutputFormat)) {
    throw new WorkbenchServiceInputError('UNSUPPORTED_OUTPUT_FORMAT');
  }
  return [input as OutputFormat];
}

function parseRubric(
  inputs: readonly WorkbenchRubricFormInput[],
  timestamp: string,
  idFactory: () => string,
): RubricCriterion[] {
  if (inputs.length === 0) {
    throw new WorkbenchServiceInputError('INVALID_RUBRIC_WEIGHT');
  }
  const rubric = inputs.map((input) => {
    const rawWeight =
      typeof input.weightPercent === 'number'
        ? String(input.weightPercent)
        : input.weightPercent.trim();
    if (!/^[1-9]\d*$/u.test(rawWeight)) {
      throw new WorkbenchServiceInputError('INVALID_RUBRIC_WEIGHT');
    }
    const weightPercent = Number(rawWeight);
    if (
      !Number.isSafeInteger(weightPercent) ||
      weightPercent < 1 ||
      weightPercent > 100
    ) {
      throw new WorkbenchServiceInputError('INVALID_RUBRIC_WEIGHT');
    }
    return {
      id: idFactory(),
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      title: input.title,
      description: input.description,
      weightPercent,
    };
  });
  if (
    rubric.reduce((total, criterion) => total + criterion.weightPercent, 0) !==
    100
  ) {
    throw new WorkbenchServiceInputError('INVALID_RUBRIC_WEIGHT');
  }
  return rubric;
}

function parseLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function createProjectSourceFile(input: {
  id: string;
  projectId: string;
  upload: ValidatedSourceUpload;
  sha256: string;
  timestamp: string;
}): ProjectSourceFile {
  return {
    id: input.id,
    version: 1,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    projectId: input.projectId,
    fileName: input.upload.name,
    mediaType: input.upload.mimeType,
    extension: input.upload.extension.slice(1),
    sizeBytes: input.upload.sizeBytes,
    contentSha256: input.sha256,
    blobId: `source-file:${input.id}`,
    sourceVersion: 1,
    status: 'pending',
    parseProgress: 0,
    pageCount: null,
    error: null,
    replacedByFileId: null,
  };
}

function findProjectSource(
  project: Project,
  sourceId: string,
): ProjectSourceFile {
  const source = project.sourceFiles.find(
    (candidate) => candidate.id === sourceId,
  );
  if (source === undefined) {
    throw new Error('persisted source file invariant failed');
  }
  return source;
}

function createUuidV7(
  cryptoProvider: Crypto | undefined,
  timestamp: number,
): string {
  if (
    cryptoProvider === undefined ||
    typeof cryptoProvider.getRandomValues !== 'function'
  ) {
    throw new WorkbenchServiceInputError('WEB_CRYPTO_UNAVAILABLE');
  }
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new WorkbenchServiceInputError('INVALID_CLOCK');
  }
  const bytes = cryptoProvider.getRandomValues(new Uint8Array(16));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = hexadecimal(bytes);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function hexadecimal(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

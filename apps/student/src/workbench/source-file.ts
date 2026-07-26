export const MAX_SOURCE_FILE_BYTES = 50 * 1_024 * 1_024;

const MAX_SOURCE_FILE_NAME_LENGTH = 255;
const MAX_SOURCE_ID_LENGTH = 128;
const MAX_PDF_PAGE_COUNT = 10_000;
const MAX_PDF_PAGE_TEXT_LENGTH = 2 * 1_024 * 1_024;

export type SourceFileKind =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'text'
  | 'markdown'
  | 'image';

export type SourceFileValidationErrorCode =
  | 'UNSAFE_FILE_NAME'
  | 'UNSUPPORTED_EXTENSION'
  | 'MIME_EXTENSION_MISMATCH'
  | 'INVALID_FILE_SIZE'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE';

export class SourceFileValidationError extends Error {
  constructor(readonly code: SourceFileValidationErrorCode) {
    super(`Source upload rejected: ${code}`);
    this.name = 'SourceFileValidationError';
  }
}

export type SourceFileDomainErrorCode =
  | 'INVALID_SHA256'
  | 'INVALID_SOURCE_ID'
  | 'INVALID_PARSE_TRANSITION'
  | 'PDF_SOURCE_REQUIRED'
  | 'SOURCE_FILE_MISMATCH'
  | 'PARSER_PORT_REQUIRED'
  | 'WEB_CRYPTO_UNAVAILABLE';

export class SourceFileDomainError extends Error {
  constructor(readonly code: SourceFileDomainErrorCode) {
    super(`Source file operation rejected: ${code}`);
    this.name = 'SourceFileDomainError';
  }
}

export type SourceParserFailureCode =
  | 'PARSER_UNAVAILABLE'
  | 'ENCRYPTED_PDF'
  | 'CORRUPT_PDF'
  | 'OCR_REQUIRED'
  | 'PARSER_FAILED';

export class SourceParserPortError extends Error {
  constructor(
    readonly code: Exclude<
      SourceParserFailureCode,
      'PARSER_FAILED'
    >,
  ) {
    super('The source parser could not parse the document');
    this.name = 'SourceParserPortError';
  }
}

type SourceFormat = Readonly<{
  kind: SourceFileKind;
  mimeTypes: ReadonlySet<string>;
}>;

const SOURCE_FORMATS: Readonly<Record<string, SourceFormat>> = {
  '.pdf': {
    kind: 'pdf',
    mimeTypes: new Set(['application/pdf']),
  },
  '.docx': {
    kind: 'docx',
    mimeTypes: new Set([
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]),
  },
  '.pptx': {
    kind: 'pptx',
    mimeTypes: new Set([
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ]),
  },
  '.txt': {
    kind: 'text',
    mimeTypes: new Set(['text/plain']),
  },
  '.md': {
    kind: 'markdown',
    mimeTypes: new Set([
      'text/markdown',
      'text/x-markdown',
      'text/plain',
    ]),
  },
  '.markdown': {
    kind: 'markdown',
    mimeTypes: new Set([
      'text/markdown',
      'text/x-markdown',
      'text/plain',
    ]),
  },
  '.png': {
    kind: 'image',
    mimeTypes: new Set(['image/png']),
  },
  '.jpg': {
    kind: 'image',
    mimeTypes: new Set(['image/jpeg']),
  },
  '.jpeg': {
    kind: 'image',
    mimeTypes: new Set(['image/jpeg']),
  },
  '.webp': {
    kind: 'image',
    mimeTypes: new Set(['image/webp']),
  },
  '.gif': {
    kind: 'image',
    mimeTypes: new Set(['image/gif']),
  },
  '.avif': {
    kind: 'image',
    mimeTypes: new Set(['image/avif']),
  },
};

const DANGEROUS_SECONDARY_EXTENSIONS = new Set([
  'app',
  'bat',
  'cmd',
  'com',
  'cpl',
  'exe',
  'html',
  'hta',
  'jar',
  'js',
  'lnk',
  'msi',
  'php',
  'ps1',
  'scr',
  'sh',
  'svg',
  'vbs',
]);

const WINDOWS_RESERVED_NAMES =
  /^(?:aux|clock\$|con|nul|prn|com[1-9]|lpt[1-9])$/iu;

export type ValidatedSourceUpload = Readonly<{
  name: string;
  sizeBytes: number;
  mimeType: string;
  extension: string;
  kind: SourceFileKind;
}>;

export function validateSourceUpload(
  file: Pick<File, 'name' | 'size' | 'type'>,
): ValidatedSourceUpload {
  assertSafeFileName(file.name);
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw new SourceFileValidationError('INVALID_FILE_SIZE');
  }
  if (file.size === 0) {
    throw new SourceFileValidationError('EMPTY_FILE');
  }
  if (file.size > MAX_SOURCE_FILE_BYTES) {
    throw new SourceFileValidationError('FILE_TOO_LARGE');
  }

  const extension = file.name
    .slice(file.name.lastIndexOf('.'))
    .toLowerCase();
  const format = SOURCE_FORMATS[extension];
  if (format === undefined) {
    throw new SourceFileValidationError('UNSUPPORTED_EXTENSION');
  }
  const mimeType = file.type
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (mimeType === undefined || !format.mimeTypes.has(mimeType)) {
    throw new SourceFileValidationError('MIME_EXTENSION_MISMATCH');
  }

  return Object.freeze({
    name: file.name,
    sizeBytes: file.size,
    mimeType,
    extension,
    kind: format.kind,
  });
}

function assertSafeFileName(name: string): void {
  if (
    name.length === 0 ||
    name.length > MAX_SOURCE_FILE_NAME_LENGTH ||
    name !== name.trim() ||
    name.includes('/') ||
    name.includes('\\') ||
    hasUnsafeFileNameCharacter(name)
  ) {
    throw new SourceFileValidationError('UNSAFE_FILE_NAME');
  }

  const extensionIndex = name.lastIndexOf('.');
  if (extensionIndex <= 0) {
    if (extensionIndex === 0) {
      throw new SourceFileValidationError('UNSAFE_FILE_NAME');
    }
    return;
  }
  const stem = name.slice(0, extensionIndex);
  if (
    stem.endsWith('.') ||
    stem.endsWith(' ') ||
    WINDOWS_RESERVED_NAMES.test(stem.split('.', 1)[0] ?? '') ||
    stem
      .split('.')
      .some((part) =>
        DANGEROUS_SECONDARY_EXTENSIONS.has(part.toLowerCase()),
      )
  ) {
    throw new SourceFileValidationError('UNSAFE_FILE_NAME');
  }
}

function hasUnsafeFileNameCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      '<>:"|?*'.includes(character)
    ) {
      return true;
    }
  }
  return false;
}

export async function computeSourceFileSha256(
  file: File,
  cryptoProvider: Pick<Crypto, 'subtle'> | undefined = globalThis.crypto,
): Promise<string> {
  validateSourceUpload(file);
  if (cryptoProvider?.subtle === undefined) {
    throw new SourceFileDomainError('WEB_CRYPTO_UNAVAILABLE');
  }
  const digest = await cryptoProvider.subtle.digest(
    'SHA-256',
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function isDuplicateSourceHash(
  sha256: string,
  existingSources: readonly Readonly<{ sha256: string }>[],
): boolean {
  assertSha256(sha256);
  return existingSources.some((source) => {
    assertSha256(source.sha256);
    return source.sha256 === sha256;
  });
}

export type PdfPageSourceChunk = Readonly<{
  kind: 'pdf-page';
  sourceFileId: string;
  ordinal: number;
  pageNumber: number;
  text: string;
}>;

export type SourceChunk = PdfPageSourceChunk;

export type SourceParsingState =
  | Readonly<{ status: 'pending'; attempt: 0 }>
  | Readonly<{ status: 'parsing'; attempt: number }>
  | Readonly<{
      status: 'parsed';
      attempt: number;
      pageCount: number;
      chunks: readonly SourceChunk[];
    }>
  | Readonly<{
      status: 'failed';
      attempt: number;
      code: SourceParserFailureCode | 'INVALID_PARSER_OUTPUT';
      retryable: true;
      replaceable: true;
    }>
  | Readonly<{
      status: 'replaced';
      attempt: number;
      replacementSourceId: string;
    }>;

export type SourceFile = Readonly<{
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  extension: string;
  kind: SourceFileKind;
  sha256: string;
  parsing: SourceParsingState;
}>;

export function createSourceFile(input: Readonly<{
  id: string;
  upload: ValidatedSourceUpload;
  sha256: string;
}>): SourceFile {
  assertSourceId(input.id);
  assertSha256(input.sha256);
  const validated = validateSourceUpload({
    name: input.upload.name,
    size: input.upload.sizeBytes,
    type: input.upload.mimeType,
  });
  if (
    validated.extension !== input.upload.extension ||
    validated.kind !== input.upload.kind
  ) {
    throw new SourceFileDomainError('SOURCE_FILE_MISMATCH');
  }
  return Object.freeze({
    id: input.id,
    name: validated.name,
    sizeBytes: validated.sizeBytes,
    mimeType: validated.mimeType,
    extension: validated.extension,
    kind: validated.kind,
    sha256: input.sha256,
    parsing: Object.freeze({ status: 'pending', attempt: 0 }),
  });
}

export function beginSourceParsing(source: SourceFile): SourceFile {
  if (source.parsing.status !== 'pending') {
    throw new SourceFileDomainError('INVALID_PARSE_TRANSITION');
  }
  return withParsing(source, {
    status: 'parsing',
    attempt: 1,
  });
}

export function retrySourceParsing(source: SourceFile): SourceFile {
  if (source.parsing.status !== 'failed') {
    throw new SourceFileDomainError('INVALID_PARSE_TRANSITION');
  }
  return withParsing(source, {
    status: 'parsing',
    attempt: source.parsing.attempt + 1,
  });
}

export function replaceFailedSource(
  source: SourceFile,
  replacementSourceId: string,
): SourceFile {
  if (source.parsing.status !== 'failed') {
    throw new SourceFileDomainError('INVALID_PARSE_TRANSITION');
  }
  assertSourceId(replacementSourceId);
  if (replacementSourceId === source.id) {
    throw new SourceFileDomainError('INVALID_SOURCE_ID');
  }
  return withParsing(source, {
    status: 'replaced',
    attempt: source.parsing.attempt,
    replacementSourceId,
  });
}

export type PdfParserPage = Readonly<{
  pageNumber: number;
  text: string;
}>;

export type PdfParserResult = Readonly<{
  pageCount: number;
  pages: readonly PdfParserPage[];
}>;

export interface PdfParserPort {
  /**
   * A real adapter (for example pdf.js) must supply page text and page numbers.
   * This domain module never decodes a PDF or invents parser output.
   */
  parsePdf(input: Readonly<{
    file: File;
    source: SourceFile;
  }>): Promise<PdfParserResult>;
}

export async function runPdfParsing(
  source: SourceFile,
  file: File,
  parser: PdfParserPort,
): Promise<SourceFile> {
  if (source.parsing.status !== 'parsing') {
    throw new SourceFileDomainError('INVALID_PARSE_TRANSITION');
  }
  if (source.kind !== 'pdf') {
    throw new SourceFileDomainError('PDF_SOURCE_REQUIRED');
  }
  if (parser === null || typeof parser?.parsePdf !== 'function') {
    throw new SourceFileDomainError('PARSER_PORT_REQUIRED');
  }
  assertMatchingSourceFile(source, file);

  try {
    const result: unknown = await parser.parsePdf({ file, source });
    const chunks = parsePdfChunks(source.id, result);
    return withParsing(source, {
      status: 'parsed',
      attempt: source.parsing.attempt,
      pageCount: chunks.length,
      chunks,
    });
  } catch (error) {
    const code =
      error instanceof InvalidParserOutputError
        ? 'INVALID_PARSER_OUTPUT'
        : error instanceof SourceParserPortError
          ? error.code
          : 'PARSER_FAILED';
    return withParsing(source, {
      status: 'failed',
      attempt: source.parsing.attempt,
      code,
      retryable: true,
      replaceable: true,
    });
  }
}

function assertMatchingSourceFile(source: SourceFile, file: File): void {
  const upload = validateSourceUpload(file);
  if (
    upload.name !== source.name ||
    upload.sizeBytes !== source.sizeBytes ||
    upload.mimeType !== source.mimeType ||
    upload.extension !== source.extension ||
    upload.kind !== source.kind
  ) {
    throw new SourceFileDomainError('SOURCE_FILE_MISMATCH');
  }
}

function parsePdfChunks(
  sourceFileId: string,
  result: unknown,
): readonly SourceChunk[] {
  if (
    !isRecord(result) ||
    !Number.isSafeInteger(result.pageCount) ||
    (result.pageCount as number) < 1 ||
    (result.pageCount as number) > MAX_PDF_PAGE_COUNT ||
    !Array.isArray(result.pages) ||
    result.pages.length !== result.pageCount
  ) {
    throw new InvalidParserOutputError();
  }
  const chunks = result.pages.map((page, index): SourceChunk => {
    if (
      !isRecord(page) ||
      page.pageNumber !== index + 1 ||
      typeof page.text !== 'string' ||
      page.text.length > MAX_PDF_PAGE_TEXT_LENGTH
    ) {
      throw new InvalidParserOutputError();
    }
    return Object.freeze({
      kind: 'pdf-page',
      sourceFileId,
      ordinal: index,
      pageNumber: page.pageNumber,
      text: page.text,
    });
  });
  return Object.freeze(chunks);
}

function withParsing(
  source: SourceFile,
  parsing: SourceParsingState,
): SourceFile {
  return Object.freeze({
    ...source,
    parsing: Object.freeze(parsing),
  });
}

function assertSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new SourceFileDomainError('INVALID_SHA256');
  }
}

function assertSourceId(value: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_SOURCE_ID_LENGTH ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw new SourceFileDomainError('INVALID_SOURCE_ID');
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    );
  });
}

class InvalidParserOutputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

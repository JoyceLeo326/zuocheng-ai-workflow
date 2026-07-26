import {
  validateSourceUpload,
  type SourceFile as UploadSourceFile,
} from './source-file.js';
import type { SourceChunk as ProjectSourceChunk } from './project-model.js';

export const TEXT_CHUNK_MAX_CHARACTERS = 16_000;

export type BrowserTextEncoding =
  | 'utf-8'
  | 'utf-16le'
  | 'utf-16be'
  | 'gb18030';

export type TraceableTextChunk = Readonly<
  Pick<
    ProjectSourceChunk,
    | 'sourceFileId'
    | 'sourceFileVersion'
    | 'ordinal'
    | 'pageNumber'
    | 'pageLabel'
    | 'characterStart'
    | 'characterEnd'
    | 'text'
    | 'contentSha256'
  >
>;

export type ImagePreviewMetadata = Readonly<{
  sourceFileId: string;
  fileName: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  contentSha256: string;
  widthPixels: number | null;
  heightPixels: number | null;
}>;

export type ParsedBrowserTextSource = Readonly<{
  status: 'parsed';
  kind: 'text' | 'markdown';
  encoding: BrowserTextEncoding;
  characterOffsetUnit: 'utf-16-code-unit';
  chunks: readonly TraceableTextChunk[];
}>;

export type BrowserImageOcrRequired = Readonly<{
  status: 'ocr-required';
  code: 'OCR_REQUIRED';
  kind: 'image';
  chunks: readonly [];
  preview: ImagePreviewMetadata;
}>;

export type BrowserSourceParseResult =
  | ParsedBrowserTextSource
  | BrowserImageOcrRequired;

export type BrowserSourceParserErrorCode =
  | 'INVALID_SOURCE_FILE_VERSION'
  | 'SOURCE_FILE_MISMATCH'
  | 'SOURCE_CONTENT_MISMATCH'
  | 'UNSUPPORTED_SOURCE_KIND'
  | 'UNSUPPORTED_TEXT_ENCODING'
  | 'EMPTY_TEXT'
  | 'WEB_CRYPTO_UNAVAILABLE';

export class BrowserSourceParserError extends Error {
  constructor(readonly code: BrowserSourceParserErrorCode) {
    super(`Browser source parsing failed: ${code}`);
    this.name = 'BrowserSourceParserError';
  }
}

export async function parseBrowserSourceFile(
  input: Readonly<{
    file: File;
    source: UploadSourceFile;
    sourceFileVersion: number;
  }>,
  cryptoProvider: Pick<Crypto, 'subtle'> | undefined = globalThis.crypto,
): Promise<BrowserSourceParseResult> {
  if (
    !Number.isSafeInteger(input.sourceFileVersion) ||
    input.sourceFileVersion < 1
  ) {
    throw new BrowserSourceParserError('INVALID_SOURCE_FILE_VERSION');
  }
  assertMatchingSource(input.file, input.source);
  if (
    input.source.kind !== 'text' &&
    input.source.kind !== 'markdown' &&
    input.source.kind !== 'image'
  ) {
    throw new BrowserSourceParserError('UNSUPPORTED_SOURCE_KIND');
  }
  if (cryptoProvider?.subtle === undefined) {
    throw new BrowserSourceParserError('WEB_CRYPTO_UNAVAILABLE');
  }

  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const contentSha256 = await sha256Hex(bytes, cryptoProvider.subtle);
  if (contentSha256 !== input.source.sha256) {
    throw new BrowserSourceParserError('SOURCE_CONTENT_MISMATCH');
  }

  if (input.source.kind === 'image') {
    const dimensions = readImageDimensions(bytes, input.source.mimeType);
    return Object.freeze({
      status: 'ocr-required',
      code: 'OCR_REQUIRED',
      kind: 'image',
      chunks: Object.freeze([]) as readonly [],
      preview: Object.freeze({
        sourceFileId: input.source.id,
        fileName: input.source.name,
        mimeType: input.source.mimeType,
        extension: input.source.extension,
        sizeBytes: input.source.sizeBytes,
        contentSha256,
        widthPixels: dimensions?.width ?? null,
        heightPixels: dimensions?.height ?? null,
      }),
    });
  }

  const decoded = decodeText(bytes);
  if (decoded === undefined || !isPlausibleText(decoded.text)) {
    throw new BrowserSourceParserError('UNSUPPORTED_TEXT_ENCODING');
  }
  const chunks = await createTraceableChunks(
    decoded.text,
    input.source.id,
    input.sourceFileVersion,
    cryptoProvider.subtle,
  );
  if (chunks.length === 0) {
    throw new BrowserSourceParserError('EMPTY_TEXT');
  }
  return Object.freeze({
    status: 'parsed',
    kind: input.source.kind,
    encoding: decoded.encoding,
    characterOffsetUnit: 'utf-16-code-unit',
    chunks,
  });
}

function assertMatchingSource(file: File, source: UploadSourceFile): void {
  const upload = validateSourceUpload(file);
  if (
    upload.name !== source.name ||
    upload.sizeBytes !== source.sizeBytes ||
    upload.mimeType !== source.mimeType ||
    upload.extension !== source.extension ||
    upload.kind !== source.kind
  ) {
    throw new BrowserSourceParserError('SOURCE_FILE_MISMATCH');
  }
}

type DecodedText = Readonly<{
  encoding: BrowserTextEncoding;
  text: string;
}>;

function decodeText(bytes: Uint8Array): DecodedText | undefined {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    return decodeWith('utf-8', bytes.subarray(3));
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return decodeWith('utf-16le', bytes.subarray(2));
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return decodeWith('utf-16be', bytes.subarray(2));
  }

  const utf16Endianness = inferUtf16Endianness(bytes);
  if (utf16Endianness !== undefined) {
    const decoded = decodeWith(utf16Endianness, bytes);
    if (decoded !== undefined) {
      return decoded;
    }
  }
  return decodeWith('utf-8', bytes) ?? decodeWith('gb18030', bytes);
}

function decodeWith(
  encoding: BrowserTextEncoding,
  bytes: Uint8Array,
): DecodedText | undefined {
  try {
    return Object.freeze({
      encoding,
      text: new TextDecoder(encoding, {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes),
    });
  } catch {
    return undefined;
  }
}

function inferUtf16Endianness(
  bytes: Uint8Array,
): 'utf-16le' | 'utf-16be' | undefined {
  if (bytes.length < 4 || bytes.length % 2 !== 0) {
    return undefined;
  }
  const pairs = Math.min(bytes.length / 2, 256);
  let evenZeros = 0;
  let oddZeros = 0;
  for (let pair = 0; pair < pairs; pair += 1) {
    evenZeros += bytes[pair * 2] === 0 ? 1 : 0;
    oddZeros += bytes[pair * 2 + 1] === 0 ? 1 : 0;
  }
  const likelyZeroCount = Math.max(2, Math.ceil(pairs * 0.3));
  const unlikelyZeroCount = Math.floor(pairs * 0.1);
  if (oddZeros >= likelyZeroCount && evenZeros <= unlikelyZeroCount) {
    return 'utf-16le';
  }
  if (evenZeros >= likelyZeroCount && oddZeros <= unlikelyZeroCount) {
    return 'utf-16be';
  }
  return undefined;
}

function isPlausibleText(text: string): boolean {
  if (text.includes('\u0000')) {
    return false;
  }
  let disallowedControls = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint < 0x20 &&
        codePoint !== 0x09 &&
        codePoint !== 0x0a &&
        codePoint !== 0x0d) ||
        (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      disallowedControls += 1;
    }
  }
  return disallowedControls <= Math.max(1, Math.floor(text.length * 0.01));
}

async function createTraceableChunks(
  text: string,
  sourceFileId: string,
  sourceFileVersion: number,
  subtle: SubtleCrypto,
): Promise<readonly TraceableTextChunk[]> {
  const ranges: Array<Readonly<{ start: number; end: number }>> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const segmentEnd = findSegmentEnd(text, cursor);
    const segment = text.slice(cursor, segmentEnd);
    const leadingLength = segment.length - segment.trimStart().length;
    const trailingLength = segment.length - segment.trimEnd().length;
    const start = cursor + leadingLength;
    const end = segmentEnd - trailingLength;
    if (end > start) {
      ranges.push(Object.freeze({ start, end }));
    }
    cursor = segmentEnd;
  }

  const chunks = await Promise.all(
    ranges.map(async (range, ordinal): Promise<TraceableTextChunk> => {
      const chunkText = text.slice(range.start, range.end);
      return Object.freeze({
        sourceFileId,
        sourceFileVersion,
        ordinal,
        pageNumber: 1,
        pageLabel: '1',
        characterStart: range.start,
        characterEnd: range.end,
        text: chunkText,
        contentSha256: await sha256Hex(
          new TextEncoder().encode(chunkText),
          subtle,
        ),
      });
    }),
  );
  return Object.freeze(chunks);
}

function findSegmentEnd(text: string, start: number): number {
  const hardEnd = Math.min(
    start + TEXT_CHUNK_MAX_CHARACTERS,
    text.length,
  );
  if (hardEnd === text.length) {
    return hardEnd;
  }
  let safeEnd = avoidBrokenSurrogatePair(text, hardEnd);
  const preferredMinimum =
    start + Math.floor(TEXT_CHUNK_MAX_CHARACTERS / 2);
  const newlineIndex = text.lastIndexOf('\n', safeEnd - 1);
  if (newlineIndex >= preferredMinimum) {
    safeEnd = newlineIndex + 1;
  }
  return safeEnd > start ? safeEnd : hardEnd;
}

function avoidBrokenSurrogatePair(text: string, boundary: number): number {
  const previous = text.charCodeAt(boundary - 1);
  const current = text.charCodeAt(boundary);
  return previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
    ? boundary - 1
    : boundary;
}

async function sha256Hex(
  bytes: Uint8Array,
  subtle: SubtleCrypto,
): Promise<string> {
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  const digest = await subtle.digest('SHA-256', ownedBytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function startsWith(
  bytes: Uint8Array,
  expected: readonly number[],
): boolean {
  return expected.every((byte, index) => bytes[index] === byte);
}

type ImageDimensions = Readonly<{ width: number; height: number }>;

function readImageDimensions(
  bytes: Uint8Array,
  mimeType: string,
): ImageDimensions | undefined {
  if (
    mimeType === 'image/png' &&
    bytes.length >= 24 &&
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    return validDimensions(
      view.getUint32(16, false),
      view.getUint32(20, false),
    );
  }
  if (
    mimeType === 'image/gif' &&
    bytes.length >= 10 &&
    (ascii(bytes, 0, 6) === 'GIF87a' ||
      ascii(bytes, 0, 6) === 'GIF89a')
  ) {
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    return validDimensions(
      view.getUint16(6, true),
      view.getUint16(8, true),
    );
  }
  if (mimeType === 'image/jpeg') {
    return readJpegDimensions(bytes);
  }
  return undefined;
}

function readJpegDimensions(
  bytes: Uint8Array,
): ImageDimensions | undefined {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8
  ) {
    return undefined;
  }
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === undefined) {
      return undefined;
    }
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const segmentLength = (bytes[offset + 2] ?? 0) * 256 +
      (bytes[offset + 3] ?? 0);
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) {
      return undefined;
    }
    if (isJpegStartOfFrame(marker)) {
      return validDimensions(
        (bytes[offset + 7] ?? 0) * 256 + (bytes[offset + 8] ?? 0),
        (bytes[offset + 5] ?? 0) * 256 + (bytes[offset + 6] ?? 0),
      );
    }
    offset += 2 + segmentLength;
  }
  return undefined;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function validDimensions(
  width: number,
  height: number,
): ImageDimensions | undefined {
  return width > 0 && height > 0
    ? Object.freeze({ width, height })
    : undefined;
}

function ascii(
  bytes: Uint8Array,
  start: number,
  length: number,
): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

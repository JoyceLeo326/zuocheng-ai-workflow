import { unzipSync, type Unzipped } from 'fflate';
import {
  validateSourceUpload,
  type SourceFile as UploadSourceFile,
} from './source-file.js';
import type { SourceChunk as ProjectSourceChunk } from './project-model.js';

const MAX_SELECTED_XML_ENTRY_BYTES = 16 * 1_024 * 1_024;
const MAX_SELECTED_XML_TOTAL_BYTES = 32 * 1_024 * 1_024;
const MAX_CHUNK_CHARACTERS = 1_000_000;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const OLE_COMPOUND_FILE_SIGNATURE = [
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
] as const;
const DOCX_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const PPTX_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';

export type TraceableOfficeChunk = Readonly<
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

export type ParsedBrowserOfficeFile = Readonly<{
  status: 'parsed';
  kind: 'docx' | 'pptx';
  pageCount: number;
  characterOffsetUnit: 'utf-16-code-unit';
  chunks: readonly TraceableOfficeChunk[];
}>;

export type BrowserOfficeParserErrorCode =
  | 'INVALID_SOURCE_FILE_VERSION'
  | 'SOURCE_FILE_MISMATCH'
  | 'SOURCE_CONTENT_MISMATCH'
  | 'UNSUPPORTED_SOURCE_KIND'
  | 'ENCRYPTED_OOXML'
  | 'CORRUPT_OOXML'
  | 'EMPTY_OOXML_TEXT'
  | 'WEB_CRYPTO_UNAVAILABLE';

export class BrowserOfficeParserError extends Error {
  constructor(readonly code: BrowserOfficeParserErrorCode) {
    super(`Browser OOXML parsing failed: ${code}`);
    this.name = 'BrowserOfficeParserError';
  }
}

export async function parseBrowserOfficeFile(
  input: Readonly<{
    file: File;
    source: UploadSourceFile;
    sourceFileVersion: number;
  }>,
  cryptoProvider: Pick<Crypto, 'subtle'> | undefined = globalThis.crypto,
): Promise<ParsedBrowserOfficeFile> {
  if (
    !Number.isSafeInteger(input.sourceFileVersion) ||
    input.sourceFileVersion < 1
  ) {
    throw new BrowserOfficeParserError('INVALID_SOURCE_FILE_VERSION');
  }
  assertMatchingSource(input.file, input.source);
  if (input.source.kind !== 'docx' && input.source.kind !== 'pptx') {
    throw new BrowserOfficeParserError('UNSUPPORTED_SOURCE_KIND');
  }
  if (cryptoProvider?.subtle === undefined) {
    throw new BrowserOfficeParserError('WEB_CRYPTO_UNAVAILABLE');
  }

  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const fileSha256 = await sha256Hex(bytes, cryptoProvider.subtle);
  if (fileSha256 !== input.source.sha256) {
    throw new BrowserOfficeParserError('SOURCE_CONTENT_MISMATCH');
  }
  if (startsWith(bytes, OLE_COMPOUND_FILE_SIGNATURE)) {
    throw new BrowserOfficeParserError('ENCRYPTED_OOXML');
  }
  if (zipHasEncryptedEntry(bytes)) {
    throw new BrowserOfficeParserError('ENCRYPTED_OOXML');
  }

  const archive = extractRequiredParts(bytes, input.source.kind);
  const blocks =
    input.source.kind === 'docx'
      ? extractDocxBlocks(archive)
      : extractPptxBlocks(archive);
  if (blocks.length === 0) {
    throw new BrowserOfficeParserError('EMPTY_OOXML_TEXT');
  }
  const chunks = await createTraceableChunks(
    blocks,
    input.source.id,
    input.sourceFileVersion,
    cryptoProvider.subtle,
  );
  return Object.freeze({
    status: 'parsed',
    kind: input.source.kind,
    pageCount:
      input.source.kind === 'docx'
        ? 1
        : countPptxSlides(archive),
    characterOffsetUnit: 'utf-16-code-unit',
    chunks,
  });
}

function assertMatchingSource(
  file: File,
  source: UploadSourceFile,
): void {
  const upload = validateSourceUpload(file);
  if (
    upload.name !== source.name ||
    upload.sizeBytes !== source.sizeBytes ||
    upload.mimeType !== source.mimeType ||
    upload.extension !== source.extension ||
    upload.kind !== source.kind
  ) {
    throw new BrowserOfficeParserError('SOURCE_FILE_MISMATCH');
  }
}

function extractRequiredParts(
  bytes: Uint8Array,
  kind: 'docx' | 'pptx',
): Unzipped {
  let selectedTotalBytes = 0;
  let archive: Unzipped;
  try {
    archive = unzipSync(bytes, {
      filter: (entry) => {
        if (!isRequiredPart(entry.name, kind)) {
          return false;
        }
        if (
          entry.originalSize < 0 ||
          entry.originalSize > MAX_SELECTED_XML_ENTRY_BYTES
        ) {
          throw new BrowserOfficeParserError('CORRUPT_OOXML');
        }
        selectedTotalBytes += entry.originalSize;
        if (selectedTotalBytes > MAX_SELECTED_XML_TOTAL_BYTES) {
          throw new BrowserOfficeParserError('CORRUPT_OOXML');
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof BrowserOfficeParserError) {
      throw error;
    }
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }

  const extractedTotalBytes = Object.values(archive).reduce(
    (total, entry) => total + entry.byteLength,
    0,
  );
  if (extractedTotalBytes > MAX_SELECTED_XML_TOTAL_BYTES) {
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }
  for (const entry of Object.values(archive)) {
    if (entry.byteLength > MAX_SELECTED_XML_ENTRY_BYTES) {
      throw new BrowserOfficeParserError('CORRUPT_OOXML');
    }
  }
  return archive;
}

function isRequiredPart(
  path: string,
  kind: 'docx' | 'pptx',
): boolean {
  if (path === '[Content_Types].xml') {
    return true;
  }
  if (kind === 'docx') {
    return path === 'word/document.xml';
  }
  return (
    path === 'ppt/presentation.xml' ||
    /^ppt\/slides\/slide[1-9][0-9]*\.xml$/u.test(path)
  );
}

type ExtractedBlock = Readonly<{
  pageNumber: number;
  pageLabel: string;
  text: string;
}>;

function extractDocxBlocks(archive: Unzipped): readonly ExtractedBlock[] {
  const contentTypes = requiredXmlPart(
    archive,
    '[Content_Types].xml',
  );
  if (!contentTypes.includes(DOCX_MAIN_CONTENT_TYPE)) {
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }
  const documentXml = requiredXmlPart(archive, 'word/document.xml');
  return Object.freeze(
    extractParagraphs(documentXml, 'w').map((text) =>
      Object.freeze({
        pageNumber: 1,
        pageLabel: 'Document',
        text,
      }),
    ),
  );
}

function extractPptxBlocks(archive: Unzipped): readonly ExtractedBlock[] {
  const contentTypes = requiredXmlPart(
    archive,
    '[Content_Types].xml',
  );
  if (!contentTypes.includes(PPTX_MAIN_CONTENT_TYPE)) {
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }
  requiredXmlPart(archive, 'ppt/presentation.xml');
  const slides = pptxSlides(archive);
  if (slides.length === 0) {
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }
  const blocks: ExtractedBlock[] = [];
  for (const slide of slides) {
    for (const text of extractParagraphs(
      requiredXmlPart(archive, slide.path),
      'a',
    )) {
      blocks.push(
        Object.freeze({
          pageNumber: slide.number,
          pageLabel: `Slide ${slide.number}`,
          text,
        }),
      );
    }
  }
  return Object.freeze(blocks);
}

type PptxSlide = Readonly<{ number: number; path: string }>;

function pptxSlides(archive: Unzipped): readonly PptxSlide[] {
  const slides: PptxSlide[] = [];
  for (const path of Object.keys(archive)) {
    const match = /^ppt\/slides\/slide([1-9][0-9]*)\.xml$/u.exec(path);
    if (match === null) {
      continue;
    }
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number)) {
      throw new BrowserOfficeParserError('CORRUPT_OOXML');
    }
    slides.push(Object.freeze({ number, path }));
  }
  slides.sort((left, right) => left.number - right.number);
  if (
    slides.some(
      (slide, index) =>
        index > 0 && slide.number === slides[index - 1]?.number,
    )
  ) {
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }
  return Object.freeze(slides);
}

function countPptxSlides(archive: Unzipped): number {
  return pptxSlides(archive).length;
}

function requiredXmlPart(archive: Unzipped, path: string): string {
  const bytes = archive[path];
  if (bytes === undefined) {
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }
  return decodeXml(bytes);
}

function decodeXml(bytes: Uint8Array): string {
  let encoding: 'utf-8' | 'utf-16le' | 'utf-16be' = 'utf-8';
  let content = bytes;
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    content = bytes.subarray(3);
  } else if (startsWith(bytes, [0xff, 0xfe])) {
    encoding = 'utf-16le';
    content = bytes.subarray(2);
  } else if (startsWith(bytes, [0xfe, 0xff])) {
    encoding = 'utf-16be';
    content = bytes.subarray(2);
  } else if (bytes[0] === 0x3c && bytes[1] === 0x00) {
    encoding = 'utf-16le';
  } else if (bytes[0] === 0x00 && bytes[1] === 0x3c) {
    encoding = 'utf-16be';
  }
  try {
    const xml = new TextDecoder(encoding, {
      fatal: true,
      ignoreBOM: true,
    }).decode(content);
    if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
      throw new BrowserOfficeParserError('CORRUPT_OOXML');
    }
    return xml;
  } catch (error) {
    if (error instanceof BrowserOfficeParserError) {
      throw error;
    }
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }
}

function extractParagraphs(
  xml: string,
  prefix: 'w' | 'a',
): readonly string[] {
  const paragraphTag = `${prefix}:p`;
  const textTag = `${prefix}:t`;
  const lineBreakTag = `${prefix}:br`;
  const tabTag = `${prefix}:tab`;
  const stack: string[] = [];
  const paragraphs: string[] = [];
  let paragraph: string[] | undefined;
  let activeTextTag: string | undefined;
  let cursor = 0;

  while (cursor < xml.length) {
    if (xml[cursor] !== '<') {
      const nextTag = xml.indexOf('<', cursor);
      const end = nextTag === -1 ? xml.length : nextTag;
      if (activeTextTag !== undefined && paragraph !== undefined) {
        paragraph.push(decodeXmlEntities(xml.slice(cursor, end)));
      }
      cursor = end;
      continue;
    }
    if (xml.startsWith('<!--', cursor)) {
      cursor = afterDelimited(xml, cursor + 4, '-->');
      continue;
    }
    if (xml.startsWith('<![CDATA[', cursor)) {
      const end = xml.indexOf(']]>', cursor + 9);
      if (end === -1) {
        throw new BrowserOfficeParserError('CORRUPT_OOXML');
      }
      if (activeTextTag !== undefined && paragraph !== undefined) {
        paragraph.push(xml.slice(cursor + 9, end));
      }
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', cursor)) {
      cursor = afterDelimited(xml, cursor + 2, '?>');
      continue;
    }
    if (xml.startsWith('<!', cursor)) {
      throw new BrowserOfficeParserError('CORRUPT_OOXML');
    }

    const tagEnd = findTagEnd(xml, cursor + 1);
    let tag = xml.slice(cursor + 1, tagEnd).trim();
    const closing = tag.startsWith('/');
    if (closing) {
      tag = tag.slice(1).trim();
    }
    const selfClosing = !closing && tag.endsWith('/');
    if (selfClosing) {
      tag = tag.slice(0, -1).trimEnd();
    }
    const name = readTagName(tag);

    if (closing) {
      const opened = stack.pop();
      if (opened !== name) {
        throw new BrowserOfficeParserError('CORRUPT_OOXML');
      }
      if (name === textTag) {
        activeTextTag = undefined;
      }
      if (name === paragraphTag) {
        finishParagraph(paragraphs, paragraph);
        paragraph = undefined;
      }
    } else {
      if (name === paragraphTag) {
        if (paragraph !== undefined) {
          throw new BrowserOfficeParserError('CORRUPT_OOXML');
        }
        paragraph = [];
      } else if (name === textTag && paragraph !== undefined) {
        if (activeTextTag !== undefined) {
          throw new BrowserOfficeParserError('CORRUPT_OOXML');
        }
        activeTextTag = name;
      } else if (paragraph !== undefined && name === lineBreakTag) {
        paragraph.push('\n');
      } else if (paragraph !== undefined && name === tabTag) {
        paragraph.push('\t');
      }

      if (!selfClosing) {
        stack.push(name);
      } else {
        if (name === textTag) {
          activeTextTag = undefined;
        }
        if (name === paragraphTag) {
          finishParagraph(paragraphs, paragraph);
          paragraph = undefined;
        }
      }
    }
    cursor = tagEnd + 1;
  }
  if (
    stack.length !== 0 ||
    paragraph !== undefined ||
    activeTextTag !== undefined
  ) {
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }
  return Object.freeze(paragraphs);
}

function finishParagraph(
  paragraphs: string[],
  parts: string[] | undefined,
): void {
  if (parts === undefined) {
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }
  const text = parts.join('').replace(/\r\n?/gu, '\n').trim();
  if (text.length > 0) {
    paragraphs.push(text);
  }
}

function findTagEnd(xml: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote === undefined && (character === '"' || character === "'")) {
      quote = character;
    } else if (quote === character) {
      quote = undefined;
    } else if (quote === undefined && character === '>') {
      return index;
    }
  }
  throw new BrowserOfficeParserError('CORRUPT_OOXML');
}

function readTagName(tag: string): string {
  const match = /^([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s|$)/u.exec(tag);
  if (match?.[1] === undefined) {
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }
  return match[1];
}

function afterDelimited(
  xml: string,
  start: number,
  delimiter: string,
): number {
  const end = xml.indexOf(delimiter, start);
  if (end === -1) {
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }
  return end + delimiter.length;
}

function decodeXmlEntities(text: string): string {
  if (
    /&(?!(?:#[0-9]+|#x[0-9a-f]+|amp|apos|gt|lt|quot);)/iu.test(text)
  ) {
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }
  return text.replace(
    /&(?:#([0-9]+)|#x([0-9a-f]+)|(amp|apos|gt|lt|quot));/giu,
    (entity, decimal: string, hexadecimal: string, named: string) => {
      if (decimal !== undefined) {
        return codePointFromEntity(Number(decimal));
      }
      if (hexadecimal !== undefined) {
        return codePointFromEntity(Number.parseInt(hexadecimal, 16));
      }
      const predefined: Readonly<Record<string, string>> = {
        amp: '&',
        apos: "'",
        gt: '>',
        lt: '<',
        quot: '"',
      };
      return predefined[named.toLowerCase()] ?? entity;
    },
  );
}

function codePointFromEntity(value: number): string {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 0x10ffff ||
    (value >= 0xd800 && value <= 0xdfff)
  ) {
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }
  return String.fromCodePoint(value);
}

async function createTraceableChunks(
  blocks: readonly ExtractedBlock[],
  sourceFileId: string,
  sourceFileVersion: number,
  subtle: SubtleCrypto,
): Promise<readonly TraceableOfficeChunk[]> {
  const drafts: Array<
    Readonly<{
      pageNumber: number;
      pageLabel: string;
      characterStart: number;
      characterEnd: number;
      text: string;
    }>
  > = [];
  let canonicalCursor = 0;

  for (const block of blocks) {
    let blockCursor = 0;
    while (blockCursor < block.text.length) {
      const hardEnd = Math.min(
        blockCursor + MAX_CHUNK_CHARACTERS,
        block.text.length,
      );
      const safeEnd = avoidBrokenSurrogatePair(block.text, hardEnd);
      const segment = block.text.slice(blockCursor, safeEnd);
      const leadingLength = segment.length - segment.trimStart().length;
      const trailingLength = segment.length - segment.trimEnd().length;
      const text = segment.slice(
        leadingLength,
        segment.length - trailingLength,
      );
      if (text.length > 0) {
        const characterStart =
          canonicalCursor + blockCursor + leadingLength;
        drafts.push(
          Object.freeze({
            pageNumber: block.pageNumber,
            pageLabel: block.pageLabel,
            characterStart,
            characterEnd: characterStart + text.length,
            text,
          }),
        );
      }
      blockCursor = safeEnd;
    }
    canonicalCursor += block.text.length + 1;
  }

  const chunks = await Promise.all(
    drafts.map(async (draft, ordinal): Promise<TraceableOfficeChunk> => {
      return Object.freeze({
        sourceFileId,
        sourceFileVersion,
        ordinal,
        pageNumber: draft.pageNumber,
        pageLabel: draft.pageLabel,
        characterStart: draft.characterStart,
        characterEnd: draft.characterEnd,
        text: draft.text,
        contentSha256: await sha256Hex(
          new TextEncoder().encode(draft.text),
          subtle,
        ),
      });
    }),
  );
  return Object.freeze(chunks);
}

function avoidBrokenSurrogatePair(text: string, boundary: number): number {
  if (boundary >= text.length) {
    return boundary;
  }
  const previous = text.charCodeAt(boundary - 1);
  const current = text.charCodeAt(boundary);
  return previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
    ? boundary - 1
    : boundary;
}

function zipHasEncryptedEntry(bytes: Uint8Array): boolean {
  const minimumEocdOffset = Math.max(0, bytes.length - 65_557);
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  let eocdOffset = -1;
  for (
    let offset = bytes.length - 22;
    offset >= minimumEocdOffset;
    offset -= 1
  ) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  const commentLength = view.getUint16(eocdOffset + 20, true);
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    eocdOffset + 22 + commentLength > bytes.length ||
    centralOffset + centralSize > eocdOffset
  ) {
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }

  let offset = centralOffset;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (
      offset + 46 > bytes.length ||
      view.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY_ENTRY
    ) {
      throw new BrowserOfficeParserError('CORRUPT_OOXML');
    }
    const centralFlags = view.getUint16(offset + 8, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (
      localOffset + 30 > bytes.length ||
      view.getUint32(localOffset, true) !== ZIP_LOCAL_FILE_HEADER
    ) {
      throw new BrowserOfficeParserError('CORRUPT_OOXML');
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    if ((centralFlags & 1) !== 0 || (localFlags & 1) !== 0) {
      return true;
    }
    offset += 46 + fileNameLength + extraLength + entryCommentLength;
  }
  if (offset !== centralOffset + centralSize) {
    throw new BrowserOfficeParserError('CORRUPT_OOXML');
  }
  return false;
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

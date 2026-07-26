import {
  GlobalWorkerOptions,
  InvalidPDFException,
  PasswordException,
  ResponseException,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import {
  SourceParserPortError,
  type PdfParserPage,
  type PdfParserPort,
  type PdfParserResult,
} from './source-file.js';

export const PDFJS_WORKER_URL = pdfWorkerUrl;

if (typeof window !== 'undefined') {
  GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
}

type TextItemLike = Readonly<{
  str: string;
  hasEOL: boolean;
  transform: readonly number[];
  height: number;
  width: number;
}>;

export class PdfJsParser implements PdfParserPort {
  async parsePdf(
    input: Parameters<PdfParserPort['parsePdf']>[0],
  ): Promise<PdfParserResult> {
    const loadingTask = getDocument({
      data: new Uint8Array(await input.file.arrayBuffer()),
      stopAtErrors: true,
    });
    let document: PDFDocumentProxy | undefined;
    let result: PdfParserResult | undefined;
    let failure: SourceParserPortError | undefined;

    try {
      document = await loadingTask.promise;
      const pages: PdfParserPage[] = [];
      let hasExtractableText = false;
      for (
        let pageNumber = 1;
        pageNumber <= document.numPages;
        pageNumber += 1
      ) {
        const page = await document.getPage(pageNumber);
        try {
          const textContent = await page.getTextContent();
          const text = joinTextItems(textContent.items);
          hasExtractableText ||= text.length > 0;
          pages.push(
            Object.freeze({
              pageNumber,
              text,
            }),
          );
        } finally {
          page.cleanup(true);
        }
      }
      if (!hasExtractableText) {
        throw new SourceParserPortError('OCR_REQUIRED');
      }
      result = Object.freeze({
        pageCount: document.numPages,
        pages: Object.freeze(pages),
      });
    } catch (error) {
      failure = mapPdfJsError(error);
    } finally {
      const cleanupFailure = await cleanupPdfJs(
        loadingTask,
        document,
      );
      failure ??= cleanupFailure;
    }

    if (failure !== undefined) {
      throw failure;
    }
    if (result === undefined) {
      throw new SourceParserPortError('PARSER_UNAVAILABLE');
    }
    return result;
  }
}

function joinTextItems(items: readonly unknown[]): string {
  const lines: string[] = [];
  let currentLine = '';
  let previousItem: TextItemLike | undefined;
  let pendingWhitespace = false;

  for (const candidate of items) {
    if (!isTextItem(candidate)) {
      continue;
    }
    const text = candidate.str.trim();
    if (text.length === 0) {
      if (candidate.hasEOL) {
        flushLine(lines, currentLine);
        currentLine = '';
        previousItem = undefined;
        pendingWhitespace = false;
      } else {
        pendingWhitespace ||= candidate.str.length > 0;
      }
      continue;
    }

    const startsNewLine =
      previousItem !== undefined &&
      (previousItem.hasEOL ||
        hasMeaningfulVerticalChange(previousItem, candidate));
    if (startsNewLine) {
      flushLine(lines, currentLine);
      currentLine = '';
    } else if (
      currentLine.length > 0 &&
      previousItem !== undefined &&
      shouldInsertSpace(
        previousItem,
        candidate,
        pendingWhitespace,
        currentLine,
        text,
      )
    ) {
      currentLine += ' ';
    }
    currentLine += text;
    previousItem = candidate;
    pendingWhitespace = false;
  }
  flushLine(lines, currentLine);
  return lines.join('\n');
}

function shouldInsertSpace(
  previous: TextItemLike,
  current: TextItemLike,
  pendingWhitespace: boolean,
  previousText: string,
  currentText: string,
): boolean {
  const previousX = previous.transform[4];
  const currentX = current.transform[4];
  if (previousX === undefined || currentX === undefined) {
    return (
      pendingWhitespace &&
      !hasSpaceFreeCjkBoundary(previousText, currentText)
    );
  }
  const horizontalGap = currentX - (previousX + previous.width);
  const visibleGapThreshold =
    Math.max(Math.abs(previous.height), Math.abs(current.height), 1) *
    0.2;
  if (horizontalGap > visibleGapThreshold) {
    return true;
  }
  if (horizontalGap <= visibleGapThreshold) {
    return false;
  }
  return (
    pendingWhitespace &&
    !hasSpaceFreeCjkBoundary(previousText, currentText)
  );
}

function hasSpaceFreeCjkBoundary(
  previousText: string,
  currentText: string,
): boolean {
  const previousCharacter = previousText.at(-1) ?? '';
  const currentCharacter = currentText.at(0) ?? '';
  return (
    /[\p{Script=Han}（《【「『]/u.test(previousCharacter) ||
    /[\p{Script=Han}，。！？；：、）》】」』]/u.test(currentCharacter)
  );
}

function flushLine(lines: string[], line: string): void {
  const normalized = line.trim();
  if (normalized.length > 0) {
    lines.push(normalized);
  }
}

function hasMeaningfulVerticalChange(
  previous: TextItemLike,
  current: TextItemLike,
): boolean {
  const previousY = previous.transform[5];
  const currentY = current.transform[5];
  if (previousY === undefined || currentY === undefined) {
    return false;
  }
  const threshold = Math.max(
    Math.abs(previous.height),
    Math.abs(current.height),
    1,
  ) * 0.5;
  return Math.abs(previousY - currentY) > threshold;
}

function isTextItem(value: unknown): value is TextItemLike {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.str === 'string' &&
    typeof candidate.hasEOL === 'boolean' &&
    Array.isArray(candidate.transform) &&
    candidate.transform.every((entry) => typeof entry === 'number') &&
    typeof candidate.height === 'number' &&
    typeof candidate.width === 'number'
  );
}

function mapPdfJsError(error: unknown): SourceParserPortError {
  if (error instanceof SourceParserPortError) {
    return error;
  }
  if (
    error instanceof PasswordException ||
    errorName(error) === 'PasswordException'
  ) {
    return new SourceParserPortError('ENCRYPTED_PDF');
  }
  if (
    error instanceof InvalidPDFException ||
    error instanceof ResponseException ||
    [
      'InvalidPDFException',
      'FormatError',
      'ResponseException',
      'MissingPDFException',
      'UnknownErrorException',
    ].includes(errorName(error))
  ) {
    return new SourceParserPortError('CORRUPT_PDF');
  }
  return new SourceParserPortError('PARSER_UNAVAILABLE');
}

function errorName(error: unknown): string {
  return (
    error !== null &&
      typeof error === 'object' &&
      'name' in error &&
      typeof error.name === 'string'
      ? error.name
      : ''
  );
}

async function cleanupPdfJs(
  loadingTask: PDFDocumentLoadingTask,
  document: PDFDocumentProxy | undefined,
): Promise<SourceParserPortError | undefined> {
  try {
    if (document !== undefined) {
      await document.cleanup();
    }
    await loadingTask.destroy();
    return undefined;
  } catch {
    return new SourceParserPortError('PARSER_UNAVAILABLE');
  }
}

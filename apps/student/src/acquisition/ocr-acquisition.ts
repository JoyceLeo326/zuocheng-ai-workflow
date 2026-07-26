import {
  AcquisitionError,
  acquisitionError,
  analyzeAcquiredText,
  validateAcquisitionFile,
  verifyAcquisitionFileSignature,
  type AcquisitionProgress,
  type OcrAcquisitionResult,
  type OcrPageResult,
} from './acquisition-domain.js';

const MAX_OCR_PDF_PAGES = 200;
const DEFAULT_PAGE_TIMEOUT_MS = 120_000;

export interface OcrRecognition {
  text: string;
  confidence: number;
}

export interface OcrWorker {
  recognize(
    image: Blob,
    pageNumber: number,
    onProgress: (progress: number) => void,
  ): Promise<OcrRecognition>;
  terminate(): Promise<void>;
}

export interface PdfRasterizedDocument {
  pageCount: number;
  renderPage(
    pageNumber: number,
    signal: AbortSignal,
  ): Promise<Blob>;
  close(): Promise<void>;
}

export interface PdfRasterizer {
  open(
    file: File,
    signal: AbortSignal,
  ): Promise<PdfRasterizedDocument>;
}

export interface OcrAcquisitionServiceOptions {
  createWorker(): Promise<OcrWorker>;
  pdfRasterizer?: PdfRasterizer;
  now?: () => Date;
  cryptoProvider?: Pick<Crypto, 'subtle'>;
  pageTimeoutMs?: number;
}

export class OcrAcquisitionService {
  readonly #createWorker: () => Promise<OcrWorker>;
  readonly #pdfRasterizer: PdfRasterizer | undefined;
  readonly #now: () => Date;
  readonly #cryptoProvider: Pick<Crypto, 'subtle'> | undefined;
  readonly #pageTimeoutMs: number;

  constructor(options: OcrAcquisitionServiceOptions) {
    this.#createWorker = options.createWorker;
    this.#pdfRasterizer = options.pdfRasterizer;
    this.#now = options.now ?? (() => new Date());
    this.#cryptoProvider =
      options.cryptoProvider ?? globalThis.crypto;
    this.#pageTimeoutMs = timeoutAt(options.pageTimeoutMs);
  }

  async acquire(
    file: File,
    signal: AbortSignal,
    onProgress: (progress: AcquisitionProgress) => void = () =>
      undefined,
  ): Promise<OcrAcquisitionResult> {
    onProgress({
      phase: 'validating',
      overallProgress: 0,
      pageNumber: null,
      pageCount: null,
      message: '正在检查文件',
    });
    const validated = validateAcquisitionFile(file);
    await verifyAcquisitionFileSignature(file, validated);
    throwIfAborted(signal);
    let worker: OcrWorker | undefined;
    let pdf: PdfRasterizedDocument | undefined;
    let terminated = false;
    const terminateWorker = async (): Promise<void> => {
      if (worker === undefined || terminated) {
        return;
      }
      terminated = true;
      await worker.terminate();
    };
    const cancelWorker = () => {
      void terminateWorker();
    };
    signal.addEventListener('abort', cancelWorker, { once: true });

    try {
      onProgress({
        phase: 'loading',
        overallProgress: 0.02,
        pageNumber: null,
        pageCount: null,
        message: '正在加载文字识别组件',
      });
      worker = await this.#createWorker();
      throwIfAborted(signal);
      let pageCount = 1;
      if (validated.kind === 'pdf') {
        if (this.#pdfRasterizer === undefined) {
          throw new AcquisitionError(
            'PDF_FAILED',
            '扫描 PDF 渲染组件不可用。',
          );
        }
        pdf = await this.#pdfRasterizer.open(file, signal);
        if (
          !Number.isSafeInteger(pdf.pageCount) ||
          pdf.pageCount < 1 ||
          pdf.pageCount > MAX_OCR_PDF_PAGES
        ) {
          throw new AcquisitionError(
            'PDF_TOO_LARGE',
            `扫描 PDF 页数须在 1 到 ${MAX_OCR_PDF_PAGES} 页之间。`,
          );
        }
        pageCount = pdf.pageCount;
      }
      const pages: OcrPageResult[] = [];
      for (
        let pageNumber = 1;
        pageNumber <= pageCount;
        pageNumber += 1
      ) {
        throwIfAborted(signal);
        let image: Blob;
        if (pdf === undefined) {
          image = file;
        } else {
          onProgress({
            phase: 'rendering',
            overallProgress: (pageNumber - 1) / pageCount,
            pageNumber,
            pageCount,
            message: `正在渲染第 ${pageNumber} / ${pageCount} 页`,
          });
          image = await pdf.renderPage(pageNumber, signal);
          if (
            !(image instanceof Blob) ||
            image.size === 0 ||
            image.type !== 'image/png'
          ) {
            throw new AcquisitionError(
              'PDF_FAILED',
              '扫描 PDF 页面渲染失败。',
            );
          }
        }
        const recognized = await withPageTimeout(
          worker.recognize(image, pageNumber, (progress) => {
            onProgress({
              phase: 'recognizing',
              overallProgress:
                (pageNumber - 1 + clampProgress(progress)) /
                pageCount,
              pageNumber,
              pageCount,
              message: `正在识别第 ${pageNumber} / ${pageCount} 页`,
            });
          }),
          this.#pageTimeoutMs,
          terminateWorker,
        );
        throwIfAborted(signal);
        pages.push(parseRecognition(recognized, pageNumber));
      }
      const originalText = pages.map((page) => page.text).join('\n\n');
      const analyzed = await analyzeAcquiredText(
        originalText,
        this.#cryptoProvider,
      );
      onProgress({
        phase: 'complete',
        overallProgress: 1,
        pageNumber: pageCount,
        pageCount,
        message: '文字识别已完成',
      });
      return {
        kind: 'ocr',
        originalFile: file,
        fileName: validated.fileName,
        mediaType: validated.mediaType,
        acquiredAt: this.#now().toISOString(),
        pageCount,
        pages,
        ...analyzed,
      };
    } catch (error) {
      if (error instanceof AcquisitionError) {
        throw error;
      }
      if (signal.aborted) {
        throw new AcquisitionError('CANCELLED', '文字识别已取消。');
      }
      const mapped = acquisitionError(error);
      if (mapped.code === 'CANCELLED') {
        throw mapped;
      }
      throw new AcquisitionError(
        'OCR_FAILED',
        '文字识别未完成，请重试或更换文件。',
        error,
      );
    } finally {
      signal.removeEventListener('abort', cancelWorker);
      await Promise.allSettled([
        terminateWorker(),
        pdf?.close() ?? Promise.resolve(),
      ]);
    }
  }
}

function parseRecognition(
  value: OcrRecognition,
  pageNumber: number,
): OcrPageResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.text !== 'string' ||
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence)
  ) {
    throw new AcquisitionError(
      'OCR_FAILED',
      '文字识别返回了无效结果。',
    );
  }
  return {
    pageNumber,
    text: value.text.replace(/\r\n?/gu, '\n').trim(),
    confidence: Math.min(100, Math.max(0, value.confidence)),
  };
}

async function withPageTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void onTimeout();
      reject(
        new AcquisitionError(
          'TIMEOUT',
          '单页文字识别超时，请降低图片尺寸后重试。',
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AcquisitionError('CANCELLED', '文字识别已取消。');
  }
}

function clampProgress(value: number): number {
  return Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

function timeoutAt(value: number | undefined): number {
  const timeout = value ?? DEFAULT_PAGE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 5_000 ||
    timeout > 10 * 60_000
  ) {
    throw new AcquisitionError(
      'INVALID_INPUT',
      '文字识别超时设置无效。',
    );
  }
  return timeout;
}

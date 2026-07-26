import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { AcquisitionError } from './acquisition-domain.js';
import type {
  PdfRasterizedDocument,
  PdfRasterizer,
} from './ocr-acquisition.js';

const MAX_RENDER_PIXELS = 18_000_000;
const TARGET_SCALE = 2;

if (typeof window !== 'undefined') {
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
}

export class PdfJsRasterizer implements PdfRasterizer {
  async open(
    file: File,
    signal: AbortSignal,
  ): Promise<PdfRasterizedDocument> {
    if (signal.aborted) {
      throw new AcquisitionError('CANCELLED', 'PDF 渲染已取消。');
    }
    const loadingTask = getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      stopAtErrors: true,
    });
    const abort = () => {
      void loadingTask.destroy();
    };
    signal.addEventListener('abort', abort, { once: true });
    let document: PDFDocumentProxy;
    try {
      document = await loadingTask.promise;
    } catch (error) {
      if (signal.aborted) {
        throw new AcquisitionError('CANCELLED', 'PDF 渲染已取消。');
      }
      throw new AcquisitionError(
        'PDF_FAILED',
        '扫描 PDF 无法打开，请检查文件是否损坏或加密。',
        error,
      );
    } finally {
      signal.removeEventListener('abort', abort);
    }
    return new PdfJsRasterizedDocument(loadingTask, document);
  }
}

class PdfJsRasterizedDocument implements PdfRasterizedDocument {
  readonly pageCount: number;
  readonly #loadingTask: PDFDocumentLoadingTask;
  readonly #document: PDFDocumentProxy;
  #closed = false;

  constructor(
    loadingTask: PDFDocumentLoadingTask,
    document: PDFDocumentProxy,
  ) {
    this.#loadingTask = loadingTask;
    this.#document = document;
    this.pageCount = document.numPages;
  }

  async renderPage(
    pageNumber: number,
    signal: AbortSignal,
  ): Promise<Blob> {
    if (
      this.#closed ||
      !Number.isSafeInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > this.pageCount
    ) {
      throw new AcquisitionError(
        'PDF_FAILED',
        '扫描 PDF 页码无效。',
      );
    }
    if (signal.aborted) {
      throw new AcquisitionError('CANCELLED', 'PDF 渲染已取消。');
    }
    if (typeof document === 'undefined') {
      throw new AcquisitionError(
        'PDF_FAILED',
        '当前环境无法创建 PDF 页面画布。',
      );
    }
    const page = await this.#document.getPage(pageNumber);
    try {
      const baseViewport = page.getViewport({ scale: 1 });
      const basePixels =
        Math.max(1, baseViewport.width) *
        Math.max(1, baseViewport.height);
      const scale = Math.min(
        TARGET_SCALE,
        Math.sqrt(MAX_RENDER_PIXELS / basePixels),
      );
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext('2d', {
        alpha: false,
        willReadFrequently: false,
      });
      if (context === null) {
        throw new AcquisitionError(
          'PDF_FAILED',
          '当前浏览器无法创建 PDF 页面画布。',
        );
      }
      const renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        intent: 'display',
      });
      const cancel = () => {
        renderTask.cancel();
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        await renderTask.promise;
      } catch (error) {
        if (signal.aborted) {
          throw new AcquisitionError(
            'CANCELLED',
            'PDF 渲染已取消。',
          );
        }
        throw new AcquisitionError(
          'PDF_FAILED',
          `PDF 第 ${pageNumber} 页渲染失败。`,
          error,
        );
      } finally {
        signal.removeEventListener('abort', cancel);
      }
      return await canvasToPng(canvas);
    } finally {
      page.cleanup(true);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#document.cleanup();
    await this.#loadingTask.destroy();
  }
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(
          new AcquisitionError(
            'PDF_FAILED',
            'PDF 页面无法转换为图片。',
          ),
        );
      } else {
        resolve(blob);
      }
    }, 'image/png');
  });
}

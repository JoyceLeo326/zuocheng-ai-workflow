import { describe, expect, it, vi } from 'vitest';
import {
  OcrAcquisitionService,
  type OcrWorker,
  type PdfRasterizer,
} from './ocr-acquisition.js';

const NOW = '2026-07-27T12:00:00.000Z';

function worker(): OcrWorker {
  return {
    recognize: vi.fn(async (_image, pageNumber, onProgress) => {
      onProgress(0.5);
      onProgress(1);
      return {
        text: pageNumber === 1 ? '第一页 中文 English' : '第二页 内容',
        confidence: 92,
      };
    }),
    terminate: vi.fn(async () => undefined),
  };
}

describe('OCR acquisition', () => {
  it('runs real injected OCR for an image and reports bounded progress', async () => {
    const ocrWorker = worker();
    const progress: number[] = [];
    const service = new OcrAcquisitionService({
      createWorker: vi.fn(async () => ocrWorker),
      now: () => new Date(NOW),
    });
    const originalFile = new File(
      [
        new Uint8Array([
          0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45,
          0x42, 0x50,
        ]),
      ],
      'scan.webp',
      {
        type: 'image/webp',
      },
    );

    const result = await service.acquire(
      originalFile,
      new AbortController().signal,
      (event) => progress.push(event.overallProgress),
    );

    expect(result).toMatchObject({
      kind: 'ocr',
      fileName: 'scan.webp',
      mediaType: 'image/webp',
      acquiredAt: NOW,
      pageCount: 1,
      originalText: '第一页 中文 English',
      safeText: '第一页 中文 English',
    });
    expect(result.pages).toEqual([
      expect.objectContaining({
        pageNumber: 1,
        confidence: 92,
      }),
    ]);
    expect(result.originalFile).toBe(originalFile);
    expect(progress.at(-1)).toBe(1);
    expect(ocrWorker.terminate).toHaveBeenCalledTimes(1);
  });

  it('renders and recognizes every scanned PDF page without inventing missing text', async () => {
    const ocrWorker = worker();
    const rasterizer: PdfRasterizer = {
      open: vi.fn(async () => ({
        pageCount: 2,
        renderPage: vi.fn(async (pageNumber) =>
          new Blob([`page-${pageNumber}`], { type: 'image/png' }),
        ),
        close: vi.fn(async () => undefined),
      })),
    };
    const service = new OcrAcquisitionService({
      createWorker: vi.fn(async () => ocrWorker),
      pdfRasterizer: rasterizer,
      now: () => new Date(NOW),
    });

    const result = await service.acquire(
      new File(['%PDF-1.7\n'], 'scan.pdf', {
        type: 'application/pdf',
      }),
      new AbortController().signal,
    );

    expect(result.pageCount).toBe(2);
    expect(result.pages.map((page) => page.text)).toEqual([
      '第一页 中文 English',
      '第二页 内容',
    ]);
    expect(result.originalText).toBe(
      '第一页 中文 English\n\n第二页 内容',
    );
  });

  it('terminates the worker and reports cancellation without a partial success', async () => {
    const abort = new AbortController();
    const ocrWorker: OcrWorker = {
      recognize: vi.fn(async () => {
        abort.abort();
        throw new DOMException('cancelled secret', 'AbortError');
      }),
      terminate: vi.fn(async () => undefined),
    };
    const service = new OcrAcquisitionService({
      createWorker: vi.fn(async () => ocrWorker),
    });

    await expect(
      service.acquire(
        new File(
          [
            new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a,
              0x0a,
            ]),
          ],
          'scan.png',
          { type: 'image/png' },
        ),
        abort.signal,
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(ocrWorker.terminate).toHaveBeenCalledTimes(1);
  });
});

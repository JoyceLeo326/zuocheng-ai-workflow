import Tesseract from 'tesseract.js';
import { AcquisitionError } from './acquisition-domain.js';
import type {
  OcrRecognition,
  OcrWorker,
} from './ocr-acquisition.js';

export interface BrowserTesseractOcrOptions {
  workerPath?: string;
  corePath?: string;
  langPath?: string;
}

export async function createBrowserTesseractOcrWorker(
  options: BrowserTesseractOcrOptions = {},
): Promise<OcrWorker> {
  const assets = localOcrAssetPaths();
  let activeProgress: ((progress: number) => void) | null = null;
  let worker: Tesseract.Worker;
  try {
    worker = await Tesseract.createWorker(
      ['chi_sim', 'eng'],
      Tesseract.OEM.LSTM_ONLY,
      {
        workerPath: options.workerPath ?? assets.workerPath,
        corePath: options.corePath ?? assets.corePath,
        langPath: options.langPath ?? assets.langPath,
        workerBlobURL: false,
        gzip: true,
        cacheMethod: 'write',
        logger: (message) => {
          if (
            message.status === 'recognizing text' &&
            activeProgress !== null
          ) {
            activeProgress(message.progress);
          }
        },
        errorHandler: () => undefined,
      },
    );
    await worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.AUTO,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });
  } catch (error) {
    throw new AcquisitionError(
      'OCR_UNAVAILABLE',
      '文字识别组件加载失败，请刷新后重试。',
      error,
    );
  }
  let terminated = false;
  return {
    async recognize(
      image: Blob,
      _pageNumber: number,
      onProgress: (progress: number) => void,
    ): Promise<OcrRecognition> {
      if (terminated) {
        throw new AcquisitionError(
          'OCR_UNAVAILABLE',
          '文字识别组件已关闭。',
        );
      }
      activeProgress = onProgress;
      try {
        const result = await worker.recognize(
          image,
          { rotateAuto: true },
          {
            text: true,
            blocks: false,
            layoutBlocks: false,
            hocr: false,
            tsv: false,
            box: false,
            unlv: false,
            osd: false,
            pdf: false,
            imageColor: false,
            imageGrey: false,
            imageBinary: false,
            debug: false,
          },
        );
        return {
          text: result.data.text,
          confidence: result.data.confidence,
        };
      } catch (error) {
        if (terminated) {
          throw new AcquisitionError(
            'CANCELLED',
            '文字识别已取消。',
          );
        }
        throw new AcquisitionError(
          'OCR_FAILED',
          '当前页面没有识别完成。',
          error,
        );
      } finally {
        activeProgress = null;
      }
    },
    async terminate(): Promise<void> {
      if (terminated) {
        return;
      }
      terminated = true;
      await worker.terminate();
    },
  };
}

export function localOcrAssetPaths(): {
  workerPath: string;
  corePath: string;
  langPath: string;
} {
  const configuredBase = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  const base = configuredBase.startsWith('.')
    ? new URL(
        configuredBase,
        globalThis.location?.href ?? 'http://localhost/',
      ).pathname
    : configuredBase;
  return {
    workerPath: `${base}ocr/worker.min.js`,
    corePath: `${base}ocr/core`,
    langPath: `${base}ocr/lang`,
  };
}

export {
  AcquisitionError,
  analyzeAcquiredText,
  validateAcquisitionFile,
  verifyAcquisitionFileSignature,
  validatePublicHttpsUrl,
  type AcquisitionProgress,
  type AcquisitionResult,
  type AnalyzedAcquiredText,
  type InjectionFlag,
  type OcrAcquisitionResult,
  type OcrPageResult,
  type UrlAcquisitionResult,
  type ValidatedAcquisitionFile,
} from './acquisition-domain.js';
export {
  UrlAcquisitionService,
  createManualUrlAcquisition,
  extractReadableHtml,
  type HtmlExtraction,
  type ReaderEndpointConfig,
  type UrlAcquisitionServiceOptions,
} from './url-acquisition.js';
export {
  OcrAcquisitionService,
  type OcrAcquisitionServiceOptions,
  type OcrRecognition,
  type OcrWorker,
  type PdfRasterizedDocument,
  type PdfRasterizer,
} from './ocr-acquisition.js';
export { PdfJsRasterizer } from './pdf-rasterizer.js';
export {
  createBrowserTesseractOcrWorker,
  localOcrAssetPaths,
  type BrowserTesseractOcrOptions,
} from './browser-tesseract-ocr.js';
export {
  AcquisitionPanel,
  AcquisitionPanelView,
  type AcquisitionPanelMode,
  type AcquisitionPanelProps,
  type AcquisitionPanelViewProps,
} from './acquisition-panel.js';

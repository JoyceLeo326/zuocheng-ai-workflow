export const MAX_ACQUISITION_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_ACQUIRED_TEXT_CHARACTERS = 20 * 1024 * 1024;

export type AcquisitionErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_TYPE'
  | 'TYPE_MISMATCH'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSAFE_URL'
  | 'CORS_OR_NETWORK'
  | 'HTTP_ERROR'
  | 'UNSUPPORTED_RESPONSE'
  | 'RESPONSE_TOO_LARGE'
  | 'EMPTY_CONTENT'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'OCR_UNAVAILABLE'
  | 'OCR_FAILED'
  | 'PDF_FAILED'
  | 'PDF_TOO_LARGE'
  | 'CRYPTO_UNAVAILABLE';

export class AcquisitionError extends Error {
  override readonly cause: unknown;

  constructor(
    readonly code: AcquisitionErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'AcquisitionError';
    this.cause = cause;
  }
}

export type AcquisitionFileKind = 'image' | 'pdf';

export interface ValidatedAcquisitionFile {
  fileName: string;
  mediaType:
    | 'image/png'
    | 'image/jpeg'
    | 'image/webp'
    | 'application/pdf';
  extension:
    | '.png'
    | '.jpg'
    | '.jpeg'
    | '.webp'
    | '.pdf';
  kind: AcquisitionFileKind;
  sizeBytes: number;
}

export interface InjectionFlag {
  kind: 'prompt-injection';
  lineNumber: number;
  excerpt: string;
}

export interface AnalyzedAcquiredText {
  originalText: string;
  safeText: string;
  flags: InjectionFlag[];
  contentSha256: string;
}

export interface OcrPageResult {
  pageNumber: number;
  text: string;
  confidence: number;
}

export interface OcrAcquisitionResult extends AnalyzedAcquiredText {
  kind: 'ocr';
  originalFile: File;
  fileName: string;
  mediaType: ValidatedAcquisitionFile['mediaType'];
  acquiredAt: string;
  pageCount: number;
  pages: OcrPageResult[];
}

export type UrlAcquisitionMethod = 'direct' | 'reader' | 'manual';

export interface UrlAcquisitionResult extends AnalyzedAcquiredText {
  kind: 'url';
  method: UrlAcquisitionMethod;
  sourceUrl: string;
  fetchedAt: string;
  title: string;
}

export type AcquisitionResult =
  | OcrAcquisitionResult
  | UrlAcquisitionResult;

export interface AcquisitionProgress {
  phase:
    | 'validating'
    | 'loading'
    | 'rendering'
    | 'recognizing'
    | 'fetching'
    | 'processing'
    | 'complete';
  overallProgress: number;
  pageNumber: number | null;
  pageCount: number | null;
  message: string;
}

const FILE_FORMATS: Readonly<
  Record<
    ValidatedAcquisitionFile['extension'],
    {
      mediaType: ValidatedAcquisitionFile['mediaType'];
      kind: AcquisitionFileKind;
    }
  >
> = {
  '.png': { mediaType: 'image/png', kind: 'image' },
  '.jpg': { mediaType: 'image/jpeg', kind: 'image' },
  '.jpeg': { mediaType: 'image/jpeg', kind: 'image' },
  '.webp': { mediaType: 'image/webp', kind: 'image' },
  '.pdf': { mediaType: 'application/pdf', kind: 'pdf' },
};

const INJECTION_PATTERNS = [
  /\bignore\s+(?:all\s+)?previous\s+instructions?\b/iu,
  /\breveal\s+(?:the\s+)?(?:system|developer)\s+prompt\b/iu,
  /\b(?:system|developer)\s+message\b/iu,
  /\btool\s*(?:call|output)\b/iu,
  /\bjailbreak\b/iu,
  /忽略.{0,12}(?:之前|以上|原有).{0,12}指令/u,
  /(?:泄露|显示|输出).{0,12}(?:系统|开发者).{0,6}(?:提示词|指令)/u,
  /你现在是.{0,30}(?:系统|助手|模型)/u,
] as const;

export function validateAcquisitionFile(
  file: Pick<File, 'name' | 'type' | 'size'>,
): ValidatedAcquisitionFile {
  if (
    typeof file.name !== 'string' ||
    file.name.length === 0 ||
    file.name.length > 255 ||
    file.name !== file.name.trim() ||
    file.name.includes('/') ||
    file.name.includes('\\') ||
    hasAsciiControl(file.name)
  ) {
    throw new AcquisitionError(
      'INVALID_INPUT',
      '文件名无效，请重新选择文件。',
    );
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw new AcquisitionError(
      'INVALID_INPUT',
      '无法读取文件大小。',
    );
  }
  if (file.size === 0) {
    throw new AcquisitionError('EMPTY_FILE', '文件内容为空。');
  }
  if (file.size > MAX_ACQUISITION_FILE_BYTES) {
    throw new AcquisitionError(
      'FILE_TOO_LARGE',
      '文件超过 50 MB，请压缩后重试。',
    );
  }
  const dot = file.name.lastIndexOf('.');
  const extension = file.name
    .slice(dot)
    .toLowerCase() as ValidatedAcquisitionFile['extension'];
  const format = FILE_FORMATS[extension];
  if (dot <= 0 || format === undefined) {
    throw new AcquisitionError(
      'UNSUPPORTED_TYPE',
      '请选择 PNG、JPEG、WebP 或 PDF 文件。',
    );
  }
  const mediaType = file.type
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== format.mediaType) {
    throw new AcquisitionError(
      'TYPE_MISMATCH',
      '文件扩展名与内容类型不一致。',
    );
  }
  return {
    fileName: file.name,
    mediaType: format.mediaType,
    extension,
    kind: format.kind,
    sizeBytes: file.size,
  };
}

export async function verifyAcquisitionFileSignature(
  file: File,
  validated = validateAcquisitionFile(file),
): Promise<void> {
  const bytes = new Uint8Array(
    await file.slice(0, 16).arrayBuffer(),
  );
  const matches =
    validated.mediaType === 'image/png'
      ? startsWith(bytes, [
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ])
      : validated.mediaType === 'image/jpeg'
        ? startsWith(bytes, [0xff, 0xd8, 0xff])
        : validated.mediaType === 'image/webp'
          ? asciiAt(bytes, 0, 'RIFF') &&
            asciiAt(bytes, 8, 'WEBP')
          : asciiAt(bytes, 0, '%PDF-');
  if (!matches) {
    throw new AcquisitionError(
      'TYPE_MISMATCH',
      '文件内容与扩展名不一致。',
    );
  }
}

export async function analyzeAcquiredText(
  originalText: string,
  cryptoProvider: Pick<Crypto, 'subtle'> | undefined = globalThis.crypto,
): Promise<AnalyzedAcquiredText> {
  if (
    typeof originalText !== 'string' ||
    originalText.trim().length === 0
  ) {
    throw new AcquisitionError(
      'EMPTY_CONTENT',
      '没有读取到可保存的正文。',
    );
  }
  if (originalText.length > MAX_ACQUIRED_TEXT_CHARACTERS) {
    throw new AcquisitionError(
      'RESPONSE_TOO_LARGE',
      '正文超过可处理上限。',
    );
  }
  if (cryptoProvider?.subtle === undefined) {
    throw new AcquisitionError(
      'CRYPTO_UNAVAILABLE',
      '当前浏览器无法计算内容校验值。',
    );
  }
  const flags: InjectionFlag[] = [];
  const safeLines = originalText.split('\n').map((line, index) => {
    const displayLine = neutralizeControls(line);
    const suspicious = INJECTION_PATTERNS.some((pattern) =>
      pattern.test(displayLine),
    );
    if (!suspicious) {
      return displayLine;
    }
    flags.push({
      kind: 'prompt-injection',
      lineNumber: index + 1,
      excerpt: displayLine.slice(0, 180),
    });
    return `[可能的外部指令] ${displayLine}`;
  });
  const bytes = new TextEncoder().encode(originalText);
  const digest = await cryptoProvider.subtle.digest(
    'SHA-256',
    bytes,
  );
  return {
    originalText,
    safeText: safeLines.join('\n'),
    flags,
    contentSha256: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join(''),
  };
}

export function validatePublicHttpsUrl(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim()
  ) {
    unsafeUrl();
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    unsafeUrl();
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.port.length > 0 && url.port !== '443') ||
    isBlockedHostname(url.hostname)
  ) {
    unsafeUrl();
  }
  url.hash = '';
  return url.href;
}

export function canonicalDateTime(
  value: string,
  field = 'timestamp',
): string {
  const date = new Date(value);
  if (
    !Number.isFinite(date.valueOf()) ||
    date.toISOString() !== value
  ) {
    throw new AcquisitionError(
      'INVALID_INPUT',
      `${field} 不是有效时间。`,
    );
  }
  return value;
}

export function acquisitionError(error: unknown): AcquisitionError {
  if (error instanceof AcquisitionError) {
    return error;
  }
  if (
    error instanceof DOMException &&
    error.name === 'AbortError'
  ) {
    return new AcquisitionError('CANCELLED', '操作已取消。');
  }
  return new AcquisitionError(
    'CORS_OR_NETWORK',
    '网络请求未完成。',
    error,
  );
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '');
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.includes(':') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.home') ||
    normalized.endsWith('.lan') ||
    normalized.endsWith('.test') ||
    normalized.endsWith('.invalid') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }
  const parts = normalized.split('.');
  if (
    parts.length === 4 &&
    parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/u.test(part))
  ) {
    const numbers = parts.map(Number);
    if (numbers.some((part) => part > 255)) {
      return true;
    }
    const [first, second] = numbers as [
      number,
      number,
      number,
      number,
    ];
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  }
  return false;
}

function neutralizeControls(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined &&
        codePoint !== 0 &&
        codePoint !== 0x7f &&
        !(codePoint >= 0x202a && codePoint <= 0x202e) &&
        !(codePoint >= 0x2066 && codePoint <= 0x2069)
      );
    })
    .join('');
}

function hasAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    );
  });
}

function unsafeUrl(): never {
  throw new AcquisitionError(
    'UNSAFE_URL',
    '只支持公开的 HTTPS 网页地址。',
  );
}

function startsWith(
  input: Uint8Array,
  signature: readonly number[],
): boolean {
  return signature.every((byte, index) => input[index] === byte);
}

function asciiAt(
  input: Uint8Array,
  offset: number,
  value: string,
): boolean {
  return Array.from(value).every(
    (character, index) =>
      input[offset + index] === character.charCodeAt(0),
  );
}

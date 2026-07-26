import {
  AcquisitionError,
  acquisitionError,
  analyzeAcquiredText,
  canonicalDateTime,
  validatePublicHttpsUrl,
  type AcquisitionProgress,
  type UrlAcquisitionResult,
} from './acquisition-domain.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface HtmlExtraction {
  title: string;
  text: string;
}

export interface ReaderEndpointConfig {
  endpoint: string;
  apiKey?: string;
}

export interface UrlAcquisitionServiceOptions {
  fetcher?: Fetcher;
  now?: () => Date;
  htmlExtractor?: (html: string, sourceUrl: string) => HtmlExtraction;
  cryptoProvider?: Pick<Crypto, 'subtle'>;
  timeoutMs?: number;
}

export class UrlAcquisitionService {
  readonly #fetcher: Fetcher;
  readonly #now: () => Date;
  readonly #htmlExtractor: (
    html: string,
    sourceUrl: string,
  ) => HtmlExtraction;
  readonly #cryptoProvider: Pick<Crypto, 'subtle'> | undefined;
  readonly #timeoutMs: number;

  constructor(options: UrlAcquisitionServiceOptions = {}) {
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? (() => new Date());
    this.#htmlExtractor =
      options.htmlExtractor ?? extractReadableHtml;
    this.#cryptoProvider =
      options.cryptoProvider ?? globalThis.crypto;
    this.#timeoutMs = timeoutAt(options.timeoutMs);
  }

  async acquireDirect(
    value: string,
    signal: AbortSignal,
    onProgress?: (progress: AcquisitionProgress) => void,
  ): Promise<UrlAcquisitionResult> {
    const sourceUrl = validatePublicHttpsUrl(value);
    onProgress?.({
      phase: 'fetching',
      overallProgress: 0.1,
      pageNumber: null,
      pageCount: null,
      message: '正在读取网页',
    });
    const response = await this.#request(
      sourceUrl,
      {
        method: 'GET',
        mode: 'cors',
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: {
          Accept:
            'text/html, application/xhtml+xml, text/plain;q=0.9',
        },
      },
      signal,
    );
    assertResponseOk(response);
    const mediaType = contentType(response);
    if (
      mediaType !== 'text/html' &&
      mediaType !== 'application/xhtml+xml' &&
      mediaType !== 'text/plain'
    ) {
      throw new AcquisitionError(
        'UNSUPPORTED_RESPONSE',
        '网页返回了不支持的内容类型。',
      );
    }
    const raw = await readTextLimited(response);
    onProgress?.({
      phase: 'processing',
      overallProgress: 0.75,
      pageNumber: null,
      pageCount: null,
      message: '正在整理网页正文',
    });
    const extracted =
      mediaType === 'text/plain'
        ? { title: titleFromUrl(sourceUrl), text: raw }
        : this.#htmlExtractor(raw, sourceUrl);
    const result = await createUrlResult({
      method: 'direct',
      sourceUrl,
      fetchedAt: this.#now().toISOString(),
      title: extracted.title,
      text: extracted.text,
      cryptoProvider: this.#cryptoProvider,
    });
    onProgress?.({
      phase: 'complete',
      overallProgress: 1,
      pageNumber: null,
      pageCount: null,
      message: '网页正文已读取',
    });
    return result;
  }

  async acquireWithReader(
    value: string,
    config: ReaderEndpointConfig,
    signal: AbortSignal,
    onProgress?: (progress: AcquisitionProgress) => void,
  ): Promise<UrlAcquisitionResult> {
    const sourceUrl = validatePublicHttpsUrl(value);
    const endpoint = validatePublicHttpsUrl(config.endpoint);
    const apiKey =
      config.apiKey === undefined || config.apiKey.length === 0
        ? null
        : credentialAt(config.apiKey);
    onProgress?.({
      phase: 'fetching',
      overallProgress: 0.15,
      pageNumber: null,
      pageCount: null,
      message: '正在通过 Reader 读取网页',
    });
    const response = await this.#request(
      endpoint,
      {
        method: 'POST',
        mode: 'cors',
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: {
          Accept: 'application/json',
          ...(apiKey === null
            ? {}
            : { Authorization: `Bearer ${apiKey}` }),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: sourceUrl }),
      },
      signal,
    );
    assertResponseOk(response);
    const raw = await readTextLimited(response);
    let object: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error('reader response must be an object');
      }
      object = parsed as Record<string, unknown>;
    } catch (error) {
      throw new AcquisitionError(
        'UNSUPPORTED_RESPONSE',
        'Reader 返回的数据格式无效。',
        error,
      );
    }
    if (
      typeof object.title !== 'string' ||
      typeof object.text !== 'string'
    ) {
      throw new AcquisitionError(
        'UNSUPPORTED_RESPONSE',
        'Reader 没有返回标题和正文。',
      );
    }
    const result = await createUrlResult({
      method: 'reader',
      sourceUrl,
      fetchedAt: this.#now().toISOString(),
      title: object.title,
      text: object.text,
      cryptoProvider: this.#cryptoProvider,
    });
    onProgress?.({
      phase: 'complete',
      overallProgress: 1,
      pageNumber: null,
      pageCount: null,
      message: 'Reader 正文已读取',
    });
    return result;
  }

  async #request(
    url: string,
    init: RequestInit,
    parentSignal: AbortSignal,
  ): Promise<Response> {
    const timed = timedSignal(parentSignal, this.#timeoutMs);
    try {
      return await this.#fetcher(url, {
        ...init,
        signal: timed.signal,
      });
    } catch (error) {
      if (timed.timedOut()) {
        throw new AcquisitionError(
          'TIMEOUT',
          '网页请求超时，请重试或改用其他读取方式。',
        );
      }
      if (parentSignal.aborted) {
        throw new AcquisitionError('CANCELLED', '网页读取已取消。');
      }
      throw acquisitionError(error);
    } finally {
      timed.dispose();
    }
  }
}

export async function createManualUrlAcquisition(input: {
  url: string;
  title: string;
  text: string;
  capturedAt?: string;
  cryptoProvider?: Pick<Crypto, 'subtle'>;
}): Promise<UrlAcquisitionResult> {
  return createUrlResult({
    method: 'manual',
    sourceUrl: validatePublicHttpsUrl(input.url),
    fetchedAt: canonicalDateTime(
      input.capturedAt ?? new Date().toISOString(),
      'capturedAt',
    ),
    title: input.title,
    text: input.text,
    cryptoProvider: input.cryptoProvider ?? globalThis.crypto,
  });
}

async function createUrlResult(input: {
  method: UrlAcquisitionResult['method'];
  sourceUrl: string;
  fetchedAt: string;
  title: string;
  text: string;
  cryptoProvider: Pick<Crypto, 'subtle'> | undefined;
}): Promise<UrlAcquisitionResult> {
  const title = normalizeTitle(input.title, input.sourceUrl);
  const analyzed = await analyzeAcquiredText(
    input.text,
    input.cryptoProvider,
  );
  return {
    kind: 'url',
    method: input.method,
    sourceUrl: input.sourceUrl,
    fetchedAt: canonicalDateTime(input.fetchedAt, 'fetchedAt'),
    title,
    ...analyzed,
  };
}

export function extractReadableHtml(
  html: string,
  sourceUrl: string,
): HtmlExtraction {
  if (typeof DOMParser === 'undefined') {
    throw new AcquisitionError(
      'UNSUPPORTED_RESPONSE',
      '当前浏览器无法解析网页正文。',
    );
  }
  const document = new DOMParser().parseFromString(html, 'text/html');
  for (const element of document.querySelectorAll(
    'script, style, noscript, iframe, object, embed, svg, canvas, template, nav, footer',
  )) {
    element.remove();
  }
  const root =
    document.querySelector('main, article, [role="main"]') ??
    document.body;
  const text = normalizeExtractedText(root?.textContent ?? '');
  return {
    title: normalizeTitle(document.title, sourceUrl),
    text,
  };
}

async function readTextLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(declared) &&
    declared > MAX_RESPONSE_BYTES
  ) {
    throw new AcquisitionError(
      'RESPONSE_TOO_LARGE',
      '网页正文超过 5 MB，未继续读取。',
    );
  }
  if (response.body === null) {
    return response.text();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AcquisitionError(
          'RESPONSE_TOO_LARGE',
          '网页正文超过 5 MB，已停止读取。',
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new AcquisitionError(
      'UNSUPPORTED_RESPONSE',
      '网页正文不是有效的 UTF-8 文本。',
      error,
    );
  }
}

function timedSignal(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timeoutReached = false;
  const abortFromParent = () => {
    controller.abort(parent.reason);
  };
  if (parent.aborted) {
    abortFromParent();
  } else {
    parent.addEventListener('abort', abortFromParent, { once: true });
  }
  const timeout = setTimeout(() => {
    timeoutReached = true;
    controller.abort(
      new DOMException('Request timed out', 'TimeoutError'),
    );
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose: () => {
      clearTimeout(timeout);
      parent.removeEventListener('abort', abortFromParent);
    },
  };
}

function assertResponseOk(response: Response): void {
  if (!response.ok) {
    throw new AcquisitionError(
      'HTTP_ERROR',
      `网页请求失败（${response.status}）。`,
    );
  }
}

function contentType(response: Response): string {
  return (
    response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase() ?? ''
  );
}

function credentialAt(value: string): string {
  if (
    value.length > 16_384 ||
    value !== value.trim() ||
    hasAsciiControl(value)
  ) {
    throw new AcquisitionError(
      'INVALID_INPUT',
      'Reader 密钥格式无效。',
    );
  }
  return value;
}

function normalizeTitle(value: string, sourceUrl: string): string {
  const title = value.replace(/\s+/gu, ' ').trim();
  if (title.length > 500) {
    return title.slice(0, 500);
  }
  return title.length > 0 ? title : titleFromUrl(sourceUrl);
}

function titleFromUrl(sourceUrl: string): string {
  return new URL(sourceUrl).hostname;
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/gu, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

function timeoutAt(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1_000 ||
    timeout > 120_000
  ) {
    throw new AcquisitionError(
      'INVALID_INPUT',
      '网页请求超时设置无效。',
    );
  }
  return timeout;
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

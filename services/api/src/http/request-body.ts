export const MAX_PROJECT_JSON_BODY_BYTES = 64 * 1_024;
const MAX_JSON_NESTING_DEPTH = 64;

export type HttpRequestErrorCode =
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'VALIDATION_FAILED';

export class HttpRequestError extends Error {
  readonly status: 413 | 415 | 422;
  readonly code: HttpRequestErrorCode;

  constructor(
    status: 413 | 415 | 422,
    code: HttpRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpRequestError';
    this.status = status;
    this.code = code;
  }
}

export async function readBoundedJsonBody(request: Request): Promise<unknown> {
  assertJsonMediaType(request.headers.get('content-type'));
  assertDeclaredLength(request.headers.get('content-length'));

  if (request.body === null) {
    return {};
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_PROJECT_JSON_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw payloadTooLarge();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let rawBody: string;
  try {
    rawBody = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidPayload();
  }

  if (rawBody.trim().length === 0) {
    return {};
  }
  if (exceedsJsonNestingLimit(rawBody)) {
    throw invalidPayload();
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw invalidPayload();
  }
}

function assertJsonMediaType(contentType: string | null): void {
  const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    mediaType !== 'application/json' &&
    !/^application\/[a-z0-9!#$&^_.+-]+\+json$/u.test(mediaType ?? '')
  ) {
    throw new HttpRequestError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'A JSON request body is required',
    );
  }
}

function assertDeclaredLength(contentLength: string | null): void {
  if (contentLength === null) {
    return;
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(contentLength)) {
    throw invalidPayload();
  }
  try {
    if (BigInt(contentLength) > BigInt(MAX_PROJECT_JSON_BODY_BYTES)) {
      throw payloadTooLarge();
    }
  } catch (error) {
    if (error instanceof HttpRequestError) {
      throw error;
    }
    throw invalidPayload();
  }
}

function exceedsJsonNestingLimit(value: string): boolean {
  let depth = 0;
  let escaped = false;
  let inString = false;

  for (const character of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{' || character === '[') {
      depth += 1;
      if (depth > MAX_JSON_NESTING_DEPTH) {
        return true;
      }
    } else if (character === '}' || character === ']') {
      depth -= 1;
    }
  }

  return false;
}

function payloadTooLarge(): HttpRequestError {
  return new HttpRequestError(
    413,
    'PAYLOAD_TOO_LARGE',
    'The request payload exceeds the allowed size',
  );
}

function invalidPayload(): HttpRequestError {
  return new HttpRequestError(
    422,
    'VALIDATION_FAILED',
    'The request payload is invalid',
  );
}

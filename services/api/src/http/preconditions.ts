import { createHash } from 'node:crypto';

export type HttpPreconditionCode =
  | 'PRECONDITION_REQUIRED'
  | 'INVALID_IF_MATCH'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'INVALID_IDEMPOTENCY_KEY';

export class HttpPreconditionError extends Error {
  readonly status: 400 | 428;
  readonly code: HttpPreconditionCode;

  constructor(status: 400 | 428, code: HttpPreconditionCode, message: string) {
    super(message);
    this.name = 'HttpPreconditionError';
    this.status = status;
    this.code = code;
  }
}

export function parseRequiredIfMatch(value: string | undefined): number {
  if (value === undefined || value === '') {
    throw new HttpPreconditionError(
      428,
      'PRECONDITION_REQUIRED',
      'If-Match is required for this mutation',
    );
  }

  const match = /^"([1-9]\d*)"$/u.exec(value);
  if (match === null) {
    throw new HttpPreconditionError(
      400,
      'INVALID_IF_MATCH',
      'If-Match must be one strong positive integer ETag',
    );
  }

  const version = Number(match[1]);
  if (!Number.isSafeInteger(version)) {
    throw new HttpPreconditionError(
      400,
      'INVALID_IF_MATCH',
      'If-Match version is outside the safe integer range',
    );
  }

  return version;
}

export function formatStrongEtag(version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError('Resource version must be a positive safe integer');
  }
  return `"${version}"`;
}

export function parseRequiredIdempotencyKey(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new HttpPreconditionError(
      428,
      'IDEMPOTENCY_KEY_REQUIRED',
      'Idempotency-Key is required for this mutation',
    );
  }

  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(value)) {
    throw new HttpPreconditionError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency-Key must be 8-128 URL-safe printable characters',
    );
  }

  return value;
}

type FingerprintInput = {
  method: string;
  path: string;
  ifMatch?: number;
  body: unknown;
};

export function createRequestFingerprint(input: FingerprintInput): string {
  const canonical = canonicalJson({
    body: input.body,
    ifMatch: input.ifMatch ?? null,
    method: input.method.toUpperCase(),
    path: input.path,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Request fingerprint only accepts finite JSON numbers');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  throw new TypeError('Request fingerprint only accepts JSON-compatible input');
}

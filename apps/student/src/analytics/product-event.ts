export const PRODUCT_EVENT_SCHEMA_VERSION = 1 as const;

export const PRODUCT_EVENT_NAMES = [
  'signup_completed',
  'project_created',
  'file_uploaded',
  'task_defined',
  'evidence_added',
  'outline_created',
  'artifact_generated',
  'artifact_exported',
  'course_completed',
  'second_project_started',
] as const;

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

export interface ProductEvent {
  schemaVersion: typeof PRODUCT_EVENT_SCHEMA_VERSION;
  id: string;
  name: ProductEventName;
  occurredAt: string;
  anonymousId: string;
  userId: string | null;
  workspaceId: string | null;
  projectId: string | null;
  idempotencyKey: string;
  sourceVersion: string;
}

export interface CreateProductEventInput {
  name: ProductEventName;
  idempotencyKey: string;
  projectId?: string | null;
}

export interface ProductEventContext {
  anonymousId: string;
  userId?: string | null;
  workspaceId?: string | null;
  sourceVersion: string;
  now?: () => Date;
  idFactory?: () => string;
}

export class ProductEventValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'ProductEventValidationError';
  }
}

const EVENT_KEYS = [
  'schemaVersion',
  'id',
  'name',
  'occurredAt',
  'anonymousId',
  'userId',
  'workspaceId',
  'projectId',
  'idempotencyKey',
  'sourceVersion',
] as const;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_IDENTITY = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu;
const IDEMPOTENCY_KEY = /^[a-z0-9][a-z0-9:._-]{0,199}$/u;
const SOURCE_VERSION = /^[a-z0-9][a-z0-9._+-]{0,63}$/iu;
const ANONYMOUS_STORAGE_KEY = 'zuocheng.analytics.anonymous-id.v1';

export function createProductEvent(
  input: CreateProductEventInput,
  context: ProductEventContext,
): ProductEvent {
  const now = context.now?.() ?? new Date();
  const event = {
    schemaVersion: PRODUCT_EVENT_SCHEMA_VERSION,
    id: context.idFactory?.() ?? createProductEventId(now.valueOf()),
    name: input.name,
    occurredAt: canonicalDate(now, 'occurredAt'),
    anonymousId: context.anonymousId,
    userId: context.userId ?? null,
    workspaceId: context.workspaceId ?? null,
    projectId: input.projectId ?? null,
    idempotencyKey: input.idempotencyKey,
    sourceVersion: context.sourceVersion,
  };
  return parseProductEvent(event);
}

export function parseProductEvent(input: unknown): ProductEvent {
  const event = objectAt(input, 'event');
  assertExactKeys(event, EVENT_KEYS, 'event');
  if (event.schemaVersion !== PRODUCT_EVENT_SCHEMA_VERSION) {
    fail('event.schemaVersion', 'must equal 1');
  }
  const name = stringAt(event.name, 'event.name');
  if (!PRODUCT_EVENT_NAMES.includes(name as ProductEventName)) {
    fail('event.name', 'is unsupported');
  }
  const occurredAt = stringAt(event.occurredAt, 'event.occurredAt');
  canonicalDate(new Date(occurredAt), 'event.occurredAt', occurredAt);
  const idempotencyKey = stringAt(
    event.idempotencyKey,
    'event.idempotencyKey',
  );
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    fail(
      'event.idempotencyKey',
      'must be a lowercase action identity without personal data',
    );
  }
  const sourceVersion = stringAt(
    event.sourceVersion,
    'event.sourceVersion',
  );
  if (!SOURCE_VERSION.test(sourceVersion)) {
    fail('event.sourceVersion', 'must be a safe version token');
  }
  return {
    schemaVersion: PRODUCT_EVENT_SCHEMA_VERSION,
    id: uuidAt(event.id, 'event.id'),
    name: name as ProductEventName,
    occurredAt,
    anonymousId: uuidAt(event.anonymousId, 'event.anonymousId'),
    userId: nullableIdentityAt(event.userId, 'event.userId'),
    workspaceId: nullableIdentityAt(
      event.workspaceId,
      'event.workspaceId',
    ),
    projectId: nullableIdentityAt(event.projectId, 'event.projectId'),
    idempotencyKey,
    sourceVersion,
  };
}

export interface ResolveAnonymousBrowserIdOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  idFactory?: () => string;
}

export function resolveAnonymousBrowserId(
  options: ResolveAnonymousBrowserIdOptions = {},
): string {
  const storage =
    options.storage === undefined ? safeLocalStorage() : options.storage;
  const stored = safeStorageRead(storage, ANONYMOUS_STORAGE_KEY);
  if (stored !== null && UUID.test(stored)) {
    return stored;
  }
  const id = uuidAt(
    options.idFactory?.() ?? createProductEventId(),
    'anonymousId',
  );
  safeStorageWrite(storage, ANONYMOUS_STORAGE_KEY, id);
  return id;
}

export function createProductEventId(
  timestamp = Date.now(),
  cryptoProvider: Crypto | undefined = globalThis.crypto,
): string {
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > 0xffffffffffff
  ) {
    fail('timestamp', 'must fit the UUIDv7 timestamp range');
  }
  if (cryptoProvider === undefined) {
    fail('crypto', 'is required to generate an event identity');
  }
  const bytes = new Uint8Array(16);
  cryptoProvider.getRandomValues(bytes);
  let remaining = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10).join(''),
  ].join('-');
}

function objectAt(
  input: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail(path, 'must be an object');
  }
  return input as Record<string, unknown>;
}

function assertExactKeys(
  object: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const allowed = new Set(keys);
  const extra = Object.keys(object).find((key) => !allowed.has(key));
  if (extra !== undefined) {
    fail(`${path}.${extra}`, 'is an unsupported field');
  }
  const missing = keys.find((key) => !(key in object));
  if (missing !== undefined) {
    fail(`${path}.${missing}`, 'is required');
  }
}

function stringAt(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    fail(path, 'must be a non-empty trimmed string');
  }
  return value;
}

function uuidAt(value: unknown, path: string): string {
  const id = stringAt(value, path);
  if (!UUID.test(id)) {
    fail(path, 'must be a canonical lowercase UUID');
  }
  return id;
}

function nullableIdentityAt(value: unknown, path: string): string | null {
  if (value === null) {
    return null;
  }
  const identity = stringAt(value, path);
  if (!SAFE_IDENTITY.test(identity)) {
    fail(path, 'must be an opaque identity without personal data');
  }
  return identity;
}

function canonicalDate(
  date: Date,
  path: string,
  expected?: string,
): string {
  if (!Number.isFinite(date.valueOf())) {
    fail(path, 'must be a valid timestamp');
  }
  const canonical = date.toISOString();
  if (expected !== undefined && canonical !== expected) {
    fail(path, 'must be a canonical ISO-8601 UTC timestamp');
  }
  return canonical;
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function safeStorageRead(
  storage: Pick<Storage, 'getItem'> | null,
  key: string,
): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeStorageWrite(
  storage: Pick<Storage, 'setItem'> | null,
  key: string,
  value: string,
): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // The runtime identity remains valid when browser storage is unavailable.
  }
}

function fail(path: string, message: string): never {
  throw new ProductEventValidationError(path, message);
}

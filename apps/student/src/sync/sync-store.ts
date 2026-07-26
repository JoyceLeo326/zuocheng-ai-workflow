import {
  SyncError,
  parseEncryptedSyncBundle,
  type SyncAuditAction,
  type SyncAuditEvent,
  type SyncAuditOutcome,
  type SyncLink,
  type SyncOutboxEntry,
  type SyncStore,
} from './sync-domain.js';

const DEFAULT_MAX_AUDIT_EVENTS = 500;
const DATABASE_NAME = 'zuocheng-sync-v1';
const DATABASE_VERSION = 1;
const OUTBOX_STORE = 'outbox';
const LINKS_STORE = 'links';
const AUDIT_STORE = 'audit';
const SHA256 = /^[0-9a-f]{64}$/u;

export interface MemorySyncStoreOptions {
  maxAuditEvents?: number;
}

export class MemorySyncStore implements SyncStore {
  readonly #maxAuditEvents: number;
  readonly #outbox = new Map<string, SyncOutboxEntry>();
  readonly #links = new Map<string, SyncLink>();
  readonly #audit = new Map<string, SyncAuditEvent>();

  constructor(options: MemorySyncStoreOptions = {}) {
    this.#maxAuditEvents = maxAuditAt(options.maxAuditEvents);
  }

  async listOutbox(): Promise<SyncOutboxEntry[]> {
    return [...this.#outbox.values()]
      .map((entry) => clone(parseOutbox(entry)))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
  }

  async putOutbox(input: SyncOutboxEntry): Promise<void> {
    const entry = parseOutbox(input);
    this.#outbox.set(entry.id, clone(entry));
  }

  async deleteOutbox(id: string): Promise<void> {
    this.#outbox.delete(nonEmpty(id, 'outbox.id', 256));
  }

  async getLink(projectId: string): Promise<SyncLink | null> {
    const value = this.#links.get(
      nonEmpty(projectId, 'link.projectId', 256),
    );
    return value === undefined ? null : clone(parseLink(value));
  }

  async putLink(input: SyncLink): Promise<void> {
    const link = parseLink(input);
    this.#links.set(link.projectId, clone(link));
  }

  async deleteLink(projectId: string): Promise<void> {
    this.#links.delete(nonEmpty(projectId, 'link.projectId', 256));
  }

  async listAudit(): Promise<SyncAuditEvent[]> {
    return [...this.#audit.values()]
      .map((event) => clone(parseAudit(event)))
      .sort(
        (left, right) =>
          right.at.localeCompare(left.at) ||
          right.id.localeCompare(left.id),
      );
  }

  async appendAudit(input: SyncAuditEvent): Promise<void> {
    const event = parseAudit(input);
    this.#audit.set(event.id, clone(event));
    trimMapByOldest(this.#audit, this.#maxAuditEvents);
  }
}

export interface IndexedDbSyncStoreOptions
  extends MemorySyncStoreOptions {
  indexedDBFactory?: IDBFactory | null;
  databaseName?: string;
}

export class IndexedDbSyncStore implements SyncStore {
  readonly #database: Promise<IDBDatabase>;
  readonly #maxAuditEvents: number;
  #closed = false;

  constructor(
    indexedDBFactory: IDBFactory,
    databaseName = DATABASE_NAME,
    maxAuditEvents = DEFAULT_MAX_AUDIT_EVENTS,
  ) {
    this.#database = openDatabase(indexedDBFactory, databaseName);
    this.#maxAuditEvents = maxAuditAt(maxAuditEvents);
  }

  async listOutbox(): Promise<SyncOutboxEntry[]> {
    const database = await this.#db();
    const transaction = database.transaction(
      OUTBOX_STORE,
      'readonly',
    );
    const values = (await requestResult(
      transaction.objectStore(OUTBOX_STORE).getAll(),
    )) as unknown[];
    await transactionDone(transaction);
    return values
      .map(parseOutbox)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
  }

  async putOutbox(input: SyncOutboxEntry): Promise<void> {
    await this.#put(OUTBOX_STORE, parseOutbox(input));
  }

  async deleteOutbox(id: string): Promise<void> {
    await this.#delete(
      OUTBOX_STORE,
      nonEmpty(id, 'outbox.id', 256),
    );
  }

  async getLink(projectId: string): Promise<SyncLink | null> {
    const database = await this.#db();
    const transaction = database.transaction(LINKS_STORE, 'readonly');
    const value = await requestResult(
      transaction
        .objectStore(LINKS_STORE)
        .get(nonEmpty(projectId, 'link.projectId', 256)),
    );
    await transactionDone(transaction);
    return value === undefined ? null : parseLink(value);
  }

  async putLink(input: SyncLink): Promise<void> {
    await this.#put(LINKS_STORE, parseLink(input));
  }

  async deleteLink(projectId: string): Promise<void> {
    await this.#delete(
      LINKS_STORE,
      nonEmpty(projectId, 'link.projectId', 256),
    );
  }

  async listAudit(): Promise<SyncAuditEvent[]> {
    const database = await this.#db();
    const transaction = database.transaction(AUDIT_STORE, 'readonly');
    const values = (await requestResult(
      transaction.objectStore(AUDIT_STORE).getAll(),
    )) as unknown[];
    await transactionDone(transaction);
    return values
      .map(parseAudit)
      .sort(
        (left, right) =>
          right.at.localeCompare(left.at) ||
          right.id.localeCompare(left.id),
      );
  }

  async appendAudit(input: SyncAuditEvent): Promise<void> {
    const event = parseAudit(input);
    const database = await this.#db();
    const transaction = database.transaction(AUDIT_STORE, 'readwrite');
    const store = transaction.objectStore(AUDIT_STORE);
    store.put(clone(event));
    const values = (await requestResult(store.getAll())) as unknown[];
    const ordered = values
      .map(parseAudit)
      .sort(
        (left, right) =>
          left.at.localeCompare(right.at) ||
          left.id.localeCompare(right.id),
      );
    for (
      let index = 0;
      index < ordered.length - this.#maxAuditEvents;
      index += 1
    ) {
      store.delete(ordered[index]!.id);
    }
    await transactionDone(transaction);
  }

  close(): void {
    this.#closed = true;
    void this.#database.then((database) => database.close());
  }

  async #put(
    storeName: typeof OUTBOX_STORE | typeof LINKS_STORE,
    value: SyncOutboxEntry | SyncLink,
  ): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(clone(value));
    await transactionDone(transaction);
  }

  async #delete(
    storeName: typeof OUTBOX_STORE | typeof LINKS_STORE,
    key: string,
  ): Promise<void> {
    const database = await this.#db();
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).delete(key);
    await transactionDone(transaction);
  }

  async #db(): Promise<IDBDatabase> {
    if (this.#closed) {
      throw storageError('同步存储已关闭。');
    }
    try {
      return await this.#database;
    } catch (error) {
      if (error instanceof SyncError) {
        throw error;
      }
      throw storageError('无法打开同步存储。', error);
    }
  }
}

export function createIndexedDbSyncStore(
  options: IndexedDbSyncStoreOptions = {},
): IndexedDbSyncStore {
  const indexedDBFactory =
    options.indexedDBFactory === undefined
      ? globalThis.indexedDB
      : options.indexedDBFactory;
  if (indexedDBFactory === null || indexedDBFactory === undefined) {
    throw storageError('当前浏览器无法保存同步队列。');
  }
  return new IndexedDbSyncStore(
    indexedDBFactory,
    options.databaseName ?? DATABASE_NAME,
    maxAuditAt(options.maxAuditEvents),
  );
}

function parseOutbox(input: unknown): SyncOutboxEntry {
  const object = objectAt(input, 'outbox');
  if (object.action !== 'upload') {
    invalid('outbox.action');
  }
  const gistId =
    object.gistId === null
      ? null
      : nonEmpty(object.gistId, 'outbox.gistId', 256);
  const expectedRevision =
    object.expectedRevision === null
      ? null
      : nonEmpty(
          object.expectedRevision,
          'outbox.expectedRevision',
          128,
        );
  if (
    (gistId === null) !== (expectedRevision === null)
  ) {
    invalid('outbox.expectedRevision');
  }
  return {
    id: nonEmpty(object.id, 'outbox.id', 256),
    createdAt: dateAt(object.createdAt, 'outbox.createdAt'),
    action: 'upload',
    projectId: nonEmpty(
      object.projectId,
      'outbox.projectId',
      256,
    ),
    gistId,
    expectedRevision,
    bundle: parseEncryptedSyncBundle(object.bundle),
    localPackageSha256: shaAt(
      object.localPackageSha256,
      'outbox.localPackageSha256',
    ),
  };
}

function parseLink(input: unknown): SyncLink {
  const object = objectAt(input, 'link');
  return {
    projectId: nonEmpty(object.projectId, 'link.projectId', 256),
    gistId: nonEmpty(object.gistId, 'link.gistId', 256),
    remoteRevision: nonEmpty(
      object.remoteRevision,
      'link.remoteRevision',
      128,
    ),
    remoteProjectVersion: positiveInteger(
      object.remoteProjectVersion,
      'link.remoteProjectVersion',
    ),
    remoteProjectUpdatedAt: dateAt(
      object.remoteProjectUpdatedAt,
      'link.remoteProjectUpdatedAt',
    ),
    lastSyncedPackageSha256: shaAt(
      object.lastSyncedPackageSha256,
      'link.lastSyncedPackageSha256',
    ),
    syncedAt: dateAt(object.syncedAt, 'link.syncedAt'),
  };
}

function parseAudit(input: unknown): SyncAuditEvent {
  const object = objectAt(input, 'audit');
  const actions: readonly SyncAuditAction[] = [
    'connect',
    'list',
    'push',
    'pull',
    'delete',
    'flush',
  ];
  const outcomes: readonly SyncAuditOutcome[] = [
    'success',
    'error',
    'conflict',
    'cancelled',
    'queued',
  ];
  if (
    typeof object.action !== 'string' ||
    !actions.includes(object.action as SyncAuditAction)
  ) {
    invalid('audit.action');
  }
  if (
    typeof object.outcome !== 'string' ||
    !outcomes.includes(object.outcome as SyncAuditOutcome)
  ) {
    invalid('audit.outcome');
  }
  return {
    id: nonEmpty(object.id, 'audit.id', 256),
    at: dateAt(object.at, 'audit.at'),
    action: object.action as SyncAuditAction,
    outcome: object.outcome as SyncAuditOutcome,
    projectId:
      object.projectId === null
        ? null
        : nonEmpty(object.projectId, 'audit.projectId', 256),
    gistId:
      object.gistId === null
        ? null
        : nonEmpty(object.gistId, 'audit.gistId', 256),
    summary: nonEmpty(object.summary, 'audit.summary', 500),
  };
}

function openDatabase(
  indexedDBFactory: IDBFactory,
  databaseName: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDBFactory.open(
      databaseName,
      DATABASE_VERSION,
    );
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
        database.createObjectStore(OUTBOX_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(LINKS_STORE)) {
        database.createObjectStore(LINKS_STORE, {
          keyPath: 'projectId',
        });
      }
      if (!database.objectStoreNames.contains(AUDIT_STORE)) {
        database.createObjectStore(AUDIT_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(storageError('无法打开同步存储。', request.error));
    request.onblocked = () =>
      reject(storageError('同步存储升级被其他页面占用。'));
  });
}

function requestResult<T = unknown>(
  request: IDBRequest<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(storageError('同步存储请求失败。', request.error));
  });
}

function transactionDone(
  transaction: IDBTransaction,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        storageError(
          '同步存储事务未完成。',
          transaction.error,
        ),
      );
    transaction.onerror = () => undefined;
  });
}

function objectAt(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(path);
  }
  return value as Record<string, unknown>;
}

function nonEmpty(
  value: unknown,
  path: string,
  maximum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim()
  ) {
    invalid(path);
  }
  return value;
}

function dateAt(value: unknown, path: string): string {
  const timestamp = nonEmpty(value, path, 64);
  const date = new Date(timestamp);
  if (
    !Number.isFinite(date.valueOf()) ||
    date.toISOString() !== timestamp
  ) {
    invalid(path);
  }
  return timestamp;
}

function positiveInteger(value: unknown, path: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    invalid(path);
  }
  return value;
}

function shaAt(value: unknown, path: string): string {
  const hash = nonEmpty(value, path, 64);
  if (!SHA256.test(hash)) {
    invalid(path);
  }
  return hash;
}

function maxAuditAt(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_MAX_AUDIT_EVENTS;
  }
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 10_000
  ) {
    throw new SyncError(
      'INVALID_INPUT',
      '同步记录上限设置无效。',
    );
  }
  return value;
}

function trimMapByOldest(
  map: Map<string, SyncAuditEvent>,
  maximum: number,
): void {
  const ordered = [...map.values()].sort(
    (left, right) =>
      left.at.localeCompare(right.at) ||
      left.id.localeCompare(right.id),
  );
  for (let index = 0; index < ordered.length - maximum; index += 1) {
    map.delete(ordered[index]!.id);
  }
}

function invalid(path: string): never {
  throw new SyncError(
    'STORAGE_UNAVAILABLE',
    `同步存储数据无效：${path}`,
  );
}

function storageError(
  message: string,
  cause?: unknown,
): SyncError {
  return new SyncError('STORAGE_UNAVAILABLE', message, { cause });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

import type { WorkflowAssistantSession } from './workflow-assistant.js';

const DATABASE_NAME = 'zuocheng-workflow-assistant';
const DATABASE_VERSION = 1;
const SESSION_STORE = 'sessions';
const PROJECT_INDEX = 'projectId';
const CREDENTIAL_FIELD =
  /^(?:api[-_]?key|authorization|bearer|client[-_]?secret|secret|password|credential|access[-_]?token|refresh[-_]?token)$/iu;

export type WorkflowAssistantStoreErrorCode =
  | 'INDEXEDDB_UNAVAILABLE'
  | 'INVALID_RECORD'
  | 'PERSISTENCE_FAILED';

export class WorkflowAssistantStoreError extends Error {
  constructor(
    readonly code: WorkflowAssistantStoreErrorCode,
    options?: ErrorOptions,
  ) {
    super(`Workflow assistant persistence failed: ${code}`, options);
    this.name = 'WorkflowAssistantStoreError';
  }
}

export interface WorkflowAssistantStore {
  get(id: string): Promise<WorkflowAssistantSession | null>;
  listByProject(projectId: string): Promise<WorkflowAssistantSession[]>;
  put(session: WorkflowAssistantSession): Promise<void>;
  delete(id: string): Promise<void>;
}

export class MemoryWorkflowAssistantStore
  implements WorkflowAssistantStore
{
  readonly #records: Map<string, WorkflowAssistantSession>;

  constructor(
    records: Map<string, WorkflowAssistantSession> = new Map(),
  ) {
    this.#records = records;
  }

  async get(id: string): Promise<WorkflowAssistantSession | null> {
    const record = this.#records.get(requiredText(id));
    return record === undefined ? null : cloneSession(record);
  }

  async listByProject(
    projectId: string,
  ): Promise<WorkflowAssistantSession[]> {
    const normalizedProjectId = requiredText(projectId);
    return [...this.#records.values()]
      .filter((record) => record.projectId === normalizedProjectId)
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      )
      .map(cloneSession);
  }

  async put(session: WorkflowAssistantSession): Promise<void> {
    const safe = assertPersistableWorkflowSession(session);
    this.#records.set(safe.id, cloneSession(safe));
  }

  async delete(id: string): Promise<void> {
    this.#records.delete(requiredText(id));
  }
}

export type IndexedDbWorkflowAssistantStoreOptions = Readonly<{
  indexedDBFactory?: IDBFactory | null;
  databaseName?: string;
}>;

export function createIndexedDbWorkflowAssistantStore(
  options: IndexedDbWorkflowAssistantStoreOptions = {},
): IndexedDbWorkflowAssistantStore {
  const factory =
    options.indexedDBFactory === undefined
      ? globalThis.indexedDB
      : options.indexedDBFactory;
  if (factory === undefined || factory === null) {
    throw new WorkflowAssistantStoreError('INDEXEDDB_UNAVAILABLE');
  }
  return new IndexedDbWorkflowAssistantStore(
    factory,
    options.databaseName ?? DATABASE_NAME,
  );
}

export class IndexedDbWorkflowAssistantStore
  implements WorkflowAssistantStore
{
  readonly #database: Promise<IDBDatabase>;

  constructor(factory: IDBFactory, databaseName = DATABASE_NAME) {
    this.#database = openDatabase(factory, requiredText(databaseName));
  }

  async get(id: string): Promise<WorkflowAssistantSession | null> {
    const database = await this.#database;
    const transaction = database.transaction(SESSION_STORE, 'readonly');
    const completed = transactionComplete(transaction);
    const result = await requestResult(
      transaction.objectStore(SESSION_STORE).get(requiredText(id)),
    );
    await completed;
    return result === undefined
      ? null
      : cloneSession(assertPersistableWorkflowSession(result));
  }

  async listByProject(
    projectId: string,
  ): Promise<WorkflowAssistantSession[]> {
    const database = await this.#database;
    const transaction = database.transaction(SESSION_STORE, 'readonly');
    const completed = transactionComplete(transaction);
    const result = await requestResult(
      transaction
        .objectStore(SESSION_STORE)
        .index(PROJECT_INDEX)
        .getAll(requiredText(projectId)),
    );
    await completed;
    if (!Array.isArray(result)) {
      throw new WorkflowAssistantStoreError('INVALID_RECORD');
    }
    return result
      .map(assertPersistableWorkflowSession)
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      )
      .map(cloneSession);
  }

  async put(session: WorkflowAssistantSession): Promise<void> {
    const safe = cloneSession(assertPersistableWorkflowSession(session));
    const database = await this.#database;
    const transaction = database.transaction(SESSION_STORE, 'readwrite');
    const completed = transactionComplete(transaction);
    await requestResult(transaction.objectStore(SESSION_STORE).put(safe));
    await completed;
  }

  async delete(id: string): Promise<void> {
    const database = await this.#database;
    const transaction = database.transaction(SESSION_STORE, 'readwrite');
    const completed = transactionComplete(transaction);
    await requestResult(
      transaction.objectStore(SESSION_STORE).delete(requiredText(id)),
    );
    await completed;
  }
}

export function assertPersistableWorkflowSession(
  value: unknown,
): WorkflowAssistantSession {
  assertNoCredentialFields(value);
  if (!isPlainObject(value)) {
    throw new WorkflowAssistantStoreError('INVALID_RECORD');
  }
  const record = value as Partial<WorkflowAssistantSession>;
  if (
    !isRequiredText(record.id) ||
    !isRequiredText(record.projectId) ||
    !isRequiredText(record.workflow) ||
    !isIsoDateTime(record.createdAt) ||
    !isIsoDateTime(record.updatedAt) ||
    !isPlainObject(record.inputSnapshot) ||
    !isPlainObject(record.definition) ||
    !isPlainObject(record.run) ||
    !isPlainObject(record.application) ||
    record.run.id !== record.id ||
    record.inputSnapshot.projectId !== record.projectId
  ) {
    throw new WorkflowAssistantStoreError('INVALID_RECORD');
  }
  try {
    return JSON.parse(JSON.stringify(value)) as WorkflowAssistantSession;
  } catch (error) {
    throw new WorkflowAssistantStoreError('INVALID_RECORD', {
      cause: error,
    });
  }
}

async function openDatabase(
  factory: IDBFactory,
  databaseName: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, DATABASE_VERSION);
    } catch (error) {
      reject(
        new WorkflowAssistantStoreError('PERSISTENCE_FAILED', {
          cause: error,
        }),
      );
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(SESSION_STORE)
        ? request.transaction!.objectStore(SESSION_STORE)
        : database.createObjectStore(SESSION_STORE, { keyPath: 'id' });
      if (!store.indexNames.contains(PROJECT_INDEX)) {
        store.createIndex(PROJECT_INDEX, PROJECT_INDEX, { unique: false });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(
        new WorkflowAssistantStoreError('PERSISTENCE_FAILED', {
          cause: request.error,
        }),
      );
    };
    request.onblocked = () => {
      reject(new WorkflowAssistantStoreError('PERSISTENCE_FAILED'));
    };
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(
        new WorkflowAssistantStoreError('PERSISTENCE_FAILED', {
          cause: request.error,
        }),
      );
    };
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onabort = () => {
      reject(
        new WorkflowAssistantStoreError('PERSISTENCE_FAILED', {
          cause: transaction.error,
        }),
      );
    };
    transaction.onerror = () => {
      reject(
        new WorkflowAssistantStoreError('PERSISTENCE_FAILED', {
          cause: transaction.error,
        }),
      );
    };
  });
}

function cloneSession(
  session: WorkflowAssistantSession,
): WorkflowAssistantSession {
  return JSON.parse(JSON.stringify(session)) as WorkflowAssistantSession;
}

function assertNoCredentialFields(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoCredentialFields(item, seen);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL_FIELD.test(key)) {
      throw new WorkflowAssistantStoreError('INVALID_RECORD');
    }
    assertNoCredentialFields(item, seen);
  }
}

function requiredText(value: string): string {
  if (!isRequiredText(value)) {
    throw new WorkflowAssistantStoreError('INVALID_RECORD');
  }
  return value;
}

function isRequiredText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim()
  );
}

function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

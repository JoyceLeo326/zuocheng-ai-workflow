import {
  AdminConflictError,
  AdminValidationError,
  applyAdminCommand,
  createEmptyAdminSnapshot,
  isAdminSnapshot,
  type AdminCommand,
  type AdminSnapshot,
} from './admin-domain.js';

const DATABASE_NAME = 'zuocheng-admin';
const DATABASE_VERSION = 1;
const STORE_NAME = 'snapshots';
const SNAPSHOT_KEY = 'primary';

export interface AdminRepository {
  readonly mode: 'local' | 'remote';
  readonly readOnly: boolean;
  load(): Promise<AdminSnapshot>;
  save(snapshot: AdminSnapshot, expectedVersion: number): Promise<void>;
}

export interface AdminRuntime {
  now: () => string;
  createId: () => string;
  isOnline: () => boolean;
}

export interface AdminServiceStatus {
  id: 'network' | 'local-storage' | 'admin-api';
  label: string;
  status: 'healthy' | 'degraded' | 'unavailable' | 'unconfigured';
  detail: string;
  observedAt: string;
}

export interface AdminLoadResult {
  snapshot: AdminSnapshot;
  connectivity: 'online' | 'offline';
  repositoryMode: AdminRepository['mode'];
  readOnly: boolean;
  services: AdminServiceStatus[];
}

export class AdminPermissionError extends Error {}

export const createBrowserAdminRuntime = (): AdminRuntime => ({
  now: () => new Date().toISOString(),
  createId: () => crypto.randomUUID(),
  isOnline: () => navigator.onLine,
});

export class InMemoryAdminRepository implements AdminRepository {
  readonly mode = 'local' as const;
  readonly readOnly = false;
  #snapshot: AdminSnapshot;

  constructor(snapshot: AdminSnapshot) {
    this.#snapshot = structuredClone(snapshot);
  }

  async load(): Promise<AdminSnapshot> {
    return structuredClone(this.#snapshot);
  }

  async save(snapshot: AdminSnapshot, expectedVersion: number): Promise<void> {
    if (this.#snapshot.version !== expectedVersion) {
      throw new AdminConflictError(expectedVersion, this.#snapshot.version);
    }
    this.#snapshot = structuredClone(snapshot);
  }
}

export class IndexedDbAdminRepository implements AdminRepository {
  readonly mode = 'local' as const;
  readonly readOnly = false;
  readonly #databasePromise: Promise<IDBDatabase>;
  readonly #now: () => string;

  constructor(
    indexedDBFactory: IDBFactory,
    now: () => string,
    databaseName = DATABASE_NAME,
  ) {
    this.#databasePromise = openDatabase(indexedDBFactory, databaseName);
    this.#now = now;
  }

  async load(): Promise<AdminSnapshot> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const stored = await requestToPromise<unknown>(
      transaction.objectStore(STORE_NAME).get(SNAPSHOT_KEY),
    );
    await transactionDone(transaction);
    if (stored === undefined) {
      return createEmptyAdminSnapshot(this.#now());
    }
    if (!isAdminSnapshot(stored)) {
      throw new AdminValidationError(
        '本地管理数据格式不受支持，请导出当前数据库后联系管理员。',
      );
    }
    return structuredClone(stored);
  }

  async save(snapshot: AdminSnapshot, expectedVersion: number): Promise<void> {
    const database = await this.#databasePromise;
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const stored = await requestToPromise<unknown>(store.get(SNAPSHOT_KEY));
    const currentVersion =
      stored === undefined
        ? 1
        : isAdminSnapshot(stored)
          ? stored.version
          : Number.NaN;
    if (currentVersion !== expectedVersion) {
      transaction.abort();
      throw new AdminConflictError(expectedVersion, currentVersion);
    }
    store.put(structuredClone(snapshot), SNAPSHOT_KEY);
    await transactionDone(transaction);
  }
}

export class HttpAdminRepository implements AdminRepository {
  readonly mode = 'remote' as const;
  readonly readOnly: boolean;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: {
    baseUrl: string;
    readOnly?: boolean;
    fetchImplementation?: typeof fetch;
  }) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.readOnly = options.readOnly ?? false;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async load(): Promise<AdminSnapshot> {
    const response = await this.#fetch(`${this.#baseUrl}/admin/snapshot`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw await responseError(response);
    }
    const payload: unknown = await response.json();
    if (!isAdminSnapshot(payload)) {
      throw new AdminValidationError('管理 API 返回了不受支持的数据格式。');
    }
    return payload;
  }

  async save(snapshot: AdminSnapshot, expectedVersion: number): Promise<void> {
    if (this.readOnly) {
      throw new AdminValidationError('当前管理 API 为只读模式。');
    }
    const response = await this.#fetch(`${this.#baseUrl}/admin/snapshot`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': `"${String(expectedVersion)}"`,
      },
      body: JSON.stringify(snapshot),
    });
    if (response.status === 409 || response.status === 412) {
      throw new AdminConflictError(expectedVersion, snapshot.version);
    }
    if (!response.ok) {
      throw await responseError(response);
    }
  }
}

export class AdminService {
  readonly #repository: AdminRepository;
  readonly #runtime: AdminRuntime;

  constructor(repository: AdminRepository, runtime: AdminRuntime) {
    this.#repository = repository;
    this.#runtime = runtime;
  }

  async load(): Promise<AdminLoadResult> {
    const snapshot = await this.#repository.load();
    const online = this.#runtime.isOnline();
    const observedAt = this.#runtime.now();
    const remote = this.#repository.mode === 'remote';
    return {
      snapshot,
      connectivity: online ? 'online' : 'offline',
      repositoryMode: this.#repository.mode,
      readOnly: this.#repository.readOnly,
      services: [
        {
          id: 'network',
          label: '网络连接',
          status: online ? 'healthy' : 'unavailable',
          detail: online ? '浏览器报告网络可用。' : '当前离线。',
          observedAt,
        },
        {
          id: 'local-storage',
          label: '本地持久化',
          status: remote ? 'unconfigured' : 'healthy',
          detail: remote
            ? '当前使用管理 API。'
            : 'IndexedDB 已完成读取。',
          observedAt,
        },
        {
          id: 'admin-api',
          label: '管理 API',
          status: remote
            ? online
              ? 'healthy'
              : 'unavailable'
            : 'unconfigured',
          detail: remote
            ? online
              ? '已完成受保护快照读取。'
              : '离线时无法访问远端管理数据。'
            : '未配置管理 API，数据只保存在当前浏览器。',
          observedAt,
        },
      ],
    };
  }

  async execute(command: AdminCommand): Promise<AdminSnapshot> {
    if (this.#repository.readOnly) {
      throw new AdminValidationError('当前数据源为只读，不能执行修改。');
    }
    const current = await this.#repository.load();
    const next = applyAdminCommand(current, command, {
      now: this.#runtime.now(),
      createId: this.#runtime.createId,
    });
    await this.#repository.save(next, current.version);
    return next;
  }

  async replaceWithImportedSnapshot(
    value: unknown,
    confirmation: string,
    actor: string,
  ): Promise<AdminSnapshot> {
    if (this.#repository.readOnly) {
      throw new AdminValidationError('当前数据源为只读，不能导入。');
    }
    if (!isAdminSnapshot(value)) {
      throw new AdminValidationError('所选文件不是有效的管理后台数据包。');
    }
    if (confirmation.trim() !== '导入并覆盖') {
      throw new AdminValidationError('请输入“导入并覆盖”确认操作。');
    }
    const normalizedActor = actor.trim();
    if (normalizedActor.length === 0) {
      throw new AdminValidationError('导入前请填写操作人标识。');
    }
    const current = await this.#repository.load();
    const imported = structuredClone(value);
    imported.version = current.version + 1;
    imported.updatedAt = this.#runtime.now();
    imported.auditEvents.push({
      id: this.#runtime.createId(),
      sequence: imported.auditEvents.length + 1,
      actor: normalizedActor,
      action: 'snapshot.import',
      targetType: 'system',
      targetId: 'admin-snapshot',
      outcome: 'success',
      summary: '导入并覆盖管理后台数据集',
      createdAt: imported.updatedAt,
    });
    await this.#repository.save(imported, current.version);
    return imported;
  }
}

export function createBrowserAdminRepository(
  runtime: AdminRuntime,
): AdminRepository {
  const configuredUrl = import.meta.env.VITE_ADMIN_API_URL?.trim();
  if (configuredUrl !== undefined && configuredUrl.length > 0) {
    return new HttpAdminRepository({
      baseUrl: configuredUrl,
      readOnly: import.meta.env.VITE_ADMIN_API_READ_ONLY === 'true',
    });
  }
  if (globalThis.indexedDB === undefined) {
    const unavailable = new AdminValidationError(
      '此浏览器不支持 IndexedDB，无法持久化管理数据。',
    );
    return {
      mode: 'local',
      readOnly: true,
      load: async () => {
        throw unavailable;
      },
      save: async () => {
        throw unavailable;
      },
    };
  }
  return new IndexedDbAdminRepository(globalThis.indexedDB, runtime.now);
}

function openDatabase(
  indexedDBFactory: IDBFactory,
  databaseName: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDBFactory.open(databaseName, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('无法打开管理后台本地数据库。'));
    request.onblocked = () =>
      reject(new Error('管理后台数据库升级被其他标签页阻止。'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('管理后台数据库操作失败。'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('管理后台数据库事务失败。'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('管理后台数据库事务已中止。'));
  });
}

async function responseError(response: Response): Promise<Error> {
  let message = `管理 API 请求失败（${String(response.status)}）。`;
  try {
    const payload: unknown = await response.json();
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'message' in payload &&
      typeof payload.message === 'string'
    ) {
      message = payload.message;
    }
  } catch {
    // The status code remains the truthful fallback when no JSON body exists.
  }
  if (response.status === 401 || response.status === 403) {
    return new AdminPermissionError(message);
  }
  return new Error(message);
}

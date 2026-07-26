import { describe, expect, it } from 'vitest';
import {
  MemoryWorkflowAssistantStore,
  WorkflowAssistantStoreError,
  assertPersistableWorkflowSession,
  createIndexedDbWorkflowAssistantStore,
} from './workflow-assistant-store.js';
import type { WorkflowAssistantSession } from './workflow-assistant.js';

function session(id = 'run-1'): WorkflowAssistantSession {
  return {
    id,
    projectId: '01900000-0000-7000-8000-000000000101',
    workflow: 'outline',
    createdAt: '2026-07-27T01:00:00.000Z',
    updatedAt: '2026-07-27T01:00:00.000Z',
    inputSnapshot: {
      projectId: '01900000-0000-7000-8000-000000000101',
      projectVersion: 1,
      taskDefinitionVersion: 1,
      capturedAt: '2026-07-27T01:00:00.000Z',
      taskDefinition: {
        taskName: '三页汇报',
        audience: '教师',
        dueAt: '2026-08-15T09:00:00.000Z',
        lengthTarget: { unit: 'pages', value: 3 },
        presentationDurationMinutes: 6,
        outputFormats: ['pptx'],
        rubric: [],
        tone: '清晰',
        mustInclude: [],
        mustAvoid: [],
      },
      sourceChunks: [
        {
          id: 'chunk-1',
          sourceFileId: 'file-1',
          sourceFileVersion: 1,
          pageNumber: 1,
          pageLabel: '1',
          characterStart: 0,
          characterEnd: 4,
          text: '资料内容',
          contentSha256: 'a'.repeat(64),
        },
      ],
      evidenceCards: [
        {
          id: 'evidence-1',
          sourceChunkId: 'chunk-1',
          quote: '资料',
          kind: 'fact',
          note: '',
          citation: '第 1 页',
          status: 'verified',
          stance: 'support',
          confirmationStatus: 'confirmed',
        },
      ],
      outlines: [],
    },
    definition: {
      idempotencyKey: 'request-1',
      provider: {
        id: 'provider-1',
        kind: 'byok-openai-compatible',
        displayName: '个人模型',
        endpoint: 'https://models.example.test/v1',
        model: 'example',
      },
      promptVersion: 'workflow-assistant/1',
      prompt: '生成候选',
      input: { projectId: '01900000-0000-7000-8000-000000000101' },
      inputVersions: { project: 1 },
      retrievedChunkIds: ['chunk-1'],
      availableEvidenceCardIds: ['evidence-1'],
      lockedPaths: [],
      schemaVersion: 'workflow-assistant/1',
      estimated: null,
    },
    run: {
      id: 'run-1',
      idempotencyKey: 'request-1',
      parentRunId: null,
      attempt: 1,
      provider: {
        id: 'provider-1',
        kind: 'byok-openai-compatible',
        endpoint: 'https://models.example.test/v1',
      },
      model: 'example',
      promptVersion: 'workflow-assistant/1',
      inputVersions: { project: 1 },
      retrievedChunkIds: ['chunk-1'],
      schemaVersion: 'workflow-assistant/1',
      tokenUsage: null,
      estimated: null,
      actualCost: null,
      times: {
        createdAt: '2026-07-27T01:00:00.000Z',
        queuedAt: '2026-07-27T01:00:00.000Z',
        updatedAt: '2026-07-27T01:00:00.000Z',
        startedAt: null,
        waitingForReviewAt: null,
        completedAt: null,
        failedAt: null,
        cancelledAt: null,
        quotaExhaustedAt: null,
        staleAt: null,
      },
      errorCode: null,
      status: 'queued',
      candidate: null,
      claims: [],
      patches: [],
    },
    candidate: null,
    application: {
      status: 'not_started',
      appliedUnitIds: [],
      lastErrorCode: null,
    },
  };
}

describe('workflow assistant persistence', () => {
  it('clones records across store instances and supports project-scoped listing', async () => {
    const database = new Map<string, WorkflowAssistantSession>();
    const first = new MemoryWorkflowAssistantStore(database);
    await first.put(session());

    const restored = await new MemoryWorkflowAssistantStore(database).get(
      'run-1',
    );
    expect(restored).toEqual(session());
    expect(restored).not.toBe(database.get('run-1'));
    await expect(first.listByProject(session().projectId)).resolves.toHaveLength(
      1,
    );
  });

  it('rejects plaintext credentials anywhere in a record', () => {
    const unsafe = {
      ...session(),
      inputSnapshot: {
        ...session().inputSnapshot,
        nested: { apiKey: 'sk-must-not-persist' },
      },
    };
    expect(() => assertPersistableWorkflowSession(unsafe)).toThrowError(
      WorkflowAssistantStoreError,
    );
  });

  it('fails closed when IndexedDB is unavailable', () => {
    expect(() =>
      createIndexedDbWorkflowAssistantStore({
        indexedDBFactory: null,
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'INDEXEDDB_UNAVAILABLE' }),
    );
  });

  it('persists and restores a review record through the IndexedDB adapter', async () => {
    const indexedDBFactory = createTestIndexedDbFactory();
    const first = createIndexedDbWorkflowAssistantStore({
      indexedDBFactory,
      databaseName: 'assistant-refresh-test',
    });
    const queued = session();
    const waiting: WorkflowAssistantSession = {
      ...queued,
      run: {
        ...queued.run,
        status: 'waiting_for_review',
        candidate: {
          value: {
            kind: 'outline_options',
            completeness: 'complete',
            warnings: [],
            options: [],
          },
          claims: [],
          patches: [],
        },
      },
    };
    await first.put(waiting);

    const refreshed = createIndexedDbWorkflowAssistantStore({
      indexedDBFactory,
      databaseName: 'assistant-refresh-test',
    });
    await expect(refreshed.get(waiting.id)).resolves.toEqual(waiting);
    await expect(
      refreshed.listByProject(waiting.projectId),
    ).resolves.toEqual([waiting]);
  });
});

type TestRequest<T> = {
  result: T;
  error: DOMException | null;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
};

type TestOpenRequest = {
  result: IDBDatabase;
  error: DOMException | null;
  transaction: TestTransaction;
  onupgradeneeded: ((event: Event) => void) | null;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onblocked: ((event: Event) => void) | null;
};

type TestTransaction = {
  error: DOMException | null;
  oncomplete: ((event: Event) => void) | null;
  onabort: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  objectStore(name: string): TestObjectStore;
};

type TestObjectStore = {
  indexNames: { contains(name: string): boolean };
  createIndex(name: string): void;
  get(id: string): TestRequest<WorkflowAssistantSession | undefined>;
  getAll(): TestRequest<WorkflowAssistantSession[]>;
  put(value: WorkflowAssistantSession): TestRequest<string>;
  delete(id: string): TestRequest<undefined>;
  index(name: string): {
    getAll(projectId: string): TestRequest<WorkflowAssistantSession[]>;
  };
};

function createTestIndexedDbFactory(): IDBFactory {
  const databases = new Map<
    string,
    Map<string, WorkflowAssistantSession>
  >();
  return {
    open(name: string) {
      const isUpgrade = !databases.has(name);
      const records =
        databases.get(name) ??
        new Map<string, WorkflowAssistantSession>();
      databases.set(name, records);
      const database = createTestDatabase(records);
      const request: TestOpenRequest = {
        result: database,
        error: null,
        transaction: createTestTransaction(records),
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      queueMicrotask(() => {
        if (isUpgrade) {
          request.onupgradeneeded?.(new Event('upgradeneeded'));
        }
        request.onsuccess?.(new Event('success'));
      });
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

function createTestDatabase(
  records: Map<string, WorkflowAssistantSession>,
): IDBDatabase {
  let storeCreated = false;
  return {
    objectStoreNames: {
      contains: () => storeCreated,
    },
    createObjectStore() {
      storeCreated = true;
      return createTestObjectStore(
        records,
        createTestTransaction(records),
      );
    },
    transaction() {
      return createTestTransaction(records) as unknown as IDBTransaction;
    },
  } as unknown as IDBDatabase;
}

function createTestTransaction(
  records: Map<string, WorkflowAssistantSession>,
): TestTransaction {
  const transaction: TestTransaction = {
    error: null,
    oncomplete: null,
    onabort: null,
    onerror: null,
    objectStore() {
      return createTestObjectStore(records, transaction);
    },
  };
  return transaction;
}

function createTestObjectStore(
  records: Map<string, WorkflowAssistantSession>,
  transaction: TestTransaction,
): TestObjectStore {
  let projectIndexCreated = false;
  return {
    indexNames: {
      contains: () => projectIndexCreated,
    },
    createIndex() {
      projectIndexCreated = true;
    },
    get(id) {
      return request(records.get(id), transaction);
    },
    getAll() {
      return request([...records.values()], transaction);
    },
    put(value) {
      records.set(value.id, JSON.parse(JSON.stringify(value)));
      return request(value.id, transaction);
    },
    delete(id) {
      records.delete(id);
      return request(undefined, transaction);
    },
    index() {
      return {
        getAll(projectId) {
          return request(
            [...records.values()].filter(
              (record) => record.projectId === projectId,
            ),
            transaction,
          );
        },
      };
    },
  };
}

function request<T>(
  result: T,
  transaction: TestTransaction,
): TestRequest<T> {
  const pending: TestRequest<T> = {
    result,
    error: null,
    onsuccess: null,
    onerror: null,
  };
  queueMicrotask(() => {
    pending.onsuccess?.(new Event('success'));
    setTimeout(() => {
      transaction.oncomplete?.(new Event('complete'));
    }, 0);
  });
  return pending;
}

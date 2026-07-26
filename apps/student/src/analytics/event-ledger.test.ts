import { describe, expect, it } from 'vitest';
import {
  AnalyticsLedgerUnavailableError,
  MemoryProductEventLedger,
  createIndexedDbProductEventLedger,
  type ProductEventRecord,
} from './event-ledger.js';
import { createProductEvent } from './product-event.js';
import { createProductEventRecorder } from './event-recorder.js';

const ids = [
  '019b0000-0000-7000-8000-000000000011',
  '019b0000-0000-7000-8000-000000000012',
  '019b0000-0000-7000-8000-000000000013',
];

function recorder(ledger = new MemoryProductEventLedger()) {
  let index = 0;
  return {
    ledger,
    recorder: createProductEventRecorder({
      ledger,
      context: {
        anonymousId: '019b0000-0000-7000-8000-000000000010',
        sourceVersion: 'student-1.0.0',
      },
      now: () => new Date('2026-07-27T04:05:00.000Z'),
      idFactory: () => ids[index++]!,
    }),
  };
}

describe('product event ledger', () => {
  it('deduplicates idempotency keys and leaves new events in the outbox', async () => {
    const setup = recorder();

    const first = await setup.recorder.record({
      name: 'project_created',
      projectId: 'project-001',
      idempotencyKey: 'project_created:project-001:1',
    });
    const duplicate = await setup.recorder.record({
      name: 'project_created',
      projectId: 'project-001',
      idempotencyKey: 'project_created:project-001:1',
    });

    expect(first.status).toBe('recorded');
    expect(duplicate).toEqual({
      status: 'duplicate',
      record: first.record,
    });
    await expect(setup.ledger.list()).resolves.toHaveLength(1);
    await expect(setup.ledger.pending(50)).resolves.toEqual([
      expect.objectContaining({
        delivery: {
          state: 'pending',
          attemptCount: 0,
          lastAttemptAt: null,
          lastFailureCode: null,
          deliveredAt: null,
        },
      }),
    ]);
  });

  it('tracks explicit delivery attempts and exports deterministic JSON batches', async () => {
    const setup = recorder();
    const first = await setup.recorder.record({
      name: 'artifact_exported',
      projectId: 'project-001',
      idempotencyKey: 'artifact_exported:project-001:operation-001',
    });

    await setup.ledger.markFailed(
      [first.record.event.id],
      'NETWORK',
      '2026-07-27T04:06:00.000Z',
    );
    expect((await setup.ledger.pending(10))[0]!.delivery).toMatchObject({
      state: 'pending',
      attemptCount: 1,
      lastFailureCode: 'NETWORK',
    });
    await setup.ledger.markDelivered(
      [first.record.event.id],
      '2026-07-27T04:07:00.000Z',
    );
    expect(await setup.ledger.pending(10)).toEqual([]);

    const exported = JSON.parse(await setup.ledger.exportJson()) as {
      format: string;
      schemaVersion: number;
      records: unknown[];
    };
    expect(exported).toMatchObject({
      format: 'zuocheng-product-events',
      schemaVersion: 1,
    });
    expect(exported.records).toHaveLength(1);
    expect(JSON.stringify(exported)).not.toMatch(
      /task body|file contents|api[_ -]?key/iu,
    );
  });

  it('fails explicitly when IndexedDB cannot be opened', () => {
    expect(() =>
      createIndexedDbProductEventLedger({
        indexedDBFactory: null,
      }),
    ).toThrow(AnalyticsLedgerUnavailableError);
  });

  it('persists and deduplicates records across IndexedDB ledger sessions', async () => {
    const factory = createTestIndexedDbFactory();
    const databaseName = 'analytics-ledger-test';
    const event = createProductEvent(
      {
        name: 'evidence_added',
        projectId: 'project-001',
        idempotencyKey: 'evidence_added:evidence-001:1',
      },
      {
        anonymousId: '019b0000-0000-7000-8000-000000000010',
        sourceVersion: 'student-1.0.0',
        now: () => new Date('2026-07-27T04:05:00.000Z'),
        idFactory: () => ids[0]!,
      },
    );
    const first = createIndexedDbProductEventLedger({
      indexedDBFactory: factory,
      databaseName,
    });
    await expect(first.append(event)).resolves.toMatchObject({
      status: 'recorded',
    });
    first.close();

    const reopened = createIndexedDbProductEventLedger({
      indexedDBFactory: factory,
      databaseName,
    });
    await expect(reopened.list()).resolves.toEqual([
      expect.objectContaining({ event }),
    ]);
    await expect(reopened.append(event)).resolves.toMatchObject({
      status: 'duplicate',
    });
    await expect(reopened.list()).resolves.toHaveLength(1);
  });

  it('rejects arbitrary recorder fields instead of silently serializing them', async () => {
    const setup = recorder();
    await expect(
      setup.recorder.record({
        name: 'task_defined',
        projectId: 'project-001',
        idempotencyKey: 'task_defined:project-001:1',
        taskBody: 'private details',
      } as never),
    ).rejects.toThrow('unsupported field');
    await expect(setup.ledger.list()).resolves.toEqual([]);
  });
});

interface TestRequest<T> {
  result: T;
  error: DOMException | null;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

interface TestOpenRequest extends TestRequest<IDBDatabase> {
  transaction: IDBTransaction | null;
  onupgradeneeded: ((event: Event) => void) | null;
  onblocked: ((event: Event) => void) | null;
}

interface TestTransaction {
  error: DOMException | null;
  oncomplete: ((event: Event) => void) | null;
  onabort: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  objectStore(): TestObjectStore;
}

interface TestObjectStore {
  createIndex(): void;
  index(): {
    get(key: string): TestRequest<ProductEventRecord | undefined>;
  };
  get(id: string): TestRequest<ProductEventRecord | undefined>;
  getAll(): TestRequest<ProductEventRecord[]>;
  add(value: ProductEventRecord): TestRequest<string>;
  put(value: ProductEventRecord): TestRequest<string>;
  delete(id: string): TestRequest<undefined>;
}

function createTestIndexedDbFactory(): IDBFactory {
  const databases = new Map<
    string,
    Map<string, ProductEventRecord>
  >();
  return {
    open(name: string) {
      const isUpgrade = !databases.has(name);
      const records =
        databases.get(name) ?? new Map<string, ProductEventRecord>();
      databases.set(name, records);
      const database = createTestDatabase(records);
      const request: TestOpenRequest = {
        result: database,
        error: null,
        transaction: null,
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
  records: Map<string, ProductEventRecord>,
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
    close() {},
  } as unknown as IDBDatabase;
}

function createTestTransaction(
  records: Map<string, ProductEventRecord>,
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
  records: Map<string, ProductEventRecord>,
  transaction: TestTransaction,
): TestObjectStore {
  return {
    createIndex() {},
    index() {
      return {
        get(key) {
          return request(
            [...records.values()].find(
              (record) => record.event.idempotencyKey === key,
            ),
            transaction,
          );
        },
      };
    },
    get(id) {
      return request(records.get(id), transaction);
    },
    getAll() {
      return request([...records.values()], transaction);
    },
    add(value) {
      records.set(value.event.id, structuredClone(value));
      return request(value.event.id, transaction);
    },
    put(value) {
      records.set(value.event.id, structuredClone(value));
      return request(value.event.id, transaction);
    },
    delete(id) {
      records.delete(id);
      return request(undefined, transaction);
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

import {
  parseProductEvent,
  type ProductEvent,
} from './product-event.js';

const DATABASE_NAME = 'zuocheng-product-events';
const DATABASE_VERSION = 1;
const RECORDS_STORE = 'records';
const IDEMPOTENCY_INDEX = 'by-idempotency';
const DELIVERY_INDEX = 'by-delivery';

export type ProductEventDeliveryState = 'pending' | 'delivered';
export type ProductEventDeliveryFailureCode =
  | 'NETWORK'
  | 'HTTP_ERROR'
  | 'ABORTED'
  | 'LEDGER_ERROR';

export interface ProductEventDelivery {
  state: ProductEventDeliveryState;
  attemptCount: number;
  lastAttemptAt: string | null;
  lastFailureCode: ProductEventDeliveryFailureCode | null;
  deliveredAt: string | null;
}

export interface ProductEventRecord {
  event: ProductEvent;
  delivery: ProductEventDelivery;
}

export type AppendProductEventResult =
  | Readonly<{ status: 'recorded'; record: ProductEventRecord }>
  | Readonly<{ status: 'duplicate'; record: ProductEventRecord }>;

export interface ProductEventLedger {
  append(event: ProductEvent): Promise<AppendProductEventResult>;
  list(): Promise<ProductEventRecord[]>;
  pending(limit: number): Promise<ProductEventRecord[]>;
  markFailed(
    eventIds: readonly string[],
    code: ProductEventDeliveryFailureCode,
    attemptedAt: string,
  ): Promise<void>;
  markDelivered(
    eventIds: readonly string[],
    deliveredAt: string,
  ): Promise<void>;
  deleteDelivered(): Promise<number>;
  exportJson(): Promise<string>;
  close(): void;
}

export class AnalyticsLedgerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AnalyticsLedgerError';
  }
}

export class AnalyticsLedgerUnavailableError extends AnalyticsLedgerError {
  constructor() {
    super('IndexedDB is unavailable for the product event ledger');
    this.name = 'AnalyticsLedgerUnavailableError';
  }
}

export class MemoryProductEventLedger implements ProductEventLedger {
  readonly #records = new Map<string, ProductEventRecord>();
  readonly #idempotency = new Map<string, string>();

  async append(input: ProductEvent): Promise<AppendProductEventResult> {
    const event = parseProductEvent(input);
    const existingId = this.#idempotency.get(event.idempotencyKey);
    if (existingId !== undefined) {
      return {
        status: 'duplicate',
        record: clone(this.#records.get(existingId)!),
      };
    }
    const record: ProductEventRecord = {
      event,
      delivery: initialDelivery(),
    };
    this.#records.set(event.id, clone(record));
    this.#idempotency.set(event.idempotencyKey, event.id);
    return { status: 'recorded', record: clone(record) };
  }

  async list(): Promise<ProductEventRecord[]> {
    return sortRecords([...this.#records.values()]).map(clone);
  }

  async pending(limit: number): Promise<ProductEventRecord[]> {
    assertLimit(limit);
    return sortRecords(
      [...this.#records.values()].filter(
        (record) => record.delivery.state === 'pending',
      ),
    )
      .slice(0, limit)
      .map(clone);
  }

  async markFailed(
    eventIds: readonly string[],
    code: ProductEventDeliveryFailureCode,
    attemptedAt: string,
  ): Promise<void> {
    assertTimestamp(attemptedAt);
    for (const eventId of uniqueIds(eventIds)) {
      const record = this.#records.get(eventId);
      if (record === undefined || record.delivery.state === 'delivered') {
        continue;
      }
      this.#records.set(eventId, {
        event: record.event,
        delivery: {
          state: 'pending',
          attemptCount: record.delivery.attemptCount + 1,
          lastAttemptAt: attemptedAt,
          lastFailureCode: code,
          deliveredAt: null,
        },
      });
    }
  }

  async markDelivered(
    eventIds: readonly string[],
    deliveredAt: string,
  ): Promise<void> {
    assertTimestamp(deliveredAt);
    for (const eventId of uniqueIds(eventIds)) {
      const record = this.#records.get(eventId);
      if (record === undefined) {
        continue;
      }
      this.#records.set(eventId, {
        event: record.event,
        delivery: {
          state: 'delivered',
          attemptCount: record.delivery.attemptCount + 1,
          lastAttemptAt: deliveredAt,
          lastFailureCode: null,
          deliveredAt,
        },
      });
    }
  }

  async deleteDelivered(): Promise<number> {
    let deleted = 0;
    for (const [eventId, record] of this.#records) {
      if (record.delivery.state !== 'delivered') {
        continue;
      }
      this.#records.delete(eventId);
      this.#idempotency.delete(record.event.idempotencyKey);
      deleted += 1;
    }
    return deleted;
  }

  async exportJson(): Promise<string> {
    return exportRecords(await this.list());
  }

  close(): void {}
}

export interface CreateIndexedDbProductEventLedgerOptions {
  indexedDBFactory?: IDBFactory | null;
  databaseName?: string;
}

export function createIndexedDbProductEventLedger(
  options: CreateIndexedDbProductEventLedgerOptions = {},
): IndexedDbProductEventLedger {
  const factory =
    options.indexedDBFactory === undefined
      ? globalThis.indexedDB
      : options.indexedDBFactory;
  if (factory === undefined || factory === null) {
    throw new AnalyticsLedgerUnavailableError();
  }
  return new IndexedDbProductEventLedger(
    factory,
    options.databaseName ?? DATABASE_NAME,
  );
}

export class IndexedDbProductEventLedger implements ProductEventLedger {
  readonly #databasePromise: Promise<IDBDatabase>;
  #closed = false;

  constructor(factory: IDBFactory, databaseName = DATABASE_NAME) {
    this.#databasePromise = openDatabase(factory, databaseName);
  }

  async append(input: ProductEvent): Promise<AppendProductEventResult> {
    const event = parseProductEvent(input);
    const database = await this.#database();
    const transaction = database.transaction(RECORDS_STORE, 'readwrite');
    const store = transaction.objectStore(RECORDS_STORE);
    const existing = await requestResult(
      store.index(IDEMPOTENCY_INDEX).get(event.idempotencyKey),
    );
    if (existing !== undefined) {
      await transactionDone(transaction);
      return {
        status: 'duplicate',
        record: parseRecord(existing),
      };
    }
    const record: ProductEventRecord = {
      event,
      delivery: initialDelivery(),
    };
    store.add(clone(record));
    try {
      await transactionDone(transaction);
      return { status: 'recorded', record: clone(record) };
    } catch (error) {
      if (isConstraintError(error)) {
        const duplicate = await this.#byIdempotency(event.idempotencyKey);
        if (duplicate !== null) {
          return { status: 'duplicate', record: duplicate };
        }
      }
      throw wrapLedgerError('Unable to append the product event', error);
    }
  }

  async list(): Promise<ProductEventRecord[]> {
    const database = await this.#database();
    const transaction = database.transaction(RECORDS_STORE, 'readonly');
    const values = await requestResult(
      transaction.objectStore(RECORDS_STORE).getAll(),
    );
    await transactionDone(transaction);
    return sortRecords((values as unknown[]).map(parseRecord));
  }

  async pending(limit: number): Promise<ProductEventRecord[]> {
    assertLimit(limit);
    return (await this.list())
      .filter((record) => record.delivery.state === 'pending')
      .slice(0, limit);
  }

  async markFailed(
    eventIds: readonly string[],
    code: ProductEventDeliveryFailureCode,
    attemptedAt: string,
  ): Promise<void> {
    assertTimestamp(attemptedAt);
    await this.#update(eventIds, (record) =>
      record.delivery.state === 'delivered'
        ? record
        : {
            event: record.event,
            delivery: {
              state: 'pending',
              attemptCount: record.delivery.attemptCount + 1,
              lastAttemptAt: attemptedAt,
              lastFailureCode: code,
              deliveredAt: null,
            },
          },
    );
  }

  async markDelivered(
    eventIds: readonly string[],
    deliveredAt: string,
  ): Promise<void> {
    assertTimestamp(deliveredAt);
    await this.#update(eventIds, (record) => ({
      event: record.event,
      delivery: {
        state: 'delivered',
        attemptCount: record.delivery.attemptCount + 1,
        lastAttemptAt: deliveredAt,
        lastFailureCode: null,
        deliveredAt,
      },
    }));
  }

  async deleteDelivered(): Promise<number> {
    const delivered = (await this.list()).filter(
      (record) => record.delivery.state === 'delivered',
    );
    if (delivered.length === 0) {
      return 0;
    }
    const database = await this.#database();
    const transaction = database.transaction(RECORDS_STORE, 'readwrite');
    const store = transaction.objectStore(RECORDS_STORE);
    for (const record of delivered) {
      store.delete(record.event.id);
    }
    await transactionDone(transaction);
    return delivered.length;
  }

  async exportJson(): Promise<string> {
    return exportRecords(await this.list());
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    void this.#databasePromise.then((database) => {
      database.close();
    });
  }

  async #database(): Promise<IDBDatabase> {
    if (this.#closed) {
      throw new AnalyticsLedgerError('Product event ledger is closed');
    }
    return this.#databasePromise;
  }

  async #byIdempotency(key: string): Promise<ProductEventRecord | null> {
    const database = await this.#database();
    const transaction = database.transaction(RECORDS_STORE, 'readonly');
    const value = await requestResult(
      transaction.objectStore(RECORDS_STORE).index(IDEMPOTENCY_INDEX).get(key),
    );
    await transactionDone(transaction);
    return value === undefined ? null : parseRecord(value);
  }

  async #update(
    eventIds: readonly string[],
    update: (record: ProductEventRecord) => ProductEventRecord,
  ): Promise<void> {
    const database = await this.#database();
    const transaction = database.transaction(RECORDS_STORE, 'readwrite');
    const store = transaction.objectStore(RECORDS_STORE);
    for (const eventId of uniqueIds(eventIds)) {
      const value = await requestResult(store.get(eventId));
      if (value === undefined) {
        continue;
      }
      store.put(clone(update(parseRecord(value))));
    }
    await transactionDone(transaction);
  }
}

function initialDelivery(): ProductEventDelivery {
  return {
    state: 'pending',
    attemptCount: 0,
    lastAttemptAt: null,
    lastFailureCode: null,
    deliveredAt: null,
  };
}

function parseRecord(input: unknown): ProductEventRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AnalyticsLedgerError('Invalid product event record');
  }
  const object = input as Partial<ProductEventRecord>;
  const delivery = object.delivery;
  if (
    typeof delivery !== 'object' ||
    delivery === null ||
    !['pending', 'delivered'].includes(delivery.state) ||
    !Number.isSafeInteger(delivery.attemptCount) ||
    (delivery.attemptCount ?? -1) < 0 ||
    !nullableTimestamp(delivery.lastAttemptAt) ||
    !nullableTimestamp(delivery.deliveredAt) ||
    !(
      delivery.lastFailureCode === null ||
      ['NETWORK', 'HTTP_ERROR', 'ABORTED', 'LEDGER_ERROR'].includes(
        delivery.lastFailureCode,
      )
    )
  ) {
    throw new AnalyticsLedgerError('Invalid product event delivery state');
  }
  return {
    event: parseProductEvent(object.event),
    delivery: {
      state: delivery.state as ProductEventDeliveryState,
      attemptCount: delivery.attemptCount as number,
      lastAttemptAt: delivery.lastAttemptAt as string | null,
      lastFailureCode:
        delivery.lastFailureCode as ProductEventDeliveryFailureCode | null,
      deliveredAt: delivery.deliveredAt as string | null,
    },
  };
}

function openDatabase(
  factory: IDBFactory,
  name: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, DATABASE_VERSION);
    request.onerror = () => {
      reject(
        wrapLedgerError(
          'Unable to open the product event ledger',
          request.error,
        ),
      );
    };
    request.onblocked = () => {
      reject(new AnalyticsLedgerError('Product event ledger upgrade is blocked'));
    };
    request.onupgradeneeded = () => {
      const database = request.result;
      if (database.objectStoreNames.contains(RECORDS_STORE)) {
        return;
      }
      const store = database.createObjectStore(RECORDS_STORE, {
        keyPath: 'event.id',
      });
      store.createIndex(IDEMPOTENCY_INDEX, 'event.idempotencyKey', {
        unique: true,
      });
      store.createIndex(DELIVERY_INDEX, 'delivery.state');
    };
    request.onsuccess = () => {
      resolve(request.result);
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
        wrapLedgerError('Product event database request failed', request.error),
      );
    };
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(
        wrapLedgerError(
          'Product event database transaction failed',
          transaction.error,
        ),
      );
    };
    transaction.onabort = () => {
      reject(
        wrapLedgerError(
          'Product event database transaction was aborted',
          transaction.error,
        ),
      );
    };
  });
}

function exportRecords(records: readonly ProductEventRecord[]): string {
  return `${JSON.stringify(
    {
      format: 'zuocheng-product-events',
      schemaVersion: 1,
      records,
    },
    null,
    2,
  )}\n`;
}

function sortRecords(
  records: readonly ProductEventRecord[],
): ProductEventRecord[] {
  return [...records].sort(
    (left, right) =>
      left.event.occurredAt.localeCompare(right.event.occurredAt) ||
      left.event.id.localeCompare(right.event.id),
  );
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new AnalyticsLedgerError('Batch limit must be between 1 and 500');
  }
}

function assertTimestamp(value: string): void {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new AnalyticsLedgerError('Delivery time must be canonical ISO-8601');
  }
}

function nullableTimestamp(value: unknown): boolean {
  if (value === null) {
    return true;
  }
  try {
    assertTimestamp(value as string);
    return true;
  } catch {
    return false;
  }
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function isConstraintError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'ConstraintError' ||
      error.cause instanceof DOMException &&
        error.cause.name === 'ConstraintError')
  );
}

function wrapLedgerError(message: string, cause: unknown): AnalyticsLedgerError {
  return cause instanceof AnalyticsLedgerError
    ? cause
    : new AnalyticsLedgerError(message, { cause });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

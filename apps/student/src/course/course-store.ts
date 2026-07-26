import {
  parseCourseEnrollment,
  type CourseEnrollment,
} from './course-model.js';

const DATABASE_NAME = 'zuocheng-course';
const DATABASE_VERSION = 1;
const ENROLLMENTS_STORE = 'enrollments';

export interface CourseStore {
  createEnrollment(
    enrollment: CourseEnrollment,
  ): Promise<CourseEnrollment>;
  getEnrollment(
    enrollmentId: string,
  ): Promise<CourseEnrollment | null>;
  listEnrollments(): Promise<CourseEnrollment[]>;
  saveEnrollment(
    enrollment: CourseEnrollment,
    expectedVersion: number,
  ): Promise<CourseEnrollment>;
  close(): void;
}

export interface MemoryCourseDatabase {
  readonly enrollments: Map<string, CourseEnrollment>;
}

export function createMemoryCourseDatabase(): MemoryCourseDatabase {
  return { enrollments: new Map() };
}

export class CourseStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CourseStoreError';
  }
}

export class CourseAlreadyExistsError extends CourseStoreError {
  constructor(readonly enrollmentId: string) {
    super(`Course enrollment already exists: ${enrollmentId}`);
    this.name = 'CourseAlreadyExistsError';
  }
}

export class CourseVersionConflictError extends CourseStoreError {
  constructor(
    readonly enrollmentId: string,
    readonly expectedVersion: number,
    readonly currentVersion: number | null,
  ) {
    super(
      `Course enrollment ${enrollmentId} expected version ${String(expectedVersion)}, current ${String(currentVersion)}`,
    );
    this.name = 'CourseVersionConflictError';
  }
}

export class CourseStoreUnavailableError extends CourseStoreError {
  constructor() {
    super('IndexedDB is unavailable');
    this.name = 'CourseStoreUnavailableError';
  }
}

export class MemoryCourseStore implements CourseStore {
  readonly #database: MemoryCourseDatabase;

  constructor(
    options: { database?: MemoryCourseDatabase } = {},
  ) {
    this.#database =
      options.database ?? createMemoryCourseDatabase();
  }

  async createEnrollment(
    input: CourseEnrollment,
  ): Promise<CourseEnrollment> {
    const enrollment = parseCourseEnrollment(input);
    if (this.#database.enrollments.has(enrollment.id)) {
      throw new CourseAlreadyExistsError(enrollment.id);
    }
    this.#database.enrollments.set(
      enrollment.id,
      structuredClone(enrollment),
    );
    return structuredClone(enrollment);
  }

  async getEnrollment(
    enrollmentId: string,
  ): Promise<CourseEnrollment | null> {
    const enrollment =
      this.#database.enrollments.get(enrollmentId);
    return enrollment === undefined
      ? null
      : structuredClone(enrollment);
  }

  async listEnrollments(): Promise<CourseEnrollment[]> {
    return [...this.#database.enrollments.values()]
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      )
      .map((enrollment) => structuredClone(enrollment));
  }

  async saveEnrollment(
    input: CourseEnrollment,
    expectedVersion: number,
  ): Promise<CourseEnrollment> {
    const enrollment = parseCourseEnrollment(input);
    const current = this.#database.enrollments.get(
      enrollment.id,
    );
    if (
      current === undefined ||
      current.version !== expectedVersion ||
      enrollment.version !== expectedVersion + 1
    ) {
      throw new CourseVersionConflictError(
        enrollment.id,
        expectedVersion,
        current?.version ?? null,
      );
    }
    this.#database.enrollments.set(
      enrollment.id,
      structuredClone(enrollment),
    );
    return structuredClone(enrollment);
  }

  close(): void {}
}

export interface IndexedDbCourseStoreOptions {
  indexedDBFactory?: IDBFactory | null;
  databaseName?: string;
}

export function createIndexedDbCourseStore(
  options: IndexedDbCourseStoreOptions = {},
): IndexedDbCourseStore {
  const indexedDBFactory =
    options.indexedDBFactory === undefined
      ? globalThis.indexedDB
      : options.indexedDBFactory;
  if (indexedDBFactory === undefined || indexedDBFactory === null) {
    throw new CourseStoreUnavailableError();
  }
  return new IndexedDbCourseStore(
    indexedDBFactory,
    options.databaseName ?? DATABASE_NAME,
  );
}

export class IndexedDbCourseStore implements CourseStore {
  readonly #databasePromise: Promise<IDBDatabase>;
  #closed = false;

  constructor(
    indexedDBFactory: IDBFactory,
    databaseName = DATABASE_NAME,
  ) {
    this.#databasePromise = openDatabase(
      indexedDBFactory,
      databaseName,
    );
  }

  async createEnrollment(
    input: CourseEnrollment,
  ): Promise<CourseEnrollment> {
    const enrollment = parseCourseEnrollment(input);
    const database = await this.#database();
    const transaction = database.transaction(
      ENROLLMENTS_STORE,
      'readwrite',
    );
    const store = transaction.objectStore(ENROLLMENTS_STORE);
    const existing = await requestResult(store.get(enrollment.id));
    if (existing !== undefined) {
      transaction.abort();
      throw new CourseAlreadyExistsError(enrollment.id);
    }
    store.add(structuredClone(enrollment));
    await transactionDone(transaction);
    return structuredClone(enrollment);
  }

  async getEnrollment(
    enrollmentId: string,
  ): Promise<CourseEnrollment | null> {
    const database = await this.#database();
    const transaction = database.transaction(
      ENROLLMENTS_STORE,
      'readonly',
    );
    const value = await requestResult(
      transaction
        .objectStore(ENROLLMENTS_STORE)
        .get(enrollmentId),
    );
    await transactionDone(transaction);
    return value === undefined
      ? null
      : parseCourseEnrollment(value);
  }

  async listEnrollments(): Promise<CourseEnrollment[]> {
    const database = await this.#database();
    const transaction = database.transaction(
      ENROLLMENTS_STORE,
      'readonly',
    );
    const values = await requestResult(
      transaction.objectStore(ENROLLMENTS_STORE).getAll(),
    );
    await transactionDone(transaction);
    return (values as unknown[])
      .map((value) => parseCourseEnrollment(value))
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
  }

  async saveEnrollment(
    input: CourseEnrollment,
    expectedVersion: number,
  ): Promise<CourseEnrollment> {
    const enrollment = parseCourseEnrollment(input);
    const database = await this.#database();
    const transaction = database.transaction(
      ENROLLMENTS_STORE,
      'readwrite',
    );
    const store = transaction.objectStore(ENROLLMENTS_STORE);
    const value = await requestResult(store.get(enrollment.id));
    const current =
      value === undefined
        ? null
        : parseCourseEnrollment(value);
    if (
      current === null ||
      current.version !== expectedVersion ||
      enrollment.version !== expectedVersion + 1
    ) {
      transaction.abort();
      throw new CourseVersionConflictError(
        enrollment.id,
        expectedVersion,
        current?.version ?? null,
      );
    }
    store.put(structuredClone(enrollment));
    await transactionDone(transaction);
    return structuredClone(enrollment);
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
      throw new CourseStoreError('Course store is closed');
    }
    return this.#databasePromise;
  }
}

function openDatabase(
  indexedDBFactory: IDBFactory,
  databaseName: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDBFactory.open(
      databaseName,
      DATABASE_VERSION,
    );
    request.onerror = () => {
      reject(
        request.error ??
          new CourseStoreError(
            'Unable to open the course database',
          ),
      );
    };
    request.onblocked = () => {
      reject(
        new CourseStoreError(
          'Course database upgrade is blocked',
        ),
      );
    };
    request.onupgradeneeded = () => {
      const database = request.result;
      if (
        !database.objectStoreNames.contains(ENROLLMENTS_STORE)
      ) {
        database.createObjectStore(ENROLLMENTS_STORE, {
          keyPath: 'id',
        });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

function requestResult<T>(
  request: IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(
        request.error ??
          new CourseStoreError(
            'Course database request failed',
          ),
      );
    };
  });
}

function transactionDone(
  transaction: IDBTransaction,
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(
        transaction.error ??
          new CourseStoreError(
            'Course database transaction failed',
          ),
      );
    };
    transaction.onabort = () => {
      reject(
        transaction.error ??
          new CourseStoreError(
            'Course database transaction aborted',
          ),
      );
    };
  });
}

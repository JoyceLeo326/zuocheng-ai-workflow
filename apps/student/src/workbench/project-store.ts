import {
  ProjectModelError,
  parseProject,
  parseSourceChunk,
  type EntityId,
  type IsoDateTime,
  type JsonValue,
  type Project,
  type SourceChunk,
  type VersionedEntity,
} from './project-model.js';

export const PROJECT_EXPORT_FORMAT = 'zuocheng-project' as const;
export const PROJECT_EXPORT_FORMAT_VERSION = 1 as const;

export type ProjectEditKind =
  | 'create'
  | 'update'
  | 'source'
  | 'chunks'
  | 'import';

export interface ProjectEdit extends VersionedEntity {
  projectId: EntityId;
  projectVersion: number;
  kind: ProjectEditKind;
  path: string;
  before: JsonValue;
  after: JsonValue;
}

export interface ProjectExportBlob {
  sourceFileId: EntityId;
  blob: Blob;
}

export interface ProjectExportBundle {
  format: typeof PROJECT_EXPORT_FORMAT;
  formatVersion: typeof PROJECT_EXPORT_FORMAT_VERSION;
  exportedAt: IsoDateTime;
  project: Project;
  sourceBlobs: ProjectExportBlob[];
  sourceChunks: SourceChunk[];
  editHistory: ProjectEdit[];
}

export interface ProjectStore {
  createProject(project: Project): Promise<Project>;
  getProject(projectId: EntityId): Promise<Project | null>;
  listProjects(): Promise<Project[]>;
  saveProject(project: Project, expectedVersion: number): Promise<Project>;
  putSourceBlob(
    projectId: EntityId,
    sourceFileId: EntityId,
    blob: Blob,
  ): Promise<void>;
  getSourceBlob(
    projectId: EntityId,
    sourceFileId: EntityId,
  ): Promise<Blob | null>;
  replaceSourceChunks(
    projectId: EntityId,
    sourceFileId: EntityId,
    chunks: readonly SourceChunk[],
    expectedVersion: number,
    updatedAt: IsoDateTime,
  ): Promise<Project>;
  getSourceChunks(
    projectId: EntityId,
    sourceFileId: EntityId,
  ): Promise<SourceChunk[]>;
  appendEdit(edit: ProjectEdit): Promise<void>;
  listEdits(projectId: EntityId): Promise<ProjectEdit[]>;
  exportProject(
    projectId: EntityId,
    exportedAt?: IsoDateTime,
  ): Promise<ProjectExportBundle>;
  importProject(bundle: unknown): Promise<Project>;
  close(): void;
}

export class ProjectStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectStoreError';
  }
}

export class ProjectStoreUnavailableError extends ProjectStoreError {
  constructor(message = 'IndexedDB is unavailable') {
    super(message);
    this.name = 'ProjectStoreUnavailableError';
  }
}

export class ProjectNotFoundError extends ProjectStoreError {
  readonly projectId: EntityId;

  constructor(projectId: EntityId) {
    super(`projectId ${projectId} does not exist`);
    this.name = 'ProjectNotFoundError';
    this.projectId = projectId;
  }
}

export class ProjectAlreadyExistsError extends ProjectStoreError {
  readonly projectId: EntityId;

  constructor(projectId: EntityId) {
    super(`projectId ${projectId} already exists`);
    this.name = 'ProjectAlreadyExistsError';
    this.projectId = projectId;
  }
}

export class ProjectVersionConflictError extends ProjectStoreError {
  readonly projectId: EntityId;
  readonly expectedVersion: number;
  readonly currentVersion: number | null;

  constructor(
    projectId: EntityId,
    expectedVersion: number,
    currentVersion: number | null,
  ) {
    super(
      `projectId ${projectId} expected version ${expectedVersion}, current version is ${currentVersion ?? 'missing'}`,
    );
    this.name = 'ProjectVersionConflictError';
    this.projectId = projectId;
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

export class ProjectImportError extends ProjectStoreError {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ProjectImportError';
    this.cause = cause;
  }
}

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EDIT_KINDS = [
  'create',
  'update',
  'source',
  'chunks',
  'import',
] as const;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectImportError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new ProjectImportError(`${path} must be a non-empty trimmed string`);
  }
  return value;
}

function idAt(value: unknown, path: string): EntityId {
  const id = stringAt(value, path);
  if (!UUID_V7.test(id) || id !== id.toLowerCase()) {
    throw new ProjectImportError(
      `${path} must be a canonical lowercase UUIDv7`,
    );
  }
  return id;
}

function positiveIntegerAt(value: unknown, path: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new ProjectImportError(`${path} must be a positive safe integer`);
  }
  return value;
}

function dateTimeAt(value: unknown, path: string): IsoDateTime {
  const dateTime = stringAt(value, path);
  const date = new Date(dateTime);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== dateTime) {
    throw new ProjectImportError(
      `${path} must be a canonical ISO-8601 UTC timestamp`,
    );
  }
  return dateTime;
}

function jsonAt(
  value: unknown,
  path: string,
  seen = new WeakSet<object>(),
): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ProjectImportError(`${path} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new ProjectImportError(`${path} must be JSON-compatible`);
  }
  if (seen.has(value)) {
    throw new ProjectImportError(`${path} must not contain cycles`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item, index) =>
      jsonAt(item, `${path}[${index}]`, seen),
    );
    seen.delete(value);
    return result;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ProjectImportError(`${path} must contain plain objects`);
  }
  const result: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = jsonAt(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
  return result;
}

function parseProjectEdit(input: unknown, path = 'editHistory'): ProjectEdit {
  const object = objectAt(input, path);
  const createdAt = dateTimeAt(object.createdAt, `${path}.createdAt`);
  const updatedAt = dateTimeAt(object.updatedAt, `${path}.updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new ProjectImportError(`${path}.updatedAt precedes createdAt`);
  }
  const kind = stringAt(object.kind, `${path}.kind`);
  if (!EDIT_KINDS.includes(kind as ProjectEditKind)) {
    throw new ProjectImportError(`${path}.kind is unsupported`);
  }
  return {
    id: idAt(object.id, `${path}.id`),
    version: positiveIntegerAt(object.version, `${path}.version`),
    createdAt,
    updatedAt,
    projectId: idAt(object.projectId, `${path}.projectId`),
    projectVersion: positiveIntegerAt(
      object.projectVersion,
      `${path}.projectVersion`,
    ),
    kind: kind as ProjectEditKind,
    path: stringAt(object.path, `${path}.path`),
    before: jsonAt(object.before, `${path}.before`),
    after: jsonAt(object.after, `${path}.after`),
  };
}

function parseBundle(input: unknown): ProjectExportBundle {
  try {
    const object = objectAt(input, 'bundle');
    if (object.format !== PROJECT_EXPORT_FORMAT) {
      throw new ProjectImportError(
        `bundle.format must equal ${PROJECT_EXPORT_FORMAT}`,
      );
    }
    if (object.formatVersion !== PROJECT_EXPORT_FORMAT_VERSION) {
      throw new ProjectImportError(
        `bundle.formatVersion must equal ${PROJECT_EXPORT_FORMAT_VERSION}`,
      );
    }
    const project = parseProject(object.project);
    const sourceBlobsRaw = object.sourceBlobs;
    if (!Array.isArray(sourceBlobsRaw)) {
      throw new ProjectImportError('bundle.sourceBlobs must be an array');
    }
    const sourceBlobs = sourceBlobsRaw.map((item, index) => {
      const value = objectAt(item, `bundle.sourceBlobs[${index}]`);
      const sourceFileId = idAt(
        value.sourceFileId,
        `bundle.sourceBlobs[${index}].sourceFileId`,
      );
      if (!(value.blob instanceof Blob)) {
        throw new ProjectImportError(
          `bundle.sourceBlobs[${index}].blob must be a Blob`,
        );
      }
      return { sourceFileId, blob: value.blob };
    });
    if (
      new Set(sourceBlobs.map((entry) => entry.sourceFileId)).size !==
      sourceBlobs.length
    ) {
      throw new ProjectImportError(
        'bundle.sourceBlobs contains duplicate sourceFileId values',
      );
    }
    const sourceChunksRaw = object.sourceChunks;
    if (!Array.isArray(sourceChunksRaw)) {
      throw new ProjectImportError('bundle.sourceChunks must be an array');
    }
    const sourceChunks = sourceChunksRaw.map((item, index) => {
      try {
        return parseSourceChunk(item);
      } catch (error) {
        throw new ProjectImportError(
          `bundle.sourceChunks[${index}] is invalid`,
          error,
        );
      }
    });
    if (
      new Set(sourceChunks.map((entry) => entry.id)).size !==
      sourceChunks.length
    ) {
      throw new ProjectImportError(
        'bundle.sourceChunks contains duplicate identities',
      );
    }
    const editHistoryRaw = object.editHistory;
    if (!Array.isArray(editHistoryRaw)) {
      throw new ProjectImportError('bundle.editHistory must be an array');
    }
    const editHistory = editHistoryRaw.map((item, index) =>
      parseProjectEdit(item, `bundle.editHistory[${index}]`),
    );
    if (
      new Set(editHistory.map((entry) => entry.id)).size !== editHistory.length
    ) {
      throw new ProjectImportError(
        'bundle.editHistory contains duplicate identities',
      );
    }

    if (!sameChunks(project.sourceChunks, sourceChunks)) {
      throw new ProjectImportError(
        'bundle.project.sourceChunks must exactly match bundle.sourceChunks',
      );
    }
    validateBundleOwnership(project, sourceBlobs, sourceChunks, editHistory);
    return {
      format: PROJECT_EXPORT_FORMAT,
      formatVersion: PROJECT_EXPORT_FORMAT_VERSION,
      exportedAt: dateTimeAt(object.exportedAt, 'bundle.exportedAt'),
      project,
      sourceBlobs: sourceBlobs.map((entry) => ({
        sourceFileId: entry.sourceFileId,
        blob: clone(entry.blob),
      })),
      sourceChunks,
      editHistory,
    };
  } catch (error) {
    if (error instanceof ProjectImportError) {
      throw error;
    }
    if (error instanceof ProjectModelError) {
      throw new ProjectImportError('bundle.project is invalid', error);
    }
    throw new ProjectImportError('bundle is invalid', error);
  }
}

function validateBundleOwnership(
  project: Project,
  sourceBlobs: readonly ProjectExportBlob[],
  sourceChunks: readonly SourceChunk[],
  editHistory: readonly ProjectEdit[],
): void {
  const files = new Map(project.sourceFiles.map((file) => [file.id, file]));
  for (const entry of sourceBlobs) {
    const file = files.get(entry.sourceFileId);
    if (file === undefined) {
      throw new ProjectImportError(
        'bundle.sourceBlobs.sourceFileId is not owned by bundle.project',
      );
    }
    if (entry.blob.size !== file.sizeBytes) {
      throw new ProjectImportError(
        'bundle.sourceBlobs.blob size does not match the source file',
      );
    }
  }
  for (const chunk of sourceChunks) {
    const file = files.get(chunk.sourceFileId);
    if (
      chunk.projectId !== project.id ||
      file === undefined ||
      chunk.sourceFileVersion !== file.sourceVersion
    ) {
      throw new ProjectImportError(
        'bundle.sourceChunks references a different project or source version',
      );
    }
  }
  for (const edit of editHistory) {
    if (
      edit.projectId !== project.id ||
      edit.projectVersion > project.version
    ) {
      throw new ProjectImportError(
        'bundle.editHistory references a different or future project version',
      );
    }
  }
}

function parseForCreate(input: Project): Project {
  const parsed = parseProject(input);
  const project = parseProject({
    ...parsed,
    sourceChunks: sortChunks(parsed.sourceChunks),
  });
  if (project.version !== 1) {
    throw new ProjectVersionConflictError(project.id, 0, null);
  }
  return project;
}

function parseForSave(input: Project, expectedVersion: number): Project {
  const parsed = parseProject(input);
  const project = parseProject({
    ...parsed,
    sourceChunks: sortChunks(parsed.sourceChunks),
  });
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new ProjectVersionConflictError(project.id, expectedVersion, null);
  }
  if (project.version !== expectedVersion + 1) {
    throw new ProjectVersionConflictError(
      project.id,
      expectedVersion,
      expectedVersion,
    );
  }
  return project;
}

function findSourceFile(
  project: Project,
  sourceFileId: EntityId,
): Project['sourceFiles'][number] {
  const file = project.sourceFiles.find((candidate) => candidate.id === sourceFileId);
  if (file === undefined) {
    throw new ProjectStoreError(
      `sourceFileId ${sourceFileId} is not owned by projectId ${project.id}`,
    );
  }
  return file;
}

function validateChunks(
  project: Project,
  sourceFileId: EntityId,
  inputs: readonly SourceChunk[],
): SourceChunk[] {
  const file = findSourceFile(project, sourceFileId);
  const chunks = inputs.map((chunk) => parseSourceChunk(chunk));
  if (new Set(chunks.map((chunk) => chunk.id)).size !== chunks.length) {
    throw new ProjectStoreError('source chunks contain duplicate identities');
  }
  if (
    chunks.some(
      (chunk) =>
        chunk.projectId !== project.id ||
        chunk.sourceFileId !== sourceFileId ||
        chunk.sourceFileVersion !== file.sourceVersion,
    )
  ) {
    throw new ProjectStoreError(
      'source chunk projectId, sourceFileId or sourceFileVersion is invalid',
    );
  }
  const ordinals = chunks.map((chunk) => chunk.ordinal);
  if (
    new Set(ordinals).size !== ordinals.length ||
    [...ordinals].sort((left, right) => left - right).some(
      (ordinal, index) => ordinal !== index,
    )
  ) {
    throw new ProjectStoreError(
      'source chunk ordinal values must be unique and contiguous',
    );
  }
  return chunks;
}

function sortChunks(chunks: readonly SourceChunk[]): SourceChunk[] {
  return [...chunks].sort(
    (left, right) =>
      left.sourceFileId.localeCompare(right.sourceFileId) ||
      left.ordinal - right.ordinal ||
      left.id.localeCompare(right.id),
  );
}

function sameChunks(
  left: readonly SourceChunk[],
  right: readonly SourceChunk[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nextProjectWithChunks(
  current: Project,
  sourceFileId: EntityId,
  inputs: readonly SourceChunk[],
  expectedVersion: number,
  updatedAtInput: IsoDateTime,
): Project {
  if (current.version !== expectedVersion) {
    throw new ProjectVersionConflictError(
      current.id,
      expectedVersion,
      current.version,
    );
  }
  const updatedAt = dateTimeAt(updatedAtInput, 'updatedAt');
  if (Date.parse(updatedAt) <= Date.parse(current.updatedAt)) {
    throw new ProjectStoreError(
      'updatedAt must be later than the current project updatedAt',
    );
  }
  const chunks = validateChunks(current, sourceFileId, inputs);
  return parseProject({
    ...current,
    version: current.version + 1,
    updatedAt,
    sourceChunks: sortChunks([
      ...current.sourceChunks.filter(
        (chunk) => chunk.sourceFileId !== sourceFileId,
      ),
      ...chunks,
    ]),
  });
}

function validateEditForProject(edit: ProjectEdit, project: Project): ProjectEdit {
  const parsed = parseProjectEdit(edit);
  if (
    parsed.projectId !== project.id ||
    parsed.projectVersion > project.version
  ) {
    throw new ProjectStoreError(
      'edit projectId or projectVersion does not match the stored project',
    );
  }
  return parsed;
}

function blobKey(projectId: EntityId, sourceFileId: EntityId): string {
  return `${projectId}:${sourceFileId}`;
}

export interface MemoryProjectDatabase {
  readonly projects: Map<EntityId, Project>;
  readonly sourceBlobs: Map<string, Blob>;
  readonly sourceChunks: Map<EntityId, SourceChunk>;
  readonly edits: Map<EntityId, ProjectEdit>;
}

export function createMemoryProjectDatabase(): MemoryProjectDatabase {
  return {
    projects: new Map(),
    sourceBlobs: new Map(),
    sourceChunks: new Map(),
    edits: new Map(),
  };
}

export class MemoryProjectStore implements ProjectStore {
  readonly #database: MemoryProjectDatabase;

  constructor(
    options: { database?: MemoryProjectDatabase } = {},
  ) {
    this.#database = options.database ?? createMemoryProjectDatabase();
  }

  async createProject(input: Project): Promise<Project> {
    const project = parseForCreate(input);
    if (this.#database.projects.has(project.id)) {
      throw new ProjectAlreadyExistsError(project.id);
    }
    this.#assertChunkIdsAvailable(project);
    this.#database.projects.set(project.id, clone(project));
    this.#writeProjectChunks(project);
    return clone(project);
  }

  async getProject(projectId: EntityId): Promise<Project | null> {
    const project = this.#database.projects.get(projectId);
    return project === undefined ? null : clone(project);
  }

  async listProjects(): Promise<Project[]> {
    return [...this.#database.projects.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((project) => clone(project));
  }

  async saveProject(
    input: Project,
    expectedVersion: number,
  ): Promise<Project> {
    const project = parseForSave(input, expectedVersion);
    const current = this.#database.projects.get(project.id);
    if (current === undefined || current.version !== expectedVersion) {
      throw new ProjectVersionConflictError(
        project.id,
        expectedVersion,
        current?.version ?? null,
      );
    }
    this.#assertChunkIdsAvailable(project);
    this.#database.projects.set(project.id, clone(project));
    this.#writeProjectChunks(project);
    return clone(project);
  }

  async putSourceBlob(
    projectId: EntityId,
    sourceFileId: EntityId,
    blob: Blob,
  ): Promise<void> {
    const project = await this.#requireProject(projectId);
    const file = findSourceFile(project, sourceFileId);
    if (!(blob instanceof Blob)) {
      throw new ProjectStoreError('blob must be a Blob');
    }
    if (blob.size !== file.sizeBytes) {
      throw new ProjectStoreError(
        `blob size ${blob.size} does not match source file size ${file.sizeBytes}`,
      );
    }
    this.#database.sourceBlobs.set(
      blobKey(projectId, sourceFileId),
      clone(blob),
    );
  }

  async getSourceBlob(
    projectId: EntityId,
    sourceFileId: EntityId,
  ): Promise<Blob | null> {
    const project = await this.#requireProject(projectId);
    findSourceFile(project, sourceFileId);
    const blob = this.#database.sourceBlobs.get(
      blobKey(projectId, sourceFileId),
    );
    return blob === undefined ? null : clone(blob);
  }

  async replaceSourceChunks(
    projectId: EntityId,
    sourceFileId: EntityId,
    inputs: readonly SourceChunk[],
    expectedVersion: number,
    updatedAt: IsoDateTime,
  ): Promise<Project> {
    const stored = this.#database.projects.get(projectId);
    if (stored === undefined) {
      throw new ProjectNotFoundError(projectId);
    }
    const current = clone(stored);
    const next = nextProjectWithChunks(
      current,
      sourceFileId,
      inputs,
      expectedVersion,
      updatedAt,
    );
    this.#assertChunkIdsAvailable(next);
    this.#database.projects.set(projectId, clone(next));
    this.#writeProjectChunks(next);
    return clone(next);
  }

  async getSourceChunks(
    projectId: EntityId,
    sourceFileId: EntityId,
  ): Promise<SourceChunk[]> {
    const project = await this.#requireProject(projectId);
    findSourceFile(project, sourceFileId);
    const stored = [...this.#database.sourceChunks.values()]
      .filter(
        (chunk) =>
          chunk.projectId === projectId &&
          chunk.sourceFileId === sourceFileId,
      )
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((chunk) => clone(chunk));
    const canonical = project.sourceChunks.filter(
      (chunk) => chunk.sourceFileId === sourceFileId,
    );
    if (!sameChunks(canonical, stored)) {
      throw new ProjectStoreError(
        'stored sourceChunks do not match project.sourceChunks',
      );
    }
    return stored;
  }

  async appendEdit(input: ProjectEdit): Promise<void> {
    const project = await this.#requireProject(input.projectId);
    const edit = validateEditForProject(input, project);
    if (this.#database.edits.has(edit.id)) {
      throw new ProjectStoreError(`edit id ${edit.id} already exists`);
    }
    this.#database.edits.set(edit.id, clone(edit));
  }

  async listEdits(projectId: EntityId): Promise<ProjectEdit[]> {
    await this.#requireProject(projectId);
    return [...this.#database.edits.values()]
      .filter((edit) => edit.projectId === projectId)
      .sort(
        (left, right) =>
          left.projectVersion - right.projectVersion ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .map((edit) => clone(edit));
  }

  async exportProject(
    projectId: EntityId,
    exportedAt = new Date().toISOString(),
  ): Promise<ProjectExportBundle> {
    const project = await this.#requireProject(projectId);
    const timestamp = dateTimeAt(exportedAt, 'exportedAt');
    const sourceBlobs: ProjectExportBlob[] = [];
    for (const file of project.sourceFiles) {
      const blob = this.#database.sourceBlobs.get(
        blobKey(projectId, file.id),
      );
      if (blob !== undefined) {
        sourceBlobs.push({ sourceFileId: file.id, blob: clone(blob) });
      }
    }
    const sourceChunks = [...this.#database.sourceChunks.values()]
      .filter((chunk) => chunk.projectId === projectId)
      .sort(
        (left, right) =>
          left.sourceFileId.localeCompare(right.sourceFileId) ||
          left.ordinal - right.ordinal,
      )
      .map((chunk) => clone(chunk));
    if (!sameChunks(project.sourceChunks, sourceChunks)) {
      throw new ProjectStoreError(
        'cannot export inconsistent project.sourceChunks',
      );
    }
    const editHistory = await this.listEdits(projectId);
    return {
      format: PROJECT_EXPORT_FORMAT,
      formatVersion: PROJECT_EXPORT_FORMAT_VERSION,
      exportedAt: timestamp,
      project,
      sourceBlobs,
      sourceChunks,
      editHistory,
    };
  }

  async importProject(input: unknown): Promise<Project> {
    const bundle = parseBundle(input);
    if (this.#database.projects.has(bundle.project.id)) {
      throw new ProjectAlreadyExistsError(bundle.project.id);
    }
    this.#assertChunkIdsAvailable(bundle.project);
    if (
      bundle.editHistory.some((edit) => this.#database.edits.has(edit.id))
    ) {
      throw new ProjectStoreError(
        'import edit identity conflicts with existing edit history',
      );
    }
    this.#database.projects.set(bundle.project.id, clone(bundle.project));
    for (const entry of bundle.sourceBlobs) {
      this.#database.sourceBlobs.set(
        blobKey(bundle.project.id, entry.sourceFileId),
        clone(entry.blob),
      );
    }
    this.#writeProjectChunks(bundle.project);
    for (const edit of bundle.editHistory) {
      this.#database.edits.set(edit.id, clone(edit));
    }
    return clone(bundle.project);
  }

  close(): void {}

  async #requireProject(projectId: EntityId): Promise<Project> {
    const project = this.#database.projects.get(projectId);
    if (project === undefined) {
      throw new ProjectNotFoundError(projectId);
    }
    return clone(project);
  }

  #assertChunkIdsAvailable(project: Project): void {
    for (const chunk of project.sourceChunks) {
      const existing = this.#database.sourceChunks.get(chunk.id);
      if (existing !== undefined && existing.projectId !== project.id) {
        throw new ProjectStoreError(
          `source chunk id ${chunk.id} belongs to another project`,
        );
      }
    }
  }

  #writeProjectChunks(project: Project): void {
    for (const [chunkId, chunk] of this.#database.sourceChunks) {
      if (chunk.projectId === project.id) {
        this.#database.sourceChunks.delete(chunkId);
      }
    }
    for (const chunk of project.sourceChunks) {
      this.#database.sourceChunks.set(chunk.id, clone(chunk));
    }
  }
}

const DATABASE_NAME = 'zuocheng-workbench';
const DATABASE_VERSION = 1;
const PROJECTS_STORE = 'projects';
const BLOBS_STORE = 'sourceBlobs';
const CHUNKS_STORE = 'sourceChunks';
const EDITS_STORE = 'edits';
const PROJECT_FILE_INDEX = 'projectFile';
const PROJECT_ID_INDEX = 'projectId';

interface StoredBlob extends ProjectExportBlob {
  key: string;
  projectId: EntityId;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new ProjectStoreError('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new ProjectStoreError('IndexedDB transaction was aborted'),
      );
    transaction.onerror = () => {
      // The abort event provides the final transaction error.
    };
  });
}

function openDatabase(
  indexedDBFactory: IDBFactory,
  databaseName: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDBFactory.open(databaseName, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECTS_STORE)) {
        database.createObjectStore(PROJECTS_STORE, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(BLOBS_STORE)) {
        const blobs = database.createObjectStore(BLOBS_STORE, {
          keyPath: 'key',
        });
        blobs.createIndex(PROJECT_ID_INDEX, 'projectId', { unique: false });
        blobs.createIndex(PROJECT_FILE_INDEX, ['projectId', 'sourceFileId'], {
          unique: true,
        });
      }
      if (!database.objectStoreNames.contains(CHUNKS_STORE)) {
        const chunks = database.createObjectStore(CHUNKS_STORE, {
          keyPath: 'id',
        });
        chunks.createIndex(PROJECT_ID_INDEX, 'projectId', { unique: false });
        chunks.createIndex(PROJECT_FILE_INDEX, ['projectId', 'sourceFileId'], {
          unique: false,
        });
      }
      if (!database.objectStoreNames.contains(EDITS_STORE)) {
        const edits = database.createObjectStore(EDITS_STORE, {
          keyPath: 'id',
        });
        edits.createIndex(PROJECT_ID_INDEX, 'projectId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ??
          new ProjectStoreUnavailableError('Unable to open IndexedDB'),
      );
    request.onblocked = () =>
      reject(
        new ProjectStoreUnavailableError(
          'IndexedDB upgrade is blocked by another page',
        ),
      );
  });
}

export interface IndexedDbProjectStoreOptions {
  indexedDBFactory?: IDBFactory | null;
  databaseName?: string;
}

export function createIndexedDbProjectStore(
  options: IndexedDbProjectStoreOptions = {},
): IndexedDbProjectStore {
  const indexedDBFactory =
    options.indexedDBFactory === undefined
      ? globalThis.indexedDB
      : options.indexedDBFactory;
  if (indexedDBFactory === null || indexedDBFactory === undefined) {
    throw new ProjectStoreUnavailableError();
  }
  return new IndexedDbProjectStore(
    indexedDBFactory,
    options.databaseName ?? DATABASE_NAME,
  );
}

export class IndexedDbProjectStore implements ProjectStore {
  readonly #databasePromise: Promise<IDBDatabase>;
  #closed = false;

  constructor(indexedDBFactory: IDBFactory, databaseName = DATABASE_NAME) {
    this.#databasePromise = openDatabase(indexedDBFactory, databaseName);
  }

  async createProject(input: Project): Promise<Project> {
    const project = parseForCreate(input);
    const database = await this.#database();
    const transaction = database.transaction(
      [PROJECTS_STORE, CHUNKS_STORE],
      'readwrite',
    );
    const store = transaction.objectStore(PROJECTS_STORE);
    const current = (await requestResult(store.get(project.id))) as
      | Project
      | undefined;
    if (current !== undefined) {
      transaction.abort();
      throw new ProjectAlreadyExistsError(project.id);
    }
    store.add(clone(project));
    await this.#writeProjectChunks(transaction, project);
    await transactionDone(transaction);
    return clone(project);
  }

  async getProject(projectId: EntityId): Promise<Project | null> {
    const database = await this.#database();
    const transaction = database.transaction(PROJECTS_STORE, 'readonly');
    const value = (await requestResult(
      transaction.objectStore(PROJECTS_STORE).get(projectId),
    )) as Project | undefined;
    await transactionDone(transaction);
    return value === undefined ? null : parseProject(value);
  }

  async listProjects(): Promise<Project[]> {
    const database = await this.#database();
    const transaction = database.transaction(PROJECTS_STORE, 'readonly');
    const values = (await requestResult(
      transaction.objectStore(PROJECTS_STORE).getAll(),
    )) as Project[];
    await transactionDone(transaction);
    return values
      .map((project) => parseProject(project))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async saveProject(
    input: Project,
    expectedVersion: number,
  ): Promise<Project> {
    const project = parseForSave(input, expectedVersion);
    const database = await this.#database();
    const transaction = database.transaction(
      [PROJECTS_STORE, CHUNKS_STORE],
      'readwrite',
    );
    const store = transaction.objectStore(PROJECTS_STORE);
    const current = (await requestResult(store.get(project.id))) as
      | Project
      | undefined;
    if (current === undefined || current.version !== expectedVersion) {
      transaction.abort();
      throw new ProjectVersionConflictError(
        project.id,
        expectedVersion,
        current?.version ?? null,
      );
    }
    store.put(clone(project));
    await this.#writeProjectChunks(transaction, project);
    await transactionDone(transaction);
    return clone(project);
  }

  async putSourceBlob(
    projectId: EntityId,
    sourceFileId: EntityId,
    blob: Blob,
  ): Promise<void> {
    if (!(blob instanceof Blob)) {
      throw new ProjectStoreError('blob must be a Blob');
    }
    const database = await this.#database();
    const transaction = database.transaction(
      [PROJECTS_STORE, BLOBS_STORE],
      'readwrite',
    );
    const project = await this.#projectInTransaction(transaction, projectId);
    const file = findSourceFile(project, sourceFileId);
    if (blob.size !== file.sizeBytes) {
      transaction.abort();
      throw new ProjectStoreError(
        `blob size ${blob.size} does not match source file size ${file.sizeBytes}`,
      );
    }
    const record: StoredBlob = {
      key: blobKey(projectId, sourceFileId),
      projectId,
      sourceFileId,
      blob: clone(blob),
    };
    transaction.objectStore(BLOBS_STORE).put(record);
    await transactionDone(transaction);
  }

  async getSourceBlob(
    projectId: EntityId,
    sourceFileId: EntityId,
  ): Promise<Blob | null> {
    const database = await this.#database();
    const transaction = database.transaction(
      [PROJECTS_STORE, BLOBS_STORE],
      'readonly',
    );
    const project = await this.#projectInTransaction(transaction, projectId);
    findSourceFile(project, sourceFileId);
    const value = (await requestResult(
      transaction.objectStore(BLOBS_STORE).get(blobKey(projectId, sourceFileId)),
    )) as StoredBlob | undefined;
    await transactionDone(transaction);
    return value === undefined ? null : clone(value.blob);
  }

  async replaceSourceChunks(
    projectId: EntityId,
    sourceFileId: EntityId,
    inputs: readonly SourceChunk[],
    expectedVersion: number,
    updatedAt: IsoDateTime,
  ): Promise<Project> {
    const database = await this.#database();
    const transaction = database.transaction(
      [PROJECTS_STORE, CHUNKS_STORE],
      'readwrite',
    );
    const current = await this.#projectInTransaction(transaction, projectId);
    let next: Project;
    try {
      next = nextProjectWithChunks(
        current,
        sourceFileId,
        inputs,
        expectedVersion,
        updatedAt,
      );
    } catch (error) {
      transaction.abort();
      throw error;
    }
    transaction.objectStore(PROJECTS_STORE).put(clone(next));
    await this.#writeProjectChunks(transaction, next);
    await transactionDone(transaction);
    return clone(next);
  }

  async getSourceChunks(
    projectId: EntityId,
    sourceFileId: EntityId,
  ): Promise<SourceChunk[]> {
    const database = await this.#database();
    const transaction = database.transaction(
      [PROJECTS_STORE, CHUNKS_STORE],
      'readonly',
    );
    const project = await this.#projectInTransaction(transaction, projectId);
    findSourceFile(project, sourceFileId);
    const chunks = (await requestResult(
      transaction
        .objectStore(CHUNKS_STORE)
        .index(PROJECT_FILE_INDEX)
        .getAll([projectId, sourceFileId]),
    )) as SourceChunk[];
    await transactionDone(transaction);
    const stored = chunks
      .map((chunk) => parseSourceChunk(chunk))
      .sort((left, right) => left.ordinal - right.ordinal);
    const canonical = project.sourceChunks.filter(
      (chunk) => chunk.sourceFileId === sourceFileId,
    );
    if (!sameChunks(canonical, stored)) {
      throw new ProjectStoreError(
        'stored sourceChunks do not match project.sourceChunks',
      );
    }
    return stored;
  }

  async appendEdit(input: ProjectEdit): Promise<void> {
    const database = await this.#database();
    const transaction = database.transaction(
      [PROJECTS_STORE, EDITS_STORE],
      'readwrite',
    );
    const project = await this.#projectInTransaction(
      transaction,
      input.projectId,
    );
    const edit = validateEditForProject(input, project);
    const store = transaction.objectStore(EDITS_STORE);
    const current = await requestResult(store.get(edit.id));
    if (current !== undefined) {
      transaction.abort();
      throw new ProjectStoreError(`edit id ${edit.id} already exists`);
    }
    store.add(clone(edit));
    await transactionDone(transaction);
  }

  async listEdits(projectId: EntityId): Promise<ProjectEdit[]> {
    const database = await this.#database();
    const transaction = database.transaction(
      [PROJECTS_STORE, EDITS_STORE],
      'readonly',
    );
    await this.#projectInTransaction(transaction, projectId);
    const edits = (await requestResult(
      transaction
        .objectStore(EDITS_STORE)
        .index(PROJECT_ID_INDEX)
        .getAll(projectId),
    )) as ProjectEdit[];
    await transactionDone(transaction);
    return edits
      .map((edit, index) => parseProjectEdit(edit, `edits[${index}]`))
      .sort(
        (left, right) =>
          left.projectVersion - right.projectVersion ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
  }

  async exportProject(
    projectId: EntityId,
    exportedAt = new Date().toISOString(),
  ): Promise<ProjectExportBundle> {
    const timestamp = dateTimeAt(exportedAt, 'exportedAt');
    const database = await this.#database();
    const transaction = database.transaction(
      [PROJECTS_STORE, BLOBS_STORE, CHUNKS_STORE, EDITS_STORE],
      'readonly',
    );
    const project = await this.#projectInTransaction(transaction, projectId);
    const blobs = (await requestResult(
      transaction
        .objectStore(BLOBS_STORE)
        .index(PROJECT_ID_INDEX)
        .getAll(projectId),
    )) as StoredBlob[];
    const chunks = (await requestResult(
      transaction
        .objectStore(CHUNKS_STORE)
        .index(PROJECT_ID_INDEX)
        .getAll(projectId),
    )) as SourceChunk[];
    const edits = (await requestResult(
      transaction
        .objectStore(EDITS_STORE)
        .index(PROJECT_ID_INDEX)
        .getAll(projectId),
    )) as ProjectEdit[];
    await transactionDone(transaction);
    const bundle: ProjectExportBundle = {
      format: PROJECT_EXPORT_FORMAT,
      formatVersion: PROJECT_EXPORT_FORMAT_VERSION,
      exportedAt: timestamp,
      project,
      sourceBlobs: blobs
        .map((entry) => ({
          sourceFileId: entry.sourceFileId,
          blob: clone(entry.blob),
        }))
        .sort((left, right) =>
          left.sourceFileId.localeCompare(right.sourceFileId),
        ),
      sourceChunks: chunks
        .map((chunk) => parseSourceChunk(chunk))
        .sort(
          (left, right) =>
            left.sourceFileId.localeCompare(right.sourceFileId) ||
            left.ordinal - right.ordinal,
        ),
      editHistory: edits
        .map((edit, index) => parseProjectEdit(edit, `edits[${index}]`))
        .sort(
          (left, right) =>
            left.projectVersion - right.projectVersion ||
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id),
        ),
    };
    if (!sameChunks(bundle.project.sourceChunks, bundle.sourceChunks)) {
      throw new ProjectStoreError(
        'cannot export inconsistent project.sourceChunks',
      );
    }
    validateBundleOwnership(
      bundle.project,
      bundle.sourceBlobs,
      bundle.sourceChunks,
      bundle.editHistory,
    );
    return bundle;
  }

  async importProject(input: unknown): Promise<Project> {
    const bundle = parseBundle(input);
    const database = await this.#database();
    const transaction = database.transaction(
      [PROJECTS_STORE, BLOBS_STORE, CHUNKS_STORE, EDITS_STORE],
      'readwrite',
    );
    const projects = transaction.objectStore(PROJECTS_STORE);
    const current = await requestResult(projects.get(bundle.project.id));
    if (current !== undefined) {
      transaction.abort();
      throw new ProjectAlreadyExistsError(bundle.project.id);
    }
    projects.add(clone(bundle.project));
    const blobs = transaction.objectStore(BLOBS_STORE);
    for (const entry of bundle.sourceBlobs) {
      const stored: StoredBlob = {
        key: blobKey(bundle.project.id, entry.sourceFileId),
        projectId: bundle.project.id,
        sourceFileId: entry.sourceFileId,
        blob: clone(entry.blob),
      };
      blobs.add(stored);
    }
    const chunks = transaction.objectStore(CHUNKS_STORE);
    for (const chunk of bundle.sourceChunks) {
      chunks.add(clone(chunk));
    }
    const edits = transaction.objectStore(EDITS_STORE);
    for (const edit of bundle.editHistory) {
      edits.add(clone(edit));
    }
    await transactionDone(transaction);
    return clone(bundle.project);
  }

  close(): void {
    this.#closed = true;
    void this.#databasePromise.then((database) => database.close());
  }

  async #database(): Promise<IDBDatabase> {
    if (this.#closed) {
      throw new ProjectStoreUnavailableError('ProjectStore is closed');
    }
    try {
      return await this.#databasePromise;
    } catch (error) {
      if (error instanceof ProjectStoreError) {
        throw error;
      }
      throw new ProjectStoreUnavailableError(
        error instanceof Error ? error.message : 'Unable to open IndexedDB',
      );
    }
  }

  async #projectInTransaction(
    transaction: IDBTransaction,
    projectId: EntityId,
  ): Promise<Project> {
    const value = (await requestResult(
      transaction.objectStore(PROJECTS_STORE).get(projectId),
    )) as Project | undefined;
    if (value === undefined) {
      transaction.abort();
      throw new ProjectNotFoundError(projectId);
    }
    return parseProject(value);
  }

  async #writeProjectChunks(
    transaction: IDBTransaction,
    project: Project,
  ): Promise<void> {
    const store = transaction.objectStore(CHUNKS_STORE);
    const keys = await requestResult(
      store.index(PROJECT_ID_INDEX).getAllKeys(project.id),
    );
    for (const key of keys) {
      store.delete(key);
    }
    for (const chunk of project.sourceChunks) {
      store.add(clone(chunk));
    }
  }
}

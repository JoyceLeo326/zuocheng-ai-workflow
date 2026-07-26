import {
  parseProject,
  type EntityId,
  type IsoDateTime,
  type Project,
} from './project-model.js';

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type LifecycleProjectStatus =
  | 'active'
  | 'archived'
  | 'trashed';

export type RestorableProjectStatus = Exclude<
  LifecycleProjectStatus,
  'trashed'
>;

type DeepReadonly<T> = T extends
  | null
  | undefined
  | string
  | number
  | boolean
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends (...args: never[]) => unknown
      ? T
      : { readonly [Key in keyof T]: DeepReadonly<T[Key]> };

type MutableLifecycleProject = Omit<Project, 'status'> & {
  status: LifecycleProjectStatus;
  statusBeforeTrash: RestorableProjectStatus | null;
  trashedAt: IsoDateTime | null;
};

export type LifecycleProject = DeepReadonly<MutableLifecycleProject>;
export type LifecycleProjectInput = Project | LifecycleProject;

export interface ProjectLifecycleCommand {
  expectedVersion: number;
  now: IsoDateTime;
}

export interface CopyProjectCommand extends ProjectLifecycleCommand {
  idFactory(): EntityId;
}

export interface PermanentDeleteProjectIntent {
  readonly kind: 'permanent-delete-project';
  readonly projectId: EntityId;
  readonly projectVersion: number;
  readonly requestedAt: IsoDateTime;
}

export type ProjectLifecycleErrorCode =
  | 'INVALID_PROJECT'
  | 'VERSION_CONFLICT'
  | 'INVALID_TIMESTAMP'
  | 'INVALID_TRANSITION'
  | 'PROJECT_TRASHED'
  | 'INVALID_UUID_FACTORY';

export class ProjectLifecycleError extends Error {
  override readonly cause: unknown;

  constructor(
    readonly code: ProjectLifecycleErrorCode,
    message: string,
    readonly expectedVersion?: number,
    readonly currentVersion?: number,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ProjectLifecycleError';
    this.cause = cause;
  }
}

export function toLifecycleProject(
  project: Project,
): LifecycleProject {
  return freezeProject(normalizeLifecycleProject(project));
}

export function copyProject(
  source: LifecycleProjectInput,
  command: CopyProjectCommand,
): LifecycleProject {
  const current = normalizeLifecycleProject(source);
  assertCommand(current, command);
  if (current.status === 'trashed') {
    fail('PROJECT_TRASHED', 'A trashed project cannot be copied.');
  }

  const sourceProject = projectForModel(current);
  const oldIds = collectEntityIds(sourceProject);
  const idMap = new Map<EntityId, EntityId>();
  const generatedIds = new Set<EntityId>();
  for (const oldId of oldIds) {
    let nextId: EntityId;
    try {
      nextId = command.idFactory();
    } catch {
      fail(
        'INVALID_UUID_FACTORY',
        'The UUID factory failed while copying the project.',
      );
    }
    if (
      !isUuidV7(nextId) ||
      nextId === oldId ||
      oldIds.has(nextId) ||
      generatedIds.has(nextId)
    ) {
      fail(
        'INVALID_UUID_FACTORY',
        'The UUID factory must return unique new canonical UUIDv7 values.',
      );
    }
    generatedIds.add(nextId);
    idMap.set(oldId, nextId);
  }

  const rewritten = rewriteReferences(sourceProject, idMap) as Project;
  resetVersionedEntities(rewritten, generatedIds, command.now);
  rewritten.status = 'active';
  rewritten.sourceFiles.forEach((sourceFile) => {
    sourceFile.sourceVersion = 1;
    sourceFile.blobId = `source-file:${sourceFile.id}`;
  });
  rewritten.sourceChunks.forEach((chunk) => {
    chunk.sourceFileVersion = 1;
  });
  rewritten.evidenceCards.forEach((evidence) => {
    evidence.sourceFileVersion = 1;
    evidence.userConfirmedAt =
      evidence.confirmationStatus === 'confirmed'
        ? command.now
        : null;
  });
  rewritten.outlines.forEach((outline) => {
    outline.lockedAt =
      outline.status === 'locked' ? command.now : null;
  });
  rewritten.artifacts.forEach((artifact) => {
    artifact.outlineVersion = 1;
    artifact.status = 'stale';
    artifact.blobId = null;
    artifact.contentSha256 = null;
    artifact.staleBecause = ['PROJECT_COPIED'];
    artifact.errorCode = null;
  });
  rewritten.verificationResults.forEach((result) => {
    result.artifactVersion = 1;
    result.status = 'stale';
    result.checkedAt = command.now;
  });

  let parsed: Project;
  try {
    parsed = parseProject(rewritten);
  } catch (error) {
    throw new ProjectLifecycleError(
      'INVALID_PROJECT',
      'The copied project did not satisfy aggregate invariants.',
      undefined,
      undefined,
      error,
    );
  }
  return freezeProject({
    ...parsed,
    status: 'active',
    statusBeforeTrash: null,
    trashedAt: null,
  });
}

export function archiveProject(
  project: LifecycleProjectInput,
  command: ProjectLifecycleCommand,
): LifecycleProject {
  return transitionProject(project, command, 'active', 'archived');
}

export function activateProject(
  project: LifecycleProjectInput,
  command: ProjectLifecycleCommand,
): LifecycleProject {
  return transitionProject(project, command, 'archived', 'active');
}

export function trashProject(
  project: LifecycleProjectInput,
  command: ProjectLifecycleCommand,
): LifecycleProject {
  const current = normalizeLifecycleProject(project);
  assertCommand(current, command);
  if (current.status === 'trashed') {
    fail(
      'INVALID_TRANSITION',
      'Only an active or archived project can be trashed.',
    );
  }
  return freezeProject({
    ...current,
    version: current.version + 1,
    updatedAt: command.now,
    statusBeforeTrash: current.status,
    status: 'trashed',
    trashedAt: command.now,
  });
}

export function restoreProject(
  project: LifecycleProjectInput,
  command: ProjectLifecycleCommand,
): LifecycleProject {
  const current = normalizeLifecycleProject(project);
  assertCommand(current, command);
  if (
    current.status !== 'trashed' ||
    current.statusBeforeTrash === null
  ) {
    fail(
      'INVALID_TRANSITION',
      'Only a trashed project can be restored.',
    );
  }
  return freezeProject({
    ...current,
    version: current.version + 1,
    updatedAt: command.now,
    status: current.statusBeforeTrash,
    statusBeforeTrash: null,
    trashedAt: null,
  });
}

export function requestPermanentDelete(
  project: LifecycleProjectInput,
  command: ProjectLifecycleCommand,
): PermanentDeleteProjectIntent {
  const current = normalizeLifecycleProject(project);
  assertCommand(current, command);
  if (current.status !== 'trashed') {
    fail(
      'INVALID_TRANSITION',
      'Permanent deletion requires a trashed project.',
    );
  }
  return Object.freeze({
    kind: 'permanent-delete-project',
    projectId: current.id,
    projectVersion: current.version,
    requestedAt: command.now,
  });
}

function transitionProject(
  project: LifecycleProjectInput,
  command: ProjectLifecycleCommand,
  from: RestorableProjectStatus,
  to: RestorableProjectStatus,
): LifecycleProject {
  const current = normalizeLifecycleProject(project);
  assertCommand(current, command);
  if (current.status !== from) {
    fail(
      'INVALID_TRANSITION',
      `Project must be ${from} before transitioning to ${to}.`,
    );
  }
  return freezeProject({
    ...current,
    version: current.version + 1,
    updatedAt: command.now,
    status: to,
    statusBeforeTrash: null,
    trashedAt: null,
  });
}

function normalizeLifecycleProject(
  input: LifecycleProjectInput,
): MutableLifecycleProject {
  let candidate: unknown;
  try {
    candidate = structuredClone(input);
  } catch (error) {
    throw new ProjectLifecycleError(
      'INVALID_PROJECT',
      'Project aggregate could not be cloned.',
      undefined,
      undefined,
      error,
    );
  }
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    fail('INVALID_PROJECT', 'Project aggregate must be an object.');
  }
  const raw = candidate as Record<string, unknown>;
  const status = raw.status;
  const statusBeforeTrash =
    'statusBeforeTrash' in raw ? raw.statusBeforeTrash : null;
  const trashedAt = 'trashedAt' in raw ? raw.trashedAt : null;
  if (
    status !== 'active' &&
    status !== 'archived' &&
    status !== 'trashed'
  ) {
    fail('INVALID_PROJECT', 'Project has an invalid lifecycle status.');
  }
  if (status === 'trashed') {
    if (
      (statusBeforeTrash !== 'active' &&
        statusBeforeTrash !== 'archived') ||
      !isCanonicalDateTime(trashedAt)
    ) {
      fail(
        'INVALID_PROJECT',
        'A trashed project requires its previous status and trashedAt.',
      );
    }
  } else if (statusBeforeTrash !== null || trashedAt !== null) {
    fail(
      'INVALID_PROJECT',
      'A non-trashed project cannot retain trash metadata.',
    );
  }

  const modelInput: Record<string, unknown> = {
    ...raw,
    status: status === 'trashed' ? statusBeforeTrash : status,
  };
  delete modelInput.statusBeforeTrash;
  delete modelInput.trashedAt;
  let parsed: Project;
  try {
    parsed = parseProject(modelInput);
  } catch (error) {
    throw new ProjectLifecycleError(
      'INVALID_PROJECT',
      'Project aggregate validation failed.',
      undefined,
      undefined,
      error,
    );
  }
  return {
    ...parsed,
    status,
    statusBeforeTrash:
      status === 'trashed'
        ? (statusBeforeTrash as RestorableProjectStatus)
        : null,
    trashedAt: status === 'trashed' ? (trashedAt as string) : null,
  };
}

function projectForModel(project: MutableLifecycleProject): Project {
  const snapshot: Record<string, unknown> = { ...project };
  delete snapshot.statusBeforeTrash;
  delete snapshot.trashedAt;
  return parseProject({
    ...snapshot,
    status:
      project.status === 'trashed'
        ? (project.statusBeforeTrash ?? 'active')
        : project.status,
  });
}

function assertCommand(
  project: MutableLifecycleProject,
  command: ProjectLifecycleCommand,
): void {
  if (
    !Number.isSafeInteger(command.expectedVersion) ||
    command.expectedVersion !== project.version
  ) {
    throw new ProjectLifecycleError(
      'VERSION_CONFLICT',
      `Expected project version ${String(command.expectedVersion)}, current version is ${String(project.version)}.`,
      command.expectedVersion,
      project.version,
    );
  }
  if (
    !isCanonicalDateTime(command.now) ||
    Date.parse(command.now) <= Date.parse(project.updatedAt)
  ) {
    fail(
      'INVALID_TIMESTAMP',
      'Lifecycle time must be canonical and later than project.updatedAt.',
    );
  }
}

function collectEntityIds(project: Project): Set<EntityId> {
  const ids = new Set<EntityId>();
  const add = (id: EntityId) => {
    ids.add(id);
  };
  add(project.id);
  add(project.taskDefinition.id);
  project.taskDefinition.rubric.forEach((criterion) => add(criterion.id));
  project.sourceFiles.forEach((source) => add(source.id));
  project.sourceChunks.forEach((chunk) => add(chunk.id));
  project.evidenceCards.forEach((evidence) => add(evidence.id));
  project.outlines.forEach((outline) => {
    add(outline.id);
    outline.nodes.forEach((node) => add(node.id));
  });
  project.artifacts.forEach((artifact) => {
    add(artifact.id);
    collectPayloadEntityIds(artifact.payload, ids);
  });
  project.verificationResults.forEach((result) => {
    add(result.id);
    result.checks.forEach((check) => add(check.id));
  });
  return ids;
}

function collectPayloadEntityIds(
  value: unknown,
  ids: Set<EntityId>,
): void {
  if (isUuidV7(value)) {
    ids.add(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectPayloadEntityIds(item, ids));
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  Object.entries(value as Record<string, unknown>).forEach(
    ([key, item]) => {
      if (isUuidV7(key)) {
        ids.add(key);
      }
      collectPayloadEntityIds(item, ids);
    },
  );
}

function rewriteReferences(
  value: unknown,
  idMap: ReadonlyMap<EntityId, EntityId>,
): unknown {
  if (typeof value === 'string') {
    return idMap.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteReferences(item, idMap));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => [
        idMap.get(key) ?? key,
        rewriteReferences(item, idMap),
      ],
    ),
  );
}

function resetVersionedEntities(
  value: unknown,
  entityIds: ReadonlySet<EntityId>,
  now: IsoDateTime,
): void {
  if (Array.isArray(value)) {
    value.forEach((item) => resetVersionedEntities(item, entityIds, now));
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  const object = value as Record<string, unknown>;
  Object.values(object).forEach((item) =>
    resetVersionedEntities(item, entityIds, now),
  );
  if (
    typeof object.id === 'string' &&
    entityIds.has(object.id) &&
    'version' in object &&
    'createdAt' in object &&
    'updatedAt' in object
  ) {
    object.version = 1;
    object.createdAt = now;
    object.updatedAt = now;
  }
}

function freezeProject(
  project: MutableLifecycleProject,
): LifecycleProject {
  return deepFreeze(project) as LifecycleProject;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== 'object' || value === null) {
    return value as DeepReadonly<T>;
  }
  Object.values(value).forEach((item) => {
    deepFreeze(item);
  });
  return Object.freeze(value) as DeepReadonly<T>;
}

function isUuidV7(value: unknown): value is EntityId {
  return (
    typeof value === 'string' &&
    UUID_V7.test(value) &&
    value === value.toLowerCase()
  );
}

function isCanonicalDateTime(value: unknown): value is IsoDateTime {
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.valueOf()) &&
    parsed.toISOString() === value
  );
}

function fail(
  code: ProjectLifecycleErrorCode,
  message: string,
): never {
  throw new ProjectLifecycleError(code, message);
}

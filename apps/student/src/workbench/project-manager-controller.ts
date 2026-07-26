import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
  type Unzipped,
  type Zippable,
} from 'fflate';
import {
  PROJECT_SCHEMA_VERSION,
  parseProject,
  type Project,
} from './project-model.js';
import {
  PROJECT_EXPORT_FORMAT,
  PROJECT_EXPORT_FORMAT_VERSION,
  ProjectNotFoundError,
  type ProjectExportBlob,
  type ProjectExportBundle,
} from './project-store.js';
import type {
  ManagedProject,
  ProjectManagerCallbacks,
} from './project-manager.js';
import type { WorkbenchProjectLifecycleService } from './workbench-service.js';

export const PROJECT_PACKAGE_FORMAT =
  'zuocheng-project-package' as const;
export const PROJECT_PACKAGE_FORMAT_VERSION = 1 as const;

const PACKAGE_MIME_TYPE = 'application/zip';
const MANIFEST_PATH = 'manifest.json';
const PROJECT_PATH = 'project.json';
const CHUNKS_PATH = 'source-chunks.json';
const EDITS_PATH = 'edit-history.json';
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ARCHIVE_PATH =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[a-zA-Z0-9._/-]+$/u;
const MAX_COMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4_096;
const ZIP_EPOCH = new Date('1980-01-01T00:00:00.000Z');

export type ProjectPackageErrorCode =
  | 'CRYPTO_UNAVAILABLE'
  | 'INVALID_ARCHIVE'
  | 'UNSUPPORTED_FORMAT'
  | 'UNSUPPORTED_VERSION'
  | 'MISSING_ENTRY'
  | 'SHA_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'MANIFEST_MISMATCH';

export class ProjectPackageError extends Error {
  override readonly cause: unknown;

  constructor(
    readonly code: ProjectPackageErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ProjectPackageError';
    this.cause = cause;
  }
}

export interface ProjectManagerControllerOptions {
  service: WorkbenchProjectLifecycleService;
  openProject(project: Project): Promise<void>;
  prepareNewProject(title: string): Promise<void>;
  cryptoProvider?: Crypto;
}

interface PackageEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
}

interface PackageCollectionEntry extends PackageEntry {
  count: number;
}

interface PackageSourceEntry extends PackageEntry {
  sourceFileId: string;
  fileName: string;
  mediaType: string;
}

interface ProjectPackageManifest {
  format: typeof PROJECT_PACKAGE_FORMAT;
  formatVersion: typeof PROJECT_PACKAGE_FORMAT_VERSION;
  bundleFormat: typeof PROJECT_EXPORT_FORMAT;
  bundleFormatVersion: typeof PROJECT_EXPORT_FORMAT_VERSION;
  exportedAt: string;
  projectId: string;
  projectVersion: number;
  projectSchemaVersion: number;
  project: PackageEntry;
  sourceChunks: PackageCollectionEntry;
  editHistory: PackageCollectionEntry;
  sourceBlobs: PackageSourceEntry[];
}

export class ProjectManagerController
  implements ProjectManagerCallbacks
{
  readonly #service: WorkbenchProjectLifecycleService;
  readonly #openProject: (project: Project) => Promise<void>;
  readonly #prepareNewProject: (title: string) => Promise<void>;
  readonly #cryptoProvider: Crypto | undefined;
  #projectsById = new Map<string, Project>();
  #managedProjects: readonly ManagedProject[] = Object.freeze([]);

  constructor(options: ProjectManagerControllerOptions) {
    this.#service = options.service;
    this.#openProject = options.openProject;
    this.#prepareNewProject = options.prepareNewProject;
    this.#cryptoProvider = options.cryptoProvider ?? globalThis.crypto;
  }

  get projects(): readonly ManagedProject[] {
    return this.#managedProjects;
  }

  async refresh(): Promise<readonly ManagedProject[]> {
    const projects = await this.#service.listProjects();
    this.#projectsById = new Map(
      projects.map((project) => [project.id, project]),
    );
    this.#managedProjects = Object.freeze(
      projects.map((project) => mapManagedProject(project)),
    );
    return this.#managedProjects;
  }

  readonly onOpen: ProjectManagerCallbacks['onOpen'] = async ({
    projectId,
  }) => {
    await this.refresh();
    const project = await this.#requireProject(projectId);
    await this.#openProject(structuredClone(project));
  };

  readonly onCreate: ProjectManagerCallbacks['onCreate'] = async ({
    title,
  }) => {
    const normalizedTitle = title.trim();
    if (normalizedTitle.length === 0) {
      throw new Error('Project title must not be empty.');
    }
    await this.#prepareNewProject(normalizedTitle);
  };

  readonly onDuplicate: ProjectManagerCallbacks['onDuplicate'] = async ({
    projectId,
  }) => {
    const project = await this.#requireProject(projectId);
    await this.#service.copyProject(projectId, project.version);
    await this.refresh();
  };

  readonly onArchive: ProjectManagerCallbacks['onArchive'] = async ({
    projectId,
  }) => {
    const project = await this.#requireProject(projectId);
    await this.#service.archiveProject(projectId, project.version);
    await this.refresh();
  };

  readonly onRestore: ProjectManagerCallbacks['onRestore'] = async ({
    projectId,
    from,
  }) => {
    const project = await this.#requireProject(projectId);
    if (from === 'archived') {
      await this.#service.activateProject(projectId, project.version);
    } else {
      await this.#service.restoreProject(projectId, project.version);
    }
    await this.refresh();
  };

  readonly onMoveToTrash: ProjectManagerCallbacks['onMoveToTrash'] =
    async ({ projectId }) => {
      const project = await this.#requireProject(projectId);
      await this.#service.trashProject(projectId, project.version);
      await this.refresh();
    };

  readonly onDeletePermanently: ProjectManagerCallbacks['onDeletePermanently'] =
    async ({ projectId }) => {
      const project = await this.#requireProject(projectId);
      await this.#service.permanentlyDeleteProject(
        projectId,
        project.version,
      );
      await this.refresh();
    };

  readonly onExportProjectPackage: ProjectManagerCallbacks['onExportProjectPackage'] =
    async ({ projectId }) => {
      await this.#requireProject(projectId);
      const bundle = await this.#service.exportProjectBundle(projectId);
      const blob = await serializeProjectPackage(
        bundle,
        this.#cryptoProvider,
      );
      return {
        blob,
        fileName:
          `${safeFileBase(bundle.project.title)}-${bundle.project.id}` +
          '.zuocheng.zip',
      };
    };

  readonly onImportProjectPackage: ProjectManagerCallbacks['onImportProjectPackage'] =
    async ({ file }) => {
      const bundle = await deserializeProjectPackage(
        file,
        this.#cryptoProvider,
      );
      await this.#service.importProjectBundle(bundle);
      await this.refresh();
    };

  async #requireProject(projectId: string): Promise<Project> {
    let project = this.#projectsById.get(projectId);
    if (project === undefined) {
      await this.refresh();
      project = this.#projectsById.get(projectId);
    }
    if (project === undefined) {
      throw new ProjectNotFoundError(projectId);
    }
    return project;
  }
}

export function createProjectManagerController(
  options: ProjectManagerControllerOptions,
): ProjectManagerController {
  return new ProjectManagerController(options);
}

export function mapManagedProject(project: Project): ManagedProject {
  const activeOutlineId =
    project.activeOutlineId ??
    project.outlines.find(
      (outline) =>
        outline.status === 'selected' ||
        outline.status === 'locked',
    )?.id ??
    null;
  const draftArtifact = project.artifacts.find(
    (artifact) =>
      (activeOutlineId === null ||
        artifact.outlineId === activeOutlineId) &&
      typeof artifact.payload === 'object' &&
      artifact.payload !== null &&
      !Array.isArray(artifact.payload) &&
      artifact.payload.format === 'zuocheng-draft-artifact',
  );
  const draftPageCount =
    draftArtifact !== undefined &&
    typeof draftArtifact.payload === 'object' &&
    draftArtifact.payload !== null &&
    !Array.isArray(draftArtifact.payload) &&
    Array.isArray(draftArtifact.payload.pages)
      ? draftArtifact.payload.pages.length
      : 0;
  return Object.freeze({
    id: project.id,
    title: project.title,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    sourceCount: project.sourceFiles.length,
    draftPageCount,
  });
}

export async function serializeProjectPackage(
  bundle: ProjectExportBundle,
  cryptoProvider: Crypto | undefined = globalThis.crypto,
): Promise<Blob> {
  const subtle = requireSubtleCrypto(cryptoProvider);
  const projectBytes = jsonBytes(bundle.project);
  const chunkBytes = jsonBytes(bundle.sourceChunks);
  const editBytes = jsonBytes(bundle.editHistory);
  const projectEntry = await describeEntry(
    PROJECT_PATH,
    projectBytes,
    subtle,
  );
  const sourceChunks = {
    ...(await describeEntry(CHUNKS_PATH, chunkBytes, subtle)),
    count: bundle.sourceChunks.length,
  };
  const editHistory = {
    ...(await describeEntry(EDITS_PATH, editBytes, subtle)),
    count: bundle.editHistory.length,
  };
  const sourceEntries: PackageSourceEntry[] = [];
  const sourceBytes = new Map<string, Uint8Array>();
  for (const entry of bundle.sourceBlobs) {
    const source = bundle.project.sourceFiles.find(
      (candidate) => candidate.id === entry.sourceFileId,
    );
    if (source === undefined) {
      throw new ProjectPackageError(
        'MANIFEST_MISMATCH',
        `Source blob ${entry.sourceFileId} is not owned by the project.`,
      );
    }
    const path = `sources/${source.id}.bin`;
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    const described = await describeEntry(path, bytes, subtle);
    if (described.sha256 !== source.contentSha256) {
      failPackage(
        'SHA_MISMATCH',
        `Source blob ${source.id} does not match project contentSha256.`,
      );
    }
    sourceBytes.set(path, bytes);
    sourceEntries.push({
      ...described,
      sourceFileId: source.id,
      fileName: source.fileName,
      mediaType: source.mediaType,
    });
  }
  const manifest: ProjectPackageManifest = {
    format: PROJECT_PACKAGE_FORMAT,
    formatVersion: PROJECT_PACKAGE_FORMAT_VERSION,
    bundleFormat: bundle.format,
    bundleFormatVersion: bundle.formatVersion,
    exportedAt: bundle.exportedAt,
    projectId: bundle.project.id,
    projectVersion: bundle.project.version,
    projectSchemaVersion: bundle.project.schemaVersion,
    project: projectEntry,
    sourceChunks,
    editHistory,
    sourceBlobs: sourceEntries,
  };
  const archive: Zippable = {
    [MANIFEST_PATH]: zipEntry(jsonBytes(manifest)),
    [PROJECT_PATH]: zipEntry(projectBytes),
    [CHUNKS_PATH]: zipEntry(chunkBytes),
    [EDITS_PATH]: zipEntry(editBytes),
  };
  for (const [path, bytes] of sourceBytes) {
    archive[path] = zipEntry(bytes);
  }
  return blobFromBytes(zipSync(archive), PACKAGE_MIME_TYPE);
}

export async function deserializeProjectPackage(
  file: Blob,
  cryptoProvider: Crypto | undefined = globalThis.crypto,
): Promise<ProjectExportBundle> {
  if (!(file instanceof Blob) || file.size > MAX_COMPRESSED_BYTES) {
    failPackage('INVALID_ARCHIVE', 'Project package is not a valid ZIP.');
  }
  const subtle = requireSubtleCrypto(cryptoProvider);
  const archive = extractArchive(
    new Uint8Array(await file.arrayBuffer()),
  );
  const manifest = parseManifest(
    parseJson(archive[MANIFEST_PATH], MANIFEST_PATH),
  );
  assertExactArchivePaths(archive, manifest);
  const project = parseProject(
    await verifiedJson(archive, manifest.project, subtle),
  );
  if (
    project.id !== manifest.projectId ||
    project.version !== manifest.projectVersion ||
    project.schemaVersion !== manifest.projectSchemaVersion
  ) {
    failPackage(
      'MANIFEST_MISMATCH',
      'Project identity or version does not match the manifest.',
    );
  }
  const sourceChunks = await verifiedJson(
    archive,
    manifest.sourceChunks,
    subtle,
  );
  if (
    !Array.isArray(sourceChunks) ||
    sourceChunks.length !== manifest.sourceChunks.count
  ) {
    failPackage(
      'MANIFEST_MISMATCH',
      'Source chunk count does not match the manifest.',
    );
  }
  const editHistory = await verifiedJson(
    archive,
    manifest.editHistory,
    subtle,
  );
  if (
    !Array.isArray(editHistory) ||
    editHistory.length !== manifest.editHistory.count
  ) {
    failPackage(
      'MANIFEST_MISMATCH',
      'Edit history count does not match the manifest.',
    );
  }
  const sourceBlobs: ProjectExportBlob[] = [];
  for (const entry of manifest.sourceBlobs) {
    const source = project.sourceFiles.find(
      (candidate) => candidate.id === entry.sourceFileId,
    );
    if (
      source === undefined ||
      entry.fileName !== source.fileName ||
      entry.mediaType !== source.mediaType ||
      entry.sizeBytes !== source.sizeBytes ||
      entry.sha256 !== source.contentSha256
    ) {
      failPackage(
        'MANIFEST_MISMATCH',
        `Source blob ${entry.sourceFileId} does not match project metadata.`,
      );
    }
    const bytes = await verifiedBytes(archive, entry, subtle);
    sourceBlobs.push({
      sourceFileId: entry.sourceFileId,
      blob: blobFromBytes(bytes, entry.mediaType),
    });
  }
  return {
    format: PROJECT_EXPORT_FORMAT,
    formatVersion: PROJECT_EXPORT_FORMAT_VERSION,
    exportedAt: manifest.exportedAt,
    project,
    sourceBlobs,
    sourceChunks: sourceChunks as ProjectExportBundle['sourceChunks'],
    editHistory: editHistory as ProjectExportBundle['editHistory'],
  };
}

function requireSubtleCrypto(
  cryptoProvider: Crypto | undefined,
): SubtleCrypto {
  if (cryptoProvider?.subtle === undefined) {
    failPackage(
      'CRYPTO_UNAVAILABLE',
      'Web Crypto SHA-256 is unavailable.',
    );
  }
  return cryptoProvider.subtle;
}

function jsonBytes(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`);
}

function zipEntry(bytes: Uint8Array): Zippable[string] {
  return [
    bytes,
    {
      level: 6,
      mtime: ZIP_EPOCH,
    },
  ];
}

async function describeEntry(
  path: string,
  bytes: Uint8Array,
  subtle: SubtleCrypto,
): Promise<PackageEntry> {
  return {
    path,
    sha256: await sha256Bytes(bytes, subtle),
    sizeBytes: bytes.byteLength,
  };
}

function extractArchive(bytes: Uint8Array): Unzipped {
  let totalBytes = 0;
  let entryCount = 0;
  const paths = new Set<string>();
  try {
    return unzipSync(bytes, {
      filter: (entry) => {
        entryCount += 1;
        if (
          entryCount > MAX_ARCHIVE_ENTRIES ||
          !isSafeArchivePath(entry.name) ||
          paths.has(entry.name) ||
          entry.originalSize < 0 ||
          entry.originalSize > MAX_ENTRY_BYTES
        ) {
          failPackage(
            'INVALID_ARCHIVE',
            'Project package contains an unsafe ZIP entry.',
          );
        }
        paths.add(entry.name);
        totalBytes += entry.originalSize;
        if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
          failPackage(
            'INVALID_ARCHIVE',
            'Project package expands beyond the supported size.',
          );
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ProjectPackageError) {
      throw error;
    }
    throw new ProjectPackageError(
      'INVALID_ARCHIVE',
      'Project package could not be decompressed.',
      error,
    );
  }
}

function parseManifest(input: unknown): ProjectPackageManifest {
  const object = objectAt(input, 'manifest');
  if (object.format !== PROJECT_PACKAGE_FORMAT) {
    failPackage(
      'UNSUPPORTED_FORMAT',
      `manifest.format must equal ${PROJECT_PACKAGE_FORMAT}.`,
    );
  }
  if (object.formatVersion !== PROJECT_PACKAGE_FORMAT_VERSION) {
    failPackage(
      'UNSUPPORTED_VERSION',
      `manifest.formatVersion must equal ${PROJECT_PACKAGE_FORMAT_VERSION}.`,
    );
  }
  if (object.bundleFormat !== PROJECT_EXPORT_FORMAT) {
    failPackage(
      'UNSUPPORTED_FORMAT',
      `manifest.bundleFormat must equal ${PROJECT_EXPORT_FORMAT}.`,
    );
  }
  if (object.bundleFormatVersion !== PROJECT_EXPORT_FORMAT_VERSION) {
    failPackage(
      'UNSUPPORTED_VERSION',
      'manifest.bundleFormatVersion is unsupported.',
    );
  }
  const sourceBlobs = arrayAt(
    object.sourceBlobs,
    'manifest.sourceBlobs',
  ).map((entry, index) =>
    sourceEntryAt(entry, `manifest.sourceBlobs[${index}]`),
  );
  const project = entryAt(object.project, 'manifest.project');
  const sourceChunks = collectionEntryAt(
    object.sourceChunks,
    'manifest.sourceChunks',
  );
  const editHistory = collectionEntryAt(
    object.editHistory,
    'manifest.editHistory',
  );
  const projectSchemaVersion = positiveIntegerAt(
    object.projectSchemaVersion,
    'manifest.projectSchemaVersion',
  );
  if (projectSchemaVersion !== PROJECT_SCHEMA_VERSION) {
    failPackage(
      'UNSUPPORTED_VERSION',
      `manifest.projectSchemaVersion must equal ${PROJECT_SCHEMA_VERSION}.`,
    );
  }
  const paths = [
    MANIFEST_PATH,
    project.path,
    sourceChunks.path,
    editHistory.path,
    ...sourceBlobs.map((entry) => entry.path),
  ];
  if (new Set(paths).size !== paths.length) {
    failPackage(
      'MANIFEST_MISMATCH',
      'Manifest paths must be unique.',
    );
  }
  const sourceFileIds = sourceBlobs.map((entry) => entry.sourceFileId);
  if (new Set(sourceFileIds).size !== sourceFileIds.length) {
    failPackage(
      'MANIFEST_MISMATCH',
      'Manifest source file identities must be unique.',
    );
  }
  return {
    format: PROJECT_PACKAGE_FORMAT,
    formatVersion: PROJECT_PACKAGE_FORMAT_VERSION,
    bundleFormat: PROJECT_EXPORT_FORMAT,
    bundleFormatVersion: PROJECT_EXPORT_FORMAT_VERSION,
    exportedAt: dateTimeAt(object.exportedAt, 'manifest.exportedAt'),
    projectId: stringAt(object.projectId, 'manifest.projectId'),
    projectVersion: positiveIntegerAt(
      object.projectVersion,
      'manifest.projectVersion',
    ),
    projectSchemaVersion,
    project,
    sourceChunks,
    editHistory,
    sourceBlobs,
  };
}

function entryAt(input: unknown, path: string): PackageEntry {
  const object = objectAt(input, path);
  const entryPath = stringAt(object.path, `${path}.path`);
  if (!isSafeArchivePath(entryPath) || entryPath === MANIFEST_PATH) {
    failPackage(
      'MANIFEST_MISMATCH',
      `${path}.path is not a safe archive path.`,
    );
  }
  const sha256 = stringAt(object.sha256, `${path}.sha256`);
  if (!SHA256.test(sha256)) {
    failPackage(
      'MANIFEST_MISMATCH',
      `${path}.sha256 must be lowercase SHA-256.`,
    );
  }
  return {
    path: entryPath,
    sha256,
    sizeBytes: nonNegativeIntegerAt(
      object.sizeBytes,
      `${path}.sizeBytes`,
    ),
  };
}

function collectionEntryAt(
  input: unknown,
  path: string,
): PackageCollectionEntry {
  const object = objectAt(input, path);
  return {
    ...entryAt(object, path),
    count: nonNegativeIntegerAt(object.count, `${path}.count`),
  };
}

function sourceEntryAt(
  input: unknown,
  path: string,
): PackageSourceEntry {
  const object = objectAt(input, path);
  return {
    ...entryAt(object, path),
    sourceFileId: stringAt(
      object.sourceFileId,
      `${path}.sourceFileId`,
    ),
    fileName: stringAt(object.fileName, `${path}.fileName`),
    mediaType: stringAt(object.mediaType, `${path}.mediaType`),
  };
}

function assertExactArchivePaths(
  archive: Unzipped,
  manifest: ProjectPackageManifest,
): void {
  const expected = new Set([
    MANIFEST_PATH,
    manifest.project.path,
    manifest.sourceChunks.path,
    manifest.editHistory.path,
    ...manifest.sourceBlobs.map((entry) => entry.path),
  ]);
  if (
    Object.keys(archive).some((path) => !expected.has(path)) ||
    [...expected].some((path) => archive[path] === undefined)
  ) {
    failPackage(
      'MANIFEST_MISMATCH',
      'ZIP entries must exactly match the manifest.',
    );
  }
}

async function verifiedJson(
  archive: Unzipped,
  entry: PackageEntry,
  subtle: SubtleCrypto,
): Promise<unknown> {
  const bytes = await verifiedBytes(archive, entry, subtle);
  return parseJson(bytes, entry.path);
}

async function verifiedBytes(
  archive: Unzipped,
  entry: PackageEntry,
  subtle: SubtleCrypto,
): Promise<Uint8Array> {
  const bytes = archive[entry.path];
  if (bytes === undefined) {
    failPackage(
      'MISSING_ENTRY',
      `ZIP entry ${entry.path} is missing.`,
    );
  }
  if (bytes.byteLength !== entry.sizeBytes) {
    failPackage(
      'SIZE_MISMATCH',
      `ZIP entry ${entry.path} has an unexpected size.`,
    );
  }
  if ((await sha256Bytes(bytes, subtle)) !== entry.sha256) {
    failPackage(
      'SHA_MISMATCH',
      `ZIP entry ${entry.path} failed SHA-256 validation.`,
    );
  }
  return bytes;
}

async function sha256Bytes(
  bytes: Uint8Array,
  subtle: SubtleCrypto,
): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await subtle.digest('SHA-256', owned.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function parseJson(bytes: Uint8Array | undefined, path: string): unknown {
  if (bytes === undefined) {
    failPackage('MISSING_ENTRY', `ZIP entry ${path} is missing.`);
  }
  try {
    return JSON.parse(strFromU8(bytes)) as unknown;
  } catch (error) {
    throw new ProjectPackageError(
      'INVALID_ARCHIVE',
      `ZIP entry ${path} is not valid JSON.`,
      error,
    );
  }
}

function objectAt(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    failPackage('MANIFEST_MISMATCH', `${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    failPackage('MANIFEST_MISMATCH', `${path} must be an array.`);
  }
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    failPackage(
      'MANIFEST_MISMATCH',
      `${path} must be a non-empty trimmed string.`,
    );
  }
  return value;
}

function positiveIntegerAt(value: unknown, path: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    failPackage(
      'MANIFEST_MISMATCH',
      `${path} must be a positive integer.`,
    );
  }
  return value;
}

function nonNegativeIntegerAt(value: unknown, path: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    failPackage(
      'MANIFEST_MISMATCH',
      `${path} must be a non-negative integer.`,
    );
  }
  return value;
}

function dateTimeAt(value: unknown, path: string): string {
  const timestamp = stringAt(value, path);
  const date = new Date(timestamp);
  if (
    !Number.isFinite(date.valueOf()) ||
    date.toISOString() !== timestamp
  ) {
    failPackage(
      'MANIFEST_MISMATCH',
      `${path} must be a canonical timestamp.`,
    );
  }
  return timestamp;
}

function isSafeArchivePath(path: string): boolean {
  return (
    path.length <= 512 &&
    SAFE_ARCHIVE_PATH.test(path) &&
    !path.endsWith('/')
  );
}

function blobFromBytes(bytes: Uint8Array, type: string): Blob {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return new Blob([owned.buffer], { type });
}

function safeFileBase(value: string): string {
  let normalized = '';
  for (const character of value.normalize('NFKC')) {
    const codePoint = character.codePointAt(0);
    normalized +=
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      '<>:"/\\|?*'.includes(character)
        ? '-'
        : character;
  }
  const safe = normalized
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[.\s-]+|[.\s-]+$/gu, '')
    .slice(0, 80);
  return safe.length > 0 ? safe : 'project';
}

function failPackage(
  code: ProjectPackageErrorCode,
  message: string,
): never {
  throw new ProjectPackageError(code, message);
}

export const ENCRYPTED_SYNC_FORMAT = 'zuocheng-encrypted-sync' as const;
export const ENCRYPTED_SYNC_FORMAT_VERSION = 1 as const;

export type SyncErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_CREDENTIAL'
  | 'AUTH_FAILED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'CANCELLED'
  | 'INVALID_RESPONSE'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'CRYPTO_UNAVAILABLE'
  | 'INVALID_PASSPHRASE'
  | 'CORRUPT_PAYLOAD'
  | 'STORAGE_UNAVAILABLE'
  | 'OFFLINE'
  | 'CONFIRMATION_REQUIRED'
  | 'PROJECT_NOT_FOUND';

export class SyncError extends Error {
  override readonly cause: unknown;

  constructor(
    readonly code: SyncErrorCode,
    message: string,
    options: {
      cause?: unknown;
      retryAfterAt?: string;
    } = {},
  ) {
    super(message);
    this.name = 'SyncError';
    this.cause = options.cause;
    this.retryAfterAt = options.retryAfterAt;
  }

  readonly retryAfterAt: string | undefined;
}

export interface LocalSyncSnapshot {
  projectId: string;
  projectTitle: string;
  projectVersion: number;
  projectUpdatedAt: string;
  package: Blob;
}

export interface EncryptedSyncDescriptor {
  format: typeof ENCRYPTED_SYNC_FORMAT;
  formatVersion: typeof ENCRYPTED_SYNC_FORMAT_VERSION;
  revision: string;
  projectId: string;
  projectVersion: number;
  projectUpdatedAt: string;
  encryptedAt: string;
  algorithm: {
    name: 'AES-GCM';
    kdf: 'PBKDF2';
    hash: 'SHA-256';
    iterations: number;
    salt: string;
    iv: string;
  };
  payload: {
    encoding: 'base64url';
    chunkPaths: string[];
    ciphertextBytes: number;
    ciphertextSha256: string;
  };
}

export interface EncryptedSyncBundle {
  descriptor: EncryptedSyncDescriptor;
  encryptedFiles: Record<string, string>;
}

export interface DecryptedSyncPackage
  extends Omit<LocalSyncSnapshot, 'package'> {
  package: Blob;
  packageSha256: string;
}

export interface RemoteSyncRecord {
  gistId: string;
  etag: string | null;
  revision: string;
  projectId: string;
  projectVersion: number;
  projectUpdatedAt: string;
  encryptedAt: string;
  encryptedBytes: number;
  lastModifiedAt: string;
}

export interface RemoteEncryptedProject {
  record: RemoteSyncRecord;
  bundle: EncryptedSyncBundle;
}

export interface SyncConnectionIdentity {
  login: string;
  userId: number;
}

export interface SyncUploadInput {
  token: string;
  bundle: EncryptedSyncBundle;
  gistId?: string;
  expectedRevision?: string;
  signal: AbortSignal;
}

export interface SyncDeleteInput {
  token: string;
  gistId: string;
  expectedRevision: string;
  signal: AbortSignal;
}

export interface SyncAdapter {
  verifyConnection(
    token: string,
    signal: AbortSignal,
  ): Promise<SyncConnectionIdentity>;
  listProjects(
    token: string,
    signal: AbortSignal,
  ): Promise<RemoteSyncRecord[]>;
  fetchProject(
    token: string,
    gistId: string,
    signal: AbortSignal,
  ): Promise<RemoteEncryptedProject>;
  uploadProject(input: SyncUploadInput): Promise<RemoteSyncRecord>;
  deleteProject(input: SyncDeleteInput): Promise<void>;
}

export interface SyncLink {
  projectId: string;
  gistId: string;
  remoteRevision: string;
  remoteProjectVersion: number;
  remoteProjectUpdatedAt: string;
  lastSyncedPackageSha256: string;
  syncedAt: string;
}

export interface SyncOutboxEntry {
  id: string;
  createdAt: string;
  action: 'upload';
  projectId: string;
  gistId: string | null;
  expectedRevision: string | null;
  bundle: EncryptedSyncBundle;
  localPackageSha256: string;
}

export type SyncAuditAction =
  | 'connect'
  | 'list'
  | 'push'
  | 'pull'
  | 'delete'
  | 'flush';
export type SyncAuditOutcome =
  | 'success'
  | 'error'
  | 'conflict'
  | 'cancelled'
  | 'queued';

export interface SyncAuditEvent {
  id: string;
  at: string;
  action: SyncAuditAction;
  outcome: SyncAuditOutcome;
  projectId: string | null;
  gistId: string | null;
  summary: string;
}

export interface SyncStore {
  listOutbox(): Promise<SyncOutboxEntry[]>;
  putOutbox(entry: SyncOutboxEntry): Promise<void>;
  deleteOutbox(id: string): Promise<void>;
  getLink(projectId: string): Promise<SyncLink | null>;
  putLink(link: SyncLink): Promise<void>;
  deleteLink(projectId: string): Promise<void>;
  listAudit(): Promise<SyncAuditEvent[]>;
  appendAudit(event: SyncAuditEvent): Promise<void>;
  close?(): void;
}

export type SyncConflictKind =
  | 'both_changed'
  | 'remote_changed'
  | 'remote_missing'
  | 'unlinked_existing_remote'
  | 'unlinked_existing_local';

export interface SyncConflict {
  kind: SyncConflictKind;
  projectId: string;
  localVersion: number | null;
  localUpdatedAt: string | null;
  remoteVersion: number | null;
  remoteUpdatedAt: string | null;
  remoteRevision: string | null;
  gistId: string | null;
}

export class SyncConflictError extends SyncError {
  constructor(readonly conflict: SyncConflict) {
    super('CONFLICT', '同步版本已变化，需要选择保留的版本。');
    this.name = 'SyncConflictError';
  }
}

const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^[a-zA-Z0-9_-]{8,128}$/u;
const PAYLOAD_PATH = /^payload-[0-9]{4}\.txt$/u;
const BASE64URL = /^[a-zA-Z0-9_-]*$/u;

export function parseEncryptedSyncDescriptor(
  input: unknown,
): EncryptedSyncDescriptor {
  const object = objectAt(input, 'descriptor');
  if (object.format !== ENCRYPTED_SYNC_FORMAT) {
    invalid('descriptor.format');
  }
  if (object.formatVersion !== ENCRYPTED_SYNC_FORMAT_VERSION) {
    invalid('descriptor.formatVersion');
  }
  const algorithm = objectAt(object.algorithm, 'descriptor.algorithm');
  const payload = objectAt(object.payload, 'descriptor.payload');
  const chunkPaths = arrayAt(
    payload.chunkPaths,
    'descriptor.payload.chunkPaths',
  ).map((value, index) => {
    const path = stringAt(
      value,
      `descriptor.payload.chunkPaths[${index}]`,
      64,
    );
    if (!PAYLOAD_PATH.test(path)) {
      invalid(`descriptor.payload.chunkPaths[${index}]`);
    }
    return path;
  });
  if (
    chunkPaths.length === 0 ||
    chunkPaths.length > 256 ||
    new Set(chunkPaths).size !== chunkPaths.length
  ) {
    invalid('descriptor.payload.chunkPaths');
  }
  const revision = stringAt(object.revision, 'descriptor.revision', 128);
  if (!REVISION.test(revision)) {
    invalid('descriptor.revision');
  }
  const salt = stringAt(algorithm.salt, 'descriptor.algorithm.salt', 128);
  const iv = stringAt(algorithm.iv, 'descriptor.algorithm.iv', 128);
  if (!BASE64URL.test(salt) || !BASE64URL.test(iv)) {
    invalid('descriptor.algorithm');
  }
  const ciphertextSha256 = stringAt(
    payload.ciphertextSha256,
    'descriptor.payload.ciphertextSha256',
    64,
  );
  if (!SHA256.test(ciphertextSha256)) {
    invalid('descriptor.payload.ciphertextSha256');
  }
  if (
    algorithm.name !== 'AES-GCM' ||
    algorithm.kdf !== 'PBKDF2' ||
    algorithm.hash !== 'SHA-256'
  ) {
    invalid('descriptor.algorithm');
  }
  return {
    format: ENCRYPTED_SYNC_FORMAT,
    formatVersion: ENCRYPTED_SYNC_FORMAT_VERSION,
    revision,
    projectId: stringAt(object.projectId, 'descriptor.projectId', 256),
    projectVersion: integerAt(
      object.projectVersion,
      'descriptor.projectVersion',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    projectUpdatedAt: dateAt(
      object.projectUpdatedAt,
      'descriptor.projectUpdatedAt',
    ),
    encryptedAt: dateAt(object.encryptedAt, 'descriptor.encryptedAt'),
    algorithm: {
      name: 'AES-GCM',
      kdf: 'PBKDF2',
      hash: 'SHA-256',
      iterations: integerAt(
        algorithm.iterations,
        'descriptor.algorithm.iterations',
        300_000,
        2_000_000,
      ),
      salt,
      iv,
    },
    payload: {
      encoding:
        payload.encoding === 'base64url'
          ? 'base64url'
          : invalid('descriptor.payload.encoding'),
      chunkPaths,
      ciphertextBytes: integerAt(
        payload.ciphertextBytes,
        'descriptor.payload.ciphertextBytes',
        1,
        128 * 1024 * 1024,
      ),
      ciphertextSha256,
    },
  };
}

export function parseEncryptedSyncBundle(
  input: unknown,
): EncryptedSyncBundle {
  const object = objectAt(input, 'bundle');
  const descriptor = parseEncryptedSyncDescriptor(object.descriptor);
  const encryptedFilesObject = objectAt(
    object.encryptedFiles,
    'bundle.encryptedFiles',
  );
  const encryptedFiles: Record<string, string> = {};
  const expected = new Set(descriptor.payload.chunkPaths);
  for (const [path, value] of Object.entries(encryptedFilesObject)) {
    if (!expected.has(path)) {
      invalid(`bundle.encryptedFiles.${path}`);
    }
    const content = stringAt(
      value,
      `bundle.encryptedFiles.${path}`,
      950_000,
    );
    if (!BASE64URL.test(content)) {
      invalid(`bundle.encryptedFiles.${path}`);
    }
    encryptedFiles[path] = content;
  }
  if (
    Object.keys(encryptedFiles).length !== expected.size ||
    [...expected].some((path) => encryptedFiles[path] === undefined)
  ) {
    invalid('bundle.encryptedFiles');
  }
  return { descriptor, encryptedFiles };
}

export function syncError(
  error: unknown,
  fallbackCode: SyncErrorCode = 'NETWORK',
): SyncError {
  if (error instanceof SyncError) {
    return error;
  }
  if (
    error instanceof DOMException &&
    error.name === 'AbortError'
  ) {
    return new SyncError('CANCELLED', '操作已取消。');
  }
  return new SyncError(fallbackCode, '同步操作未完成，请稍后重试。', {
    cause: error,
  });
}

function invalid(path: string): never {
  throw new SyncError('INVALID_RESPONSE', `同步数据无效：${path}`);
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

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    invalid(path);
  }
  return value;
}

function stringAt(
  value: unknown,
  path: string,
  maximum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value !== value.trim() ||
    hasControl(value)
  ) {
    invalid(path);
  }
  return value;
}

function integerAt(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalid(path);
  }
  return value;
}

function dateAt(value: unknown, path: string): string {
  const timestamp = stringAt(value, path, 64);
  const date = new Date(timestamp);
  if (
    !Number.isFinite(date.valueOf()) ||
    date.toISOString() !== timestamp
  ) {
    invalid(path);
  }
  return timestamp;
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

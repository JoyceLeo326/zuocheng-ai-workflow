import {
  SyncConflictError,
  SyncError,
  syncError,
  type LocalSyncSnapshot,
  type RemoteSyncRecord,
  type SyncAdapter,
  type SyncAuditAction,
  type SyncAuditOutcome,
  type SyncConnectionIdentity,
  type SyncConflict,
  type SyncLink,
  type SyncStore,
} from './sync-domain.js';
import {
  decryptProjectPackage,
  encryptProjectPackage,
  sha256Blob,
} from './sync-crypto.js';
import type { GitHubSyncCredentialStore } from './sync-credential-store.js';

export interface SyncControllerOptions {
  adapter: SyncAdapter;
  store: SyncStore;
  credentials: GitHubSyncCredentialStore;
  getLocalProject(
    projectId: string,
  ): Promise<LocalSyncSnapshot | null>;
  applyRemoteProject(input: {
    projectId: string;
    package: Blob;
    mode: 'create' | 'overwrite';
  }): Promise<void>;
  isOnline?: () => boolean;
  now?: () => Date;
  idFactory?: () => string;
  cryptoProvider?: Crypto;
}

export interface SyncActionResult {
  status: 'synced' | 'queued' | 'unchanged';
  projectId: string;
  gistId: string | null;
}

export interface FlushOutboxResult {
  completed: number;
  conflicts: number;
  remaining: number;
}

export interface PushProjectOptions {
  conflictResolution?: 'fail' | 'overwrite-remote';
  signal?: AbortSignal;
}

export interface PullProjectOptions {
  conflictResolution?: 'fail' | 'overwrite-local';
  signal?: AbortSignal;
}

export class SyncController {
  readonly #adapter: SyncAdapter;
  readonly #store: SyncStore;
  readonly #credentials: GitHubSyncCredentialStore;
  readonly #getLocalProject: SyncControllerOptions['getLocalProject'];
  readonly #applyRemoteProject: SyncControllerOptions['applyRemoteProject'];
  readonly #isOnline: () => boolean;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #cryptoProvider: Crypto | undefined;

  constructor(options: SyncControllerOptions) {
    this.#adapter = options.adapter;
    this.#store = options.store;
    this.#credentials = options.credentials;
    this.#getLocalProject = options.getLocalProject;
    this.#applyRemoteProject = options.applyRemoteProject;
    this.#isOnline = options.isOnline ?? (() => navigator.onLine);
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.#cryptoProvider = options.cryptoProvider ?? globalThis.crypto;
  }

  get connected(): boolean {
    return this.#credentials.resolveToken() !== null;
  }

  async connect(
    token: string,
    signal = new AbortController().signal,
  ): Promise<SyncConnectionIdentity> {
    this.#requireOnline();
    try {
      const identity = await this.#adapter.verifyConnection(
        token,
        signal,
      );
      this.#credentials.saveToken(token);
      await this.#audit(
        'connect',
        'success',
        null,
        null,
        `已连接 GitHub 账号 ${identity.login}。`,
      );
      return identity;
    } catch (error) {
      const mapped = syncError(error);
      await this.#auditFailure('connect', mapped, null, null);
      throw mapped;
    }
  }

  disconnect(): void {
    this.#credentials.removeToken();
  }

  async listRemoteProjects(
    signal = new AbortController().signal,
  ): Promise<RemoteSyncRecord[]> {
    this.#requireOnline();
    const token = this.#token();
    try {
      const records = await this.#adapter.listProjects(token, signal);
      await this.#audit(
        'list',
        'success',
        null,
        null,
        `已读取 ${records.length} 个远端项目。`,
      );
      return records;
    } catch (error) {
      const mapped = syncError(error);
      await this.#auditFailure('list', mapped, null, null);
      throw mapped;
    }
  }

  async pushProject(
    projectId: string,
    passphrase: string,
    options: PushProjectOptions = {},
  ): Promise<SyncActionResult> {
    const signal = options.signal ?? new AbortController().signal;
    const local = await this.#getLocalProject(projectId);
    if (local === null) {
      throw new SyncError(
        'PROJECT_NOT_FOUND',
        '找不到要同步的项目。',
      );
    }
    const localPackageSha256 = await sha256Blob(
      local.package,
      this.#cryptoProvider,
    );
    const bundle = await encryptProjectPackage(
      local,
      passphrase,
      this.#cryptoProvider,
      this.#timestamp(),
    );
    const link = await this.#store.getLink(projectId);
    if (!this.#isOnline()) {
      const entries = await this.#store.listOutbox();
      for (const entry of entries) {
        if (entry.projectId === projectId) {
          await this.#store.deleteOutbox(entry.id);
        }
      }
      await this.#store.putOutbox({
        id: this.#idFactory(),
        createdAt: this.#timestamp(),
        action: 'upload',
        projectId,
        gistId: link?.gistId ?? null,
        expectedRevision: link?.remoteRevision ?? null,
        bundle,
        localPackageSha256,
      });
      await this.#audit(
        'push',
        'queued',
        projectId,
        link?.gistId ?? null,
        '当前离线，项目已加入待同步队列。',
      );
      return {
        status: 'queued',
        projectId,
        gistId: link?.gistId ?? null,
      };
    }
    const token = this.#token();
    try {
      const remotes = await this.#adapter.listProjects(token, signal);
      const remote =
        remotes.find((candidate) => candidate.projectId === projectId) ??
        null;
      const conflict = pushConflict(local, remote, link);
      if (
        conflict !== null &&
        options.conflictResolution !== 'overwrite-remote'
      ) {
        throw new SyncConflictError(conflict);
      }
      const uploaded = await this.#adapter.uploadProject({
        token,
        bundle,
        ...(remote === null
          ? {}
          : {
              gistId: remote.gistId,
              expectedRevision: remote.revision,
            }),
        signal,
      });
      await this.#store.putLink(
        linkFrom(uploaded, localPackageSha256, this.#timestamp()),
      );
      await this.#audit(
        'push',
        'success',
        projectId,
        uploaded.gistId,
        `项目第 ${local.projectVersion} 版已同步。`,
      );
      return {
        status: 'synced',
        projectId,
        gistId: uploaded.gistId,
      };
    } catch (error) {
      const mapped = syncError(error);
      await this.#auditFailure(
        'push',
        mapped,
        projectId,
        link?.gistId ?? null,
      );
      throw mapped;
    }
  }

  async pullProject(
    gistId: string,
    passphrase: string,
    options: PullProjectOptions = {},
  ): Promise<SyncActionResult> {
    this.#requireOnline();
    const signal = options.signal ?? new AbortController().signal;
    const token = this.#token();
    try {
      const remote = await this.#adapter.fetchProject(
        token,
        gistId,
        signal,
      );
      const decrypted = await decryptProjectPackage(
        remote.bundle,
        passphrase,
        this.#cryptoProvider,
      );
      const local = await this.#getLocalProject(decrypted.projectId);
      const link = await this.#store.getLink(decrypted.projectId);
      let localSha: string | null = null;
      if (local !== null) {
        localSha = await sha256Blob(
          local.package,
          this.#cryptoProvider,
        );
        if (localSha === decrypted.packageSha256) {
          await this.#store.putLink(
            linkFrom(
              remote.record,
              decrypted.packageSha256,
              this.#timestamp(),
            ),
          );
          await this.#audit(
            'pull',
            'success',
            decrypted.projectId,
            gistId,
            '此设备与远端项目内容一致。',
          );
          return {
            status: 'unchanged',
            projectId: decrypted.projectId,
            gistId,
          };
        }
      }
      const conflict = pullConflict(
        local,
        localSha,
        remote.record,
        link,
      );
      if (
        conflict !== null &&
        options.conflictResolution !== 'overwrite-local'
      ) {
        throw new SyncConflictError(conflict);
      }
      await this.#applyRemoteProject({
        projectId: decrypted.projectId,
        package: decrypted.package,
        mode: local === null ? 'create' : 'overwrite',
      });
      await this.#store.putLink(
        linkFrom(
          remote.record,
          decrypted.packageSha256,
          this.#timestamp(),
        ),
      );
      await this.#audit(
        'pull',
        'success',
        decrypted.projectId,
        gistId,
        `已拉取远端第 ${decrypted.projectVersion} 版。`,
      );
      return {
        status: 'synced',
        projectId: decrypted.projectId,
        gistId,
      };
    } catch (error) {
      const mapped = syncError(error);
      await this.#auditFailure('pull', mapped, null, gistId);
      throw mapped;
    }
  }

  async flushOutbox(
    signal = new AbortController().signal,
  ): Promise<FlushOutboxResult> {
    this.#requireOnline();
    const token = this.#token();
    const entries = await this.#store.listOutbox();
    let completed = 0;
    let conflicts = 0;
    for (const entry of entries) {
      if (signal.aborted) {
        throw new SyncError('CANCELLED', '同步队列处理已取消。');
      }
      try {
        if (entry.gistId === null) {
          const remote = (
            await this.#adapter.listProjects(token, signal)
          ).find(
            (candidate) =>
              candidate.projectId === entry.projectId,
          );
          if (remote !== undefined) {
            throw new SyncConflictError({
              kind: 'unlinked_existing_remote',
              projectId: entry.projectId,
              localVersion: entry.bundle.descriptor.projectVersion,
              localUpdatedAt:
                entry.bundle.descriptor.projectUpdatedAt,
              remoteVersion: remote.projectVersion,
              remoteUpdatedAt: remote.projectUpdatedAt,
              remoteRevision: remote.revision,
              gistId: remote.gistId,
            });
          }
        }
        const uploaded = await this.#adapter.uploadProject({
          token,
          bundle: entry.bundle,
          ...(entry.gistId === null
            ? {}
            : {
                gistId: entry.gistId,
                expectedRevision: entry.expectedRevision!,
              }),
          signal,
        });
        await this.#store.putLink(
          linkFrom(
            uploaded,
            entry.localPackageSha256,
            this.#timestamp(),
          ),
        );
        await this.#store.deleteOutbox(entry.id);
        completed += 1;
      } catch (error) {
        const mapped = syncError(error);
        if (mapped.code === 'CONFLICT') {
          conflicts += 1;
          await this.#auditFailure(
            'flush',
            mapped,
            entry.projectId,
            entry.gistId,
          );
          continue;
        }
        await this.#auditFailure(
          'flush',
          mapped,
          entry.projectId,
          entry.gistId,
        );
        throw mapped;
      }
    }
    const remaining = (await this.#store.listOutbox()).length;
    await this.#audit(
      'flush',
      conflicts > 0 ? 'conflict' : 'success',
      null,
      null,
      conflicts > 0
        ? `已同步 ${completed} 项，${conflicts} 项需要处理冲突。`
        : `已同步 ${completed} 项待办。`,
    );
    return { completed, conflicts, remaining };
  }

  async deleteRemoteProject(input: {
    record: RemoteSyncRecord;
    confirmed: boolean;
    confirmationText: string;
    signal?: AbortSignal;
  }): Promise<void> {
    if (
      !input.confirmed ||
      input.confirmationText !== '删除远端项目'
    ) {
      throw new SyncError(
        'CONFIRMATION_REQUIRED',
        '请完成两步确认后再删除远端项目。',
      );
    }
    this.#requireOnline();
    const token = this.#token();
    try {
      await this.#adapter.deleteProject({
        token,
        gistId: input.record.gistId,
        expectedRevision: input.record.revision,
        signal: input.signal ?? new AbortController().signal,
      });
      const link = await this.#store.getLink(input.record.projectId);
      if (link?.gistId === input.record.gistId) {
        await this.#store.deleteLink(input.record.projectId);
      }
      await this.#audit(
        'delete',
        'success',
        input.record.projectId,
        input.record.gistId,
        '远端项目已删除。',
      );
    } catch (error) {
      const mapped = syncError(error);
      await this.#auditFailure(
        'delete',
        mapped,
        input.record.projectId,
        input.record.gistId,
      );
      throw mapped;
    }
  }

  listOutbox() {
    return this.#store.listOutbox();
  }

  listAudit() {
    return this.#store.listAudit();
  }

  #token(): string {
    const token = this.#credentials.resolveToken();
    if (token === null) {
      throw new SyncError(
        'AUTH_FAILED',
        '请先连接 GitHub 再同步项目。',
      );
    }
    return token;
  }

  #requireOnline(): void {
    if (!this.#isOnline()) {
      throw new SyncError(
        'OFFLINE',
        '当前离线，请联网后重试。',
      );
    }
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  async #auditFailure(
    action: SyncAuditAction,
    error: SyncError,
    projectId: string | null,
    gistId: string | null,
  ): Promise<void> {
    const outcome: SyncAuditOutcome =
      error.code === 'CONFLICT'
        ? 'conflict'
        : error.code === 'CANCELLED'
          ? 'cancelled'
          : 'error';
    await this.#audit(
      action,
      outcome,
      projectId,
      gistId,
      auditMessage(error),
    );
  }

  async #audit(
    action: SyncAuditAction,
    outcome: SyncAuditOutcome,
    projectId: string | null,
    gistId: string | null,
    summary: string,
  ): Promise<void> {
    await this.#store.appendAudit({
      id: this.#idFactory(),
      at: this.#timestamp(),
      action,
      outcome,
      projectId,
      gistId,
      summary,
    });
  }
}

function pushConflict(
  local: LocalSyncSnapshot,
  remote: RemoteSyncRecord | null,
  link: SyncLink | null,
): SyncConflict | null {
  if (remote === null && link !== null) {
    return {
      kind: 'remote_missing',
      projectId: local.projectId,
      localVersion: local.projectVersion,
      localUpdatedAt: local.projectUpdatedAt,
      remoteVersion: null,
      remoteUpdatedAt: null,
      remoteRevision: null,
      gistId: link.gistId,
    };
  }
  if (remote !== null && link === null) {
    return conflictFrom(
      'unlinked_existing_remote',
      local,
      remote,
    );
  }
  if (
    remote !== null &&
    link !== null &&
    (remote.gistId !== link.gistId ||
      remote.revision !== link.remoteRevision)
  ) {
    return conflictFrom('both_changed', local, remote);
  }
  return null;
}

function pullConflict(
  local: LocalSyncSnapshot | null,
  localSha: string | null,
  remote: RemoteSyncRecord,
  link: SyncLink | null,
): SyncConflict | null {
  if (local === null) {
    return null;
  }
  if (link === null || link.gistId !== remote.gistId) {
    return conflictFrom(
      'unlinked_existing_local',
      local,
      remote,
    );
  }
  const localChanged =
    localSha !== null &&
    localSha !== link.lastSyncedPackageSha256;
  const remoteChanged =
    remote.revision !== link.remoteRevision;
  if (localChanged || remoteChanged) {
    return conflictFrom(
      localChanged && remoteChanged ? 'both_changed' : 'remote_changed',
      local,
      remote,
    );
  }
  return null;
}

function conflictFrom(
  kind: SyncConflict['kind'],
  local: LocalSyncSnapshot,
  remote: RemoteSyncRecord,
): SyncConflict {
  return {
    kind,
    projectId: local.projectId,
    localVersion: local.projectVersion,
    localUpdatedAt: local.projectUpdatedAt,
    remoteVersion: remote.projectVersion,
    remoteUpdatedAt: remote.projectUpdatedAt,
    remoteRevision: remote.revision,
    gistId: remote.gistId,
  };
}

function linkFrom(
  remote: RemoteSyncRecord,
  packageSha256: string,
  syncedAt: string,
): SyncLink {
  return {
    projectId: remote.projectId,
    gistId: remote.gistId,
    remoteRevision: remote.revision,
    remoteProjectVersion: remote.projectVersion,
    remoteProjectUpdatedAt: remote.projectUpdatedAt,
    lastSyncedPackageSha256: packageSha256,
    syncedAt,
  };
}

function auditMessage(error: SyncError): string {
  switch (error.code) {
    case 'CONFLICT':
      return '远端内容已变化，等待选择保留版本。';
    case 'CANCELLED':
      return '同步操作已取消。';
    case 'AUTH_FAILED':
      return 'GitHub 连接已失效。';
    case 'RATE_LIMITED':
      return 'GitHub 请求次数已达上限。';
    case 'INVALID_PASSPHRASE':
      return '同步口令无法解密远端项目。';
    case 'CORRUPT_PAYLOAD':
      return '远端加密内容校验失败。';
    case 'OFFLINE':
      return '当前离线，同步操作未执行。';
    default:
      return '同步操作未完成。';
  }
}

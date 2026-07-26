import { describe, expect, it, vi } from 'vitest';
import { createGitHubSyncCredentialStore } from './sync-credential-store.js';
import type {
  LocalSyncSnapshot,
  RemoteEncryptedProject,
  RemoteSyncRecord,
  SyncAdapter,
} from './sync-domain.js';
import { SyncController } from './sync-controller.js';
import { MemorySyncStore } from './sync-store.js';

const PROJECT_ID = '01900000-0000-7000-8000-000000000901';
const TOKEN = 'test-session-token-value-1234567890';
const PASSPHRASE = 'a-long-sync-passphrase';

function localSnapshot(version = 2) {
  return {
    projectId: PROJECT_ID,
    projectTitle: '真实项目',
    projectVersion: version,
    projectUpdatedAt: `2026-07-27T10:0${version}:00.000Z`,
    package: new Blob([`package-${version}`], {
      type: 'application/zip',
    }),
  };
}

function remoteRecord(
  revision = 'remote-revision-001',
  version = 1,
): RemoteSyncRecord {
  return {
    gistId: 'gist-001',
    etag: '"etag-001"',
    revision,
    projectId: PROJECT_ID,
    projectVersion: version,
    projectUpdatedAt: `2026-07-27T09:0${version}:00.000Z`,
    encryptedAt: '2026-07-27T09:10:00.000Z',
    encryptedBytes: 128,
    lastModifiedAt: '2026-07-27T09:10:00.000Z',
  };
}

function adapter(
  overrides: Partial<SyncAdapter> = {},
): SyncAdapter {
  return {
    verifyConnection: vi.fn(async () => ({
      login: 'sync-owner',
      userId: 123,
    })),
    listProjects: vi.fn(async () => []),
    fetchProject: vi.fn(),
    uploadProject: vi.fn(async ({ bundle, gistId }) => ({
      ...remoteRecord(bundle.descriptor.revision, bundle.descriptor.projectVersion),
      gistId: gistId ?? 'gist-created',
    })),
    deleteProject: vi.fn(async () => undefined),
    ...overrides,
  };
}

function controller(options: {
  adapter?: SyncAdapter;
  store?: MemorySyncStore;
  online?: boolean;
  getLocalProject?: (
    projectId: string,
  ) => Promise<LocalSyncSnapshot | null>;
  applyRemoteProject?: (
    input: {
      projectId: string;
      package: Blob;
      mode: 'create' | 'overwrite';
    },
  ) => Promise<void>;
} = {}) {
  const credentials = createGitHubSyncCredentialStore({
    sessionStorage: null,
  });
  credentials.saveToken(TOKEN);
  const store = options.store ?? new MemorySyncStore();
  const selectedAdapter = options.adapter ?? adapter();
  const getLocalProject =
    options.getLocalProject ?? (async () => localSnapshot());
  const applyRemoteProject =
    options.applyRemoteProject ?? vi.fn(async () => undefined);
  return {
    controller: new SyncController({
      adapter: selectedAdapter,
      store,
      credentials,
      getLocalProject,
      applyRemoteProject,
      isOnline: () => options.online ?? true,
      now: () => new Date('2026-07-27T11:00:00.000Z'),
      idFactory: () => 'sync-id-001',
      cryptoProvider: globalThis.crypto,
    }),
    adapter: selectedAdapter,
    store,
    applyRemoteProject,
  };
}

describe('SyncController', () => {
  it('queues an encrypted upload while offline and flushes it only on explicit request', async () => {
    const selectedAdapter = adapter();
    const first = controller({
      adapter: selectedAdapter,
      online: false,
    });

    await expect(
      first.controller.pushProject(PROJECT_ID, PASSPHRASE),
    ).resolves.toMatchObject({ status: 'queued' });
    expect(selectedAdapter.uploadProject).not.toHaveBeenCalled();
    const [queued] = await first.store.listOutbox();
    expect(queued).toMatchObject({
      action: 'upload',
      projectId: PROJECT_ID,
    });
    expect(JSON.stringify(queued)).not.toContain(PASSPHRASE);
    expect(JSON.stringify(queued)).not.toContain('package-2');

    const online = controller({
      adapter: selectedAdapter,
      store: first.store,
      online: true,
    });
    await expect(online.controller.flushOutbox()).resolves.toEqual({
      completed: 1,
      conflicts: 0,
      remaining: 0,
    });
    expect(selectedAdapter.uploadProject).toHaveBeenCalledTimes(1);
    expect(await first.store.listOutbox()).toEqual([]);
    expect(await first.store.getLink(PROJECT_ID)).toMatchObject({
      gistId: 'gist-created',
      remoteProjectVersion: 2,
    });
  });

  it('detects a changed remote revision and requires explicit overwrite', async () => {
    const store = new MemorySyncStore();
    await store.putLink({
      projectId: PROJECT_ID,
      gistId: 'gist-001',
      remoteRevision: 'baseline-revision',
      remoteProjectVersion: 1,
      remoteProjectUpdatedAt: '2026-07-27T09:01:00.000Z',
      lastSyncedPackageSha256:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      syncedAt: '2026-07-27T09:10:00.000Z',
    });
    const selectedAdapter = adapter({
      listProjects: vi.fn(async () => [
        remoteRecord('changed-remotely', 3),
      ]),
    });
    const subject = controller({
      adapter: selectedAdapter,
      store,
    });

    await expect(
      subject.controller.pushProject(PROJECT_ID, PASSPHRASE),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      conflict: {
        kind: 'both_changed',
        remoteRevision: 'changed-remotely',
      },
    });
    expect(selectedAdapter.uploadProject).not.toHaveBeenCalled();

    await expect(
      subject.controller.pushProject(PROJECT_ID, PASSPHRASE, {
        conflictResolution: 'overwrite-remote',
      }),
    ).resolves.toMatchObject({ status: 'synced' });
    expect(selectedAdapter.uploadProject).toHaveBeenCalledWith(
      expect.objectContaining({
        gistId: 'gist-001',
        expectedRevision: 'changed-remotely',
      }),
    );
  });

  it('decrypts, verifies and applies a remote package only after local conflict resolution', async () => {
    const encryptedRemote = await (
      await import('./sync-crypto.js')
    ).encryptProjectPackage(
      {
        ...localSnapshot(4),
        projectUpdatedAt: '2026-07-27T12:00:00.000Z',
      },
      PASSPHRASE,
      globalThis.crypto,
    );
    const record = {
      ...remoteRecord(encryptedRemote.descriptor.revision, 4),
      projectUpdatedAt: '2026-07-27T12:00:00.000Z',
    };
    const remote: RemoteEncryptedProject = {
      record,
      bundle: encryptedRemote,
    };
    const selectedAdapter = adapter({
      fetchProject: vi.fn(async () => remote),
    });
    const subject = controller({ adapter: selectedAdapter });

    await expect(
      subject.controller.pullProject(
        'gist-001',
        PASSPHRASE,
        { conflictResolution: 'fail' },
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      conflict: { kind: 'unlinked_existing_local' },
    });
    expect(subject.applyRemoteProject).not.toHaveBeenCalled();

    await expect(
      subject.controller.pullProject(
        'gist-001',
        PASSPHRASE,
        { conflictResolution: 'overwrite-local' },
      ),
    ).resolves.toMatchObject({ status: 'synced' });
    expect(subject.applyRemoteProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        mode: 'overwrite',
      }),
    );
    const applied = vi.mocked(subject.applyRemoteProject).mock.calls[0]?.[0];
    expect(await applied?.package.text()).toBe('package-4');
  });

  it('requires two-step confirmation before deleting a remote project', async () => {
    const selectedAdapter = adapter();
    const subject = controller({ adapter: selectedAdapter });

    await expect(
      subject.controller.deleteRemoteProject({
        record: remoteRecord(),
        confirmed: true,
        confirmationText: '删除',
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(selectedAdapter.deleteProject).not.toHaveBeenCalled();

    await subject.controller.deleteRemoteProject({
      record: remoteRecord(),
      confirmed: true,
      confirmationText: '删除远端项目',
    });
    expect(selectedAdapter.deleteProject).toHaveBeenCalledWith(
      expect.objectContaining({
        gistId: 'gist-001',
        expectedRevision: 'remote-revision-001',
      }),
    );
  });
});

import { describe, expect, it } from 'vitest';
import type {
  SyncAuditEvent,
  SyncLink,
  SyncOutboxEntry,
} from './sync-domain.js';
import { MemorySyncStore } from './sync-store.js';

const PROJECT_ID = '01900000-0000-7000-8000-000000000901';

function outbox(): SyncOutboxEntry {
  return {
    id: 'outbox-001',
    createdAt: '2026-07-27T10:00:00.000Z',
    action: 'upload',
    projectId: PROJECT_ID,
    gistId: 'gist-001',
    expectedRevision: 'revision-001',
    bundle: {
      descriptor: {
        format: 'zuocheng-encrypted-sync',
        formatVersion: 1,
        revision: 'revision-002',
        projectId: PROJECT_ID,
        projectVersion: 2,
        projectUpdatedAt: '2026-07-27T10:00:00.000Z',
        encryptedAt: '2026-07-27T10:00:01.000Z',
        algorithm: {
          name: 'AES-GCM',
          kdf: 'PBKDF2',
          hash: 'SHA-256',
          iterations: 310_000,
          salt: 'c2FsdA',
          iv: 'aW5pdGlhbGl6ZXI',
        },
        payload: {
          encoding: 'base64url',
          chunkPaths: ['payload-0001.txt'],
          ciphertextBytes: 12,
          ciphertextSha256:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
      encryptedFiles: {
        'payload-0001.txt': 'ZW5jcnlwdGVk',
      },
    },
    localPackageSha256:
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };
}

describe('SyncStore', () => {
  it('persists encrypted outbox entries, baselines and bounded audit summaries', async () => {
    const store = new MemorySyncStore({ maxAuditEvents: 2 });
    const link: SyncLink = {
      projectId: PROJECT_ID,
      gistId: 'gist-001',
      remoteRevision: 'revision-001',
      remoteProjectVersion: 1,
      remoteProjectUpdatedAt: '2026-07-27T09:00:00.000Z',
      lastSyncedPackageSha256:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      syncedAt: '2026-07-27T09:01:00.000Z',
    };
    const audit = (id: string): SyncAuditEvent => ({
      id,
      at: `2026-07-27T10:00:0${id.at(-1)}.000Z`,
      action: 'push',
      outcome: 'success',
      projectId: PROJECT_ID,
      gistId: 'gist-001',
      summary: `同步记录 ${id}`,
    });

    await store.putOutbox(outbox());
    await store.putLink(link);
    await store.appendAudit(audit('audit-1'));
    await store.appendAudit(audit('audit-2'));
    await store.appendAudit(audit('audit-3'));

    expect(await store.listOutbox()).toEqual([outbox()]);
    expect(await store.getLink(PROJECT_ID)).toEqual(link);
    expect(await store.listAudit()).toEqual([
      audit('audit-3'),
      audit('audit-2'),
    ]);

    await store.deleteOutbox('outbox-001');
    await store.deleteLink(PROJECT_ID);
    expect(await store.listOutbox()).toEqual([]);
    expect(await store.getLink(PROJECT_ID)).toBeNull();
  });

  it('returns clones so UI mutations cannot rewrite persisted sync state', async () => {
    const store = new MemorySyncStore();
    const entry = outbox();
    await store.putOutbox(entry);
    const read = (await store.listOutbox())[0]!;
    read.bundle.encryptedFiles['payload-0001.txt'] = 'changed';

    expect((await store.listOutbox())[0]?.bundle.encryptedFiles).toEqual({
      'payload-0001.txt': 'ZW5jcnlwdGVk',
    });
  });
});

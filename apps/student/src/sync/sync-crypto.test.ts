import { describe, expect, it } from 'vitest';
import {
  decryptProjectPackage,
  encryptProjectPackage,
} from './sync-crypto.js';

const snapshot = {
  projectId: '01900000-0000-7000-8000-000000000901',
  projectTitle: '跨设备项目',
  projectVersion: 7,
  projectUpdatedAt: '2026-07-27T10:00:00.000Z',
  package: new Blob(['real project package'], {
    type: 'application/zip',
  }),
};

describe('encrypted project sync payload', () => {
  it('round-trips a package with PBKDF2 and AES-GCM without exposing title or bytes', async () => {
    const encrypted = await encryptProjectPackage(
      snapshot,
      'a-long-sync-passphrase',
      globalThis.crypto,
    );

    expect(encrypted.descriptor).toMatchObject({
      format: 'zuocheng-encrypted-sync',
      formatVersion: 1,
      projectId: snapshot.projectId,
      projectVersion: 7,
      projectUpdatedAt: snapshot.projectUpdatedAt,
      algorithm: {
        name: 'AES-GCM',
        kdf: 'PBKDF2',
        hash: 'SHA-256',
      },
    });
    expect(encrypted.descriptor.algorithm.iterations).toBeGreaterThanOrEqual(
      300_000,
    );
    expect(JSON.stringify(encrypted)).not.toContain(snapshot.projectTitle);
    expect(JSON.stringify(encrypted)).not.toContain('real project package');
    expect(Object.keys(encrypted.encryptedFiles).length).toBeGreaterThan(0);

    const decrypted = await decryptProjectPackage(
      encrypted,
      'a-long-sync-passphrase',
      globalThis.crypto,
    );
    expect(decrypted).toMatchObject({
      projectId: snapshot.projectId,
      projectTitle: snapshot.projectTitle,
      projectVersion: 7,
      projectUpdatedAt: snapshot.projectUpdatedAt,
    });
    expect(await decrypted.package.text()).toBe('real project package');
    expect(decrypted.packageSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects a wrong passphrase and modified ciphertext without returning package bytes', async () => {
    const encrypted = await encryptProjectPackage(
      snapshot,
      'a-long-sync-passphrase',
      globalThis.crypto,
    );

    await expect(
      decryptProjectPackage(
        encrypted,
        'another-long-passphrase',
        globalThis.crypto,
      ),
    ).rejects.toMatchObject({
      name: 'SyncError',
      code: 'INVALID_PASSPHRASE',
    });

    const [firstPath] = encrypted.descriptor.payload.chunkPaths;
    if (firstPath === undefined) {
      throw new Error('expected encrypted chunk');
    }
    const original = encrypted.encryptedFiles[firstPath]!;
    encrypted.encryptedFiles[firstPath] =
      `${original.slice(0, -2)}${original.endsWith('AA') ? 'BB' : 'AA'}`;
    await expect(
      decryptProjectPackage(
        encrypted,
        'a-long-sync-passphrase',
        globalThis.crypto,
      ),
    ).rejects.toMatchObject({
      name: 'SyncError',
      code: 'CORRUPT_PAYLOAD',
    });
  });
});

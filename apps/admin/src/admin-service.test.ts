import { describe, expect, it } from 'vitest';
import {
  AdminPermissionError,
  AdminService,
  HttpAdminRepository,
  InMemoryAdminRepository,
  type AdminRuntime,
} from './admin-service.js';
import { createEmptyAdminSnapshot } from './admin-domain.js';

const runtime: AdminRuntime = {
  now: () => '2026-07-27T08:00:00.000Z',
  createId: () => crypto.randomUUID(),
  isOnline: () => true,
};

describe('admin service', () => {
  it('persists a mutation and returns the audit-backed snapshot', async () => {
    const repository = new InMemoryAdminRepository(
      createEmptyAdminSnapshot(runtime.now()),
    );
    const service = new AdminService(repository, runtime);

    const result = await service.execute({
      type: 'feature-flag.upsert',
      expectedVersion: 1,
      actor: '平台管理员',
      payload: {
        key: 'course-review',
        enabled: false,
        scope: 'local-admin',
        reason: '准备人工复核流程',
      },
    });

    expect(result.featureFlags[0]).toMatchObject({
      key: 'course-review',
      enabled: false,
    });
    expect((await repository.load()).version).toBe(2);
    expect(result.auditEvents[0]?.action).toBe('feature-flag.upsert');
  });

  it('keeps the previous snapshot when persistence fails', async () => {
    const original = createEmptyAdminSnapshot(runtime.now());
    const repository = {
      mode: 'local' as const,
      readOnly: false,
      load: async () => original,
      save: async () => {
        throw new Error('storage unavailable');
      },
    };
    const service = new AdminService(repository, runtime);

    await expect(
      service.execute({
        type: 'content.create',
        expectedVersion: 1,
        actor: '内容管理员',
        payload: { kind: 'template', title: '课堂汇报' },
      }),
    ).rejects.toThrow('storage unavailable');
    expect(await repository.load()).toBe(original);
  });

  it('exposes offline state without claiming the remote API is healthy', async () => {
    const repository = new InMemoryAdminRepository(
      createEmptyAdminSnapshot(runtime.now()),
    );
    const offlineService = new AdminService(repository, {
      ...runtime,
      isOnline: () => false,
    });

    const result = await offlineService.load();

    expect(result.connectivity).toBe('offline');
    expect(result.services).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'network',
          status: 'unavailable',
        }),
        expect.objectContaining({
          id: 'admin-api',
          status: 'unconfigured',
        }),
      ]),
    );
  });

  it('reports an authorization failure as permission denied', async () => {
    const repository = new HttpAdminRepository({
      baseUrl: 'https://admin.example.test',
      fetchImplementation: async () =>
        new Response(JSON.stringify({ message: '需要管理员权限。' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await expect(repository.load()).rejects.toBeInstanceOf(
      AdminPermissionError,
    );
  });

  it('attributes a confirmed import to the real operator label', async () => {
    const original = createEmptyAdminSnapshot(runtime.now());
    const repository = new InMemoryAdminRepository(original);
    const service = new AdminService(repository, runtime);

    const result = await service.replaceWithImportedSnapshot(
      original,
      '导入并覆盖',
      'Alice Chen',
    );

    expect(result.auditEvents.at(-1)).toMatchObject({
      actor: 'Alice Chen',
      action: 'snapshot.import',
      targetType: 'system',
    });
  });
});

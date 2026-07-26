import { describe, expect, it, vi } from 'vitest';
import type {
  DeletionTask,
  ProjectRecord,
  ProjectStore,
  TenantContext,
} from './project-service.js';
import { ProjectService, ProjectServiceError } from './project-service.js';

const TENANT_ID = '01890f3e-b6e8-7cc2-98c0-7c9a2fe4f5d1';
const USER_ID = '01890f3e-b6e8-7d37-a839-3f11a9ca1b79';
const PROJECT_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a2';
const COPIED_PROJECT_ID = '01890f3e-b6e8-7a12-8d98-5b82e8cc46a2';
const DELETION_TASK_ID = '01890f3e-b6e8-7a13-8d98-5b82e8cc46a2';

const context: TenantContext = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  membershipId: '01890f3e-b6e8-7eb6-af23-7977c98e4a1c',
  sessionId: '01890f3e-b6e8-72d5-ac15-af026a93e3fc',
};

const storedProject: ProjectRecord = {
  id: PROJECT_ID,
  tenantId: TENANT_ID,
  version: 1,
  etag: '"1"',
  name: 'Research brief',
  description: 'Turn 25 pages into a concise brief',
  status: 'active',
  deletionStatus: 'active',
  copiedFromProjectId: null,
  createdBy: USER_ID,
  updatedBy: USER_ID,
  createdAt: '2026-07-23T00:00:00.000Z',
  updatedAt: '2026-07-23T00:00:00.000Z',
  archivedAt: null,
  deletedAt: null,
};

const deletionTask: DeletionTask = {
  id: DELETION_TASK_ID,
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  status: 'purge_pending',
  requestedBy: USER_ID,
  requestedAt: '2026-07-23T00:00:00.000Z',
};

function withVersion(
  project: ProjectRecord,
  version: number,
): ProjectRecord {
  return { ...project, version, etag: `"${version}"` };
}

function createStore(overrides: Partial<ProjectStore> = {}): ProjectStore {
  return {
    create: vi.fn(async () => ({ kind: 'applied' as const, project: storedProject })),
    listVisible: vi.fn(async () => [storedProject]),
    findVisible: vi.fn(async () => storedProject),
    update: vi.fn(async () => ({
      kind: 'applied' as const,
      project: { ...withVersion(storedProject, 2), name: 'Updated brief' },
    })),
    copy: vi.fn(async () => ({
      kind: 'applied' as const,
      project: {
        ...storedProject,
        id: COPIED_PROJECT_ID,
        name: 'Copy',
        copiedFromProjectId: PROJECT_ID,
      },
    })),
    archive: vi.fn(async () => ({
      kind: 'applied' as const,
      project: {
        ...withVersion(storedProject, 2),
        status: 'archived' as const,
        archivedAt: '2026-07-23T00:00:00.000Z',
      },
    })),
    softDelete: vi.fn(async () => ({
      kind: 'applied' as const,
      project: {
        ...withVersion(storedProject, 2),
        deletionStatus: 'soft_deleted' as const,
        deletedAt: '2026-07-23T00:00:00.000Z',
      },
    })),
    restore: vi.fn(async () => ({
      kind: 'applied' as const,
      project: storedProject,
    })),
    requestPermanentDelete: vi.fn(async () => ({
      kind: 'applied' as const,
      project: {
        ...withVersion(storedProject, 3),
        deletionStatus: 'purge_pending' as const,
        deletedAt: '2026-07-23T00:00:00.000Z',
      },
      deletionTask,
    })),
    ...overrides,
  };
}

describe('ProjectService create/get/update', () => {
  it('derives tenant and actor only from trusted context', async () => {
    const store = createStore();
    const service = new ProjectService(store, {
      createId: () => PROJECT_ID,
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    await expect(
      service.create(
        context,
        { name: 'Research brief', description: '25 source pages' },
        'project-create-001',
      ),
    ).resolves.toEqual(storedProject);
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        projectId: PROJECT_ID,
        version: 1,
        idempotencyKey: 'project-create-001',
      }),
    );

    await expect(
      service.create(
        context,
        {
          name: 'Escalation attempt',
          tenantId: '01890f3e-b6e8-7000-8000-000000000099',
        },
        'project-create-002',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });

  it('replays an idempotent creation and rejects a reused key', async () => {
    const replayStore = createStore({
      create: vi.fn(async () => ({ kind: 'replayed' as const, project: storedProject })),
    });
    const conflictStore = createStore({
      create: vi.fn(async () => ({ kind: 'idempotency_conflict' as const })),
    });

    await expect(
      new ProjectService(replayStore, { createId: () => PROJECT_ID }).create(
        context,
        { name: 'Research brief' },
        'project-create-001',
      ),
    ).resolves.toEqual(storedProject);
    await expect(
      new ProjectService(conflictStore, { createId: () => PROJECT_ID }).create(
        context,
        { name: 'Different project' },
        'project-create-001',
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
  });

  it('returns the same 404 for absent and cross-tenant reads', async () => {
    const store = createStore({ findVisible: vi.fn(async () => null) });
    const service = new ProjectService(store);

    await expect(service.get(context, PROJECT_ID)).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      status: 404,
    });
    expect(store.findVisible).toHaveBeenCalledWith(
      TENANT_ID,
      USER_ID,
      PROJECT_ID,
    );
  });

  it('performs a strong ETag compare-and-swap update', async () => {
    const store = createStore();
    const service = new ProjectService(store);
    const updated = await service.update(
      context,
      PROJECT_ID,
      { name: 'Updated brief' },
      '"1"',
      'project-update-001',
    );

    expect(updated).toMatchObject({ version: 2, etag: '"2"' });
    expect(store.update).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 1, tenantId: TENANT_ID }),
    );
  });

  it('returns a conflict with the safe current snapshot', async () => {
    const current = { ...withVersion(storedProject, 3), name: 'Device A edit' };
    const store = createStore({
      update: vi.fn(async () => ({ kind: 'version_conflict' as const, current })),
    });
    const service = new ProjectService(store);

    try {
      await service.update(
        context,
        PROJECT_ID,
        { name: 'Device B edit' },
        '"2"',
        'project-update-002',
      );
      expect.unreachable('stale update must fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectServiceError);
      expect(error).toMatchObject({
        code: 'VERSION_CONFLICT',
        status: 409,
        details: { expectedVersion: 2, currentVersion: 3, current },
      });
    }
  });

  it('maps a database-enforced ACL denial to a safe 403 response', async () => {
    const store = createStore({
      update: vi.fn(async () => ({ kind: 'forbidden' as const })),
    });
    const service = new ProjectService(store);

    await expect(
      service.update(
        context,
        PROJECT_ID,
        { name: 'Forbidden edit' },
        '"1"',
        'project-update-forbidden',
      ),
    ).rejects.toMatchObject({
      code: 'PROJECT_ACCESS_DENIED',
      status: 403,
    });
  });
});

describe('ProjectService lifecycle', () => {
  it('lists only records returned by the tenant-scoped store boundary', async () => {
    const store = createStore();
    const service = new ProjectService(store);

    await expect(service.list(context)).resolves.toEqual([storedProject]);
    expect(store.listVisible).toHaveBeenCalledWith(TENANT_ID, USER_ID);
  });

  it('copies atomically from a source ETag and never accepts a tenant override', async () => {
    const store = createStore();
    const service = new ProjectService(store, {
      createId: () => COPIED_PROJECT_ID,
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    await expect(
      service.copy(
        context,
        PROJECT_ID,
        { name: 'Copy', tenantId: '01890f3e-b6e8-7000-8000-000000000099' },
        '"1"',
        'project-copy-001',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });

    await expect(
      service.copy(context, PROJECT_ID, { name: 'Copy' }, '"1"', 'project-copy-002'),
    ).resolves.toMatchObject({
      id: COPIED_PROJECT_ID,
      copiedFromProjectId: PROJECT_ID,
    });
    expect(store.copy).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        sourceProjectId: PROJECT_ID,
        copiedProjectId: COPIED_PROJECT_ID,
        expectedVersion: 1,
        idempotencyKey: 'project-copy-002',
      }),
    );
  });

  it('archives by atomic CAS and permits an unchanged replay without incrementing version', async () => {
    const archived: ProjectRecord = {
      ...storedProject,
      status: 'archived',
      archivedAt: '2026-07-23T00:00:00.000Z',
    };
    const store = createStore({
      archive: vi.fn(async () => ({ kind: 'unchanged' as const, project: archived })),
    });
    const service = new ProjectService(store);

    const result = await service.archive(
      context,
      PROJECT_ID,
      '"1"',
      'project-archive-001',
    );

    expect(result).toMatchObject({ version: 1, etag: '"1"', status: 'archived' });
    expect(store.archive).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: 1, tenantId: TENANT_ID }),
    );
  });

  it('soft deletes without changing the archived state', async () => {
    const archivedSoftDeleted: ProjectRecord = {
      ...withVersion(storedProject, 2),
      status: 'archived',
      archivedAt: '2026-07-22T00:00:00.000Z',
      deletionStatus: 'soft_deleted',
      deletedAt: '2026-07-23T00:00:00.000Z',
    };
    const store = createStore({
      softDelete: vi.fn(async () => ({ kind: 'applied' as const, project: archivedSoftDeleted })),
    });
    const service = new ProjectService(store);

    await expect(
      service.softDelete(context, PROJECT_ID, '"1"', 'project-delete-001'),
    ).resolves.toMatchObject({ status: 'archived', deletionStatus: 'soft_deleted' });
  });

  it('rejects restore after purge has been requested', async () => {
    const pending: ProjectRecord = {
      ...withVersion(storedProject, 3),
      deletionStatus: 'purge_pending',
      deletedAt: '2026-07-23T00:00:00.000Z',
    };
    const store = createStore({
      restore: vi.fn(async () => ({ kind: 'invalid_state' as const, current: pending })),
    });
    const service = new ProjectService(store);

    await expect(
      service.restore(context, PROJECT_ID, '"3"', 'project-restore-001'),
    ).rejects.toMatchObject({
      code: 'INVALID_PROJECT_STATE',
      status: 409,
      details: { current: pending },
    });
  });

  it('requests asynchronous purge only from soft_deleted and returns its pending task', async () => {
    const store = createStore();
    const service = new ProjectService(store, {
      createId: () => DELETION_TASK_ID,
      now: () => new Date('2026-07-23T00:00:00.000Z'),
    });

    const result = await service.requestPermanentDelete(
      context,
      PROJECT_ID,
      '"2"',
      'project-purge-001',
    );

    expect(result).toEqual({
      project: expect.objectContaining({ deletionStatus: 'purge_pending' }),
      deletionTask,
    });
    expect(store.requestPermanentDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        deletionTaskId: DELETION_TASK_ID,
        expectedVersion: 2,
        idempotencyKey: 'project-purge-001',
        requiredDeletionStatus: 'soft_deleted',
        tenantId: TENANT_ID,
      }),
    );
  });

  it('refuses permanent deletion unless the atomic store observes soft_deleted', async () => {
    const store = createStore({
      requestPermanentDelete: vi.fn(async () => ({
        kind: 'invalid_state' as const,
        current: storedProject,
      })),
    });
    const service = new ProjectService(store, { createId: () => DELETION_TASK_ID });

    await expect(
      service.requestPermanentDelete(
        context,
        PROJECT_ID,
        '"1"',
        'project-purge-active',
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_PROJECT_STATE',
      status: 409,
      details: { current: storedProject },
    });
  });

  it('returns the same 404 for absent and cross-tenant copies', async () => {
    const store = createStore({
      copy: vi.fn(async () => ({ kind: 'not_found' as const })),
    });
    const service = new ProjectService(store, { createId: () => COPIED_PROJECT_ID });

    await expect(
      service.copy(context, PROJECT_ID, {}, '"1"', 'project-copy-404'),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });
  });

  it.each(['archive', 'softDelete', 'restore', 'requestPermanentDelete'] as const)(
    'returns the same 404 for absent and cross-tenant %s mutations',
    async (method) => {
      const store = createStore({
        [method]: vi.fn(async () => ({ kind: 'not_found' as const })),
      });
      const service = new ProjectService(store, { createId: () => DELETION_TASK_ID });

      await expect(
        service[method](context, PROJECT_ID, '"1"', `project-${method}-404`),
      ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });
    },
  );
});

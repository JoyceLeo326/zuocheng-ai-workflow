import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ArchiveProjectCommand,
  CopyProjectCommand,
  CreateProjectCommand,
  PermanentDeleteProjectCommand,
  RestoreProjectCommand,
  SoftDeleteProjectCommand,
  UpdateProjectCommand,
} from './project-service.js';
import {
  PostgresProjectStore,
  type ProjectStoreFaultStep,
  type SqlPool,
  type TenantPoolProvider,
} from './postgres-project-store.js';

const migrationPath = fileURLToPath(
  new URL('../../../../packages/db/migrations/0000_foundation.sql', import.meta.url),
);
const migration = readFileSync(migrationPath, 'utf8');

const TENANT_A = '01890f3e-b6e8-7cc2-98c0-7c9a2fe4f5d1';
const TENANT_B = '01890f3e-b6e8-7cc2-98c0-7c9a2fe4f5d2';
const USER_A = '01890f3e-b6e8-7d37-a839-3f11a9ca1b79';
const USER_B = '01890f3e-b6e8-7d37-a839-3f11a9ca1b80';
const USER_A_VIEWER = '01890f3e-b6e8-7d37-a839-3f11a9ca1b81';
const PROJECT_A = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a2';
const PROJECT_B = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a3';
const COPY_A = '01890f3e-b6e8-7a12-8d98-5b82e8cc46a2';
const ROLLBACK_PROJECT = '01890f3e-b6e8-7a12-8d98-5b82e8cc46a3';
const DELETE_TASK = '01890f3e-b6e8-7a13-8d98-5b82e8cc46a2';
const AT = '2026-07-23T00:00:00.000Z';

type QueryRow = Record<string, unknown>;

function pglitePool(db: PGlite): SqlPool {
  return {
    async connect() {
      return {
        async query<Row extends QueryRow = QueryRow>(sql: string, values: readonly unknown[] = []) {
          const result = await db.query<Row>(sql, [...values]);
          return { rows: result.rows, rowCount: result.affectedRows ?? null };
        },
        release() {},
      };
    },
  };
}

function pgliteTenantPools(db: PGlite): TenantPoolProvider {
  const roles = new Map([
    [`${TENANT_A}:${USER_A}`, 'zuocheng_runtime_a'],
    [`${TENANT_A}:${USER_A_VIEWER}`, 'zuocheng_runtime_a_viewer'],
    [`${TENANT_B}:${USER_B}`, 'zuocheng_runtime_b'],
  ]);
  return {
    poolForContext(tenantId, userId) {
      const role = roles.get(`${tenantId}:${userId}`);
      if (role === undefined) {
        throw new Error(`No database login for tenant ${tenantId} and user ${userId}`);
      }
      return pgliteLoginPool(db, role);
    },
  };
}

function pgliteLoginPool(db: PGlite, role: string): SqlPool {
  return {
    async connect() {
      await db.exec('RESET ROLE');
      await db.exec('RESET SESSION AUTHORIZATION');
      await db.exec(`SET SESSION AUTHORIZATION ${role}`);
      // PGlite 0.5.x requires the session-level SET ROLE used by the database
      // compatibility suite; the store still issues production SET LOCAL ROLE.
      await db.exec('SET ROLE zuocheng_app');
      return pglitePool(db).connect();
    },
  };
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function createCommand(projectId = PROJECT_A, key = 'project-create-001'): CreateProjectCommand {
  return {
    tenantId: TENANT_A,
    actorUserId: USER_A,
    projectId,
    version: 1,
    name: 'Research brief',
    description: 'Original source snapshot',
    idempotencyKey: key,
    requestHash: hash(`create:${projectId}`),
    occurredAt: AT,
  };
}

function mutationBase(projectId: string, version: number, key: string) {
  return {
    tenantId: TENANT_A,
    actorUserId: USER_A,
    projectId,
    expectedVersion: version,
    idempotencyKey: key,
    requestHash: hash(`${key}:${version}`),
    occurredAt: AT,
  };
}

describe.sequential('PostgresProjectStore against PGlite PostgreSQL', () => {
  const db = new PGlite();
  const pools = pgliteTenantPools(db);
  const store = new PostgresProjectStore(pools);
  let projectA = PROJECT_A;
  let copyA = COPY_A;

  async function runtimeTenantQuery<Row extends QueryRow>(
    tenantId: string,
    sql: string,
    values: readonly (string | number | boolean | null)[] = [],
  ): Promise<Row[]> {
    const client = await pgliteLoginPool(db, 'zuocheng_runtime_a').connect();
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE zuocheng_app');
      await client.query("SELECT set_config('zuocheng.current_tenant_id', $1, true)", [
        tenantId,
      ]);
      const result = await client.query<Row>(sql, values);
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    await db.exec(migration);
    await db.exec(
      `CREATE FUNCTION zuocheng.test_grant_project_viewer(
         p_tenant_id uuid,
         p_project_id uuid,
         p_user_id uuid
       ) RETURNS void
       LANGUAGE sql
       SECURITY DEFINER
       SET search_path = pg_catalog, zuocheng
       AS $function$
         INSERT INTO zuocheng.project_acl
           (tenant_id, project_id, principal_user_id, access_level)
         VALUES (p_tenant_id, p_project_id, p_user_id, 'viewer');
       $function$;
       REVOKE ALL ON FUNCTION zuocheng.test_grant_project_viewer(uuid, uuid, uuid)
         FROM PUBLIC;
       GRANT EXECUTE ON FUNCTION zuocheng.test_grant_project_viewer(uuid, uuid, uuid)
         TO zuocheng_app;

       CREATE FUNCTION zuocheng.test_expire_idempotency(
         p_tenant_id uuid,
         p_principal_user_id uuid,
         p_scope text,
         p_key_hash text
       ) RETURNS void
       LANGUAGE sql
       SECURITY DEFINER
       SET search_path = pg_catalog, zuocheng
       AS $function$
         UPDATE zuocheng.idempotency_record
            SET expires_at = clock_timestamp() - interval '1 minute'
          WHERE tenant_id = p_tenant_id
            AND principal_user_id = p_principal_user_id
            AND scope = p_scope
            AND idempotency_key_hash = p_key_hash;
       $function$;
       REVOKE ALL ON FUNCTION zuocheng.test_expire_idempotency(uuid, uuid, text, text)
         FROM PUBLIC;
       GRANT EXECUTE ON FUNCTION zuocheng.test_expire_idempotency(uuid, uuid, text, text)
         TO zuocheng_app;`,
    );
    await db.query(
      `INSERT INTO zuocheng.tenant (id, slug, display_name)
       VALUES ($1, 'store-a', 'Store A'), ($2, 'store-b', 'Store B')`,
      [TENANT_A, TENANT_B],
    );
    await db.query(
      `INSERT INTO zuocheng."user" (id, email, display_name)
       VALUES ($1, 'store-a@example.test', 'Store A'),
              ($2, 'store-b@example.test', 'Store B'),
              ($3, 'store-a-viewer@example.test', 'Store A Viewer')`,
      [USER_A, USER_B, USER_A_VIEWER],
    );
    await db.query(
      `INSERT INTO zuocheng.membership (tenant_id, user_id, role)
       VALUES ($1, $3, 'owner'), ($2, $4, 'owner'), ($1, $5, 'viewer')`,
      [TENANT_A, TENANT_B, USER_A, USER_B, USER_A_VIEWER],
    );
    await db.exec(
      `CREATE ROLE zuocheng_runtime_a LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
       CREATE ROLE zuocheng_runtime_a_viewer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
       CREATE ROLE zuocheng_runtime_b LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
       GRANT zuocheng_app TO zuocheng_runtime_a WITH SET TRUE, INHERIT FALSE;
       GRANT zuocheng_app TO zuocheng_runtime_a_viewer WITH SET TRUE, INHERIT FALSE;
       GRANT zuocheng_app TO zuocheng_runtime_b WITH SET TRUE, INHERIT FALSE;`,
    );
    await db.query(
      `INSERT INTO zuocheng.runtime_principal (login_role, tenant_id, user_id)
       VALUES ('zuocheng_runtime_a', $1, $3),
              ('zuocheng_runtime_a_viewer', $1, $4),
              ('zuocheng_runtime_b', $2, $5)`,
      [TENANT_A, TENANT_B, USER_A, USER_A_VIEWER, USER_B],
    );
  });

  afterAll(async () => db.close());

  it('creates, replays by key without persisting the raw key, and rejects key reuse', async () => {
    const command = createCommand();
    const created = await store.create(command);
    expect(created).toMatchObject({ kind: 'applied', project: { version: 1 } });
    if (created.kind !== 'applied') throw new Error('expected applied creation');
    projectA = created.project.id;
    await expect(store.create({ ...command, projectId: PROJECT_B })).resolves.toEqual({
      kind: 'replayed',
      project: created.kind === 'applied' ? created.project : undefined,
    });
    await expect(
      store.create({ ...command, projectId: PROJECT_B, requestHash: hash('different') }),
    ).resolves.toEqual({ kind: 'idempotency_conflict' });

    const persisted = await runtimeTenantQuery<{ key_hash: string; raw_count: number }>(
      TENANT_A,
      `SELECT idempotency_key_hash AS key_hash,
              count(*) FILTER (WHERE response_body::text LIKE '%' || $2 || '%')::integer AS raw_count
         FROM zuocheng.idempotency_record
        WHERE tenant_id = $1
        GROUP BY idempotency_key_hash`,
      [TENANT_A, command.idempotencyKey],
    );
    expect(persisted).toEqual([{ key_hash: hash(command.idempotencyKey), raw_count: 0 }]);
  });

  it('binds the database login to the actor and enforces project ACLs', async () => {
    await expect(
      store.findVisible(TENANT_A, USER_A_VIEWER, projectA),
    ).resolves.toBeNull();
    await expect(
      store.listVisible(TENANT_A, USER_A_VIEWER),
    ).resolves.toEqual([]);

    const wrongUserPool = new PostgresProjectStore({
      poolForContext: () => pgliteLoginPool(db, 'zuocheng_runtime_a'),
    });
    await expect(
      wrongUserPool.listVisible(TENANT_A, USER_A_VIEWER),
    ).rejects.toMatchObject({ code: '42501' });

    await runtimeTenantQuery(
      TENANT_A,
      'SELECT zuocheng.test_grant_project_viewer($1, $2, $3)',
      [TENANT_A, projectA, USER_A_VIEWER],
    );
    await expect(
      store.findVisible(TENANT_A, USER_A_VIEWER, projectA),
    ).resolves.toMatchObject({ id: projectA });
    await expect(
      store.listVisible(TENANT_A, USER_A_VIEWER),
    ).resolves.toContainEqual(expect.objectContaining({ id: projectA }));

    const viewerUpdate: UpdateProjectCommand = {
      ...mutationBase(projectA, 1, 'project-viewer-update'),
      actorUserId: USER_A_VIEWER,
      patch: { name: 'Forbidden viewer edit' },
    };
    await expect(store.update(viewerUpdate)).resolves.toEqual({
      kind: 'forbidden',
    });
  });

  it('authorizes mutation before disclosing a stale soft-deleted snapshot', async () => {
    const created = await store.create(
      createCommand(PROJECT_B, 'viewer-soft-deleted-create'),
    );
    if (created.kind !== 'applied') throw new Error('expected isolated project creation');
    const secretProjectId = created.project.id;
    await runtimeTenantQuery(
      TENANT_A,
      'SELECT zuocheng.test_grant_project_viewer($1, $2, $3)',
      [TENANT_A, secretProjectId, USER_A_VIEWER],
    );
    await expect(
      store.softDelete({
        ...mutationBase(secretProjectId, 1, 'viewer-soft-deleted-owner-delete'),
        preserveProjectStatus: true,
      }),
    ).resolves.toMatchObject({ kind: 'applied', project: { version: 2 } });
    await expect(
      store.findVisible(TENANT_A, USER_A_VIEWER, secretProjectId),
    ).resolves.toBeNull();

    const staleViewerUpdate: UpdateProjectCommand = {
      ...mutationBase(secretProjectId, 1, 'viewer-soft-deleted-stale-update'),
      actorUserId: USER_A_VIEWER,
      patch: { name: 'must not reveal the tombstone' },
    };
    const result = await store.update(staleViewerUpdate);
    expect(result).toEqual({ kind: 'forbidden' });
    expect(JSON.stringify(result)).not.toContain('Research brief');
    expect(JSON.stringify(result)).not.toContain('soft_deleted');
  });

  it('atomically reclaims an expired idempotency key without growing duplicate rows', async () => {
    const key = 'expired-create-key';
    const first = await store.create(createCommand(PROJECT_B, key));
    expect(first).toMatchObject({ kind: 'applied' });
    await runtimeTenantQuery(
      TENANT_A,
      'SELECT zuocheng.test_expire_idempotency($1, $2, $3, $4)',
      [TENANT_A, USER_A, 'project.create', hash(key)],
    );

    const second = await store.create({
      ...createCommand(PROJECT_B, key),
      requestHash: hash('expired-key-new-request'),
      name: 'Reclaimed request',
    });
    expect(second).toMatchObject({
      kind: 'applied',
      project: { name: 'Reclaimed request' },
    });
    const rows = await runtimeTenantQuery<{ count: number }>(
      TENANT_A,
      `SELECT count(*)::integer AS count FROM zuocheng.idempotency_record
        WHERE tenant_id = $1 AND principal_user_id = $2
          AND scope = 'project.create' AND idempotency_key_hash = $3`,
      [TENANT_A, USER_A, hash(key)],
    );
    expect(rows).toEqual([{ count: 1 }]);
  });

  it('keeps stale CAS from overwriting and retains both committed snapshots', async () => {
    const update: UpdateProjectCommand = {
      ...mutationBase(projectA, 1, 'project-update-a'),
      patch: { name: 'Device A edit' },
    };
    await expect(store.update(update)).resolves.toMatchObject({
      kind: 'applied',
      project: { name: 'Device A edit', version: 2 },
    });
    await expect(
      store.update({
        ...update,
        idempotencyKey: 'project-update-stale',
        requestHash: hash('stale'),
        patch: { name: 'Device B stale edit' },
      }),
    ).resolves.toMatchObject({
      kind: 'version_conflict',
      current: { name: 'Device A edit', version: 2 },
    });

    const versions = await runtimeTenantQuery<{ version: number; name: string }>(
      TENANT_A,
      `SELECT version, snapshot->>'name' AS name
         FROM zuocheng.project_version
        WHERE tenant_id = $1 AND project_id = $2 ORDER BY version`,
      [TENANT_A, projectA],
    );
    expect(versions).toEqual([
      { version: 1, name: 'Research brief' },
      { version: 2, name: 'Device A edit' },
    ]);
  });

  it('fails closed across tenants and copies the locked source version', async () => {
    expect(await store.findVisible(TENANT_B, USER_B, projectA)).toBeNull();
    expect(await store.listVisible(TENANT_B, USER_B)).toEqual([]);
    const wrongTenantPool = new PostgresProjectStore({
      poolForContext: () => pgliteLoginPool(db, 'zuocheng_runtime_a'),
    });
    await expect(wrongTenantPool.listVisible(TENANT_B, USER_B)).rejects.toMatchObject({
      code: '42501',
    });
    const copyBase = mutationBase(
      projectA,
      2,
      'project-copy-a',
    );
    const copy: CopyProjectCommand = {
      tenantId: copyBase.tenantId,
      actorUserId: copyBase.actorUserId,
      expectedVersion: copyBase.expectedVersion,
      idempotencyKey: copyBase.idempotencyKey,
      requestHash: copyBase.requestHash,
      occurredAt: copyBase.occurredAt,
      sourceProjectId: projectA,
      copiedProjectId: COPY_A,
      name: 'Fixed copy',
    };
    const copied = await store.copy(copy);
    expect(copied).toMatchObject({
      kind: 'applied',
      project: {
        name: 'Fixed copy',
        description: 'Original source snapshot',
        copiedFromProjectId: projectA,
      },
    });
    if (copied.kind !== 'applied') throw new Error('expected applied copy');
    copyA = copied.project.id;
  });

  it('archives once, preserves status through soft delete, restores, and queues purge only after soft delete', async () => {
    const archive: ArchiveProjectCommand = mutationBase(copyA, 1, 'project-archive-a');
    const archived = await store.archive(archive);
    expect(archived).toMatchObject({ kind: 'applied', project: { status: 'archived', version: 2 } });
    await expect(
      store.archive({ ...archive, expectedVersion: 2, idempotencyKey: 'archive-unchanged', requestHash: hash('archive-unchanged') }),
    ).resolves.toMatchObject({ kind: 'unchanged', project: { version: 2 } });

    const soft: SoftDeleteProjectCommand = {
      ...mutationBase(copyA, 2, 'project-soft-a'),
      preserveProjectStatus: true,
    };
    await expect(store.softDelete(soft)).resolves.toMatchObject({
      kind: 'applied',
      project: { status: 'archived', deletionStatus: 'soft_deleted', version: 3 },
    });
    await expect(store.findVisible(TENANT_A, USER_A, copyA)).resolves.toBeNull();
    await expect(store.listVisible(TENANT_A, USER_A)).resolves.not.toContainEqual(
      expect.objectContaining({ id: copyA }),
    );
    const restore: RestoreProjectCommand = {
      ...mutationBase(copyA, 3, 'project-restore-a'),
      prohibitedDeletionStatus: 'purge_pending',
    };
    await expect(store.restore(restore)).resolves.toMatchObject({
      kind: 'applied',
      project: { status: 'archived', deletionStatus: 'active', version: 4 },
    });

    await expect(
      store.requestPermanentDelete({
        ...mutationBase(copyA, 4, 'project-purge-invalid'),
        deletionTaskId: DELETE_TASK,
        requiredDeletionStatus: 'soft_deleted',
      }),
    ).resolves.toMatchObject({ kind: 'invalid_state', current: { deletionStatus: 'active' } });

    const softAgain: SoftDeleteProjectCommand = {
      ...mutationBase(copyA, 4, 'project-soft-b'),
      preserveProjectStatus: true,
    };
    await store.softDelete(softAgain);
    const purge: PermanentDeleteProjectCommand = {
      ...mutationBase(copyA, 5, 'project-purge-a'),
      deletionTaskId: DELETE_TASK,
      requiredDeletionStatus: 'soft_deleted',
    };
    await expect(store.requestPermanentDelete(purge)).resolves.toMatchObject({
      kind: 'applied',
      project: { deletionStatus: 'purge_pending', version: 6 },
      deletionTask: { status: 'purge_pending' },
    });
    await expect(store.findVisible(TENANT_A, USER_A, copyA)).resolves.toBeNull();
    await expect(store.listVisible(TENANT_A, USER_A)).resolves.not.toContainEqual(
      expect.objectContaining({ id: copyA }),
    );
  });

  it('rolls back project, version, audit, and idempotency together after an injected failure', async () => {
    const before = await runtimeTenantQuery<{
      projects: number;
      versions: number;
      audits: number;
    }>(TENANT_A, `SELECT
      (SELECT count(*)::integer FROM zuocheng.project) AS projects,
      (SELECT count(*)::integer FROM zuocheng.project_version) AS versions,
      (SELECT count(*)::integer FROM zuocheng.audit_event) AS audits`);
    const failAt: ProjectStoreFaultStep = 'audit_appended';
    const faulty = new PostgresProjectStore(pools, {
      afterStep(step) {
        if (step === failAt) throw new Error('injected transaction failure');
      },
    });
    await expect(
      faulty.create(createCommand(ROLLBACK_PROJECT, 'project-create-rollback')),
    ).rejects.toThrow('injected transaction failure');

    const counts = await runtimeTenantQuery<{
      projects: number;
      versions: number;
      audits: number;
      idempotency: number;
    }>(TENANT_A, `SELECT
      (SELECT count(*)::integer FROM zuocheng.project) AS projects,
      (SELECT count(*)::integer FROM zuocheng.project_version) AS versions,
      (SELECT count(*)::integer FROM zuocheng.audit_event) AS audits,
      (SELECT count(*)::integer FROM zuocheng.idempotency_record
        WHERE idempotency_key_hash = $1) AS idempotency`,
    [hash('project-create-rollback')]);
    expect(counts).toEqual([{ ...before[0]!, idempotency: 0 }]);
  });
});

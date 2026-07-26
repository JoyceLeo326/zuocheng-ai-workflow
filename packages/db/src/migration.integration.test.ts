import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL('../migrations/0000_foundation.sql', import.meta.url),
);
const migration = readFileSync(migrationPath, 'utf8');

type PgError = Error & { code?: string };
type ScalarRow = Record<string, string | number | boolean | null>;

async function expectSqlState(operation: Promise<unknown>, expectedCode: string) {
  try {
    await operation;
  } catch (error) {
    expect((error as PgError).code).toBe(expectedCode);
    return;
  }
  throw new Error(`Expected PostgreSQL SQLSTATE ${expectedCode}`);
}

// PGlite 0.5.x embeds PostgreSQL 18. This is a fast compatibility layer only;
// packages/db/qa/postgres17.mjs is the release gate for native PostgreSQL 17.
describe.sequential('PGlite PostgreSQL 18 compatibility smoke test', () => {
  const db = new PGlite();
  let tenantA = '';
  let tenantB = '';
  let userA = '';
  let userA2 = '';
  let userB = '';
  let projectA = '';
  let projectB = '';
  let copiedProject = '';
  let cancelledRequest = '';
  let purgeRequest = '';

  async function becomeAdmin() {
    await db.exec('RESET ROLE');
    await db.exec('RESET SESSION AUTHORIZATION');
  }

  async function becomeRuntime() {
    await becomeAdmin();
    await db.exec('SET SESSION AUTHORIZATION zuocheng_runtime_a');
    await db.exec('SET ROLE zuocheng_app');
  }

  async function becomeApp() {
    await becomeAdmin();
    await db.exec('SET ROLE zuocheng_app');
  }

  async function beginTenant(tenantId: string) {
    await db.exec('BEGIN');
    await db.query("SELECT set_config('zuocheng.current_tenant_id', $1, true)", [tenantId]);
  }

  async function expectTenantSqlState(
    tenantId: string,
    operation: () => Promise<unknown>,
    expectedCode: string,
  ) {
    await beginTenant(tenantId);
    try {
      await expectSqlState(operation(), expectedCode);
    } finally {
      await db.exec('ROLLBACK');
    }
  }

  async function inTenantTransaction(tenantId: string, operation: () => Promise<void>) {
    await beginTenant(tenantId);
    try {
      await operation();
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw error;
    }
  }

  beforeAll(async () => {
    await db.exec(migration);

    const ids = await db.query<{
      tenant_a: string;
      tenant_b: string;
      user_a: string;
      user_b: string;
      user_a2: string;
      project_a: string;
      project_b: string;
      copied_project: string;
    }>(`SELECT
      zuocheng.uuid_v7()::text AS tenant_a,
      zuocheng.uuid_v7()::text AS tenant_b,
      zuocheng.uuid_v7()::text AS user_a,
      zuocheng.uuid_v7()::text AS user_b,
      zuocheng.uuid_v7()::text AS user_a2,
      zuocheng.uuid_v7()::text AS project_a,
      zuocheng.uuid_v7()::text AS project_b,
      zuocheng.uuid_v7()::text AS copied_project`);
    ({
      tenant_a: tenantA,
      tenant_b: tenantB,
      user_a: userA,
      user_b: userB,
      user_a2: userA2,
      project_a: projectA,
      project_b: projectB,
      copied_project: copiedProject,
    } = ids.rows[0]!);

    await db.query(
      `INSERT INTO zuocheng.tenant (id, slug, display_name)
       VALUES ($1, 'tenant-a', 'Tenant A'), ($2, 'tenant-b', 'Tenant B')`,
      [tenantA, tenantB],
    );
    await db.query(
      `INSERT INTO zuocheng."user" (id, email, display_name)
       VALUES ($1, 'a@example.test', 'User A'), ($2, 'b@example.test', 'User B'),
              ($3, 'a2@example.test', 'User A2')`,
      [userA, userB, userA2],
    );
    await db.query(
      `INSERT INTO zuocheng.membership (tenant_id, user_id, role)
       VALUES ($1, $3, 'owner'), ($2, $4, 'owner'), ($1, $5, 'member')`,
      [tenantA, tenantB, userA, userB, userA2],
    );
    await db.query(
      `INSERT INTO zuocheng.project
         (tenant_id, id, created_by_user_id, updated_by_user_id, name, description)
       VALUES
         ($1, $3, $5, $5, 'A project', 'sensitive body'),
         ($2, $4, $6, $6, 'B project', 'other tenant body')`,
      [tenantA, tenantB, projectA, projectB, userA, userB],
    );
    await db.query("SELECT set_config('zuocheng.current_tenant_id', $1, false)", [tenantA]);
    await db.query(
      `INSERT INTO zuocheng.project_version
         (tenant_id, project_id, version, snapshot, created_by_user_id)
       VALUES ($1, $2, 1, '{"name":"A project","body":"sensitive"}', $3)`,
      [tenantA, projectA, userA],
    );
    await db.query(
      `INSERT INTO zuocheng.project_acl
         (tenant_id, project_id, principal_user_id, access_level)
       VALUES ($1, $2, $3, 'owner')`,
      [tenantA, projectA, userA],
    );
    await db.query(
      `INSERT INTO zuocheng.idempotency_record
         (tenant_id, principal_user_id, project_id, scope, idempotency_key_hash, request_hash,
          response_status, response_body, expires_at)
       VALUES ($1, $3, $2, 'project.update', repeat('a', 64), repeat('b', 64), 200,
          '{"body":"sensitive"}', now() + interval '1 day')`,
      [tenantA, projectA, userA],
    );
    await db.query(
      `INSERT INTO zuocheng.audit_event
         (tenant_id, actor_user_id, event_type, subject_type, subject_id, payload)
       VALUES ($1, $2, 'project.created', 'project', $3, '{"body":"sensitive"}')`,
      [tenantA, userA, projectA],
    );

    await db.exec(
      `CREATE ROLE zuocheng_runtime_a LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
       CREATE ROLE zuocheng_runtime_b LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
       CREATE ROLE zuocheng_purge_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
       GRANT zuocheng_app TO zuocheng_runtime_a WITH SET TRUE, INHERIT FALSE;
       GRANT zuocheng_app TO zuocheng_runtime_b WITH SET TRUE, INHERIT FALSE;
       GRANT zuocheng_purge TO zuocheng_purge_runtime WITH SET TRUE, INHERIT FALSE;
       INSERT INTO zuocheng.runtime_principal (login_role, tenant_id, user_id)
       VALUES ('postgres', '${tenantA}', '${userA}'),
              ('zuocheng_runtime_a', '${tenantA}', '${userA}'),
              ('zuocheng_runtime_b', '${tenantB}', '${userB}');`,
    );
    await db.exec('RESET zuocheng.current_tenant_id');
    await becomeApp();
    await beginTenant(tenantA);
    const copied = await db.query<{ project_id: string }>(
      `SELECT zuocheng.copy_project($1, $2, 1, 'Copied project')::text AS project_id`,
      [projectA, userA],
    );
    copiedProject = copied.rows[0]!.project_id;
    await db.query(
      `SELECT * FROM zuocheng.claim_idempotency_record(
         $1, 'project.copy.result', repeat('3', 64), repeat('4', 64), NULL
       )`,
      [tenantA],
    );
    await db.query(
      `SELECT zuocheng.complete_idempotency_record(
         $1, 'project.copy.result', repeat('3', 64), $2, 201,
         jsonb_build_object('sourceProjectId', upper($3::text))
       )`,
      [tenantA, copiedProject, projectA],
    );
    await db.exec('COMMIT');
  });

  afterAll(async () => {
    await db.close();
  });

  it('labels PGlite as PostgreSQL 18 rather than native PostgreSQL 17 evidence', async () => {
    const result = await db.query<{ version: string }>('SELECT version()');
    expect(result.rows[0]!.version).toContain('PostgreSQL 18');
  });

  it('uses a non-super runtime login and forces RLS on every core table', async () => {
    const roles = await db.query<ScalarRow>(`SELECT
      app.rolbypassrls AS app_bypass,
      app.rolsuper AS app_super,
      runtime.rolbypassrls AS runtime_bypass,
      runtime.rolsuper AS runtime_super,
      pg_has_role('zuocheng_runtime_a', 'zuocheng_app', 'MEMBER') AS runtime_is_member
    FROM pg_roles AS app
    CROSS JOIN pg_roles AS runtime
    WHERE app.rolname = 'zuocheng_app' AND runtime.rolname = 'zuocheng_runtime_a'`);
    expect(roles.rows).toEqual([
      {
        app_bypass: false,
        app_super: false,
        runtime_bypass: false,
        runtime_super: false,
        runtime_is_member: true,
      },
    ]);

    const relations = await db.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      owner: string;
    }>(`SELECT relation.relname, relation.relrowsecurity, relation.relforcerowsecurity,
              owner.rolname AS owner
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN pg_roles AS owner ON owner.oid = relation.relowner
       WHERE namespace.nspname = 'zuocheng' AND relation.relkind = 'r'
         AND relation.relname IN (
           'tenant', 'user', 'membership', 'project', 'project_version', 'project_acl',
           'idempotency_record', 'audit_event', 'deletion_request'
         )
       ORDER BY relation.relname`);
    expect(relations.rows).toHaveLength(9);
    expect(relations.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    expect(relations.rows.every((row) => row.owner === 'zuocheng_owner')).toBe(true);

    const memberships = await db.query<{ member: string; granted_role: string }>(
      `SELECT member.rolname AS member, granted.rolname AS granted_role
         FROM pg_auth_members AS membership
         JOIN pg_roles AS member ON member.oid = membership.member
         JOIN pg_roles AS granted ON granted.oid = membership.roleid
        WHERE member.rolname IN (
          'postgres', 'zuocheng_runtime_a', 'zuocheng_runtime_b', 'zuocheng_purge_runtime'
        )
        ORDER BY member.rolname, granted.rolname`,
    );
    expect(memberships.rows).toEqual([
      { member: 'postgres', granted_role: 'zuocheng_owner' },
      { member: 'zuocheng_purge_runtime', granted_role: 'zuocheng_purge' },
      { member: 'zuocheng_runtime_a', granted_role: 'zuocheng_app' },
      { member: 'zuocheng_runtime_b', granted_role: 'zuocheng_app' },
    ]);

    await expectSqlState(db.query('SELECT * FROM zuocheng.runtime_principal'), '42501');

    const constraint = await db.query<{ conname: string }>(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'zuocheng.idempotency_record'::regclass
          AND conname = 'idempotency_record_tenant_principal_scope_key_hash_unique'`,
    );
    expect(constraint.rows).toEqual([
      { conname: 'idempotency_record_tenant_principal_scope_key_hash_unique' },
    ]);
  });

  it('fails closed and clears transaction-local tenant context after commit', async () => {
    const hidden = await db.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM zuocheng.project',
    );
    expect(hidden.rows[0]!.count).toBe(0);

    await beginTenant(tenantA);
    await db.query('SELECT zuocheng.require_app_tenant($1)', [tenantA]);
    const visible = await db.query<{ name: string }>(
      'SELECT name FROM zuocheng.project ORDER BY name',
    );
    expect(visible.rows.map((row) => row.name)).toEqual(['A project', 'Copied project']);
    await db.exec('COMMIT');

    const context = await db.query<{ tenant_id: string | null }>(
      "SELECT NULLIF(current_setting('zuocheng.current_tenant_id', true), '') AS tenant_id",
    );
    expect(context.rows[0]!.tenant_id).toBeNull();
    const hiddenAgain = await db.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM zuocheng.project',
    );
    expect(hiddenAgain.rows[0]!.count).toBe(0);

    await expectTenantSqlState(
      tenantB,
      () => db.query('SELECT zuocheng.require_app_tenant($1)', [tenantB]),
      '42501',
    );
  });

  it('rejects cross-tenant writes', async () => {
    await beginTenant(tenantA);
    await expectSqlState(
      db.query(
        `INSERT INTO zuocheng.project (tenant_id, created_by_user_id, name)
         VALUES ($1, $2, 'Forbidden project')`,
        [tenantB, userB],
      ),
      '42501',
    );
    await db.exec('ROLLBACK');
  });

  it('binds actor arguments to the mapped session user and revokes ACL administration', async () => {
    await beginTenant(tenantA);
    await db.query('SELECT zuocheng.require_app_context($1, $2)', [tenantA, userA]);
    await db.exec('COMMIT');

    await expectTenantSqlState(
      tenantA,
      () => db.query('SELECT zuocheng.require_app_context($1, $2)', [tenantA, userA2]),
      '42501',
    );
    await expectTenantSqlState(
      tenantA,
      () => db.query(`SELECT zuocheng.create_project($1, 'Impersonated', NULL)`, [userA2]),
      '42501',
    );
    await expectTenantSqlState(
      tenantA,
      () => db.query('UPDATE zuocheng.membership SET role = \'owner\' WHERE user_id = $1', [userA2]),
      '42501',
    );
    await expectTenantSqlState(
      tenantA,
      () =>
        db.query(
          `INSERT INTO zuocheng.project_acl
             (tenant_id, project_id, principal_user_id, access_level)
           VALUES ($1, $2, $3, 'owner')`,
          [tenantA, copiedProject, userA2],
        ),
      '42501',
    );
  });

  it('allows atomic idempotency claims and only canonical project-less completions', async () => {
    await beginTenant(tenantA);
    await db.query(
      `SELECT * FROM zuocheng.claim_idempotency_record(
         $1, 'claim.complete', repeat('5', 64), repeat('6', 64), NULL
       )`,
      [tenantA],
    );
    await db.query(
      `SELECT zuocheng.complete_idempotency_record(
         $1, 'claim.complete', repeat('5', 64), NULL, 404, '{"kind":"not_found"}'::jsonb
       )`,
      [tenantA],
    );
    const canonical = await db.query<{ response_body: Record<string, unknown> }>(
      `SELECT response_body FROM zuocheng.idempotency_record
        WHERE tenant_id = $1 AND scope = 'claim.complete'`,
      [tenantA],
    );
    expect(canonical.rows).toEqual([{ response_body: { kind: 'not_found' } }]);
    await db.exec('ROLLBACK');

    await expectTenantSqlState(
      tenantA,
      () =>
        db.query(
          `INSERT INTO zuocheng.idempotency_record
             (tenant_id, principal_user_id, scope, idempotency_key_hash, request_hash,
              response_status, response_body, expires_at)
           VALUES ($1, $2, 'direct.complete', repeat('d', 64), repeat('e', 64), 404,
             '{"kind":"not_found"}'::jsonb, now() + interval '1 day')`,
          [tenantA, userA],
        ),
      '42501',
    );

    await expectTenantSqlState(
      tenantA,
      () =>
        db.query(
          `INSERT INTO zuocheng.idempotency_record
             (tenant_id, principal_user_id, scope, idempotency_key_hash, request_hash,
              response_status, response_body, expires_at)
           VALUES ($1, $2, 'forged.complete', repeat('7', 64), repeat('8', 64), 404,
             '{"kind":"not_found","sourceProjectId":"forged"}'::jsonb,
             now() + interval '1 day')`,
          [tenantA, userA],
        ),
      '42501',
    );
    await expectTenantSqlState(
      tenantA,
      () =>
        db.query(
          `INSERT INTO zuocheng.idempotency_record
             (tenant_id, principal_user_id, scope, idempotency_key_hash, request_hash,
              response_status, response_body, expires_at)
           VALUES ($1, $2, 'missing.project', repeat('9', 64), repeat('0', 64), 200,
             '{"kind":"ok"}'::jsonb, now() + interval '1 day')`,
          [tenantA, userA],
        ),
      '42501',
    );
  });

  it('reclaims expired idempotency rows through a bounded purge-only sweeper', async () => {
    await becomeAdmin();
    await db.query(
      `INSERT INTO zuocheng.idempotency_record
         (tenant_id, principal_user_id, scope, idempotency_key_hash, request_hash, expires_at)
       VALUES ($1, $2, 'cleanup.expired', repeat('1', 64), repeat('2', 64),
                 now() - interval '1 minute'),
              ($1, $2, 'cleanup.active', repeat('3', 64), repeat('4', 64),
                 now() + interval '1 day')`,
      [tenantA, userA],
    );

    await db.exec('SET ROLE zuocheng_purge');
    const purged = await db.query<{ purged: number }>(
      `SELECT zuocheng.purge_expired_idempotency_records($1, 1) AS purged`,
      [tenantA],
    );
    expect(purged.rows).toEqual([{ purged: 1 }]);
    await becomeAdmin();
    const remaining = await db.query<{ scope: string }>(
      `SELECT scope FROM zuocheng.idempotency_record
        WHERE tenant_id = $1 AND scope LIKE 'cleanup.%' ORDER BY scope`,
      [tenantA],
    );
    expect(remaining.rows).toEqual([{ scope: 'cleanup.active' }]);

    await becomeApp();
    await expectTenantSqlState(
      tenantA,
      () => db.query('SELECT zuocheng.purge_expired_idempotency_records($1, 100)', [tenantA]),
      '42501',
    );
  });

  it('separates app privilege denial from the owner append-only trigger', async () => {
    await beginTenant(tenantA);
    await expectSqlState(
      db.query('UPDATE zuocheng.project_version SET snapshot = \'{}\' WHERE tenant_id = $1', [
        tenantA,
      ]),
      '42501',
    );
    await db.exec('ROLLBACK');

    await expectTenantSqlState(
      tenantA,
      () => db.query('SELECT zuocheng.append_project_version($1, $2, $3)', [tenantA, projectA, userA]),
      '42501',
    );
    await expectTenantSqlState(
      tenantA,
      () =>
        db.query(
          `INSERT INTO zuocheng.project_version
             (tenant_id, project_id, version, snapshot, created_by_user_id)
           VALUES ($1, $2, 99, '{}', $3)`,
          [tenantA, projectA, userA],
        ),
      '42501',
    );
    await expectTenantSqlState(
      tenantA,
      () =>
        db.query(
          `SELECT zuocheng.append_audit_event(
             $1, $2, 'forged', 'project', $3, NULL, '{}'::jsonb
           )`,
          [tenantA, userA, projectA],
        ),
      '42501',
    );
    await expectTenantSqlState(
      tenantA,
      () =>
        db.query(
          `INSERT INTO zuocheng.audit_event
             (tenant_id, actor_user_id, event_type, subject_type, subject_id)
           VALUES ($1, $2, 'forged', 'project', $3)`,
          [tenantA, userA, projectA],
        ),
      '42501',
    );

    await becomeAdmin();
    await db.exec('SET ROLE zuocheng_owner');
    await beginTenant(tenantA);
    await expectSqlState(
      db.query('UPDATE zuocheng.project_version SET snapshot = \'{}\' WHERE tenant_id = $1', [
        tenantA,
      ]),
      '55000',
    );
    await db.exec('ROLLBACK');
    await becomeApp();
  });

  it('rejects direct project lifecycle and purge-state updates', async () => {
    await expectTenantSqlState(
      tenantA,
      () =>
        db.query(
          `INSERT INTO zuocheng.project
             (tenant_id, created_by_user_id, updated_by_user_id, name)
           VALUES ($1, $2, $2, 'attacker')`,
          [tenantA, userA],
        ),
      '42501',
    );
    await expectTenantSqlState(
      tenantA,
      () => db.query('UPDATE zuocheng.project SET name = \'attacker\' WHERE id = $1', [copiedProject]),
      '42501',
    );
    await expectTenantSqlState(
      tenantA,
      () =>
        db.query(
          `UPDATE zuocheng.project
              SET deletion_status = 'purge_pending', deleted_at = now()
            WHERE id = $1`,
          [copiedProject],
        ),
      '42501',
    );

    await becomeAdmin();
    await db.exec('SET ROLE zuocheng_owner');
    await beginTenant(tenantA);
    await expectSqlState(
      db.query('UPDATE zuocheng.project SET name = \'owner bypass\' WHERE id = $1', [copiedProject]),
      '42501',
    );
    await db.exec('ROLLBACK');
    await becomeApp();
  });

  it('creates and copies projects only through tenant-bound UUIDv7 routines', async () => {
    await beginTenant(tenantA);
    try {
      const created = await db.query<{ project_id: string }>(
        `SELECT zuocheng.create_project($1, 'Created safely', 'body')::text AS project_id`,
        [userA],
      );
      const copied = await db.query<{ project_id: string }>(
        `SELECT zuocheng.copy_project($1, $2, 1, 'Copied safely')::text AS project_id`,
        [projectA, userA],
      );
      for (const id of [created.rows[0]!.project_id, copied.rows[0]!.project_id]) {
        expect(id[14]).toBe('7');
        expect(id[19]).toMatch(/[89ab]/);
      }
      const ownerAcls = await db.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM zuocheng.project_acl
          WHERE tenant_id = $1 AND principal_user_id = $2 AND access_level = 'owner'
            AND project_id IN ($3, $4)`,
        [tenantA, userA, created.rows[0]!.project_id, copied.rows[0]!.project_id],
      );
      expect(ownerAcls.rows).toEqual([{ count: 2 }]);
      const copyState = await db.query<{
        copied_from_project_id: string;
        version: number;
        snapshots: number;
      }>(
        `SELECT project.copied_from_project_id::text, project.version,
                count(snapshot.version)::integer AS snapshots
           FROM zuocheng.project AS project
           LEFT JOIN zuocheng.project_version AS snapshot
             ON snapshot.tenant_id = project.tenant_id AND snapshot.project_id = project.id
          WHERE project.tenant_id = $1 AND project.id = $2
          GROUP BY project.tenant_id, project.id`,
        [tenantA, copied.rows[0]!.project_id],
      );
      expect(copyState.rows).toEqual([
        { copied_from_project_id: projectA, version: 1, snapshots: 1 },
      ]);
    } finally {
      await db.exec('ROLLBACK');
    }

    await expectTenantSqlState(
      tenantA,
      () => db.query(`SELECT zuocheng.copy_project($1, $2, 999, 'stale')`, [projectA, userA]),
      '40001',
    );
  });

  it('runs legal project lifecycle mutations through versioned procedures', async () => {
    await inTenantTransaction(tenantA, async () => {
      await db.query(
        'CALL zuocheng.update_project_content($1, $2, 1, $3, $4, $5)',
        [tenantA, copiedProject, userA, 'Updated copy', 'safe content'],
      );
    });
    await expectTenantSqlState(
      tenantA,
      () =>
        db.query('CALL zuocheng.update_project_content($1, $2, 1, $3, $4, $5)', [
          tenantA,
          copiedProject,
          userA,
          'stale',
          null,
        ]),
      '40001',
    );
    await inTenantTransaction(tenantA, async () => {
      await db.query('CALL zuocheng.archive_project($1, $2, 2, $3)', [
        tenantA,
        copiedProject,
        userA,
      ]);
      await db.query('CALL zuocheng.soft_delete_project($1, $2, 3, $3)', [
        tenantA,
        copiedProject,
        userA,
      ]);
      await db.query('CALL zuocheng.restore_project($1, $2, 4, $3)', [
        tenantA,
        copiedProject,
        userA,
      ]);
      const state = await db.query<{
        name: string;
        status: string;
        deletion_status: string;
        version: number;
        updated_by_user_id: string;
      }>(
        `SELECT name, status, deletion_status, version, updated_by_user_id::text
           FROM zuocheng.project WHERE tenant_id = $1 AND id = $2`,
        [tenantA, copiedProject],
      );
      expect(state.rows).toEqual([
        {
          name: 'Updated copy',
          status: 'archived',
          deletion_status: 'active',
          version: 5,
          updated_by_user_id: userA,
        },
      ]);
      const history = await db.query<{ snapshots: number; audits: number }>(
        `SELECT
           (SELECT count(*)::integer FROM zuocheng.project_version
             WHERE tenant_id = $1 AND project_id = $2) AS snapshots,
           (SELECT count(*)::integer FROM zuocheng.audit_event
             WHERE tenant_id = $1 AND subject_id = $2) AS audits`,
        [tenantA, copiedProject],
      );
      expect(history.rows).toEqual([{ snapshots: 5, audits: 5 }]);
    });
  });

  it('restores prior state on cancellation and rejects illegal transitions', async () => {
    await expectTenantSqlState(
      tenantA,
      () =>
        db.query('SELECT zuocheng.request_project_deletion($1, $2, 5, $3, now(), NULL)', [
          tenantA,
          copiedProject,
          userA,
        ]),
      '23514',
    );

    await beginTenant(tenantA);
    await db.query('CALL zuocheng.soft_delete_project($1, $2, 1, $3)', [
      tenantA,
      projectA,
      userA,
    ]);
    const requested = await db.query<{ request_id: string }>(
      `SELECT zuocheng.request_project_deletion($1, $2, 2, $3, now(), 'cancel me')::text
         AS request_id`,
      [tenantA, projectA, userA],
    );
    cancelledRequest = requested.rows[0]!.request_id;
    await db.exec('COMMIT');

    await beginTenant(tenantA);
    const pending = await db.query<{ deletion_status: string; prior_deletion_status: string }>(
      `SELECT project.deletion_status, request.prior_deletion_status
       FROM zuocheng.project AS project
       JOIN zuocheng.deletion_request AS request
         ON request.tenant_id = project.tenant_id AND request.project_id = project.id
       WHERE project.tenant_id = $1 AND request.id = $2`,
      [tenantA, cancelledRequest],
    );
    expect(pending.rows).toEqual([
      { deletion_status: 'purge_pending', prior_deletion_status: 'soft_deleted' },
    ]);
    await db.query('CALL zuocheng.cancel_project_deletion($1, $2, 1, $3)', [
      tenantA,
      cancelledRequest,
      userA,
    ]);
    const restored = await db.query<{ deletion_status: string; deleted: boolean }>(
      `SELECT deletion_status, deleted_at IS NOT NULL AS deleted
       FROM zuocheng.project WHERE tenant_id = $1 AND id = $2`,
      [tenantA, projectA],
    );
    expect(restored.rows).toEqual([{ deletion_status: 'soft_deleted', deleted: true }]);
    await db.exec('COMMIT');

    await becomeAdmin();
    await db.exec('SET ROLE zuocheng_purge');
    await beginTenant(tenantA);
    await expectSqlState(
      db.query(
        `UPDATE zuocheng.deletion_request
            SET status = 'processing'
          WHERE tenant_id = $1 AND id = $2`,
        [tenantA, cancelledRequest],
      ),
      '42501',
    );
    await db.exec('ROLLBACK');

    await beginTenant(tenantA);
    await expectSqlState(
      db.query('CALL zuocheng.transition_project_deletion($1, $2, 2, \'processing\')', [
        tenantA,
        cancelledRequest,
      ]),
      '23514',
    );
    await db.exec('ROLLBACK');
    await becomeApp();
  });

  it('denies app purge and lets the purge role leave only scrubbed tombstones', async () => {
    await expectTenantSqlState(
      tenantA,
      () =>
        db.query(
          `INSERT INTO zuocheng.deletion_request
             (tenant_id, requested_by_user_id, subject_type, subject_id, subject_hash,
              project_id, status, scheduled_for)
           VALUES ($1, $2, 'project', $3, repeat('d', 64), $3, 'pending', now())`,
          [tenantA, userA, projectA],
        ),
      '42501',
    );

    await beginTenant(tenantA);
    const requested = await db.query<{ request_id: string }>(
      `SELECT zuocheng.request_project_deletion($1, $2, 4, $3, now(), 'private')::text
         AS request_id`,
      [tenantA, projectA, userA],
    );
    purgeRequest = requested.rows[0]!.request_id;
    await db.exec('COMMIT');

    await expectTenantSqlState(
      tenantA,
      () =>
        db.query('CALL zuocheng.transition_project_deletion($1, $2, 1, \'processing\')', [
          tenantA,
          purgeRequest,
        ]),
      '42501',
    );

    await becomeAdmin();
    await db.exec('SET ROLE zuocheng_purge');
    await beginTenant(tenantA);
    await db.query('CALL zuocheng.transition_project_deletion($1, $2, 1, \'processing\')', [
      tenantA,
      purgeRequest,
    ]);
    await db.exec('COMMIT');

    await becomeApp();
    await expectTenantSqlState(
      tenantA,
      () => db.query('CALL zuocheng.purge_project($1, $2, 2)', [tenantA, purgeRequest]),
      '42501',
    );

    await becomeAdmin();
    await db.exec('SET ROLE zuocheng_purge');
    await db.query('CALL zuocheng.purge_project($1, $2, 2)', [tenantA, purgeRequest]);
    await becomeAdmin();

    const tombstone = await db.query<{
      name: string;
      description: string | null;
      created_by_user_id: string | null;
      updated_by_user_id: string | null;
      deletion_status: string;
    }>(`SELECT name, description, created_by_user_id::text, updated_by_user_id::text, deletion_status
        FROM zuocheng.project WHERE tenant_id = $1 AND id = $2`, [tenantA, projectA]);
    expect(tombstone.rows).toEqual([
      {
        name: '[purged]',
        description: null,
        created_by_user_id: null,
        updated_by_user_id: null,
        deletion_status: 'purged',
      },
    ]);

    const removed = await db.query<{
      versions: number;
      acls: number;
      idempotency: number;
    }>(`SELECT
      (SELECT count(*)::integer FROM zuocheng.project_version WHERE tenant_id = $1 AND project_id = $2) AS versions,
      (SELECT count(*)::integer FROM zuocheng.project_acl WHERE tenant_id = $1 AND project_id = $2) AS acls,
      (SELECT count(*)::integer FROM zuocheng.idempotency_record WHERE tenant_id = $1 AND project_id = $2) AS idempotency`, [tenantA, projectA]);
    expect(removed.rows).toEqual([{ versions: 0, acls: 0, idempotency: 0 }]);

    const copied = await db.query<{ copied_from_project_id: string | null }>(
      'SELECT copied_from_project_id::text FROM zuocheng.project WHERE tenant_id = $1 AND id = $2',
      [tenantA, copiedProject],
    );
    expect(copied.rows).toEqual([{ copied_from_project_id: null }]);

    const sourceReferences = await db.query<{
      snapshots: number;
      audits: number;
      responses: number;
    }>(`SELECT
      (SELECT count(*)::integer FROM zuocheng.project_version
        WHERE tenant_id = $1 AND lower(snapshot::text) LIKE '%' || $2::text || '%') AS snapshots,
      (SELECT count(*)::integer FROM zuocheng.audit_event
        WHERE tenant_id = $1 AND lower(payload::text) LIKE '%' || $2::text || '%') AS audits,
      (SELECT count(*)::integer FROM zuocheng.idempotency_record
        WHERE tenant_id = $1 AND lower(response_body::text) LIKE '%' || $2::text || '%') AS responses`,
    [tenantA, projectA]);
    expect(sourceReferences.rows).toEqual([{ snapshots: 0, audits: 0, responses: 0 }]);

    const scrubbedCopyMetadata = await db.query<{
      source_purged_snapshots: number;
      source_purged_audits: number;
      response_body: Record<string, unknown>;
    }>(`SELECT
      (SELECT count(*)::integer FROM zuocheng.project_version
        WHERE tenant_id = $1 AND project_id = $2
          AND snapshot = '{"sourcePurged":true}'::jsonb) AS source_purged_snapshots,
      (SELECT count(*)::integer FROM zuocheng.audit_event
        WHERE tenant_id = $1 AND subject_id = $2
          AND payload = '{"sourcePurged":true}'::jsonb) AS source_purged_audits,
      (SELECT response_body FROM zuocheng.idempotency_record
        WHERE tenant_id = $1 AND project_id = $2
          AND scope = 'project.copy.result') AS response_body`, [tenantA, copiedProject]);
    expect(scrubbedCopyMetadata.rows).toEqual([
      {
        source_purged_snapshots: 5,
        source_purged_audits: 1,
        response_body: { kind: 'purged_reference' },
      },
    ]);

    const request = await db.query<{
      status: string;
      subject_id: string | null;
      project_id: string | null;
      requested_by_user_id: string | null;
      reason: string | null;
      subject_hash: string;
    }>(`SELECT status, subject_id::text, project_id::text, requested_by_user_id::text,
              reason, subject_hash
       FROM zuocheng.deletion_request WHERE tenant_id = $1 AND id = $2`, [tenantA, purgeRequest]);
    expect(request.rows).toEqual([
      {
        status: 'completed',
        subject_id: null,
        project_id: null,
        requested_by_user_id: null,
        reason: null,
        subject_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);

    const audit = await db.query<{ subject_id: string | null; payload: Record<string, unknown> }>(
      `SELECT subject_id::text, payload FROM zuocheng.audit_event
       WHERE tenant_id = $1 AND event_type = 'project.created'`,
      [tenantA],
    );
    expect(audit.rows).toEqual([{ subject_id: null, payload: { purged: true } }]);

    await becomeApp();
    await beginTenant(tenantA);
    const appVisible = await db.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM zuocheng.project WHERE id = $1',
      [projectA],
    );
    expect(appVisible.rows).toEqual([{ count: 0 }]);
    await db.exec('COMMIT');
  });

  it('denies direct updates against a purged project tombstone', async () => {
    await expectTenantSqlState(
      tenantA,
      () => db.query('UPDATE zuocheng.project SET name = \'rebuilt\' WHERE id = $1', [projectA]),
      '42501',
    );
  });

  it('rejects rebuilding every purged-project relation and copy reference', async () => {
    const attacks = [
      () =>
        db.query(
          `INSERT INTO zuocheng.project_version
             (tenant_id, project_id, version, snapshot, created_by_user_id)
           VALUES ($1, $2, 2, '{"rebuilt":true}', $3)`,
          [tenantA, projectA, userA],
        ),
      () =>
        db.query(
          `INSERT INTO zuocheng.project_acl
             (tenant_id, project_id, principal_user_id, access_level)
           VALUES ($1, $2, $3, 'owner')`,
          [tenantA, projectA, userA],
        ),
      () =>
        db.query(
          `INSERT INTO zuocheng.idempotency_record
             (tenant_id, principal_user_id, project_id, scope, idempotency_key_hash,
              request_hash, response_body, expires_at)
           VALUES ($1, $3, $2, 'project.rebuild', repeat('e', 64), repeat('f', 64),
             '{"rebuilt":true}', now() + interval '1 day')`,
          [tenantA, projectA, userA],
        ),
      () =>
        db.query(
          `INSERT INTO zuocheng.project
             (tenant_id, created_by_user_id, updated_by_user_id, name, copied_from_project_id)
           VALUES ($1, $2, $2, 'Rebuilt copy', $3)`,
          [tenantA, userA, projectA],
        ),
      () =>
        db.query('SELECT zuocheng.copy_project($1, $2, 6, \'Rebuilt copy\')', [
          projectA,
          userA,
        ]),
    ];
    const observedCodes: string[] = [];

    for (const attack of attacks) {
      await beginTenant(tenantA);
      try {
        await attack();
        observedCodes.push('none');
      } catch (error) {
        observedCodes.push((error as PgError).code ?? 'unknown');
      } finally {
        await db.exec('ROLLBACK');
      }
    }

    expect(observedCodes).toEqual(['42501', '42501', '42501', '42501', '23514']);
  });

  it('runs through a non-super runtime login and clears its transaction-local tenant GUC', async () => {
    await becomeRuntime();
    const identity = await db.query<{ current_role: string; session_role: string }>(
      'SELECT current_user AS current_role, session_user AS session_role',
    );
    expect(identity.rows).toEqual([
      { current_role: 'zuocheng_app', session_role: 'zuocheng_runtime_a' },
    ]);

    await beginTenant(tenantA);
    const visible = await db.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM zuocheng.project',
    );
    expect(visible.rows).toEqual([{ count: 1 }]);
    await db.exec('COMMIT');

    await beginTenant(tenantB);
    const victimVisible = await db.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM zuocheng.project',
    );
    expect(victimVisible.rows).toEqual([{ count: 0 }]);
    await db.exec('COMMIT');
    await expectTenantSqlState(
      tenantB,
      () =>
        db.query(
          `INSERT INTO zuocheng.idempotency_record
             (tenant_id, principal_user_id, project_id, scope, idempotency_key_hash,
              request_hash, expires_at)
           VALUES ($1, $3, $2, 'victim', repeat('1', 64), repeat('2', 64),
             now() + interval '1 day')`,
          [tenantB, projectB, userA],
        ),
      '42501',
    );
    await expectSqlState(db.query('SELECT * FROM zuocheng.runtime_principal'), '42501');
    await expectSqlState(
      db.query(`UPDATE zuocheng.runtime_principal SET tenant_id = $1`, [tenantB]),
      '42501',
    );

    const context = await db.query<{ tenant_id: string | null }>(
      "SELECT NULLIF(current_setting('zuocheng.current_tenant_id', true), '') AS tenant_id",
    );
    expect(context.rows).toEqual([{ tenant_id: null }]);

    const tenantBDb = new PGlite();
    try {
      await tenantBDb.exec(migration);
      await tenantBDb.query(
        `INSERT INTO zuocheng.tenant (id, slug, display_name)
         VALUES ($1, 'runtime-a', 'Runtime A'), ($2, 'runtime-b', 'Runtime B')`,
        [tenantA, tenantB],
      );
      await tenantBDb.query(
        `INSERT INTO zuocheng."user" (id, email, display_name)
         VALUES ($1, 'runtime-a@example.test', 'Runtime A'),
                ($2, 'runtime-b@example.test', 'Runtime B')`,
        [userA, userB],
      );
      await tenantBDb.query(
        `INSERT INTO zuocheng.membership (tenant_id, user_id, role)
         VALUES ($1, $3, 'owner'), ($2, $4, 'viewer'), ($2, $3, 'member')`,
        [tenantA, tenantB, userA, userB],
      );
      const auxiliaryIds = await tenantBDb.query<{
        hidden_project: string;
        visible_deletion_project: string;
        hidden_deletion_project: string;
        self_deletion_project: string;
      }>(`SELECT
        zuocheng.uuid_v7()::text AS hidden_project,
        zuocheng.uuid_v7()::text AS visible_deletion_project,
        zuocheng.uuid_v7()::text AS hidden_deletion_project,
        zuocheng.uuid_v7()::text AS self_deletion_project`);
      const {
        hidden_project: hiddenProject,
        visible_deletion_project: visibleDeletionProject,
        hidden_deletion_project: hiddenDeletionProject,
        self_deletion_project: selfDeletionProject,
      } = auxiliaryIds.rows[0]!;
      await tenantBDb.query(
        `INSERT INTO zuocheng.project
           (tenant_id, id, created_by_user_id, updated_by_user_id, name,
            deletion_status, deleted_at)
         VALUES ($1, $3, $5, $5, 'Runtime A project', 'active', NULL),
                ($2, $4, $6, $6, 'Runtime B project', 'active', NULL),
                ($2, $7, $6, $6, 'Hidden same-tenant project', 'active', NULL),
                ($2, $8, $6, $6, 'Visible deletion project', 'soft_deleted', now()),
                ($2, $9, $6, $6, 'Hidden deletion project', 'soft_deleted', now()),
                ($2, $10, $6, $6, 'Self deletion project', 'soft_deleted', now())`,
        [
          tenantA,
          tenantB,
          projectA,
          projectB,
          userA,
          userB,
          hiddenProject,
          visibleDeletionProject,
          hiddenDeletionProject,
          selfDeletionProject,
        ],
      );
      await tenantBDb.query("SELECT set_config('zuocheng.current_tenant_id', $1, false)", [tenantB]);
      await tenantBDb.query(
        `INSERT INTO zuocheng.project_acl
           (tenant_id, project_id, principal_user_id, access_level)
         VALUES ($1, $2, $4, 'viewer'), ($1, $3, $4, 'viewer')`,
        [tenantB, projectB, visibleDeletionProject, userB],
      );
      await tenantBDb.query(
        `INSERT INTO zuocheng.idempotency_record
           (tenant_id, principal_user_id, project_id, scope, idempotency_key_hash, request_hash,
            response_status, response_body, expires_at)
         VALUES ($1, $4, $2, 'visible.response', repeat('a', 64), repeat('b', 64), 200,
                   '{"secret":"visible"}'::jsonb, now() + interval '1 day'),
                ($1, $4, $3, 'hidden.response', repeat('c', 64), repeat('d', 64), 200,
                   '{"secret":"hidden"}'::jsonb, now() + interval '1 day')`,
        [tenantB, projectB, hiddenProject, userB],
      );
      await tenantBDb.query(
        `INSERT INTO zuocheng.idempotency_record
           (tenant_id, principal_user_id, scope, idempotency_key_hash, request_hash, expires_at)
         VALUES ($1, $2, 'shared.claim', repeat('1', 64), repeat('2', 64),
                   now() + interval '1 day'),
                ($1, $3, 'shared.claim', repeat('1', 64), repeat('2', 64),
                   now() + interval '1 day')`,
        [tenantB, userB, userA],
      );
      await tenantBDb.query(
        `INSERT INTO zuocheng.audit_event
           (tenant_id, actor_user_id, event_type, subject_type, subject_id, payload)
         VALUES ($1, $4, 'visible.audit', 'project', $3, '{"secret":"visible"}'),
                ($1, $4, 'hidden.audit', 'project', $5, '{"secret":"hidden"}'),
                ($1, $2, 'self.audit', 'project', $5, '{"secret":"self"}')`,
        [tenantB, userB, projectB, userA, hiddenProject],
      );
      await tenantBDb.query(
        `INSERT INTO zuocheng.deletion_request
           (tenant_id, requested_by_user_id, subject_type, subject_id, subject_hash,
            project_id, status, scheduled_for)
         VALUES ($1, $5, 'project', $3, repeat('e', 64), $3, 'pending', now()),
                ($1, $5, 'project', $4, repeat('f', 64), $4, 'pending', now()),
                ($1, $2, 'project', $6, repeat('0', 64), $6, 'pending', now())`,
        [
          tenantB,
          userB,
          visibleDeletionProject,
          hiddenDeletionProject,
          userA,
          selfDeletionProject,
        ],
      );
      await tenantBDb.exec('RESET zuocheng.current_tenant_id');
      await tenantBDb.exec(
        `CREATE ROLE zuocheng_runtime_b LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
         GRANT zuocheng_app TO zuocheng_runtime_b WITH SET TRUE, INHERIT FALSE;`,
      );
      await tenantBDb.query(
        `INSERT INTO zuocheng.runtime_principal (login_role, tenant_id, user_id)
         VALUES ('zuocheng_runtime_b', $1, $2)`,
        [tenantB, userB],
      );
      await tenantBDb.exec('SET SESSION AUTHORIZATION zuocheng_runtime_b');
      await tenantBDb.exec('SET ROLE zuocheng_app');
      await tenantBDb.exec('BEGIN');
      await tenantBDb.query("SELECT set_config('zuocheng.current_tenant_id', $1, true)", [tenantB]);
      const tenantBOwn = await tenantBDb.query<{ id: string; name: string }>(
        'SELECT id::text, name FROM zuocheng.project ORDER BY name',
      );
      expect(tenantBOwn.rows).toEqual([
        { id: projectB, name: 'Runtime B project' },
        { id: visibleDeletionProject, name: 'Visible deletion project' },
      ]);
      const visibleIdempotency = await tenantBDb.query<{
        scope: string;
        response_body: Record<string, unknown>;
      }>(
        `SELECT scope, response_body FROM zuocheng.idempotency_record
          WHERE response_body IS NOT NULL ORDER BY scope`,
      );
      expect(visibleIdempotency.rows).toEqual([
        { scope: 'visible.response', response_body: { secret: 'visible' } },
      ]);
      const projectlessClaims = await tenantBDb.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM zuocheng.idempotency_record
          WHERE scope = 'shared.claim'`,
      );
      expect(projectlessClaims.rows).toEqual([{ count: 1 }]);
      const visibleAudits = await tenantBDb.query<{ event_type: string }>(
        'SELECT event_type FROM zuocheng.audit_event ORDER BY event_type',
      );
      expect(visibleAudits.rows).toEqual([
        { event_type: 'self.audit' },
        { event_type: 'visible.audit' },
      ]);
      const visibleDeletionRequests = await tenantBDb.query<{ project_id: string }>(
        'SELECT project_id::text FROM zuocheng.deletion_request ORDER BY project_id',
      );
      expect(visibleDeletionRequests.rows.map((row) => row.project_id).sort()).toEqual(
        [selfDeletionProject, visibleDeletionProject].sort(),
      );
      const viewerCopy = await tenantBDb.query<{ id: string }>(
        `SELECT zuocheng.copy_project($1, $2, 1, 'Viewer copy')::text AS id`,
        [projectB, userB],
      );
      expect(viewerCopy.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
      await tenantBDb.exec('ROLLBACK');

      await tenantBDb.exec('BEGIN');
      await tenantBDb.query("SELECT set_config('zuocheng.current_tenant_id', $1, true)", [tenantB]);
      await expectSqlState(
        tenantBDb.query(
          `INSERT INTO zuocheng.idempotency_record
             (tenant_id, principal_user_id, project_id, scope, idempotency_key_hash,
              request_hash, response_status, response_body, expires_at)
           VALUES ($1, $2, $3, 'forged.hidden', repeat('3', 64), repeat('4', 64), 200,
             '{"secret":"forged"}'::jsonb, now() + interval '1 day')`,
          [tenantB, userB, hiddenProject],
        ),
        '42501',
      );
      await tenantBDb.exec('ROLLBACK');

      await tenantBDb.exec('BEGIN');
      await tenantBDb.query("SELECT set_config('zuocheng.current_tenant_id', $1, true)", [tenantB]);
      await expectSqlState(
        tenantBDb.query(
          `INSERT INTO zuocheng.idempotency_record
             (tenant_id, principal_user_id, scope, idempotency_key_hash, request_hash, expires_at)
           VALUES ($1, $2, 'foreign.principal', repeat('5', 64), repeat('6', 64),
             now() + interval '1 day')`,
          [tenantB, userA],
        ),
        '42501',
      );
      await tenantBDb.exec('ROLLBACK');

      await tenantBDb.exec('BEGIN');
      await tenantBDb.query("SELECT set_config('zuocheng.current_tenant_id', $1, true)", [tenantB]);
      await expectSqlState(
        tenantBDb.query(
          `UPDATE zuocheng.idempotency_record
              SET response_body = '{"secret":"tampered"}'::jsonb
            WHERE scope = 'visible.response'`,
        ),
        '42501',
      );
      await tenantBDb.exec('ROLLBACK');

      await tenantBDb.exec('BEGIN');
      await tenantBDb.query("SELECT set_config('zuocheng.current_tenant_id', $1, true)", [tenantB]);
      await expectSqlState(
        tenantBDb.query(
          `CALL zuocheng.update_project_content($1, $2, 1, $3, 'forbidden', NULL)`,
          [tenantB, projectB, userB],
        ),
        '42501',
      );
      await tenantBDb.exec('ROLLBACK');

      await tenantBDb.exec('BEGIN');
      await tenantBDb.query("SELECT set_config('zuocheng.current_tenant_id', $1, true)", [tenantB]);
      await expectSqlState(
        tenantBDb.query('CALL zuocheng.soft_delete_project($1, $2, 1, $3)', [
          tenantB,
          projectB,
          userB,
        ]),
        '42501',
      );
      await tenantBDb.exec('ROLLBACK');

      await tenantBDb.exec('BEGIN');
      await tenantBDb.query("SELECT set_config('zuocheng.current_tenant_id', $1, true)", [tenantA]);
      const tenantBVictim = await tenantBDb.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM zuocheng.project',
      );
      expect(tenantBVictim.rows).toEqual([{ count: 0 }]);
      await tenantBDb.exec('COMMIT');
    } finally {
      await tenantBDb.close();
    }
  });
});

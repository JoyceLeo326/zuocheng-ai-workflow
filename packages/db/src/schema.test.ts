import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  auditEvent,
  deletionRequest,
  idempotencyRecord,
  membership,
  project,
  projectAcl,
  PROJECT_DELETION_STATUS_BY_REQUEST_STATUS,
  projectVersion,
  runtimePrincipal,
  tenant,
  tenantScopedTables,
  user,
} from './schema.js';

const migration = readFileSync(
  fileURLToPath(new URL('../migrations/0000_foundation.sql', import.meta.url)),
  'utf8',
);
const nativePg17QaPath = fileURLToPath(new URL('../qa/postgres17.mjs', import.meta.url));
const nativePg17Qa = readFileSync(nativePg17QaPath, 'utf8');

const allTables = [
  tenant,
  user,
  membership,
  project,
  projectVersion,
  projectAcl,
  idempotencyRecord,
  auditEvent,
  deletionRequest,
] as const;

const uuidIdentifiedTables = allTables.filter((table) => getTableName(table) !== 'project_version');

describe('PostgreSQL domain schema', () => {
  it('defines every ZC-02 core table in the zuocheng schema', () => {
    expect(allTables.map(getTableName)).toEqual([
      'tenant',
      'user',
      'membership',
      'project',
      'project_version',
      'project_acl',
      'idempotency_record',
      'audit_event',
      'deletion_request',
    ]);

    for (const table of allTables) {
      expect(getTableConfig(table).schema).toBe('zuocheng');
    }
    expect(getTableName(runtimePrincipal)).toBe('runtime_principal');
    expect(runtimePrincipal.userId).toMatchObject({ notNull: true });
    expect(
      getTableConfig(runtimePrincipal).foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map((column) => column.name),
      ),
    ).toContainEqual(['tenant_id', 'user_id']);
  });

  it('uses database-generated UUIDv7 identifiers and optimistic versions', () => {
    for (const table of allTables) {
      expect(getTableConfig(table).enableRLS, `${getTableName(table)} Drizzle RLS metadata`).toBe(true);
    }

    for (const table of uuidIdentifiedTables) {
      const config = getTableConfig(table);
      const id = config.columns.find((column) => column.name === 'id');
      const version = config.columns.find((column) => column.name === 'version');

      expect(id, `${config.name}.id`).toMatchObject({
        dataType: 'string',
        notNull: true,
        hasDefault: true,
      });
      expect(id?.getSQLType()).toBe('uuid');
      expect(version, `${config.name}.version`).toMatchObject({
        notNull: true,
        hasDefault: true,
      });
    }

    expect(projectVersion.version).toMatchObject({ notNull: true });
  });

  it('adds non-null tenant context, composite primary keys, and soft deletion to tenant data', () => {
    expect(tenantScopedTables).toHaveLength(7);

    for (const table of tenantScopedTables) {
      const config = getTableConfig(table);
      const tenantId = config.columns.find((column) => column.name === 'tenant_id');
      const deletedAt = config.columns.find((column) => column.name === 'deleted_at');

      expect(tenantId, `${config.name}.tenant_id`).toMatchObject({ notNull: true });
      if (config.name !== 'project_version') {
        const compositePrimaryKey = config.primaryKeys.some((key) =>
          ['tenant_id', 'id'].every((name) => key.columns.some((column) => column.name === name)),
        );
        expect(deletedAt, `${config.name}.deleted_at`).toBeDefined();
        expect(compositePrimaryKey, `${config.name} composite primary key`).toBe(true);
      }
    }
  });

  it('models immutable project snapshots with tenant-qualified authorship', () => {
    const config = getTableConfig(projectVersion);
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      'tenant_id',
      'project_id',
      'version',
    ]);
    expect(projectVersion.snapshot).toMatchObject({ notNull: true });
    expect(projectVersion.createdByUserId).toMatchObject({ notNull: true });
    expect(
      config.foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map((column) => column.name),
      ),
    ).toEqual(
      expect.arrayContaining([
        ['tenant_id', 'project_id'],
        ['tenant_id', 'created_by_user_id'],
      ]),
    );
  });

  it('matches the project API contract and makes purge state transitions explicit', () => {
    expect(project.name.getSQLType()).toBe('varchar(160)');
    expect(project.name).toMatchObject({ notNull: true });
    expect(project.description).toMatchObject({ notNull: false });
    expect(project.copiedFromProjectId).toMatchObject({ notNull: false });
    expect(project.updatedByUserId).toMatchObject({ notNull: false });
    expect(project.archivedAt).toMatchObject({ notNull: false });
    expect(project).not.toHaveProperty('title');
    expect(project.deletionStatus).toMatchObject({ notNull: true, hasDefault: true });
    expect(PROJECT_DELETION_STATUS_BY_REQUEST_STATUS).toEqual({
      pending: 'purge_pending',
      processing: 'purge_pending',
      completed: 'purged',
      cancelled: 'restore_prior',
      rejected: 'restore_prior',
    });

    const foreignKeys = getTableConfig(project).foreignKeys.map((foreignKey) =>
      foreignKey.reference().columns.map((column) => column.name),
    );
    expect(foreignKeys).toContainEqual(['tenant_id', 'copied_from_project_id']);
    expect(foreignKeys).toContainEqual(['tenant_id', 'updated_by_user_id']);
    expect(migration).toMatch(
      /project_deletion_status_valid[\s\S]*IN \('active', 'soft_deleted', 'purge_pending', 'purged'\)/i,
    );
    expect(
      getTableConfig(project).checks.some(
        (constraint) => constraint.name === 'project_copied_from_not_self',
      ),
    ).toBe(true);
  });

  it('keeps every tenant-local relationship tenant-qualified', () => {
    const expectedCompositeForeignKeys: Record<string, string[][]> = {
      project: [['tenant_id', 'created_by_user_id']],
      project_version: [
        ['tenant_id', 'project_id'],
        ['tenant_id', 'created_by_user_id'],
      ],
      project_acl: [
        ['tenant_id', 'project_id'],
        ['tenant_id', 'principal_user_id'],
      ],
      audit_event: [['tenant_id', 'actor_user_id']],
      idempotency_record: [
        ['tenant_id', 'principal_user_id'],
        ['tenant_id', 'project_id'],
      ],
      deletion_request: [
        ['tenant_id', 'requested_by_user_id'],
        ['tenant_id', 'subject_user_id'],
        ['tenant_id', 'project_id'],
      ],
    };

    for (const [tableName, expectedKeys] of Object.entries(expectedCompositeForeignKeys)) {
      const table = tenantScopedTables.find((candidate) => getTableName(candidate) === tableName);
      expect(table, tableName).toBeDefined();
      const foreignKeys = getTableConfig(table!).foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map((column) => column.name),
      );

      for (const expectedKey of expectedKeys) {
        expect(foreignKeys, `${tableName}: ${expectedKey.join(',')}`).toContainEqual(expectedKey);
      }
    }
  });

  it('supports tenant-qualified user, project, and tenant deletion subjects', () => {
    const config = getTableConfig(deletionRequest);
    expect(config.columns.find((column) => column.name === 'subject_type')).toMatchObject({
      notNull: true,
    });
    expect(config.columns.find((column) => column.name === 'subject_id')).toMatchObject({
      notNull: false,
    });
    expect(config.columns.find((column) => column.name === 'project_id')).toBeDefined();
    expect(config.columns.find((column) => column.name === 'subject_hash')).toMatchObject({
      notNull: true,
    });
    expect(config.columns.find((column) => column.name === 'prior_deletion_status')).toBeDefined();
    expect(config.checks.some((constraint) => constraint.name === 'deletion_request_subject_valid')).toBe(
      true,
    );
  });

  it('declares uniqueness and checks for tenant-safe keys and valid states', () => {
    const membershipConfig = getTableConfig(membership);
    expect(
      membershipConfig.uniqueConstraints.map((constraint) =>
        constraint.columns.map((column) => column.name),
      ),
    ).toContainEqual(['tenant_id', 'user_id']);

    const aclConfig = getTableConfig(projectAcl);
    expect(
      aclConfig.uniqueConstraints.map((constraint) =>
        constraint.columns.map((column) => column.name),
      ),
    ).toContainEqual(['tenant_id', 'project_id', 'principal_user_id']);

    const idempotencyConfig = getTableConfig(idempotencyRecord);
    expect(
      idempotencyConfig.uniqueConstraints.map((constraint) =>
        constraint.columns.map((column) => column.name),
      ),
    ).toContainEqual(['tenant_id', 'principal_user_id', 'scope', 'idempotency_key_hash']);
    expect(idempotencyRecord.principalUserId.notNull).toBe(true);
    expect(idempotencyRecord.idempotencyKeyHash.getSQLType()).toBe('char(64)');
    expect(idempotencyRecord).not.toHaveProperty('idempotencyKey');
    expect(
      idempotencyConfig.checks.some(
        (constraint) => constraint.name === 'idempotency_record_completed_response_valid',
      ),
    ).toBe(true);

    const projectConfig = getTableConfig(project);
    expect(
      projectConfig.checks.some(
        (constraint) => constraint.name === 'project_creator_required_unless_purged',
      ),
    ).toBe(true);
    expect(
      projectConfig.checks.some(
        (constraint) => constraint.name === 'project_updater_required_unless_purged',
      ),
    ).toBe(true);

    for (const table of allTables) {
      const config = getTableConfig(table);
      expect(
        config.checks.some((constraint) => constraint.name === `${config.name}_version_positive`),
        `${config.name} positive version check`,
      ).toBe(true);
    }
  });
});

describe('production PostgreSQL migration', () => {
  it('creates a database-side RFC 9562 UUIDv7 generator', () => {
    expect(migration).not.toMatch(/CREATE EXTENSION IF NOT EXISTS pgcrypto/i);
    expect(migration).toMatch(/gen_random_uuid\(\)/i);
    expect(migration).not.toMatch(/gen_random_bytes\(/i);
    expect(migration).toMatch(/CREATE(?: OR REPLACE)? FUNCTION zuocheng\.uuid_v7\(\)/i);
    expect(migration).toMatch(/set_byte\(uuid_bytes,\s*6,[\s\S]*0x70/i);
    expect(migration).toMatch(/set_byte\(uuid_bytes,\s*8,[\s\S]*0x80/i);
    expect(migration.match(/DEFAULT zuocheng\.uuid_v7\(\)/gi)).toHaveLength(8);
  });

  it('enables and forces RLS on every core table with fail-closed tenant settings', () => {
    for (const table of allTables.map(getTableName)) {
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE zuocheng\\."?${table}"? ENABLE ROW LEVEL SECURITY`, 'i'),
      );
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE zuocheng\\."?${table}"? FORCE ROW LEVEL SECURITY`, 'i'),
      );
    }

    expect(migration).toContain("current_setting('zuocheng.current_tenant_id', true)");
    expect(migration).toMatch(/NULLIF\([\s\S]*current_tenant_id[\s\S]*''\)::uuid/i);
    expect(migration).toMatch(/visible_membership\.user_id\s*=\s*"user"\.id/i);
  });

  it('separates the non-bypass application role from table ownership', () => {
    expect(migration).toMatch(/CREATE ROLE zuocheng_app[\s\S]*NOBYPASSRLS/i);
    expect(migration).toMatch(/CREATE ROLE zuocheng_owner[\s\S]*NOLOGIN/i);
    expect(migration).toMatch(/CREATE ROLE zuocheng_purge[\s\S]*NOLOGIN[\s\S]*NOBYPASSRLS/i);
    expect(migration).not.toMatch(/ALTER TABLE[\s\S]*OWNER TO zuocheng_app/i);

    for (const table of allTables.map(getTableName)) {
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE zuocheng\\."?${table}"? OWNER TO zuocheng_owner`, 'i'),
      );
    }
  });

  it('exposes purge only through a guarded security-definer procedure', () => {
    expect(migration).toMatch(
      /CREATE PROCEDURE zuocheng\.purge_project\([\s\S]*SECURITY DEFINER/i,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON PROCEDURE zuocheng\.purge_project\([\s\S]*FROM PUBLIC/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON PROCEDURE zuocheng\.purge_project\([\s\S]*TO zuocheng_purge/i,
    );
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON PROCEDURE zuocheng\.purge_project\([^;]*\)\s*TO zuocheng_app\s*;/i,
    );
    expect(migration).toContain("set_config('zuocheng.purge_guard', 'project', true)");
    expect(migration).toMatch(
      /DELETE FROM zuocheng\.project_version[\s\S]*DELETE FROM zuocheng\.project_acl[\s\S]*DELETE FROM zuocheng\.idempotency_record/i,
    );
  });

  it('atomically restores prior soft-delete state and rejects direct request mutation', () => {
    expect(migration).toMatch(
      /CREATE PROCEDURE zuocheng\.transition_project_deletion\([\s\S]*SECURITY DEFINER/i,
    );
    expect(migration).toMatch(/prior_deletion_status text/i);
    expect(migration).toMatch(/cancelled[\s\S]*prior_deletion_status/i);
    expect(migration).toMatch(/current_deletion_status\s*<>\s*'soft_deleted'/i);
    expect(migration).toMatch(/CONSTRAINT project_creator_required_unless_purged[\s\S]*purged/i);
    expect(migration).not.toMatch(
      /GRANT SELECT, INSERT, UPDATE ON[^;]*zuocheng\.deletion_request[^;]*;/i,
    );
  });

  it('routes every mutable project lifecycle through guarded CAS procedures', () => {
    for (const [name, signature] of [
      ['update_project_content', 'uuid, uuid, integer, uuid, text, text'],
      ['archive_project', 'uuid, uuid, integer, uuid'],
      ['soft_delete_project', 'uuid, uuid, integer, uuid'],
      ['restore_project', 'uuid, uuid, integer, uuid'],
    ] as const) {
      expect(migration).toMatch(
        new RegExp(`CREATE PROCEDURE zuocheng\\.${name}\\([\\s\\S]*SECURITY DEFINER`, 'i'),
      );
      expect(migration).toMatch(
        new RegExp(
          `GRANT EXECUTE ON PROCEDURE zuocheng\\.${name}\\(${signature}\\)\\s*TO zuocheng_app`,
          'i',
        ),
      );
    }

    expect(migration).not.toMatch(/GRANT[^;]*UPDATE[^;]*zuocheng\.project(?:\s|,|;)/i);
    expect(migration).toMatch(/CREATE TRIGGER project_update_guard[\s\S]*BEFORE UPDATE ON zuocheng\.project/i);
    expect(migration).toMatch(/project_write_guard/i);
    expect(migration).toMatch(
      /CREATE FUNCTION zuocheng\.create_project\([\s\S]*RETURNS uuid[\s\S]*SECURITY DEFINER/i,
    );
    expect(migration).toMatch(
      /CREATE FUNCTION zuocheng\.copy_project\([\s\S]*RETURNS uuid[\s\S]*SECURITY DEFINER/i,
    );
    expect(migration).not.toMatch(/GRANT[^;]*INSERT[^;]*zuocheng\.project(?:\s|,|;)/i);
  });

  it('rejects rebuilding purged project relations and copy references', () => {
    expect(migration).toMatch(
      /CREATE TRIGGER project_version_parent_state_guard[\s\S]*BEFORE INSERT OR UPDATE ON zuocheng\.project_version/i,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER project_acl_parent_state_guard[\s\S]*BEFORE INSERT OR UPDATE ON zuocheng\.project_acl/i,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER idempotency_record_parent_state_guard[\s\S]*BEFORE INSERT OR UPDATE ON zuocheng\.idempotency_record/i,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER project_copy_source_guard[\s\S]*copied_from_project_id/i,
    );
  });

  it('binds app RLS to an owner-only session principal mapping', () => {
    expect(migration).toMatch(/CREATE TABLE zuocheng\.runtime_principal/i);
    expect(migration).toMatch(/session_user::text/i);
    expect(migration).toMatch(/current_session_tenant_id\(\)/i);
    expect(migration).toMatch(/current_session_user_id\(\)/i);
    expect(migration).toMatch(/require_app_context\(uuid, uuid\)/i);
    expect(migration).not.toMatch(/GRANT[^;]*(?:SELECT|INSERT|UPDATE|DELETE)[^;]*runtime_principal/i);
    expect(migration).toMatch(
      /project_current_tenant_policy[\s\S]*current_session_tenant_id\(\)/i,
    );
  });

  it('enforces actor-bound ACL authorization without direct membership administration', () => {
    expect(migration).toMatch(/project_current_tenant_policy[\s\S]*project_acl/i);
    expect(migration).toMatch(/require_project_access/i);
    expect(migration).toMatch(
      /lock_project_for_mutation[\s\S]*require_project_access\([\s\S]*'editor'/i,
    );
    expect(migration).toMatch(
      /lock_project_for_deletion[\s\S]*require_project_access\([\s\S]*'owner'/i,
    );
    expect(migration).toMatch(/access_level[\s\S]*'owner'/i);
    expect(migration).not.toMatch(
      /GRANT[^;]*(?:INSERT|UPDATE|DELETE)[^;]*zuocheng\.membership/i,
    );
    expect(migration).not.toMatch(
      /GRANT[^;]*(?:INSERT|UPDATE|DELETE)[^;]*zuocheng\.project_acl/i,
    );
    expect(migration).toMatch(
      /INSERT INTO zuocheng\.project_acl[\s\S]*access_level[\s\S]*'owner'/i,
    );
  });

  it('scopes auxiliary project records to the session principal and visible projects', () => {
    expect(migration).toMatch(
      /idempotency_record_current_principal_select_policy[\s\S]*current_session_user_id\(\)[\s\S]*project/i,
    );
    expect(migration).toMatch(
      /idempotency_record_current_principal_insert_policy[\s\S]*current_session_user_id\(\)[\s\S]*project/i,
    );
    expect(migration).not.toMatch(
      /GRANT[^;]*UPDATE[^;]*zuocheng\.idempotency_record/i,
    );
    expect(migration).not.toMatch(
      /GRANT[^;]*INSERT[^;]*zuocheng\.idempotency_record/i,
    );
    expect(migration).toMatch(
      /CREATE FUNCTION zuocheng\.claim_idempotency_record\([\s\S]*FOR UPDATE/i,
    );
    expect(migration).toMatch(
      /CREATE FUNCTION zuocheng\.complete_idempotency_record\([\s\S]*SECURITY DEFINER/i,
    );
    expect(migration).toMatch(
      /audit_event_project_visibility_policy[\s\S]*current_session_user_id\(\)[\s\S]*project/i,
    );
    expect(migration).toMatch(
      /deletion_request_project_visibility_policy[\s\S]*current_session_user_id\(\)[\s\S]*project/i,
    );
    expect(migration).toMatch(
      /CREATE FUNCTION zuocheng\.lock_project_for_mutation\([\s\S]*require_project_access[\s\S]*FOR UPDATE/i,
    );
    expect(migration).toMatch(
      /purge_expired_idempotency_records[\s\S]*FOR UPDATE SKIP LOCKED/i,
    );
  });

  it('scrubs every persisted source-project UUID reference during purge', () => {
    expect(migration).toMatch(/snapshot::text[\s\S]*request_row\.project_id::text/i);
    expect(migration).toMatch(/payload::text[\s\S]*request_row\.project_id::text/i);
    expect(migration).toMatch(/response_body::text[\s\S]*request_row\.project_id::text/i);
    expect(migration).toMatch(/sourceProjectId/i);
    expect(migration).toMatch(
      /NOT EXISTS \([\s\S]*project_version[\s\S]*snapshot::text[\s\S]*NOT EXISTS \([\s\S]*audit_event[\s\S]*payload::text[\s\S]*NOT EXISTS \([\s\S]*idempotency_record[\s\S]*response_body::text/i,
    );
  });

  it('keeps append helpers owner-only and exposes narrow request routines', () => {
    for (const table of ['project_version', 'audit_event', 'deletion_request']) {
      expect(migration).not.toMatch(
        new RegExp(`GRANT[^;]*INSERT[^;]*zuocheng\\.${table}(?:\\s|,|;)`, 'i'),
      );
    }
    expect(migration).not.toMatch(
      /GRANT EXECUTE ON (?:FUNCTION|PROCEDURE) zuocheng\.append_(?:project_version|audit_event)[^;]*TO zuocheng_app/i,
    );
    expect(migration).toMatch(
      /CREATE FUNCTION zuocheng\.request_project_deletion\([\s\S]*RETURNS uuid[\s\S]*SECURITY DEFINER/i,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON PROCEDURE zuocheng\.cancel_project_deletion\(uuid, uuid, integer, uuid\)[\s\S]*TO zuocheng_app/i,
    );
  });

  it('enforces append-only project snapshots and audit events', () => {
    expect(migration).toMatch(
      /CREATE(?: OR REPLACE)? FUNCTION zuocheng\.reject_append_only_mutation\(\)/i,
    );
    for (const table of ['project_version', 'audit_event']) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE TRIGGER ${table}_append_only[\\s\\S]*BEFORE UPDATE OR DELETE ON zuocheng\\.${table}[\\s\\S]*reject_append_only_mutation`,
          'i',
        ),
      );
      expect(migration).toMatch(
        new RegExp(`GRANT SELECT ON[^;]*zuocheng\\.${table}[^;]*TO zuocheng_app`, 'i'),
      );
      expect(migration).not.toMatch(
        new RegExp(`GRANT[^;]*(?:UPDATE|DELETE)[^;]*zuocheng\\.${table}`, 'i'),
      );
    }
  });

  it('persists only hashed idempotency keys and documents deletion state mapping', () => {
    expect(migration).toMatch(/idempotency_key_hash char\(64\) NOT NULL/i);
    expect(migration).not.toMatch(/\bidempotency_key\s+(?:varchar|text|char)/i);
    expect(migration).toMatch(/pending\/processing -> purge_pending; completed -> purged/i);
  });

  it('contains no SQLite compatibility path', () => {
    expect(migration).not.toMatch(/sqlite|d1_database/i);
  });

  it('keeps schema constraint names aligned and ships native PostgreSQL 17 QA', () => {
    expect(getTableConfig(idempotencyRecord).uniqueConstraints[0]?.name).toBe(
      'idempotency_record_tenant_principal_scope_key_hash_unique',
    );
    expect(migration).toContain('idempotency_record_tenant_principal_scope_key_hash_unique');
    expect(existsSync(nativePg17QaPath)).toBe(true);
    expect(nativePg17Qa).toMatch(/zuocheng-qa-device-a/);
    expect(nativePg17Qa).toMatch(/zuocheng-qa-device-b/);
    expect(nativePg17Qa).toMatch(/wait_event_type\s*=\s*'Lock'/);
    expect(nativePg17Qa).toMatch(/project_version[\s\S]*count\(\*\)/i);
    expect(nativePg17Qa).toMatch(/40001/);
  });
});

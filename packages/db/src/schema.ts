import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const zuochengSchema = pgSchema('zuocheng');

export const PROJECT_DELETION_STATUS_BY_REQUEST_STATUS = Object.freeze({
  pending: 'purge_pending',
  processing: 'purge_pending',
  completed: 'purged',
  cancelled: 'restore_prior',
  rejected: 'restore_prior',
} as const);

const uuidV7 = (name: string) =>
  uuid(name).notNull().default(sql`zuocheng.uuid_v7()`);

const optimisticVersion = () => integer('version').notNull().default(1);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const deletedAt = () => timestamp('deleted_at', { withTimezone: true });

export const tenant = zuochengSchema
  .table(
    'tenant',
    {
      id: uuidV7('id').primaryKey(),
      slug: varchar('slug', { length: 63 }).notNull(),
      displayName: varchar('display_name', { length: 200 }).notNull(),
      version: optimisticVersion(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
      deletedAt: deletedAt(),
    },
    (table) => [
      unique('tenant_slug_unique').on(table.slug),
      check(
        'tenant_slug_format',
        sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{0,62}$' AND ${table.slug} !~ '-$'`,
      ),
      check('tenant_display_name_nonempty', sql`btrim(${table.displayName}) <> ''`),
      check('tenant_version_positive', sql`${table.version} > 0`),
    ],
  )
  .enableRLS();

export const user = zuochengSchema
  .table(
    'user',
    {
      id: uuidV7('id').primaryKey(),
      email: varchar('email', { length: 320 }).notNull(),
      displayName: varchar('display_name', { length: 200 }).notNull(),
      version: optimisticVersion(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
      deletedAt: deletedAt(),
    },
    (table) => [
      unique('user_email_unique').on(table.email),
      check('user_email_normalized', sql`${table.email} = lower(btrim(${table.email}))`),
      check('user_email_shape', sql`${table.email} ~ '^[^[:space:]@]+@[^[:space:]@]+$'`),
      check('user_display_name_nonempty', sql`btrim(${table.displayName}) <> ''`),
      check('user_version_positive', sql`${table.version} > 0`),
    ],
  )
  .enableRLS();

export const membership = zuochengSchema
  .table(
    'membership',
    {
      tenantId: uuid('tenant_id')
        .notNull(),
      id: uuidV7('id'),
      userId: uuid('user_id').notNull(),
      role: text('role').notNull().default('member'),
      status: text('status').notNull().default('active'),
      version: optimisticVersion(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
      deletedAt: deletedAt(),
    },
    (table) => [
      primaryKey({
        name: 'membership_tenant_id_pk',
        columns: [table.tenantId, table.id],
      }),
      unique('membership_tenant_user_unique').on(table.tenantId, table.userId),
      foreignKey({
        name: 'membership_tenant_fk',
        columns: [table.tenantId],
        foreignColumns: [tenant.id],
      }).onDelete('restrict'),
      foreignKey({
        name: 'membership_user_fk',
        columns: [table.userId],
        foreignColumns: [user.id],
      }).onDelete('restrict'),
      check('membership_role_valid', sql`${table.role} IN ('owner', 'admin', 'member', 'viewer')`),
      check('membership_status_valid', sql`${table.status} IN ('invited', 'active', 'suspended')`),
      check('membership_version_positive', sql`${table.version} > 0`),
      index('membership_user_idx').on(table.userId),
    ],
  )
  .enableRLS();

export const runtimePrincipal = zuochengSchema.table(
  'runtime_principal',
  {
    loginRole: text('login_role').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: 'runtime_principal_tenant_fk',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'runtime_principal_membership_fk',
      columns: [table.tenantId, table.userId],
      foreignColumns: [membership.tenantId, membership.userId],
    }).onDelete('restrict'),
    check('runtime_principal_login_role_nonempty', sql`btrim(${table.loginRole}) <> ''`),
  ],
);

export const project = zuochengSchema
  .table(
    'project',
    {
      tenantId: uuid('tenant_id')
        .notNull(),
      id: uuidV7('id'),
      createdByUserId: uuid('created_by_user_id'),
      updatedByUserId: uuid('updated_by_user_id'),
      name: varchar('name', { length: 160 }).notNull(),
      description: text('description'),
      copiedFromProjectId: uuid('copied_from_project_id'),
      status: text('status').notNull().default('active'),
      deletionStatus: text('deletion_status').notNull().default('active'),
      version: optimisticVersion(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
      archivedAt: timestamp('archived_at', { withTimezone: true }),
      deletedAt: deletedAt(),
    },
    (table) => [
      primaryKey({ name: 'project_tenant_id_pk', columns: [table.tenantId, table.id] }),
      foreignKey({
        name: 'project_tenant_fk',
        columns: [table.tenantId],
        foreignColumns: [tenant.id],
      }).onDelete('restrict'),
      foreignKey({
        name: 'project_creator_membership_fk',
        columns: [table.tenantId, table.createdByUserId],
        foreignColumns: [membership.tenantId, membership.userId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'project_updater_membership_fk',
        columns: [table.tenantId, table.updatedByUserId],
        foreignColumns: [membership.tenantId, membership.userId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'project_copied_from_fk',
        columns: [table.tenantId, table.copiedFromProjectId],
        foreignColumns: [table.tenantId, table.id],
      }).onDelete('restrict'),
      check('project_name_nonempty', sql`btrim(${table.name}) <> ''`),
      check(
        'project_copied_from_not_self',
        sql`${table.copiedFromProjectId} IS NULL OR ${table.copiedFromProjectId} <> ${table.id}`,
      ),
      check('project_status_valid', sql`${table.status} IN ('active', 'archived')`),
      check(
        'project_deletion_status_valid',
        sql`${table.deletionStatus} IN ('active', 'soft_deleted', 'purge_pending', 'purged')`,
      ),
      check(
        'project_creator_required_unless_purged',
        sql`${table.createdByUserId} IS NOT NULL OR ${table.deletionStatus} = 'purged'`,
      ),
      check(
        'project_updater_required_unless_purged',
        sql`${table.updatedByUserId} IS NOT NULL OR ${table.deletionStatus} = 'purged'`,
      ),
      check(
        'project_deletion_state_valid',
        sql`(
          (${table.deletionStatus} = 'active' AND ${table.deletedAt} IS NULL)
          OR (${table.deletionStatus} IN ('soft_deleted', 'purge_pending', 'purged') AND ${table.deletedAt} IS NOT NULL)
        )`,
      ),
      check(
        'project_archive_state_valid',
        sql`(
          (${table.status} = 'active' AND ${table.archivedAt} IS NULL)
          OR (${table.status} = 'archived' AND ${table.archivedAt} IS NOT NULL)
        )`,
      ),
      check('project_version_positive', sql`${table.version} > 0`),
      index('project_tenant_updated_idx').on(table.tenantId, table.updatedAt),
    ],
  )
  .enableRLS();

export const projectVersion = zuochengSchema
  .table(
    'project_version',
    {
      tenantId: uuid('tenant_id')
        .notNull(),
      projectId: uuid('project_id').notNull(),
      version: integer('version').notNull(),
      snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
      createdByUserId: uuid('created_by_user_id').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      primaryKey({
        name: 'project_version_tenant_project_version_pk',
        columns: [table.tenantId, table.projectId, table.version],
      }),
      foreignKey({
        name: 'project_version_tenant_fk',
        columns: [table.tenantId],
        foreignColumns: [tenant.id],
      }).onDelete('restrict'),
      foreignKey({
        name: 'project_version_project_fk',
        columns: [table.tenantId, table.projectId],
        foreignColumns: [project.tenantId, project.id],
      }).onDelete('restrict'),
      foreignKey({
        name: 'project_version_creator_membership_fk',
        columns: [table.tenantId, table.createdByUserId],
        foreignColumns: [membership.tenantId, membership.userId],
      }).onDelete('restrict'),
      check('project_version_version_positive', sql`${table.version} > 0`),
      check('project_version_snapshot_object', sql`jsonb_typeof(${table.snapshot}) = 'object'`),
      index('project_version_creator_idx').on(table.tenantId, table.createdByUserId),
    ],
  )
  .enableRLS();

export const projectAcl = zuochengSchema
  .table(
    'project_acl',
    {
      tenantId: uuid('tenant_id')
        .notNull(),
      id: uuidV7('id'),
      projectId: uuid('project_id').notNull(),
      principalUserId: uuid('principal_user_id').notNull(),
      accessLevel: text('access_level').notNull(),
      version: optimisticVersion(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
      deletedAt: deletedAt(),
    },
    (table) => [
      primaryKey({ name: 'project_acl_tenant_id_pk', columns: [table.tenantId, table.id] }),
      foreignKey({
        name: 'project_acl_tenant_fk',
        columns: [table.tenantId],
        foreignColumns: [tenant.id],
      }).onDelete('restrict'),
      unique('project_acl_principal_unique').on(
        table.tenantId,
        table.projectId,
        table.principalUserId,
      ),
      foreignKey({
        name: 'project_acl_project_fk',
        columns: [table.tenantId, table.projectId],
        foreignColumns: [project.tenantId, project.id],
      }).onDelete('restrict'),
      foreignKey({
        name: 'project_acl_principal_membership_fk',
        columns: [table.tenantId, table.principalUserId],
        foreignColumns: [membership.tenantId, membership.userId],
      }).onDelete('restrict'),
      check('project_acl_access_level_valid', sql`${table.accessLevel} IN ('owner', 'editor', 'viewer')`),
      check('project_acl_version_positive', sql`${table.version} > 0`),
      index('project_acl_principal_idx').on(table.tenantId, table.principalUserId),
    ],
  )
  .enableRLS();

export const idempotencyRecord = zuochengSchema
  .table(
    'idempotency_record',
    {
      tenantId: uuid('tenant_id')
        .notNull(),
      id: uuidV7('id'),
      principalUserId: uuid('principal_user_id').notNull(),
      projectId: uuid('project_id'),
      scope: varchar('scope', { length: 120 }).notNull(),
      idempotencyKeyHash: char('idempotency_key_hash', { length: 64 }).notNull(),
      requestHash: char('request_hash', { length: 64 }).notNull(),
      responseStatus: integer('response_status'),
      responseBody: jsonb('response_body').$type<Record<string, unknown> | null>(),
      expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
      version: optimisticVersion(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
      deletedAt: deletedAt(),
    },
    (table) => [
      primaryKey({
        name: 'idempotency_record_tenant_id_pk',
        columns: [table.tenantId, table.id],
      }),
      unique('idempotency_record_tenant_principal_scope_key_hash_unique').on(
        table.tenantId,
        table.principalUserId,
        table.scope,
        table.idempotencyKeyHash,
      ),
      foreignKey({
        name: 'idempotency_record_tenant_fk',
        columns: [table.tenantId],
        foreignColumns: [tenant.id],
      }).onDelete('restrict'),
      foreignKey({
        name: 'idempotency_record_principal_membership_fk',
        columns: [table.tenantId, table.principalUserId],
        foreignColumns: [membership.tenantId, membership.userId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'idempotency_record_project_fk',
        columns: [table.tenantId, table.projectId],
        foreignColumns: [project.tenantId, project.id],
      }).onDelete('restrict'),
      check('idempotency_record_scope_nonempty', sql`btrim(${table.scope}) <> ''`),
      check(
        'idempotency_record_key_hash_valid',
        sql`${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'`,
      ),
      check('idempotency_record_hash_valid', sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
      check(
        'idempotency_record_response_status_valid',
        sql`${table.responseStatus} IS NULL OR ${table.responseStatus} BETWEEN 100 AND 599`,
      ),
      check(
        'idempotency_record_completed_response_valid',
        sql`(
          (${table.responseStatus} IS NULL AND ${table.responseBody} IS NULL)
          OR (
            ${table.responseStatus} IS NOT NULL
            AND ${table.responseBody} IS NOT NULL
            AND (
              ${table.projectId} IS NOT NULL
              OR ${table.responseBody} = '{"kind":"not_found"}'::jsonb
            )
          )
        )`,
      ),
      check('idempotency_record_version_positive', sql`${table.version} > 0`),
      index('idempotency_record_expiry_idx').on(table.tenantId, table.expiresAt),
    ],
  )
  .enableRLS();

export const auditEvent = zuochengSchema
  .table(
    'audit_event',
    {
      tenantId: uuid('tenant_id')
        .notNull(),
      id: uuidV7('id'),
      actorUserId: uuid('actor_user_id'),
      eventType: varchar('event_type', { length: 160 }).notNull(),
      subjectType: varchar('subject_type', { length: 120 }).notNull(),
      subjectId: uuid('subject_id'),
      requestId: uuid('request_id'),
      payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
      occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
      version: optimisticVersion(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
      deletedAt: deletedAt(),
    },
    (table) => [
      primaryKey({ name: 'audit_event_tenant_id_pk', columns: [table.tenantId, table.id] }),
      foreignKey({
        name: 'audit_event_tenant_fk',
        columns: [table.tenantId],
        foreignColumns: [tenant.id],
      }).onDelete('restrict'),
      foreignKey({
        name: 'audit_event_actor_membership_fk',
        columns: [table.tenantId, table.actorUserId],
        foreignColumns: [membership.tenantId, membership.userId],
      }).onDelete('restrict'),
      check('audit_event_type_nonempty', sql`btrim(${table.eventType}) <> ''`),
      check('audit_event_subject_type_nonempty', sql`btrim(${table.subjectType}) <> ''`),
      check('audit_event_version_positive', sql`${table.version} > 0`),
      index('audit_event_tenant_occurred_idx').on(table.tenantId, table.occurredAt),
    ],
  )
  .enableRLS();

export const deletionRequest = zuochengSchema
  .table(
    'deletion_request',
    {
      tenantId: uuid('tenant_id')
        .notNull(),
      id: uuidV7('id'),
      requestedByUserId: uuid('requested_by_user_id'),
      subjectType: text('subject_type').notNull(),
      subjectId: uuid('subject_id'),
      subjectHash: char('subject_hash', { length: 64 }).notNull(),
      subjectUserId: uuid('subject_user_id'),
      projectId: uuid('project_id'),
      priorDeletionStatus: text('prior_deletion_status'),
      status: text('status').notNull().default('pending'),
      reason: text('reason'),
      requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
      scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
      completedAt: timestamp('completed_at', { withTimezone: true }),
      version: optimisticVersion(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
      deletedAt: deletedAt(),
    },
    (table) => [
      primaryKey({
        name: 'deletion_request_tenant_id_pk',
        columns: [table.tenantId, table.id],
      }),
      foreignKey({
        name: 'deletion_request_tenant_fk',
        columns: [table.tenantId],
        foreignColumns: [tenant.id],
      }).onDelete('restrict'),
      foreignKey({
        name: 'deletion_request_requester_membership_fk',
        columns: [table.tenantId, table.requestedByUserId],
        foreignColumns: [membership.tenantId, membership.userId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'deletion_request_subject_membership_fk',
        columns: [table.tenantId, table.subjectUserId],
        foreignColumns: [membership.tenantId, membership.userId],
      }).onDelete('restrict'),
      foreignKey({
        name: 'deletion_request_project_fk',
        columns: [table.tenantId, table.projectId],
        foreignColumns: [project.tenantId, project.id],
      }).onDelete('restrict'),
      check(
        'deletion_request_subject_type_valid',
        sql`${table.subjectType} IN ('user', 'project', 'tenant')`,
      ),
      check(
        'deletion_request_subject_hash_valid',
        sql`${table.subjectHash} ~ '^[0-9a-f]{64}$'`,
      ),
      check(
        'deletion_request_prior_status_valid',
        sql`${table.priorDeletionStatus} IS NULL OR ${table.priorDeletionStatus} IN ('active', 'soft_deleted')`,
      ),
      check(
        'deletion_request_subject_valid',
        sql`(
          (${table.status} = 'completed' AND ${table.subjectId} IS NULL AND ${table.subjectUserId} IS NULL AND ${table.projectId} IS NULL)
          OR (${table.status} <> 'completed' AND ${table.subjectType} = 'user' AND ${table.subjectId} = ${table.subjectUserId} AND ${table.subjectUserId} IS NOT NULL AND ${table.projectId} IS NULL)
          OR (${table.status} <> 'completed' AND ${table.subjectType} = 'project' AND ${table.subjectId} = ${table.projectId} AND ${table.projectId} IS NOT NULL AND ${table.subjectUserId} IS NULL AND ${table.priorDeletionStatus} IS NOT NULL)
          OR (${table.status} <> 'completed' AND ${table.subjectType} = 'tenant' AND ${table.subjectId} = ${table.tenantId} AND ${table.subjectUserId} IS NULL AND ${table.projectId} IS NULL)
        )`,
      ),
      check(
        'deletion_request_requester_valid',
        sql`${table.requestedByUserId} IS NOT NULL OR ${table.status} = 'completed'`,
      ),
      check(
        'deletion_request_status_valid',
        sql`${table.status} IN ('pending', 'processing', 'completed', 'cancelled', 'rejected')`,
      ),
      check(
        'deletion_request_schedule_valid',
        sql`${table.scheduledFor} >= ${table.requestedAt}`,
      ),
      check(
        'deletion_request_completion_valid',
        sql`(${table.status} = 'completed') = (${table.completedAt} IS NOT NULL)`,
      ),
      check('deletion_request_version_positive', sql`${table.version} > 0`),
      index('deletion_request_status_idx').on(table.tenantId, table.status, table.scheduledFor),
    ],
  )
  .enableRLS();

export const tenantScopedTables = [
  membership,
  project,
  projectVersion,
  projectAcl,
  idempotencyRecord,
  auditEvent,
  deletionRequest,
] as const;

export type Tenant = typeof tenant.$inferSelect;
export type NewTenant = typeof tenant.$inferInsert;
export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
export type Membership = typeof membership.$inferSelect;
export type NewMembership = typeof membership.$inferInsert;
export type RuntimePrincipal = typeof runtimePrincipal.$inferSelect;
export type NewRuntimePrincipal = typeof runtimePrincipal.$inferInsert;
export type Project = typeof project.$inferSelect;
export type NewProject = typeof project.$inferInsert;
export type ProjectVersion = typeof projectVersion.$inferSelect;
export type NewProjectVersion = typeof projectVersion.$inferInsert;

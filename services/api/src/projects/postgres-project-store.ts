import { createHash } from 'node:crypto';
import { formatETag } from '@zuocheng/contracts';
import type { Pool as NodePostgresPool } from 'pg';
import {
  DeletionTaskSchema,
  ProjectRecordSchema,
  type ArchiveProjectCommand,
  type CopyProjectCommand,
  type CreateProjectCommand,
  type DeletionTask,
  type PermanentDeleteProjectCommand,
  type ProjectRecord,
  type ProjectStore,
  type RestoreProjectCommand,
  type SoftDeleteProjectCommand,
  type UpdateProjectCommand,
} from './project-service.js';

type SqlValue = string | number | boolean | null;
type SqlRow = Record<string, unknown>;

export type SqlQueryResult<Row extends SqlRow = SqlRow> = {
  rows: Row[];
  rowCount?: number | null;
};

export type SqlClient = {
  query<Row extends SqlRow = SqlRow>(
    sql: string,
    values?: readonly SqlValue[],
  ): Promise<SqlQueryResult<Row>>;
  release(error?: Error | boolean): void;
};

/** Structurally compatible with a node-postgres 8.22 Pool. */
export type SqlPool = {
  connect(): Promise<SqlClient>;
};

/**
 * Production must return a pool whose login is bound to exactly this tenant.
 * A shared all-tenant database login is intentionally outside this boundary.
 */
export type TenantPoolProvider = {
  poolForContext(tenantId: string, userId: string): SqlPool;
};

/** Adapts exact-pinned node-postgres pools without weakening the tenant key. */
export function nodePostgresTenantPools(
  resolveContextPool: (tenantId: string, userId: string) => NodePostgresPool,
): TenantPoolProvider {
  return {
    poolForContext(tenantId, userId) {
      const pool = resolveContextPool(tenantId, userId);
      return {
        async connect() {
          const client = await pool.connect();
          return {
            async query<Row extends SqlRow = SqlRow>(
              sql: string,
              values: readonly SqlValue[] = [],
            ): Promise<SqlQueryResult<Row>> {
              const result = await client.query<Row>(sql, [...values]);
              return { rows: result.rows, rowCount: result.rowCount };
            },
            release(error?: Error | boolean) {
              client.release(error);
            },
          };
        },
      };
    },
  };
}

export type ProjectStoreFaultStep =
  | 'idempotency_claimed'
  | 'project_written'
  | 'version_appended'
  | 'audit_appended'
  | 'idempotency_completed';

type StoreOptions = {
  afterStep?: (step: ProjectStoreFaultStep) => void | Promise<void>;
};

type PermanentDeleteResult = Awaited<
  ReturnType<ProjectStore['requestPermanentDelete']>
>;

type IdempotencyClaim =
  | { kind: 'claimed'; scope: string; keyHash: string }
  | { kind: 'conflict' }
  | { kind: 'replay'; value: unknown };

type ProjectRow = {
  id: string;
  tenant_id: string;
  version: number;
  name: string;
  description: string | null;
  status: string;
  deletion_status: string;
  copied_from_project_id: string | null;
  created_by_user_id: string;
  updated_by_user_id: string;
  created_at: string | Date;
  updated_at: string | Date;
  archived_at: string | Date | null;
  deleted_at: string | Date | null;
};

type DeletionRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  status: string;
  requested_by_user_id: string;
  requested_at: string | Date;
};

type ExpectedRoutineFailure = 'P0002' | '40001' | '23514' | '42501';

const PROJECT_COLUMNS = `
  project.id::text AS id,
  project.tenant_id::text AS tenant_id,
  project.version,
  project.name,
  project.description,
  project.status,
  project.deletion_status,
  project.copied_from_project_id::text AS copied_from_project_id,
  project.created_by_user_id::text AS created_by_user_id,
  project.updated_by_user_id::text AS updated_by_user_id,
  project.created_at,
  project.updated_at,
  project.archived_at,
  project.deleted_at`;

const PROJECT_FROM = 'FROM zuocheng.project AS project';

/**
 * PostgreSQL-backed implementation. Mutations own their complete transaction:
 * tenant role/GUC, hashed idempotency claim, CAS, immutable snapshot/audit, and
 * replay response are committed or rolled back together.
 */
export class PostgresProjectStore implements ProjectStore {
  readonly #pools: TenantPoolProvider;
  readonly #afterStep: (step: ProjectStoreFaultStep) => void | Promise<void>;

  constructor(pools: TenantPoolProvider, options: StoreOptions = {}) {
    this.#pools = pools;
    this.#afterStep = options.afterStep ?? (() => undefined);
  }

  async create(command: CreateProjectCommand) {
    return this.#transaction(command.tenantId, command.actorUserId, async (client) => {
      const claim = await this.#claimIdempotency(
        client,
        command.tenantId,
        'project.create',
        command.idempotencyKey,
        command.requestHash,
        null,
      );
      if (claim.kind === 'conflict') return { kind: 'idempotency_conflict' as const };
      if (claim.kind === 'replay') return replayCreate(claim.value);

      const created = await client.query<{ id: string }>(
        `SELECT zuocheng.create_project($1, $2, $3)::text AS id`,
        [command.actorUserId, command.name, command.description],
      );
      const projectId = requiredReturnedId(created, 'create_project');
      await this.#step('project_written');
      await this.#step('version_appended');
      await this.#step('audit_appended');
      const project = await this.#requireProject(client, command.tenantId, projectId);
      const result = { kind: 'applied' as const, project };
      await this.#completeIdempotency(client, command.tenantId, claim, project.id, 201, result);
      return result;
    });
  }

  async listVisible(
    tenantId: string,
    actorUserId: string,
  ): Promise<ProjectRecord[]> {
    return this.#transaction(tenantId, actorUserId, async (client) => {
      const result = await client.query<ProjectRow>(
        `SELECT ${PROJECT_COLUMNS} ${PROJECT_FROM}
          WHERE project.tenant_id = $1
            AND project.deletion_status = 'active'
            AND (
              EXISTS (
                SELECT 1
                  FROM zuocheng.membership AS membership
                 WHERE membership.tenant_id = project.tenant_id
                   AND membership.user_id = $2
                   AND membership.role IN ('owner', 'admin')
                   AND membership.status = 'active'
                   AND membership.deleted_at IS NULL
              )
              OR EXISTS (
                SELECT 1
                  FROM zuocheng.project_acl AS acl
                 WHERE acl.tenant_id = project.tenant_id
                   AND acl.project_id = project.id
                   AND acl.principal_user_id = $2
                   AND acl.deleted_at IS NULL
              )
            )
          ORDER BY project.updated_at DESC, project.id`,
        [tenantId, actorUserId],
      );
      return result.rows.map(mapProject);
    });
  }

  async findVisible(
    tenantId: string,
    actorUserId: string,
    projectId: string,
  ): Promise<ProjectRecord | null> {
    return this.#transaction(tenantId, actorUserId, (client) =>
      this.#selectProject(client, tenantId, projectId, 'public', actorUserId),
    );
  }

  async update(command: UpdateProjectCommand) {
    return this.#mutate(
      command,
      'project.update',
      async (client, current) => {
        await client.query(
          `CALL zuocheng.update_project_content($1, $2, $3, $4, $5, $6)`,
          [
            command.tenantId,
            command.projectId,
            command.expectedVersion,
            command.actorUserId,
            command.patch.name ?? current.name,
            command.patch.description === undefined
              ? current.description
              : command.patch.description,
          ],
        );
        return 'applied';
      },
    );
  }

  async copy(command: CopyProjectCommand) {
    return this.#transaction(command.tenantId, command.actorUserId, async (client) => {
      const claim = await this.#claimIdempotency(
        client,
        command.tenantId,
        'project.copy',
        command.idempotencyKey,
        command.requestHash,
        null,
      );
      if (claim.kind === 'conflict') return { kind: 'idempotency_conflict' as const };
      if (claim.kind === 'replay') return replayMutation(claim.value);

      const source = await this.#selectProject(
        client,
        command.tenantId,
        command.sourceProjectId,
        'internal',
      );
      if (source === null) {
        return this.#completeMutationOutcome(client, command.tenantId, claim, null, {
          kind: 'not_found' as const,
        });
      }
      if (source.version !== command.expectedVersion) {
        return this.#completeMutationOutcome(client, command.tenantId, claim, source.id, {
          kind: 'version_conflict' as const,
          current: source,
        });
      }
      if (source.deletionStatus !== 'active') {
        return this.#completeMutationOutcome(client, command.tenantId, claim, source.id, {
          kind: 'invalid_state' as const,
          current: source,
        });
      }

      const copiedName = command.name ?? `${source.name} copy`.slice(0, 160);
      const copyAttempt = await this.#attemptRoutine(client, () =>
        client.query<{ id: string }>(
          `SELECT zuocheng.copy_project($1, $2, $3, $4)::text AS id`,
          [source.id, command.actorUserId, command.expectedVersion, copiedName],
        ),
      );
      if (!copyAttempt.ok) {
        return this.#routineFailureOutcome(
          client,
          command.tenantId,
          claim,
          source.id,
          copyAttempt.code,
        );
      }
      const copiedResult = copyAttempt.value;
      const copiedProjectId = requiredReturnedId(copiedResult, 'copy_project');
      await this.#step('project_written');
      await this.#step('version_appended');
      await this.#step('audit_appended');
      const copied = await this.#requireProject(
        client,
        command.tenantId,
        copiedProjectId,
      );
      return this.#completeMutationOutcome(client, command.tenantId, claim, copied.id, {
        kind: 'applied' as const,
        project: copied,
      });
    });
  }

  async archive(command: ArchiveProjectCommand) {
    return this.#mutate(
      command,
      'project.archive',
      async (client, current) => {
        if (current.status === 'archived') return 'unchanged';
        await client.query(
          `CALL zuocheng.archive_project($1, $2, $3, $4)`,
          [
            command.tenantId,
            command.projectId,
            command.expectedVersion,
            command.actorUserId,
          ],
        );
        return 'applied';
      },
    );
  }

  async softDelete(command: SoftDeleteProjectCommand) {
    return this.#mutate(
      command,
      'project.soft-delete',
      async (client, current) => {
        if (current.deletionStatus !== 'active') return 'invalid_state';
        await client.query(
          `CALL zuocheng.soft_delete_project($1, $2, $3, $4)`,
          [
            command.tenantId,
            command.projectId,
            command.expectedVersion,
            command.actorUserId,
          ],
        );
        return 'applied';
      },
    );
  }

  async restore(command: RestoreProjectCommand) {
    return this.#mutate(
      command,
      'project.restore',
      async (client, current) => {
        if (current.deletionStatus === command.prohibitedDeletionStatus) return 'invalid_state';
        if (current.deletionStatus === 'active') return 'unchanged';
        if (current.deletionStatus !== 'soft_deleted') return 'invalid_state';
        await client.query(
          `CALL zuocheng.restore_project($1, $2, $3, $4)`,
          [
            command.tenantId,
            command.projectId,
            command.expectedVersion,
            command.actorUserId,
          ],
        );
        return 'applied';
      },
    );
  }

  async requestPermanentDelete(
    command: PermanentDeleteProjectCommand,
  ): Promise<PermanentDeleteResult> {
    return this.#transaction(command.tenantId, command.actorUserId, async (client) => {
      const claim = await this.#claimIdempotency(
        client,
        command.tenantId,
        'project.permanent-delete',
        command.idempotencyKey,
        command.requestHash,
        null,
      );
      if (claim.kind === 'conflict') return { kind: 'idempotency_conflict' as const };
      if (claim.kind === 'replay') return replayPermanentDelete(claim.value);

      const locked = await this.#attemptRoutine(client, () =>
        this.#lockProjectForDeletion(
          client,
          command.tenantId,
          command.projectId,
          command.actorUserId,
        ),
      );
      if (!locked.ok) {
        if (locked.code !== '42501') {
          throw new Error(`Unexpected project lock failure: ${locked.code}`);
        }
        const visibleProjectId = await this.#selectVisibleProjectId(
          client,
          command.tenantId,
          command.projectId,
        );
        if (visibleProjectId === null) {
          return this.#completeMutationOutcome(client, command.tenantId, claim, null, {
            kind: 'not_found' as const,
          });
        }
        return this.#completeMutationOutcome(
          client,
          command.tenantId,
          claim,
          visibleProjectId,
          { kind: 'forbidden' as const },
        );
      }
      const current = locked.value;
      if (current === null) {
        return this.#completeMutationOutcome(client, command.tenantId, claim, null, {
          kind: 'not_found' as const,
        });
      }
      if (current.version !== command.expectedVersion) {
        return this.#completeMutationOutcome(client, command.tenantId, claim, current.id, {
          kind: 'version_conflict' as const,
          current,
        });
      }
      if (current.deletionStatus !== command.requiredDeletionStatus) {
        return this.#completeMutationOutcome(client, command.tenantId, claim, current.id, {
          kind: 'invalid_state' as const,
          current,
        });
      }

      const requestAttempt = await this.#attemptRoutine(client, () =>
        client.query<{ id: string }>(
          `SELECT zuocheng.request_project_deletion(
             $1, $2, $3, $4, $5::timestamptz, $6
           )::text AS id`,
          [
            command.tenantId,
            command.projectId,
            command.expectedVersion,
            command.actorUserId,
            command.occurredAt,
            null,
          ],
        ),
      );
      if (!requestAttempt.ok) {
        return this.#routineFailureOutcome(
          client,
          command.tenantId,
          claim,
          current.id,
          requestAttempt.code,
        );
      }
      const requested = requestAttempt.value;
      const deletionTaskId = requiredReturnedId(
        requested,
        'request_project_deletion',
      );
      await this.#step('project_written');
      await this.#step('version_appended');
      await this.#step('audit_appended');
      const project = await this.#requireProject(client, command.tenantId, command.projectId);
      const deletionTask = await this.#requireDeletionTask(
        client,
        command.tenantId,
        deletionTaskId,
      );
      const result = { kind: 'applied' as const, project, deletionTask };
      await this.#completeIdempotency(client, command.tenantId, claim, project.id, 202, result);
      return result;
    });
  }

  async #mutate(
    command:
      | UpdateProjectCommand
      | ArchiveProjectCommand
      | SoftDeleteProjectCommand
      | RestoreProjectCommand,
    scope: string,
    apply: (
      client: SqlClient,
      current: ProjectRecord,
    ) => Promise<'applied' | 'unchanged' | 'invalid_state'>,
  ) {
    return this.#transaction(command.tenantId, command.actorUserId, async (client) => {
      const claim = await this.#claimIdempotency(
        client,
        command.tenantId,
        scope,
        command.idempotencyKey,
        command.requestHash,
        null,
      );
      if (claim.kind === 'conflict') return { kind: 'idempotency_conflict' as const };
      if (claim.kind === 'replay') return replayMutation(claim.value);

      const locked = await this.#attemptRoutine(client, () =>
        this.#lockProjectForMutation(
          client,
          command.tenantId,
          command.projectId,
          command.actorUserId,
        ),
      );
      if (!locked.ok) {
        if (locked.code !== '42501') {
          throw new Error(`Unexpected project lock failure: ${locked.code}`);
        }
        const visibleProjectId = await this.#selectVisibleProjectId(
          client,
          command.tenantId,
          command.projectId,
        );
        if (visibleProjectId === null) {
          return this.#completeMutationOutcome(client, command.tenantId, claim, null, {
            kind: 'not_found' as const,
          });
        }
        return this.#completeMutationOutcome(
          client,
          command.tenantId,
          claim,
          visibleProjectId,
          { kind: 'forbidden' as const },
        );
      }
      const current = locked.value;
      if (current === null) {
        return this.#completeMutationOutcome(client, command.tenantId, claim, null, {
          kind: 'not_found' as const,
        });
      }
      if (current.version !== command.expectedVersion) {
        return this.#completeMutationOutcome(client, command.tenantId, claim, current.id, {
          kind: 'version_conflict' as const,
          current,
        });
      }

      const mutationAttempt = await this.#attemptRoutine(client, () =>
        apply(client, current),
      );
      if (!mutationAttempt.ok) {
        return this.#routineFailureOutcome(
          client,
          command.tenantId,
          claim,
          current.id,
          mutationAttempt.code,
        );
      }
      const disposition = mutationAttempt.value;
      if (disposition === 'invalid_state') {
        return this.#completeMutationOutcome(client, command.tenantId, claim, current.id, {
          kind: 'invalid_state' as const,
          current,
        });
      }
      if (disposition === 'unchanged') {
        return this.#completeMutationOutcome(client, command.tenantId, claim, current.id, {
          kind: 'unchanged' as const,
          project: current,
        });
      }

      await this.#step('project_written');
      await this.#step('version_appended');
      await this.#step('audit_appended');
      const project = await this.#requireProject(client, command.tenantId, command.projectId);
      return this.#completeMutationOutcome(client, command.tenantId, claim, project.id, {
        kind: 'applied' as const,
        project,
      });
    });
  }

  async #transaction<Result>(
    tenantId: string,
    actorUserId: string,
    operation: (client: SqlClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.#pools
      .poolForContext(tenantId, actorUserId)
      .connect();
    let destroyClient = false;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE zuocheng_app');
      await client.query("SELECT set_config('zuocheng.current_tenant_id', $1, true)", [tenantId]);
      await client.query('SELECT zuocheng.require_app_context($1, $2)', [
        tenantId,
        actorUserId,
      ]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroyClient = true;
      }
      throw error;
    } finally {
      if (destroyClient) client.release(true);
      else client.release();
    }
  }

  async #claimIdempotency(
    client: SqlClient,
    tenantId: string,
    scope: string,
    rawKey: string,
    requestHash: string,
    projectId: string | null,
  ): Promise<IdempotencyClaim> {
    const keyHash = sha256(rawKey);
    const claim = await client.query<{
      claimed: boolean;
      stored_request_hash: string;
      stored_response_body: unknown;
    }>(
      `SELECT claimed, stored_request_hash, stored_response_body
         FROM zuocheng.claim_idempotency_record($1, $2, $3, $4, $5)`,
      [tenantId, scope, keyHash, requestHash, projectId],
    );
    const record = claim.rows[0];
    if (record === undefined) throw new Error('Idempotency claim routine returned no result');
    if (record.claimed) {
      await this.#step('idempotency_claimed');
      return { kind: 'claimed', scope, keyHash };
    }
    if (record.stored_request_hash !== requestHash) return { kind: 'conflict' };
    if (record.stored_response_body === null) {
      throw new Error('Idempotency record is incomplete after acquiring its row lock');
    }
    return { kind: 'replay', value: jsonValue(record.stored_response_body) };
  }

  async #completeIdempotency(
    client: SqlClient,
    tenantId: string,
    claim: Extract<IdempotencyClaim, { kind: 'claimed' }>,
    projectId: string | null,
    responseStatus: number,
    response: unknown,
  ) {
    await client.query(
      `SELECT zuocheng.complete_idempotency_record(
         $1, $2, $3, $4, $5, $6::jsonb
       )`,
      [
        tenantId,
        claim.scope,
        claim.keyHash,
        projectId,
        responseStatus,
        JSON.stringify(response),
      ],
    );
    await this.#step('idempotency_completed');
  }

  async #completeMutationOutcome<Outcome>(
    client: SqlClient,
    tenantId: string,
    claim: Extract<IdempotencyClaim, { kind: 'claimed' }>,
    projectId: string | null,
    outcome: Outcome,
  ): Promise<Outcome> {
    const status =
      typeof outcome === 'object' && outcome !== null && 'kind' in outcome
        ? outcome.kind === 'not_found'
          ? 404
          : outcome.kind === 'forbidden'
            ? 403
          : outcome.kind === 'version_conflict' ||
              outcome.kind === 'invalid_state'
            ? 409
            : 200
        : 200;
    await this.#completeIdempotency(client, tenantId, claim, projectId, status, outcome);
    return outcome;
  }

  async #routineFailureOutcome(
    client: SqlClient,
    tenantId: string,
    claim: Extract<IdempotencyClaim, { kind: 'claimed' }>,
    projectId: string,
    code: ExpectedRoutineFailure,
  ) {
    const current = await this.#selectProject(
      client,
      tenantId,
      projectId,
      'internal',
    );
    if (current === null || code === 'P0002') {
      return this.#completeMutationOutcome(client, tenantId, claim, null, {
        kind: 'not_found' as const,
      });
    }
    if (code === '40001') {
      return this.#completeMutationOutcome(client, tenantId, claim, current.id, {
        kind: 'version_conflict' as const,
        current,
      });
    }
    if (code === '42501') {
      return this.#completeMutationOutcome(client, tenantId, claim, current.id, {
        kind: 'forbidden' as const,
      });
    }
    return this.#completeMutationOutcome(client, tenantId, claim, current.id, {
      kind: 'invalid_state' as const,
      current,
    });
  }

  async #attemptRoutine<Result>(
    client: SqlClient,
    operation: () => Promise<Result>,
  ): Promise<
    | { ok: true; value: Result }
    | { ok: false; code: ExpectedRoutineFailure }
  > {
    await client.query('SAVEPOINT project_store_routine');
    try {
      const value = await operation();
      await client.query('RELEASE SAVEPOINT project_store_routine');
      return { ok: true, value };
    } catch (error) {
      const code = sqlState(error);
      if (
        code !== 'P0002' &&
        code !== '40001' &&
        code !== '23514' &&
        code !== '42501'
      ) {
        throw error;
      }
      await client.query('ROLLBACK TO SAVEPOINT project_store_routine');
      await client.query('RELEASE SAVEPOINT project_store_routine');
      return { ok: false, code };
    }
  }

  async #selectProject(
    client: SqlClient,
    tenantId: string,
    projectId: string,
    visibility: 'public' | 'internal',
    actorUserId?: string,
  ): Promise<ProjectRecord | null> {
    if (visibility === 'public' && actorUserId === undefined) {
      throw new Error('Public project reads require an authenticated actor');
    }
    const result = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} ${PROJECT_FROM}
        WHERE project.tenant_id = $1 AND project.id = $2
          ${
            visibility === 'public'
              ? `AND project.deletion_status = 'active'
                 AND (
                   EXISTS (
                     SELECT 1
                       FROM zuocheng.membership AS membership
                      WHERE membership.tenant_id = project.tenant_id
                        AND membership.user_id = $3
                        AND membership.role IN ('owner', 'admin')
                        AND membership.status = 'active'
                        AND membership.deleted_at IS NULL
                   )
                   OR EXISTS (
                     SELECT 1
                       FROM zuocheng.project_acl AS acl
                      WHERE acl.tenant_id = project.tenant_id
                        AND acl.project_id = project.id
                        AND acl.principal_user_id = $3
                        AND acl.deleted_at IS NULL
                   )
                 )`
              : ''
          }`,
      visibility === 'public'
        ? [tenantId, projectId, actorUserId ?? null]
        : [tenantId, projectId],
    );
    return result.rows[0] === undefined ? null : mapProject(result.rows[0]);
  }

  async #lockProjectForMutation(
    client: SqlClient,
    tenantId: string,
    projectId: string,
    actorUserId: string,
  ): Promise<ProjectRecord | null> {
    const result = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS}
         FROM zuocheng.lock_project_for_mutation($1, $2, $3) AS project`,
      [tenantId, projectId, actorUserId],
    );
    return result.rows[0] === undefined ? null : mapProject(result.rows[0]);
  }

  async #lockProjectForDeletion(
    client: SqlClient,
    tenantId: string,
    projectId: string,
    actorUserId: string,
  ): Promise<ProjectRecord | null> {
    const result = await client.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS}
         FROM zuocheng.lock_project_for_deletion($1, $2, $3) AS project`,
      [tenantId, projectId, actorUserId],
    );
    return result.rows[0] === undefined ? null : mapProject(result.rows[0]);
  }

  async #selectVisibleProjectId(client: SqlClient, tenantId: string, projectId: string) {
    const result = await client.query<{ id: string }>(
      `SELECT id::text FROM zuocheng.project
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, projectId],
    );
    return result.rows[0]?.id ?? null;
  }

  async #requireProject(client: SqlClient, tenantId: string, projectId: string) {
    const project = await this.#selectProject(
      client,
      tenantId,
      projectId,
      'internal',
    );
    if (project === null) throw new Error('A committed project write was not visible in its transaction');
    return project;
  }

  async #requireDeletionTask(client: SqlClient, tenantId: string, taskId: string) {
    const result = await client.query<DeletionRow>(
      `SELECT id::text, tenant_id::text, project_id::text, status,
              requested_by_user_id::text, requested_at
         FROM zuocheng.deletion_request
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, taskId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Deletion request was not visible after insertion');
    return mapDeletionTask(row);
  }

  async #step(step: ProjectStoreFaultStep) {
    await this.#afterStep(step);
  }
}

function mapProject(row: ProjectRow): ProjectRecord {
  return ProjectRecordSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    version: Number(row.version),
    etag: formatETag(Number(row.version)),
    name: row.name,
    description: row.description,
    status: row.status,
    deletionStatus: row.deletion_status,
    copiedFromProjectId: row.copied_from_project_id,
    createdBy: row.created_by_user_id,
    updatedBy: row.updated_by_user_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    archivedAt: row.archived_at === null ? null : iso(row.archived_at),
    deletedAt: row.deleted_at === null ? null : iso(row.deleted_at),
  });
}

function mapDeletionTask(row: DeletionRow): DeletionTask {
  if (row.status !== 'pending') throw new Error(`Unexpected deletion task state: ${row.status}`);
  return DeletionTaskSchema.parse({
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    status: 'purge_pending',
    requestedBy: row.requested_by_user_id,
    requestedAt: iso(row.requested_at),
  });
}

function replayCreate(value: unknown) {
  const result = parseStoredMutation(value);
  if (result.kind !== 'applied') throw new Error('Create replay has an invalid stored outcome');
  return { kind: 'replayed' as const, project: result.project };
}

function replayMutation(value: unknown) {
  const result = parseStoredMutation(value);
  return result.kind === 'applied'
    ? { kind: 'replayed' as const, project: result.project }
    : result;
}

function replayPermanentDelete(value: unknown): PermanentDeleteResult {
  const parsed = jsonObject(value);
  if (parsed.kind === 'applied') {
    return {
      kind: 'replayed' as const,
      project: ProjectRecordSchema.parse(parsed.project),
      deletionTask: DeletionTaskSchema.parse(parsed.deletionTask),
    };
  }
  const result = parseStoredMutation(parsed);
  if (result.kind === 'applied' || result.kind === 'unchanged') {
    throw new Error('Permanent deletion replay has an invalid stored outcome');
  }
  return result;
}

function parseStoredMutation(value: unknown):
  | { kind: 'applied'; project: ProjectRecord }
  | { kind: 'unchanged'; project: ProjectRecord }
  | { kind: 'not_found' | 'idempotency_conflict' | 'forbidden' }
  | { kind: 'version_conflict' | 'invalid_state'; current: ProjectRecord } {
  const parsed = jsonObject(value);
  if (parsed.kind === 'applied' || parsed.kind === 'unchanged') {
    return { kind: parsed.kind, project: ProjectRecordSchema.parse(parsed.project) };
  }
  if (
    parsed.kind === 'not_found' ||
    parsed.kind === 'idempotency_conflict' ||
    parsed.kind === 'forbidden'
  ) {
    return { kind: parsed.kind };
  }
  if (parsed.kind === 'version_conflict' || parsed.kind === 'invalid_state') {
    return { kind: parsed.kind, current: ProjectRecordSchema.parse(parsed.current) };
  }
  throw new Error('Stored idempotency response has an unknown outcome');
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = jsonValue(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Stored response must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function jsonValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requiredReturnedId(
  result: SqlQueryResult<{ id: string }>,
  routine: string,
): string {
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`${routine} did not return an id`);
  return id;
}

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
}

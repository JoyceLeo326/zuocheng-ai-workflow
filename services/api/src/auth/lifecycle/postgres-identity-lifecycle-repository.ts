import { createHash } from 'node:crypto';
import type {
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow,
} from 'pg';
import type { UUIDv7 } from '@zuocheng/contracts';
import type {
  AccountDeletionStatus,
  AccountDeletionView,
  AccountExportStatus,
  AccountExportView,
  IdentityDeviceView,
  IdentityPrincipal,
  IdentitySessionView,
} from '../http/identity-lifecycle-service.js';
import type {
  AccountExportSnapshot,
  IdentityIdempotencyClaim,
  IdentityLifecycleRepository,
} from './postgres-identity-lifecycle-service.js';

type SessionRow = Readonly<{
  id: string;
  user_id: string;
  device_public_id: string;
  created_at: Date | string;
  last_seen_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
}>;

type ExportRow = Readonly<{
  id: string;
  status: string;
  requested_at: Date | string;
  completed_at: Date | string | null;
  expires_at: Date | string | null;
  artifact_url: string | null;
  artifact_sha256: string | null;
}>;

type DeletionRow = Readonly<{
  id: string;
  status: string;
  requested_at: Date | string;
  scheduled_for: Date | string | null;
  irreversible_at: Date | string | null;
  completed_at: Date | string | null;
}>;

type SqlClient = Pick<PoolClient, 'query'>;

export class PostgresIdentityLifecycleRepository
  implements IdentityLifecycleRepository
{
  readonly kind = 'customer-managed-postgres-identity-repository';

  constructor(private readonly pool: Pool) {}

  claimIdempotency(input: Readonly<{
    actorScope: string;
    operation: string;
    keyDigest: string;
    requestDigest: string;
  }>): Promise<IdentityIdempotencyClaim> {
    return this.transaction(async (client) => {
      const actorScopeHash = sha256(input.actorScope);
      await client.query(
        `DELETE FROM zuocheng.identity_idempotency
          WHERE actor_scope_hash = $1
            AND operation = $2
            AND key_hash = $3
            AND expires_at <= now()`,
        [actorScopeHash, input.operation, input.keyDigest],
      );
      const inserted = await client.query<{ inserted: boolean }>(
        `INSERT INTO zuocheng.identity_idempotency
           (actor_scope_hash, operation, key_hash, request_hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (actor_scope_hash, operation, key_hash) DO NOTHING
         RETURNING true AS inserted`,
        [
          actorScopeHash,
          input.operation,
          input.keyDigest,
          input.requestDigest,
        ],
      );
      if (inserted.rows[0]?.inserted === true) {
        return { kind: 'claimed' };
      }
      const existing = await client.query<{
        request_hash: string;
        status: string;
      }>(
        `SELECT request_hash, status
           FROM zuocheng.identity_idempotency
          WHERE actor_scope_hash = $1
            AND operation = $2
            AND key_hash = $3
          FOR UPDATE`,
        [actorScopeHash, input.operation, input.keyDigest],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new Error('Identity idempotency conflict disappeared');
      }
      return row.request_hash === input.requestDigest
        ? { kind: 'replay' }
        : { kind: 'conflict' };
    });
  }

  completeIdempotency(input: Readonly<{
    actorScope: string;
    operation: string;
    keyDigest: string;
  }>): Promise<void> {
    return this.transaction(async (client) => {
      await requireAffected(
        client.query(
          `UPDATE zuocheng.identity_idempotency
              SET status = 'completed',
                  completed_at = now()
            WHERE actor_scope_hash = $1
              AND operation = $2
              AND key_hash = $3
              AND status = 'processing'`,
          [sha256(input.actorScope), input.operation, input.keyDigest],
        ),
        'identity idempotency completion',
      );
    });
  }

  abandonIdempotency(input: Readonly<{
    actorScope: string;
    operation: string;
    keyDigest: string;
  }>): Promise<void> {
    return this.transaction(async (client) => {
      await client.query(
        `DELETE FROM zuocheng.identity_idempotency
          WHERE actor_scope_hash = $1
            AND operation = $2
            AND key_hash = $3
            AND status = 'processing'`,
        [sha256(input.actorScope), input.operation, input.keyDigest],
      );
    });
  }

  getCurrentSession(
    principal: IdentityPrincipal,
  ): Promise<IdentitySessionView | null> {
    return this.transaction(async (client) => {
      const result = await client.query<SessionRow>(
        `${sessionSelect()}
          WHERE identity_session.user_id = $1
            AND identity_session.id = $2`,
        [principal.userId, principal.sessionId],
      );
      return result.rows[0] === undefined
        ? null
        : mapSession(result.rows[0], principal.sessionId);
    });
  }

  listSessions(
    principal: IdentityPrincipal,
  ): Promise<readonly IdentitySessionView[]> {
    return this.transaction(async (client) => {
      const result = await client.query<SessionRow>(
        `${sessionSelect()}
          WHERE identity_session.user_id = $1
          ORDER BY identity_session.created_at DESC`,
        [principal.userId],
      );
      return result.rows.map((row) =>
        mapSession(row, principal.sessionId),
      );
    });
  }

  listDevices(
    principal: IdentityPrincipal,
  ): Promise<readonly IdentityDeviceView[]> {
    return this.transaction(async (client) => {
      const result = await client.query<{
        id: string;
        display_name: string | null;
        platform: string | null;
        last_seen_at: Date | string;
        current: boolean;
      }>(
        `SELECT DISTINCT ON (
           COALESCE(identity_session.device_id_hash, identity_session.id::text)
         )
           identity_session.device_public_id::text AS id,
           identity_session.device_name AS display_name,
           identity_session.device_type AS platform,
           identity_session.last_seen_at,
           identity_session.id = $2::uuid AS current
         FROM zuocheng.session AS identity_session
        WHERE identity_session.user_id = $1
        ORDER BY
          COALESCE(identity_session.device_id_hash, identity_session.id::text),
          (identity_session.id = $2::uuid) DESC,
          identity_session.last_seen_at DESC`,
        [principal.userId, principal.sessionId],
      );
      return result.rows.map((row) => ({
        id: row.id as UUIDv7,
        displayName: row.display_name ?? 'Unknown device',
        platform: row.platform ?? 'Unknown platform',
        lastSeenAt: iso(row.last_seen_at),
        current: row.current,
      }));
    });
  }

  revokeSession(
    principal: IdentityPrincipal,
    sessionId: UUIDv7,
  ): Promise<readonly UUIDv7[]> {
    return this.revokeSessions(
      principal,
      'identity_session.id = $2::uuid',
      [principal.userId, sessionId],
      'user_session_revoked',
    );
  }

  revokeOtherSessions(
    principal: IdentityPrincipal,
  ): Promise<readonly UUIDv7[]> {
    return this.revokeSessions(
      principal,
      'identity_session.id <> $2::uuid',
      [principal.userId, principal.sessionId],
      'other_sessions_revoked',
    );
  }

  revokeAllSessions(
    principal: IdentityPrincipal,
  ): Promise<readonly UUIDv7[]> {
    return this.revokeSessions(
      principal,
      'true',
      [principal.userId],
      'all_sessions_revoked',
    );
  }

  appendAudit(input: Readonly<{
    principal?: IdentityPrincipal;
    userId?: UUIDv7;
    eventType: string;
    payload?: Readonly<Record<string, unknown>>;
  }>): Promise<void> {
    return this.transaction(async (client) => {
      const userId = input.principal?.userId ?? input.userId ?? null;
      const sessionId = input.principal?.sessionId ?? null;
      await client.query(
        `INSERT INTO zuocheng.identity_audit_event
           (user_id, session_id, event_type, payload)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          userId,
          sessionId,
          input.eventType,
          JSON.stringify(input.payload ?? {}),
        ],
      );
    });
  }

  createRecentAuthProof(
    principal: IdentityPrincipal,
    tokenDigest: string,
    expiresAt: string,
    purpose: 'account-deletion',
  ): Promise<void> {
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO zuocheng.verification
           (user_id, purpose, identifier_hash, subject_value, expires_at,
            max_attempts)
         VALUES ($1, 'recent_auth', $2, $3, $4, 1)`,
        [
          principal.userId,
          tokenDigest,
          `${principal.userId}:${purpose}`,
          expiresAt,
        ],
      );
    });
  }

  createAccountExport(
    principal: IdentityPrincipal,
  ): Promise<AccountExportView> {
    return this.transaction(async (client) => {
      const result = await client.query<ExportRow>(
        `INSERT INTO zuocheng.account_export_request
           (user_id, requested_by_session_id, status)
         VALUES ($1, $2, 'processing')
         RETURNING
           id::text, status, requested_at, completed_at, expires_at,
           artifact_url, artifact_sha256`,
        [principal.userId, principal.sessionId],
      );
      return mapExport(requiredRow(result, 'account export creation'));
    });
  }

  captureAccountExport(
    principal: IdentityPrincipal,
  ): Promise<AccountExportSnapshot> {
    return this.transaction(async (client) => {
      const result = await client.query<{ snapshot: unknown }>(
        `SELECT zuocheng.capture_account_export($1)::jsonb AS snapshot`,
        [principal.userId],
      );
      return parseExportSnapshot(
        requiredRow(result, 'account export snapshot').snapshot,
      );
    });
  }

  completeAccountExport(
    principal: IdentityPrincipal,
    exportId: UUIDv7,
    artifact: Readonly<{
      downloadUrl: string;
      expiresAt: string;
      sha256: string;
      manifest: unknown;
    }>,
  ): Promise<AccountExportView> {
    return this.transaction(async (client) => {
      const result = await client.query<ExportRow>(
        `UPDATE zuocheng.account_export_request
            SET status = 'ready',
                manifest = $3::jsonb,
                manifest_sha256 = $4,
                artifact_url = $5,
                artifact_sha256 = $4,
                completed_at = now(),
                expires_at = $6,
                updated_at = now()
          WHERE user_id = $1
            AND id = $2
            AND status = 'processing'
        RETURNING
          id::text, status, requested_at, completed_at, expires_at,
          artifact_url, artifact_sha256`,
        [
          principal.userId,
          exportId,
          JSON.stringify(artifact.manifest),
          artifact.sha256,
          artifact.downloadUrl,
          artifact.expiresAt,
        ],
      );
      return mapExport(requiredRow(result, 'account export completion'));
    });
  }

  failAccountExport(
    principal: IdentityPrincipal,
    exportId: UUIDv7,
  ): Promise<void> {
    return this.transaction(async (client) => {
      await client.query(
        `UPDATE zuocheng.account_export_request
            SET status = 'failed',
                failure_code = 'EXPORT_RESOURCE_UNAVAILABLE',
                updated_at = now()
          WHERE user_id = $1
            AND id = $2
            AND status IN ('pending', 'processing')`,
        [principal.userId, exportId],
      );
    });
  }

  getAccountExport(
    principal: IdentityPrincipal,
    exportId: UUIDv7,
  ): Promise<AccountExportView | null> {
    return this.transaction(async (client) => {
      const result = await client.query<ExportRow>(
        `SELECT
           id::text, status, requested_at, completed_at, expires_at,
           artifact_url, artifact_sha256
         FROM zuocheng.account_export_request
        WHERE user_id = $1 AND id = $2`,
        [principal.userId, exportId],
      );
      return result.rows[0] === undefined
        ? null
        : mapExport(result.rows[0]);
    });
  }

  consumeRecentAuthAndCreateDeletion(
    principal: IdentityPrincipal,
    recentAuthDigest: string,
    confirmationDigest: string,
  ): Promise<Readonly<{
    deletion: AccountDeletionView;
    email: string;
    confirmationDigest: string;
  }> | null> {
    return this.transaction(async (client) => {
      const recent = await client.query<{
        user_id: string;
        purpose: string;
        subject_value: string;
      }>(
        `SELECT user_id::text, purpose, subject_value
           FROM zuocheng.consume_verification_value($1)`,
        [recentAuthDigest],
      );
      const proof = recent.rows[0];
      if (
        proof === undefined ||
        proof.user_id !== principal.userId ||
        proof.purpose !== 'recent_auth' ||
        proof.subject_value !==
          `${principal.userId}:account-deletion`
      ) {
        return null;
      }
      const result = await client.query<
        DeletionRow & { email: string }
      >(
        `WITH created AS (
           INSERT INTO zuocheng.account_deletion_request
             (user_id, requested_by_session_id, confirmation_token_hash,
              status, scheduled_for)
           VALUES (
             $1, $2, $3, 'pending_confirmation',
             now() + interval '7 days'
           )
           RETURNING
             id, user_id, status, requested_at, scheduled_for,
             irreversible_at, completed_at
         )
         SELECT
           created.id::text,
           created.status,
           created.requested_at,
           created.scheduled_for,
           created.irreversible_at,
           created.completed_at,
           account_user.email
         FROM created
         JOIN zuocheng."user" AS account_user
           ON account_user.id = created.user_id`,
        [principal.userId, principal.sessionId, confirmationDigest],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        deletion: mapDeletion(row),
        email: row.email,
        confirmationDigest,
      };
    });
  }

  abortAccountDeletion(
    principal: IdentityPrincipal,
    deletionId: UUIDv7,
  ): Promise<void> {
    return this.transaction(async (client) => {
      await client.query(
        `UPDATE zuocheng.account_deletion_request
            SET status = 'rejected',
                cancelled_at = now(),
                failure_code = 'EMAIL_DELIVERY_UNCONFIRMED',
                updated_at = now()
          WHERE user_id = $1
            AND id = $2
            AND status = 'pending_confirmation'`,
        [principal.userId, deletionId],
      );
    });
  }

  getAccountDeletion(
    principal: IdentityPrincipal,
  ): Promise<AccountDeletionView | null> {
    return this.transaction(async (client) => {
      const result = await client.query<DeletionRow>(
        `SELECT
           id::text, status, requested_at, scheduled_for,
           irreversible_at, completed_at
         FROM zuocheng.account_deletion_request
        WHERE user_id = $1
        ORDER BY requested_at DESC
        LIMIT 1`,
        [principal.userId],
      );
      return result.rows[0] === undefined
        ? null
        : mapDeletion(result.rows[0]);
    });
  }

  cancelAccountDeletion(
    principal: IdentityPrincipal,
  ): Promise<AccountDeletionView | null> {
    return this.transaction(async (client) => {
      const result = await client.query<DeletionRow>(
        `UPDATE zuocheng.account_deletion_request
            SET status = 'cancelled',
                cancelled_at = now(),
                updated_at = now()
          WHERE user_id = $1
            AND status IN ('pending_confirmation', 'pending')
            AND irreversible_at IS NULL
        RETURNING
          id::text, status, requested_at, scheduled_for,
          irreversible_at, completed_at`,
        [principal.userId],
      );
      return result.rows[0] === undefined
        ? null
        : mapDeletion(result.rows[0]);
    });
  }

  confirmAccountDeletionAndRevoke(
    principal: IdentityPrincipal,
    deletionId: UUIDv7,
    confirmationDigest: string,
  ): Promise<Readonly<{
    deletion: AccountDeletionView;
    revokedSessionIds: readonly UUIDv7[];
  }> | null> {
    return this.transaction(async (client) => {
      const result = await client.query<
        DeletionRow & { revoked_session_ids: string[] }
      >(
        `WITH confirmed_deletion AS (
           UPDATE zuocheng.account_deletion_request
              SET status = 'processing',
                  confirmed_at = COALESCE(confirmed_at, now()),
                  irreversible_at = COALESCE(irreversible_at, now()),
                  updated_at = now()
            WHERE user_id = $1
              AND id = $2
              AND confirmation_token_hash = $3
              AND (
                (
                  status = 'pending_confirmation'
                  AND confirmation_expires_at > now()
                )
                OR (
                  status = 'processing'
                  AND irreversible_at IS NOT NULL
                )
              )
          RETURNING
            id, user_id, status, requested_at, scheduled_for,
            irreversible_at, completed_at
         ),
         revoked_sessions AS (
           UPDATE zuocheng.session AS identity_session
              SET revoked_at = COALESCE(identity_session.revoked_at, now()),
                  revocation_reason = COALESCE(
                    identity_session.revocation_reason,
                    'account_deletion'
                  ),
                  updated_at = now()
            WHERE identity_session.user_id = $1
              AND EXISTS (SELECT 1 FROM confirmed_deletion)
          RETURNING identity_session.id
         ),
         revoked_passkeys AS (
           UPDATE zuocheng.passkey AS passkey
              SET revoked_at = COALESCE(passkey.revoked_at, now()),
                  revocation_reason = COALESCE(
                    passkey.revocation_reason,
                    'account_deletion'
                  ),
                  updated_at = now()
            WHERE passkey.user_id = $1
              AND EXISTS (SELECT 1 FROM confirmed_deletion)
          RETURNING passkey.id
         ),
         revoked_accounts AS (
           UPDATE zuocheng.account AS account
              SET revoked_at = COALESCE(account.revoked_at, now()),
                  updated_at = now()
            WHERE account.user_id = $1
              AND EXISTS (SELECT 1 FROM confirmed_deletion)
          RETURNING account.id
         ),
         suspended_user AS (
           UPDATE zuocheng."user" AS account_user
              SET account_status = 'deletion_pending',
                  status_changed_at = now(),
                  updated_at = now()
            WHERE account_user.id = $1
              AND account_user.account_status = 'active'
              AND EXISTS (SELECT 1 FROM confirmed_deletion)
          RETURNING account_user.id
         )
         SELECT
           confirmed_deletion.id::text,
           confirmed_deletion.status,
           confirmed_deletion.requested_at,
           confirmed_deletion.scheduled_for,
           confirmed_deletion.irreversible_at,
           confirmed_deletion.completed_at,
           COALESCE(
             (
               SELECT array_agg(revoked_sessions.id::text)
               FROM revoked_sessions
             ),
             ARRAY[]::text[]
           ) AS revoked_session_ids
         FROM confirmed_deletion`,
        [principal.userId, deletionId, confirmationDigest],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        deletion: mapDeletion(row),
        revokedSessionIds: row.revoked_session_ids as UUIDv7[],
      };
    });
  }

  private revokeSessions(
    principal: IdentityPrincipal,
    predicate: string,
    values: readonly unknown[],
    reason: string,
  ): Promise<readonly UUIDv7[]> {
    return this.transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `UPDATE zuocheng.session AS identity_session
            SET revoked_at = now(),
                revocation_reason = $${values.length + 1},
                updated_at = now()
          WHERE identity_session.user_id = $1
            AND ${predicate}
            AND identity_session.revoked_at IS NULL
        RETURNING identity_session.id::text`,
        [...values, reason],
      );
      return result.rows.map((row) => row.id as UUIDv7);
    });
  }

  private async transaction<Result>(
    operation: (client: SqlClient) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    let destroy = false;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE zuocheng_auth');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroy = true;
      }
      throw error;
    } finally {
      client.release(destroy);
    }
  }
}

function sessionSelect(): string {
  return `SELECT
    identity_session.id::text,
    identity_session.user_id::text,
    identity_session.device_public_id::text,
    identity_session.created_at,
    identity_session.last_seen_at,
    identity_session.expires_at,
    identity_session.revoked_at
   FROM zuocheng.session AS identity_session`;
}

function mapSession(
  row: SessionRow,
  currentSessionId: UUIDv7,
): IdentitySessionView {
  return {
    id: row.id as UUIDv7,
    userId: row.user_id as UUIDv7,
    deviceId: row.device_public_id as UUIDv7,
    createdAt: iso(row.created_at),
    lastSeenAt: iso(row.last_seen_at),
    expiresAt: iso(row.expires_at),
    current: row.id === currentSessionId,
    revokedAt: row.revoked_at === null ? null : iso(row.revoked_at),
  };
}

function mapExport(row: ExportRow): AccountExportView {
  return {
    id: row.id as UUIDv7,
    status: exportStatus(row.status),
    requestedAt: iso(row.requested_at),
    completedAt:
      row.completed_at === null ? null : iso(row.completed_at),
    expiresAt: row.expires_at === null ? null : iso(row.expires_at),
    downloadUrl: row.artifact_url,
    sha256: row.artifact_sha256,
  };
}

function mapDeletion(row: DeletionRow): AccountDeletionView {
  const status = deletionStatus(row.status);
  return {
    id: row.id as UUIDv7,
    status,
    requestedAt: iso(row.requested_at),
    cancellableUntil:
      status === 'pending' && row.irreversible_at === null
        ? row.scheduled_for === null
          ? null
          : iso(row.scheduled_for)
        : null,
    irreversibleAt:
      row.irreversible_at === null ? null : iso(row.irreversible_at),
    completedAt:
      row.completed_at === null ? null : iso(row.completed_at),
  };
}

function exportStatus(value: string): AccountExportStatus {
  if (
    value === 'pending' ||
    value === 'processing' ||
    value === 'ready' ||
    value === 'failed' ||
    value === 'expired'
  ) {
    return value;
  }
  throw new Error('Unexpected account export status');
}

function deletionStatus(value: string): AccountDeletionStatus {
  if (value === 'pending_confirmation' || value === 'pending') {
    return 'pending';
  }
  if (
    value === 'cancelled' ||
    value === 'processing' ||
    value === 'completed'
  ) {
    return value;
  }
  if (value === 'rejected') return 'failed';
  throw new Error('Unexpected account deletion status');
}

function parseExportSnapshot(value: unknown): AccountExportSnapshot {
  const object = jsonObject(value);
  const account = jsonObject(object.account);
  if (
    typeof account.id !== 'string' ||
    typeof account.email !== 'string' ||
    typeof account.displayName !== 'string'
  ) {
    throw new Error('Account export projection omitted account identity');
  }
  return {
    account: {
      id: account.id as UUIDv7,
      email: account.email,
      displayName: account.displayName,
      ...(typeof account.accountStatus === 'string'
        ? { accountStatus: account.accountStatus }
        : {}),
      ...(typeof account.createdAt === 'string'
        ? { createdAt: account.createdAt }
        : {}),
      ...(typeof account.updatedAt === 'string'
        ? { updatedAt: account.updatedAt }
        : {}),
    },
    memberships: jsonArray(object.memberships),
    projects: jsonArray(object.projects),
    versions: jsonArray(object.versions),
    audit: jsonArray(object.audit),
    courses: jsonArray(object.courses),
    usage: jsonArray(object.usage),
    ledger: jsonArray(object.ledger),
  };
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed =
    typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error('Expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function jsonArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected a JSON array');
  return value;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requiredRow<Row extends QueryResultRow>(
  result: QueryResult<Row>,
  operation: string,
): Row {
  const row = result.rows[0];
  if (row === undefined) throw new Error(`${operation} returned no row`);
  return row;
}

async function requireAffected(
  operation: Promise<QueryResult>,
  name: string,
): Promise<void> {
  const result = await operation;
  if (result.rowCount !== 1) {
    throw new Error(`${name} affected no row`);
  }
}

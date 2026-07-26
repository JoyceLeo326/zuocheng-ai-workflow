import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { IdentityPrincipal } from '../http/identity-lifecycle-service.js';
import { PostgresIdentityLifecycleRepository } from './postgres-identity-lifecycle-repository.js';

const USER_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a2';
const SESSION_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a3';
const DEVICE_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a4';
const DELETION_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a5';
const principal: IdentityPrincipal = {
  userId: USER_ID,
  sessionId: SESSION_ID,
};

function pool(
  implementation: (
    sql: string,
    values: readonly unknown[] | undefined,
  ) => { rows: unknown[]; rowCount?: number },
) {
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) =>
    implementation(sql, values),
  );
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return {
    pool: { connect } as unknown as Pool,
    query,
    release,
  };
}

describe('Postgres identity lifecycle repository', () => {
  it('claims only digest-keyed idempotency records under the auth role', async () => {
    const database = pool((sql) => {
      if (sql.includes('INSERT INTO zuocheng.identity_idempotency')) {
        return { rows: [{ inserted: true }], rowCount: 1 };
      }
      return { rows: [] };
    });
    const repository = new PostgresIdentityLifecycleRepository(database.pool);

    await expect(
      repository.claimIdempotency({
        actorScope: USER_ID,
        operation: 'account-export-request',
        keyDigest: 'a'.repeat(64),
        requestDigest: 'b'.repeat(64),
      }),
    ).resolves.toEqual({ kind: 'claimed' });

    expect(database.query).toHaveBeenCalledWith(
      'SET LOCAL ROLE zuocheng_auth',
    );
    const insert = database.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO zuocheng.identity_idempotency'),
    );
    expect(insert?.[0]).not.toContain(USER_ID);
    expect(insert?.[1]).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/u),
      'account-export-request',
      'a'.repeat(64),
      'b'.repeat(64),
    ]);
  });

  it('maps only a principal-owned session and exposes its public device id', async () => {
    const database = pool((sql) => {
      if (sql.includes('FROM zuocheng.session')) {
        return {
          rows: [
            {
              id: SESSION_ID,
              user_id: USER_ID,
              device_public_id: DEVICE_ID,
              created_at: new Date('2026-07-26T07:30:00.000Z'),
              last_seen_at: new Date('2026-07-26T08:30:00.000Z'),
              expires_at: new Date('2026-08-02T08:30:00.000Z'),
              revoked_at: null,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = new PostgresIdentityLifecycleRepository(database.pool);

    await expect(repository.getCurrentSession(principal)).resolves.toEqual({
      id: SESSION_ID,
      userId: USER_ID,
      deviceId: DEVICE_ID,
      createdAt: '2026-07-26T07:30:00.000Z',
      lastSeenAt: '2026-07-26T08:30:00.000Z',
      expiresAt: '2026-08-02T08:30:00.000Z',
      current: true,
      revokedAt: null,
    });
    const select = database.query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM zuocheng.session'),
    );
    expect(select?.[1]).toEqual([USER_ID, SESSION_ID]);
  });

  it('atomically consumes confirmation and revokes sessions, passkeys, OAuth accounts and the active user', async () => {
    const database = pool((sql) => {
      if (sql.includes('confirmed_deletion AS')) {
        return {
          rows: [
            {
              id: DELETION_ID,
              status: 'processing',
              requested_at: new Date('2026-07-26T08:30:00.000Z'),
              irreversible_at: new Date('2026-07-26T08:31:00.000Z'),
              completed_at: null,
              revoked_session_ids: [SESSION_ID],
            },
          ],
        };
      }
      return { rows: [] };
    });
    const repository = new PostgresIdentityLifecycleRepository(database.pool);

    await expect(
      repository.confirmAccountDeletionAndRevoke(
        principal,
        DELETION_ID,
        'c'.repeat(64),
      ),
    ).resolves.toMatchObject({
      deletion: {
        id: DELETION_ID,
        status: 'processing',
      },
      revokedSessionIds: [SESSION_ID],
    });

    const mutation = database.query.mock.calls.find(([sql]) =>
      String(sql).includes('confirmed_deletion AS'),
    );
    expect(mutation?.[0]).toMatch(
      /UPDATE zuocheng\.session[\s\S]*UPDATE zuocheng\.passkey[\s\S]*UPDATE zuocheng\.account[\s\S]*UPDATE zuocheng\."user"/u,
    );
    expect(mutation?.[1]).toEqual([
      USER_ID,
      DELETION_ID,
      'c'.repeat(64),
    ]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { SqlClient, TenantPoolProvider } from '../projects/postgres-project-store.js';
import { PostgresMembershipRepository } from './postgres-membership-repository.js';

const TENANT_ID = '01890f3e-b6e8-7cc2-98c0-7c9a2fe4f5d1';
const USER_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a2';
const MEMBERSHIP_ID = '01890f3e-b6e8-7a12-8d98-5b82e8cc46a2';

function createRepository(identity = { tenant_id: TENANT_ID, user_id: USER_ID }) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('current_session_tenant_id')) {
      return { rows: [identity], rowCount: 1 };
    }
    if (sql.includes('FROM zuocheng.membership')) {
      return {
        rows: [
          {
            id: MEMBERSHIP_ID,
            tenant_id: TENANT_ID,
            user_id: USER_ID,
            status: 'active',
            deleted_at: null,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: null };
  });
  const client = { query, release: vi.fn() } as unknown as SqlClient;
  const pools: TenantPoolProvider = {
    poolForContext: vi.fn(() => ({
      connect: vi.fn(async () => client),
    })),
  };
  return {
    client,
    pools,
    query,
    repository: new PostgresMembershipRepository(pools),
  };
}

describe('PostgresMembershipRepository', () => {
  it('reads membership only after the database login proves the tenant and user identity', async () => {
    const { client, pools, query, repository } = createRepository();

    await expect(
      repository.findActive({ tenantId: TENANT_ID, userId: USER_ID }),
    ).resolves.toEqual({
      id: MEMBERSHIP_ID,
      tenantId: TENANT_ID,
      userId: USER_ID,
      status: 'active',
      deletedAt: null,
    });

    expect(pools.poolForContext).toHaveBeenCalledWith(TENANT_ID, USER_ID);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SET LOCAL ROLE zuocheng_app',
      "SELECT set_config('zuocheng.current_tenant_id', $1, true)",
      expect.stringContaining('current_session_tenant_id'),
      expect.stringContaining('FROM zuocheng.membership'),
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('returns no membership when the customer pool resolves a different principal', async () => {
    const { query, repository } = createRepository({
      tenant_id: TENANT_ID,
      user_id: '01890f3e-b6e8-7b11-8d98-5b82e8cc46a2',
    });

    await expect(
      repository.findActive({ tenantId: TENANT_ID, userId: USER_ID }),
    ).resolves.toBeNull();
    expect(
      query.mock.calls.some(([sql]) => sql.includes('FROM zuocheng.membership')),
    ).toBe(false);
  });

  it('rolls back and releases the principal-bound client on query failure', async () => {
    const { client, query, repository } = createRepository();
    query.mockImplementationOnce(async () => {
      throw new Error('customer database unavailable');
    });

    await expect(
      repository.findActive({ tenantId: TENANT_ID, userId: USER_ID }),
    ).rejects.toThrow('customer database unavailable');
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('destroys the principal-bound client when rollback also fails', async () => {
    const { client, query, repository } = createRepository();
    query
      .mockImplementationOnce(async () => {
        throw new Error('customer database unavailable');
      })
      .mockImplementationOnce(async () => {
        throw new Error('connection lost during rollback');
      });

    await expect(
      repository.findActive({ tenantId: TENANT_ID, userId: USER_ID }),
    ).rejects.toThrow('customer database unavailable');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledWith(true);
  });
});

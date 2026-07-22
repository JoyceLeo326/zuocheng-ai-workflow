import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  nodePostgresTenantPools,
  PostgresProjectStore,
  type SqlClient,
  type TenantPoolProvider,
} from './postgres-project-store.js';

const TENANT_ID = '01890f3e-b6e8-7cc2-98c0-7c9a2fe4f5d1';
const USER_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a2';
const PROJECT_ID = '01890f3e-b6e8-7a12-8d98-5b82e8cc46a3';

describe('PostgresProjectStore connection lifecycle', () => {
  it('passes a destroy signal through the node-postgres adapter', async () => {
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query: vi.fn(), release })),
    } as unknown as Pool;
    const client = await nodePostgresTenantPools(() => pool)
      .poolForContext(TENANT_ID, USER_ID)
      .connect();

    client.release(true);

    expect(release).toHaveBeenCalledWith(true);
  });

  it('destroys a client whose rollback fails without masking the original error', async () => {
    const storageError = new Error('idempotency storage failed');
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('claim_idempotency_record')) throw storageError;
      if (sql === 'ROLLBACK') throw new Error('connection lost during rollback');
      return { rows: [], rowCount: null };
    });
    const release = vi.fn();
    const client = { query, release } as unknown as SqlClient;
    const pools: TenantPoolProvider = {
      poolForContext: () => ({ connect: async () => client }),
    };
    const store = new PostgresProjectStore(pools);

    await expect(
      store.create({
        tenantId: TENANT_ID,
        actorUserId: USER_ID,
        projectId: PROJECT_ID,
        version: 1,
        name: 'Rollback fault',
        description: null,
        idempotencyKey: 'rollback-fault-key',
        requestHash: 'request-hash',
        occurredAt: '2026-07-23T00:00:00.000Z',
      }),
    ).rejects.toBe(storageError);

    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledWith(true);
  });
});

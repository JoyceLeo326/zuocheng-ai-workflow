import { parseRuntimeEnvironment } from '@zuocheng/config';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import {
  ProductionCompositionError,
  composeApiRuntime,
  type CustomerManagedRuntimeAdapter,
} from './production-composition.js';

const TENANT_ID = '01890f3e-b6e8-7cc2-98c0-7c9a2fe4f5d1';
const USER_ID = '01890f3e-b6e8-7a11-8d98-5b82e8cc46a2';
const MEMBERSHIP_ID = '01890f3e-b6e8-7a12-8d98-5b82e8cc46a2';
const SESSION_ID = '01890f3e-b6e8-7a13-8d98-5b82e8cc46a2';
const REQUEST_ID = '01900000-0000-7000-8000-000000000001';

function createCustomerAdapter(): {
  adapter: CustomerManagedRuntimeAdapter;
  queries: Array<{ sql: string; values: readonly unknown[] }>;
  close: ReturnType<typeof vi.fn>;
} {
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, values: readonly unknown[] = []) {
      queries.push({ sql, values });
      if (sql.includes('current_session_tenant_id')) {
        return {
          rows: [{ tenant_id: TENANT_ID, user_id: USER_ID }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM zuocheng.project AS project')) {
        return { rows: [], rowCount: 0 };
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
    },
    release: vi.fn(),
  };
  const close = vi.fn(async () => undefined);
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return {
    queries,
    close,
    adapter: {
      kind: 'customer-managed-production',
      betterAuth: {
        getSession: vi.fn(async () => ({
          session: {
            id: SESSION_ID,
            userId: USER_ID,
            activeTenantId: TENANT_ID,
            expiresAt: new Date('2026-07-24T00:00:00.000Z'),
          },
          user: { id: USER_ID, accountStatus: 'active' },
        })),
      },
      principalPoolForContext: vi.fn(() => pool),
      checkReadiness: vi.fn(async () => ({
        identity: 'ready' as const,
        database: 'ready' as const,
      })),
      close,
    },
  };
}

function productionConfiguration(module = '@customer/zuocheng-runtime') {
  return parseRuntimeEnvironment({
    DEPLOYMENT_MODE: 'tenant-managed-production',
    TENANT_RUNTIME_ADAPTER_MODULE: module,
  });
}

describe('tenant-managed production composition', () => {
  it('refuses startup without a customer runtime adapter module', async () => {
    await expect(
      composeApiRuntime(
        parseRuntimeEnvironment({
          DEPLOYMENT_MODE: 'tenant-managed-production',
        }),
      ),
    ).rejects.toBeInstanceOf(ProductionCompositionError);
  });

  it('loads real customer boundaries and exposes authenticated project routes', async () => {
    const { adapter, queries } = createCustomerAdapter();
    const importer = vi.fn(async () => ({
      createCustomerManagedRuntimeAdapter: vi.fn(async () => adapter),
    }));
    const runtime = await composeApiRuntime(productionConfiguration(), {
      importer,
      clock: () => new Date('2026-07-23T10:00:00.000Z'),
      createRequestId: () => REQUEST_ID,
    });

    const response = await runtime.app.request('/v1/projects', {
      headers: {
        cookie: '__Host-zuocheng.session_token=opaque-customer-session',
      },
    });

    expect(importer).toHaveBeenCalledWith('@customer/zuocheng-runtime');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: [] });
    expect(queries.some(({ sql }) => sql.includes('FROM zuocheng.membership'))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes('FROM zuocheng.project AS project'))).toBe(true);
  });

  it('uses only the customer adapter readiness result and closes its resources once', async () => {
    const { adapter, close } = createCustomerAdapter();
    const runtime = await composeApiRuntime(productionConfiguration(), {
      importer: async () => ({
        createCustomerManagedRuntimeAdapter: async () => adapter,
      }),
      clock: () => new Date('2026-07-23T10:00:00.000Z'),
      createRequestId: () => REQUEST_ID,
    });

    const ready = await runtime.app.request('/readyz');
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      status: 'ok',
      dependencies: { identity: 'ready', database: 'ready' },
    });

    await runtime.close();
    await runtime.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects malformed customer readiness claims instead of claiming ready', async () => {
    const { adapter } = createCustomerAdapter();
    const malformed = {
      ...adapter,
      checkReadiness: async () => ({
        identity: 'ready',
        database: 'unknown',
      }),
    } as unknown as CustomerManagedRuntimeAdapter;
    const runtime = await composeApiRuntime(productionConfiguration(), {
      importer: async () => ({
        createCustomerManagedRuntimeAdapter: async () => malformed,
      }),
      clock: () => new Date('2026-07-23T10:00:00.000Z'),
      createRequestId: () => REQUEST_ID,
    });

    expect((await runtime.app.request('/readyz')).status).toBe(503);
  });

  it('rejects an invalid adapter export instead of installing production mocks', async () => {
    await expect(
      composeApiRuntime(productionConfiguration(), {
        importer: async () => ({ default: { mock: true } }),
      }),
    ).rejects.toMatchObject({
      name: 'ProductionCompositionError',
      code: 'INVALID_CUSTOMER_RUNTIME_ADAPTER',
    });
  });
});

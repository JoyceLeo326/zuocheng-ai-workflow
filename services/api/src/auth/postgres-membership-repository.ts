import { UUIDv7Schema } from '@zuocheng/contracts';
import { z } from 'zod';
import type {
  SqlClient,
  TenantPoolProvider,
} from '../projects/postgres-project-store.js';
import type { MembershipRepository } from './tenant-session.js';

const DatabaseIdentitySchema = z.strictObject({
  tenant_id: UUIDv7Schema.nullable(),
  user_id: UUIDv7Schema.nullable(),
});

const MembershipRowSchema = z.strictObject({
  id: UUIDv7Schema,
  tenant_id: UUIDv7Schema,
  user_id: UUIDv7Schema,
  status: z.literal('active'),
  deleted_at: z.null(),
});

/**
 * Rechecks membership through the same tenant-and-user-bound database
 * principal used by project persistence. No tenant asserted by HTTP is trusted.
 */
export class PostgresMembershipRepository implements MembershipRepository {
  constructor(private readonly pools: TenantPoolProvider) {}

  async findActive(input: Readonly<{ tenantId: string; userId: string }>) {
    const tenantId = UUIDv7Schema.parse(input.tenantId);
    const userId = UUIDv7Schema.parse(input.userId);
    const client = await this.pools.poolForContext(tenantId, userId).connect();
    let destroyClient = false;

    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE zuocheng_app');
      await client.query(
        "SELECT set_config('zuocheng.current_tenant_id', $1, true)",
        [tenantId],
      );
      const identityResult = await client.query<{
        tenant_id: string | null;
        user_id: string | null;
      }>(
        `SELECT zuocheng.current_session_tenant_id()::text AS tenant_id,
                zuocheng.current_session_user_id()::text AS user_id`,
      );
      const identity = DatabaseIdentitySchema.safeParse(
        identityResult.rows[0],
      );
      if (
        !identity.success ||
        identity.data.tenant_id !== tenantId ||
        identity.data.user_id !== userId
      ) {
        await client.query('COMMIT');
        return null;
      }

      const result = await client.query<{
        id: string;
        tenant_id: string;
        user_id: string;
        status: string;
        deleted_at: null;
      }>(
        `SELECT membership.id::text AS id,
                membership.tenant_id::text AS tenant_id,
                membership.user_id::text AS user_id,
                membership.status,
                membership.deleted_at
           FROM zuocheng.membership AS membership
          WHERE membership.tenant_id = $1
            AND membership.user_id = $2
            AND membership.status = 'active'
            AND membership.deleted_at IS NULL`,
        [tenantId, userId],
      );
      const membership = MembershipRowSchema.safeParse(result.rows[0]);
      await client.query('COMMIT');
      if (!membership.success) return null;
      return {
        id: membership.data.id,
        tenantId: membership.data.tenant_id,
        userId: membership.data.user_id,
        status: membership.data.status,
        deletedAt: membership.data.deleted_at,
      };
    } catch (error) {
      destroyClient = !(await rollbackWithoutMasking(client));
      throw error;
    } finally {
      if (destroyClient) client.release(true);
      else client.release();
    }
  }
}

async function rollbackWithoutMasking(client: SqlClient): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}

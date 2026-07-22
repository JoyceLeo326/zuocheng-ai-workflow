import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('API foundation', () => {
  it('reports readiness without claiming owner-billed infrastructure', async () => {
    const response = await createApp('local').request('/readyz');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      service: 'zuocheng-api',
      status: 'ok',
      deploymentMode: 'local',
      ownerBilling: 'deny',
    });
  });

  it('publishes the immutable cost policy', async () => {
    const response = await createApp('hosted-beta').request(
      '/v1/system/cost-policy',
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      remoteQuotaBehavior: 'fail-closed',
      policy: {
        COST_MODE: 'zero_owner_cost',
        ALLOW_AUTO_UPGRADE: false,
      },
    });
  });

  it('does not claim production readiness before the database exists', async () => {
    const response = await createApp('tenant-managed-production').request(
      '/readyz',
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      dependencies: { database: 'not-configured-until-zc-02' },
    });
  });
});

import { ZERO_OWNER_COST_POLICY } from '@zuocheng/contracts';
import { Hono } from 'hono';
import type { DeploymentMode, HealthStatus } from '@zuocheng/contracts';

export function createApp(deploymentMode: DeploymentMode) {
  const app = new Hono();

  app.get('/livez', (context) => context.json({ status: 'ok' }));

  app.get('/readyz', (context) => {
    if (deploymentMode === 'tenant-managed-production') {
      return context.json(
        {
          service: 'zuocheng-api',
          status: 'degraded',
          deploymentMode,
          ownerBilling: 'deny',
          dependencies: {
            database: 'not-configured-until-zc-02',
          },
          timestamp: new Date().toISOString(),
        },
        503,
      );
    }

    const response: HealthStatus = {
      service: 'zuocheng-api',
      status: 'ok',
      deploymentMode,
      ownerBilling: 'deny',
      timestamp: new Date().toISOString(),
    };
    return context.json(response);
  });

  app.get('/v1/system/cost-policy', (context) =>
    context.json({
      deploymentMode,
      policy: ZERO_OWNER_COST_POLICY,
      remoteQuotaBehavior: 'fail-closed',
    }),
  );

  app.notFound((context) =>
    context.json(
      {
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        code: 'NOT_FOUND',
        requestId: crypto.randomUUID(),
      },
      404,
    ),
  );

  return app;
}

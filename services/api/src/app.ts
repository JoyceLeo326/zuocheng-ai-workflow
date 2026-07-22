import {
  UUIDv7Schema,
  ZERO_OWNER_COST_POLICY,
} from '@zuocheng/contracts';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { DeploymentMode, HealthStatus } from '@zuocheng/contracts';
import {
  mapErrorToProblem,
  notFoundProblem,
  projectServiceUnavailableProblem,
} from './http/problems.js';
import { createUuidV7 } from './http/request-id.js';
import {
  registerProjectRoutes,
  type ProjectRouteResolver,
  type ProjectRouteService,
} from './projects/project-routes.js';

export type ApiEnvironment = {
  Variables: {
    requestId: string;
  };
};

type CreateAppOptions = {
  clock?: () => Date;
  createRequestId?: () => string;
  productionReadinessProbe?: ProductionReadinessProbe;
  tenantSessionResolver?: ProjectRouteResolver;
  projectService?: ProjectRouteService;
};

export type ProductionDependencyStatus = Readonly<{
  identity: 'ready';
  database: 'ready';
}>;

export type ProductionReadinessProbe =
  () => Promise<ProductionDependencyStatus>;

export function createApp(
  deploymentMode: DeploymentMode,
  options: CreateAppOptions = {},
) {
  const clock = options.clock ?? (() => new Date());
  const createRequestId =
    options.createRequestId ?? (() => createUuidV7(clock));
  const app = new Hono<ApiEnvironment>();

  app.use('*', async (context, next) => {
    const requestId = UUIDv7Schema.parse(createRequestId());
    context.set('requestId', requestId);
    await next();
    context.header('X-Request-Id', requestId);
  });

  app.get('/livez', (context) => context.json({ status: 'ok' }));

  app.get('/readyz', async (context) => {
    if (deploymentMode === 'tenant-managed-production') {
      if (options.productionReadinessProbe !== undefined) {
        try {
          const dependencies = await options.productionReadinessProbe();
          return context.json({
            service: 'zuocheng-api',
            status: 'ok',
            deploymentMode,
            ownerBilling: 'deny',
            dependencies,
            timestamp: clock().toISOString(),
          });
        } catch {
          return context.json(
            {
              service: 'zuocheng-api',
              status: 'degraded',
              deploymentMode,
              ownerBilling: 'deny',
              dependencies: {
                identity: 'dependency-probe-failed',
                database: 'dependency-probe-failed',
              },
              timestamp: clock().toISOString(),
            },
            503,
          );
        }
      }
      return context.json(
        {
          service: 'zuocheng-api',
          status: 'degraded',
          deploymentMode,
          ownerBilling: 'deny',
          dependencies: {
            database: 'runtime-database-probe-required',
          },
          timestamp: clock().toISOString(),
        },
        503,
      );
    }

    const response: HealthStatus = {
      service: 'zuocheng-api',
      status: 'ok',
      deploymentMode,
      ownerBilling: 'deny',
      timestamp: clock().toISOString(),
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

  const hasResolver = options.tenantSessionResolver !== undefined;
  const hasProjectService = options.projectService !== undefined;
  if (hasResolver !== hasProjectService) {
    throw new TypeError(
      'Project routes require both a tenant session resolver and a project service',
    );
  }
  if (
    options.tenantSessionResolver !== undefined &&
    options.projectService !== undefined
  ) {
    registerProjectRoutes(app, {
      resolver: options.tenantSessionResolver,
      service: options.projectService,
    });
  } else {
    const unavailable = (context: Context<ApiEnvironment>) =>
      context.json(
        projectServiceUnavailableProblem(context.get('requestId')),
        503,
        { 'Content-Type': 'application/problem+json' },
      );
    app.all('/v1/projects', unavailable);
    app.all('/v1/projects/*', unavailable);
  }

  app.onError((error, context) => {
    const problem = mapErrorToProblem(error, context.get('requestId'));
    return context.json(problem.body, problem.status, {
      'Content-Type': 'application/problem+json',
    });
  });

  app.notFound((context) =>
    context.json(notFoundProblem(context.get('requestId')), 404, {
      'Content-Type': 'application/problem+json',
    }),
  );

  return app;
}

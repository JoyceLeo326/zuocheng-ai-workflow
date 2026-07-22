import type { Hono, MiddlewareHandler } from 'hono';
import {
  assertNoClientTenantOverride,
  type TenantSessionResolver,
} from '../auth/tenant-session.js';
import {
  parseRequiredIdempotencyKey,
  parseRequiredIfMatch,
} from '../http/preconditions.js';
import { readBoundedJsonBody } from '../http/request-body.js';
import {
  type ProjectService,
  type TenantContext,
} from './project-service.js';

type ProjectRouteEnvironment = {
  Variables: {
    requestId: string;
  };
};

export type ProjectRouteResolver = Pick<TenantSessionResolver, 'resolve'>;
export type ProjectRouteService = Pick<
  ProjectService,
  | 'create'
  | 'list'
  | 'get'
  | 'update'
  | 'copy'
  | 'archive'
  | 'softDelete'
  | 'restore'
  | 'requestPermanentDelete'
>;

export type ProjectRouteDependencies = Readonly<{
  resolver: ProjectRouteResolver;
  service: ProjectRouteService;
}>;

export function registerProjectRoutes(
  app: Hono<ProjectRouteEnvironment>,
  dependencies: ProjectRouteDependencies,
): void {
  const privateProjectResponse: MiddlewareHandler<ProjectRouteEnvironment> = async (
    routeContext,
    next,
  ) => {
    try {
      await next();
    } finally {
      routeContext.header('Cache-Control', 'private, no-store');
      routeContext.header('Vary', 'Cookie, Authorization');
    }
  };
  app.use('/v1/projects', privateProjectResponse);
  app.use('/v1/projects/*', privateProjectResponse);

  app.post('/v1/projects', async (routeContext) => {
    const tenant = await resolveTenant(routeContext.req.raw, undefined, dependencies);
    const idempotencyKey = requiredIdempotencyKey(routeContext.req.raw);
    const body = await readBoundedJsonBody(routeContext.req.raw);
    assertNoClientTenantOverride({ body });
    const project = await dependencies.service.create(
      tenant,
      body,
      idempotencyKey,
    );
    return routeContext.json(project, 201, {
      ETag: project.etag,
      Location: `/v1/projects/${project.id}`,
    });
  });

  app.get('/v1/projects', async (routeContext) => {
    const tenant = await resolveTenant(
      routeContext.req.raw,
      undefined,
      dependencies,
    );
    const projects = await dependencies.service.list(tenant);
    return routeContext.json({ data: projects });
  });

  app.get('/v1/projects/:id', async (routeContext) => {
    const tenant = await resolveTenant(
      routeContext.req.raw,
      undefined,
      dependencies,
    );
    const project = await dependencies.service.get(
      tenant,
      routeContext.req.param('id'),
    );
    return routeContext.json(project, 200, { ETag: project.etag });
  });

  app.patch('/v1/projects/:id', async (routeContext) => {
    const tenant = await resolveTenant(routeContext.req.raw, undefined, dependencies);
    const preconditions = requiredExistingMutationHeaders(
      routeContext.req.raw,
    );
    const body = await readBoundedJsonBody(routeContext.req.raw);
    assertNoClientTenantOverride({ body });
    const project = await dependencies.service.update(
      tenant,
      routeContext.req.param('id'),
      body,
      preconditions.ifMatch,
      preconditions.idempotencyKey,
    );
    return routeContext.json(project, 200, { ETag: project.etag });
  });

  app.post('/v1/projects/:id/copies', async (routeContext) => {
    const tenant = await resolveTenant(routeContext.req.raw, undefined, dependencies);
    const preconditions = requiredExistingMutationHeaders(
      routeContext.req.raw,
    );
    const body = await readBoundedJsonBody(routeContext.req.raw);
    assertNoClientTenantOverride({ body });
    const project = await dependencies.service.copy(
      tenant,
      routeContext.req.param('id'),
      body,
      preconditions.ifMatch,
      preconditions.idempotencyKey,
    );
    return routeContext.json(project, 201, {
      ETag: project.etag,
      Location: `/v1/projects/${project.id}`,
    });
  });

  app.post('/v1/projects/:id/archive', async (routeContext) => {
    const tenant = await resolveTenant(
      routeContext.req.raw,
      undefined,
      dependencies,
    );
    const preconditions = requiredExistingMutationHeaders(
      routeContext.req.raw,
    );
    const project = await dependencies.service.archive(
      tenant,
      routeContext.req.param('id'),
      preconditions.ifMatch,
      preconditions.idempotencyKey,
    );
    return routeContext.json(project, 200, { ETag: project.etag });
  });

  app.post('/v1/projects/:id/restore', async (routeContext) => {
    const tenant = await resolveTenant(
      routeContext.req.raw,
      undefined,
      dependencies,
    );
    const preconditions = requiredExistingMutationHeaders(
      routeContext.req.raw,
    );
    const project = await dependencies.service.restore(
      tenant,
      routeContext.req.param('id'),
      preconditions.ifMatch,
      preconditions.idempotencyKey,
    );
    return routeContext.json(project, 200, { ETag: project.etag });
  });

  app.delete('/v1/projects/:id', async (routeContext) => {
    const tenant = await resolveTenant(
      routeContext.req.raw,
      undefined,
      dependencies,
    );
    const preconditions = requiredExistingMutationHeaders(
      routeContext.req.raw,
    );
    const project = await dependencies.service.softDelete(
      tenant,
      routeContext.req.param('id'),
      preconditions.ifMatch,
      preconditions.idempotencyKey,
    );
    return routeContext.json(project, 200, { ETag: project.etag });
  });

  app.delete('/v1/projects/:id/permanent', async (routeContext) => {
    const tenant = await resolveTenant(
      routeContext.req.raw,
      undefined,
      dependencies,
    );
    const preconditions = requiredExistingMutationHeaders(
      routeContext.req.raw,
    );
    const result = await dependencies.service.requestPermanentDelete(
      tenant,
      routeContext.req.param('id'),
      preconditions.ifMatch,
      preconditions.idempotencyKey,
    );
    return routeContext.json(result, 202, { ETag: result.project.etag });
  });
}

async function resolveTenant(
  request: Request,
  body: unknown,
  dependencies: ProjectRouteDependencies,
): Promise<TenantContext> {
  const authorization = request.headers.get('authorization');
  const cookie = request.headers.get('cookie');
  return dependencies.resolver.resolve({
    ...(authorization === null ? {} : { authorization }),
    ...(cookie === null ? {} : { cookie }),
    headers: Object.fromEntries(request.headers.entries()),
    ...(body === undefined ? {} : { body }),
  });
}

function requiredIdempotencyKey(request: Request): string {
  return parseRequiredIdempotencyKey(
    request.headers.get('idempotency-key') ?? undefined,
  );
}

function requiredExistingMutationHeaders(request: Request): {
  idempotencyKey: string;
  ifMatch: string;
} {
  const idempotencyKey = requiredIdempotencyKey(request);
  const ifMatch = request.headers.get('if-match') ?? undefined;
  parseRequiredIfMatch(ifMatch);
  return { idempotencyKey, ifMatch: ifMatch as string };
}

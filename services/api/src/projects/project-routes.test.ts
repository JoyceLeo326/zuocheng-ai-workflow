import { ProblemDetailsSchema, type UUIDv7 } from '@zuocheng/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthenticationRequiredError,
  TenantOverrideForbiddenError,
} from '../auth/tenant-session.js';
import { createApp } from '../app.js';
import type {
  ProjectRouteResolver,
  ProjectRouteService,
} from './project-routes.js';
import { ProjectServiceError, type ProjectRecord } from './project-service.js';

const REQUEST_ID = '01900000-0000-7000-8000-000000000001';
const TENANT_ID = '01900000-0000-7000-8000-000000000002' as UUIDv7;
const USER_ID = '01900000-0000-7000-8000-000000000003' as UUIDv7;
const MEMBERSHIP_ID = '01900000-0000-7000-8000-000000000004' as UUIDv7;
const SESSION_ID = '01900000-0000-7000-8000-000000000005' as UUIDv7;
const PROJECT_ID = '01900000-0000-7000-8000-000000000006';
const OTHER_PROJECT_ID = '01900000-0000-7000-8000-000000000007';
const COPIED_PROJECT_ID = '01900000-0000-7000-8000-000000000008';
const TASK_ID = '01900000-0000-7000-8000-000000000009';
const IDEMPOTENCY_KEY = 'project-route-key-0001';

const context = {
  tenantId: TENANT_ID,
  userId: USER_ID,
  membershipId: MEMBERSHIP_ID,
  sessionId: SESSION_ID,
};

function project(
  overrides: Partial<ProjectRecord> = {},
): ProjectRecord {
  return {
    id: PROJECT_ID,
    tenantId: TENANT_ID,
    version: 3,
    etag: '"3"',
    name: '课程证据项目',
    description: null,
    status: 'active',
    deletionStatus: 'active',
    copiedFromProjectId: null,
    createdBy: USER_ID,
    updatedBy: USER_ID,
    createdAt: '2026-07-23T09:30:00.000Z',
    updatedAt: '2026-07-23T09:30:00.000Z',
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function createResolver(
  implementation?: ProjectRouteResolver['resolve'],
): ProjectRouteResolver & { resolve: ReturnType<typeof vi.fn> } {
  return {
    resolve: vi.fn(
      implementation ??
        (async () => context),
    ),
  };
}

function createService(): ProjectRouteService & Record<string, ReturnType<typeof vi.fn>> {
  const current = project();
  const copied = project({
    id: COPIED_PROJECT_ID,
    copiedFromProjectId: PROJECT_ID,
    version: 1,
    etag: '"1"',
  });
  const archived = project({
    status: 'archived',
    archivedAt: '2026-07-23T09:31:00.000Z',
  });
  const deleted = project({
    deletionStatus: 'soft_deleted',
    deletedAt: '2026-07-23T09:32:00.000Z',
  });
  const pending = project({
    deletionStatus: 'purge_pending',
    deletedAt: '2026-07-23T09:32:00.000Z',
  });
  return {
    create: vi.fn(async () => current),
    list: vi.fn(async () => [current]),
    get: vi.fn(async () => current),
    update: vi.fn(async () => current),
    copy: vi.fn(async () => copied),
    archive: vi.fn(async () => archived),
    softDelete: vi.fn(async () => deleted),
    restore: vi.fn(async () => current),
    requestPermanentDelete: vi.fn(async () => ({
      project: pending,
      deletionTask: {
        id: TASK_ID,
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        status: 'purge_pending' as const,
        requestedBy: USER_ID,
        requestedAt: '2026-07-23T09:33:00.000Z',
      },
    })),
  };
}

function testApp(
  resolver: ProjectRouteResolver = createResolver(),
  service: ProjectRouteService = createService(),
) {
  return createApp('local', {
    clock: () => new Date('2026-07-23T09:30:00.000Z'),
    createRequestId: () => REQUEST_ID,
    tenantSessionResolver: resolver,
    projectService: service,
  });
}

const mutationHeaders = {
  Authorization: 'Bearer verified-session',
  Cookie: 'session=verified',
  'Idempotency-Key': IDEMPOTENCY_KEY,
  'If-Match': '"3"',
};

describe('project routes', () => {
  it('connects every project operation to one trusted resolver call and emits canonical status and resource headers', async () => {
    const resolver = createResolver();
    const service = createService();
    const app = testApp(resolver, service);

    const responses = await Promise.all([
      app.request('/v1/projects', {
        method: 'POST',
        headers: {
          Authorization: mutationHeaders.Authorization,
          Cookie: mutationHeaders.Cookie,
          'Content-Type': 'application/json',
          'Idempotency-Key': IDEMPOTENCY_KEY,
        },
        body: JSON.stringify({ name: '课程证据项目' }),
      }),
      app.request('/v1/projects', {
        headers: { Authorization: mutationHeaders.Authorization },
      }),
      app.request(`/v1/projects/${PROJECT_ID}`, {
        headers: { Authorization: mutationHeaders.Authorization },
      }),
      app.request(`/v1/projects/${PROJECT_ID}`, {
        method: 'PATCH',
        headers: { ...mutationHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '更新后的名称' }),
      }),
      app.request(`/v1/projects/${PROJECT_ID}/copies`, {
        method: 'POST',
        headers: { ...mutationHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '项目副本' }),
      }),
      app.request(`/v1/projects/${PROJECT_ID}/archive`, {
        method: 'POST',
        headers: mutationHeaders,
      }),
      app.request(`/v1/projects/${PROJECT_ID}/restore`, {
        method: 'POST',
        headers: mutationHeaders,
      }),
      app.request(`/v1/projects/${PROJECT_ID}`, {
        method: 'DELETE',
        headers: mutationHeaders,
      }),
      app.request(`/v1/projects/${PROJECT_ID}/permanent`, {
        method: 'DELETE',
        headers: mutationHeaders,
      }),
    ]);

    expect(resolver.resolve).toHaveBeenCalledTimes(9);
    expect(resolver.resolve).toHaveBeenCalledWith({
      authorization: 'Bearer verified-session',
      cookie: 'session=verified',
      headers: expect.objectContaining({
        authorization: 'Bearer verified-session',
        'idempotency-key': IDEMPOTENCY_KEY,
      }),
    });

    expect(responses.map((response) => response.status)).toEqual([
      201, 200, 200, 200, 201, 200, 200, 200, 202,
    ]);
    expect(responses[0]?.headers.get('location')).toBe(
      `/v1/projects/${PROJECT_ID}`,
    );
    expect(responses[0]?.headers.get('etag')).toBe('"3"');
    expect(responses[2]?.headers.get('etag')).toBe('"3"');
    expect(responses[4]?.headers.get('location')).toBe(
      `/v1/projects/${COPIED_PROJECT_ID}`,
    );
    expect(responses[4]?.headers.get('etag')).toBe('"1"');
    expect(responses[8]?.headers.get('etag')).toBe('"3"');
    await expect(responses[1]?.json()).resolves.toEqual({
      data: [project()],
    });

    expect(service.create).toHaveBeenCalledWith(
      context,
      { name: '课程证据项目' },
      IDEMPOTENCY_KEY,
    );
    expect(service.update).toHaveBeenCalledWith(
      context,
      PROJECT_ID,
      { name: '更新后的名称' },
      '"3"',
      IDEMPOTENCY_KEY,
    );
    expect(service.requestPermanentDelete).toHaveBeenCalledWith(
      context,
      PROJECT_ID,
      '"3"',
      IDEMPOTENCY_KEY,
    );
  });

  it('requires idempotency for every mutation and If-Match for existing resources', async () => {
    const resolver = createResolver();
    const service = createService();
    const app = testApp(resolver, service);
    const existingMutations = [
      ['PATCH', `/v1/projects/${PROJECT_ID}`, { name: '新名称' }],
      ['POST', `/v1/projects/${PROJECT_ID}/copies`, {}],
      ['POST', `/v1/projects/${PROJECT_ID}/archive`, undefined],
      ['POST', `/v1/projects/${PROJECT_ID}/restore`, undefined],
      ['DELETE', `/v1/projects/${PROJECT_ID}`, undefined],
      ['DELETE', `/v1/projects/${PROJECT_ID}/permanent`, undefined],
    ] as const;

    const createWithoutKey = await app.request('/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '缺少键' }),
    });
    expect(createWithoutKey.status).toBe(428);
    await expect(createWithoutKey.json()).resolves.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });

    for (const [method, path, body] of existingMutations) {
      const withoutKey = await app.request(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'If-Match': '"3"',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(withoutKey.status, `${method} ${path}`).toBe(428);
      await expect(withoutKey.json()).resolves.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
      });

      const withoutIfMatch = await app.request(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': IDEMPOTENCY_KEY,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(withoutIfMatch.status, `${method} ${path}`).toBe(428);
      await expect(withoutIfMatch.json()).resolves.toMatchObject({
        code: 'PRECONDITION_REQUIRED',
      });
    }

    for (const operation of Object.values(service)) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it('passes the single parsed body to the resolver so tenant overrides are rejected before the service', async () => {
    const resolver = createResolver(async (request) => {
      if (
        request.body !== null &&
        typeof request.body === 'object' &&
        Object.prototype.hasOwnProperty.call(request.body, 'tenantId')
      ) {
        throw new TenantOverrideForbiddenError();
      }
      return context;
    });
    const service = createService();
    const response = await testApp(resolver, service).request('/v1/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': IDEMPOTENCY_KEY,
      },
      body: JSON.stringify({ name: '越权项目', tenantId: TENANT_ID }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'TENANT_OVERRIDE_FORBIDDEN',
    });
    expect(resolver.resolve).toHaveBeenCalledOnce();
    expect(service.create).not.toHaveBeenCalled();
  });

  it('maps malformed JSON to a safe 422 problem without leaking parser details', async () => {
    const response = await testApp().request('/v1/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': IDEMPOTENCY_KEY,
      },
      body: '{"name":',
    });

    expect(response.status).toBe(422);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain('VALIDATION_FAILED');
    expect(serialized).not.toMatch(/SyntaxError|Unexpected end|JSON/u);
  });

  it('authenticates and validates mutation preconditions before consuming JSON', async () => {
    const unauthenticatedResolver = createResolver(async () => {
      throw new AuthenticationRequiredError();
    });
    const service = createService();
    const unauthenticated = await testApp(
      unauthenticatedResolver,
      service,
    ).request('/v1/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': IDEMPOTENCY_KEY,
      },
      body: '{"name":',
    });

    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('cache-control')).toBe(
      'private, no-store',
    );
    expect(unauthenticated.headers.get('vary')).toBe(
      'Cookie, Authorization',
    );
    expect(unauthenticatedResolver.resolve).toHaveBeenCalledOnce();
    expect(service.create).not.toHaveBeenCalled();

    const missingPrecondition = await testApp().request('/v1/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":',
    });
    expect(missingPrecondition.status).toBe(428);
    await expect(missingPrecondition.json()).resolves.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
  });

  it('rejects unsupported media types, declared oversize, and streamed oversize bodies', async () => {
    const unsupported = await testApp().request('/v1/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Idempotency-Key': IDEMPOTENCY_KEY,
      },
      body: '{"name":"plain text"}',
    });
    expect(unsupported.status).toBe(415);
    await expect(unsupported.json()).resolves.toMatchObject({
      code: 'UNSUPPORTED_MEDIA_TYPE',
    });

    const declaredOversize = await testApp().request('/v1/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '999999999',
        'Idempotency-Key': IDEMPOTENCY_KEY,
      },
      body: '{}',
    });
    expect(declaredOversize.status).toBe(413);
    await expect(declaredOversize.json()).resolves.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });

    const streamedOversize = await testApp().request('/v1/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': IDEMPOTENCY_KEY,
      },
      body: JSON.stringify({ name: 'x'.repeat(70_000) }),
    });
    expect(streamedOversize.status).toBe(413);
    await expect(streamedOversize.json()).resolves.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
  });

  it('rejects excessive JSON nesting and marks authenticated responses non-cacheable', async () => {
    const deeplyNested = `${'{"node":'.repeat(70)}null${'}'.repeat(70)}`;
    const nestedResponse = await testApp().request('/v1/projects', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': IDEMPOTENCY_KEY,
      },
      body: deeplyNested,
    });
    expect(nestedResponse.status).toBe(422);
    await expect(nestedResponse.json()).resolves.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    const response = await testApp().request('/v1/projects', {
      headers: { Cookie: 'session=verified' },
    });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
  });

  it('returns indistinguishable 404 problems for unknown and cross-tenant project ids', async () => {
    const resolver = createResolver();
    const service = createService();
    vi.mocked(service.get).mockRejectedValue(
      new ProjectServiceError(
        404,
        'PROJECT_NOT_FOUND',
        'The requested project does not exist',
      ),
    );
    const app = testApp(resolver, service);

    const [unknown, crossTenant] = await Promise.all([
      app.request(`/v1/projects/${PROJECT_ID}`),
      app.request(`/v1/projects/${OTHER_PROJECT_ID}`),
    ]);

    expect(unknown.status).toBe(404);
    expect(crossTenant.status).toBe(404);
    expect(await unknown.json()).toEqual(await crossTenant.json());
    expect(service.get).toHaveBeenNthCalledWith(1, context, PROJECT_ID);
    expect(service.get).toHaveBeenNthCalledWith(2, context, OTHER_PROJECT_ID);
  });

  it('returns an opaque 403 problem when a readable project cannot be mutated', async () => {
    const service = createService();
    vi.mocked(service.update).mockRejectedValue(
      new ProjectServiceError(
        403,
        'PROJECT_ACCESS_DENIED',
        'database policy details must not cross the HTTP boundary',
        {
          current: project({
            name: 'hidden soft-deleted project',
            description: 'confidential tombstone description',
            deletionStatus: 'soft_deleted',
          }),
        },
      ),
    );

    const response = await testApp(createResolver(), service).request(
      `/v1/projects/${PROJECT_ID}`,
      {
        method: 'PATCH',
        headers: { ...mutationHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Forbidden edit' }),
      },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(ProblemDetailsSchema.parse(body)).toMatchObject({
      status: 403,
      code: 'PROJECT_ACCESS_DENIED',
      message: 'The current user cannot modify this project',
      requestId: REQUEST_ID,
      retryable: false,
    });
    expect(JSON.stringify(body)).not.toContain('hidden soft-deleted project');
    expect(JSON.stringify(body)).not.toContain('confidential tombstone description');
    expect(JSON.stringify(body)).not.toContain('soft_deleted');
  });
});

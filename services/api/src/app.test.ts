import { ProblemDetailsSchema, UUIDv7Schema } from '@zuocheng/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { HttpPreconditionError } from './http/preconditions.js';

const REQUEST_ID = '01900000-0000-7000-8000-000000000001';

function createTestApp(mode: Parameters<typeof createApp>[0] = 'local') {
  return createApp(mode, {
    clock: () => new Date('2026-07-23T09:30:00.000Z'),
    createRequestId: () => REQUEST_ID,
  });
}

describe('API foundation', () => {
  it('reports readiness without claiming owner-billed infrastructure', async () => {
    const response = await createTestApp().request('/readyz');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID);
    await expect(response.json()).resolves.toMatchObject({
      service: 'zuocheng-api',
      status: 'ok',
      deploymentMode: 'local',
      ownerBilling: 'deny',
      timestamp: '2026-07-23T09:30:00.000Z',
    });
  });

  it('publishes the immutable cost policy', async () => {
    const response = await createTestApp('hosted-beta').request(
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

  it('fails project routes explicitly when persistence was not composed', async () => {
    const response = await createTestApp().request('/v1/projects');
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain(
      'application/problem+json',
    );
    await expect(response.json()).resolves.toMatchObject({
      code: 'PROJECT_SERVICE_NOT_CONFIGURED',
      retryable: false,
    });
  });

  it('does not claim production readiness before the database exists', async () => {
    const response = await createTestApp('tenant-managed-production').request(
      '/readyz',
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-type')).not.toContain(
      'application/problem+json',
    );
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID);
    await expect(response.json()).resolves.toMatchObject({
      status: 'degraded',
      dependencies: { database: 'runtime-database-probe-required' },
      timestamp: '2026-07-23T09:30:00.000Z',
    });
  });

  it('reports production ready only after the injected dependency probe succeeds', async () => {
    const app = createApp('tenant-managed-production', {
      clock: () => new Date('2026-07-23T09:30:00.000Z'),
      createRequestId: () => REQUEST_ID,
      productionReadinessProbe: async () => ({
        identity: 'ready',
        database: 'ready',
      }),
    });

    const response = await app.request('/readyz');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      dependencies: { identity: 'ready', database: 'ready' },
    });
  });

  it('fails production readiness closed when an injected dependency probe fails', async () => {
    const app = createApp('tenant-managed-production', {
      clock: () => new Date('2026-07-23T09:30:00.000Z'),
      createRequestId: () => REQUEST_ID,
      productionReadinessProbe: async () => {
        throw new Error('postgres://secret@customer.invalid/zuocheng');
      },
    });

    const response = await app.request('/readyz');
    expect(response.status).toBe(503);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain('dependency-probe-failed');
    expect(serialized).not.toContain('secret');
  });

  it('returns a schema-valid problem document for unknown routes', async () => {
    const response = await createTestApp().request('/not-a-route');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain(
      'application/problem+json',
    );
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID);

    const problem = await response.json();
    expect(ProblemDetailsSchema.parse(problem)).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      requestId: REQUEST_ID,
      retryable: false,
    });
  });

  it('never trusts a client-provided request id', async () => {
    const clientRequestId = '01900000-0000-7000-8000-000000000099';
    expect(UUIDv7Schema.safeParse(clientRequestId).success).toBe(true);

    const response = await createTestApp().request('/not-a-route', {
      headers: { 'X-Request-Id': clientRequestId },
    });
    expect(response.headers.get('x-request-id')).toBe(REQUEST_ID);
    await expect(response.json()).resolves.toMatchObject({
      requestId: REQUEST_ID,
    });
  });

  it('applies the safe problem mapper as the global error boundary', async () => {
    const app = createTestApp();
    app.get('/fails-precondition', () => {
      throw new HttpPreconditionError(
        428,
        'PRECONDITION_REQUIRED',
        'If-Match is required for this mutation',
      );
    });
    app.get('/fails-unknown', () => {
      throw new Error('secret-token and stack must never cross the boundary');
    });

    const precondition = await app.request('/fails-precondition');
    expect(precondition.status).toBe(428);
    expect(precondition.headers.get('x-request-id')).toBe(REQUEST_ID);
    expect(precondition.headers.get('content-type')).toContain(
      'application/problem+json',
    );
    expect(ProblemDetailsSchema.parse(await precondition.json())).toMatchObject({
      code: 'PRECONDITION_REQUIRED',
      requestId: REQUEST_ID,
    });

    const unknown = await app.request('/fails-unknown');
    const serialized = JSON.stringify(await unknown.json());
    expect(unknown.status).toBe(500);
    expect(serialized).not.toMatch(/secret-token|stack must never/u);
  });
});

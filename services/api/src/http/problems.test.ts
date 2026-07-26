import {
  ProblemDetailsSchema,
  VersionConflictProblemSchema,
} from '@zuocheng/contracts';
import { describe, expect, it } from 'vitest';
import {
  AuthenticationRequiredError,
  IdentityServiceUnavailableError,
  TenantMembershipRequiredError,
  TenantOverrideForbiddenError,
} from '../auth/tenant-session.js';
import { ProjectServiceError } from '../projects/project-service.js';
import { HttpPreconditionError } from './preconditions.js';
import { mapErrorToProblem } from './problems.js';

const REQUEST_ID = '01900000-0000-7000-8000-000000000001';
const TENANT_ID = '01900000-0000-7000-8000-000000000002';
const PROJECT_ID = '01900000-0000-7000-8000-000000000003';

describe('safe HTTP problem mapping', () => {
  it.each([
    [new AuthenticationRequiredError(), 401, 'AUTH_REQUIRED'],
    [new TenantMembershipRequiredError(), 403, 'TENANT_MEMBERSHIP_REQUIRED'],
    [new TenantOverrideForbiddenError(), 400, 'TENANT_OVERRIDE_FORBIDDEN'],
  ] as const)('maps tenant session failures without leaking identity state', (error, status, code) => {
    const result = mapErrorToProblem(error, REQUEST_ID);

    expect(result.status).toBe(status);
    expect(ProblemDetailsSchema.parse(result.body)).toMatchObject({
      status,
      code,
      requestId: REQUEST_ID,
      retryable: false,
    });
  });

  it('maps identity dependency failure to a retryable non-disclosing 503', () => {
    const result = mapErrorToProblem(
      new IdentityServiceUnavailableError(),
      REQUEST_ID,
    );

    expect(result).toMatchObject({
      status: 503,
      body: {
        code: 'IDENTITY_SERVICE_UNAVAILABLE',
        message: 'Identity verification is temporarily unavailable',
        retryable: true,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/postgres|secret|token/iu);
  });

  it('maps HTTP precondition failures to a schema-valid safe problem', () => {
    const result = mapErrorToProblem(
      new HttpPreconditionError(
        428,
        'PRECONDITION_REQUIRED',
        'If-Match is required for this mutation',
      ),
      REQUEST_ID,
    );

    expect(result.status).toBe(428);
    expect(ProblemDetailsSchema.parse(result.body)).toMatchObject({
      code: 'PRECONDITION_REQUIRED',
      requestId: REQUEST_ID,
      retryable: false,
    });
  });

  it('uses the dedicated version-conflict schema without spreading details', () => {
    const current = {
      tenantId: TENANT_ID,
      id: PROJECT_ID,
      version: 4,
      etag: '"4"',
      name: 'Evidence brief',
    };
    const result = mapErrorToProblem(
      new ProjectServiceError(
        409,
        'VERSION_CONFLICT',
        'internal text must not define the public contract',
        {
          expectedVersion: 3,
          currentVersion: 4,
          currentETag: '"4"',
          current,
          secret: 'database-password',
        },
      ),
      REQUEST_ID,
    );

    expect(result.status).toBe(409);
    expect(VersionConflictProblemSchema.parse(result.body)).toMatchObject({
      code: 'VERSION_CONFLICT',
      expectedVersion: 3,
      currentVersion: 4,
      currentETag: '"4"',
      resource: { tenantId: TENANT_ID, id: PROJECT_ID },
    });
    expect(JSON.stringify(result.body)).not.toContain('database-password');
    expect(JSON.stringify(result.body)).not.toContain('internal text');
  });

  it('maps project ACL denial to an opaque 403 problem', () => {
    const result = mapErrorToProblem(
      new ProjectServiceError(
        403,
        'PROJECT_ACCESS_DENIED',
        'database detail must not be exposed',
      ),
      REQUEST_ID,
    );

    expect(result.status).toBe(403);
    expect(ProblemDetailsSchema.parse(result.body)).toMatchObject({
      status: 403,
      code: 'PROJECT_ACCESS_DENIED',
      requestId: REQUEST_ID,
      retryable: false,
    });
    expect(JSON.stringify(result.body)).not.toContain('database detail');
  });

  it('converts Zod issues to bounded field errors without exposing issue data', () => {
    const result = mapErrorToProblem(
      new ProjectServiceError(
        422,
        'VALIDATION_FAILED',
        'unsafe wrapper message',
        {
          issues: [
            {
              code: 'too_small',
              path: ['name'],
              message: 'secret input was abc123',
              input: 'abc123',
            },
          ],
          secret: 'database-password',
        },
      ),
      REQUEST_ID,
    );

    const body = ProblemDetailsSchema.parse(result.body);
    expect(body).toMatchObject({
      status: 422,
      code: 'VALIDATION_FAILED',
      fieldErrors: [
        {
          path: ['name'],
          code: 'ZOD_TOO_SMALL',
          message: 'Value is below the allowed minimum',
        },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(
      /abc123|database-password|unsafe wrapper message/u,
    );
  });

  it('maps unknown failures to an opaque 500 problem', () => {
    const result = mapErrorToProblem(
      new Error('secret-token stack detail'),
      REQUEST_ID,
    );

    expect(result.status).toBe(500);
    const body = ProblemDetailsSchema.parse(result.body);
    expect(body).toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
      requestId: REQUEST_ID,
      retryable: true,
    });
    expect(JSON.stringify(body)).not.toMatch(/secret-token|stack detail/u);
  });
});

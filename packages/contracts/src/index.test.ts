import { describe, expect, it } from 'vitest';
import {
  DeletionStatusSchema,
  DeploymentModeSchema,
  ETagSchema,
  IdempotencyKeySchema,
  ProblemDetailsSchema,
  ProjectStateSchema,
  ProjectStatusSchema,
  ResourceVersionSchema,
  RuntimeCostPolicySchema,
  TenantResourceSchema,
  UUIDv7Schema,
  VERSION_CONFLICT,
  VERSION_CONFLICT_TYPE,
  VersionConflictProblemSchema,
  VersionedResourceSchema,
  ZERO_OWNER_COST_POLICY,
  formatETag,
} from './index.js';

const TENANT_ID = '01890f3e-b6e8-7cc2-98c0-7c9a2fe4f5d1';
const RESOURCE_ID = '01890f3e-b6e8-7d37-a839-3f11a9ca1b79';

describe('deployment and cost contracts', () => {
  it('accepts the three explicitly documented deployment modes', () => {
    expect(DeploymentModeSchema.options).toEqual([
      'local',
      'hosted-beta',
      'tenant-managed-production',
    ]);
  });

  it('cannot authorize owner billed or automatic overage settings', () => {
    expect(RuntimeCostPolicySchema.parse(ZERO_OWNER_COST_POLICY)).toEqual(
      ZERO_OWNER_COST_POLICY,
    );
    expect(() =>
      RuntimeCostPolicySchema.parse({
        ...ZERO_OWNER_COST_POLICY,
        ALLOW_AUTO_UPGRADE: true,
      }),
    ).toThrow();
  });
});

describe('tenant resource identity and optimistic concurrency contracts', () => {
  it('accepts UUIDv7 identifiers and rejects other UUID versions', () => {
    expect(UUIDv7Schema.parse(TENANT_ID)).toBe(TENANT_ID);
    expect(() =>
      UUIDv7Schema.parse('550e8400-e29b-41d4-a716-446655440000'),
    ).toThrow();
  });

  it('requires a tenant for every resource identity and rejects extra fields', () => {
    expect(
      TenantResourceSchema.parse({ tenantId: TENANT_ID, id: RESOURCE_ID }),
    ).toEqual({ tenantId: TENANT_ID, id: RESOURCE_ID });
    expect(() =>
      TenantResourceSchema.parse({
        tenantId: TENANT_ID,
        id: RESOURCE_ID,
        otherTenantId: TENANT_ID,
      }),
    ).toThrow();
  });

  it('uses positive integer versions and a canonical strong ETag', () => {
    expect(ResourceVersionSchema.parse(1)).toBe(1);
    expect(() => ResourceVersionSchema.parse(0)).toThrow();
    expect(() => ResourceVersionSchema.parse(1.5)).toThrow();

    expect(formatETag(12)).toBe('"12"');
    expect(ETagSchema.parse('"12"')).toBe('"12"');
    expect(() => ETagSchema.parse('W/"12"')).toThrow();
    expect(() => ETagSchema.parse('"01"')).toThrow();
  });

  it('keeps the resource version and ETag in sync', () => {
    expect(
      VersionedResourceSchema.parse({
        tenantId: TENANT_ID,
        id: RESOURCE_ID,
        version: 3,
        etag: '"3"',
      }),
    ).toEqual({
      tenantId: TENANT_ID,
      id: RESOURCE_ID,
      version: 3,
      etag: '"3"',
    });

    expect(() =>
      VersionedResourceSchema.parse({
        tenantId: TENANT_ID,
        id: RESOURCE_ID,
        version: 3,
        etag: '"2"',
      }),
    ).toThrow();
  });
});

describe('problem detail contracts', () => {
  it('accepts a strict RFC 7807 problem detail object', () => {
    const problem = {
      type: 'https://zuocheng.example/problems/not-found',
      title: 'Resource not found',
      status: 404,
      detail: 'The requested project does not exist.',
      instance: '/requests/request-123',
    };

    expect(ProblemDetailsSchema.parse(problem)).toEqual(problem);
    expect(() =>
      ProblemDetailsSchema.parse({ ...problem, debug: 'must not leak' }),
    ).toThrow();
  });

  it('defines the strict 409 VERSION_CONFLICT response', () => {
    const problem = {
      type: VERSION_CONFLICT_TYPE,
      title: 'Version conflict',
      status: 409,
      detail: 'The project changed after it was loaded.',
      instance: '/projects/01890f3e-b6e8-7d37-a839-3f11a9ca1b79',
      code: VERSION_CONFLICT,
      resourceId: RESOURCE_ID,
      expectedVersion: 2,
      currentVersion: 3,
      currentETag: '"3"',
    };

    expect(VersionConflictProblemSchema.parse(problem)).toEqual(problem);
    expect(() =>
      VersionConflictProblemSchema.parse({ ...problem, currentETag: '"2"' }),
    ).toThrow();
    expect(() =>
      VersionConflictProblemSchema.parse({ ...problem, stack: 'secret' }),
    ).toThrow();
  });
});

describe('idempotency and project lifecycle contracts', () => {
  it('accepts printable, bounded idempotency keys without normalizing them', () => {
    const key = 'delete-project:01890f3e-b6e8-7d37-a839-3f11a9ca1b79';

    expect(IdempotencyKeySchema.parse(key)).toBe(key);
    expect(() => IdempotencyKeySchema.parse(' has-leading-space')).toThrow();
    expect(() => IdempotencyKeySchema.parse('line\nbreak')).toThrow();
    expect(() => IdempotencyKeySchema.parse('short')).toThrow();
    expect(() => IdempotencyKeySchema.parse('contains space')).toThrow();
    expect(() => IdempotencyKeySchema.parse('x'.repeat(129))).toThrow();
  });

  it('defines project and deletion states as separate closed enums', () => {
    expect(ProjectStatusSchema.options).toEqual(['active', 'archived']);
    expect(DeletionStatusSchema.options).toEqual([
      'active',
      'soft_deleted',
      'purge_pending',
      'purged',
    ]);

    expect(
      ProjectStateSchema.parse({
        status: 'archived',
        deletionStatus: 'active',
      }),
    ).toEqual({ status: 'archived', deletionStatus: 'active' });
    expect(() =>
      ProjectStateSchema.parse({
        status: 'active',
        deletionStatus: 'active',
        deletedAt: null,
      }),
    ).toThrow();
  });
});

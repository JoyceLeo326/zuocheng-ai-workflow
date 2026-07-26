import { z } from 'zod';

export const UUIDv7Schema = z.uuidv7();

export type UUIDv7 = z.infer<typeof UUIDv7Schema>;

export const TenantIdSchema = UUIDv7Schema;
export const ResourceIdSchema = UUIDv7Schema;

export type TenantId = z.infer<typeof TenantIdSchema>;
export type ResourceId = z.infer<typeof ResourceIdSchema>;

export const ResourceVersionSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

export type ResourceVersion = z.infer<typeof ResourceVersionSchema>;

const ETAG_PATTERN = /^"([1-9]\d*)"$/;

export const ETagSchema = z
  .string()
  .regex(ETAG_PATTERN, 'ETag must use the canonical strong form "{version}"')
  .refine((value) => {
    const version = ETAG_PATTERN.exec(value)?.[1];

    return (
      version !== undefined &&
      Number.isSafeInteger(Number(version)) &&
      Number(version) >= 1
    );
  }, 'ETag version must be a positive safe integer');

export type ETag = z.infer<typeof ETagSchema>;

export function formatETag(version: ResourceVersion): ETag {
  return ETagSchema.parse(`"${ResourceVersionSchema.parse(version)}"`);
}

export const TenantResourceSchema = z.strictObject({
  tenantId: TenantIdSchema,
  id: ResourceIdSchema,
});

export type TenantResource = z.infer<typeof TenantResourceSchema>;

export const VersionedResourceSchema = z
  .strictObject({
    tenantId: TenantIdSchema,
    id: ResourceIdSchema,
    version: ResourceVersionSchema,
    etag: ETagSchema,
  })
  .superRefine((resource, context) => {
    if (resource.etag !== formatETag(resource.version)) {
      context.addIssue({
        code: 'custom',
        message: 'ETag must represent the resource version',
        path: ['etag'],
      });
    }
  });

export type VersionedResource = z.infer<typeof VersionedResourceSchema>;

const isSafeUriReference = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) {
      return false;
    }
  }

  return true;
};

export const UriReferenceSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine(isSafeUriReference, 'Expected an RFC 3986 URI reference');

export const ProblemCodeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/,
    'Problem code must be an uppercase machine-readable identifier',
  );

export const FieldErrorSchema = z.strictObject({
  path: z
    .array(z.union([z.string().min(1), z.number().int().nonnegative()]))
    .min(1)
    .max(32)
    .describe('Path segments from the request root to the invalid field'),
  code: ProblemCodeSchema,
  message: z
    .string()
    .min(1)
    .max(2_048)
    .describe('Safe, user-facing explanation for this field failure'),
});

export type FieldError = z.infer<typeof FieldErrorSchema>;

const ProblemDetailsShape = {
  type: UriReferenceSchema,
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  code: ProblemCodeSchema,
  message: z
    .string()
    .min(1)
    .max(4_096)
    .describe('Safe, user-facing explanation; never a stack trace'),
  requestId: UUIDv7Schema,
  retryable: z
    .boolean()
    .describe('Whether the same operation may be retried without user changes'),
  fieldErrors: z
    .array(FieldErrorSchema)
    .min(1)
    .max(100)
    .optional()
    .describe('Present only when one or more request fields are invalid'),
  detail: z
    .string()
    .min(1)
    .optional()
    .describe('Optional occurrence-specific detail beyond the stable message'),
  instance: UriReferenceSchema.optional().describe(
    'Optional URI reference identifying this specific problem occurrence',
  ),
} as const;

export const ProblemDetailsSchema = z.strictObject(ProblemDetailsShape);

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export const VERSION_CONFLICT = 'VERSION_CONFLICT' as const;
export const VERSION_CONFLICT_TYPE =
  'https://zuocheng.app/problems/version-conflict' as const;

export const VersionConflictProblemSchema = z
  .strictObject({
    ...ProblemDetailsShape,
    type: z.literal(VERSION_CONFLICT_TYPE),
    title: z.literal('Version conflict'),
    status: z.literal(409),
    code: z.literal(VERSION_CONFLICT),
    retryable: z.literal(false),
    resource: TenantResourceSchema,
    expectedVersion: ResourceVersionSchema,
    currentVersion: ResourceVersionSchema,
    currentETag: ETagSchema,
    current: z
      .record(z.string(), z.unknown())
      .refine((snapshot) => Object.keys(snapshot).length > 0, {
        message: 'Current resource snapshot must not be empty',
      }),
  })
  .superRefine((problem, context) => {
    if (problem.currentETag !== formatETag(problem.currentVersion)) {
      context.addIssue({
        code: 'custom',
        message: 'Current ETag must represent the current resource version',
        path: ['currentETag'],
      });
    }

    const snapshotChecks = [
      ['tenantId', problem.resource.tenantId],
      ['id', problem.resource.id],
      ['version', problem.currentVersion],
      ['etag', problem.currentETag],
    ] as const;

    for (const [field, expected] of snapshotChecks) {
      if (problem.current[field] !== expected) {
        context.addIssue({
          code: 'custom',
          message: `Current snapshot ${field} must match the conflict metadata`,
          path: ['current', field],
        });
      }
    }
  });

export type VersionConflictProblem = z.infer<
  typeof VersionConflictProblemSchema
>;

export const IdempotencyKeySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9._:-]{8,128}$/,
    'Idempotency key must contain 8-128 URL-safe printable characters',
  );

export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export const ProjectStatusSchema = z.enum(['active', 'archived']);
export const DeletionStatusSchema = z.enum([
  'active',
  'soft_deleted',
  'purge_pending',
  'purged',
]);

export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;
export type DeletionStatus = z.infer<typeof DeletionStatusSchema>;

export const ProjectStateSchema = z.strictObject({
  status: ProjectStatusSchema,
  deletionStatus: DeletionStatusSchema,
});

export type ProjectState = z.infer<typeof ProjectStateSchema>;

export const DeploymentModeSchema = z.enum([
  'local',
  'hosted-beta',
  'tenant-managed-production',
]);

export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;

export const RuntimeCostPolicySchema = z.strictObject({
  COST_MODE: z.literal('zero_owner_cost'),
  OWNER_BILLING_MODE: z.literal('deny'),
  ALLOW_OWNER_BILLED_PROVIDER: z.literal(false),
  ALLOW_AUTO_TOPUP: z.literal(false),
  ALLOW_AUTO_UPGRADE: z.literal(false),
  PROVIDER_CREDENTIAL_SOURCE: z.literal('tenant_only'),
  REMOTE_UNKNOWN_QUOTA: z.literal('deny'),
  STORAGE_DEFAULT: z.literal('tenant_byos'),
  REQUIRE_LEDGER_RESERVATION: z.literal(true),
  TENANT_CONTEXT_REQUIRED: z.literal(true),
});

export type RuntimeCostPolicy = z.infer<typeof RuntimeCostPolicySchema>;

export const ZERO_OWNER_COST_POLICY: RuntimeCostPolicy = Object.freeze({
  COST_MODE: 'zero_owner_cost',
  OWNER_BILLING_MODE: 'deny',
  ALLOW_OWNER_BILLED_PROVIDER: false,
  ALLOW_AUTO_TOPUP: false,
  ALLOW_AUTO_UPGRADE: false,
  PROVIDER_CREDENTIAL_SOURCE: 'tenant_only',
  REMOTE_UNKNOWN_QUOTA: 'deny',
  STORAGE_DEFAULT: 'tenant_byos',
  REQUIRE_LEDGER_RESERVATION: true,
  TENANT_CONTEXT_REQUIRED: true,
});

export const HealthStatusSchema = z.strictObject({
  service: z.string().min(1),
  status: z.enum(['ok', 'degraded']),
  deploymentMode: DeploymentModeSchema,
  ownerBilling: z.literal('deny'),
  timestamp: z.string().datetime(),
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;

import { z } from 'zod';

export const DeploymentModeSchema = z.enum([
  'local',
  'hosted-beta',
  'tenant-managed-production',
]);

export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;

export const RuntimeCostPolicySchema = z.object({
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

export const HealthStatusSchema = z.object({
  service: z.string().min(1),
  status: z.enum(['ok', 'degraded']),
  deploymentMode: DeploymentModeSchema,
  ownerBilling: z.literal('deny'),
  timestamp: z.string().datetime(),
});

export type HealthStatus = z.infer<typeof HealthStatusSchema>;


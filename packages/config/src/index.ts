import {
  DeploymentModeSchema,
  ZERO_OWNER_COST_POLICY,
} from '@zuocheng/contracts';
import type { RuntimeCostPolicy } from '@zuocheng/contracts';
import { z } from 'zod';

const EnvironmentSchema = z.object({
  DEPLOYMENT_MODE: DeploymentModeSchema.default('local'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
});

export type RuntimeEnvironment = z.infer<typeof EnvironmentSchema> &
  RuntimeCostPolicy;

const ExpectedPolicyEnvironment = {
  COST_MODE: 'zero_owner_cost',
  OWNER_BILLING_MODE: 'deny',
  ALLOW_OWNER_BILLED_PROVIDER: 'false',
  ALLOW_AUTO_TOPUP: 'false',
  ALLOW_AUTO_UPGRADE: 'false',
  PROVIDER_CREDENTIAL_SOURCE: 'tenant_only',
  REMOTE_UNKNOWN_QUOTA: 'deny',
  STORAGE_DEFAULT: 'tenant_byos',
  REQUIRE_LEDGER_RESERVATION: 'true',
  TENANT_CONTEXT_REQUIRED: 'true',
} as const;

const ForbiddenOwnerProviderKeys = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPSEEK_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'PLATFORM_AI_API_KEY',
] as const;

export function parseRuntimeEnvironment(
  environment: Record<string, string | undefined>,
): RuntimeEnvironment {
  for (const [name, expected] of Object.entries(ExpectedPolicyEnvironment)) {
    const actual = environment[name];
    if (actual !== undefined && actual !== expected) {
      throw new Error(`${name} must remain ${expected}`);
    }
  }

  for (const name of ForbiddenOwnerProviderKeys) {
    if (environment[name] !== undefined && environment[name] !== '') {
      throw new Error(`${name} is forbidden in a zero-owner-cost runtime`);
    }
  }

  const runtime = EnvironmentSchema.parse({
    DEPLOYMENT_MODE: environment.DEPLOYMENT_MODE,
    PORT: environment.PORT,
  });

  return { ...runtime, ...ZERO_OWNER_COST_POLICY };
}

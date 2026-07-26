import {
  DeploymentModeSchema,
  ZERO_OWNER_COST_POLICY,
} from '@zuocheng/contracts';
import type { RuntimeCostPolicy } from '@zuocheng/contracts';
import { z } from 'zod';

export {
  IdentityProviderConfigurationError,
  parseIdentityProviderConfiguration,
  type IdentityProviderConfiguration,
} from './identity-provider.js';

const EnvironmentSchema = z.object({
  DEPLOYMENT_MODE: DeploymentModeSchema.default('local'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  TENANT_RUNTIME_ADAPTER_MODULE: z.string().trim().min(1).optional(),
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

const ForbiddenProjectIdentityCredentialKeys = [
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_SECRETS',
  'AUTH_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_TENANT_ID',
  'SMTP_URL',
  'SMTP_PASSWORD',
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

  for (const name of ForbiddenProjectIdentityCredentialKeys) {
    if (environment[name] !== undefined && environment[name] !== '') {
      throw new Error(
        `${name} must be supplied through the customer runtime adapter`,
      );
    }
  }

  const runtime = EnvironmentSchema.parse({
    DEPLOYMENT_MODE: environment.DEPLOYMENT_MODE,
    PORT: environment.PORT,
    TENANT_RUNTIME_ADAPTER_MODULE:
      environment.TENANT_RUNTIME_ADAPTER_MODULE,
  });

  return { ...runtime, ...ZERO_OWNER_COST_POLICY };
}

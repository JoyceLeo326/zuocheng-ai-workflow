import { describe, expect, it } from 'vitest';
import { parseRuntimeEnvironment } from './index.js';

describe('runtime environment', () => {
  it('defaults to a local fail-closed zero-owner-cost runtime', () => {
    const configuration = parseRuntimeEnvironment({});
    expect(configuration).toMatchObject({
      DEPLOYMENT_MODE: 'local',
      COST_MODE: 'zero_owner_cost',
      OWNER_BILLING_MODE: 'deny',
      REMOTE_UNKNOWN_QUOTA: 'deny',
    });
  });

  it('refuses an owner-billed configuration', () => {
    expect(() =>
      parseRuntimeEnvironment({ OWNER_BILLING_MODE: 'allow' }),
    ).toThrow();
  });

  it.each([
    ['ALLOW_OWNER_BILLED_PROVIDER', 'true'],
    ['ALLOW_AUTO_TOPUP', 'true'],
    ['ALLOW_AUTO_UPGRADE', 'true'],
    ['PROVIDER_CREDENTIAL_SOURCE', 'owner'],
    ['REMOTE_UNKNOWN_QUOTA', 'allow'],
    ['STORAGE_DEFAULT', 'owner_storage'],
    ['REQUIRE_LEDGER_RESERVATION', 'false'],
    ['TENANT_CONTEXT_REQUIRED', 'false'],
  ])('refuses unsafe %s=%s before startup', (name, value) => {
    expect(() => parseRuntimeEnvironment({ [name]: value })).toThrow();
  });

  it('refuses owner provider keys before startup', () => {
    expect(() =>
      parseRuntimeEnvironment({ OPENAI_API_KEY: 'owner-secret' }),
    ).toThrow(/forbidden/u);
  });

  it('preserves an explicit customer runtime adapter module for API composition', () => {
    expect(
      parseRuntimeEnvironment({
        DEPLOYMENT_MODE: 'tenant-managed-production',
        TENANT_RUNTIME_ADAPTER_MODULE: '@customer/zuocheng-runtime',
      }),
    ).toMatchObject({
      DEPLOYMENT_MODE: 'tenant-managed-production',
      TENANT_RUNTIME_ADAPTER_MODULE: '@customer/zuocheng-runtime',
    });
  });

  it('rejects an empty customer runtime adapter module', () => {
    expect(() =>
      parseRuntimeEnvironment({ TENANT_RUNTIME_ADAPTER_MODULE: '   ' }),
    ).toThrow();
  });
});

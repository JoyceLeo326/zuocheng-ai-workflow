import { describe, expect, it } from 'vitest';
import {
  DeploymentModeSchema,
  RuntimeCostPolicySchema,
  ZERO_OWNER_COST_POLICY,
} from './index.js';

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


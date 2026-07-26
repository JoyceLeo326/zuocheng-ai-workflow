import type { RuntimeEnvironment } from '@zuocheng/config';

export function assertWorkerPolicy(configuration: RuntimeEnvironment): void {
  if (
    configuration.COST_MODE !== 'zero_owner_cost' ||
    configuration.OWNER_BILLING_MODE !== 'deny' ||
    configuration.ALLOW_AUTO_TOPUP ||
    configuration.ALLOW_AUTO_UPGRADE ||
    configuration.ALLOW_OWNER_BILLED_PROVIDER
  ) {
    throw new Error('Worker refuses an owner-billed runtime');
  }
}


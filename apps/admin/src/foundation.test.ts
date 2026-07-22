import { describe, expect, it } from 'vitest';
import { ADMIN_FOUNDATION_STATUS } from './foundation.js';

describe('admin application boundary', () => {
  it('does not expose fabricated operational metrics', () => {
    expect(ADMIN_FOUNDATION_STATUS).toEqual({
      application: 'admin',
      phase: 'ZC-01',
      realOperationalMetricsAvailable: false,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { DATABASE_FOUNDATION_STATUS } from './index.js';

describe('database package boundary', () => {
  it('never treats migration artifacts as a live production readiness probe', () => {
    expect(DATABASE_FOUNDATION_STATUS).toEqual({
      ready: false,
      reason: 'runtime-database-probe-required',
      dialect: 'postgresql',
      migrationVersion: '0000_foundation',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { parseRuntimeEnvironment } from '@zuocheng/config';
import { assertWorkerPolicy } from './policy.js';

describe('worker startup policy', () => {
  it('accepts only the fail-closed zero-owner-cost policy', () => {
    expect(() => assertWorkerPolicy(parseRuntimeEnvironment({}))).not.toThrow();
  });

  it('fails before startup when owner billing is requested', () => {
    expect(() =>
      parseRuntimeEnvironment({ OWNER_BILLING_MODE: 'allow' }),
    ).toThrow();
  });
});

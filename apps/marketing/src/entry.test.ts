import { describe, expect, it } from 'vitest';
import { MARKETING_BUILD_MARKER } from './entry.js';

describe('marketing package boundary', () => {
  it('has a versioned build marker', () => {
    expect(MARKETING_BUILD_MARKER).toBe('zuocheng-marketing-v1');
  });
});

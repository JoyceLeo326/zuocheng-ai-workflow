import { describe, expect, it } from 'vitest';
import { DATABASE_FOUNDATION_STATUS } from './index.js';

describe('database package boundary', () => {
  it('does not claim a database exists before ZC-02 migrations land', () => {
    expect(DATABASE_FOUNDATION_STATUS).toEqual({
      ready: false,
      reason: 'not-configured-until-zc-02',
    });
  });
});

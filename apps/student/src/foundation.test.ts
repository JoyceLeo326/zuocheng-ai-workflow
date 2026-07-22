import { describe, expect, it } from 'vitest';
import { STUDENT_FOUNDATION_STATUS } from './foundation.js';

describe('student application boundary', () => {
  it('does not claim the production workflow is complete', () => {
    expect(STUDENT_FOUNDATION_STATUS).toEqual({
      application: 'student',
      phase: 'ZC-01',
      productionWorkflowComplete: false,
    });
  });
});


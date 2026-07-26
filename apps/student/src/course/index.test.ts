import { describe, expect, it } from 'vitest';
import {
  CourseCenter,
  CourseCenterController,
  LOCAL_7_DAY_COURSE,
  MemoryCourseStore,
  createIndexedDbCourseStore,
} from './index.js';

describe('course public module', () => {
  it('exports the course UI, domain catalog and persistence entry points for later shell integration', () => {
    expect(CourseCenter).toBeTypeOf('function');
    expect(CourseCenterController).toBeTypeOf('function');
    expect(MemoryCourseStore).toBeTypeOf('function');
    expect(createIndexedDbCourseStore).toBeTypeOf('function');
    expect(LOCAL_7_DAY_COURSE.lessons).toHaveLength(18);
  });
});

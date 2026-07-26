import { describe, expect, it } from 'vitest';
import {
  CourseAlreadyExistsError,
  CourseStoreUnavailableError,
  CourseVersionConflictError,
  MemoryCourseStore,
  createIndexedDbCourseStore,
  createMemoryCourseDatabase,
} from './course-store.js';
import {
  LOCAL_7_DAY_COURSE,
  bindCourseProject,
  createCourseEnrollment,
} from './course-model.js';

const ENROLLMENT_ID = 'enrollment-local-001';

function enrollment() {
  return createCourseEnrollment({
    id: ENROLLMENT_ID,
    learnerId: 'learner-local-001',
    course: LOCAL_7_DAY_COURSE,
    timestamp: '2026-07-27T01:00:00.000Z',
  });
}

describe('course store contract', () => {
  it('persists a cloned enrollment across injected memory-store sessions', async () => {
    const database = createMemoryCourseDatabase();
    const first = new MemoryCourseStore({ database });
    const created = await first.createEnrollment(enrollment());
    created.lessonProgress[0]!.status = 'completed';

    const second = new MemoryCourseStore({ database });
    await expect(second.getEnrollment(ENROLLMENT_ID)).resolves.toEqual(
      enrollment(),
    );
    await expect(second.listEnrollments()).resolves.toEqual([
      enrollment(),
    ]);
  });

  it('uses optimistic versions and never reports a stale write as saved', async () => {
    const store = new MemoryCourseStore();
    const initial = await store.createEnrollment(enrollment());
    const next = bindCourseProject(
      initial,
      'project-local-001',
      '2026-07-27T01:01:00.000Z',
    );

    await expect(
      store.saveEnrollment(next, initial.version),
    ).resolves.toEqual(next);
    await expect(
      store.saveEnrollment(next, initial.version),
    ).rejects.toBeInstanceOf(CourseVersionConflictError);
    await expect(
      store.createEnrollment(enrollment()),
    ).rejects.toBeInstanceOf(CourseAlreadyExistsError);
  });

  it('fails explicitly when IndexedDB is unavailable instead of falling back to fake persistence', () => {
    expect(() =>
      createIndexedDbCourseStore({
        indexedDBFactory: null,
      }),
    ).toThrow(CourseStoreUnavailableError);
  });
});

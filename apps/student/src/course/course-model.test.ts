import { describe, expect, it } from 'vitest';
import {
  LOCAL_7_DAY_COURSE,
  acceptAssignment,
  archiveClassAnnouncement,
  bindCourseProject,
  courseOutcome,
  createCourseEnrollment,
  publishClassAnnouncement,
  publishCourseComment,
  resubmitAssignment,
  returnAssignment,
  submitAssignment,
  updateCourseCommentStatus,
  updateLessonProgress,
} from './course-model.js';

const ENROLLMENT_ID = 'enrollment-local-001';
const LEARNER_ID = 'learner-local-001';
const PROJECT_ID = 'project-local-001';
const CREATED_AT = '2026-07-27T01:00:00.000Z';

function enrollment() {
  return createCourseEnrollment({
    id: ENROLLMENT_ID,
    learnerId: LEARNER_ID,
    course: LOCAL_7_DAY_COURSE,
    timestamp: CREATED_AT,
  });
}

describe('local seven-day course domain', () => {
  it('ships exactly seven ordered days and eighteen substantive lessons', () => {
    expect(LOCAL_7_DAY_COURSE.durationDays).toBe(7);
    expect(LOCAL_7_DAY_COURSE.lessons).toHaveLength(18);
    expect(
      new Set(LOCAL_7_DAY_COURSE.lessons.map((lesson) => lesson.day)),
    ).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
    expect(
      LOCAL_7_DAY_COURSE.lessons.map((lesson) => lesson.order),
    ).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));
    expect(
      LOCAL_7_DAY_COURSE.lessons.every(
        (lesson) =>
          lesson.title.trim().length > 0 &&
          lesson.summary.trim().length > 0 &&
          lesson.objectives.length > 0 &&
          lesson.estimatedMinutes > 0,
      ),
    ).toBe(true);
    expect(
      LOCAL_7_DAY_COURSE.lessons.filter(
        (lesson) => lesson.assignment !== null,
      ),
    ).toHaveLength(7);
  });

  it('tracks real lesson progress and binds one existing project without inventing completion', () => {
    const initial = enrollment();
    expect(initial.lessonProgress).toHaveLength(18);
    expect(initial.lessonProgress.every((item) => item.status === 'not_started'))
      .toBe(true);
    expect(courseOutcome(initial, LOCAL_7_DAY_COURSE)).toMatchObject({
      completedLessons: 0,
      totalLessons: 18,
      completionStatus: 'in_progress',
      certificateEligible: false,
    });

    const started = updateLessonProgress(
      initial,
      'lesson-01',
      'in_progress',
      '2026-07-27T01:01:00.000Z',
    );
    const completed = updateLessonProgress(
      started,
      'lesson-01',
      'completed',
      '2026-07-27T01:02:00.000Z',
    );
    const bound = bindCourseProject(
      completed,
      PROJECT_ID,
      '2026-07-27T01:03:00.000Z',
    );

    expect(bound.projectId).toBe(PROJECT_ID);
    expect(bound.lessonProgress[0]).toMatchObject({
      lessonId: 'lesson-01',
      status: 'completed',
      startedAt: '2026-07-27T01:01:00.000Z',
      completedAt: '2026-07-27T01:02:00.000Z',
    });
    expect(courseOutcome(bound, LOCAL_7_DAY_COURSE)).toMatchObject({
      completedLessons: 1,
      certificateEligible: false,
    });
  });

  it('preserves assignment history across submit, return, resubmit and acceptance', () => {
    const bound = bindCourseProject(
      enrollment(),
      PROJECT_ID,
      '2026-07-27T01:01:00.000Z',
    );
    const submitted = submitAssignment(bound, {
      id: 'submission-001',
      lessonId: 'lesson-03',
      content: '我的真实任务定义与材料清单。',
      timestamp: '2026-07-27T01:02:00.000Z',
    });
    const returned = returnAssignment(submitted, {
      submissionId: 'submission-001',
      reviewerRole: 'mentor',
      reason: '请补充材料来源和可核验页码。',
      timestamp: '2026-07-27T01:03:00.000Z',
    });
    const resubmitted = resubmitAssignment(returned, {
      previousSubmissionId: 'submission-001',
      id: 'submission-002',
      content: '已补充材料来源和 PDF 页码。',
      timestamp: '2026-07-27T01:04:00.000Z',
    });
    const accepted = acceptAssignment(resubmitted, {
      submissionId: 'submission-002',
      reviewerRole: 'mentor',
      timestamp: '2026-07-27T01:05:00.000Z',
    });

    expect(accepted.submissions).toEqual([
      expect.objectContaining({
        id: 'submission-001',
        attempt: 1,
        status: 'returned',
        returnReason: '请补充材料来源和可核验页码。',
      }),
      expect.objectContaining({
        id: 'submission-002',
        previousSubmissionId: 'submission-001',
        attempt: 2,
        status: 'accepted',
        content: '已补充材料来源和 PDF 页码。',
      }),
    ]);
  });

  it('stores only explicit mentor or peer comments and preserves moderation state', () => {
    const bound = bindCourseProject(
      enrollment(),
      PROJECT_ID,
      '2026-07-27T01:01:00.000Z',
    );
    const submitted = submitAssignment(bound, {
      id: 'submission-001',
      lessonId: 'lesson-03',
      content: '作业正文',
      timestamp: '2026-07-27T01:02:00.000Z',
    });
    const commented = publishCourseComment(submitted, {
      id: 'comment-001',
      submissionId: 'submission-001',
      authorId: 'mentor-real-001',
      authorDisplayName: '林老师',
      authorRole: 'mentor',
      body: '材料范围清楚，请继续核对出处。',
      timestamp: '2026-07-27T01:03:00.000Z',
    });
    const resolved = updateCourseCommentStatus(
      commented,
      'comment-001',
      'resolved',
      '2026-07-27T01:04:00.000Z',
    );

    expect(resolved.comments).toEqual([
      expect.objectContaining({
        id: 'comment-001',
        authorRole: 'mentor',
        status: 'resolved',
        body: '材料范围清楚，请继续核对出处。',
      }),
    ]);
    expect(enrollment().comments).toEqual([]);
  });

  it('keeps class announcements explicit and archiveable instead of seeding fake notices', () => {
    const initial = enrollment();
    expect(initial.announcements).toEqual([]);
    const published = publishClassAnnouncement(initial, {
      id: 'announcement-001',
      title: '第 3 天答疑安排',
      body: '今晚 20:00 开放真实答疑；未接入班级服务时不会自动出现。',
      timestamp: '2026-07-27T01:01:00.000Z',
    });
    const archived = archiveClassAnnouncement(
      published,
      'announcement-001',
      '2026-07-27T01:02:00.000Z',
    );

    expect(archived.announcements[0]).toMatchObject({
      status: 'archived',
      title: '第 3 天答疑安排',
    });
  });

  it('requires all lessons, every required assignment and a bound project before certificate eligibility', () => {
    let current = bindCourseProject(
      enrollment(),
      PROJECT_ID,
      '2026-07-27T01:01:00.000Z',
    );
    let minute = 2;
    for (const lesson of LOCAL_7_DAY_COURSE.lessons) {
      current = updateLessonProgress(
        current,
        lesson.id,
        'completed',
        `2026-07-27T01:${String(minute).padStart(2, '0')}:00.000Z`,
      );
      minute += 1;
      if (lesson.assignment === null) {
        continue;
      }
      const submissionId = `submission-${lesson.id}`;
      current = submitAssignment(current, {
        id: submissionId,
        lessonId: lesson.id,
        content: `完成 ${lesson.assignment.title}`,
        timestamp: `2026-07-27T01:${String(minute).padStart(2, '0')}:00.000Z`,
      });
      minute += 1;
      current = acceptAssignment(current, {
        submissionId,
        reviewerRole: 'mentor',
        timestamp: `2026-07-27T01:${String(minute).padStart(2, '0')}:00.000Z`,
      });
      minute += 1;
    }

    expect(courseOutcome(current, LOCAL_7_DAY_COURSE)).toEqual({
      completedLessons: 18,
      totalLessons: 18,
      acceptedAssignments: 7,
      requiredAssignments: 7,
      completionPercent: 100,
      completionStatus: 'completed',
      certificateEligible: true,
      blockers: [],
    });
    expect(current).not.toHaveProperty('certificate');
    expect(current).not.toHaveProperty('certificateUrl');
  });
});

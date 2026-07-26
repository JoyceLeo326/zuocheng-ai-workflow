export type LessonProgressStatus =
  | 'not_started'
  | 'in_progress'
  | 'completed';

export type AssignmentSubmissionStatus =
  | 'submitted'
  | 'returned'
  | 'resubmitted'
  | 'accepted';

export type CourseReviewerRole = 'mentor' | 'peer';
export type CourseCommentStatus =
  | 'published'
  | 'resolved'
  | 'withdrawn';

export interface CourseAssignment {
  id: string;
  title: string;
  brief: string;
}

export interface CourseLesson {
  id: string;
  day: number;
  order: number;
  title: string;
  summary: string;
  objectives: readonly string[];
  estimatedMinutes: number;
  assignment: CourseAssignment | null;
}

export interface CourseDefinition {
  id: string;
  title: string;
  description: string;
  durationDays: number;
  lessons: readonly CourseLesson[];
}

export interface LessonProgress {
  lessonId: string;
  status: LessonProgressStatus;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface AssignmentSubmission {
  id: string;
  lessonId: string;
  assignmentId: string;
  projectId: string;
  attempt: number;
  previousSubmissionId: string | null;
  status: AssignmentSubmissionStatus;
  content: string;
  submittedAt: string;
  updatedAt: string;
  reviewedByRole: CourseReviewerRole | null;
  reviewedAt: string | null;
  returnReason: string | null;
}

export interface CourseComment {
  id: string;
  submissionId: string;
  authorId: string;
  authorDisplayName: string;
  authorRole: CourseReviewerRole;
  body: string;
  status: CourseCommentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ClassAnnouncement {
  id: string;
  title: string;
  body: string;
  status: 'published' | 'archived';
  publishedAt: string;
  updatedAt: string;
}

export interface CourseEnrollment {
  schemaVersion: 1;
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  learnerId: string;
  courseId: string;
  projectId: string | null;
  lessonProgress: LessonProgress[];
  submissions: AssignmentSubmission[];
  comments: CourseComment[];
  announcements: ClassAnnouncement[];
}

export interface CourseOutcome {
  completedLessons: number;
  totalLessons: number;
  acceptedAssignments: number;
  requiredAssignments: number;
  completionPercent: number;
  completionStatus: 'in_progress' | 'completed';
  certificateEligible: boolean;
  blockers: string[];
}

export type CourseDomainErrorCode =
  | 'INVALID_COURSE'
  | 'INVALID_ENROLLMENT'
  | 'INVALID_TIMESTAMP'
  | 'LESSON_NOT_FOUND'
  | 'ASSIGNMENT_NOT_FOUND'
  | 'PROJECT_REQUIRED'
  | 'SUBMISSION_NOT_FOUND'
  | 'SUBMISSION_STATE_INVALID'
  | 'COMMENT_NOT_FOUND'
  | 'ANNOUNCEMENT_NOT_FOUND';

export class CourseDomainError extends Error {
  constructor(readonly code: CourseDomainErrorCode) {
    super(`Course operation rejected: ${code}`);
    this.name = 'CourseDomainError';
  }
}

const assignment = (
  id: string,
  title: string,
  brief: string,
): CourseAssignment => ({ id, title, brief });

export const LOCAL_7_DAY_COURSE: CourseDefinition = Object.freeze({
  id: 'zuocheng-7-day-course-v1',
  title: '7 天做成一份可信作品',
  description:
    '从任务定义、材料核验到结构、成稿与交付，用 18 节进阶课程完成一份可追溯作品。',
  durationDays: 7,
  lessons: [
    {
      id: 'lesson-01',
      day: 1,
      order: 1,
      title: '把模糊要求改写成交付约束',
      summary: '识别受众、截止时间、篇幅、格式和评分标准。',
      objectives: ['形成可检查的任务定义', '区分硬约束与偏好'],
      estimatedMinutes: 22,
      assignment: null,
    },
    {
      id: 'lesson-02',
      day: 1,
      order: 2,
      title: '确定一个可完成的核心问题',
      summary: '把宽泛主题收束为能在期限内回答的问题。',
      objectives: ['写出核心问题', '识别范围外内容'],
      estimatedMinutes: 20,
      assignment: null,
    },
    {
      id: 'lesson-03',
      day: 1,
      order: 3,
      title: '建立任务卡与材料清单',
      summary: '绑定真实项目，列出已有材料和仍需补充的证据。',
      objectives: ['完成任务卡', '列出材料缺口'],
      estimatedMinutes: 28,
      assignment: assignment(
        'assignment-day-1',
        '提交任务卡',
        '提交任务定义、材料清单和范围说明。',
      ),
    },
    {
      id: 'lesson-04',
      day: 2,
      order: 4,
      title: '判断来源能否支持结论',
      summary: '检查作者、时间、语境和可追溯位置。',
      objectives: ['识别来源强弱', '记录页码或段落位置'],
      estimatedMinutes: 24,
      assignment: null,
    },
    {
      id: 'lesson-05',
      day: 2,
      order: 5,
      title: '从原文提取证据卡',
      summary: '保留原句、出处、立场和自己的使用说明。',
      objectives: ['区分引用与转述', '制作可核验的证据卡'],
      estimatedMinutes: 26,
      assignment: null,
    },
    {
      id: 'lesson-06',
      day: 2,
      order: 6,
      title: '处理冲突与证据缺口',
      summary: '不掩盖相反材料，并明确尚未验证的部分。',
      objectives: ['记录冲突证据', '标记未验证信息'],
      estimatedMinutes: 25,
      assignment: assignment(
        'assignment-day-2',
        '提交证据卡组',
        '提交至少一组带真实出处的支持、反对或中立证据。',
      ),
    },
    {
      id: 'lesson-07',
      day: 3,
      order: 7,
      title: '从评分标准反推结构',
      summary: '让每个章节覆盖明确的要求和评分点。',
      objectives: ['建立评分点映射', '发现结构遗漏'],
      estimatedMinutes: 22,
      assignment: null,
    },
    {
      id: 'lesson-08',
      day: 3,
      order: 8,
      title: '写出可被证据支持的结论',
      summary: '控制结论强度，避免材料无法支撑的夸张表达。',
      objectives: ['校准结论强度', '绑定对应证据'],
      estimatedMinutes: 24,
      assignment: null,
    },
    {
      id: 'lesson-09',
      day: 3,
      order: 9,
      title: '完成第一版结构',
      summary: '排列章节顺序，检查逻辑、要求和证据覆盖。',
      objectives: ['完成结构树', '说明章节之间的关系'],
      estimatedMinutes: 30,
      assignment: assignment(
        'assignment-day-3',
        '提交结构稿',
        '提交包含章节结论、证据绑定和评分点覆盖的结构。',
      ),
    },
    {
      id: 'lesson-10',
      day: 4,
      order: 10,
      title: '把结构扩写成页面或段落',
      summary: '先写结论和证据，再补解释与过渡。',
      objectives: ['保持一页一意', '让段落围绕结论展开'],
      estimatedMinutes: 28,
      assignment: null,
    },
    {
      id: 'lesson-11',
      day: 4,
      order: 11,
      title: '写清引用与数字',
      summary: '让引文、数字和图表都能回到真实来源。',
      objectives: ['给出可追溯引用', '核对数字口径'],
      estimatedMinutes: 24,
      assignment: null,
    },
    {
      id: 'lesson-12',
      day: 4,
      order: 12,
      title: '完成可读的初稿',
      summary: '在篇幅与时间限制内完成可审阅版本。',
      objectives: ['完成初稿', '保留待核验标记'],
      estimatedMinutes: 32,
      assignment: assignment(
        'assignment-day-4',
        '提交初稿',
        '提交可完整阅读、保留引用和待核验标记的初稿。',
      ),
    },
    {
      id: 'lesson-13',
      day: 5,
      order: 13,
      title: '进行事实与来源核验',
      summary: '逐项检查引用存在、来源可追溯和数字一致。',
      objectives: ['运行核验清单', '修复不可追溯内容'],
      estimatedMinutes: 28,
      assignment: null,
    },
    {
      id: 'lesson-14',
      day: 5,
      order: 14,
      title: '按反馈完成一次修订',
      summary: '区分必须修复、值得优化和暂不采纳的反馈。',
      objectives: ['记录修订理由', '保留版本变化'],
      estimatedMinutes: 32,
      assignment: assignment(
        'assignment-day-5',
        '提交核验与修订记录',
        '提交核验结果、问题清单和对应修订。',
      ),
    },
    {
      id: 'lesson-15',
      day: 6,
      order: 15,
      title: '建立一致的视觉层级',
      summary: '用字号、留白和对齐表达结构，而不是堆叠装饰。',
      objectives: ['建立视觉层级', '减少无信息装饰'],
      estimatedMinutes: 25,
      assignment: null,
    },
    {
      id: 'lesson-16',
      day: 6,
      order: 16,
      title: '完成讲述与演练',
      summary: '依据真实时长调整页面密度和讲述节奏。',
      objectives: ['完成计时演练', '记录超时或断点'],
      estimatedMinutes: 30,
      assignment: assignment(
        'assignment-day-6',
        '提交演练记录',
        '提交真实计时、问题位置和已采取的调整。',
      ),
    },
    {
      id: 'lesson-17',
      day: 7,
      order: 17,
      title: '进行交付前终检',
      summary: '检查文件、链接、字体、引用和导出结果。',
      objectives: ['完成交付清单', '验证导出文件可打开'],
      estimatedMinutes: 24,
      assignment: null,
    },
    {
      id: 'lesson-18',
      day: 7,
      order: 18,
      title: '完成复盘与作品归档',
      summary: '记录决策、反馈和可复用方法，形成真实作品记录。',
      objectives: ['完成复盘', '归档最终项目'],
      estimatedMinutes: 28,
      assignment: assignment(
        'assignment-day-7',
        '提交最终作品与复盘',
        '提交最终项目、核验结果和基于真实过程的复盘。',
      ),
    },
  ],
});

export function createCourseEnrollment(input: Readonly<{
  id: string;
  learnerId: string;
  course: CourseDefinition;
  timestamp: string;
}>): CourseEnrollment {
  assertCourse(input.course);
  assertText(input.id, 'INVALID_ENROLLMENT');
  assertText(input.learnerId, 'INVALID_ENROLLMENT');
  assertTimestamp(input.timestamp);
  return {
    schemaVersion: 1,
    id: input.id,
    version: 1,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    learnerId: input.learnerId,
    courseId: input.course.id,
    projectId: null,
    lessonProgress: input.course.lessons.map((lesson) => ({
      lessonId: lesson.id,
      status: 'not_started',
      startedAt: null,
      completedAt: null,
      updatedAt: input.timestamp,
    })),
    submissions: [],
    comments: [],
    announcements: [],
  };
}

export function bindCourseProject(
  current: CourseEnrollment,
  projectId: string,
  timestamp: string,
): CourseEnrollment {
  assertText(projectId, 'PROJECT_REQUIRED');
  return evolve(current, timestamp, { projectId: projectId.trim() });
}

export function updateLessonProgress(
  current: CourseEnrollment,
  lessonId: string,
  status: LessonProgressStatus,
  timestamp: string,
  course: CourseDefinition = LOCAL_7_DAY_COURSE,
): CourseEnrollment {
  requireLesson(course, lessonId);
  const progress = current.lessonProgress.find(
    (item) => item.lessonId === lessonId,
  );
  if (progress === undefined) {
    throw new CourseDomainError('LESSON_NOT_FOUND');
  }
  return evolve(current, timestamp, {
    lessonProgress: current.lessonProgress.map((item) => {
      if (item.lessonId !== lessonId) {
        return item;
      }
      return {
        ...item,
        status,
        startedAt:
          status === 'not_started'
            ? null
            : (item.startedAt ?? timestamp),
        completedAt:
          status === 'completed' ? timestamp : null,
        updatedAt: timestamp,
      };
    }),
  });
}

export function submitAssignment(
  current: CourseEnrollment,
  input: Readonly<{
    id: string;
    lessonId: string;
    content: string;
    timestamp: string;
  }>,
  course: CourseDefinition = LOCAL_7_DAY_COURSE,
): CourseEnrollment {
  const projectId = requireProject(current);
  const lesson = requireAssignmentLesson(course, input.lessonId);
  assertText(input.id, 'INVALID_ENROLLMENT');
  assertText(input.content, 'INVALID_ENROLLMENT');
  if (
    current.submissions.some(
      (submission) =>
        submission.lessonId === input.lessonId &&
        submission.status !== 'returned',
    )
  ) {
    throw new CourseDomainError('SUBMISSION_STATE_INVALID');
  }
  return evolve(current, input.timestamp, {
    submissions: [
      ...current.submissions,
      {
        id: input.id,
        lessonId: lesson.id,
        assignmentId: lesson.assignment!.id,
        projectId,
        attempt: 1,
        previousSubmissionId: null,
        status: 'submitted',
        content: input.content.trim(),
        submittedAt: input.timestamp,
        updatedAt: input.timestamp,
        reviewedByRole: null,
        reviewedAt: null,
        returnReason: null,
      },
    ],
  });
}

export function returnAssignment(
  current: CourseEnrollment,
  input: Readonly<{
    submissionId: string;
    reviewerRole: CourseReviewerRole;
    reason: string;
    timestamp: string;
  }>,
): CourseEnrollment {
  assertText(input.reason, 'SUBMISSION_STATE_INVALID');
  const submission = requireSubmission(current, input.submissionId);
  if (
    submission.status !== 'submitted' &&
    submission.status !== 'resubmitted'
  ) {
    throw new CourseDomainError('SUBMISSION_STATE_INVALID');
  }
  return updateSubmission(current, submission.id, input.timestamp, {
    status: 'returned',
    reviewedByRole: input.reviewerRole,
    reviewedAt: input.timestamp,
    returnReason: input.reason.trim(),
  });
}

export function resubmitAssignment(
  current: CourseEnrollment,
  input: Readonly<{
    previousSubmissionId: string;
    id: string;
    content: string;
    timestamp: string;
  }>,
): CourseEnrollment {
  const previous = requireSubmission(
    current,
    input.previousSubmissionId,
  );
  if (previous.status !== 'returned') {
    throw new CourseDomainError('SUBMISSION_STATE_INVALID');
  }
  assertText(input.id, 'INVALID_ENROLLMENT');
  assertText(input.content, 'INVALID_ENROLLMENT');
  const projectId = requireProject(current);
  return evolve(current, input.timestamp, {
    submissions: [
      ...current.submissions,
      {
        id: input.id,
        lessonId: previous.lessonId,
        assignmentId: previous.assignmentId,
        projectId,
        attempt: previous.attempt + 1,
        previousSubmissionId: previous.id,
        status: 'resubmitted',
        content: input.content.trim(),
        submittedAt: input.timestamp,
        updatedAt: input.timestamp,
        reviewedByRole: null,
        reviewedAt: null,
        returnReason: null,
      },
    ],
  });
}

export function acceptAssignment(
  current: CourseEnrollment,
  input: Readonly<{
    submissionId: string;
    reviewerRole: CourseReviewerRole;
    timestamp: string;
  }>,
): CourseEnrollment {
  const submission = requireSubmission(current, input.submissionId);
  if (
    submission.status !== 'submitted' &&
    submission.status !== 'resubmitted'
  ) {
    throw new CourseDomainError('SUBMISSION_STATE_INVALID');
  }
  return updateSubmission(current, submission.id, input.timestamp, {
    status: 'accepted',
    reviewedByRole: input.reviewerRole,
    reviewedAt: input.timestamp,
    returnReason: null,
  });
}

export function publishCourseComment(
  current: CourseEnrollment,
  input: Readonly<{
    id: string;
    submissionId: string;
    authorId: string;
    authorDisplayName: string;
    authorRole: CourseReviewerRole;
    body: string;
    timestamp: string;
  }>,
): CourseEnrollment {
  requireSubmission(current, input.submissionId);
  for (const value of [
    input.id,
    input.authorId,
    input.authorDisplayName,
    input.body,
  ]) {
    assertText(value, 'INVALID_ENROLLMENT');
  }
  return evolve(current, input.timestamp, {
    comments: [
      ...current.comments,
      {
        id: input.id,
        submissionId: input.submissionId,
        authorId: input.authorId,
        authorDisplayName: input.authorDisplayName.trim(),
        authorRole: input.authorRole,
        body: input.body.trim(),
        status: 'published',
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      },
    ],
  });
}

export function updateCourseCommentStatus(
  current: CourseEnrollment,
  commentId: string,
  status: CourseCommentStatus,
  timestamp: string,
): CourseEnrollment {
  const comment = current.comments.find(
    (candidate) => candidate.id === commentId,
  );
  if (comment === undefined) {
    throw new CourseDomainError('COMMENT_NOT_FOUND');
  }
  return evolve(current, timestamp, {
    comments: current.comments.map((candidate) =>
      candidate.id === commentId
        ? { ...candidate, status, updatedAt: timestamp }
        : candidate,
    ),
  });
}

export function publishClassAnnouncement(
  current: CourseEnrollment,
  input: Readonly<{
    id: string;
    title: string;
    body: string;
    timestamp: string;
  }>,
): CourseEnrollment {
  for (const value of [input.id, input.title, input.body]) {
    assertText(value, 'INVALID_ENROLLMENT');
  }
  return evolve(current, input.timestamp, {
    announcements: [
      ...current.announcements,
      {
        id: input.id,
        title: input.title.trim(),
        body: input.body.trim(),
        status: 'published',
        publishedAt: input.timestamp,
        updatedAt: input.timestamp,
      },
    ],
  });
}

export function archiveClassAnnouncement(
  current: CourseEnrollment,
  announcementId: string,
  timestamp: string,
): CourseEnrollment {
  if (
    !current.announcements.some(
      (announcement) => announcement.id === announcementId,
    )
  ) {
    throw new CourseDomainError('ANNOUNCEMENT_NOT_FOUND');
  }
  return evolve(current, timestamp, {
    announcements: current.announcements.map((announcement) =>
      announcement.id === announcementId
        ? { ...announcement, status: 'archived', updatedAt: timestamp }
        : announcement,
    ),
  });
}

export function courseOutcome(
  enrollment: CourseEnrollment,
  course: CourseDefinition,
): CourseOutcome {
  const completedLessons = enrollment.lessonProgress.filter(
    (progress) => progress.status === 'completed',
  ).length;
  const requiredLessons = course.lessons.filter(
    (lesson) => lesson.assignment !== null,
  );
  const latestByLesson = new Map<string, AssignmentSubmission>();
  for (const submission of enrollment.submissions) {
    const previous = latestByLesson.get(submission.lessonId);
    if (
      previous === undefined ||
      submission.attempt > previous.attempt
    ) {
      latestByLesson.set(submission.lessonId, submission);
    }
  }
  const acceptedAssignments = requiredLessons.filter(
    (lesson) =>
      latestByLesson.get(lesson.id)?.status === 'accepted',
  ).length;
  const allLessonsCompleted =
    completedLessons === course.lessons.length;
  const allAssignmentsAccepted =
    acceptedAssignments === requiredLessons.length;
  const completionStatus =
    allLessonsCompleted && allAssignmentsAccepted
      ? 'completed'
      : 'in_progress';
  const blockers: string[] = [];
  if (enrollment.projectId === null) {
    blockers.push('尚未绑定真实项目');
  }
  if (!allLessonsCompleted) {
    blockers.push('仍有课程未完成');
  }
  if (!allAssignmentsAccepted) {
    blockers.push('仍有必交作业未验收');
  }
  return {
    completedLessons,
    totalLessons: course.lessons.length,
    acceptedAssignments,
    requiredAssignments: requiredLessons.length,
    completionPercent:
      course.lessons.length === 0
        ? 0
        : Math.round(
            (completedLessons / course.lessons.length) * 100,
          ),
    completionStatus,
    certificateEligible:
      completionStatus === 'completed' &&
      enrollment.projectId !== null,
    blockers,
  };
}

export function parseCourseEnrollment(
  value: unknown,
  course: CourseDefinition = LOCAL_7_DAY_COURSE,
): CourseEnrollment {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new CourseDomainError('INVALID_ENROLLMENT');
  }
  const candidate = value as Partial<CourseEnrollment>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.id !== 'string' ||
    candidate.id.trim().length === 0 ||
    typeof candidate.learnerId !== 'string' ||
    candidate.learnerId.trim().length === 0 ||
    candidate.courseId !== course.id ||
    !Number.isSafeInteger(candidate.version) ||
    (candidate.version ?? 0) < 1 ||
    typeof candidate.createdAt !== 'string' ||
    typeof candidate.updatedAt !== 'string' ||
    !Array.isArray(candidate.lessonProgress) ||
    !Array.isArray(candidate.submissions) ||
    !Array.isArray(candidate.comments) ||
    !Array.isArray(candidate.announcements)
  ) {
    throw new CourseDomainError('INVALID_ENROLLMENT');
  }
  assertTimestamp(candidate.createdAt);
  assertTimestamp(candidate.updatedAt);
  const lessonIds = new Set(course.lessons.map((lesson) => lesson.id));
  if (
    candidate.lessonProgress.length !== course.lessons.length ||
    candidate.lessonProgress.some(
      (progress) =>
        !lessonIds.has(progress.lessonId) ||
        !['not_started', 'in_progress', 'completed'].includes(
          progress.status,
        ),
    )
  ) {
    throw new CourseDomainError('INVALID_ENROLLMENT');
  }
  return structuredClone(candidate as CourseEnrollment);
}

function evolve(
  current: CourseEnrollment,
  timestamp: string,
  patch: Partial<CourseEnrollment>,
): CourseEnrollment {
  assertTimestampAfter(timestamp, current.updatedAt);
  return parseCourseEnrollment({
    ...current,
    ...patch,
    version: current.version + 1,
    updatedAt: timestamp,
  });
}

function updateSubmission(
  current: CourseEnrollment,
  submissionId: string,
  timestamp: string,
  patch: Partial<AssignmentSubmission>,
): CourseEnrollment {
  return evolve(current, timestamp, {
    submissions: current.submissions.map((submission) =>
      submission.id === submissionId
        ? { ...submission, ...patch, updatedAt: timestamp }
        : submission,
    ),
  });
}

function requireProject(current: CourseEnrollment): string {
  if (current.projectId === null) {
    throw new CourseDomainError('PROJECT_REQUIRED');
  }
  return current.projectId;
}

function requireLesson(
  course: CourseDefinition,
  lessonId: string,
): CourseLesson {
  const lesson = course.lessons.find(
    (candidate) => candidate.id === lessonId,
  );
  if (lesson === undefined) {
    throw new CourseDomainError('LESSON_NOT_FOUND');
  }
  return lesson;
}

function requireAssignmentLesson(
  course: CourseDefinition,
  lessonId: string,
): CourseLesson {
  const lesson = requireLesson(course, lessonId);
  if (lesson.assignment === null) {
    throw new CourseDomainError('ASSIGNMENT_NOT_FOUND');
  }
  return lesson;
}

function requireSubmission(
  current: CourseEnrollment,
  submissionId: string,
): AssignmentSubmission {
  const submission = current.submissions.find(
    (candidate) => candidate.id === submissionId,
  );
  if (submission === undefined) {
    throw new CourseDomainError('SUBMISSION_NOT_FOUND');
  }
  return submission;
}

function assertCourse(course: CourseDefinition): void {
  if (
    course.durationDays !== 7 ||
    course.lessons.length !== 18 ||
    course.lessons.some(
      (lesson, index) =>
        lesson.order !== index + 1 ||
        lesson.day < 1 ||
        lesson.day > course.durationDays,
    )
  ) {
    throw new CourseDomainError('INVALID_COURSE');
  }
}

function assertText(
  value: string,
  code: CourseDomainErrorCode,
): void {
  if (value.trim().length === 0) {
    throw new CourseDomainError(code);
  }
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new CourseDomainError('INVALID_TIMESTAMP');
  }
}

function assertTimestampAfter(value: string, previous: string): void {
  assertTimestamp(value);
  if (Date.parse(value) <= Date.parse(previous)) {
    throw new CourseDomainError('INVALID_TIMESTAMP');
  }
}

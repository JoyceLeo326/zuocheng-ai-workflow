import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { generateCourseCertificate } from './course-certificate.js';
import {
  LOCAL_7_DAY_COURSE,
  bindCourseProject,
  courseOutcome,
  createCourseEnrollment,
  resubmitAssignment,
  submitAssignment,
  updateLessonProgress,
  type CourseEnrollment,
  type LessonProgressStatus,
} from './course-model.js';
import type { CourseStore } from './course-store.js';
import './course-center.css';

export interface CourseProjectOption {
  id: string;
  title: string;
}

export interface CourseCenterViewCallbacks {
  onCreateEnrollment(): Promise<void>;
  onBindProject(projectId: string): Promise<void>;
  onUpdateLesson(
    lessonId: string,
    status: LessonProgressStatus,
  ): Promise<void>;
  onSubmitAssignment(
    lessonId: string,
    content: string,
  ): Promise<void>;
  onResubmitAssignment(
    previousSubmissionId: string,
    content: string,
  ): Promise<void>;
  onExportCertificate(learnerName: string): Promise<void>;
  onOpenProjects(): Promise<void>;
  onRefresh(): Promise<void>;
}

export interface CourseCenterViewProps
  extends CourseCenterViewCallbacks {
  enrollment: CourseEnrollment | null;
  projects: readonly CourseProjectOption[];
  loading: boolean;
  online: boolean;
  error?: string | null;
  busy?: boolean;
  initialLessonId?: string;
}

export interface CourseCenterControllerOptions {
  store: CourseStore;
  enrollmentId: string;
  now?: () => Date;
  idFactory?: () => string;
}

export class CourseCenterController {
  readonly #store: CourseStore;
  readonly #enrollmentId: string;
  readonly #now: () => Date;
  readonly #idFactory: () => string;

  constructor(options: CourseCenterControllerOptions) {
    this.#store = options.store;
    this.#enrollmentId = options.enrollmentId;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory =
      options.idFactory ??
      (() => globalThis.crypto.randomUUID());
  }

  async load(): Promise<CourseEnrollment | null> {
    return this.#store.getEnrollment(this.#enrollmentId);
  }

  async create(learnerId: string): Promise<CourseEnrollment> {
    return this.#store.createEnrollment(
      createCourseEnrollment({
        id: this.#enrollmentId,
        learnerId,
        course: LOCAL_7_DAY_COURSE,
        timestamp: this.#now().toISOString(),
      }),
    );
  }

  async bindProject(projectId: string): Promise<CourseEnrollment> {
    return this.#mutate((current, timestamp) =>
      bindCourseProject(current, projectId, timestamp),
    );
  }

  async updateLesson(
    lessonId: string,
    status: LessonProgressStatus,
  ): Promise<CourseEnrollment> {
    return this.#mutate((current, timestamp) =>
      updateLessonProgress(
        current,
        lessonId,
        status,
        timestamp,
      ),
    );
  }

  async submitAssignment(
    lessonId: string,
    content: string,
  ): Promise<CourseEnrollment> {
    return this.#mutate((current, timestamp) =>
      submitAssignment(current, {
        id: this.#idFactory(),
        lessonId,
        content,
        timestamp,
      }),
    );
  }

  async resubmitAssignment(
    previousSubmissionId: string,
    content: string,
  ): Promise<CourseEnrollment> {
    return this.#mutate((current, timestamp) =>
      resubmitAssignment(current, {
        previousSubmissionId,
        id: this.#idFactory(),
        content,
        timestamp,
      }),
    );
  }

  async #mutate(
    operation: (
      current: CourseEnrollment,
      timestamp: string,
    ) => CourseEnrollment,
  ): Promise<CourseEnrollment> {
    const current = await this.load();
    if (current === null) {
      throw new Error('课程记录不存在，请先开始课程。');
    }
    const observed = this.#now().valueOf();
    const timestamp = new Date(
      Math.max(
        observed,
        Date.parse(current.updatedAt) + 1,
      ),
    ).toISOString();
    const next = operation(current, timestamp);
    return this.#store.saveEnrollment(next, current.version);
  }
}

export interface CourseCenterProps {
  store: CourseStore;
  enrollmentId: string;
  learnerId: string;
  projects: readonly CourseProjectOption[];
  onOpenProjects(): Promise<void>;
  online?: boolean;
  now?: (() => Date) | undefined;
  idFactory?: (() => string) | undefined;
}

export function CourseCenter({
  store,
  enrollmentId,
  learnerId,
  projects,
  onOpenProjects,
  online = true,
  now,
  idFactory,
}: CourseCenterProps) {
  const controller = useMemo(
    () =>
      new CourseCenterController({
        store,
        enrollmentId,
        ...(now === undefined ? {} : { now }),
        ...(idFactory === undefined ? {} : { idFactory }),
      }),
    [enrollmentId, idFactory, now, store],
  );
  const [enrollment, setEnrollment] =
    useState<CourseEnrollment | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setEnrollment(await controller.load());
    } catch (reason) {
      setError(courseCenterErrorMessage(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    void controller
      .load()
      .then((next) => {
        if (active) {
          setEnrollment(next);
          setLoading(false);
        }
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(courseCenterErrorMessage(reason));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [controller]);

  const run = async (
    operation: () => Promise<CourseEnrollment>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      setEnrollment(await operation());
    } catch (reason) {
      setError(courseCenterErrorMessage(reason));
      throw reason;
    } finally {
      setBusy(false);
    }
  };

  return (
    <CourseCenterView
      busy={busy}
      enrollment={enrollment}
      error={error}
      loading={loading}
      onBindProject={(projectId) =>
        run(() => controller.bindProject(projectId))
      }
      onCreateEnrollment={() =>
        run(() => controller.create(learnerId))
      }
      onExportCertificate={async (learnerName) => {
        if (enrollment === null) {
          throw new Error('课程记录尚未载入。');
        }
        const result = await generateCourseCertificate({
          learnerName,
          enrollment,
        });
        downloadCertificate(result.blob, result.fileName);
      }}
      onOpenProjects={onOpenProjects}
      onRefresh={refresh}
      onResubmitAssignment={(submissionId, content) =>
        run(() =>
          controller.resubmitAssignment(
            submissionId,
            content,
          ),
        )
      }
      onSubmitAssignment={(lessonId, content) =>
        run(() =>
          controller.submitAssignment(lessonId, content),
        )
      }
      onUpdateLesson={(lessonId, status) =>
        run(() =>
          controller.updateLesson(lessonId, status),
        )
      }
      online={online}
      projects={projects}
    />
  );
}

export function CourseCenterView({
  enrollment,
  projects,
  loading,
  online,
  error = null,
  busy = false,
  initialLessonId,
  onCreateEnrollment,
  onBindProject,
  onUpdateLesson,
  onSubmitAssignment,
  onResubmitAssignment,
  onExportCertificate,
  onOpenProjects,
  onRefresh,
}: CourseCenterViewProps) {
  const defaultLessonId =
    initialLessonId ?? LOCAL_7_DAY_COURSE.lessons[0]!.id;
  const [activeLessonId, setActiveLessonId] =
    useState(defaultLessonId);
  const [selectedProjectId, setSelectedProjectId] = useState(
    enrollment?.projectId ?? projects[0]?.id ?? '',
  );
  const [assignmentContent, setAssignmentContent] =
    useState('');
  const [certificateName, setCertificateName] = useState('');
  const [certificateStatus, setCertificateStatus] = useState('');
  const [actionError, setActionError] = useState<string | null>(
    null,
  );

  if (loading) {
    return (
      <CourseCenterState
        detail="正在同步进度、作业和评价。"
        title="正在读取课程记录"
        tone="loading"
      />
    );
  }
  if (error !== null) {
    return (
      <CourseCenterState
        actionLabel="重新读取"
        detail={error}
        onAction={onRefresh}
        title="课程中心暂不可用"
        tone="error"
      />
    );
  }
  if (enrollment === null) {
    return (
      <CourseCenterState
        actionLabel="创建学习记录"
        detail="从第 1 天开始，逐步完成任务、材料、结构、成稿与交付。"
        onAction={onCreateEnrollment}
        title="开始 7 天课程"
        tone="empty"
      />
    );
  }

  const outcome = courseOutcome(
    enrollment,
    LOCAL_7_DAY_COURSE,
  );
  const activeLesson =
    LOCAL_7_DAY_COURSE.lessons.find(
      (lesson) => lesson.id === activeLessonId,
    ) ?? LOCAL_7_DAY_COURSE.lessons[0]!;
  const activeDay = activeLesson.day;
  const activeProgress = enrollment.lessonProgress.find(
    (progress) => progress.lessonId === activeLesson.id,
  )!;
  const lessonSubmissions = enrollment.submissions
    .filter(
      (submission) =>
        submission.lessonId === activeLesson.id,
    )
    .sort((left, right) => right.attempt - left.attempt);
  const latestSubmission = lessonSubmissions[0] ?? null;
  const activeComments = enrollment.comments.filter(
    (comment) =>
      latestSubmission !== null &&
      comment.submissionId === latestSubmission.id &&
      comment.status !== 'withdrawn',
  );
  const projectTitle =
    projects.find(
      (project) => project.id === enrollment.projectId,
    )?.title ?? enrollment.projectId;
  const firstAssignmentLesson =
    LOCAL_7_DAY_COURSE.lessons.find(
      (lesson) => lesson.assignment !== null,
    )!;

  const perform = async (operation: () => Promise<void>) => {
    setActionError(null);
    try {
      await operation();
    } catch (reason) {
      setActionError(courseCenterErrorMessage(reason));
    }
  };

  const submitAssignmentForm = (event: FormEvent) => {
    event.preventDefault();
    const content = assignmentContent.trim();
    if (
      content.length === 0 ||
      activeLesson.assignment === null
    ) {
      return;
    }
    void perform(async () => {
      if (latestSubmission?.status === 'returned') {
        await onResubmitAssignment(
          latestSubmission.id,
          content,
        );
      } else {
        await onSubmitAssignment(activeLesson.id, content);
      }
      setAssignmentContent('');
    });
  };

  const exportCertificateForm = (event: FormEvent) => {
    event.preventDefault();
    const learnerName = certificateName.trim();
    if (learnerName.length === 0) {
      setActionError('请填写证书姓名。');
      return;
    }
    setCertificateStatus('');
    void perform(async () => {
      await onExportCertificate(learnerName);
      setCertificateStatus('证书已生成并开始下载。');
    });
  };

  return (
    <main className="course-center" id="course-center-main">
      <a className="course-center__skip" href="#course-lesson-detail">
        跳到当前课程
      </a>

      {!online ? (
        <div
          aria-live="polite"
          className="course-center__offline"
          role="status"
        >
          <div>
            <strong>当前离线</strong>
            <span>可继续学习；班级通知和评价可能不是最新。</span>
          </div>
          <button
            disabled={busy}
            onClick={() => {
              void perform(onRefresh);
            }}
            type="button"
          >
            刷新状态
          </button>
        </div>
      ) : null}

      <header className="course-center__hero">
        <div>
          <span className="course-center__eyebrow">
            COURSE / 7 DAYS / 18 LESSONS
          </span>
          <h1>课程中心</h1>
          <p>{LOCAL_7_DAY_COURSE.title}</p>
        </div>
        <div className="course-center__scoreboard">
          <span>
            <strong>
              {String(outcome.completedLessons)} /{' '}
              {String(outcome.totalLessons)}
            </strong>
            已完成课程
          </span>
          <span>
            <strong>
              {String(outcome.acceptedAssignments)} /{' '}
              {String(outcome.requiredAssignments)}
            </strong>
            已验收作业
          </span>
          <span>
            <strong>18 节</strong>
            7 天学习路径
          </span>
        </div>
        <div className="course-center__progress">
          <div>
            <span>总体进度</span>
            <strong>{String(outcome.completionPercent)}%</strong>
          </div>
          <div
            aria-label="课程总体进度"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={outcome.completionPercent}
            className="course-center__progress-track"
            role="progressbar"
          >
            <span
              style={{
                width: `${String(outcome.completionPercent)}%`,
              }}
            />
          </div>
        </div>
      </header>

      <nav
        aria-label="课程天数"
        className="course-center__days"
      >
        {Array.from(
          { length: LOCAL_7_DAY_COURSE.durationDays },
          (_, index) => index + 1,
        ).map((day) => {
          const lessons = LOCAL_7_DAY_COURSE.lessons.filter(
            (lesson) => lesson.day === day,
          );
          const completed = lessons.filter(
            (lesson) =>
              enrollment.lessonProgress.find(
                (progress) =>
                  progress.lessonId === lesson.id,
              )?.status === 'completed',
          ).length;
          return (
            <button
              aria-pressed={activeDay === day}
              className={
                activeDay === day ? 'is-active' : undefined
              }
              key={day}
              onClick={() => {
                setActiveLessonId(lessons[0]!.id);
              }}
              type="button"
            >
              <span>第 {String(day)} 天</span>
              <small>
                {String(completed)} / {String(lessons.length)}
              </small>
            </button>
          );
        })}
      </nav>

      <div className="course-center__layout">
        <aside
          aria-label={`第 ${String(activeDay)} 天课程`}
          className="course-center__lesson-list"
        >
          <header>
            <span>DAY {String(activeDay).padStart(2, '0')}</span>
            <strong>今日课程</strong>
          </header>
          {LOCAL_7_DAY_COURSE.lessons
            .filter((lesson) => lesson.day === activeDay)
            .map((lesson) => {
              const progress = enrollment.lessonProgress.find(
                (item) => item.lessonId === lesson.id,
              )!;
              return (
                <button
                  aria-current={
                    activeLesson.id === lesson.id
                      ? 'true'
                      : undefined
                  }
                  className={
                    activeLesson.id === lesson.id
                      ? 'is-active'
                      : undefined
                  }
                  key={lesson.id}
                  onClick={() => {
                    setActiveLessonId(lesson.id);
                  }}
                  type="button"
                >
                  <span className="course-center__lesson-number">
                    {String(lesson.order).padStart(2, '0')}
                  </span>
                  <span>
                    <strong>{lesson.title}</strong>
                    <small>
                      {String(lesson.estimatedMinutes)} 分钟 ·{' '}
                      {lessonProgressLabel(progress.status)}
                    </small>
                  </span>
                </button>
              );
            })}
        </aside>

        <section
          aria-labelledby="course-lesson-title"
          className="course-center__lesson"
          id="course-lesson-detail"
          tabIndex={-1}
        >
          <header>
            <span>
              LESSON {String(activeLesson.order).padStart(2, '0')}
            </span>
            <h2 id="course-lesson-title">
              {activeLesson.title}
            </h2>
            <p>{activeLesson.summary}</p>
          </header>

          <div className="course-center__lesson-meta">
            <span>{String(activeLesson.estimatedMinutes)} 分钟</span>
            <span>{lessonProgressLabel(activeProgress.status)}</span>
          </div>

          <section className="course-center__objectives">
            <h3>完成本课后，你将能够</h3>
            <ul>
              {activeLesson.objectives.map((objective) => (
                <li key={objective}>{objective}</li>
              ))}
            </ul>
          </section>

          <div className="course-center__lesson-actions">
            {activeProgress.status === 'not_started' ? (
              <button
                disabled={busy}
                onClick={() => {
                  void perform(() =>
                    onUpdateLesson(
                      activeLesson.id,
                      'in_progress',
                    ),
                  );
                }}
                type="button"
              >
                开始学习
              </button>
            ) : null}
            {activeProgress.status !== 'completed' ? (
              <button
                className="course-center__primary"
                disabled={busy}
                onClick={() => {
                  void perform(() =>
                    onUpdateLesson(
                      activeLesson.id,
                      'completed',
                    ),
                  );
                }}
                type="button"
              >
                标记完成
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() => {
                  void perform(() =>
                    onUpdateLesson(
                      activeLesson.id,
                      'in_progress',
                    ),
                  );
                }}
                type="button"
              >
                重新学习
              </button>
            )}
          </div>

          {activeLesson.assignment === null ? null : (
            <section
              aria-labelledby="course-assignment-title"
              className="course-center__assignment"
            >
              <header>
                <span>必交作业</span>
                <strong id="course-assignment-title">
                  {activeLesson.assignment.title}
                </strong>
              </header>
              <p>{activeLesson.assignment.brief}</p>
              {latestSubmission === null ? null : (
                <div className="course-center__submission">
                  <div>
                    <strong>
                      第 {String(latestSubmission.attempt)} 次提交
                    </strong>
                    <span>
                      {submissionStatusLabel(
                        latestSubmission.status,
                      )}
                    </span>
                  </div>
                  <p>{latestSubmission.content}</p>
                  {latestSubmission.returnReason === null ? null : (
                    <blockquote>
                      <strong>退回说明</strong>
                      {latestSubmission.returnReason}
                    </blockquote>
                  )}
                </div>
              )}
              {latestSubmission?.status === 'submitted' ||
              latestSubmission?.status === 'resubmitted' ||
              latestSubmission?.status === 'accepted' ? null : (
                <form onSubmit={submitAssignmentForm}>
                  <label htmlFor="course-assignment-content">
                    {latestSubmission?.status === 'returned'
                      ? '修订后的作业内容'
                      : '作业内容'}
                  </label>
                  <textarea
                    disabled={
                      enrollment.projectId === null || busy
                    }
                    id="course-assignment-content"
                    onChange={(event) => {
                      setAssignmentContent(event.target.value);
                    }}
                    required
                    rows={5}
                    value={assignmentContent}
                  />
                  {enrollment.projectId === null ? (
                    <small>请先绑定作品项目，再提交作业。</small>
                  ) : null}
                  <button
                    className="course-center__primary"
                    disabled={
                      enrollment.projectId === null ||
                      assignmentContent.trim().length === 0 ||
                      busy
                    }
                    type="submit"
                  >
                    {latestSubmission?.status === 'returned'
                      ? '重新提交'
                      : '提交作业'}
                  </button>
                </form>
              )}
            </section>
          )}

          {actionError === null ? null : (
            <p
              className="course-center__action-error"
              role="alert"
            >
              {actionError}
            </p>
          )}
        </section>

        <aside className="course-center__rail">
          <section className="course-center__card">
            <header>
              <span>作品项目</span>
              <strong>绑定作品项目</strong>
            </header>
            {enrollment.projectId === null ? (
              projects.length === 0 ? (
                <div className="course-center__mini-empty">
                  <p>还没有可绑定的作品项目。</p>
                  <span>请先创建项目，再回到这里绑定。</span>
                  <button
                    onClick={() => {
                      void perform(onOpenProjects);
                    }}
                    type="button"
                  >
                    创建作品项目
                  </button>
                </div>
              ) : (
                <div className="course-center__binding">
                  <label htmlFor="course-project">
                    选择项目
                  </label>
                  <select
                    id="course-project"
                    onChange={(event) => {
                      setSelectedProjectId(event.target.value);
                    }}
                    value={selectedProjectId}
                  >
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.title}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={
                      selectedProjectId.length === 0 || busy
                    }
                    onClick={() => {
                      void perform(() =>
                        onBindProject(selectedProjectId),
                      );
                    }}
                    type="button"
                  >
                    确认绑定
                  </button>
                </div>
              )
            ) : (
              <div className="course-center__bound-project">
                <span aria-hidden="true">↗</span>
                <div>
                  <strong>{projectTitle}</strong>
                  <small>已绑定</small>
                </div>
              </div>
            )}
          </section>

          <section className="course-center__card">
            <header>
              <span>评价</span>
              <strong>导师与同伴</strong>
            </header>
            {activeComments.length === 0 ? (
              <div className="course-center__mini-empty">
                <p>尚无导师或同伴评价</p>
                <span>提交作业后，可在这里查看评价状态。</span>
                <button
                  onClick={() => {
                    setActiveLessonId(
                      firstAssignmentLesson.id,
                    );
                  }}
                  type="button"
                >
                  前往必交作业
                </button>
              </div>
            ) : (
              <ul className="course-center__comments">
                {activeComments.map((comment) => (
                  <li key={comment.id}>
                    <div>
                      <strong>{comment.authorDisplayName}</strong>
                      <span>
                        {comment.authorRole === 'mentor'
                          ? '导师'
                          : '同伴'}
                      </span>
                      <small>
                        {comment.status === 'resolved'
                          ? '已处理'
                          : '待处理'}
                      </small>
                    </div>
                    <p>{comment.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="course-center__card">
            <header>
              <span>结营</span>
              <strong>
                {outcome.certificateEligible
                  ? '已达到证书申请资格'
                  : '尚未达到证书资格'}
              </strong>
            </header>
            {outcome.certificateEligible ? (
              <form
                className="course-center__certificate"
                onSubmit={exportCertificateForm}
              >
                <label>
                  <span>证书姓名</span>
                  <input
                    autoComplete="name"
                    disabled={busy}
                    maxLength={80}
                    onChange={(event) => {
                      setCertificateName(event.currentTarget.value);
                    }}
                    placeholder="填写用于证书的姓名"
                    required
                    value={certificateName}
                  />
                </label>
                <button disabled={busy} type="submit">
                  生成 PDF 证书
                </button>
                {certificateStatus.length > 0 ? (
                  <p aria-live="polite" role="status">
                    {certificateStatus}
                  </p>
                ) : null}
              </form>
            ) : (
              <ul className="course-center__blockers">
                {outcome.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="course-center__card">
            <header>
              <span>班级</span>
              <strong>班级通知</strong>
            </header>
            {enrollment.announcements.filter(
              (announcement) =>
                announcement.status === 'published',
            ).length === 0 ? (
              <div className="course-center__mini-empty">
                <p>暂无班级通知</p>
                <span>有新安排时会显示在这里。</span>
                <button
                  onClick={() => {
                    void perform(onRefresh);
                  }}
                  type="button"
                >
                  刷新通知
                </button>
              </div>
            ) : (
              <ul className="course-center__announcements">
                {enrollment.announcements
                  .filter(
                    (announcement) =>
                      announcement.status === 'published',
                  )
                  .map((announcement) => (
                    <li key={announcement.id}>
                      <strong>{announcement.title}</strong>
                      <p>{announcement.body}</p>
                      <time dateTime={announcement.publishedAt}>
                        {formatCourseDate(
                          announcement.publishedAt,
                        )}
                      </time>
                    </li>
                  ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </main>
  );
}

interface CourseCenterStateProps {
  title: string;
  detail: string;
  tone: 'loading' | 'empty' | 'error';
  actionLabel?: string;
  onAction?: () => Promise<void>;
}

function CourseCenterState({
  title,
  detail,
  tone,
  actionLabel,
  onAction,
}: CourseCenterStateProps) {
  return (
    <main className="course-center course-center--state">
      <section
        aria-live="polite"
        className={`course-center__state course-center__state--${tone}`}
        role={tone === 'error' ? 'alert' : 'status'}
      >
        <span aria-hidden="true">
          {tone === 'loading' ? '···' : tone === 'error' ? '!' : '→'}
        </span>
        <h1>{title}</h1>
        <p>{detail}</p>
        {actionLabel === undefined || onAction === undefined ? null : (
          <button
            onClick={() => {
              void onAction();
            }}
            type="button"
          >
            {actionLabel}
          </button>
        )}
      </section>
    </main>
  );
}

function lessonProgressLabel(
  status: LessonProgressStatus,
): string {
  switch (status) {
    case 'completed':
      return '已完成';
    case 'in_progress':
      return '学习中';
    case 'not_started':
      return '未开始';
  }
}

function submissionStatusLabel(
  status: CourseEnrollment['submissions'][number]['status'],
): string {
  switch (status) {
    case 'submitted':
      return '待评价';
    case 'returned':
      return '已退回';
    case 'resubmitted':
      return '已重提';
    case 'accepted':
      return '已验收';
  }
}

function formatCourseDate(timestamp: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function courseCenterErrorMessage(reason: unknown): string {
  return reason instanceof Error &&
    reason.message.trim().length > 0
    ? reason.message
    : '操作未完成，请重试。';
}

function downloadCertificate(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

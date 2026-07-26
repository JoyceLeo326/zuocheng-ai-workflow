import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CourseCenterController,
  CourseCenterView,
  type CourseCenterViewCallbacks,
} from './course-center.js';
import {
  LOCAL_7_DAY_COURSE,
  bindCourseProject,
  createCourseEnrollment,
  publishClassAnnouncement,
  publishCourseComment,
  returnAssignment,
  submitAssignment,
} from './course-model.js';
import { MemoryCourseStore } from './course-store.js';

const CREATED_AT = '2026-07-27T01:00:00.000Z';

function enrollment() {
  return createCourseEnrollment({
    id: 'enrollment-local-001',
    learnerId: 'learner-local-001',
    course: LOCAL_7_DAY_COURSE,
    timestamp: CREATED_AT,
  });
}

function callbacks(): CourseCenterViewCallbacks {
  return {
    onCreateEnrollment: vi.fn().mockResolvedValue(undefined),
    onBindProject: vi.fn().mockResolvedValue(undefined),
    onUpdateLesson: vi.fn().mockResolvedValue(undefined),
    onSubmitAssignment: vi.fn().mockResolvedValue(undefined),
    onResubmitAssignment: vi.fn().mockResolvedValue(undefined),
    onExportCertificate: vi.fn().mockResolvedValue(undefined),
    onOpenProjects: vi.fn().mockResolvedValue(undefined),
    onRefresh: vi.fn().mockResolvedValue(undefined),
  };
}

describe('course center', () => {
  it('renders actionable loading, empty, error and offline states', () => {
    const loading = renderToStaticMarkup(
      <CourseCenterView
        {...callbacks()}
        enrollment={null}
        loading
        online
        projects={[]}
      />,
    );
    const empty = renderToStaticMarkup(
      <CourseCenterView
        {...callbacks()}
        enrollment={null}
        loading={false}
        online
        projects={[]}
      />,
    );
    const failed = renderToStaticMarkup(
      <CourseCenterView
        {...callbacks()}
        enrollment={null}
        error="课程记录读取失败"
        loading={false}
        online
        projects={[]}
      />,
    );
    const offline = renderToStaticMarkup(
      <CourseCenterView
        {...callbacks()}
        enrollment={enrollment()}
        loading={false}
        online={false}
        projects={[]}
      />,
    );

    expect(loading).toContain('role="status"');
    expect(loading).toContain('正在读取课程记录');
    expect(empty).toContain('开始 7 天课程');
    expect(empty).toContain('>创建学习记录</button>');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('课程记录读取失败');
    expect(failed).toContain('>重新读取</button>');
    expect(offline).toContain('当前离线');
    expect(offline).toContain('>刷新状态</button>');
    expect(offline).toContain('还没有可绑定的作品项目');
    expect(offline).toContain('>创建作品项目</button>');
  });

  it('shows seven days, eighteen real lessons, computed progress and project binding without internal product slogans', () => {
    const html = renderToStaticMarkup(
      <CourseCenterView
        {...callbacks()}
        enrollment={enrollment()}
        initialLessonId="lesson-03"
        loading={false}
        online
        projects={[
          {
            id: 'project-local-001',
            title: '课程汇报项目',
          },
        ]}
      />,
    );

    expect(html).toContain('课程中心');
    expect(html).toContain('7 天做成一份可信作品');
    expect(html).toContain('18 节');
    expect(html).toContain('0 / 18');
    expect(html).toContain('第 1 天');
    expect(html).toContain('第 7 天');
    expect(html).toContain('建立任务卡与材料清单');
    expect(html).toContain('提交任务卡');
    expect(html).toContain('绑定作品项目');
    expect(html).toContain('课程汇报项目');
    expect(html).toContain('尚未达到证书资格');
    expect(html).toContain('尚无导师或同伴评价');
    expect(html).toContain('>前往必交作业</button>');
    expect(html).toContain('暂无班级通知');
    expect(html).toContain('>刷新通知</button>');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="0"');
    expect(html).not.toContain('本地优先');
    expect(html).not.toContain('零成本');
    expect(html).not.toContain('无需登录');
    expect(html).not.toContain('假点评');
    expect(html).not.toContain('IndexedDB');
  });

  it('renders only persisted returns, mentor or peer comments and announcements with their real states', () => {
    let current = bindCourseProject(
      enrollment(),
      'project-local-001',
      '2026-07-27T01:01:00.000Z',
    );
    current = submitAssignment(current, {
      id: 'submission-001',
      lessonId: 'lesson-03',
      content: '第一版任务卡',
      timestamp: '2026-07-27T01:02:00.000Z',
    });
    current = returnAssignment(current, {
      submissionId: 'submission-001',
      reviewerRole: 'mentor',
      reason: '请补充材料出处。',
      timestamp: '2026-07-27T01:03:00.000Z',
    });
    current = publishCourseComment(current, {
      id: 'comment-001',
      submissionId: 'submission-001',
      authorId: 'mentor-real-001',
      authorDisplayName: '林老师',
      authorRole: 'mentor',
      body: '任务边界清楚，出处仍需补齐。',
      timestamp: '2026-07-27T01:04:00.000Z',
    });
    current = publishClassAnnouncement(current, {
      id: 'announcement-001',
      title: '第 3 天答疑',
      body: '今晚 20:00 开放答疑。',
      timestamp: '2026-07-27T01:05:00.000Z',
    });

    const html = renderToStaticMarkup(
      <CourseCenterView
        {...callbacks()}
        enrollment={current}
        initialLessonId="lesson-03"
        loading={false}
        online
        projects={[
          {
            id: 'project-local-001',
            title: '课程汇报项目',
          },
        ]}
      />,
    );

    expect(html).toContain('已退回');
    expect(html).toContain('请补充材料出处。');
    expect(html).toContain('重新提交');
    expect(html).toContain('林老师');
    expect(html).toContain('导师');
    expect(html).toContain('待处理');
    expect(html).toContain('任务边界清楚，出处仍需补齐。');
    expect(html).toContain('第 3 天答疑');
    expect(html).toContain('今晚 20:00 开放答疑。');
  });

  it('persists controller actions through the injected store with no optimistic fake success', async () => {
    const store = new MemoryCourseStore();
    await store.createEnrollment(enrollment());
    const times = [
      '2026-07-27T01:01:00.000Z',
      '2026-07-27T01:02:00.000Z',
      '2026-07-27T01:03:00.000Z',
    ];
    const controller = new CourseCenterController({
      store,
      enrollmentId: 'enrollment-local-001',
      now: () => new Date(times.shift()!),
      idFactory: () => 'submission-controller-001',
    });

    await controller.bindProject('project-local-001');
    await controller.updateLesson('lesson-03', 'in_progress');
    const saved = await controller.submitAssignment(
      'lesson-03',
      '控制器写入的真实作业',
    );

    expect(saved).toMatchObject({
      projectId: 'project-local-001',
      version: 4,
    });
    expect(saved.lessonProgress[2]).toMatchObject({
      status: 'in_progress',
    });
    expect(saved.submissions).toEqual([
      expect.objectContaining({
        id: 'submission-controller-001',
        content: '控制器写入的真实作业',
        status: 'submitted',
      }),
    ]);
    await expect(
      store.getEnrollment('enrollment-local-001'),
    ).resolves.toEqual(saved);
  });
});

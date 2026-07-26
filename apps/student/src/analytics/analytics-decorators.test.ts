import { describe, expect, it, vi } from 'vitest';
import type { CourseEnrollment, CourseDefinition } from '../course/course-model.js';
import type { CourseStore } from '../course/course-store.js';
import type {
  SourceIngestionResult,
  WorkbenchProjectLifecycleService,
} from '../workbench/workbench-service.js';
import type { Project } from '../workbench/project-model.js';
import {
  decorateCourseStoreWithAnalytics,
  decorateWorkbenchServiceWithAnalytics,
} from './analytics-decorators.js';
import { MemoryProductEventLedger } from './event-ledger.js';
import { createProductEventRecorder } from './event-recorder.js';

const PROJECT_ID = '019b0000-0000-7000-8000-000000000031';
const ids = [
  '019b0000-0000-7000-8000-000000000041',
  '019b0000-0000-7000-8000-000000000042',
  '019b0000-0000-7000-8000-000000000043',
  '019b0000-0000-7000-8000-000000000044',
  '019b0000-0000-7000-8000-000000000045',
  '019b0000-0000-7000-8000-000000000046',
  '019b0000-0000-7000-8000-000000000047',
  '019b0000-0000-7000-8000-000000000048',
];

function analytics() {
  const ledger = new MemoryProductEventLedger();
  let index = 0;
  return {
    ledger,
    recorder: createProductEventRecorder({
      ledger,
      context: {
        anonymousId: '019b0000-0000-7000-8000-000000000030',
        sourceVersion: 'student-1.0.0',
      },
      now: () => new Date('2026-07-27T04:15:00.000Z'),
      idFactory: () => ids[index++]!,
    }),
  };
}

function project(
  overrides: Partial<Project> = {},
): Project {
  return {
    id: PROJECT_ID,
    version: 1,
    schemaVersion: 1,
    createdAt: '2026-07-27T04:15:00.000Z',
    updatedAt: '2026-07-27T04:15:00.000Z',
    title: 'Project',
    status: 'active',
    taskDefinition: {
      id: '019b0000-0000-7000-8000-000000000032',
      version: 1,
      createdAt: '2026-07-27T04:15:00.000Z',
      updatedAt: '2026-07-27T04:15:00.000Z',
      taskName: 'Task',
      audience: 'Audience',
      dueAt: '2026-08-01T00:00:00.000Z',
      lengthTarget: { unit: 'pages', value: 3 },
      presentationDurationMinutes: null,
      outputFormats: ['pdf'],
      rubric: [],
      tone: 'Direct',
      mustInclude: [],
      mustAvoid: [],
    },
    sourceFiles: [],
    sourceChunks: [],
    evidenceCards: [],
    outlines: [],
    activeOutlineId: null,
    artifacts: [],
    verificationResults: [],
    ...overrides,
  } as Project;
}

describe('successful business-action analytics decorators', () => {
  it('records project and task creation plus the first second-project milestone only after success', async () => {
    const setup = analytics();
    const existing = project({ id: 'existing-project' });
    const service = {
      listProjects: vi.fn(async () => [existing]),
      createProject: vi.fn(async () => project()),
    } as unknown as WorkbenchProjectLifecycleService;
    const decorated = decorateWorkbenchServiceWithAnalytics(
      service,
      setup.recorder,
    );

    await expect(
      decorated.createProject({
        taskName: 'Task',
        audience: 'Audience',
        deadline: '2026-08-01T00:00',
        scope: '3 页',
        durationMinutes: '',
        outputFormat: 'pdf',
        tone: 'Direct',
        rubric: [],
        requiredContent: '',
        forbiddenContent: '',
      }),
    ).resolves.toMatchObject({ id: PROJECT_ID });

    expect((await setup.ledger.list()).map((record) => record.event.name)).toEqual([
      'project_created',
      'task_defined',
      'second_project_started',
    ]);
  });

  it('does not count rejected operations, duplicate uploads or failed parsing', async () => {
    const setup = analytics();
    const service = {
      listProjects: vi.fn(async () => []),
      createProject: vi.fn(async () => {
        throw new Error('business action rejected');
      }),
      ingestSourceFile: vi.fn(async () => ({
        status: 'failed',
        project: project(),
        sourceFile: {
          id: 'source-001',
          version: 1,
        },
        errorCode: 'CORRUPT_PDF',
      }) as SourceIngestionResult),
    } as unknown as WorkbenchProjectLifecycleService;
    const decorated = decorateWorkbenchServiceWithAnalytics(
      service,
      setup.recorder,
    );

    await expect(
      decorated.createProject({} as never),
    ).rejects.toThrow('business action rejected');
    await expect(
      decorated.ingestSourceFile(
        PROJECT_ID,
        new File(['bad'], 'bad.pdf', { type: 'application/pdf' }),
      ),
    ).resolves.toMatchObject({ status: 'failed' });
    await expect(setup.ledger.list()).resolves.toEqual([]);
  });

  it('maps successful material, evidence, outline, generation and export operations without page-view events', async () => {
    const setup = analytics();
    const sourceFile = {
      id: 'source-001',
      version: 1,
      sourceVersion: 1,
    };
    const withEvidence = project({
      evidenceCards: [{ id: 'evidence-001', version: 1 } as never],
    });
    const withOutline = project({
      outlines: [{ id: 'outline-001', version: 1 } as never],
    });
    const withArtifact = project({
      artifacts: [{ id: 'artifact-001', version: 1 } as never],
    });
    const service = {
      listProjects: vi.fn(async () => [project()]),
      ingestSourceFile: vi.fn(async () => ({
        status: 'ready',
        project: project(),
        sourceFile,
        chunks: [],
      }) as unknown as SourceIngestionResult),
      createEvidence: vi.fn(async () => withEvidence),
      createOutline: vi.fn(async () => withOutline),
      ensureDraftArtifact: vi.fn(async () => withArtifact),
      exportProjectBundle: vi.fn(async () => ({ kind: 'bundle' })),
    } as unknown as WorkbenchProjectLifecycleService;
    const decorated = decorateWorkbenchServiceWithAnalytics(
      service,
      setup.recorder,
      {
        operationIdFactory: () =>
          '019b0000-0000-7000-8000-000000000099',
      },
    );

    await decorated.ingestSourceFile(
      PROJECT_ID,
      new File(['pdf'], 'source.pdf', { type: 'application/pdf' }),
    );
    await decorated.createEvidence(PROJECT_ID, {} as never);
    await decorated.createOutline(PROJECT_ID, {} as never);
    await decorated.ensureDraftArtifact(PROJECT_ID, 'outline-001');
    await decorated.exportProjectBundle(PROJECT_ID);

    expect((await setup.ledger.list()).map((record) => record.event.name)).toEqual([
      'file_uploaded',
      'evidence_added',
      'outline_created',
      'artifact_generated',
      'artifact_exported',
    ]);
  });

  it('records course completion only on the transition into completed', async () => {
    const setup = analytics();
    const course: CourseDefinition = {
      id: 'course-001',
      title: 'Course',
      description: 'Course',
      durationDays: 1,
      lessons: [
        {
          id: 'lesson-001',
          day: 1,
          order: 1,
          title: 'Lesson',
          summary: 'Lesson',
          objectives: [],
          estimatedMinutes: 10,
          assignment: null,
        },
      ],
    };
    const before: CourseEnrollment = {
      schemaVersion: 1,
      id: 'enrollment-001',
      version: 1,
      createdAt: '2026-07-27T04:15:00.000Z',
      updatedAt: '2026-07-27T04:15:00.000Z',
      learnerId: 'learner-001',
      courseId: course.id,
      projectId: PROJECT_ID,
      lessonProgress: [
        {
          lessonId: 'lesson-001',
          status: 'in_progress',
          startedAt: '2026-07-27T04:15:00.000Z',
          completedAt: null,
          updatedAt: '2026-07-27T04:15:00.000Z',
        },
      ],
      submissions: [],
      comments: [],
      announcements: [],
    };
    const completed: CourseEnrollment = {
      ...before,
      version: 2,
      updatedAt: '2026-07-27T04:16:00.000Z',
      lessonProgress: [
        {
          ...before.lessonProgress[0]!,
          status: 'completed',
          completedAt: '2026-07-27T04:16:00.000Z',
          updatedAt: '2026-07-27T04:16:00.000Z',
        },
      ],
    };
    const store = {
      getEnrollment: vi.fn(async () => before),
      saveEnrollment: vi.fn(async () => completed),
      createEnrollment: vi.fn(),
      listEnrollments: vi.fn(),
      close: vi.fn(),
    } satisfies CourseStore;
    const decorated = decorateCourseStoreWithAnalytics(
      store,
      setup.recorder,
      { course },
    );

    await decorated.saveEnrollment(completed, 1);
    expect((await setup.ledger.list()).map((record) => record.event.name)).toEqual([
      'course_completed',
    ]);
  });
});

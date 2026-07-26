import {
  LOCAL_7_DAY_COURSE,
  courseOutcome,
  type CourseDefinition,
} from '../course/course-model.js';
import type { CourseStore } from '../course/course-store.js';
import type {
  SourceIngestionResult,
  WorkbenchProjectLifecycleService,
} from '../workbench/workbench-service.js';
import { createProductEventId } from './product-event.js';
import type { ProductEventRecorder } from './event-recorder.js';

export interface AnalyticsDecoratorOptions {
  onAnalyticsError?(error: unknown): void;
  operationIdFactory?: () => string;
}

export interface CourseAnalyticsDecoratorOptions
  extends AnalyticsDecoratorOptions {
  course?: CourseDefinition;
}

export interface ProductAnalyticsHooks {
  signupCompleted(input: {
    idempotencyKey: string;
  }): Promise<void>;
}

export function createProductAnalyticsHooks(
  recorder: ProductEventRecorder,
  options: AnalyticsDecoratorOptions = {},
): ProductAnalyticsHooks {
  return {
    async signupCompleted({ idempotencyKey }) {
      await track(
        recorder,
        {
          name: 'signup_completed',
          idempotencyKey,
        },
        options,
      );
    },
  };
}

export function decorateWorkbenchServiceWithAnalytics(
  service: WorkbenchProjectLifecycleService,
  recorder: ProductEventRecorder,
  options: AnalyticsDecoratorOptions = {},
): WorkbenchProjectLifecycleService {
  const operationId =
    options.operationIdFactory ?? (() => createProductEventId());

  const overrides: Partial<WorkbenchProjectLifecycleService> = {
    async createProject(input) {
      const before = await service.listProjects();
      const project = await service.createProject(input);
      await trackAll(
        recorder,
        [
          {
            name: 'project_created',
            projectId: project.id,
            idempotencyKey: `project_created:${project.id}:${String(project.version)}`,
          },
          {
            name: 'task_defined',
            projectId: project.id,
            idempotencyKey: `task_defined:${project.taskDefinition.id}:${String(project.taskDefinition.version)}`,
          },
          ...(before.length === 1
            ? [
                {
                  name: 'second_project_started' as const,
                  projectId: project.id,
                  idempotencyKey: `second_project_started:${project.id}`,
                },
              ]
            : []),
        ],
        options,
      );
      return project;
    },

    async ingestSourceFile(projectId, file) {
      const result = await service.ingestSourceFile(projectId, file);
      await trackReadySource(result, recorder, options);
      return result;
    },

    ...(service.ingestAcquiredMaterial === undefined
      ? {}
      : {
          async ingestAcquiredMaterial(projectId, result, originalFile) {
            const ingested = await service.ingestAcquiredMaterial!(
              projectId,
              result,
              originalFile,
            );
            await trackReadySource(ingested, recorder, options);
            return ingested;
          },
        }),

    async retrySourceFile(projectId, sourceFileId) {
      const result = await service.retrySourceFile(projectId, sourceFileId);
      await trackReadySource(result, recorder, options);
      return result;
    },

    async replaceSourceFile(projectId, sourceFileId, file) {
      const result = await service.replaceSourceFile(
        projectId,
        sourceFileId,
        file,
      );
      await trackReadySource(result, recorder, options);
      return result;
    },

    async createEvidence(projectId, input) {
      const project = await service.createEvidence(projectId, input);
      const evidence = project.evidenceCards.at(-1);
      if (evidence !== undefined) {
        await track(
          recorder,
          {
            name: 'evidence_added',
            projectId: project.id,
            idempotencyKey: `evidence_added:${evidence.id}:${String(evidence.version)}`,
          },
          options,
        );
      }
      return project;
    },

    async createOutline(projectId, input) {
      const project = await service.createOutline(projectId, input);
      const outline = project.outlines.at(-1);
      if (outline !== undefined) {
        await track(
          recorder,
          {
            name: 'outline_created',
            projectId: project.id,
            idempotencyKey: `outline_created:${outline.id}:${String(outline.version)}`,
          },
          options,
        );
      }
      return project;
    },

    async ensureDraftArtifact(projectId, outlineId) {
      const previous = (await service.listProjects()).find(
        (project) => project.id === projectId,
      );
      const priorIds = new Set(
        previous?.artifacts.map((artifact) => artifact.id) ?? [],
      );
      const project = await service.ensureDraftArtifact(projectId, outlineId);
      const artifact = project.artifacts.find(
        (candidate) => !priorIds.has(candidate.id),
      );
      if (artifact !== undefined) {
        await track(
          recorder,
          {
            name: 'artifact_generated',
            projectId: project.id,
            idempotencyKey: `artifact_generated:${artifact.id}:${String(artifact.version)}`,
          },
          options,
        );
      }
      return project;
    },

    async exportProjectBundle(projectId) {
      const exportOperationId = operationId();
      const bundle = await service.exportProjectBundle(projectId);
      await track(
        recorder,
        {
          name: 'artifact_exported',
          projectId,
          idempotencyKey: `artifact_exported:${projectId}:${exportOperationId}`,
        },
        options,
      );
      return bundle;
    },
  };

  return new Proxy(service, {
    get(target, property) {
      const override =
        overrides[property as keyof WorkbenchProjectLifecycleService];
      if (override !== undefined) {
        return override;
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function decorateCourseStoreWithAnalytics(
  store: CourseStore,
  recorder: ProductEventRecorder,
  options: CourseAnalyticsDecoratorOptions = {},
): CourseStore {
  const course = options.course ?? LOCAL_7_DAY_COURSE;
  return {
    createEnrollment: (enrollment) =>
      store.createEnrollment(enrollment),
    getEnrollment: (enrollmentId) =>
      store.getEnrollment(enrollmentId),
    listEnrollments: () => store.listEnrollments(),
    async saveEnrollment(enrollment, expectedVersion) {
      const previous = await store.getEnrollment(enrollment.id);
      const saved = await store.saveEnrollment(
        enrollment,
        expectedVersion,
      );
      const wasCompleted =
        previous !== null &&
        courseOutcome(previous, course).completionStatus === 'completed';
      const isCompleted =
        courseOutcome(saved, course).completionStatus === 'completed';
      if (!wasCompleted && isCompleted) {
        await track(
          recorder,
          {
            name: 'course_completed',
            projectId: saved.projectId,
            idempotencyKey: `course_completed:${saved.id}`,
          },
          options,
        );
      }
      return saved;
    },
    close: () => {
      store.close();
    },
  };
}

async function trackReadySource(
  result: SourceIngestionResult,
  recorder: ProductEventRecorder,
  options: AnalyticsDecoratorOptions,
): Promise<void> {
  if (result.status !== 'ready') {
    return;
  }
  await track(
    recorder,
    {
      name: 'file_uploaded',
      projectId: result.project.id,
      idempotencyKey: `file_uploaded:${result.sourceFile.id}:${String(result.sourceFile.sourceVersion)}`,
    },
    options,
  );
}

async function trackAll(
  recorder: ProductEventRecorder,
  inputs: readonly Parameters<ProductEventRecorder['record']>[0][],
  options: AnalyticsDecoratorOptions,
): Promise<void> {
  for (const input of inputs) {
    await track(recorder, input, options);
  }
}

async function track(
  recorder: ProductEventRecorder,
  input: Parameters<ProductEventRecorder['record']>[0],
  options: AnalyticsDecoratorOptions,
): Promise<void> {
  try {
    await recorder.record(input);
  } catch (error) {
    if (options.onAnalyticsError === undefined) {
      throw error;
    }
    options.onAnalyticsError(error);
  }
}

import {
  DeletionStatusSchema,
  ETagSchema,
  IdempotencyKeySchema,
  ProjectStatusSchema,
  ResourceVersionSchema,
  UUIDv7Schema,
  formatETag,
} from '@zuocheng/contracts';
import { z } from 'zod';
import { createRequestFingerprint } from '../http/preconditions.js';

export const ProjectRecordSchema = z
  .strictObject({
    id: UUIDv7Schema,
    tenantId: UUIDv7Schema,
    version: ResourceVersionSchema,
    etag: ETagSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(4_000).nullable(),
    status: ProjectStatusSchema,
    deletionStatus: DeletionStatusSchema,
    copiedFromProjectId: UUIDv7Schema.nullable(),
    createdBy: UUIDv7Schema,
    updatedBy: UUIDv7Schema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    archivedAt: z.iso.datetime().nullable(),
    deletedAt: z.iso.datetime().nullable(),
  })
  .superRefine((project, context) => {
    if (project.etag !== formatETag(project.version)) {
      context.addIssue({
        code: 'custom',
        message: 'ETag must represent the project version',
        path: ['etag'],
      });
    }
    if (project.status === 'active' && project.archivedAt !== null) {
      context.addIssue({
        code: 'custom',
        message: 'An active project cannot have an archive timestamp',
        path: ['archivedAt'],
      });
    }
    if (project.status === 'archived' && project.archivedAt === null) {
      context.addIssue({
        code: 'custom',
        message: 'An archived project requires an archive timestamp',
        path: ['archivedAt'],
      });
    }
    if (project.deletionStatus === 'active' && project.deletedAt !== null) {
      context.addIssue({
        code: 'custom',
        message: 'An active project cannot have a deletion timestamp',
        path: ['deletedAt'],
      });
    }
    if (project.deletionStatus !== 'active' && project.deletedAt === null) {
      context.addIssue({
        code: 'custom',
        message: 'A deleted project requires a deletion timestamp',
        path: ['deletedAt'],
      });
    }
  });

export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export const DeletionTaskSchema = z.strictObject({
  id: UUIDv7Schema,
  tenantId: UUIDv7Schema,
  projectId: UUIDv7Schema,
  status: z.literal('purge_pending'),
  requestedBy: UUIDv7Schema,
  requestedAt: z.iso.datetime(),
});

export type DeletionTask = z.infer<typeof DeletionTaskSchema>;

export type TenantContext = {
  tenantId: string;
  userId: string;
  membershipId: string;
  sessionId: string;
};

const CreateProjectInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4_000).nullable().optional(),
});

const UpdateProjectInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(4_000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one project field must be updated',
  });

const CopyProjectInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(160).optional(),
});

export type CreateProjectCommand = {
  tenantId: string;
  actorUserId: string;
  projectId: string;
  version: 1;
  name: string;
  description: string | null;
  idempotencyKey: string;
  requestHash: string;
  occurredAt: string;
};

type ExistingProjectMutationCommand = {
  tenantId: string;
  actorUserId: string;
  projectId: string;
  expectedVersion: number;
  idempotencyKey: string;
  requestHash: string;
  occurredAt: string;
};

export type UpdateProjectCommand = ExistingProjectMutationCommand & {
  patch: {
    name?: string;
    description?: string | null;
  };
};

export type CopyProjectCommand = Omit<
  ExistingProjectMutationCommand,
  'projectId'
> & {
  sourceProjectId: string;
  copiedProjectId: string;
  name: string | null;
};

export type ArchiveProjectCommand = ExistingProjectMutationCommand;

export type SoftDeleteProjectCommand = ExistingProjectMutationCommand & {
  preserveProjectStatus: true;
};

export type RestoreProjectCommand = ExistingProjectMutationCommand & {
  prohibitedDeletionStatus: 'purge_pending';
};

export type PermanentDeleteProjectCommand = ExistingProjectMutationCommand & {
  deletionTaskId: string;
  requiredDeletionStatus: 'soft_deleted';
};

type CreateResult =
  | { kind: 'applied' | 'replayed'; project: ProjectRecord }
  | { kind: 'idempotency_conflict' };

type ProjectMutationResult =
  | { kind: 'applied' | 'replayed' | 'unchanged'; project: ProjectRecord }
  | { kind: 'not_found' }
  | { kind: 'version_conflict'; current: ProjectRecord }
  | { kind: 'idempotency_conflict' }
  | { kind: 'forbidden' }
  | { kind: 'invalid_state'; current: ProjectRecord };

type PermanentDeleteResult =
  | {
      kind: 'applied' | 'replayed';
      project: ProjectRecord;
      deletionTask: DeletionTask;
    }
  | Exclude<ProjectMutationResult, { kind: 'applied' | 'replayed' | 'unchanged' }>;

/**
 * Every mutation method is an atomic persistence boundary: idempotency claim,
 * tenant-scoped CAS, version/audit append, and response persistence succeed or
 * fail as one transaction. Implementations must never authorize by a client
 * supplied tenant identifier.
 */
export type ProjectStore = {
  create(command: CreateProjectCommand): Promise<CreateResult>;
  listVisible(tenantId: string, actorUserId: string): Promise<ProjectRecord[]>;
  findVisible(
    tenantId: string,
    actorUserId: string,
    projectId: string,
  ): Promise<ProjectRecord | null>;
  update(command: UpdateProjectCommand): Promise<ProjectMutationResult>;
  copy(command: CopyProjectCommand): Promise<ProjectMutationResult>;
  archive(command: ArchiveProjectCommand): Promise<ProjectMutationResult>;
  softDelete(command: SoftDeleteProjectCommand): Promise<ProjectMutationResult>;
  restore(command: RestoreProjectCommand): Promise<ProjectMutationResult>;
  requestPermanentDelete(
    command: PermanentDeleteProjectCommand,
  ): Promise<PermanentDeleteResult>;
};

export type ProjectServiceCode =
  | 'VALIDATION_FAILED'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_ACCESS_DENIED'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_PROJECT_STATE'
  | 'STORE_INVARIANT_VIOLATION'
  | 'UUID_GENERATOR_NOT_CONFIGURED';

export class ProjectServiceError extends Error {
  readonly status: 403 | 404 | 409 | 422 | 500;
  readonly code: ProjectServiceCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    status: 403 | 404 | 409 | 422 | 500,
    code: ProjectServiceCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'ProjectServiceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type ProjectServiceDependencies = {
  createId?: () => string;
  now?: () => Date;
};

export class ProjectService {
  readonly #store: ProjectStore;
  readonly #createId: () => string;
  readonly #now: () => Date;

  constructor(
    store: ProjectStore,
    dependencies: ProjectServiceDependencies = {},
  ) {
    this.#store = store;
    this.#createId =
      dependencies.createId ??
      (() => {
        throw new ProjectServiceError(
          500,
          'UUID_GENERATOR_NOT_CONFIGURED',
          'A UUIDv7 generator is required to create projects or deletion tasks',
        );
      });
    this.#now = dependencies.now ?? (() => new Date());
  }

  async create(
    context: TenantContext,
    untrustedInput: unknown,
    untrustedIdempotencyKey: string,
  ): Promise<ProjectRecord> {
    const trustedContext = parseContext(context);
    const input = parseInput(CreateProjectInputSchema, untrustedInput);
    const idempotencyKey = parseInput(
      IdempotencyKeySchema,
      untrustedIdempotencyKey,
    );
    const projectId = this.#newId();
    const occurredAt = this.#occurredAt();
    const requestHash = fingerprint('POST', '/v1/projects', input);

    const result = await this.#store.create({
      tenantId: trustedContext.tenantId,
      actorUserId: trustedContext.userId,
      projectId,
      version: 1,
      name: input.name,
      description: input.description ?? null,
      idempotencyKey,
      requestHash,
      occurredAt,
    });

    if (result.kind === 'idempotency_conflict') {
      throw idempotencyConflict();
    }
    return ProjectRecordSchema.parse(result.project);
  }

  async list(context: TenantContext): Promise<ProjectRecord[]> {
    const trustedContext = parseContext(context);
    const projects = await this.#store.listVisible(
      trustedContext.tenantId,
      trustedContext.userId,
    );
    return z.array(ProjectRecordSchema).parse(projects);
  }

  async get(
    context: TenantContext,
    untrustedProjectId: string,
  ): Promise<ProjectRecord> {
    const trustedContext = parseContext(context);
    const projectId = parseInput(UUIDv7Schema, untrustedProjectId);
    const project = await this.#store.findVisible(
      trustedContext.tenantId,
      trustedContext.userId,
      projectId,
    );
    if (project === null) {
      throw projectNotFound();
    }
    return ProjectRecordSchema.parse(project);
  }

  async update(
    context: TenantContext,
    untrustedProjectId: string,
    untrustedPatch: unknown,
    untrustedIfMatch: string,
    untrustedIdempotencyKey: string,
  ): Promise<ProjectRecord> {
    const trustedContext = parseContext(context);
    const projectId = parseInput(UUIDv7Schema, untrustedProjectId);
    const parsedPatch = parseInput(UpdateProjectInputSchema, untrustedPatch);
    const patch: UpdateProjectCommand['patch'] = {
      ...(parsedPatch.name === undefined ? {} : { name: parsedPatch.name }),
      ...(parsedPatch.description === undefined
        ? {}
        : { description: parsedPatch.description }),
    };
    const preconditions = parseMutationPreconditions(
      untrustedIfMatch,
      untrustedIdempotencyKey,
    );
    const result = await this.#store.update({
      tenantId: trustedContext.tenantId,
      actorUserId: trustedContext.userId,
      projectId,
      expectedVersion: preconditions.expectedVersion,
      patch,
      idempotencyKey: preconditions.idempotencyKey,
      requestHash: fingerprint(
        'PATCH',
        `/v1/projects/${projectId}`,
        patch,
        preconditions.expectedVersion,
      ),
      occurredAt: this.#occurredAt(),
    });
    return handleMutationResult(result, preconditions.expectedVersion);
  }

  async copy(
    context: TenantContext,
    untrustedSourceProjectId: string,
    untrustedInput: unknown,
    untrustedIfMatch: string,
    untrustedIdempotencyKey: string,
  ): Promise<ProjectRecord> {
    const trustedContext = parseContext(context);
    const sourceProjectId = parseInput(UUIDv7Schema, untrustedSourceProjectId);
    const input = parseInput(CopyProjectInputSchema, untrustedInput);
    const preconditions = parseMutationPreconditions(
      untrustedIfMatch,
      untrustedIdempotencyKey,
    );
    const copiedProjectId = this.#newId();
    const result = await this.#store.copy({
      tenantId: trustedContext.tenantId,
      actorUserId: trustedContext.userId,
      sourceProjectId,
      copiedProjectId,
      expectedVersion: preconditions.expectedVersion,
      name: input.name ?? null,
      idempotencyKey: preconditions.idempotencyKey,
      requestHash: fingerprint(
        'POST',
        `/v1/projects/${sourceProjectId}/copies`,
        input,
        preconditions.expectedVersion,
      ),
      occurredAt: this.#occurredAt(),
    });
    const project = handleMutationResult(result, preconditions.expectedVersion);
    if (project.copiedFromProjectId !== sourceProjectId) {
      throw storeInvariant('A copied project must reference its source project');
    }
    return project;
  }

  async archive(
    context: TenantContext,
    untrustedProjectId: string,
    untrustedIfMatch: string,
    untrustedIdempotencyKey: string,
  ): Promise<ProjectRecord> {
    const { trustedContext, projectId, preconditions, command } =
      this.#mutationCommand(
        context,
        untrustedProjectId,
        untrustedIfMatch,
        untrustedIdempotencyKey,
        'POST',
        'archive',
      );
    const result = await this.#store.archive({
      ...command,
      tenantId: trustedContext.tenantId,
      actorUserId: trustedContext.userId,
      projectId,
    });
    const project = handleMutationResult(result, preconditions.expectedVersion);
    if (project.status !== 'archived') {
      throw storeInvariant('Archive must return an archived project');
    }
    if (result.kind === 'unchanged' && project.version !== preconditions.expectedVersion) {
      throw storeInvariant('An unchanged archive cannot increment the version');
    }
    return project;
  }

  async softDelete(
    context: TenantContext,
    untrustedProjectId: string,
    untrustedIfMatch: string,
    untrustedIdempotencyKey: string,
  ): Promise<ProjectRecord> {
    const { trustedContext, projectId, preconditions, command } =
      this.#mutationCommand(
        context,
        untrustedProjectId,
        untrustedIfMatch,
        untrustedIdempotencyKey,
        'DELETE',
        undefined,
      );
    const result = await this.#store.softDelete({
      ...command,
      tenantId: trustedContext.tenantId,
      actorUserId: trustedContext.userId,
      projectId,
      preserveProjectStatus: true,
    });
    const project = handleMutationResult(result, preconditions.expectedVersion);
    if (project.deletionStatus !== 'soft_deleted') {
      throw storeInvariant('Soft delete must return a soft-deleted project');
    }
    return project;
  }

  async restore(
    context: TenantContext,
    untrustedProjectId: string,
    untrustedIfMatch: string,
    untrustedIdempotencyKey: string,
  ): Promise<ProjectRecord> {
    const { trustedContext, projectId, preconditions, command } =
      this.#mutationCommand(
        context,
        untrustedProjectId,
        untrustedIfMatch,
        untrustedIdempotencyKey,
        'POST',
        'restore',
      );
    const result = await this.#store.restore({
      ...command,
      tenantId: trustedContext.tenantId,
      actorUserId: trustedContext.userId,
      projectId,
      prohibitedDeletionStatus: 'purge_pending',
    });
    const project = handleMutationResult(result, preconditions.expectedVersion);
    if (project.deletionStatus !== 'active') {
      throw storeInvariant('Restore must return an active deletion state');
    }
    return project;
  }

  async requestPermanentDelete(
    context: TenantContext,
    untrustedProjectId: string,
    untrustedIfMatch: string,
    untrustedIdempotencyKey: string,
  ): Promise<{ project: ProjectRecord; deletionTask: DeletionTask }> {
    const { trustedContext, projectId, preconditions, command } =
      this.#mutationCommand(
        context,
        untrustedProjectId,
        untrustedIfMatch,
        untrustedIdempotencyKey,
        'DELETE',
        'permanent',
      );
    const deletionTaskId = this.#newId();
    const result = await this.#store.requestPermanentDelete({
      ...command,
      tenantId: trustedContext.tenantId,
      actorUserId: trustedContext.userId,
      projectId,
      deletionTaskId,
      requiredDeletionStatus: 'soft_deleted',
    });
    if (
      result.kind === 'not_found' ||
      result.kind === 'version_conflict' ||
      result.kind === 'idempotency_conflict' ||
      result.kind === 'forbidden' ||
      result.kind === 'invalid_state'
    ) {
      handleMutationResult(result, preconditions.expectedVersion);
      throw storeInvariant('Unreachable permanent deletion result');
    }
    const project = ProjectRecordSchema.parse(result.project);
    const task = DeletionTaskSchema.parse(result.deletionTask);
    if (
      project.deletionStatus !== 'purge_pending' ||
      task.status !== 'purge_pending' ||
      task.projectId !== project.id ||
      task.tenantId !== trustedContext.tenantId
    ) {
      throw storeInvariant(
        'Permanent deletion must return a tenant-scoped pending purge task',
      );
    }
    return { project, deletionTask: task };
  }

  #newId(): string {
    return parseInput(UUIDv7Schema, this.#createId());
  }

  #occurredAt(): string {
    return this.#now().toISOString();
  }

  #mutationCommand(
    context: TenantContext,
    untrustedProjectId: string,
    untrustedIfMatch: string,
    untrustedIdempotencyKey: string,
    method: string,
    action: string | undefined,
  ) {
    const trustedContext = parseContext(context);
    const projectId = parseInput(UUIDv7Schema, untrustedProjectId);
    const preconditions = parseMutationPreconditions(
      untrustedIfMatch,
      untrustedIdempotencyKey,
    );
    const path = `/v1/projects/${projectId}${action === undefined ? '' : `/${action}`}`;
    return {
      trustedContext,
      projectId,
      preconditions,
      command: {
        expectedVersion: preconditions.expectedVersion,
        idempotencyKey: preconditions.idempotencyKey,
        requestHash: fingerprint(method, path, {}, preconditions.expectedVersion),
        occurredAt: this.#occurredAt(),
      },
    };
  }
}

function parseContext(context: TenantContext): TenantContext {
  return z
    .strictObject({
      tenantId: UUIDv7Schema,
      userId: UUIDv7Schema,
      membershipId: UUIDv7Schema,
      sessionId: UUIDv7Schema,
    })
    .parse(context);
}

function parseMutationPreconditions(
  untrustedIfMatch: string,
  untrustedIdempotencyKey: string,
) {
  const etag = parseInput(ETagSchema, untrustedIfMatch);
  return {
    expectedVersion: parseInput(
      ResourceVersionSchema,
      Number(etag.slice(1, -1)),
    ),
    idempotencyKey: parseInput(
      IdempotencyKeySchema,
      untrustedIdempotencyKey,
    ),
  };
}

function fingerprint(
  method: string,
  path: string,
  body: unknown,
  ifMatch?: number,
): string {
  return createRequestFingerprint({
    method,
    path,
    body,
    ...(ifMatch === undefined ? {} : { ifMatch }),
  });
}

function handleMutationResult(
  result: ProjectMutationResult,
  expectedVersion: number,
): ProjectRecord {
  if (result.kind === 'not_found') {
    throw projectNotFound();
  }
  if (result.kind === 'idempotency_conflict') {
    throw idempotencyConflict();
  }
  if (result.kind === 'forbidden') {
    throw new ProjectServiceError(
      403,
      'PROJECT_ACCESS_DENIED',
      'The current user cannot modify this project',
    );
  }
  if (result.kind === 'version_conflict') {
    const current = ProjectRecordSchema.parse(result.current);
    throw new ProjectServiceError(
      409,
      'VERSION_CONFLICT',
      'The project changed after it was loaded',
      {
        expectedVersion,
        currentVersion: current.version,
        currentETag: current.etag,
        current,
      },
    );
  }
  if (result.kind === 'invalid_state') {
    const current = ProjectRecordSchema.parse(result.current);
    throw new ProjectServiceError(
      409,
      'INVALID_PROJECT_STATE',
      'The project state does not allow this operation',
      { current },
    );
  }
  return ProjectRecordSchema.parse(result.project);
}

function projectNotFound(): ProjectServiceError {
  return new ProjectServiceError(
    404,
    'PROJECT_NOT_FOUND',
    'The requested project does not exist',
  );
}

function idempotencyConflict(): ProjectServiceError {
  return new ProjectServiceError(
    409,
    'IDEMPOTENCY_KEY_REUSED',
    'The idempotency key was already used for another request',
  );
}

function storeInvariant(message: string): ProjectServiceError {
  return new ProjectServiceError(500, 'STORE_INVARIANT_VIOLATION', message);
}

function parseInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ProjectServiceError(
      422,
      'VALIDATION_FAILED',
      'The request payload is invalid',
      { issues: result.error.issues },
    );
  }
  return result.data;
}

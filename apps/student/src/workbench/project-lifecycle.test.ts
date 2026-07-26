import { describe, expect, it } from 'vitest';
import {
  PROJECT_SCHEMA_VERSION,
  parseProject,
  type Project,
} from './project-model.js';
import {
  ProjectLifecycleError,
  activateProject,
  archiveProject,
  copyProject,
  requestPermanentDelete,
  restoreProject,
  toLifecycleProject,
  trashProject,
} from './project-lifecycle.js';

const PROJECT_ID = '01900000-0000-7000-8000-000000000101';
const TASK_ID = '01900000-0000-7000-8000-000000000102';
const RUBRIC_ID = '01900000-0000-7000-8000-000000000103';
const FILE_ID = '01900000-0000-7000-8000-000000000104';
const CHUNK_ID = '01900000-0000-7000-8000-000000000105';
const EVIDENCE_ID = '01900000-0000-7000-8000-000000000106';
const OUTLINE_ID = '01900000-0000-7000-8000-000000000107';
const NODE_ID = '01900000-0000-7000-8000-000000000108';
const ARTIFACT_ID = '01900000-0000-7000-8000-000000000109';
const RESULT_ID = '01900000-0000-7000-8000-000000000110';
const CHECK_ID = '01900000-0000-7000-8000-000000000111';
const PAGE_ID = '01900000-0000-7000-8000-000000000112';
const CLAIM_ID = '01900000-0000-7000-8000-000000000113';
const CREATED_AT = '2026-07-26T23:00:00.000Z';
const UPDATED_AT = '2026-07-27T00:00:00.000Z';
const NOW_1 = '2026-07-27T01:00:00.000Z';
const NOW_2 = '2026-07-27T02:00:00.000Z';
const NOW_3 = '2026-07-27T03:00:00.000Z';
const SHA256 = 'a'.repeat(64);

const OLD_IDS = [
  PROJECT_ID,
  TASK_ID,
  RUBRIC_ID,
  FILE_ID,
  CHUNK_ID,
  EVIDENCE_ID,
  OUTLINE_ID,
  NODE_ID,
  ARTIFACT_ID,
  RESULT_ID,
  CHECK_ID,
  PAGE_ID,
  CLAIM_ID,
] as const;

function metadata(id: string, version = 2) {
  return {
    id,
    version,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function project(): Project {
  return parseProject({
    schemaVersion: PROJECT_SCHEMA_VERSION,
    ...metadata(PROJECT_ID, 4),
    title: '课程路演',
    status: 'active',
    taskDefinition: {
      ...metadata(TASK_ID),
      taskName: '三页课程汇报',
      audience: '课程教师与同学',
      dueAt: '2026-08-15T09:00:00.000Z',
      lengthTarget: { unit: 'pages', value: 3 },
      presentationDurationMinutes: 6,
      outputFormats: ['pptx', 'pdf'],
      rubric: [
        {
          ...metadata(RUBRIC_ID),
          title: '论证与证据',
          description: '每个结论都有来源',
          weightPercent: 100,
        },
      ],
      tone: '清晰、克制',
      mustInclude: ['核心结论'],
      mustAvoid: ['无来源数字'],
    },
    sourceFiles: [
      {
        ...metadata(FILE_ID),
        projectId: PROJECT_ID,
        fileName: 'course.pdf',
        mediaType: 'application/pdf',
        extension: 'pdf',
        sizeBytes: 2048,
        contentSha256: SHA256,
        blobId: `source-file:${FILE_ID}`,
        sourceVersion: 2,
        status: 'ready',
        parseProgress: 100,
        pageCount: 1,
        error: null,
        replacedByFileId: null,
      },
    ],
    sourceChunks: [
      {
        ...metadata(CHUNK_ID),
        projectId: PROJECT_ID,
        sourceFileId: FILE_ID,
        sourceFileVersion: 2,
        ordinal: 0,
        pageNumber: 1,
        pageLabel: '1',
        characterStart: 0,
        characterEnd: 5,
        text: 'Alpha',
        contentSha256: SHA256,
      },
    ],
    evidenceCards: [
      {
        ...metadata(EVIDENCE_ID),
        projectId: PROJECT_ID,
        sourceFileId: FILE_ID,
        sourceChunkId: CHUNK_ID,
        sourceFileVersion: 2,
        pageNumber: 1,
        characterStart: 0,
        characterEnd: 5,
        quote: 'Alpha',
        kind: 'fact',
        note: '真实证据',
        citation: 'course.pdf, page 1',
        status: 'verified',
        stance: 'support',
        confirmationStatus: 'confirmed',
        userConfirmedAt: UPDATED_AT,
      },
    ],
    outlines: [
      {
        ...metadata(OUTLINE_ID),
        projectId: PROJECT_ID,
        title: '证据结构',
        status: 'selected',
        lockedAt: null,
        nodes: [
          {
            ...metadata(NODE_ID),
            position: 0,
            title: '核心结论',
            conclusion: 'Alpha 支持核心结论。',
            evidenceCardIds: [EVIDENCE_ID],
            coveredRequirements: ['核心结论'],
            rubricCriterionIds: [RUBRIC_ID],
            locked: false,
          },
        ],
      },
    ],
    activeOutlineId: OUTLINE_ID,
    artifacts: [
      {
        ...metadata(ARTIFACT_ID, 3),
        projectId: PROJECT_ID,
        outlineId: OUTLINE_ID,
        outlineVersion: 2,
        kind: 'presentation',
        status: 'exported',
        payload: {
          id: ARTIFACT_ID,
          version: 3,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          projectId: PROJECT_ID,
          outlineId: OUTLINE_ID,
          pages: [
            {
              id: PAGE_ID,
              version: 2,
              createdAt: CREATED_AT,
              updatedAt: UPDATED_AT,
              outlineNodeId: NODE_ID,
              evidenceCardIds: [EVIDENCE_ID],
              rubricCriterionIds: [RUBRIC_ID],
              claim: {
                id: CLAIM_ID,
                evidenceCardIds: [EVIDENCE_ID],
              },
            },
          ],
        },
        blobId: 'artifact:original-project',
        contentSha256: SHA256,
        staleBecause: [],
        errorCode: null,
      },
    ],
    verificationResults: [
      {
        ...metadata(RESULT_ID),
        projectId: PROJECT_ID,
        artifactId: ARTIFACT_ID,
        artifactVersion: 3,
        status: 'passed',
        checkedAt: UPDATED_AT,
        checks: [
          {
            ...metadata(CHECK_ID),
            rule: 'citation_exists',
            outcome: 'pass',
            message: '引用存在。',
            artifactPath: 'pages[0]',
            evidenceCardIds: [EVIDENCE_ID],
          },
        ],
        summary: {
          passed: 1,
          warnings: 0,
          failed: 0,
          notRun: 0,
        },
      },
    ],
  });
}

function sequentialIds(output: string[]) {
  let sequence = 901;
  return () => {
    const id =
      `01900000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
    sequence += 1;
    output.push(id);
    return id;
  };
}

describe('local project lifecycle domain', () => {
  it('copies the complete aggregate with new UUIDs and no stale cross-project references', () => {
    const source = project();
    const snapshot = structuredClone(source);
    const generated: string[] = [];

    const copied = copyProject(source, {
      expectedVersion: source.version,
      now: NOW_1,
      idFactory: sequentialIds(generated),
    });

    expect(source).toEqual(snapshot);
    expect(copied).toMatchObject({
      version: 1,
      createdAt: NOW_1,
      updatedAt: NOW_1,
      status: 'active',
      statusBeforeTrash: null,
      trashedAt: null,
    });
    expect(generated).toHaveLength(OLD_IDS.length);
    expect(new Set(generated).size).toBe(generated.length);
    for (const oldId of OLD_IDS) {
      expect(JSON.stringify(copied)).not.toContain(oldId);
    }

    const sourceFile = copied.sourceFiles[0]!;
    const chunk = copied.sourceChunks[0]!;
    const evidence = copied.evidenceCards[0]!;
    const outline = copied.outlines[0]!;
    const node = outline.nodes[0]!;
    const artifact = copied.artifacts[0]!;
    const verification = copied.verificationResults[0]!;
    expect(sourceFile.projectId).toBe(copied.id);
    expect(sourceFile.blobId).toBe(`source-file:${sourceFile.id}`);
    expect(sourceFile.sourceVersion).toBe(1);
    expect(chunk).toMatchObject({
      projectId: copied.id,
      sourceFileId: sourceFile.id,
      sourceFileVersion: 1,
    });
    expect(evidence).toMatchObject({
      projectId: copied.id,
      sourceFileId: sourceFile.id,
      sourceChunkId: chunk.id,
      sourceFileVersion: 1,
      userConfirmedAt: NOW_1,
    });
    expect(outline.projectId).toBe(copied.id);
    expect(node.evidenceCardIds).toEqual([evidence.id]);
    expect(node.rubricCriterionIds).toEqual([
      copied.taskDefinition.rubric[0]!.id,
    ]);
    expect(copied.activeOutlineId).toBe(outline.id);
    expect(artifact).toMatchObject({
      version: 1,
      projectId: copied.id,
      outlineId: outline.id,
      outlineVersion: 1,
      status: 'stale',
      blobId: null,
      contentSha256: null,
      staleBecause: ['PROJECT_COPIED'],
      errorCode: null,
    });
    expect(verification).toMatchObject({
      version: 1,
      projectId: copied.id,
      artifactId: artifact.id,
      artifactVersion: 1,
      status: 'stale',
      checkedAt: NOW_1,
    });
    expect(verification.checks[0]!.evidenceCardIds).toEqual([
      evidence.id,
    ]);

    const payload = artifact.payload as Record<string, unknown>;
    const pages = payload.pages as Array<Record<string, unknown>>;
    const payloadPage = pages[0]!;
    expect(payload).toMatchObject({
      id: artifact.id,
      version: 1,
      createdAt: NOW_1,
      updatedAt: NOW_1,
      projectId: copied.id,
      outlineId: outline.id,
    });
    expect(payloadPage).toMatchObject({
      version: 1,
      createdAt: NOW_1,
      updatedAt: NOW_1,
      outlineNodeId: node.id,
      evidenceCardIds: [evidence.id],
      rubricCriterionIds: [copied.taskDefinition.rubric[0]!.id],
    });
    expect(Object.isFrozen(copied)).toBe(true);
    expect(Object.isFrozen(copied.outlines[0]!.nodes)).toBe(true);

    const projectSnapshot: Record<string, unknown> = { ...copied };
    delete projectSnapshot.statusBeforeTrash;
    delete projectSnapshot.trashedAt;
    expect(() => parseProject(projectSnapshot)).not.toThrow();
  });

  it('transitions active and archived projects through trash and restore immutably', () => {
    const source = project();
    const archived = archiveProject(source, {
      expectedVersion: 4,
      now: NOW_1,
    });
    expect(archived).toMatchObject({
      status: 'archived',
      version: 5,
      updatedAt: NOW_1,
      statusBeforeTrash: null,
      trashedAt: null,
    });
    expect(source.status).toBe('active');

    const activeAgain = activateProject(archived, {
      expectedVersion: 5,
      now: NOW_2,
    });
    expect(activeAgain).toMatchObject({
      status: 'active',
      version: 6,
      updatedAt: NOW_2,
    });

    const trashedActive = trashProject(activeAgain, {
      expectedVersion: 6,
      now: NOW_3,
    });
    expect(trashedActive).toMatchObject({
      status: 'trashed',
      statusBeforeTrash: 'active',
      trashedAt: NOW_3,
      version: 7,
    });
    expect(
      restoreProject(trashedActive, {
        expectedVersion: 7,
        now: '2026-07-27T04:00:00.000Z',
      }),
    ).toMatchObject({
      status: 'active',
      statusBeforeTrash: null,
      trashedAt: null,
      version: 8,
    });

    const trashedArchived = trashProject(archived, {
      expectedVersion: 5,
      now: NOW_2,
    });
    expect(
      restoreProject(trashedArchived, {
        expectedVersion: 6,
        now: NOW_3,
      }),
    ).toMatchObject({
      status: 'archived',
      statusBeforeTrash: null,
      trashedAt: null,
    });
  });

  it('returns a permanent-delete intent only for a correctly versioned trashed project', () => {
    const trashed = trashProject(project(), {
      expectedVersion: 4,
      now: NOW_1,
    });

    const intent = requestPermanentDelete(trashed, {
      expectedVersion: 5,
      now: NOW_2,
    });
    expect(intent).toEqual({
      kind: 'permanent-delete-project',
      projectId: PROJECT_ID,
      projectVersion: 5,
      requestedAt: NOW_2,
    });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(() =>
      requestPermanentDelete(project(), {
        expectedVersion: 4,
        now: NOW_1,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: 'ProjectLifecycleError',
        code: 'INVALID_TRANSITION',
      }),
    );
  });

  it('rejects stale versions, invalid time, invalid transitions and unsafe copy IDs', () => {
    expect(() =>
      archiveProject(project(), {
        expectedVersion: 3,
        now: NOW_1,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'VERSION_CONFLICT',
      }),
    );
    expect(() =>
      archiveProject(project(), {
        expectedVersion: 4,
        now: UPDATED_AT,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVALID_TIMESTAMP',
      }),
    );
    const archived = archiveProject(project(), {
      expectedVersion: 4,
      now: NOW_1,
    });
    expect(() =>
      archiveProject(archived, {
        expectedVersion: 5,
        now: NOW_2,
      }),
    ).toThrow(ProjectLifecycleError);

    expect(() =>
      copyProject(project(), {
        expectedVersion: 4,
        now: NOW_1,
        idFactory: () => PROJECT_ID,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'INVALID_UUID_FACTORY',
      }),
    );
    const trashed = trashProject(project(), {
      expectedVersion: 4,
      now: NOW_1,
    });
    expect(() =>
      copyProject(trashed, {
        expectedVersion: 5,
        now: NOW_2,
        idFactory: sequentialIds([]),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'PROJECT_TRASHED',
      }),
    );
  });

  it('normalizes a strict project into a frozen lifecycle value without mutating it', () => {
    const source = project();
    const lifecycle = toLifecycleProject(source);

    expect(lifecycle).toMatchObject({
      status: 'active',
      statusBeforeTrash: null,
      trashedAt: null,
    });
    expect(lifecycle).not.toBe(source);
    expect(lifecycle.taskDefinition).not.toBe(source.taskDefinition);
    expect(Object.isFrozen(lifecycle.taskDefinition)).toBe(true);
  });
});

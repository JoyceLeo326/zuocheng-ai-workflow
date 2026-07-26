import { describe, expect, it } from 'vitest';
import type { Project, SourceChunk } from './project-model.js';
import {
  MemoryProjectStore,
  ProjectAlreadyExistsError,
  ProjectImportError,
  ProjectStoreUnavailableError,
  ProjectVersionConflictError,
  createIndexedDbProjectStore,
  createMemoryProjectDatabase,
  type ProjectEdit,
} from './project-store.js';

const PROJECT_ID = '01900000-0000-7000-8000-000000000201';
const TASK_ID = '01900000-0000-7000-8000-000000000202';
const RUBRIC_ID = '01900000-0000-7000-8000-000000000203';
const FILE_ID = '01900000-0000-7000-8000-000000000204';
const CHUNK_ID = '01900000-0000-7000-8000-000000000205';
const EDIT_ID = '01900000-0000-7000-8000-000000000206';
const SECOND_CHUNK_ID = '01900000-0000-7000-8000-000000000207';
const CREATED_AT = '2026-07-27T01:00:00.000Z';
const UPDATED_AT = '2026-07-27T02:00:00.000Z';
const NEXT_UPDATED_AT = '2026-07-27T03:00:00.000Z';
const EXPORT_AT = '2026-07-27T04:00:00.000Z';
const SHA256 = 'b'.repeat(64);

function project(): Project {
  return {
    schemaVersion: 1,
    id: PROJECT_ID,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    title: '课程路演',
    status: 'active',
    taskDefinition: {
      id: TASK_ID,
      version: 1,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      taskName: '三页课程汇报',
      audience: '课程教师与同学',
      dueAt: '2026-08-15T09:00:00.000Z',
      lengthTarget: { unit: 'pages', value: 3 },
      presentationDurationMinutes: 6,
      outputFormats: ['pptx', 'pdf'],
      rubric: [
        {
          id: RUBRIC_ID,
          version: 1,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          title: '论证与证据',
          description: '结论必须有来源证据支持',
          weightPercent: 100,
        },
      ],
      tone: '清晰、克制',
      mustInclude: ['核心结论'],
      mustAvoid: ['无来源数字'],
    },
    sourceFiles: [
      {
        id: FILE_ID,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        projectId: PROJECT_ID,
        fileName: 'notes.txt',
        mediaType: 'text/plain',
        extension: 'txt',
        sizeBytes: 5,
        contentSha256: SHA256,
        blobId: 'blob:notes',
        sourceVersion: 1,
        status: 'ready',
        parseProgress: 100,
        pageCount: 1,
        error: null,
        replacedByFileId: null,
      },
    ],
    sourceChunks: [],
    evidenceCards: [],
    outlines: [],
    activeOutlineId: null,
    artifacts: [],
    verificationResults: [],
  };
}

function chunk(): SourceChunk {
  return {
    id: CHUNK_ID,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    projectId: PROJECT_ID,
    sourceFileId: FILE_ID,
    sourceFileVersion: 1,
    ordinal: 0,
    pageNumber: 1,
    pageLabel: '1',
    characterStart: 0,
    characterEnd: 5,
    text: 'hello',
    contentSha256: SHA256,
  };
}

function projectWithChunks(): Project {
  return {
    ...project(),
    version: 2,
    updatedAt: NEXT_UPDATED_AT,
    sourceChunks: [chunk()],
  };
}

function edit(): ProjectEdit {
  return {
    id: EDIT_ID,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    projectId: PROJECT_ID,
    projectVersion: 1,
    kind: 'create',
    path: '$',
    before: null,
    after: { title: '课程路演' },
  };
}

async function blobText(blob: Blob | null): Promise<string | null> {
  return blob === null ? null : blob.text();
}

describe('MemoryProjectStore contract', () => {
  it('restores projects, source blobs, parse chunks and edit history in a fresh store instance', async () => {
    const database = createMemoryProjectDatabase();
    const firstSession = new MemoryProjectStore({ database });

    await firstSession.createProject(project());
    await firstSession.putSourceBlob(PROJECT_ID, FILE_ID, new Blob(['hello']));
    await expect(
      firstSession.replaceSourceChunks(
        PROJECT_ID,
        FILE_ID,
        [chunk()],
        1,
        NEXT_UPDATED_AT,
      ),
    ).resolves.toEqual(projectWithChunks());
    await firstSession.appendEdit(edit());

    const refreshedSession = new MemoryProjectStore({ database });
    await expect(refreshedSession.getProject(PROJECT_ID)).resolves.toEqual(
      projectWithChunks(),
    );
    expect(
      await blobText(
        await refreshedSession.getSourceBlob(PROJECT_ID, FILE_ID),
      ),
    ).toBe('hello');
    await expect(
      refreshedSession.getSourceChunks(PROJECT_ID, FILE_ID),
    ).resolves.toEqual([chunk()]);
    await expect(refreshedSession.listEdits(PROJECT_ID)).resolves.toEqual([
      edit(),
    ]);
  });

  it('uses optimistic versions and reports both stale writes and duplicate creates', async () => {
    const store = new MemoryProjectStore();
    await store.createProject(project());
    await expect(store.createProject(project())).rejects.toBeInstanceOf(
      ProjectAlreadyExistsError,
    );

    const next = {
      ...project(),
      title: '课程路演（修订）',
      version: 2,
      updatedAt: NEXT_UPDATED_AT,
    };
    await expect(store.saveProject(next, 1)).resolves.toEqual(next);

    await expect(
      store.saveProject(
        {
          ...next,
          title: '过期写入',
          version: 2,
        },
        1,
      ),
    ).rejects.toMatchObject({
      name: 'ProjectVersionConflictError',
      projectId: PROJECT_ID,
      expectedVersion: 1,
      currentVersion: 2,
    });
    await expect(store.saveProject(next, 1)).rejects.toBeInstanceOf(
      ProjectVersionConflictError,
    );
  });

  it('rejects blobs and chunks that are not owned by the project source file', async () => {
    const store = new MemoryProjectStore();
    await store.createProject(project());
    await expect(
      store.putSourceBlob(
        PROJECT_ID,
        '01900000-0000-7000-8000-000000000299',
        new Blob(['hello']),
      ),
    ).rejects.toThrow(/sourceFileId/u);
    await expect(
      store.putSourceBlob(PROJECT_ID, FILE_ID, new Blob(['wrong-size'])),
    ).rejects.toThrow(/size/u);
    await expect(
      store.replaceSourceChunks(
        PROJECT_ID,
        FILE_ID,
        [
          {
            ...chunk(),
            projectId: '01900000-0000-7000-8000-000000000299',
          },
        ],
        1,
        NEXT_UPDATED_AT,
      ),
    ).rejects.toThrow(/projectId/u);
  });

  it('atomically versions the canonical project snapshot and rejects stale chunk replacements', async () => {
    const store = new MemoryProjectStore();
    await store.createProject(project());

    await expect(
      store.replaceSourceChunks(
        PROJECT_ID,
        FILE_ID,
        [chunk()],
        1,
        NEXT_UPDATED_AT,
      ),
    ).resolves.toEqual(projectWithChunks());
    await expect(store.getProject(PROJECT_ID)).resolves.toEqual(
      projectWithChunks(),
    );

    await expect(
      store.replaceSourceChunks(
        PROJECT_ID,
        FILE_ID,
        [],
        1,
        EXPORT_AT,
      ),
    ).rejects.toMatchObject({
      name: 'ProjectVersionConflictError',
      projectId: PROJECT_ID,
      expectedVersion: 1,
      currentVersion: 2,
    });
    await expect(store.getProject(PROJECT_ID)).resolves.toEqual(
      projectWithChunks(),
    );
    await expect(
      store.getSourceChunks(PROJECT_ID, FILE_ID),
    ).resolves.toEqual([chunk()]);

    const racingStore = new MemoryProjectStore();
    await racingStore.createProject(project());
    const racingWrites = await Promise.allSettled([
      racingStore.replaceSourceChunks(
        PROJECT_ID,
        FILE_ID,
        [chunk()],
        1,
        NEXT_UPDATED_AT,
      ),
      racingStore.replaceSourceChunks(
        PROJECT_ID,
        FILE_ID,
        [],
        1,
        EXPORT_AT,
      ),
    ]);
    expect(
      racingWrites.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      racingWrites.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      racingWrites.find((result) => result.status === 'rejected'),
    ).toMatchObject({
      reason: {
        name: 'ProjectVersionConflictError',
        expectedVersion: 1,
        currentVersion: 2,
      },
    });
  });

  it('exports a complete explicit migration bundle and imports it without losing stable identities', async () => {
    const source = new MemoryProjectStore();
    await source.createProject(project());
    await source.putSourceBlob(PROJECT_ID, FILE_ID, new Blob(['hello']));
    await source.replaceSourceChunks(
      PROJECT_ID,
      FILE_ID,
      [chunk()],
      1,
      NEXT_UPDATED_AT,
    );
    await source.appendEdit(edit());

    const bundle = await source.exportProject(PROJECT_ID, EXPORT_AT);
    expect(bundle).toMatchObject({
      format: 'zuocheng-project',
      formatVersion: 1,
      exportedAt: EXPORT_AT,
      project: { id: PROJECT_ID, version: 2, sourceChunks: [chunk()] },
      sourceBlobs: [{ sourceFileId: FILE_ID }],
      sourceChunks: [chunk()],
      editHistory: [edit()],
    });
    expect(bundle.project.sourceChunks).toEqual(bundle.sourceChunks);

    const destination = new MemoryProjectStore();
    await expect(destination.importProject(bundle)).resolves.toEqual(
      projectWithChunks(),
    );
    await expect(destination.getProject(PROJECT_ID)).resolves.toEqual(
      projectWithChunks(),
    );
    expect(
      await blobText(await destination.getSourceBlob(PROJECT_ID, FILE_ID)),
    ).toBe('hello');
    await expect(
      destination.getSourceChunks(PROJECT_ID, FILE_ID),
    ).resolves.toEqual([chunk()]);
    await expect(destination.listEdits(PROJECT_ID)).resolves.toEqual([edit()]);
  });

  it('fails closed at import boundaries and never silently overwrites a project', async () => {
    const source = new MemoryProjectStore();
    await source.createProject(project());
    await source.replaceSourceChunks(
      PROJECT_ID,
      FILE_ID,
      [chunk()],
      1,
      NEXT_UPDATED_AT,
    );
    const bundle = await source.exportProject(PROJECT_ID, EXPORT_AT);

    const destination = new MemoryProjectStore();
    await destination.createProject(project());
    await expect(destination.importProject(bundle)).rejects.toBeInstanceOf(
      ProjectAlreadyExistsError,
    );
    await expect(
      destination.importProject(
        { ...bundle, format: 'unknown-format' } as unknown,
      ),
    ).rejects.toBeInstanceOf(ProjectImportError);

    const emptyDestination = new MemoryProjectStore();
    await expect(
      emptyDestination.importProject({
        ...bundle,
        project: {
          ...bundle.project,
          sourceChunks: [],
        },
      }),
    ).rejects.toThrow(/sourceChunks/u);
    await expect(
      emptyDestination.getProject(PROJECT_ID),
    ).resolves.toBeNull();

    const secondChunk: SourceChunk = {
      ...chunk(),
      id: SECOND_CHUNK_ID,
      ordinal: 1,
      characterStart: 5,
      characterEnd: 10,
      text: 'world',
    };
    const reorderedDestination = new MemoryProjectStore();
    await expect(
      reorderedDestination.importProject({
        ...bundle,
        project: {
          ...bundle.project,
          sourceChunks: [chunk(), secondChunk],
        },
        sourceChunks: [secondChunk, chunk()],
      }),
    ).rejects.toThrow(/sourceChunks/u);
  });

  it('reports unavailable IndexedDB instead of falling back to volatile storage', () => {
    expect(() =>
      createIndexedDbProjectStore({ indexedDBFactory: null }),
    ).toThrow(ProjectStoreUnavailableError);
  });
});

import { describe, expect, it } from 'vitest';
import type { Project, SourceChunk } from './project-model.js';
import {
  requestPermanentDelete,
  trashProject,
} from './project-lifecycle.js';
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
const PERMANENT_AT = '2026-07-27T05:00:00.000Z';
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
    statusBeforeTrash: null,
    trashedAt: null,
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
    after: {
      projectId: PROJECT_ID,
      sourceFileId: FILE_ID,
      sourceChunkId: CHUNK_ID,
      title: '课程路演',
    },
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

  it('deletes one persisted source blob without deleting the project', async () => {
    const database = createMemoryProjectDatabase();
    const store = new MemoryProjectStore({ database });
    const current = project();
    await store.createProject(current);
    await store.putSourceBlob(
      PROJECT_ID,
      FILE_ID,
      new Blob(['hello']),
    );

    await store.deleteSourceBlob(PROJECT_ID, FILE_ID);

    await expect(
      store.getSourceBlob(PROJECT_ID, FILE_ID),
    ).resolves.toBeNull();
    await expect(store.getProject(PROJECT_ID)).resolves.toEqual(
      current,
    );
    expect(database.sourceBlobs.size).toBe(0);
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

  it('permanently deletes only a version-matched trashed project and every owned local record', async () => {
    const database = createMemoryProjectDatabase();
    const store = new MemoryProjectStore({ database });
    await store.createProject(project());
    await store.putSourceBlob(PROJECT_ID, FILE_ID, new Blob(['hello']));
    await store.replaceSourceChunks(
      PROJECT_ID,
      FILE_ID,
      [chunk()],
      1,
      NEXT_UPDATED_AT,
    );
    await store.appendEdit(edit());

    const trashed = trashProject(projectWithChunks(), {
      expectedVersion: 2,
      now: EXPORT_AT,
    });
    await store.saveProject(trashed, 2);
    const intent = requestPermanentDelete(trashed, {
      expectedVersion: 3,
      now: PERMANENT_AT,
    });
    await expect(store.deleteProject(intent)).resolves.toBeUndefined();
    await expect(store.getProject(PROJECT_ID)).resolves.toBeNull();
    await expect(store.listProjects()).resolves.toEqual([]);
    expect(database.sourceBlobs.size).toBe(0);
    expect(database.sourceChunks.size).toBe(0);
    expect(database.edits.size).toBe(0);
    await expect(store.deleteProject(intent)).rejects.toMatchObject({
      name: 'ProjectNotFoundError',
      projectId: PROJECT_ID,
    });
  });

  it('atomically copies project-owned blobs, chunks and remapped edit history', async () => {
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
    let sequence = 501;
    const idFactory = () => {
      const id =
        `01900000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
      sequence += 1;
      return id;
    };

    const copied = await source.copyProject(PROJECT_ID, {
      expectedVersion: 2,
      now: EXPORT_AT,
      idFactory,
    });

    expect(copied).toMatchObject({
      version: 1,
      createdAt: EXPORT_AT,
      updatedAt: EXPORT_AT,
      status: 'active',
      statusBeforeTrash: null,
      trashedAt: null,
    });
    expect(copied.id).not.toBe(PROJECT_ID);
    expect(copied.sourceFiles[0]!.id).not.toBe(FILE_ID);
    expect(copied.sourceChunks[0]).toMatchObject({
      projectId: copied.id,
      sourceFileId: copied.sourceFiles[0]!.id,
      sourceFileVersion: 1,
    });
    expect(
      await blobText(
        await source.getSourceBlob(
          copied.id,
          copied.sourceFiles[0]!.id,
        ),
      ),
    ).toBe('hello');
    await expect(
      source.getSourceChunks(copied.id, copied.sourceFiles[0]!.id),
    ).resolves.toEqual(copied.sourceChunks);
    const copiedEdits = await source.listEdits(copied.id);
    expect(copiedEdits).toHaveLength(1);
    expect(copiedEdits[0]).toMatchObject({
      version: 1,
      createdAt: EXPORT_AT,
      updatedAt: EXPORT_AT,
      projectId: copied.id,
      projectVersion: 1,
      kind: 'create',
      after: {
        projectId: copied.id,
        sourceFileId: copied.sourceFiles[0]!.id,
        sourceChunkId: copied.sourceChunks[0]!.id,
        title: '课程路演',
      },
    });
    await expect(source.getProject(PROJECT_ID)).resolves.toEqual(
      projectWithChunks(),
    );
    await expect(
      source.copyProject(PROJECT_ID, {
        expectedVersion: 1,
        now: PERMANENT_AT,
        idFactory,
      }),
    ).rejects.toMatchObject({
      name: 'ProjectLifecycleError',
      code: 'VERSION_CONFLICT',
      expectedVersion: 1,
      currentVersion: 2,
    });
    await expect(source.listProjects()).resolves.toHaveLength(2);
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

  it('replaces a synchronized project only at the observed version and keeps the bundle complete', async () => {
    const remote = new MemoryProjectStore();
    await remote.createProject(project());
    await remote.putSourceBlob(
      PROJECT_ID,
      FILE_ID,
      new Blob(['world']),
    );
    await remote.replaceSourceChunks(
      PROJECT_ID,
      FILE_ID,
      [chunk()],
      1,
      NEXT_UPDATED_AT,
    );
    await remote.appendEdit(edit());
    const bundle = await remote.exportProject(PROJECT_ID, EXPORT_AT);

    const local = new MemoryProjectStore();
    await local.createProject(project());
    await expect(
      local.replaceProject(bundle, 99),
    ).rejects.toBeInstanceOf(ProjectVersionConflictError);
    await expect(local.getProject(PROJECT_ID)).resolves.toEqual(
      project(),
    );

    await expect(local.replaceProject(bundle, 1)).resolves.toEqual(
      projectWithChunks(),
    );
    expect(
      await blobText(
        await local.getSourceBlob(PROJECT_ID, FILE_ID),
      ),
    ).toBe('world');
    await expect(
      local.getSourceChunks(PROJECT_ID, FILE_ID),
    ).resolves.toEqual([chunk()]);
    await expect(local.listEdits(PROJECT_ID)).resolves.toEqual([
      edit(),
    ]);
  });

  it('reports unavailable IndexedDB instead of falling back to volatile storage', () => {
    expect(() =>
      createIndexedDbProjectStore({ indexedDBFactory: null }),
    ).toThrow(ProjectStoreUnavailableError);
  });
});

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from './project-model.js';
import {
  MemoryProjectStore,
  type ProjectEdit,
} from './project-store.js';
import {
  createProjectManagerController,
  mapManagedProject,
} from './project-manager-controller.js';
import { createWorkbenchService } from './workbench-service.js';

const PROJECT_ID = '01900000-0000-7000-8000-000000000701';
const TASK_ID = '01900000-0000-7000-8000-000000000702';
const RUBRIC_ID = '01900000-0000-7000-8000-000000000703';
const FILE_ID = '01900000-0000-7000-8000-000000000704';
const CHUNK_ID = '01900000-0000-7000-8000-000000000705';
const OUTLINE_ID = '01900000-0000-7000-8000-000000000706';
const ARTIFACT_ID = '01900000-0000-7000-8000-000000000707';
const EDIT_ID = '01900000-0000-7000-8000-000000000708';
const CREATED_AT = '2026-07-27T00:00:00.000Z';
const UPDATED_AT = '2026-07-27T01:00:00.000Z';
const NOW = '2026-07-27T02:00:00.000Z';
const HELLO_SHA256 =
  '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

function project(): Project {
  return {
    schemaVersion: 1,
    id: PROJECT_ID,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    title: 'Portable project',
    status: 'active',
    statusBeforeTrash: null,
    trashedAt: null,
    taskDefinition: {
      id: TASK_ID,
      version: 1,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      taskName: 'Portable project',
      audience: 'Reviewers',
      dueAt: '2026-08-27T00:00:00.000Z',
      lengthTarget: { unit: 'pages', value: 1 },
      presentationDurationMinutes: 1,
      outputFormats: ['pptx'],
      rubric: [
        {
          id: RUBRIC_ID,
          version: 1,
          createdAt: CREATED_AT,
          updatedAt: UPDATED_AT,
          title: 'Completeness',
          description: 'The project is complete.',
          weightPercent: 100,
        },
      ],
      tone: 'Clear',
      mustInclude: ['Summary'],
      mustAvoid: ['Unsupported claims'],
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
        contentSha256: HELLO_SHA256,
        blobId: `source-file:${FILE_ID}`,
        sourceVersion: 1,
        status: 'ready',
        parseProgress: 100,
        pageCount: 1,
        error: null,
        replacedByFileId: null,
      },
    ],
    sourceChunks: [
      {
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
        contentSha256: HELLO_SHA256,
      },
    ],
    evidenceCards: [],
    outlines: [
      {
        id: OUTLINE_ID,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        projectId: PROJECT_ID,
        title: 'Draft',
        status: 'draft',
        lockedAt: null,
        nodes: [],
      },
    ],
    activeOutlineId: null,
    artifacts: [
      {
        id: ARTIFACT_ID,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        projectId: PROJECT_ID,
        outlineId: OUTLINE_ID,
        outlineVersion: 1,
        kind: 'presentation',
        status: 'ready',
        payload: {
          format: 'zuocheng-draft-artifact',
          pages: [{ title: 'One' }, { title: 'Two' }],
        },
        blobId: null,
        contentSha256: null,
        staleBecause: [],
        errorCode: null,
      },
    ],
    verificationResults: [],
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
    },
  };
}

function sequentialIds(start = 801): () => string {
  let sequence = start;
  return () => {
    const id =
      `01900000-0000-7000-8000-${String(sequence).padStart(12, '0')}`;
    sequence += 1;
    return id;
  };
}

function createController(
  store: MemoryProjectStore,
  openProject = vi.fn<(project: Project) => Promise<void>>(
    async () => undefined,
  ),
  prepareNewProject = vi.fn<(title: string) => Promise<void>>(
    async () => undefined,
  ),
) {
  const service = createWorkbenchService({
    store,
    idFactory: sequentialIds(),
    now: () => new Date(NOW),
  });
  return {
    controller: createProjectManagerController({
      service,
      openProject,
      prepareNewProject,
      cryptoProvider: globalThis.crypto,
    }),
    openProject,
    prepareNewProject,
    service,
  };
}

describe('ProjectManagerController', () => {
  it('maps canonical projects to immutable manager rows with real counts', () => {
    const managed = mapManagedProject(project());

    expect(managed).toEqual({
      id: PROJECT_ID,
      title: 'Portable project',
      status: 'active',
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      sourceCount: 1,
      draftPageCount: 2,
    });
    expect(Object.isFrozen(managed)).toBe(true);
  });

  it('refreshes, opens and persists every manager lifecycle callback', async () => {
    const store = new MemoryProjectStore();
    await store.createProject(project());
    const { controller, openProject, prepareNewProject } =
      createController(store);

    await expect(controller.refresh()).resolves.toEqual([
      mapManagedProject(project()),
    ]);
    await controller.onOpen({ projectId: PROJECT_ID });
    expect(openProject).toHaveBeenCalledWith(project());

    await controller.onArchive({ projectId: PROJECT_ID });
    await expect(store.getProject(PROJECT_ID)).resolves.toMatchObject({
      status: 'archived',
      version: 2,
    });
    await controller.onRestore({
      projectId: PROJECT_ID,
      from: 'archived',
    });
    await expect(store.getProject(PROJECT_ID)).resolves.toMatchObject({
      status: 'active',
      version: 3,
    });
    await controller.onDuplicate({ projectId: PROJECT_ID });
    expect((await store.listProjects()).filter((item) => item.id !== PROJECT_ID))
      .toHaveLength(1);

    await controller.onMoveToTrash({
      projectId: PROJECT_ID,
      from: 'active',
    });
    await expect(store.getProject(PROJECT_ID)).resolves.toMatchObject({
      status: 'trashed',
      statusBeforeTrash: 'active',
      version: 4,
    });
    await controller.onRestore({
      projectId: PROJECT_ID,
      from: 'trashed',
    });
    await controller.onMoveToTrash({
      projectId: PROJECT_ID,
      from: 'active',
    });
    await controller.onDeletePermanently({ projectId: PROJECT_ID });
    await expect(store.getProject(PROJECT_ID)).resolves.toBeNull();

    await controller.onCreate({ title: 'New real project' });
    expect(prepareNewProject).toHaveBeenCalledWith('New real project');
    expect(
      (await store.listProjects()).some(
        (candidate) => candidate.title === 'New real project',
      ),
    ).toBe(false);
    expect(controller.projects.every(Object.isFrozen)).toBe(true);
  });

  it('surfaces optimistic conflicts instead of reporting a stale action as successful', async () => {
    const store = new MemoryProjectStore();
    await store.createProject(project());
    const first = createController(store);
    const second = createController(store);
    await first.controller.refresh();
    await second.controller.refresh();

    await first.controller.onArchive({ projectId: PROJECT_ID });
    await expect(
      second.controller.onArchive({ projectId: PROJECT_ID }),
    ).rejects.toMatchObject({
      name: 'ProjectLifecycleError',
      code: 'VERSION_CONFLICT',
      expectedVersion: 1,
      currentVersion: 2,
    });
    expect(second.controller.projects[0]).toMatchObject({
      status: 'active',
      updatedAt: UPDATED_AT,
    });
  });

  it('exports a checksummed portable ZIP and imports all project-owned data', async () => {
    const sourceStore = new MemoryProjectStore();
    await sourceStore.createProject(project());
    await sourceStore.putSourceBlob(
      PROJECT_ID,
      FILE_ID,
      new Blob(['hello'], { type: 'text/plain' }),
    );
    await sourceStore.appendEdit(edit());
    const source = createController(sourceStore);
    await source.controller.refresh();

    const download = await source.controller.onExportProjectPackage({
      projectId: PROJECT_ID,
    });
    expect(download.fileName).toMatch(/\.zuocheng\.zip$/u);
    const archive = unzipSync(
      new Uint8Array(await download.blob.arrayBuffer()),
    );
    const manifest = JSON.parse(
      strFromU8(archive['manifest.json']!),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      format: 'zuocheng-project-package',
      formatVersion: 1,
      bundleFormat: 'zuocheng-project',
      bundleFormatVersion: 1,
      projectId: PROJECT_ID,
      projectVersion: 1,
      projectSchemaVersion: 1,
    });
    expect(Object.keys(archive)).toEqual(
      expect.arrayContaining([
        'manifest.json',
        'project.json',
        'source-chunks.json',
        'edit-history.json',
        `sources/${FILE_ID}.bin`,
      ]),
    );

    const destinationStore = new MemoryProjectStore();
    const destination = createController(destinationStore);
    await destination.controller.onImportProjectPackage({
      file: new File([download.blob], download.fileName, {
        type: 'application/zip',
      }),
    });

    await expect(destinationStore.getProject(PROJECT_ID)).resolves.toEqual(
      project(),
    );
    expect(
      await (
        await destinationStore.getSourceBlob(PROJECT_ID, FILE_ID)
      )?.text(),
    ).toBe('hello');
    await expect(
      destinationStore.getSourceChunks(PROJECT_ID, FILE_ID),
    ).resolves.toEqual(project().sourceChunks);
    await expect(destinationStore.listEdits(PROJECT_ID)).resolves.toEqual([
      edit(),
    ]);
    expect(destination.controller.projects).toEqual([
      mapManagedProject(project()),
    ]);
  });

  it('rejects tampered ZIP entries before import and leaves the store unchanged', async () => {
    const sourceStore = new MemoryProjectStore();
    await sourceStore.createProject(project());
    const source = createController(sourceStore);
    const download = await source.controller.onExportProjectPackage({
      projectId: PROJECT_ID,
    });
    const archive = unzipSync(
      new Uint8Array(await download.blob.arrayBuffer()),
    );
    const projectBytes = archive['project.json'];
    if (projectBytes === undefined) {
      throw new Error('expected project.json');
    }
    projectBytes[0] = (projectBytes[0] ?? 0) ^ 1;
    const tampered = zipSync(archive);
    const owned = new Uint8Array(tampered.length);
    owned.set(tampered);

    const destinationStore = new MemoryProjectStore();
    const destination = createController(destinationStore);
    await expect(
      destination.controller.onImportProjectPackage({
        file: new File([owned.buffer], 'tampered.zuocheng.zip', {
          type: 'application/zip',
        }),
      }),
    ).rejects.toMatchObject({
      name: 'ProjectPackageError',
      code: 'SHA_MISMATCH',
    });
    await expect(destinationStore.listProjects()).resolves.toEqual([]);

    const unsupportedArchive = unzipSync(
      new Uint8Array(await download.blob.arrayBuffer()),
    );
    const manifest = JSON.parse(
      strFromU8(unsupportedArchive['manifest.json']!),
    ) as Record<string, unknown>;
    manifest.formatVersion = 99;
    unsupportedArchive['manifest.json'] = strToU8(
      `${JSON.stringify(manifest)}\n`,
    );
    const unsupported = zipSync(unsupportedArchive);
    const unsupportedBytes = new Uint8Array(unsupported.length);
    unsupportedBytes.set(unsupported);
    await expect(
      destination.controller.onImportProjectPackage({
        file: new File(
          [unsupportedBytes.buffer],
          'unsupported.zuocheng.zip',
          { type: 'application/zip' },
        ),
      }),
    ).rejects.toMatchObject({
      name: 'ProjectPackageError',
      code: 'UNSUPPORTED_VERSION',
    });
    await expect(destinationStore.listProjects()).resolves.toEqual([]);
  });
});

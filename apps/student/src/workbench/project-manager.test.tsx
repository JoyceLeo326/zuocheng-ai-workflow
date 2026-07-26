import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  PackageDownloadUrlRegistry,
  ProjectActionConfirmation,
  ProjectManager,
  executeProjectManagerAction,
  filterManagedProjects,
  projectManagerActionReducer,
  type ManagedProject,
  type ProjectManagerCallbacks,
} from './project-manager.js';

const projects: readonly ManagedProject[] = [
  {
    id: 'active-older',
    title: '课程调研',
    status: 'active',
    createdAt: '2026-07-01T08:00:00.000Z',
    updatedAt: '2026-07-20T08:00:00.000Z',
    sourceCount: 3,
    draftPageCount: 4,
  },
  {
    id: 'active-newer',
    title: 'AI Literacy Review',
    status: 'active',
    createdAt: '2026-07-02T08:00:00.000Z',
    updatedAt: '2026-07-26T08:00:00.000Z',
    sourceCount: 2,
    draftPageCount: 6,
  },
  {
    id: 'archived-1',
    title: '往期答辩',
    status: 'archived',
    createdAt: '2026-06-01T08:00:00.000Z',
    updatedAt: '2026-06-30T08:00:00.000Z',
    sourceCount: 5,
    draftPageCount: 8,
  },
  {
    id: 'trashed-1',
    title: '废弃选题',
    status: 'trashed',
    createdAt: '2026-05-01T08:00:00.000Z',
    updatedAt: '2026-05-15T08:00:00.000Z',
    sourceCount: 1,
    draftPageCount: 0,
  },
];

function callbacks(): ProjectManagerCallbacks {
  return {
    onOpen: vi.fn().mockResolvedValue(undefined),
    onCreate: vi.fn().mockResolvedValue(undefined),
    onDuplicate: vi.fn().mockResolvedValue(undefined),
    onArchive: vi.fn().mockResolvedValue(undefined),
    onRestore: vi.fn().mockResolvedValue(undefined),
    onMoveToTrash: vi.fn().mockResolvedValue(undefined),
    onDeletePermanently: vi.fn().mockResolvedValue(undefined),
    onExportProjectPackage: vi.fn().mockResolvedValue({
      blob: new Blob(['package']),
      fileName: '课程调研-project.zip',
    }),
    onImportProjectPackage: vi.fn().mockResolvedValue(undefined),
  };
}

describe('project manager', () => {
  it('renders recent projects, lifecycle tabs and every real management action', () => {
    const html = renderToStaticMarkup(
      <ProjectManager {...callbacks()} projects={projects} />,
    );

    expect(html).toContain('本地项目');
    expect(html).toContain('最近项目');
    expect(html).toContain('搜索项目');
    expect(html).toContain('新建项目');
    expect(html).toContain('导入项目包');
    expect(html).toContain('进行中');
    expect(html).toContain('已归档');
    expect(html).toContain('回收站');
    expect(html).toContain('AI Literacy Review');
    expect(html).toContain('课程调研');
    expect(html.indexOf('AI Literacy Review')).toBeLessThan(
      html.indexOf('课程调研'),
    );
    expect(html).toContain('打开');
    expect(html).toContain('复制');
    expect(html).toContain('归档');
    expect(html).toContain('恢复项目');
    expect(html).toContain('移入回收站');
    expect(html).toContain('永久删除');
    expect(html).toContain('导出项目包');
    expect(html).toContain('accept=".zip,application/zip"');
    expect(html).not.toContain('0 成本');
    expect(html).not.toContain('IndexedDB');
    expect(html).not.toContain('callback');
  });

  it('searches case-insensitively inside a lifecycle and sorts by real update time', () => {
    expect(
      filterManagedProjects(projects, 'active', ''),
    ).toEqual([projects[1], projects[0]]);
    expect(
      filterManagedProjects(projects, 'active', ' literacy '),
    ).toEqual([projects[1]]);
    expect(
      filterManagedProjects(projects, 'archived', '答辩'),
    ).toEqual([projects[2]]);
    expect(
      filterManagedProjects(projects, 'trashed', 'missing'),
    ).toEqual([]);
  });

  it('requires a second confirmation and exact project title for irreversible deletion', () => {
    const trashed = projects[3]!;
    const wrongHtml = renderToStaticMarkup(
      <ProjectActionConfirmation
        confirmation={{ kind: 'delete', project: trashed }}
        confirmationText="废弃"
        onCancel={vi.fn()}
        onConfirmationTextChange={vi.fn()}
        onConfirm={vi.fn()}
        pending={false}
      />,
    );
    const exactHtml = renderToStaticMarkup(
      <ProjectActionConfirmation
        confirmation={{ kind: 'delete', project: trashed }}
        confirmationText="废弃选题"
        onCancel={vi.fn()}
        onConfirmationTextChange={vi.fn()}
        onConfirm={vi.fn()}
        pending={false}
      />,
    );
    const trashHtml = renderToStaticMarkup(
      <ProjectActionConfirmation
        confirmation={{ kind: 'trash', project: projects[0]! }}
        confirmationText=""
        onCancel={vi.fn()}
        onConfirmationTextChange={vi.fn()}
        onConfirm={vi.fn()}
        pending={false}
      />,
    );

    expect(wrongHtml).toContain('永久删除后不可恢复');
    expect(wrongHtml).toContain('输入项目名称“废弃选题”以确认');
    expect(wrongHtml).toContain('disabled=""');
    expect(exactHtml).toContain('>确认永久删除</button>');
    expect(exactHtml).not.toContain(
      'class="project-manager__confirm-danger" disabled=""',
    );
    expect(trashHtml).toContain('确认移入回收站');
    expect(trashHtml).toContain('移入后仍可从回收站恢复');
  });

  it('awaits exact callback payloads and exposes real errors without fake success', async () => {
    const open = vi.fn().mockResolvedValue({ destination: 'workbench' });
    await expect(
      executeProjectManagerAction(open, {
        projectId: 'active-newer',
      }),
    ).resolves.toEqual({
      ok: true,
      result: { destination: 'workbench' },
      error: null,
    });
    expect(open).toHaveBeenCalledWith({
      projectId: 'active-newer',
    });

    const failed = vi
      .fn()
      .mockRejectedValue(new Error('项目包校验失败'));
    await expect(
      executeProjectManagerAction(failed, {
        fileName: 'damaged.zip',
      }),
    ).resolves.toEqual({
      ok: false,
      result: null,
      error: '项目包校验失败',
    });
  });

  it('models pending and error feedback deterministically', () => {
    const pending = projectManagerActionReducer(
      { status: 'idle', actionKey: null, message: null },
      { type: 'start', actionKey: 'archive:active-older' },
    );
    expect(pending).toEqual({
      status: 'pending',
      actionKey: 'archive:active-older',
      message: null,
    });
    expect(
      projectManagerActionReducer(pending, {
        type: 'failure',
        message: '归档写入失败',
      }),
    ).toEqual({
      status: 'error',
      actionKey: null,
      message: '归档写入失败',
    });
  });

  it('revokes replaced, removed and released project-package URLs', () => {
    const createObjectURL = vi
      .fn()
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second');
    const revokeObjectURL = vi.fn();
    const registry = new PackageDownloadUrlRegistry({
      createObjectURL,
      revokeObjectURL,
    });

    expect(
      registry.replace('active-older', new Blob(['first'])),
    ).toBe('blob:first');
    expect(
      registry.replace('active-older', new Blob(['second'])),
    ).toBe('blob:second');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:first');

    registry.releaseMissing(new Set(['another-project']));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:second');
    registry.releaseAll();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});

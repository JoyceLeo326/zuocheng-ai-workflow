import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import './project-manager.css';

export type ManagedProjectStatus =
  | 'active'
  | 'archived'
  | 'trashed';

export interface ManagedProject {
  id: string;
  title: string;
  status: ManagedProjectStatus;
  createdAt: string;
  updatedAt: string;
  sourceCount: number;
  draftPageCount: number;
}

export interface ProjectPackageDownload {
  blob: Blob;
  fileName: string;
}

export interface ProjectManagerCallbacks {
  onOpen(input: Readonly<{ projectId: string }>): Promise<void>;
  onCreate(input: Readonly<{ title: string }>): Promise<void>;
  onDuplicate(input: Readonly<{ projectId: string }>): Promise<void>;
  onArchive(input: Readonly<{ projectId: string }>): Promise<void>;
  onRestore(
    input: Readonly<{
      projectId: string;
      from: 'archived' | 'trashed';
    }>,
  ): Promise<void>;
  onMoveToTrash(
    input: Readonly<{
      projectId: string;
      from: 'active' | 'archived';
    }>,
  ): Promise<void>;
  onDeletePermanently(
    input: Readonly<{ projectId: string }>,
  ): Promise<void>;
  onExportProjectPackage(
    input: Readonly<{ projectId: string }>,
  ): Promise<ProjectPackageDownload>;
  onImportProjectPackage(
    input: Readonly<{ file: File }>,
  ): Promise<void>;
}

export interface ProjectManagerProps extends ProjectManagerCallbacks {
  projects: readonly ManagedProject[];
}

export type ProjectConfirmationKind =
  | 'archive'
  | 'trash'
  | 'delete';

export type ProjectConfirmation = Readonly<{
  kind: ProjectConfirmationKind;
  project: ManagedProject;
}>;

export type ProjectManagerActionState = Readonly<{
  status: 'idle' | 'pending' | 'error';
  actionKey: string | null;
  message: string | null;
}>;

export type ProjectManagerAction =
  | Readonly<{ type: 'start'; actionKey: string }>
  | Readonly<{ type: 'success' }>
  | Readonly<{ type: 'failure'; message: string }>
  | Readonly<{ type: 'clear-error' }>;

export type ProjectManagerActionResult<TResult> =
  | Readonly<{
      ok: true;
      result: TResult;
      error: null;
    }>
  | Readonly<{
      ok: false;
      result: null;
      error: string;
    }>;

type ObjectUrlApi = Pick<
  typeof URL,
  'createObjectURL' | 'revokeObjectURL'
>;

type PackageDownloadState = Readonly<{
  url: string;
  fileName: string;
  projectUpdatedAt: string;
}>;

type ProjectActionName =
  | 'open'
  | 'duplicate'
  | 'archive'
  | 'restore'
  | 'trash'
  | 'delete'
  | 'export';

const STATUS_ORDER: readonly ManagedProjectStatus[] = [
  'active',
  'archived',
  'trashed',
];

const STATUS_LABELS: Readonly<
  Record<ManagedProjectStatus, string>
> = {
  active: '进行中',
  archived: '已归档',
  trashed: '回收站',
};

const INITIAL_ACTION_STATE: ProjectManagerActionState =
  Object.freeze({
    status: 'idle',
    actionKey: null,
    message: null,
  });

export class PackageDownloadUrlRegistry {
  readonly #urls = new Map<string, string>();

  constructor(
    private readonly api: ObjectUrlApi = globalThis.URL,
  ) {}

  replace(projectId: string, blob: Blob): string {
    const nextUrl = this.api.createObjectURL(blob);
    const previousUrl = this.#urls.get(projectId);
    this.#urls.set(projectId, nextUrl);
    if (previousUrl !== undefined) {
      this.api.revokeObjectURL(previousUrl);
    }
    return nextUrl;
  }

  release(projectId: string): void {
    const url = this.#urls.get(projectId);
    if (url === undefined) {
      return;
    }
    this.#urls.delete(projectId);
    this.api.revokeObjectURL(url);
  }

  releaseMissing(projectIds: ReadonlySet<string>): void {
    for (const projectId of [...this.#urls.keys()]) {
      if (!projectIds.has(projectId)) {
        this.release(projectId);
      }
    }
  }

  releaseAll(): void {
    for (const url of this.#urls.values()) {
      this.api.revokeObjectURL(url);
    }
    this.#urls.clear();
  }
}

export function filterManagedProjects(
  projects: readonly ManagedProject[],
  status: ManagedProjectStatus,
  query: string,
): readonly ManagedProject[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return [...projects]
    .filter(
      (project) =>
        project.status === status &&
        (normalizedQuery.length === 0 ||
          project.title
            .toLocaleLowerCase()
            .includes(normalizedQuery)),
    )
    .sort((left, right) => {
      const updatedDifference =
        safeTimestamp(right.updatedAt) -
        safeTimestamp(left.updatedAt);
      if (updatedDifference !== 0) {
        return updatedDifference;
      }
      return left.title.localeCompare(right.title, 'zh-CN');
    });
}

export async function executeProjectManagerAction<
  TInput,
  TResult,
>(
  callback: (input: TInput) => Promise<TResult>,
  input: TInput,
): Promise<ProjectManagerActionResult<TResult>> {
  try {
    return {
      ok: true,
      result: await callback(input),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      result: null,
      error:
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : '操作失败，请重试。',
    };
  }
}

export function projectManagerActionReducer(
  state: ProjectManagerActionState,
  action: ProjectManagerAction,
): ProjectManagerActionState {
  switch (action.type) {
    case 'start':
      return {
        status: 'pending',
        actionKey: action.actionKey,
        message: null,
      };
    case 'success':
    case 'clear-error':
      return INITIAL_ACTION_STATE;
    case 'failure':
      return {
        status: 'error',
        actionKey: null,
        message: action.message,
      };
  }
}

export function ProjectActionConfirmation({
  confirmation,
  confirmationText,
  onCancel,
  onConfirmationTextChange,
  onConfirm,
  pending,
}: Readonly<{
  confirmation: ProjectConfirmation;
  confirmationText: string;
  onCancel(): void;
  onConfirmationTextChange(value: string): void;
  onConfirm(): void;
  pending: boolean;
}>) {
  const { kind, project } = confirmation;
  const isDelete = kind === 'delete';
  const titleId = `project-confirm-${kind}-title`;
  const canConfirm =
    !pending &&
    (!isDelete || confirmationText === project.title);
  const copy = confirmationCopy(kind, project.title);

  return (
    <section
      aria-labelledby={titleId}
      className={`project-manager__confirmation project-manager__confirmation--${kind}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !pending) {
          onCancel();
        }
      }}
    >
      <div className="project-manager__confirmation-copy">
        <p>再次确认</p>
        <h3 id={titleId}>{copy.title}</h3>
        <span>{copy.description}</span>
      </div>

      {isDelete ? (
        <label className="project-manager__confirmation-input">
          <span>输入项目名称“{project.title}”以确认</span>
          <input
            autoComplete="off"
            autoFocus
            disabled={pending}
            onChange={(event) =>
              onConfirmationTextChange(event.currentTarget.value)
            }
            spellCheck={false}
            type="text"
            value={confirmationText}
          />
        </label>
      ) : null}

      <div className="project-manager__confirmation-actions">
        <button
          className="project-manager__confirm-cancel"
          disabled={pending}
          onClick={onCancel}
          type="button"
        >
          取消
        </button>
        <button
          autoFocus={!isDelete}
          className={
            isDelete || kind === 'trash'
              ? 'project-manager__confirm-danger'
              : 'project-manager__confirm-primary'
          }
          disabled={!canConfirm}
          onClick={onConfirm}
          type="button"
        >
          {pending ? '正在处理…' : copy.confirmLabel}
        </button>
      </div>
    </section>
  );
}

export function ProjectManager({
  projects,
  onOpen,
  onCreate,
  onDuplicate,
  onArchive,
  onRestore,
  onMoveToTrash,
  onDeletePermanently,
  onExportProjectPackage,
  onImportProjectPackage,
}: ProjectManagerProps) {
  const [selectedStatus, setSelectedStatus] =
    useState<ManagedProjectStatus>('active');
  const [query, setQuery] = useState('');
  const [newProjectTitle, setNewProjectTitle] = useState('');
  const [confirmation, setConfirmation] =
    useState<ProjectConfirmation | null>(null);
  const [confirmationText, setConfirmationText] = useState('');
  const [actionState, dispatch] = useReducer(
    projectManagerActionReducer,
    INITIAL_ACTION_STATE,
  );
  const [downloads, setDownloads] = useState<
    Readonly<Record<string, PackageDownloadState>>
  >({});
  const mountedRef = useRef(true);
  const managerRef = useRef<HTMLElement | null>(null);
  const confirmationReturnFocusRef =
    useRef<HTMLButtonElement | null>(null);
  const urlRegistryRef =
    useRef<PackageDownloadUrlRegistry | null>(null);
  if (urlRegistryRef.current === null) {
    urlRegistryRef.current = new PackageDownloadUrlRegistry();
  }

  const projectsByStatus = useMemo(
    () =>
      Object.fromEntries(
        STATUS_ORDER.map((status) => [
          status,
          filterManagedProjects(projects, status, query),
        ]),
      ) as Record<
        ManagedProjectStatus,
        readonly ManagedProject[]
      >,
    [projects, query],
  );
  const counts = useMemo(
    () =>
      Object.fromEntries(
        STATUS_ORDER.map((status) => [
          status,
          projects.filter(
            (project) => project.status === status,
          ).length,
        ]),
      ) as Record<ManagedProjectStatus, number>,
    [projects],
  );
  const busy = actionState.status === 'pending';

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      urlRegistryRef.current?.releaseAll();
    };
  }, []);

  useEffect(() => {
    const currentProjects = new Map(
      projects.map((project) => [project.id, project]),
    );
    urlRegistryRef.current?.releaseMissing(
      new Set(currentProjects.keys()),
    );
    setDownloads((current) => {
      const retained = Object.fromEntries(
        Object.entries(current).filter(
          ([projectId, download]) => {
            const project = currentProjects.get(projectId);
            const currentDownload =
              download as PackageDownloadState;
            const keep =
              project !== undefined &&
              project.updatedAt ===
                currentDownload.projectUpdatedAt;
            if (!keep) {
              urlRegistryRef.current?.release(projectId);
            }
            return keep;
          },
        ),
      );
      return Object.keys(retained).length ===
        Object.keys(current).length
        ? current
        : retained;
    });
  }, [projects]);

  async function runAction<TInput, TResult>(
    actionKey: string,
    callback: (input: TInput) => Promise<TResult>,
    input: TInput,
  ): Promise<ProjectManagerActionResult<TResult>> {
    dispatch({ type: 'start', actionKey });
    const outcome = await executeProjectManagerAction(
      callback,
      input,
    );
    if (!mountedRef.current) {
      return outcome;
    }
    if (outcome.ok) {
      dispatch({ type: 'success' });
    } else {
      dispatch({ type: 'failure', message: outcome.error });
    }
    return outcome;
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = newProjectTitle.trim();
    if (title.length === 0 || busy) {
      return;
    }
    const outcome = await runAction(
      'create',
      onCreate,
      { title },
    );
    if (outcome.ok && mountedRef.current) {
      setNewProjectTitle('');
    }
  }

  async function handleImport(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.currentTarget.files?.[0];
    if (file === undefined || busy) {
      return;
    }
    const input = event.currentTarget;
    await runAction(
      'import',
      onImportProjectPackage,
      { file },
    );
    if (mountedRef.current) {
      input.value = '';
    }
  }

  async function handleImmediateAction(
    action: ProjectActionName,
    project: ManagedProject,
    trigger: HTMLButtonElement,
  ) {
    if (busy) {
      return;
    }
    switch (action) {
      case 'open':
        await runAction(
          `open:${project.id}`,
          onOpen,
          { projectId: project.id },
        );
        return;
      case 'duplicate':
        await runAction(
          `duplicate:${project.id}`,
          onDuplicate,
          { projectId: project.id },
        );
        return;
      case 'restore':
        if (project.status === 'active') {
          return;
        }
        await runAction(
          `restore:${project.id}`,
          onRestore,
          {
            projectId: project.id,
            from: project.status,
          },
        );
        return;
      case 'export': {
        const outcome = await runAction(
          `export:${project.id}`,
          onExportProjectPackage,
          { projectId: project.id },
        );
        if (!outcome.ok || !mountedRef.current) {
          return;
        }
        try {
          if (
            outcome.result.blob.size === 0 ||
            outcome.result.fileName.trim().length === 0
          ) {
            throw new Error('项目包为空或文件名无效');
          }
          const url = urlRegistryRef.current!.replace(
            project.id,
            outcome.result.blob,
          );
          setDownloads((current) => ({
            ...current,
            [project.id]: {
              url,
              fileName: outcome.result.fileName,
              projectUpdatedAt: project.updatedAt,
            },
          }));
        } catch (error) {
          dispatch({
            type: 'failure',
            message:
              error instanceof Error &&
              error.message.trim().length > 0
                ? `下载链接创建失败：${error.message}`
                : '下载链接创建失败，请重试。',
          });
        }
        return;
      }
      case 'archive':
      case 'trash':
      case 'delete':
        confirmationReturnFocusRef.current = trigger;
        setConfirmation({ kind: action, project });
        setConfirmationText('');
        return;
    }
  }

  async function handleConfirmedAction() {
    if (confirmation === null || busy) {
      return;
    }
    const { kind, project } = confirmation;
    let outcome: ProjectManagerActionResult<void>;
    if (kind === 'archive') {
      outcome = await runAction(
        `archive:${project.id}`,
        onArchive,
        { projectId: project.id },
      );
    } else if (kind === 'trash') {
      if (project.status === 'trashed') {
        return;
      }
      outcome = await runAction(
        `trash:${project.id}`,
        onMoveToTrash,
        {
          projectId: project.id,
          from: project.status,
        },
      );
    } else {
      if (confirmationText !== project.title) {
        return;
      }
      outcome = await runAction(
        `delete:${project.id}`,
        onDeletePermanently,
        { projectId: project.id },
      );
    }
    if (outcome.ok && mountedRef.current) {
      closeConfirmation();
    }
  }

  function closeConfirmation() {
    setConfirmation(null);
    setConfirmationText('');
    const returnTarget = confirmationReturnFocusRef.current;
    confirmationReturnFocusRef.current = null;
    globalThis.requestAnimationFrame?.(() => {
      if (returnTarget?.isConnected) {
        returnTarget.focus();
      } else {
        managerRef.current?.focus();
      }
    });
  }

  return (
    <section
      aria-busy={busy}
      aria-labelledby="project-manager-title"
      className="project-manager"
      ref={managerRef}
      tabIndex={-1}
    >
      <header className="project-manager__hero">
        <div>
          <p className="project-manager__eyebrow">本地项目</p>
          <h2 id="project-manager-title">最近项目</h2>
          <p>
            查找并管理本机项目，或从已有项目包继续工作。
          </p>
        </div>
        <label className="project-manager__import">
          <span>{busy && actionState.actionKey === 'import'
            ? '正在导入…'
            : '导入项目包'}</span>
          <input
            accept=".zip,application/zip"
            disabled={busy}
            onChange={(event) => {
              void handleImport(event);
            }}
            type="file"
          />
        </label>
      </header>

      <div className="project-manager__controls">
        <label className="project-manager__search">
          <span>搜索项目</span>
          <input
            onChange={(event) =>
              setQuery(event.currentTarget.value)
            }
            placeholder="输入项目名称"
            type="search"
            value={query}
          />
        </label>

        <form
          className="project-manager__create"
          onSubmit={(event) => {
            void handleCreate(event);
          }}
        >
          <label>
            <span>新建项目</span>
            <input
              disabled={busy}
              maxLength={120}
              onChange={(event) =>
                setNewProjectTitle(event.currentTarget.value)
              }
              placeholder="项目名称"
              type="text"
              value={newProjectTitle}
            />
          </label>
          <button
            disabled={busy || newProjectTitle.trim().length === 0}
            type="submit"
          >
            {busy && actionState.actionKey === 'create'
              ? '正在新建…'
              : '新建'}
          </button>
        </form>
      </div>

      {actionState.status === 'error' &&
      actionState.message !== null ? (
        <div
          className="project-manager__error"
          role="alert"
        >
          <div>
            <strong>操作未完成</strong>
            <span>{actionState.message}</span>
          </div>
          <button
            onClick={() =>
              dispatch({ type: 'clear-error' })
            }
            type="button"
          >
            关闭
          </button>
        </div>
      ) : null}

      <div
        aria-label="项目状态"
        className="project-manager__tabs"
        role="tablist"
      >
        {STATUS_ORDER.map((status) => (
          <button
            aria-controls={`projects-${status}`}
            aria-selected={selectedStatus === status}
            id={`projects-${status}-tab`}
            key={status}
            onKeyDown={(event) => {
              const nextStatus = tabStatusForKey(
                status,
                event.key,
              );
              if (nextStatus === null) {
                return;
              }
              event.preventDefault();
              setSelectedStatus(nextStatus);
              globalThis.requestAnimationFrame?.(() => {
                document
                  .getElementById(
                    `projects-${nextStatus}-tab`,
                  )
                  ?.focus();
              });
            }}
            onClick={() => setSelectedStatus(status)}
            role="tab"
            tabIndex={selectedStatus === status ? 0 : -1}
            type="button"
          >
            <span>{STATUS_LABELS[status]}</span>
            <strong>{counts[status]}</strong>
          </button>
        ))}
      </div>

      {STATUS_ORDER.map((status) => {
        const visibleProjects = projectsByStatus[status];
        return (
          <section
            aria-labelledby={`projects-${status}-tab`}
            className="project-manager__panel"
            hidden={selectedStatus !== status}
            id={`projects-${status}`}
            key={status}
            role="tabpanel"
          >
            <div className="project-manager__panel-heading">
              <div>
                <p className="project-manager__eyebrow">
                  {STATUS_LABELS[status]}
                </p>
                <h3>{panelTitle(status)}</h3>
              </div>
              <span>
                {query.trim().length === 0
                  ? `${visibleProjects.length} 个项目`
                  : `${visibleProjects.length} 个匹配项目`}
              </span>
            </div>

            {visibleProjects.length === 0 ? (
              <div className="project-manager__empty">
                <strong>
                  {query.trim().length === 0
                    ? emptyTitle(status)
                    : '没有匹配的项目'}
                </strong>
                <p>
                  {query.trim().length === 0
                    ? emptyDescription(status)
                    : '请调整搜索关键词后重试。'}
                </p>
              </div>
            ) : (
              <div className="project-manager__grid">
                {visibleProjects.map((project) => (
                  <ProjectCard
                    busy={busy}
                    download={downloads[project.id] ?? null}
                    key={project.id}
                    onAction={(action, trigger) => {
                      void handleImmediateAction(
                        action,
                        project,
                        trigger,
                      );
                    }}
                    pendingActionKey={
                      actionState.status === 'pending'
                        ? actionState.actionKey
                        : null
                    }
                    project={project}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {confirmation !== null ? (
        <ProjectActionConfirmation
          confirmation={confirmation}
          confirmationText={confirmationText}
          onCancel={closeConfirmation}
          onConfirmationTextChange={setConfirmationText}
          onConfirm={() => {
            void handleConfirmedAction();
          }}
          pending={busy}
        />
      ) : null}
    </section>
  );
}

function ProjectCard({
  busy,
  download,
  onAction,
  pendingActionKey,
  project,
}: Readonly<{
  busy: boolean;
  download: PackageDownloadState | null;
  onAction(
    action: ProjectActionName,
    trigger: HTMLButtonElement,
  ): void;
  pendingActionKey: string | null;
  project: ManagedProject;
}>) {
  const titleId = `project-${project.id}-title`;
  const actions = projectActions(project.status);

  return (
    <article
      aria-labelledby={titleId}
      className={`project-manager__card project-manager__card--${project.status}`}
    >
      <div className="project-manager__card-heading">
        <span className="project-manager__status">
          {STATUS_LABELS[project.status]}
        </span>
        <time dateTime={project.updatedAt}>
          更新于 {formatDate(project.updatedAt)}
        </time>
      </div>
      <h4 id={titleId}>{project.title}</h4>
      <dl>
        <div>
          <dt>来源</dt>
          <dd>{project.sourceCount} 份</dd>
        </div>
        <div>
          <dt>草稿</dt>
          <dd>{project.draftPageCount} 页</dd>
        </div>
      </dl>

      {download !== null ? (
        <a
          aria-label={`下载项目包：${project.title}`}
          className="project-manager__download"
          download={download.fileName}
          href={download.url}
        >
          下载已生成的项目包
        </a>
      ) : null}

      <div
        aria-label={`${project.title}的项目操作`}
        className="project-manager__actions"
      >
        {actions.map((action) => {
          const actionKey = `${action}:${project.id}`;
          const isPending = pendingActionKey === actionKey;
          return (
            <button
              aria-label={`${actionLabel(action)}：${project.title}`}
              className={
                action === 'delete' || action === 'trash'
                  ? 'project-manager__action-danger'
                  : action === 'open'
                    ? 'project-manager__action-primary'
                    : undefined
              }
              disabled={busy}
              key={action}
              onClick={(event) =>
                onAction(action, event.currentTarget)
              }
              type="button"
            >
              {isPending
                ? pendingActionLabel(action)
                : actionLabel(action)}
            </button>
          );
        })}
      </div>
    </article>
  );
}

function projectActions(
  status: ManagedProjectStatus,
): readonly ProjectActionName[] {
  switch (status) {
    case 'active':
      return [
        'open',
        'duplicate',
        'export',
        'archive',
        'trash',
      ];
    case 'archived':
      return [
        'open',
        'restore',
        'duplicate',
        'export',
        'trash',
      ];
    case 'trashed':
      return ['restore', 'export', 'delete'];
  }
}

function actionLabel(action: ProjectActionName): string {
  const labels: Record<ProjectActionName, string> = {
    open: '打开',
    duplicate: '复制',
    archive: '归档',
    restore: '恢复项目',
    trash: '移入回收站',
    delete: '永久删除',
    export: '导出项目包',
  };
  return labels[action];
}

function pendingActionLabel(action: ProjectActionName): string {
  const labels: Record<ProjectActionName, string> = {
    open: '正在打开…',
    duplicate: '正在复制…',
    archive: '正在归档…',
    restore: '正在恢复…',
    trash: '正在移动…',
    delete: '正在删除…',
    export: '正在导出…',
  };
  return labels[action];
}

function confirmationCopy(
  kind: ProjectConfirmationKind,
  projectTitle: string,
): Readonly<{
  title: string;
  description: string;
  confirmLabel: string;
}> {
  switch (kind) {
    case 'archive':
      return {
        title: `归档“${projectTitle}”？`,
        description:
          '归档后项目不再出现在进行中列表，可随时恢复。',
        confirmLabel: '确认归档',
      };
    case 'trash':
      return {
        title: `将“${projectTitle}”移入回收站？`,
        description: '移入后仍可从回收站恢复。',
        confirmLabel: '确认移入回收站',
      };
    case 'delete':
      return {
        title: `永久删除“${projectTitle}”？`,
        description:
          '永久删除后不可恢复，项目内容和本地文件将被彻底移除。',
        confirmLabel: '确认永久删除',
      };
  }
}

function panelTitle(status: ManagedProjectStatus): string {
  const labels: Record<ManagedProjectStatus, string> = {
    active: '继续最近的工作',
    archived: '已完成或暂存的项目',
    trashed: '待恢复或永久删除',
  };
  return labels[status];
}

function emptyTitle(status: ManagedProjectStatus): string {
  const labels: Record<ManagedProjectStatus, string> = {
    active: '还没有进行中的项目',
    archived: '还没有归档项目',
    trashed: '回收站为空',
  };
  return labels[status];
}

function emptyDescription(
  status: ManagedProjectStatus,
): string {
  const labels: Record<ManagedProjectStatus, string> = {
    active: '新建项目或导入项目包后，可从这里继续工作。',
    archived: '归档的项目会保留在这里。',
    trashed: '移入回收站的项目会显示在这里。',
  };
  return labels[status];
}

function tabStatusForKey(
  current: ManagedProjectStatus,
  key: string,
): ManagedProjectStatus | null {
  const currentIndex = STATUS_ORDER.indexOf(current);
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return STATUS_ORDER[
        (currentIndex + 1) % STATUS_ORDER.length
      ]!;
    case 'ArrowLeft':
    case 'ArrowUp':
      return STATUS_ORDER[
        (currentIndex - 1 + STATUS_ORDER.length) %
          STATUS_ORDER.length
      ]!;
    case 'Home':
      return STATUS_ORDER[0]!;
    case 'End':
      return STATUS_ORDER[STATUS_ORDER.length - 1]!;
    default:
      return null;
  }
}

function safeTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatDate(value: string): string {
  const timestamp = safeTimestamp(value);
  if (timestamp === 0) {
    return value;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

import {
  useEffect,
  useId,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import type {
  Project,
  SourceChunk,
  SourceFile,
} from './project-model.js';
import './source-manager.css';

export interface SourceManagerCallbacks {
  onAppendFiles(
    input: Readonly<{
      projectId: string;
      files: readonly File[];
    }>,
  ): Promise<void>;
  onRetrySource(
    input: Readonly<{
      projectId: string;
      sourceFileId: string;
    }>,
  ): Promise<void>;
  onReplaceSource(
    input: Readonly<{
      projectId: string;
      sourceFileId: string;
      file: File;
    }>,
  ): Promise<void>;
  onDeleteSource(
    input: Readonly<{
      projectId: string;
      sourceFileId: string;
    }>,
  ): Promise<void>;
}

export interface SourceManagerProps extends SourceManagerCallbacks {
  project: Pick<Project, 'id' | 'title'>;
  sourceFiles: readonly SourceFile[];
  sourceChunks: readonly SourceChunk[];
}

export type SourceStatusTone =
  | 'idle'
  | 'working'
  | 'ready'
  | 'failed'
  | 'replaced';

export type SourceStatusDetails = Readonly<{
  label: string;
  tone: SourceStatusTone;
  progress: number;
}>;

export type SourceManagerActionState = Readonly<{
  status: 'idle' | 'pending' | 'error';
  actionKey: string | null;
  message: string | null;
}>;

export type SourceManagerAction =
  | Readonly<{ type: 'start'; actionKey: string }>
  | Readonly<{ type: 'success' }>
  | Readonly<{ type: 'failure'; message: string }>
  | Readonly<{ type: 'clear-error' }>;

export type SourceManagerActionResult<TResult> =
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

const ACCEPTED_SOURCE_FILES =
  '.pdf,.docx,.pptx,.txt,.md,image/*';

const INITIAL_ACTION_STATE: SourceManagerActionState =
  Object.freeze({
    status: 'idle',
    actionKey: null,
    message: null,
  });

export function sourceStatusDetails(
  source: SourceFile,
): SourceStatusDetails {
  const progress = clampProgress(source.parseProgress);
  switch (source.status) {
    case 'pending':
      return { label: '待处理', tone: 'idle', progress };
    case 'uploading':
      return { label: '上传中', tone: 'working', progress };
    case 'queued':
      return { label: '等待解析', tone: 'working', progress };
    case 'parsing':
      return { label: '解析中', tone: 'working', progress };
    case 'ready':
      return { label: '解析完成', tone: 'ready', progress: 100 };
    case 'failed':
      return { label: '解析失败', tone: 'failed', progress };
    case 'replaced':
      return { label: '已被替换', tone: 'replaced', progress };
  }
}

export function sourceChunksForFile(
  source: SourceFile,
  chunks: readonly SourceChunk[],
): readonly SourceChunk[] {
  return chunks
    .filter(
      (chunk) =>
        chunk.sourceFileId === source.id &&
        chunk.sourceFileVersion === source.sourceVersion,
    )
    .sort(
      (left, right) =>
        left.ordinal - right.ordinal ||
        left.characterStart - right.characterStart ||
        left.id.localeCompare(right.id),
    );
}

export async function executeSourceManagerAction<
  TInput,
  TResult,
>(
  callback: (input: TInput) => Promise<TResult>,
  input: TInput,
): Promise<SourceManagerActionResult<TResult>> {
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
          : '材料操作失败，请重试。',
    };
  }
}

export function sourceManagerActionReducer(
  state: SourceManagerActionState,
  action: SourceManagerAction,
): SourceManagerActionState {
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

export function SourceDeleteConfirmation({
  onCancel,
  onConfirm,
  pending,
  source,
}: Readonly<{
  onCancel(): void;
  onConfirm(): void;
  pending: boolean;
  source: SourceFile;
}>) {
  const titleId = `source-delete-${source.id}-title`;
  return (
    <section
      aria-labelledby={titleId}
      className="source-manager__confirmation"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !pending) {
          onCancel();
        }
      }}
    >
      <div>
        <p>再次确认</p>
        <h3 id={titleId}>确认删除材料</h3>
        <strong>{source.fileName}</strong>
        <span>
          删除后将无法继续查看此材料的原文片段。
        </span>
      </div>
      <div className="source-manager__confirmation-actions">
        <button
          disabled={pending}
          onClick={onCancel}
          type="button"
        >
          取消
        </button>
        <button
          autoFocus
          className="source-manager__danger-button"
          disabled={pending}
          onClick={onConfirm}
          type="button"
        >
          {pending ? '正在删除…' : '确认删除'}
        </button>
      </div>
    </section>
  );
}

export function SourceManager({
  project,
  sourceFiles,
  sourceChunks,
  onAppendFiles,
  onRetrySource,
  onReplaceSource,
  onDeleteSource,
}: SourceManagerProps) {
  const appendInputId = useId();
  const [expandedSourceId, setExpandedSourceId] =
    useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [deleteSource, setDeleteSource] =
    useState<SourceFile | null>(null);
  const [actionState, dispatch] = useReducer(
    sourceManagerActionReducer,
    INITIAL_ACTION_STATE,
  );
  const mountedRef = useRef(true);
  const managerRef = useRef<HTMLElement | null>(null);
  const deleteReturnFocusRef =
    useRef<HTMLButtonElement | null>(null);
  const busy = actionState.status === 'pending';
  const interactionLocked = busy || deleteSource !== null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (
      expandedSourceId !== null &&
      !sourceFiles.some(
        (source) => source.id === expandedSourceId,
      )
    ) {
      setExpandedSourceId(null);
    }
    if (
      deleteSource !== null &&
      !sourceFiles.some(
        (source) => source.id === deleteSource.id,
      )
    ) {
      setDeleteSource(null);
    }
  }, [deleteSource, expandedSourceId, sourceFiles]);

  async function runAction<TInput, TResult>(
    actionKey: string,
    callback: (input: TInput) => Promise<TResult>,
    input: TInput,
  ): Promise<SourceManagerActionResult<TResult>> {
    dispatch({ type: 'start', actionKey });
    const outcome = await executeSourceManagerAction(
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

  async function appendFiles(files: readonly File[]) {
    if (files.length === 0 || interactionLocked) {
      return;
    }
    await runAction(
      'append',
      onAppendFiles,
      {
        projectId: project.id,
        files,
      },
    );
  }

  async function handleAppendInput(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    await appendFiles(files);
    if (mountedRef.current) {
      input.value = '';
    }
  }

  async function handleReplaceInput(
    source: SourceFile,
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file === undefined || interactionLocked) {
      return;
    }
    await runAction(
      `replace:${source.id}`,
      onReplaceSource,
      {
        projectId: project.id,
        sourceFileId: source.id,
        file,
      },
    );
    if (mountedRef.current) {
      input.value = '';
    }
  }

  async function handleRetry(source: SourceFile) {
    if (interactionLocked) {
      return;
    }
    await runAction(
      `retry:${source.id}`,
      onRetrySource,
      {
        projectId: project.id,
        sourceFileId: source.id,
      },
    );
  }

  async function handleConfirmedDelete() {
    if (deleteSource === null || busy) {
      return;
    }
    const outcome = await runAction(
      `delete:${deleteSource.id}`,
      onDeleteSource,
      {
        projectId: project.id,
        sourceFileId: deleteSource.id,
      },
    );
    if (outcome.ok && mountedRef.current) {
      closeDeleteConfirmation();
    }
  }

  function closeDeleteConfirmation() {
    setDeleteSource(null);
    const returnTarget = deleteReturnFocusRef.current;
    deleteReturnFocusRef.current = null;
    globalThis.requestAnimationFrame?.(() => {
      if (returnTarget?.isConnected) {
        returnTarget.focus();
      } else {
        managerRef.current?.focus();
      }
    });
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    if (interactionLocked) {
      return;
    }
    void appendFiles(Array.from(event.dataTransfer.files));
  }

  const readyCount = sourceFiles.filter(
    (source) => source.status === 'ready',
  ).length;
  const workingCount = sourceFiles.filter((source) =>
    ['pending', 'uploading', 'queued', 'parsing'].includes(
      source.status,
    ),
  ).length;
  const failedCount = sourceFiles.filter(
    (source) => source.status === 'failed',
  ).length;

  return (
    <section
      aria-busy={busy}
      aria-labelledby="source-manager-title"
      className="source-manager"
      ref={managerRef}
      tabIndex={-1}
    >
      <header className="source-manager__hero">
        <div>
          <p className="source-manager__eyebrow">
            材料管理
          </p>
          <h2 id="source-manager-title">{project.title}</h2>
          <p>
            添加、检查并维护用于当前任务的材料和原文片段。
          </p>
        </div>
        <dl className="source-manager__summary">
          <div>
            <dt>材料</dt>
            <dd>{sourceFiles.length}</dd>
          </div>
          <div>
            <dt>已解析</dt>
            <dd>{readyCount}</dd>
          </div>
          <div>
            <dt>处理中</dt>
            <dd>{workingCount}</dd>
          </div>
          <div>
            <dt>失败</dt>
            <dd>{failedCount}</dd>
          </div>
        </dl>
      </header>

      <div
        className={`source-manager__dropzone ${
          dragActive
            ? 'source-manager__dropzone--active'
            : ''
        }`}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!interactionLocked) {
            setDragActive(true);
          }
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          const nextTarget = event.relatedTarget;
          if (
            !(nextTarget instanceof Node) ||
            !event.currentTarget.contains(nextTarget)
          ) {
            setDragActive(false);
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = interactionLocked
            ? 'none'
            : 'copy';
        }}
        onDrop={handleDrop}
      >
        <div>
          <span aria-hidden="true">＋</span>
          <strong>拖拽材料到这里</strong>
          <p>
            支持 PDF、DOCX、PPTX、TXT、Markdown 和图片，可一次添加多个文件。
          </p>
        </div>
        <label htmlFor={appendInputId}>
          <span>
            {busy && actionState.actionKey === 'append'
              ? '正在添加…'
              : '选择材料文件'}
          </span>
          <input
            accept={ACCEPTED_SOURCE_FILES}
            disabled={interactionLocked}
            id={appendInputId}
            multiple
            onChange={(event) => {
              void handleAppendInput(event);
            }}
            type="file"
          />
        </label>
      </div>

      {actionState.status === 'error' &&
      actionState.message !== null ? (
        <div
          className="source-manager__error"
          role="alert"
        >
          <div>
            <strong>材料操作未完成</strong>
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

      {busy ? (
        <p
          className="source-manager__pending"
          role="status"
        >
          正在处理材料，请稍候…
        </p>
      ) : null}

      {sourceFiles.length === 0 ? (
        <div className="source-manager__empty">
          <span aria-hidden="true">◇</span>
          <div>
            <strong>尚未添加材料</strong>
            <p>
              选择文件或拖入上方区域，材料会显示在这里。
            </p>
          </div>
        </div>
      ) : (
        <div
          aria-label="项目材料"
          className="source-manager__list"
          role="list"
        >
          {sourceFiles.map((source) => {
            const chunks = sourceChunksForFile(
              source,
              sourceChunks,
            );
            const expanded =
              expandedSourceId === source.id;
            return (
              <SourceCard
                busy={interactionLocked}
                chunks={chunks}
                expanded={expanded}
                key={source.id}
                onDelete={(trigger) => {
                  deleteReturnFocusRef.current = trigger;
                  setDeleteSource(source);
                }}
                onReplace={(event) => {
                  void handleReplaceInput(source, event);
                }}
                onRetry={() => {
                  void handleRetry(source);
                }}
                onToggleChunks={() =>
                  setExpandedSourceId((current) =>
                    current === source.id ? null : source.id,
                  )
                }
                pendingActionKey={
                  actionState.status === 'pending'
                    ? actionState.actionKey
                    : null
                }
                source={source}
              />
            );
          })}
        </div>
      )}

      {deleteSource !== null ? (
        <SourceDeleteConfirmation
          onCancel={closeDeleteConfirmation}
          onConfirm={() => {
            void handleConfirmedDelete();
          }}
          pending={busy}
          source={deleteSource}
        />
      ) : null}
    </section>
  );
}

function SourceCard({
  busy,
  chunks,
  expanded,
  onDelete,
  onReplace,
  onRetry,
  onToggleChunks,
  pendingActionKey,
  source,
}: Readonly<{
  busy: boolean;
  chunks: readonly SourceChunk[];
  expanded: boolean;
  onDelete(trigger: HTMLButtonElement): void;
  onReplace(event: ChangeEvent<HTMLInputElement>): void;
  onRetry(): void;
  onToggleChunks(): void;
  pendingActionKey: string | null;
  source: SourceFile;
}>) {
  const status = sourceStatusDetails(source);
  const titleId = `source-${source.id}-title`;
  const chunksId = `source-${source.id}-chunks`;
  const retryPending =
    pendingActionKey === `retry:${source.id}`;
  const replacePending =
    pendingActionKey === `replace:${source.id}`;
  const canReplace = source.status !== 'replaced';
  const canViewChunks =
    source.status === 'ready' && chunks.length > 0;

  return (
    <article
      aria-labelledby={titleId}
      className={`source-manager__card source-manager__card--${status.tone}`}
      role="listitem"
    >
      <div className="source-manager__card-main">
        <div className="source-manager__file-mark">
          <span>{source.extension.toUpperCase()}</span>
        </div>

        <div className="source-manager__identity">
          <div>
            <h3 id={titleId}>{source.fileName}</h3>
            <span>
              {source.mediaType || '未知类型'} ·{' '}
              {formatFileSize(source.sizeBytes)}
            </span>
          </div>
          <div className="source-manager__counts">
            {source.pageCount !== null ? (
              <span>{source.pageCount} 页</span>
            ) : null}
            <span>{chunks.length} 个片段</span>
          </div>
        </div>

        <div className="source-manager__parse-state">
          <span
            aria-live="polite"
            className={`source-manager__status source-manager__status--${status.tone}`}
          >
            {status.label}
          </span>
          {status.tone === 'working' ? (
            <div
              aria-label={`${source.fileName}处理进度`}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={status.progress}
              className="source-manager__progress"
              role="progressbar"
            >
              <span
                style={{ width: `${status.progress}%` }}
              />
              <strong>{status.progress}%</strong>
            </div>
          ) : null}
          {source.status === 'failed' ? (
            <p className="source-manager__failure">
              <strong>
                {source.error?.message ??
                  '未提供失败原因。'}
              </strong>
              {!source.error?.retryable ? (
                <span>请替换或删除此材料。</span>
              ) : null}
            </p>
          ) : null}
        </div>

        <div
          aria-label={`${source.fileName}的材料操作`}
          className="source-manager__actions"
        >
          {canViewChunks ? (
            <button
              aria-controls={chunksId}
              aria-expanded={expanded}
              disabled={busy}
              onClick={onToggleChunks}
              type="button"
            >
              {expanded ? '收起片段' : '查看片段'}
            </button>
          ) : null}
          {source.status === 'failed' &&
          source.error?.retryable ? (
            <button
              disabled={busy}
              onClick={onRetry}
              type="button"
            >
              {retryPending ? '正在重试…' : '重试'}
            </button>
          ) : null}
          {canReplace ? (
            <label className="source-manager__replace">
              <span>
                {replacePending ? '正在替换…' : '替换'}
              </span>
              <input
                accept={ACCEPTED_SOURCE_FILES}
                aria-label={`替换材料：${source.fileName}`}
                disabled={busy}
                onChange={onReplace}
                type="file"
              />
            </label>
          ) : null}
          <button
            className="source-manager__delete"
            disabled={busy}
            onClick={(event) =>
              onDelete(event.currentTarget)
            }
            type="button"
          >
            删除
          </button>
        </div>
      </div>

      {expanded && canViewChunks ? (
        <section
          aria-label={`${source.fileName}的原文片段`}
          className="source-manager__chunks"
          id={chunksId}
        >
          <ol>
            {chunks.map((chunk) => (
              <li key={chunk.id}>
                <header>
                  <strong>{chunk.pageLabel}</strong>
                  <span>
                    字符 {chunk.characterStart}–
                    {chunk.characterEnd}
                  </span>
                </header>
                <p>{chunk.text}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </article>
  );
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_048_576) {
    return `${(bytes / 1_024).toFixed(1)} KB`;
  }
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

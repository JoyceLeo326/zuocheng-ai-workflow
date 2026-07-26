import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import {
  DELIVERABLE_KINDS,
  DeliverableExportError,
  exportDeliverable,
  type DeliverableExportInput,
  type DeliverableExportResult,
  type DeliverableKind,
} from './deliverable-export.js';
import type {
  DraftPage,
  DraftVerificationCheck,
} from './draft-verification.js';
import type { Project } from './project-model.js';
import './export-stage.css';

export type DeliverableExporter = (
  input: DeliverableExportInput,
) => Promise<DeliverableExportResult>;

export type ExportGate = Readonly<{
  allowed: boolean;
  reason: string | null;
}>;

export type ExportEntryStatus =
  | 'idle'
  | 'exporting'
  | 'success'
  | 'error';

export type ExportEntryState = Readonly<{
  status: ExportEntryStatus;
  exportedAt: string | null;
  result: DeliverableExportResult | null;
  downloadUrl: string | null;
  error: string | null;
}>;

export type ExportExecutionResult = Readonly<{
  status: 'success' | 'error';
  exportedAt: string;
  result: DeliverableExportResult | null;
  error: string | null;
}>;

export interface ExportStageProps {
  project: Project;
  draftPages: readonly DraftPage[];
  verificationChecks: readonly DraftVerificationCheck[];
  exporter?: DeliverableExporter;
}

type DeliverablePresentation = Readonly<{
  label: string;
  format: string;
  description: string;
  group: 'document' | 'record' | 'package';
}>;

const PRESENTATIONS: Readonly<
  Record<DeliverableKind, DeliverablePresentation>
> = {
  pptx: {
    label: '演示文稿 PPTX',
    format: 'PPTX',
    description: '包含页面内容、视觉说明、引用和演讲者备注。',
    group: 'document',
  },
  pdf: {
    label: '便携文档 PDF',
    format: 'PDF',
    description: '适合审阅和归档的固定版式文档。',
    group: 'document',
  },
  docx: {
    label: '文档 DOCX',
    format: 'DOCX',
    description: '可继续编辑的正文、引用和讲稿文档。',
    group: 'document',
  },
  markdown: {
    label: 'Markdown 初稿',
    format: 'MD',
    description: '保留页面层级、结论、正文和来源引用。',
    group: 'document',
  },
  script: {
    label: '讲稿',
    format: 'MD',
    description: '按页面整理的演讲备注、时长和核心结论。',
    group: 'document',
  },
  'source-index': {
    label: '来源索引',
    format: 'MD',
    description: '列出证据、源文件、页码、引文和确认状态。',
    group: 'record',
  },
  'task-card': {
    label: '任务卡',
    format: 'MD',
    description: '汇总受众、篇幅、格式、必含项和评分标准。',
    group: 'record',
  },
  'verification-report': {
    label: '核验记录',
    format: 'MD',
    description: '保存每条确定性核验的结果、位置和修复提示。',
    group: 'record',
  },
  'project-json': {
    label: 'Project JSON',
    format: 'JSON',
    description: '项目、草稿和核验记录的可移植结构化快照。',
    group: 'record',
  },
  'project-package': {
    label: '完整项目包',
    format: 'ZIP',
    description: '包含项目、草稿、清单和全部文本记录的归档包。',
    group: 'package',
  },
};

const INDEPENDENT_KINDS = new Set<DeliverableKind>([
  'source-index',
  'task-card',
  'verification-report',
  'project-json',
]);

const IDLE_ENTRY: ExportEntryState = Object.freeze({
  status: 'idle',
  exportedAt: null,
  result: null,
  downloadUrl: null,
  error: null,
});

type ExportEntries = Readonly<
  Record<DeliverableKind, ExportEntryState>
>;

type ExportEntriesAction =
  | Readonly<{
      type: 'reset';
    }>
  | Readonly<{
      type: 'start';
      kind: DeliverableKind;
      exportedAt: string;
    }>
  | Readonly<{
      type: 'success';
      kind: DeliverableKind;
      exportedAt: string;
      result: DeliverableExportResult;
      downloadUrl: string;
    }>
  | Readonly<{
      type: 'failure';
      kind: DeliverableKind;
      exportedAt: string;
      error: string;
    }>;

type ObjectUrlApi = Pick<
  typeof URL,
  'createObjectURL' | 'revokeObjectURL'
>;

export class DownloadUrlRegistry {
  readonly #urls = new Map<DeliverableKind, string>();

  constructor(
    private readonly api: ObjectUrlApi = globalThis.URL,
  ) {}

  replace(kind: DeliverableKind, blob: Blob): string {
    const nextUrl = this.api.createObjectURL(blob);
    const previousUrl = this.#urls.get(kind);
    this.#urls.set(kind, nextUrl);
    if (previousUrl !== undefined) {
      this.api.revokeObjectURL(previousUrl);
    }
    return nextUrl;
  }

  release(kind: DeliverableKind): void {
    const url = this.#urls.get(kind);
    if (url === undefined) {
      return;
    }
    this.#urls.delete(kind);
    this.api.revokeObjectURL(url);
  }

  releaseAll(): void {
    for (const url of this.#urls.values()) {
      this.api.revokeObjectURL(url);
    }
    this.#urls.clear();
  }
}

export function getDeliverableGate(
  kind: DeliverableKind,
  draftPages: readonly DraftPage[],
  verificationChecks: readonly DraftVerificationCheck[],
): ExportGate {
  if (INDEPENDENT_KINDS.has(kind)) {
    return { allowed: true, reason: null };
  }
  if (draftPages.length === 0) {
    return {
      allowed: false,
      reason: '尚无草稿页面，完成初稿后才能导出此项。',
    };
  }
  if (
    verificationChecks.some((check) => check.outcome === 'fail')
  ) {
    return {
      allowed: false,
      reason: '核验仍有失败项，修复并重新核验后才能导出此项。',
    };
  }
  if (
    verificationChecks.length === 0 ||
    verificationChecks.some(
      (check) => check.outcome === 'not_run',
    )
  ) {
    return {
      allowed: false,
      reason: '核验尚未完成，运行核验后才能导出此项。',
    };
  }
  return { allowed: true, reason: null };
}

export async function executeDeliverableExport(
  exporter: DeliverableExporter,
  input: DeliverableExportInput,
): Promise<ExportExecutionResult> {
  try {
    const result = await exporter(input);
    return {
      status: 'success',
      exportedAt: input.exportedAt,
      result,
      error: null,
    };
  } catch (error) {
    return {
      status: 'error',
      exportedAt: input.exportedAt,
      result: null,
      error: exportErrorMessage(error),
    };
  }
}

export function DeliverableExportCard({
  gate,
  kind,
  onExport,
  state,
}: Readonly<{
  gate: ExportGate;
  kind: DeliverableKind;
  onExport(kind: DeliverableKind): void;
  state: ExportEntryState;
}>) {
  const presentation = PRESENTATIONS[kind];
  const titleId = `deliverable-${kind}-title`;
  const descriptionId = `deliverable-${kind}-description`;
  const gateId = `deliverable-${kind}-gate`;
  const isExporting = state.status === 'exporting';

  return (
    <article
      aria-labelledby={titleId}
      className={`export-stage__card export-stage__card--${presentation.group}`}
      data-kind={kind}
    >
      <div className="export-stage__card-heading">
        <div>
          <span className="export-stage__format">
            {presentation.format}
          </span>
          <h3 id={titleId}>{presentation.label}</h3>
        </div>
        <ExportStatus status={state.status} />
      </div>

      <p
        className="export-stage__description"
        id={descriptionId}
      >
        {presentation.description}
      </p>

      {!gate.allowed && gate.reason !== null ? (
        <p
          className="export-stage__gate"
          id={gateId}
          role="note"
        >
          {gate.reason}
        </p>
      ) : null}

      {state.error !== null ? (
        <p
          className="export-stage__error"
          role="alert"
        >
          <strong>导出失败</strong>
          <span>{state.error}</span>
        </p>
      ) : null}

      {state.result !== null &&
      state.downloadUrl !== null &&
      state.exportedAt !== null ? (
        <ExportMetadata
          downloadUrl={state.downloadUrl}
          exportedAt={state.exportedAt}
          result={state.result}
        />
      ) : (
        <p
          aria-live="polite"
          className="export-stage__waiting"
        >
          {isExporting ? '正在生成文件，请稍候…' : '尚未生成'}
        </p>
      )}

      <button
        aria-describedby={
          gate.allowed
            ? descriptionId
            : `${descriptionId} ${gateId}`
        }
        aria-label={`${
          state.result === null ? '导出' : '重新导出'
        }${presentation.label}`}
        className="export-stage__export-button"
        disabled={!gate.allowed || isExporting}
        onClick={() => onExport(kind)}
        type="button"
      >
        {isExporting
          ? '正在导出…'
          : state.result === null
            ? '导出'
            : '重新导出'}
      </button>
    </article>
  );
}

export function ExportStage({
  project,
  draftPages,
  verificationChecks,
  exporter = defaultExporter,
}: ExportStageProps) {
  const [entries, dispatch] = useReducer(
    exportEntriesReducer,
    undefined,
    initialExportEntries,
  );
  const registryRef = useRef<DownloadUrlRegistry | null>(null);
  const mountedRef = useRef(true);
  const attemptRef = useRef(new Map<DeliverableKind, number>());
  const inputsRef = useRef({
    project,
    draftPages,
    verificationChecks,
  });
  if (registryRef.current === null) {
    registryRef.current = new DownloadUrlRegistry();
  }

  const gates = useMemo(
    () =>
      Object.fromEntries(
        DELIVERABLE_KINDS.map((kind) => [
          kind,
          getDeliverableGate(
            kind,
            draftPages,
            verificationChecks,
          ),
        ]),
      ) as Record<DeliverableKind, ExportGate>,
    [draftPages, verificationChecks],
  );
  const failedCount = verificationChecks.filter(
    (check) => check.outcome === 'fail',
  ).length;
  const warningCount = verificationChecks.filter(
    (check) => check.outcome === 'warning',
  ).length;
  const notRunCount = verificationChecks.filter(
    (check) => check.outcome === 'not_run',
  ).length;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      attemptRef.current.clear();
      registryRef.current?.releaseAll();
    };
  }, []);

  useEffect(() => {
    const previous = inputsRef.current;
    if (
      previous.project === project &&
      previous.draftPages === draftPages &&
      previous.verificationChecks === verificationChecks
    ) {
      return;
    }
    inputsRef.current = {
      project,
      draftPages,
      verificationChecks,
    };
    attemptRef.current.clear();
    registryRef.current?.releaseAll();
    dispatch({ type: 'reset' });
  }, [draftPages, project, verificationChecks]);

  const handleExport = useCallback(
    async (kind: DeliverableKind) => {
      if (!gates[kind].allowed) {
        return;
      }
      const exportedAt = new Date().toISOString();
      const attempt = (attemptRef.current.get(kind) ?? 0) + 1;
      attemptRef.current.set(kind, attempt);
      dispatch({ type: 'start', kind, exportedAt });

      const execution = await executeDeliverableExport(exporter, {
        kind,
        project,
        draftPages,
        verificationChecks,
        exportedAt,
      });
      if (
        !mountedRef.current ||
        attemptRef.current.get(kind) !== attempt
      ) {
        return;
      }
      if (
        execution.status === 'error' ||
        execution.result === null
      ) {
        dispatch({
          type: 'failure',
          kind,
          exportedAt,
          error:
            execution.error ??
            '文件生成失败，请检查项目数据后重试。',
        });
        return;
      }

      try {
        const downloadUrl = registryRef.current!.replace(
          kind,
          execution.result.blob,
        );
        dispatch({
          type: 'success',
          kind,
          exportedAt,
          result: execution.result,
          downloadUrl,
        });
      } catch (error) {
        dispatch({
          type: 'failure',
          kind,
          exportedAt,
          error:
            error instanceof Error && error.message.length > 0
              ? `下载链接创建失败：${error.message}`
              : '下载链接创建失败，请重试。',
        });
      }
    },
    [
      draftPages,
      exporter,
      gates,
      project,
      verificationChecks,
    ],
  );

  const packageGate = gates['project-package'];
  const packageIsExporting =
    entries['project-package'].status === 'exporting';

  return (
    <section
      aria-labelledby="export-stage-title"
      className="export-stage"
    >
      <header className="export-stage__hero">
        <div>
          <p className="export-stage__eyebrow">第 6 阶段 · 导出与交付</p>
          <h2 id="export-stage-title">生成可核验的交付文件</h2>
          <p className="export-stage__intro">
            每次导出都基于当前项目快照重新生成文件，并记录实际大小与
            SHA-256。浏览器不会在文件真正生成前显示成功。
          </p>
        </div>
        <div className="export-stage__package-action">
          <button
            aria-describedby={
              packageGate.allowed
                ? 'export-stage-package-note'
                : 'export-stage-package-note export-stage-package-gate'
            }
            disabled={!packageGate.allowed || packageIsExporting}
            onClick={() => {
              void handleExport('project-package');
            }}
            type="button"
          >
            {packageIsExporting
              ? '正在生成完整交付包…'
              : '导出完整交付包'}
          </button>
          <p id="export-stage-package-note">
            将项目、草稿、来源和核验记录归档为 ZIP。
          </p>
          {!packageGate.allowed && packageGate.reason !== null ? (
            <p
              className="export-stage__package-gate"
              id="export-stage-package-gate"
            >
              {packageGate.reason}
            </p>
          ) : null}
        </div>
      </header>

      <ExportReadiness
        draftCount={draftPages.length}
        failedCount={failedCount}
        notRunCount={notRunCount}
        verificationCount={verificationChecks.length}
        warningCount={warningCount}
      />

      <div className="export-stage__group">
        <div className="export-stage__group-heading">
          <div>
            <p className="export-stage__group-kicker">
              成果文件
            </p>
            <h3>面向提交与展示</h3>
          </div>
          <p>需要草稿完整且确定性核验无失败项。</p>
        </div>
        <div className="export-stage__grid">
          {DELIVERABLE_KINDS.filter(
            (kind) => PRESENTATIONS[kind].group === 'document',
          ).map((kind) => (
            <DeliverableExportCard
              gate={gates[kind]}
              key={kind}
              kind={kind}
              onExport={(selectedKind) => {
                void handleExport(selectedKind);
              }}
              state={entries[kind]}
            />
          ))}
        </div>
      </div>

      <div className="export-stage__group">
        <div className="export-stage__group-heading">
          <div>
            <p className="export-stage__group-kicker">
              项目记录
            </p>
            <h3>可独立归档</h3>
          </div>
          <p>即使草稿未完成，也可单独导出已有的来源与任务记录。</p>
        </div>
        <div className="export-stage__grid">
          {DELIVERABLE_KINDS.filter(
            (kind) => PRESENTATIONS[kind].group === 'record',
          ).map((kind) => (
            <DeliverableExportCard
              gate={gates[kind]}
              key={kind}
              kind={kind}
              onExport={(selectedKind) => {
                void handleExport(selectedKind);
              }}
              state={entries[kind]}
            />
          ))}
        </div>
      </div>

      <div className="export-stage__group export-stage__group--package">
        <div className="export-stage__group-heading">
          <div>
            <p className="export-stage__group-kicker">
              完整归档
            </p>
            <h3>项目交付包</h3>
          </div>
          <p>适合最终提交、迁移和长期保存。</p>
        </div>
        <DeliverableExportCard
          gate={packageGate}
          kind="project-package"
          onExport={(selectedKind) => {
            void handleExport(selectedKind);
          }}
          state={entries['project-package']}
        />
      </div>
    </section>
  );
}

function ExportReadiness({
  draftCount,
  failedCount,
  notRunCount,
  verificationCount,
  warningCount,
}: Readonly<{
  draftCount: number;
  failedCount: number;
  notRunCount: number;
  verificationCount: number;
  warningCount: number;
}>) {
  const ready =
    draftCount > 0 &&
    verificationCount > 0 &&
    failedCount === 0 &&
    notRunCount === 0;

  return (
    <aside
      aria-labelledby="export-readiness-title"
      className={`export-stage__readiness ${
        ready
          ? 'export-stage__readiness--ready'
          : 'export-stage__readiness--blocked'
      }`}
    >
      <div>
        <p className="export-stage__group-kicker">交付门禁</p>
        <h3 id="export-readiness-title">
          {ready ? '成果文件可以导出' : '成果文件暂不可导出'}
        </h3>
      </div>
      <ul>
        <li>
          {draftCount === 0
            ? '当前没有草稿页面'
            : `当前有 ${draftCount} 个草稿页面`}
        </li>
        <li>
          {verificationCount === 0
            ? '尚无核验记录'
            : failedCount > 0
              ? `核验存在 ${failedCount} 个失败项`
              : notRunCount > 0
                ? `核验仍有 ${notRunCount} 项未运行`
                : `核验无失败项${
                    warningCount > 0
                      ? `，有 ${warningCount} 个提醒`
                      : ''
                  }`}
        </li>
      </ul>
      {!ready ? (
        <p>
          来源索引、任务卡、核验记录和 Project JSON 仍可独立导出。
        </p>
      ) : null}
    </aside>
  );
}

function ExportStatus({
  status,
}: Readonly<{ status: ExportEntryStatus }>) {
  const label: Record<ExportEntryStatus, string> = {
    idle: '未生成',
    exporting: '生成中',
    success: '可下载',
    error: '失败',
  };
  return (
    <span
      aria-live="polite"
      className={`export-stage__status export-stage__status--${status}`}
    >
      {label[status]}
    </span>
  );
}

function ExportMetadata({
  downloadUrl,
  exportedAt,
  result,
}: Readonly<{
  downloadUrl: string;
  exportedAt: string;
  result: DeliverableExportResult;
}>) {
  return (
    <div className="export-stage__metadata">
      <dl>
        <div>
          <dt>文件名</dt>
          <dd>{result.fileName}</dd>
        </div>
        <div>
          <dt>生成时间</dt>
          <dd>
            <time dateTime={exportedAt}>
              {formatExportedAt(exportedAt)}
            </time>
          </dd>
        </div>
        <div>
          <dt>文件大小</dt>
          <dd>{formatExactBytes(result.sizeBytes)}</dd>
        </div>
        <div className="export-stage__digest">
          <dt>SHA-256</dt>
          <dd>
            <code>{result.sha256}</code>
          </dd>
        </div>
      </dl>
      <a
        aria-label={`下载文件：${result.fileName}`}
        className="export-stage__download"
        download={result.fileName}
        href={downloadUrl}
      >
        下载文件
      </a>
    </div>
  );
}

function initialExportEntries(): ExportEntries {
  return Object.fromEntries(
    DELIVERABLE_KINDS.map((kind) => [kind, IDLE_ENTRY]),
  ) as Record<DeliverableKind, ExportEntryState>;
}

function exportEntriesReducer(
  entries: ExportEntries,
  action: ExportEntriesAction,
): ExportEntries {
  if (action.type === 'reset') {
    return initialExportEntries();
  }
  const current = entries[action.kind];
  switch (action.type) {
    case 'start':
      return {
        ...entries,
        [action.kind]: {
          ...current,
          status: 'exporting',
          exportedAt:
            current.result === null
              ? action.exportedAt
              : current.exportedAt,
          error: null,
        },
      };
    case 'success':
      return {
        ...entries,
        [action.kind]: {
          status: 'success',
          exportedAt: action.exportedAt,
          result: action.result,
          downloadUrl: action.downloadUrl,
          error: null,
        },
      };
    case 'failure':
      return {
        ...entries,
        [action.kind]: {
          ...current,
          status: 'error',
          exportedAt:
            current.result === null
              ? action.exportedAt
              : current.exportedAt,
          error: action.error,
        },
      };
  }
}

async function defaultExporter(
  input: DeliverableExportInput,
): Promise<DeliverableExportResult> {
  return exportDeliverable(input);
}

function exportErrorMessage(error: unknown): string {
  if (error instanceof DeliverableExportError) {
    const messages: Record<
      DeliverableExportError['code'],
      string
    > = {
      INVALID_EXPORTED_AT: '导出时间无效，请刷新页面后重试。',
      EMPTY_DRAFT: '当前没有可导出的草稿页面。',
      WEB_CRYPTO_UNAVAILABLE:
        '当前浏览器无法计算 SHA-256，请更换现代浏览器。',
      UNSUPPORTED_PDF_TEXT:
        'PDF 暂不支持当前文本字符，请改用 DOCX 或 Markdown。',
      EXPORT_FAILED: '文件生成失败，请检查项目数据后重试。',
    };
    return messages[error.code];
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return '文件生成失败，请检查项目数据后重试。';
}

function formatExportedAt(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(parsed);
}

function formatExactBytes(value: number): string {
  return `${new Intl.NumberFormat('zh-CN').format(value)} 字节`;
}

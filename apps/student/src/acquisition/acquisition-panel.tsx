import {
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import {
  AcquisitionError,
  type AcquisitionProgress,
  type AcquisitionResult,
} from './acquisition-domain.js';
import type { OcrAcquisitionService } from './ocr-acquisition.js';
import {
  createManualUrlAcquisition,
  type ReaderEndpointConfig,
  type UrlAcquisitionService,
} from './url-acquisition.js';
import './acquisition-panel.css';

export type AcquisitionPanelMode = 'ocr' | 'url';

export interface AcquisitionPanelProps {
  ocrService: OcrAcquisitionService;
  urlService: UrlAcquisitionService;
  onAcquired(
    result: AcquisitionResult,
    originalFile: File | null,
  ): void | Promise<void>;
}

export interface AcquisitionPanelViewProps {
  mode: AcquisitionPanelMode;
  progress: AcquisitionProgress | null;
  result: AcquisitionResult | null;
  error: string | null;
  approvalStatus: 'ready' | 'approving' | 'approved';
  onOcr(
    file: File,
    signal: AbortSignal,
    onProgress: (progress: AcquisitionProgress) => void,
  ): Promise<void>;
  onUrlDirect(
    url: string,
    signal: AbortSignal,
    onProgress: (progress: AcquisitionProgress) => void,
  ): Promise<void>;
  onUrlReader(
    url: string,
    config: ReaderEndpointConfig,
    signal: AbortSignal,
    onProgress: (progress: AcquisitionProgress) => void,
  ): Promise<void>;
  onUrlManual(input: {
    url: string;
    title: string;
    text: string;
  }): Promise<void>;
  onApprove(): Promise<void>;
  onRetry(signal: AbortSignal): Promise<void>;
  onCancel(): void;
}

type RetryAction = (signal: AbortSignal) => Promise<void>;

export function AcquisitionPanel({
  ocrService,
  urlService,
  onAcquired,
}: AcquisitionPanelProps) {
  const [mode, setMode] = useState<AcquisitionPanelMode>('ocr');
  const [progress, setProgress] =
    useState<AcquisitionProgress | null>(null);
  const [result, setResult] = useState<AcquisitionResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const retryRef = useRef<RetryAction | null>(null);

  const run = async (
    action: RetryAction,
    suppliedSignal?: AbortSignal,
  ): Promise<void> => {
    abortRef.current?.abort();
    const abort = new AbortController();
    const forwardAbort = () => abort.abort(suppliedSignal?.reason);
    if (suppliedSignal?.aborted) {
      forwardAbort();
    } else {
      suppliedSignal?.addEventListener('abort', forwardAbort, {
        once: true,
      });
    }
    abortRef.current = abort;
    retryRef.current = action;
    setError(null);
    setResult(null);
    setApproved(false);
    try {
      await action(abort.signal);
    } catch (caught) {
      setError(acquisitionMessage(caught));
    } finally {
      suppliedSignal?.removeEventListener('abort', forwardAbort);
      if (abortRef.current === abort) {
        abortRef.current = null;
        setProgress(null);
      }
    }
  };

  const stageResult = (next: AcquisitionResult): void => {
    setResult(next);
  };

  const approveResult = async (): Promise<void> => {
    if (result === null || approving || approved) {
      return;
    }
    setApproving(true);
    setError(null);
    try {
      await onAcquired(
        result,
        result.kind === 'ocr' ? result.originalFile : null,
      );
      setApproved(true);
    } catch {
      setError('未能加入项目，请确认项目仍可编辑后重试。');
    } finally {
      setApproving(false);
    }
  };

  return (
    <AcquisitionPanelView
      error={error}
      mode={mode}
      progress={progress}
      result={result}
      approvalStatus={
        approved ? 'approved' : approving ? 'approving' : 'ready'
      }
      onApprove={approveResult}
      onCancel={() => abortRef.current?.abort()}
      onOcr={async (file, signal, onProgress) => {
        setMode('ocr');
        await run(async (operationSignal) => {
          const acquired = await ocrService.acquire(
            file,
            operationSignal,
            (next) => {
              setProgress(next);
              onProgress(next);
            },
          );
          stageResult(acquired);
        }, signal);
      }}
      onRetry={async (signal) => {
        const retry = retryRef.current;
        if (retry === null) {
          return;
        }
        await run(retry, signal);
      }}
      onUrlDirect={async (url, signal, onProgress) => {
        setMode('url');
        await run(async (operationSignal) => {
          const acquired = await urlService.acquireDirect(
            url,
            operationSignal,
            (next) => {
              setProgress(next);
              onProgress(next);
            },
          );
          stageResult(acquired);
        }, signal);
      }}
      onUrlManual={async (input) => {
        setMode('url');
        await run(async () => {
          stageResult(await createManualUrlAcquisition(input));
        });
      }}
      onUrlReader={async (url, config, signal, onProgress) => {
        setMode('url');
        await run(async (operationSignal) => {
          const acquired = await urlService.acquireWithReader(
            url,
            config,
            operationSignal,
            (next) => {
              setProgress(next);
              onProgress(next);
            },
          );
          stageResult(acquired);
        }, signal);
      }}
    />
  );
}

export function AcquisitionPanelView({
  mode,
  progress,
  result,
  error,
  approvalStatus,
  onOcr,
  onUrlDirect,
  onUrlReader,
  onUrlManual,
  onApprove,
  onRetry,
  onCancel,
}: AcquisitionPanelViewProps) {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [readerEndpoint, setReaderEndpoint] = useState('');
  const [readerKey, setReaderKey] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [manualText, setManualText] = useState('');
  const busy = progress !== null && progress.phase !== 'complete';

  const emptyProgress = () => undefined;
  const submitDirect = (event: FormEvent): void => {
    event.preventDefault();
    void onUrlDirect(
      url,
      new AbortController().signal,
      emptyProgress,
    );
  };
  const submitReader = (event: FormEvent): void => {
    event.preventDefault();
    void onUrlReader(
      url,
      {
        endpoint: readerEndpoint,
        ...(readerKey.length === 0 ? {} : { apiKey: readerKey }),
      },
      new AbortController().signal,
      emptyProgress,
    );
  };
  const submitManual = (event: FormEvent): void => {
    event.preventDefault();
    void onUrlManual({
      url,
      title: manualTitle,
      text: manualText,
    });
  };

  return (
    <section
      className="acquisition-panel"
      aria-labelledby="acquisition-title"
    >
      <header className="acquisition-panel__header">
        <div>
          <p className="acquisition-panel__eyebrow">材料采集</p>
          <h2 id="acquisition-title">添加扫描件或网页</h2>
          <p>识别文件或读取网页后，检查正文再加入项目。</p>
        </div>
        <div
          aria-label="材料采集方式"
          className="acquisition-panel__modes"
          role="group"
        >
          <span data-active={mode === 'ocr'}>
            图片与扫描 PDF
          </span>
          <span data-active={mode === 'url'}>
            网页 URL
          </span>
        </div>
      </header>

      <div className="acquisition-panel__grid">
        <form
          className="acquisition-panel__card"
          onSubmit={(event) => {
            event.preventDefault();
            if (file !== null) {
              void onOcr(
                file,
                new AbortController().signal,
                emptyProgress,
              );
            }
          }}
        >
          <div>
            <p className="acquisition-panel__eyebrow">文字识别</p>
            <h3>图片与扫描 PDF</h3>
            <p>支持 PNG、JPEG、WebP 或 PDF，识别中英文。</p>
          </div>
          <label>
            <span>选择文件</span>
            <input
              accept=".png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf"
              disabled={busy}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                setFile(event.target.files?.[0] ?? null)
              }
              required
              type="file"
            />
          </label>
          <button
            className="acquisition-panel__primary"
            disabled={busy || file === null}
            type="submit"
          >
            开始识别
          </button>
        </form>

        <div className="acquisition-panel__card">
          <div>
            <p className="acquisition-panel__eyebrow">网页正文</p>
            <h3>网页 URL</h3>
            <p>先直接读取；受网页限制时可使用 Reader 或粘贴正文。</p>
          </div>
          <label>
            <span>网页地址</span>
            <input
              disabled={busy}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/article"
              required
              type="url"
              value={url}
            />
          </label>
          <form onSubmit={submitDirect}>
            <button
              className="acquisition-panel__primary"
              disabled={busy || url.length === 0}
              type="submit"
            >
              直接读取
            </button>
          </form>
          <details>
            <summary>连接 Reader</summary>
            <form
              className="acquisition-panel__subform"
              onSubmit={submitReader}
            >
              <label>
                <span>Reader 地址</span>
                <input
                  disabled={busy}
                  onChange={(event) =>
                    setReaderEndpoint(event.target.value)
                  }
                  placeholder="https://reader.example.com/v1/read"
                  type="url"
                  value={readerEndpoint}
                />
              </label>
              <label>
                <span>访问密钥（可选）</span>
                <input
                  autoComplete="off"
                  disabled={busy}
                  onChange={(event) => setReaderKey(event.target.value)}
                  type="password"
                  value={readerKey}
                />
              </label>
              <button
                disabled={
                  busy ||
                  url.length === 0 ||
                  readerEndpoint.length === 0
                }
                type="submit"
              >
                通过 Reader 读取
              </button>
            </form>
          </details>
          <details>
            <summary>手动粘贴正文</summary>
            <form
              className="acquisition-panel__subform"
              onSubmit={submitManual}
            >
              <label>
                <span>标题</span>
                <input
                  disabled={busy}
                  onChange={(event) =>
                    setManualTitle(event.target.value)
                  }
                  value={manualTitle}
                />
              </label>
              <label>
                <span>原始正文</span>
                <textarea
                  disabled={busy}
                  onChange={(event) =>
                    setManualText(event.target.value)
                  }
                  rows={7}
                  value={manualText}
                />
              </label>
              <button
                disabled={
                  busy ||
                  url.length === 0 ||
                  manualText.trim().length === 0
                }
                type="submit"
              >
                保存粘贴正文
              </button>
            </form>
          </details>
        </div>
      </div>

      {progress !== null ? (
        <section className="acquisition-panel__progress" role="status">
          <div>
            <strong>{progress.message}</strong>
            <span>
              {Math.round(progress.overallProgress * 100)}%
            </span>
          </div>
          <progress
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(
              progress.overallProgress * 100,
            )}
            max={100}
            role="progressbar"
            value={Math.round(progress.overallProgress * 100)}
          />
          {busy ? (
            <button onClick={onCancel} type="button">
              取消
            </button>
          ) : null}
        </section>
      ) : null}

      {error !== null ? (
        <section className="acquisition-panel__error" role="alert">
          <p>{error}</p>
          <button
            onClick={() => {
              if (result === null) {
                void onRetry(new AbortController().signal);
                return;
              }
              void onApprove();
            }}
            type="button"
          >
            {result === null ? '重试' : '重新加入'}
          </button>
        </section>
      ) : null}

      {result !== null ? (
        <AcquisitionResultView
          approvalStatus={approvalStatus}
          onApprove={onApprove}
          result={result}
        />
      ) : null}
    </section>
  );
}

function AcquisitionResultView({
  approvalStatus,
  onApprove,
  result,
}: {
  approvalStatus: 'ready' | 'approving' | 'approved';
  onApprove(): Promise<void>;
  result: AcquisitionResult;
}) {
  return (
    <section className="acquisition-panel__result">
      <header>
        <div>
          <p className="acquisition-panel__eyebrow">读取结果</p>
          <h3>
            {result.kind === 'url' ? result.title : result.fileName}
          </h3>
        </div>
        <code>{result.contentSha256.slice(0, 12)}…</code>
      </header>
      {result.kind === 'ocr' ? (
        <dl className="acquisition-panel__facts">
          <div>
            <dt>页数</dt>
            <dd>{result.pageCount}</dd>
          </div>
          <div>
            <dt>平均置信度</dt>
            <dd>
              {Math.round(
                result.pages.reduce(
                  (total, page) => total + page.confidence,
                  0,
                ) / result.pages.length,
              )}
              %
            </dd>
          </div>
          <div>
            <dt>识别时间</dt>
            <dd>{formatAcquisitionTime(result.acquiredAt)}</dd>
          </div>
        </dl>
      ) : (
        <dl className="acquisition-panel__facts">
          <div>
            <dt>读取方式</dt>
            <dd>
              {result.method === 'direct'
                ? '直接读取'
                : result.method === 'reader'
                  ? 'Reader'
                  : '手动正文'}
            </dd>
          </div>
          <div>
            <dt>读取时间</dt>
            <dd>{formatAcquisitionTime(result.fetchedAt)}</dd>
          </div>
          <div>
            <dt>来源</dt>
            <dd>
              <a
                href={result.sourceUrl}
                rel="noreferrer"
                target="_blank"
              >
                打开原网页
              </a>
            </dd>
          </div>
        </dl>
      )}
      {result.flags.length > 0 ? (
        <div className="acquisition-panel__warning" role="alert">
          <strong>检测到可能影响 AI 判断的外部指令</strong>
          <p>安全视图已作标记；原文仍完整保留。</p>
        </div>
      ) : null}
      <div className="acquisition-panel__text">
        <div>
          <h4>安全视图</h4>
          <pre>{result.safeText}</pre>
        </div>
        <details>
          <summary>查看原文</summary>
          <pre>{result.originalText}</pre>
        </details>
      </div>
      <footer className="acquisition-panel__approval">
        <div>
          <strong>确认正文与来源无误</strong>
          <p>加入后会作为项目材料参与证据与结构整理。</p>
        </div>
        <button
          className="acquisition-panel__primary"
          disabled={approvalStatus !== 'ready'}
          onClick={() => void onApprove()}
          type="button"
        >
          {approvalStatus === 'approved'
            ? '已加入项目'
            : approvalStatus === 'approving'
              ? '正在加入…'
              : '审核后加入项目'}
        </button>
      </footer>
    </section>
  );
}

function acquisitionMessage(error: unknown): string {
  if (!(error instanceof AcquisitionError)) {
    return '材料读取未完成，请重试。';
  }
  const messages: Partial<
    Record<AcquisitionError['code'], string>
  > = {
    UNSAFE_URL: '只支持公开的 HTTPS 网页地址。',
    CORS_OR_NETWORK:
      '网页无法直接读取，请检查 CORS 设置或使用其他方式。',
    HTTP_ERROR: '网页返回错误状态，请检查地址后重试。',
    TIMEOUT: '读取超时，请重试或更换读取方式。',
    CANCELLED: '操作已取消。',
    UNSUPPORTED_RESPONSE: '返回内容无法识别，请使用其他读取方式。',
    RESPONSE_TOO_LARGE: '返回内容过大，已停止读取。',
    OCR_UNAVAILABLE: '文字识别组件加载失败，请刷新后重试。',
    OCR_FAILED: '文字识别未完成，请重试或更换文件。',
    PDF_FAILED: '扫描 PDF 无法读取，请检查文件。',
    EMPTY_CONTENT: '没有读取到可保存的正文。',
  };
  return messages[error.code] ?? error.message;
}

function formatAcquisitionTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
    : '时间未知';
}

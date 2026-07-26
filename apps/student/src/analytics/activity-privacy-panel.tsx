import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from 'react';
import {
  sendPendingProductEvents,
  type ProductEventDeliveryResult,
} from './event-delivery.js';
import type {
  ProductEventLedger,
  ProductEventRecord,
} from './event-ledger.js';
import type { ProductEventName } from './product-event.js';
import './activity-privacy-panel.css';

export interface ActivityPrivacyPanelProps {
  ledger: ProductEventLedger;
  initialEndpoint?: string;
  fetcher?: typeof fetch;
  onEndpointChange?(endpoint: string): void;
  onClose?(): void;
}

type PanelPhase = 'loading' | 'ready' | 'working' | 'error';

const eventLabels: Record<ProductEventName, string> = {
  signup_completed: '完成注册',
  project_created: '创建项目',
  file_uploaded: '添加材料',
  task_defined: '定义任务',
  evidence_added: '添加证据',
  outline_created: '创建结构',
  artifact_generated: '生成交付稿',
  artifact_exported: '导出文件',
  course_completed: '完成课程',
  second_project_started: '开始第二个项目',
};

export function ActivityPrivacyPanel({
  ledger,
  initialEndpoint = '',
  fetcher,
  onEndpointChange,
  onClose,
}: ActivityPrivacyPanelProps) {
  const [records, setRecords] = useState<ProductEventRecord[]>([]);
  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const [phase, setPhase] = useState<PanelPhase>('loading');
  const [message, setMessage] = useState('正在读取活动记录…');
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRecords(await ledger.list());
      setPhase('ready');
      setMessage('');
    } catch {
      setPhase('error');
      setMessage('活动记录暂时无法读取，请稍后重试。');
    }
  }, [ledger]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const summary = useMemo(
    () => ({
      total: records.length,
      pending: records.filter(
        (record) => record.delivery.state === 'pending',
      ).length,
      delivered: records.filter(
        (record) => record.delivery.state === 'delivered',
      ).length,
    }),
    [records],
  );

  function updateEndpoint(event: ChangeEvent<HTMLInputElement>) {
    const value = event.currentTarget.value;
    setEndpoint(value);
    onEndpointChange?.(value);
  }

  async function exportJson(): Promise<void> {
    setPhase('working');
    setMessage('正在准备 JSON 文件…');
    try {
      const json = await ledger.exportJson();
      downloadJson(json);
      setPhase('ready');
      setMessage('活动记录已导出。');
    } catch {
      setPhase('error');
      setMessage('导出失败，请稍后重试。');
    }
  }

  async function sendPending(): Promise<void> {
    setPhase('working');
    setMessage('正在发送待同步记录…');
    try {
      const result = await sendPendingProductEvents({
        ledger,
        endpoint,
        ...(fetcher === undefined ? {} : { fetcher }),
      });
      await refresh();
      setMessage(deliveryMessage(result));
    } catch {
      await refresh();
      setPhase('error');
      setMessage('发送失败，记录仍在待同步列表中。');
    }
  }

  async function clearDelivered(): Promise<void> {
    if (!confirmClear) {
      setConfirmClear(true);
      setMessage('再次点击即可清除已发送记录。');
      return;
    }
    setPhase('working');
    try {
      const count = await ledger.deleteDelivered();
      setConfirmClear(false);
      await refresh();
      setMessage(
        count === 0
          ? '没有可清除的已发送记录。'
          : `已清除 ${String(count)} 条已发送记录。`,
      );
    } catch {
      setPhase('error');
      setMessage('清除失败，请稍后重试。');
    }
  }

  const busy = phase === 'working';

  return (
    <section
      className="activity-panel"
      aria-labelledby="activity-panel-title"
      aria-busy={busy}
    >
      <header className="activity-panel__header">
        <div>
          <p className="activity-panel__eyebrow">设置</p>
          <h2 id="activity-panel-title">活动记录与隐私</h2>
          <p>
            这里记录操作类型、时间和项目标识，不包含任务正文、文件内容或模型密钥。
          </p>
        </div>
        {onClose === undefined ? null : (
          <button
            type="button"
            className="activity-panel__close"
            onClick={onClose}
            aria-label="关闭活动记录"
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </header>

      <div className="activity-panel__summary" aria-label="活动记录概览">
        <SummaryMetric label="全部记录" value={summary.total} />
        <SummaryMetric label="待同步" value={summary.pending} />
        <SummaryMetric label="已发送" value={summary.delivered} />
      </div>

      <div className="activity-panel__layout">
        <section className="activity-panel__history">
          <div className="activity-panel__section-heading">
            <div>
              <h3>最近活动</h3>
              <p>只在操作成功后写入。</p>
            </div>
            <button type="button" onClick={() => void refresh()} disabled={busy}>
              刷新
            </button>
          </div>

          {phase === 'loading' ? (
            <p className="activity-panel__empty">正在读取记录…</p>
          ) : records.length === 0 ? (
            <p className="activity-panel__empty">还没有活动记录。</p>
          ) : (
            <ol className="activity-panel__records">
              {[...records].reverse().slice(0, 20).map((record) => (
                <li key={record.event.id}>
                  <span
                    className="activity-panel__record-mark"
                    data-state={record.delivery.state}
                    aria-hidden="true"
                  />
                  <div>
                    <strong>{eventLabels[record.event.name]}</strong>
                    <p>
                      <time dateTime={record.event.occurredAt}>
                        {formatTime(record.event.occurredAt)}
                      </time>
                      {record.event.projectId === null
                        ? ''
                        : ` · 项目 ${shortIdentity(record.event.projectId)}`}
                    </p>
                  </div>
                  <span className="activity-panel__state">
                    {record.delivery.state === 'delivered'
                      ? '已发送'
                      : '待同步'}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <aside className="activity-panel__controls">
          <section>
            <h3>接收地址</h3>
            <p>需要集中查看时，可填写你或机构提供的 HTTPS 地址。</p>
            <label>
              <span>HTTPS 地址</span>
              <input
                type="url"
                inputMode="url"
                value={endpoint}
                onChange={updateEndpoint}
                placeholder="https://events.example.com/batches"
                autoComplete="url"
              />
            </label>
            <button
              className="activity-panel__primary"
              type="button"
              disabled={busy}
              onClick={() => void sendPending()}
            >
              发送待同步记录
            </button>
          </section>

          <section>
            <h3>管理记录</h3>
            <div className="activity-panel__button-stack">
              <button
                type="button"
                disabled={busy}
                onClick={() => void exportJson()}
              >
                导出 JSON
              </button>
              <button
                type="button"
                disabled={busy}
                data-confirming={confirmClear}
                onClick={() => void clearDelivered()}
              >
                {confirmClear ? '确认清除已发送记录' : '清除已发送记录'}
              </button>
            </div>
          </section>
        </aside>
      </div>

      <div
        className="activity-panel__feedback"
        data-phase={phase}
        aria-live="polite"
        role={phase === 'error' ? 'alert' : 'status'}
      >
        {message}
      </div>
    </section>
  );
}

function SummaryMetric({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div>
      <strong>{String(value).padStart(2, '0')}</strong>
      <span>{label}</span>
    </div>
  );
}

function deliveryMessage(result: ProductEventDeliveryResult): string {
  if (result.status === 'not_configured') {
    return '未填写接收地址，记录没有发送。';
  }
  if (result.status === 'idle') {
    return '没有待同步记录。';
  }
  return `已发送 ${String(result.sent)} 条记录。`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function shortIdentity(value: string): string {
  return value.length <= 12
    ? value
    : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function downloadJson(json: string): void {
  if (
    typeof document === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    throw new Error('Browser download is unavailable');
  }
  const url = URL.createObjectURL(
    new Blob([json], { type: 'application/json;charset=utf-8' }),
  );
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'zuocheng-activity-records.json';
    anchor.rel = 'noopener';
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

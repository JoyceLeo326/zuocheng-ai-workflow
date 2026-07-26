import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  SyncConflictError,
  SyncError,
  type RemoteSyncRecord,
  type SyncAuditEvent,
  type SyncConflict,
} from './sync-domain.js';
import type { SyncController } from './sync-controller.js';
import './sync-center.css';

export interface SyncLocalProjectOption {
  id: string;
  title: string;
  version: number;
  updatedAt: string;
}

export type SyncBusyAction =
  | 'connect'
  | 'refresh'
  | 'push'
  | 'pull'
  | 'flush'
  | 'delete';

export interface SyncCenterViewProps {
  connected: boolean;
  online: boolean;
  busyAction: SyncBusyAction | null;
  error: string | null;
  conflict?: SyncConflict | null;
  localProjects: readonly SyncLocalProjectOption[];
  remoteProjects: readonly RemoteSyncRecord[];
  outboxCount: number;
  auditEvents: readonly SyncAuditEvent[];
  onConnect(token: string, signal: AbortSignal): Promise<void>;
  onDisconnect(): void;
  onRefresh(signal: AbortSignal): Promise<void>;
  onPush(
    projectId: string,
    passphrase: string,
    signal: AbortSignal,
  ): Promise<void>;
  onPull(
    gistId: string,
    passphrase: string,
    signal: AbortSignal,
  ): Promise<void>;
  onOverwriteRemote(
    conflict: SyncConflict,
    passphrase: string,
    signal: AbortSignal,
  ): Promise<void>;
  onOverwriteLocal(
    conflict: SyncConflict,
    passphrase: string,
    signal: AbortSignal,
  ): Promise<void>;
  onFlushOutbox(signal: AbortSignal): Promise<void>;
  onDeleteRemote(
    record: RemoteSyncRecord,
    confirmed: boolean,
    confirmationText: string,
    signal: AbortSignal,
  ): Promise<void>;
  onCancel(): void;
}

export interface SyncCenterProps {
  controller: SyncController;
  localProjects: readonly SyncLocalProjectOption[];
  online: boolean;
  onLocalChange?(): Promise<void> | void;
}

export function SyncCenter({
  controller,
  localProjects,
  online,
  onLocalChange,
}: SyncCenterProps) {
  const [remoteProjects, setRemoteProjects] = useState<
    RemoteSyncRecord[]
  >([]);
  const [auditEvents, setAuditEvents] = useState<SyncAuditEvent[]>([]);
  const [outboxCount, setOutboxCount] = useState(0);
  const [busyAction, setBusyAction] =
    useState<SyncBusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<SyncConflict | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refreshLocalState = async (): Promise<void> => {
    const [outbox, audit] = await Promise.all([
      controller.listOutbox(),
      controller.listAudit(),
    ]);
    setOutboxCount(outbox.length);
    setAuditEvents(audit);
  };

  const refreshRemote = async (signal: AbortSignal): Promise<void> => {
    await refreshLocalState();
    if (!controller.connected || !online) {
      setRemoteProjects([]);
      return;
    }
    setRemoteProjects(await controller.listRemoteProjects(signal));
    await refreshLocalState();
  };

  const run = async (
    action: SyncBusyAction,
    operation: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setBusyAction(action);
    setError(null);
    try {
      await operation(abort.signal);
      setConflict(null);
    } catch (caught) {
      if (caught instanceof SyncConflictError) {
        setConflict(caught.conflict);
        setError(null);
      } else {
        setError(publicErrorMessage(caught));
      }
    } finally {
      if (abortRef.current === abort) {
        abortRef.current = null;
        setBusyAction(null);
      }
      await refreshLocalState().catch(() => undefined);
    }
  };

  useEffect(() => {
    const abort = new AbortController();
    void refreshRemote(abort.signal).catch((caught) => {
      setError(publicErrorMessage(caught));
    });
    return () => {
      abort.abort();
    };
  }, [controller, online]);

  return (
    <SyncCenterView
      auditEvents={auditEvents}
      busyAction={busyAction}
      conflict={conflict}
      connected={controller.connected}
      error={error}
      localProjects={localProjects}
      online={online}
      outboxCount={outboxCount}
      remoteProjects={remoteProjects}
      onCancel={() => {
        abortRef.current?.abort();
      }}
      onConnect={(token) =>
        run('connect', async (signal) => {
          await controller.connect(token, signal);
          await refreshRemote(signal);
        })
      }
      onDeleteRemote={(record, confirmed, text) =>
        run('delete', async (signal) => {
          await controller.deleteRemoteProject({
            record,
            confirmed,
            confirmationText: text,
            signal,
          });
          await refreshRemote(signal);
        })
      }
      onDisconnect={() => {
        controller.disconnect();
        setRemoteProjects([]);
        setConflict(null);
        setError(null);
      }}
      onFlushOutbox={() =>
        run('flush', async (signal) => {
          await controller.flushOutbox(signal);
          await refreshRemote(signal);
        })
      }
      onOverwriteLocal={(current, passphrase) =>
        run('pull', async (signal) => {
          if (current.gistId === null) {
            throw new SyncError(
              'INVALID_INPUT',
              '冲突记录缺少远端项目。',
            );
          }
          await controller.pullProject(
            current.gistId,
            passphrase,
            {
              conflictResolution: 'overwrite-local',
              signal,
            },
          );
          await onLocalChange?.();
          await refreshRemote(signal);
        })
      }
      onOverwriteRemote={(current, passphrase) =>
        run('push', async (signal) => {
          await controller.pushProject(
            current.projectId,
            passphrase,
            {
              conflictResolution: 'overwrite-remote',
              signal,
            },
          );
          await refreshRemote(signal);
        })
      }
      onPull={(gistId, passphrase) =>
        run('pull', async (signal) => {
          await controller.pullProject(gistId, passphrase, {
            signal,
          });
          await onLocalChange?.();
          await refreshRemote(signal);
        })
      }
      onPush={(projectId, passphrase) =>
        run('push', async (signal) => {
          await controller.pushProject(projectId, passphrase, {
            signal,
          });
          await refreshRemote(signal);
        })
      }
      onRefresh={() =>
        run('refresh', (signal) => refreshRemote(signal))
      }
    />
  );
}

export function SyncCenterView({
  connected,
  online,
  busyAction,
  error,
  conflict = null,
  localProjects,
  remoteProjects,
  outboxCount,
  auditEvents,
  onConnect,
  onDisconnect,
  onRefresh,
  onPush,
  onPull,
  onOverwriteRemote,
  onOverwriteLocal,
  onFlushOutbox,
  onDeleteRemote,
  onCancel,
}: SyncCenterViewProps) {
  const [token, setToken] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(
    localProjects[0]?.id ?? '',
  );
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const active = busyAction !== null;
  const selectedProject = useMemo(
    () =>
      localProjects.find(
        (project) => project.id === selectedProjectId,
      ) ?? null,
    [localProjects, selectedProjectId],
  );

  const withAbort = (
    operation: (signal: AbortSignal) => Promise<void>,
  ): void => {
    void operation(new AbortController().signal);
  };

  const submitConnection = (event: FormEvent): void => {
    event.preventDefault();
    withAbort(async (signal) => {
      await onConnect(token, signal);
      setToken('');
    });
  };

  return (
    <section className="sync-center" aria-labelledby="sync-center-title">
      <header className="sync-center__header">
        <div>
          <p className="sync-center__eyebrow">项目接力</p>
          <h2 id="sync-center-title">同步项目</h2>
          <p>连接存储后，可在其他设备继续同一份项目。</p>
        </div>
        <div className="sync-center__status" aria-live="polite">
          <span
            className={
              online
                ? 'sync-center__signal'
                : 'sync-center__signal sync-center__signal--offline'
            }
          >
            {online ? '网络可用' : '当前离线'}
          </span>
          <span>待同步 {outboxCount} 项</span>
        </div>
      </header>

      {!connected ? (
        <form
          className="sync-center__connect"
          onSubmit={submitConnection}
        >
          <div>
            <h3>连接 GitHub</h3>
            <p>填写具有 Gist 读写权限的访问令牌。</p>
          </div>
          <label>
            <span>访问令牌</span>
            <input
              autoComplete="off"
              disabled={active || !online}
              onChange={(event) => setToken(event.target.value)}
              placeholder="github_pat_…"
              required
              type="password"
              value={token}
            />
          </label>
          <button
            className="sync-center__primary"
            disabled={active || !online || token.trim().length < 20}
            type="submit"
          >
            {busyAction === 'connect' ? '正在连接' : '连接存储'}
          </button>
        </form>
      ) : (
        <div className="sync-center__connection">
          <span aria-label="GitHub 已连接">GitHub 已连接</span>
          <button disabled={active} onClick={onDisconnect} type="button">
            断开连接
          </button>
        </div>
      )}

      <div className="sync-center__toolbar">
        <label className="sync-center__passphrase">
          <span>同步口令</span>
          <span className="sync-center__input-row">
            <input
              autoComplete="new-password"
              disabled={active}
              minLength={12}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder="至少 12 个字符"
              type={showPassphrase ? 'text' : 'password'}
              value={passphrase}
            />
            <button
              aria-label={showPassphrase ? '隐藏口令' : '显示口令'}
              aria-pressed={showPassphrase}
              onClick={() => setShowPassphrase((value) => !value)}
              type="button"
            >
              {showPassphrase ? '隐藏' : '显示'}
            </button>
          </span>
          <small>上传与拉取须使用同一口令，请妥善保存。</small>
        </label>

        <div className="sync-center__actions">
          <button
            disabled={active || !connected || !online}
            onClick={() => withAbort(onRefresh)}
            type="button"
          >
            刷新远端
          </button>
          <button
            disabled={
              active ||
              !connected ||
              !online ||
              outboxCount === 0
            }
            onClick={() => withAbort(onFlushOutbox)}
            type="button"
          >
            处理待同步
          </button>
          {active ? (
            <button onClick={onCancel} type="button">
              取消
            </button>
          ) : null}
        </div>
      </div>

      {busyAction !== null ? (
        <p className="sync-center__notice" role="status">
          {busyLabel(busyAction)}
        </p>
      ) : null}
      {error !== null ? (
        <p className="sync-center__notice sync-center__notice--error" role="alert">
          {error}
        </p>
      ) : null}
      {!online ? (
        <p className="sync-center__notice" role="status">
          当前离线。上传会进入待同步队列；拉取和删除将在联网后可用。
        </p>
      ) : null}

      {conflict !== null ? (
        <section className="sync-center__conflict" role="alert">
          <div>
            <p className="sync-center__eyebrow">需要选择</p>
            <h3>发现版本冲突</h3>
            <p>
              此设备第 {conflict.localVersion ?? '—'} 版，远端第{' '}
              {conflict.remoteVersion ?? '—'} 版。覆盖前请确认要保留的内容。
            </p>
          </div>
          <div className="sync-center__conflict-actions">
            <button
              disabled={active || passphrase.length < 12}
              onClick={() =>
                withAbort((signal) =>
                  onOverwriteRemote(conflict, passphrase, signal),
                )
              }
              type="button"
            >
              保留此设备版本
            </button>
            <button
              disabled={
                active ||
                passphrase.length < 12 ||
                conflict.gistId === null
              }
              onClick={() =>
                withAbort((signal) =>
                  onOverwriteLocal(conflict, passphrase, signal),
                )
              }
              type="button"
            >
              使用远端版本
            </button>
          </div>
        </section>
      ) : null}

      <div className="sync-center__grid">
        <section className="sync-center__panel">
          <div className="sync-center__panel-heading">
            <div>
              <p className="sync-center__eyebrow">此设备</p>
              <h3>选择要上传的项目</h3>
            </div>
            <span>{localProjects.length} 个</span>
          </div>
          {localProjects.length === 0 ? (
            <p className="sync-center__empty">还没有可同步的项目。</p>
          ) : (
            <>
              <label>
                <span>项目</span>
                <select
                  disabled={active}
                  onChange={(event) =>
                    setSelectedProjectId(event.target.value)
                  }
                  value={selectedProjectId}
                >
                  {localProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title} · 第 {project.version} 版
                    </option>
                  ))}
                </select>
              </label>
              {selectedProject !== null ? (
                <dl className="sync-center__facts">
                  <div>
                    <dt>当前版本</dt>
                    <dd>第 {selectedProject.version} 版</dd>
                  </div>
                  <div>
                    <dt>最后修改</dt>
                    <dd>{formatTime(selectedProject.updatedAt)}</dd>
                  </div>
                </dl>
              ) : null}
              <button
                className="sync-center__primary"
                disabled={
                  active ||
                  !connected ||
                  selectedProject === null ||
                  passphrase.length < 12
                }
                onClick={() => {
                  if (selectedProject !== null) {
                    withAbort((signal) =>
                      onPush(selectedProject.id, passphrase, signal),
                    );
                  }
                }}
                type="button"
              >
                {online ? '上传当前版本' : '加入待同步'}
              </button>
            </>
          )}
        </section>

        <section className="sync-center__panel">
          <div className="sync-center__panel-heading">
            <div>
              <p className="sync-center__eyebrow">远端存储</p>
              <h3>继续远端项目</h3>
            </div>
            <span>{remoteProjects.length} 个</span>
          </div>
          {remoteProjects.length === 0 ? (
            <p className="sync-center__empty">还没有远端项目。</p>
          ) : (
            <ul className="sync-center__remote-list">
              {remoteProjects.map((remote) => (
                <li key={remote.gistId}>
                  <div className="sync-center__remote-title">
                    <strong>项目 {shortId(remote.projectId)}</strong>
                    <span>第 {remote.projectVersion} 版</span>
                  </div>
                  <p>更新于 {formatTime(remote.projectUpdatedAt)}</p>
                  <div className="sync-center__remote-actions">
                    <button
                      disabled={
                        active ||
                        !online ||
                        passphrase.length < 12
                      }
                      onClick={() =>
                        withAbort((signal) =>
                          onPull(
                            remote.gistId,
                            passphrase,
                            signal,
                          ),
                        )
                      }
                      type="button"
                    >
                      拉取并校验
                    </button>
                    <details>
                      <summary>删除远端副本</summary>
                      <div className="sync-center__delete">
                        <label>
                          <input
                            checked={deleteConfirmed}
                            onChange={(event) =>
                              setDeleteConfirmed(event.target.checked)
                            }
                            type="checkbox"
                          />
                          <span>确认删除远端副本</span>
                        </label>
                        <label>
                          <span>
                            输入“删除远端项目”
                          </span>
                          <input
                            onChange={(event) =>
                              setDeleteText(event.target.value)
                            }
                            value={deleteText}
                          />
                        </label>
                        <button
                          disabled={
                            active ||
                            !online ||
                            !deleteConfirmed ||
                            deleteText !== '删除远端项目'
                          }
                          onClick={() =>
                            withAbort((signal) =>
                              onDeleteRemote(
                                remote,
                                deleteConfirmed,
                                deleteText,
                                signal,
                              ),
                            )
                          }
                          type="button"
                        >
                          删除远端项目
                        </button>
                      </div>
                    </details>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="sync-center__audit" aria-labelledby="sync-audit-title">
        <div className="sync-center__panel-heading">
          <div>
            <p className="sync-center__eyebrow">最近活动</p>
            <h3 id="sync-audit-title">同步记录</h3>
          </div>
        </div>
        {auditEvents.length === 0 ? (
          <p className="sync-center__empty">尚无同步记录。</p>
        ) : (
          <ol>
            {auditEvents.slice(0, 20).map((event) => (
              <li key={event.id}>
                <span className={`sync-center__outcome sync-center__outcome--${event.outcome}`}>
                  {outcomeLabel(event.outcome)}
                </span>
                <div>
                  <p>{event.summary}</p>
                  <time dateTime={event.at}>
                    {formatTime(event.at)}
                  </time>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof SyncError) {
    const messages: Partial<Record<SyncError['code'], string>> = {
      AUTH_FAILED: 'GitHub 连接已失效，请重新连接。',
      FORBIDDEN: '当前访问令牌没有 Gist 读写权限。',
      RATE_LIMITED: 'GitHub 请求次数已达上限，请稍后再试。',
      CANCELLED: '操作已取消。',
      INVALID_PASSPHRASE: '同步口令不正确，无法解密项目。',
      CORRUPT_PAYLOAD: '远端项目校验失败，未导入任何内容。',
      PAYLOAD_TOO_LARGE: '项目包过大，无法完成本次同步。',
      OFFLINE: '当前离线，请联网后重试。',
      CONFIRMATION_REQUIRED: '请完成两步确认后再删除。',
      PROJECT_NOT_FOUND: '找不到要同步的项目。',
      STORAGE_UNAVAILABLE: '无法读取同步记录，请检查浏览器权限。',
      INVALID_RESPONSE: '远端项目数据无效，未导入任何内容。',
      NETWORK: '网络请求未完成，请稍后重试。',
    };
    return messages[error.code] ?? '同步操作未完成，请检查填写内容。';
  }
  return '同步操作未完成，请稍后重试。';
}

function busyLabel(action: SyncBusyAction): string {
  const labels: Record<SyncBusyAction, string> = {
    connect: '正在连接',
    refresh: '正在刷新远端项目',
    push: '正在加密并上传',
    pull: '正在拉取、解密并校验',
    flush: '正在处理待同步项目',
    delete: '正在删除远端项目',
  };
  return labels[action];
}

function outcomeLabel(outcome: SyncAuditEvent['outcome']): string {
  const labels: Record<SyncAuditEvent['outcome'], string> = {
    success: '完成',
    error: '失败',
    conflict: '冲突',
    cancelled: '取消',
    queued: '待同步',
  };
  return labels[outcome];
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
    : '时间未知';
}

function shortId(value: string): string {
  return value.length <= 12
    ? value
    : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

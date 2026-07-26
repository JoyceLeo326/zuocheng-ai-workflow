import type { FormEvent } from 'react';
import type {
  AccountDeletion,
  AccountExport,
  IdentityDevice,
  IdentitySession,
  OAuthProvider,
} from './identity-client.js';

export type AuthenticationMode = 'login' | 'register' | 'recover' | 'reset';

type SubmitHandler = (event: FormEvent<HTMLFormElement>) => void;

export interface AuthenticationPanelProps {
  mode: AuthenticationMode;
  busy: boolean;
  notice: string | null;
  error: string | null;
  onModeChange(mode: AuthenticationMode): void;
  onLogin(input: { identifier: string; password: string }): void;
  onRegister(input: {
    displayName: string;
    email: string;
    password: string;
  }): void;
  onRecoveryRequest(input: { email: string }): void;
  onPasswordReset(input: {
    newPassword: string;
    confirmPassword: string;
  }): void;
  onPasskeyLogin(input: { identifier?: string }): void;
  onOAuth(provider: OAuthProvider): void;
}

function formValue(form: HTMLFormElement, name: string) {
  return String(new FormData(form).get(name) ?? '').trim();
}

function Feedback({
  notice,
  error,
}: {
  notice: string | null;
  error: string | null;
}) {
  return (
    <div className="feedback" aria-live="polite" aria-atomic="true">
      {error === null ? null : (
        <p className="feedback__error" role="alert">
          {error}
        </p>
      )}
      {notice === null ? null : <p className="feedback__notice">{notice}</p>}
    </div>
  );
}

function ProviderButtons({
  busy,
  onOAuth,
}: {
  busy: boolean;
  onOAuth(provider: OAuthProvider): void;
}) {
  return (
    <div className="provider-grid" aria-label="第三方登录">
      {(
        [
          ['google', 'Google'],
          ['github', 'GitHub'],
          ['microsoft', 'Microsoft'],
        ] as const
      ).map(([provider, label]) => (
        <button
          className="button button--provider"
          disabled={busy}
          key={provider}
          onClick={() => {
            onOAuth(provider);
          }}
          type="button"
        >
          <span aria-hidden="true">{label.slice(0, 1)}</span>
          使用 {label}
        </button>
      ))}
    </div>
  );
}

export function AuthenticationPanel({
  mode,
  busy,
  notice,
  error,
  onModeChange,
  onLogin,
  onRegister,
  onRecoveryRequest,
  onPasswordReset,
  onPasskeyLogin,
  onOAuth,
}: AuthenticationPanelProps) {
  const handleLogin: SubmitHandler = (event) => {
    event.preventDefault();
    onLogin({
      identifier: formValue(event.currentTarget, 'identifier'),
      password: formValue(event.currentTarget, 'password'),
    });
  };
  const handleRegister: SubmitHandler = (event) => {
    event.preventDefault();
    onRegister({
      displayName: formValue(event.currentTarget, 'displayName'),
      email: formValue(event.currentTarget, 'email'),
      password: formValue(event.currentTarget, 'password'),
    });
  };
  const handleRecovery: SubmitHandler = (event) => {
    event.preventDefault();
    onRecoveryRequest({ email: formValue(event.currentTarget, 'email') });
  };
  const handlePasswordReset: SubmitHandler = (event) => {
    event.preventDefault();
    onPasswordReset({
      newPassword: formValue(event.currentTarget, 'newPassword'),
      confirmPassword: formValue(event.currentTarget, 'confirmPassword'),
    });
  };

  return (
    <section className="auth-card" aria-labelledby="auth-title">
      <div className="auth-card__intro">
        <p className="eyebrow">做成■ / 正式工作台</p>
        <h1 id="auth-title">
          {mode === 'login'
            ? '登录做成'
            : mode === 'register'
              ? '创建账号'
              : mode === 'recover'
                ? '找回密码'
                : '设置新密码'}
        </h1>
        <p>
          账号、项目与交付保存在正式服务中。会话仅使用安全的 HttpOnly Cookie，
          页面不会保存登录令牌。
        </p>
      </div>

      <nav className="auth-tabs" aria-label="账号操作">
        {(
          [
            ['login', '登录'],
            ['register', '注册'],
            ['recover', '找回密码'],
          ] as const
        ).map(([nextMode, label]) => (
          <button
            aria-current={mode === nextMode ? 'page' : undefined}
            className="auth-tabs__item"
            disabled={busy}
            key={nextMode}
            onClick={() => {
              onModeChange(nextMode);
            }}
            type="button"
          >
            {label}
          </button>
        ))}
      </nav>

      <Feedback error={error} notice={notice} />

      {mode === 'login' ? (
        <>
          <form className="auth-form" onSubmit={handleLogin}>
            <label htmlFor="login-identifier">邮箱或用户名</label>
            <input
              autoCapitalize="none"
              autoComplete="username webauthn"
              disabled={busy}
              id="login-identifier"
              name="identifier"
              required
              spellCheck={false}
              type="text"
            />
            <label htmlFor="login-password">密码</label>
            <input
              autoComplete="current-password"
              disabled={busy}
              id="login-password"
              minLength={12}
              name="password"
              required
              type="password"
            />
            <button className="button button--primary" disabled={busy}>
              {busy ? '正在验证…' : '安全登录'}
            </button>
          </form>
          <button
            className="button button--passkey"
            disabled={busy}
            onClick={() => {
              const input = document.querySelector<HTMLInputElement>(
                '#login-identifier',
              );
              const identifier = input?.value.trim();
              onPasskeyLogin(
                identifier === undefined || identifier.length === 0
                  ? {}
                  : { identifier },
              );
            }}
            type="button"
          >
            使用 Passkey
          </button>
          <div className="divider" role="separator">
            <span>或使用已验证的账号</span>
          </div>
          <ProviderButtons busy={busy} onOAuth={onOAuth} />
        </>
      ) : null}

      {mode === 'register' ? (
        <form className="auth-form" onSubmit={handleRegister}>
          <label htmlFor="register-name">你的名字</label>
          <input
            autoComplete="name"
            disabled={busy}
            id="register-name"
            maxLength={80}
            name="displayName"
            required
          />
          <label htmlFor="register-email">邮箱</label>
          <input
            autoCapitalize="none"
            autoComplete="email"
            disabled={busy}
            id="register-email"
            name="email"
            required
            spellCheck={false}
            type="email"
          />
          <label htmlFor="register-password">设置密码</label>
          <input
            aria-describedby="password-help"
            autoComplete="new-password"
            disabled={busy}
            id="register-password"
            minLength={12}
            name="password"
            required
            type="password"
          />
          <p className="field-help" id="password-help">
            至少 12 个字符。请使用密码管理器生成独立密码。
          </p>
          <label className="check-row">
            <input disabled={busy} name="consent" required type="checkbox" />
            <span>我同意服务条款与隐私说明，并理解邮件验证后才能使用正式工作台。</span>
          </label>
          <button className="button button--primary" disabled={busy}>
            {busy ? '正在创建…' : '创建账号并发送验证邮件'}
          </button>
        </form>
      ) : null}

      {mode === 'recover' ? (
        <form className="auth-form" onSubmit={handleRecovery}>
          <label htmlFor="recover-email">注册邮箱</label>
          <input
            autoCapitalize="none"
            autoComplete="email"
            disabled={busy}
            id="recover-email"
            name="email"
            required
            spellCheck={false}
            type="email"
          />
          <p className="field-help">
            为保护账号，无论邮箱是否存在，页面都会显示相同结果。
          </p>
          <button className="button button--primary" disabled={busy}>
            {busy ? '正在提交…' : '发送真实恢复邮件'}
          </button>
        </form>
      ) : null}

      {mode === 'reset' ? (
        <form className="auth-form" onSubmit={handlePasswordReset}>
          <label htmlFor="reset-password">新密码</label>
          <input
            autoComplete="new-password"
            disabled={busy}
            id="reset-password"
            minLength={12}
            name="newPassword"
            required
            type="password"
          />
          <label htmlFor="reset-password-confirm">再次输入新密码</label>
          <input
            autoComplete="new-password"
            disabled={busy}
            id="reset-password-confirm"
            minLength={12}
            name="confirmPassword"
            required
            type="password"
          />
          <p className="field-help">成功后，所有旧会话都会被撤销。</p>
          <button className="button button--primary" disabled={busy}>
            {busy ? '正在更新…' : '更新密码并撤销旧会话'}
          </button>
        </form>
      ) : null}
    </section>
  );
}

export interface SecurityCenterProps {
  busyAction: string | null;
  error: string | null;
  notice: string | null;
  sessions: IdentitySession[];
  devices: IdentityDevice[];
  accountExport: AccountExport | null;
  accountDeletion: AccountDeletion | null;
  onRegisterPasskey(displayName: string): void;
  onRevokeSession(sessionId: string): void;
  onRevokeOthers(): void;
  onRevokeAll(): void;
  onExport(): void;
  onRequestDeletion(password: string): void;
  onCancelDeletion(): void;
  onConfirmDeletion(): void;
  onLogout(): void;
}

const dateTime = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTime(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : dateTime.format(parsed);
}

export function SecurityCenter({
  busyAction,
  error,
  notice,
  sessions,
  devices,
  accountExport,
  accountDeletion,
  onRegisterPasskey,
  onRevokeSession,
  onRevokeOthers,
  onRevokeAll,
  onExport,
  onRequestDeletion,
  onCancelDeletion,
  onConfirmDeletion,
  onLogout,
}: SecurityCenterProps) {
  const disabled = busyAction !== null;
  const handlePasskey: SubmitHandler = (event) => {
    event.preventDefault();
    onRegisterPasskey(formValue(event.currentTarget, 'displayName'));
  };
  const handleDeletion: SubmitHandler = (event) => {
    event.preventDefault();
    onRequestDeletion(formValue(event.currentTarget, 'password'));
  };

  return (
    <section className="security-center" aria-labelledby="security-title">
      <header className="security-header">
        <div>
          <p className="eyebrow">做成■ / Security</p>
          <h1 id="security-title">账号与设备</h1>
          <p>这里的操作直接作用于正式账号，不使用演示会话或浏览器令牌。</p>
        </div>
        <button
          className="button button--quiet"
          disabled={disabled}
          onClick={onLogout}
          type="button"
        >
          退出登录
        </button>
      </header>

      <Feedback error={error} notice={notice} />

      <div className="security-grid">
        <article className="security-card">
          <span className="card-index">01</span>
          <h2>Passkey</h2>
          <p>使用设备认证器创建抗钓鱼凭据。私钥不会离开你的设备。</p>
          <form className="inline-form" onSubmit={handlePasskey}>
            <label htmlFor="passkey-name">设备名称</label>
            <input
              autoComplete="off"
              disabled={disabled}
              id="passkey-name"
              maxLength={80}
              name="displayName"
              placeholder="例如：个人笔记本"
              required
            />
            <button className="button button--primary" disabled={disabled}>
              添加 Passkey
            </button>
          </form>
        </article>

        <article className="security-card security-card--wide">
          <span className="card-index">02</span>
          <h2>设备与会话</h2>
          {devices.length === 0 ? (
            <p className="empty-state">尚无可展示的设备记录。</p>
          ) : (
            <ul className="device-list">
              {devices.map((device) => (
                <li key={device.id}>
                  <div>
                    <strong>{device.displayName}</strong>
                    <span>
                      {device.platform} · 最近活动 {formatTime(device.lastSeenAt)}
                    </span>
                  </div>
                  {device.current ? <mark>当前设备</mark> : null}
                </li>
              ))}
            </ul>
          )}
          <ul className="session-list" aria-label="活动会话">
            {sessions.map((session) => (
              <li key={session.id}>
                <span>
                  {session.current ? '当前会话' : `会话 ${session.id.slice(-6)}`}
                  {' · '}
                  到期 {formatTime(session.expiresAt)}
                </span>
                {session.current ? null : (
                  <button
                    className="text-action"
                    disabled={disabled}
                    onClick={() => {
                      onRevokeSession(session.id);
                    }}
                    type="button"
                  >
                    撤销此会话
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="action-row">
            <button
              className="button button--quiet"
              disabled={disabled}
              onClick={onRevokeOthers}
              type="button"
            >
              撤销其他会话
            </button>
            <button
              className="button button--danger-outline"
              disabled={disabled}
              onClick={onRevokeAll}
              type="button"
            >
              撤销全部会话
            </button>
          </div>
        </article>

        <article className="security-card">
          <span className="card-index">03</span>
          <h2>数据导出</h2>
          <p>
            导出账号、项目与审计资料的真实归档。密码、会话和 Provider
            密钥永不进入导出包。
          </p>
          {accountExport === null ? null : (
            <div className="job-status" role="status">
              <strong>状态：{accountExport.status}</strong>
              <span>请求于 {formatTime(accountExport.requestedAt)}</span>
              {accountExport.sha256 === null ? null : (
                <code>SHA-256 {accountExport.sha256}</code>
              )}
              {accountExport.downloadUrl === null ? null : (
                <a href={accountExport.downloadUrl}>下载已校验归档</a>
              )}
            </div>
          )}
          <button
            className="button button--primary"
            disabled={disabled}
            onClick={onExport}
            type="button"
          >
            请求真实数据导出
          </button>
        </article>

        <article className="security-card security-card--danger">
          <span className="card-index">04</span>
          <h2>删除账号</h2>
          <p id="deletion-impact">
            该操作会撤销所有会话、Passkey 与已关联账号，并进入项目和对象数据删除流程。
            需要重新验证；进入不可逆阶段后不能取消。
          </p>
          {accountDeletion === null ? (
            <form
              aria-describedby="deletion-impact"
              className="auth-form"
              onSubmit={handleDeletion}
            >
              <label htmlFor="deletion-password">当前密码（用于重新验证）</label>
              <input
                autoComplete="current-password"
                disabled={disabled}
                id="deletion-password"
                name="password"
                required
                type="password"
              />
              <label className="check-row">
                <input
                  disabled={disabled}
                  name="confirmImpact"
                  required
                  type="checkbox"
                />
                <span>我已阅读影响，并要请求删除账号。</span>
              </label>
              <button
                className="button button--danger"
                disabled={disabled}
                type="submit"
              >
                删除账号
              </button>
            </form>
          ) : (
            <div className="job-status" role="status">
              <strong>删除状态：{accountDeletion.status}</strong>
              <span>请求于 {formatTime(accountDeletion.requestedAt)}</span>
              {accountDeletion.status === 'pending' ? (
                <div className="action-row">
                  <button
                    className="button button--quiet"
                    disabled={disabled}
                    onClick={onCancelDeletion}
                    type="button"
                  >
                    取消删除请求
                  </button>
                  <button
                    className="button button--danger"
                    disabled={disabled}
                    onClick={onConfirmDeletion}
                    type="button"
                  >
                    确认进入不可逆阶段
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </article>
      </div>
    </section>
  );
}

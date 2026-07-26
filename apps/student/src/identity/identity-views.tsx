import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
} from 'react';
import type {
  AccountDeletion,
  AccountExport,
  IdentityDevice,
  IdentitySession,
  OAuthProvider,
} from './identity-client.js';
export type AuthenticationMode = 'login' | 'register' | 'recover' | 'reset';
export type IdentityFeedbackKind =
  | 'general'
  | 'offline'
  | 'permission'
  | 'provider-unavailable'
  | 'rate-limit'
  | 'unavailable';

type SubmitHandler = (event: FormEvent<HTMLFormElement>) => void;

export interface AuthenticationPanelProps {
  mode: AuthenticationMode;
  busy: boolean;
  notice: string | null;
  error: string | null;
  errorKind?: IdentityFeedbackKind;
  errorTitle?: string | null;
  offline?: boolean;
  onBack?(): void;
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

function passwordValue(form: HTMLFormElement, name: string) {
  return String(new FormData(form).get(name) ?? '');
}

interface PasswordStrength {
  score: number;
  label: '尚未输入' | '较弱' | '一般' | '较强' | '很强';
  hint: string;
}

export function passwordStrength(password: string): PasswordStrength {
  if (password.length === 0) {
    return {
      score: 0,
      label: '尚未输入',
      hint: '至少 12 个字符；推荐使用密码管理器生成独立密码。',
    };
  }

  let score = 1;
  if (password.length >= 12) {
    score += 1;
  }
  if (password.length >= 20) {
    score += 1;
  }
  if (
    /\d/.test(password) &&
    /[^\p{L}\p{N}\s]/u.test(password)
  ) {
    score += 1;
  }
  score = Math.min(4, score);

  if (score === 1) {
    return {
      score,
      label: '较弱',
      hint: '继续增加长度，并混合不同类型的字符。',
    };
  }
  if (score === 2) {
    return {
      score,
      label: '一般',
      hint: '再增加一些长度会更难被猜中。',
    };
  }
  if (score === 3) {
    return {
      score,
      label: '较强',
      hint: '强度不错；请确保它只用于做成。',
    };
  }
  return {
    score,
    label: '很强',
    hint: '强度良好；请确认它没有在其他服务使用。',
  };
}

function EyeIcon({ visible }: { visible: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      {visible ? (
        <>
          <path d="M3 3 21 21" />
          <path d="M10.6 10.7a2 2 0 0 0 2.7 2.7" />
          <path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c5.5 0 9 5.2 9 8a8.7 8.7 0 0 1-2 3.8M6.4 6.4C4.3 7.9 3 10.3 3 12c0 2.8 3.5 8 9 8 1.4 0 2.7-.3 3.8-.8" />
        </>
      ) : (
        <>
          <path d="M3 12c0-2.8 3.5-8 9-8s9 5.2 9 8-3.5 8-9 8-9-5.2-9-8Z" />
          <circle cx="12" cy="12" r="2.5" />
        </>
      )}
    </svg>
  );
}

interface PasswordFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  id: string;
  label: string;
  showStrength?: boolean;
}

function PasswordField({
  id,
  label,
  showStrength = false,
  'aria-describedby': describedBy,
  ...inputProps
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  const meterId = `${id}-strength-meter`;
  const descriptionId = `${id}-strength-description`;
  const combinedDescription = [
    describedBy,
    showStrength ? descriptionId : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="password-field">
      <div className="password-field__label-row">
        <label htmlFor={id}>{label}</label>
        <button
          aria-controls={id}
          aria-label={visible ? '隐藏密码' : '显示密码'}
          className="password-toggle"
          disabled={inputProps.disabled}
          onClick={() => {
            setVisible((current) => !current);
          }}
          type="button"
        >
          <EyeIcon visible={visible} />
          <span>{visible ? '隐藏密码' : '显示密码'}</span>
        </button>
      </div>
      <input
        {...inputProps}
        aria-describedby={combinedDescription || undefined}
        id={id}
        onInput={(event) => {
          inputProps.onInput?.(event);
          if (!showStrength) {
            return;
          }
          const strength = passwordStrength(event.currentTarget.value);
          const meter = document.querySelector<HTMLElement>(`#${meterId}`);
          const description = document.querySelector<HTMLElement>(
            `#${descriptionId}`,
          );
          meter?.style.setProperty('--password-score', String(strength.score));
          meter?.setAttribute('aria-valuenow', String(strength.score));
          meter?.setAttribute('aria-valuetext', strength.label);
          if (description !== null) {
            description.textContent = `密码强度：${strength.label}。${strength.hint}`;
          }
        }}
        type={visible ? 'text' : 'password'}
      />
      {showStrength ? (
        <div className="password-strength">
          <div
            aria-label="密码强度"
            aria-valuemax={4}
            aria-valuemin={0}
            aria-valuenow={0}
            aria-valuetext="尚未输入"
            className="password-strength__meter"
            id={meterId}
            role="meter"
          >
            <i />
            <i />
            <i />
            <i />
          </div>
          <p
            className="field-help password-strength__description"
            id={descriptionId}
          >
            密码强度：尚未输入。至少 12 个字符；推荐使用密码管理器生成独立密码。
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Feedback({
  notice,
  error,
  errorKind = 'general',
  errorTitle,
  offline = false,
}: {
  notice: string | null;
  error: string | null;
  errorKind?: IdentityFeedbackKind;
  errorTitle?: string | null;
  offline?: boolean;
}) {
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error !== null) {
      errorRef.current?.focus();
    }
  }, [error]);

  return (
    <div
      aria-atomic="true"
      aria-live={offline ? 'assertive' : 'polite'}
      className="feedback"
    >
      {offline ? (
        <div
          className="feedback__message feedback__message--offline"
          data-state="offline"
          role="alert"
        >
          <span className="feedback__symbol" aria-hidden="true">
            !
          </span>
          <div>
            <strong>网络已断开</strong>
            <p>恢复连接后再继续；页面不会把未送达的请求显示为成功。</p>
          </div>
        </div>
      ) : null}
      {error === null ? null : (
        <div
          className="feedback__message feedback__message--error"
          data-state={errorKind}
          ref={errorRef}
          role="alert"
          tabIndex={-1}
        >
          <span className="feedback__symbol" aria-hidden="true">
            {errorKind === 'rate-limit' ? '↻' : '!'}
          </span>
          <div>
            <strong>
              {errorTitle ??
                (errorKind === 'rate-limit'
                  ? '操作冷却中'
                  : errorKind === 'provider-unavailable'
                    ? '登录方式暂不可用'
                    : errorKind === 'permission'
                      ? '没有执行权限'
                      : errorKind === 'offline'
                        ? '无法连接网络'
                        : '操作未完成')}
            </strong>
            <p>{error}</p>
          </div>
        </div>
      )}
      {notice === null ? null : (
        <div className="feedback__message feedback__message--notice" role="status">
          <span className="feedback__symbol" aria-hidden="true">
            ✓
          </span>
          <div>
            <strong>状态已更新</strong>
            <p>{notice}</p>
          </div>
        </div>
      )}
    </div>
  );
}



function ProviderIcon({ provider }: { provider: OAuthProvider }) {
  if (provider === 'google') {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M21 12.2c0-.7-.1-1.4-.2-2H12v3.7h5a4.3 4.3 0 0 1-1.8 2.8v2.4h3c1.8-1.7 2.8-4.1 2.8-6.9Z" fill="#4285f4" />
        <path d="M12 21c2.5 0 4.7-.8 6.2-2.2l-3-2.4c-.8.6-1.9.9-3.2.9a5.5 5.5 0 0 1-5.2-3.8H3.7V16A9.4 9.4 0 0 0 12 21Z" fill="#34a853" />
        <path d="M6.8 13.5a5.7 5.7 0 0 1 0-3.5V7.5H3.7a9.2 9.2 0 0 0 0 8.5l3.1-2.5Z" fill="#fbbc05" />
        <path d="M12 6.2c1.4 0 2.6.5 3.6 1.4l2.7-2.7A9 9 0 0 0 3.7 7.5L6.8 10A5.5 5.5 0 0 1 12 6.2Z" fill="#ea4335" />
      </svg>
    );
  }
  if (provider === 'github') {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path
          d="M12 2.5a9.7 9.7 0 0 0-3.1 18.9c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1 1.6 1 .9 1.6 2.4 1.1 2.9.9.1-.7.4-1.1.7-1.3-2.3-.3-4.6-1.1-4.6-4.8 0-1.1.4-2 1-2.6-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 4.9 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.6.6.7 1 1.5 1 2.6 0 3.7-2.3 4.5-4.6 4.8.4.3.7 1 .7 1.9v2.5c0 .3.2.6.7.5A9.7 9.7 0 0 0 12 2.5Z"
          fill="currentColor"
        />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M3 3h8v8H3z" fill="#f35325" />
      <path d="M13 3h8v8h-8z" fill="#81bc06" />
      <path d="M3 13h8v8H3z" fill="#05a6f0" />
      <path d="M13 13h8v8h-8z" fill="#ffba08" />
    </svg>
  );
}

function PasskeyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="9" cy="9" r="4" />
      <path d="M12 12 21 21M16 16l2-2M18.5 18.5l2-2" />
    </svg>
  );
}

function ProviderButtons({
  busy,
  onOAuth,
}: {
  busy: boolean;
  onOAuth(provider: OAuthProvider): void;
}) {
  const providers = [
    ['google', 'Google'],
    ['github', 'GitHub'],
    ['microsoft', 'Microsoft'],
  ] as const;

  return (
    <div className="provider-grid" aria-label="第三方登录">
      {providers.map(([provider, label]) => (
        <button
          className="button button--provider"
          disabled={busy}
          key={provider}
          onClick={() => {
            onOAuth(provider);
          }}
          type="button"
        >
          <ProviderIcon provider={provider} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

const modeTitles: Record<AuthenticationMode, string> = {
  login: '登录做成',
  register: '创建你的账号',
  recover: '找回密码',
  reset: '设置新密码',
};

const modeDescriptions: Record<AuthenticationMode, string> = {
  login: '登录后继续管理项目、课程与交付记录。',
  register: '创建账号并验证邮箱，让项目、课程与交付记录保持连续。',
  recover: '输入注册邮箱。为保护账号，无论它是否存在，页面都会显示相同结果。',
  reset: '设置一个全新的独立密码。成功后，系统会撤销所有旧会话。',
};

function BrandStory() {
  return (
    <aside className="auth-brand" aria-label="做成学生工作台">
      <div>
        <a className="brand-lockup" href="/" aria-label="做成首页">
          <span aria-hidden="true">■</span>
          <b>做成</b>
          <small>STUDENT OS</small>
        </a>
        <p className="auth-brand__kicker">项目、课程与交付记录</p>
        <h2>
          回到上次的
          <em>工作进度</em>
        </h2>
        <p className="auth-brand__copy">
          在一个账号中查看学习进度、作品项目与交付记录。
        </p>
      </div>

      <ol className="journey-steps" aria-label="账号功能">
        {[
          ['01', '项目进度', '返回最近项目与草稿'],
          ['02', '课程记录', '继续已开始的课程与作业'],
          ['03', '账号安全', '管理登录方式与活动设备'],
        ].map(([index, title, copy]) => (
          <li key={index}>
            <span>{index}</span>
            <div>
              <strong>{title}</strong>
              <small>{copy}</small>
            </div>
          </li>
        ))}
      </ol>

      <div className="trust-strip">
        <span className="trust-strip__pulse" aria-hidden="true" />
        <div>
          <strong>账号安全</strong>
          <small>支持 Passkey 与设备管理</small>
        </div>
      </div>
    </aside>
  );
}

export function AuthenticationPanel({
  mode,
  busy,
  notice,
  error,
  errorKind,
  errorTitle,
  offline = false,
  onBack,
  onModeChange,
  onLogin,
  onRegister,
  onRecoveryRequest,
  onPasswordReset,
  onPasskeyLogin,
  onOAuth,
}: AuthenticationPanelProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const disabled = busy || offline;

  useEffect(() => {
    titleRef.current?.focus();
  }, [mode]);

  const handleLogin: SubmitHandler = (event) => {
    event.preventDefault();
    onLogin({
      identifier: formValue(event.currentTarget, 'identifier'),
      password: passwordValue(event.currentTarget, 'password'),
    });
  };
  const handleRegister: SubmitHandler = (event) => {
    event.preventDefault();
    onRegister({
      displayName: formValue(event.currentTarget, 'displayName'),
      email: formValue(event.currentTarget, 'email'),
      password: passwordValue(event.currentTarget, 'password'),
    });
  };
  const handleRecovery: SubmitHandler = (event) => {
    event.preventDefault();
    onRecoveryRequest({ email: formValue(event.currentTarget, 'email') });
  };
  const handlePasswordReset: SubmitHandler = (event) => {
    event.preventDefault();
    onPasswordReset({
      newPassword: passwordValue(event.currentTarget, 'newPassword'),
      confirmPassword: passwordValue(event.currentTarget, 'confirmPassword'),
    });
  };

  return (
    <section className="auth-layout" aria-labelledby="auth-title">
      <BrandStory />
      <div className="auth-card">
        {onBack === undefined ? null : (
          <button
            className="auth-back"
            disabled={busy}
            onClick={onBack}
            type="button"
          >
            <span aria-hidden="true">←</span>
            返回工作台
          </button>
        )}
        <header className="auth-card__intro">
          <p className="eyebrow">账号</p>
          <h1 id="auth-title" ref={titleRef} tabIndex={-1}>
            {modeTitles[mode]}
          </h1>
          <p>{modeDescriptions[mode]}</p>
        </header>

        <nav className="auth-tabs" aria-label="账号操作">
          {(
            [
              ['login', '登录'],
              ['register', '注册'],
              ['recover', '找回'],
            ] as const
          ).map(([nextMode, label]) => (
            <button
              aria-current={mode === nextMode ? 'page' : undefined}
              className="auth-tabs__item"
              disabled={disabled}
              key={nextMode}
              onClick={() => {
                onModeChange(nextMode);
              }}
              type="button"
            >
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <Feedback
          error={error}
          errorKind={errorKind ?? 'general'}
          errorTitle={errorTitle ?? null}
          notice={notice}
          offline={offline}
        />

        <div
          aria-busy={busy}
          className="auth-form-stage"
          data-mode={mode}
          key={mode}
        >
          {mode === 'login' ? (
            <>
              <form className="auth-form" onSubmit={handleLogin}>
                <div className="field">
                  <label htmlFor="login-identifier">邮箱或用户名</label>
                  <input
                    autoCapitalize="none"
                    autoComplete="username webauthn"
                    disabled={disabled}
                    id="login-identifier"
                    name="identifier"
                    placeholder="name@example.com"
                    required
                    spellCheck={false}
                    type="text"
                  />
                </div>
                <PasswordField
                  autoComplete="current-password"
                  disabled={disabled}
                  id="login-password"
                  label="密码"
                  minLength={12}
                  name="password"
                  placeholder="输入你的密码"
                  required
                />
                <button className="button button--primary" disabled={disabled}>
                  <span>{busy ? '正在登录…' : '登录'}</span>
                  <span aria-hidden="true">↗</span>
                </button>
              </form>
              <button
                className="button button--passkey"
                disabled={disabled}
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
                <PasskeyIcon />
                <span>使用 Passkey 登录</span>
                <small>更快 · 抗钓鱼</small>
              </button>
              <div className="divider" role="separator">
                <span>或使用其他账号</span>
              </div>
              <ProviderButtons busy={disabled} onOAuth={onOAuth} />
            </>
          ) : null}

          {mode === 'register' ? (
            <form className="auth-form" onSubmit={handleRegister}>
              <div className="field">
                <label htmlFor="register-name">你的名字</label>
                <input
                  autoComplete="name"
                  disabled={disabled}
                  id="register-name"
                  maxLength={80}
                  name="displayName"
                  placeholder="工作台中显示的名字"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="register-email">邮箱</label>
                <input
                  autoCapitalize="none"
                  autoComplete="email"
                  disabled={disabled}
                  id="register-email"
                  name="email"
                  placeholder="name@example.com"
                  required
                  spellCheck={false}
                  type="email"
                />
              </div>
              <PasswordField
                autoComplete="new-password"
                disabled={disabled}
                id="register-password"
                label="设置密码"
                minLength={12}
                name="password"
                required
                showStrength
              />
              <label className="check-row">
                <input
                  disabled={disabled}
                  name="consent"
                  required
                  type="checkbox"
                />
                <span>
                  我同意服务条款与隐私说明，并接受必要的邮箱验证。
                </span>
              </label>
              <button className="button button--primary" disabled={disabled}>
                <span>{busy ? '正在创建账号…' : '创建账号并验证邮箱'}</span>
                <span aria-hidden="true">↗</span>
              </button>
            </form>
          ) : null}

          {mode === 'recover' ? (
            <form className="auth-form" onSubmit={handleRecovery}>
              <div className="field">
                <label htmlFor="recover-email">注册邮箱</label>
                <input
                  autoCapitalize="none"
                  autoComplete="email"
                  disabled={disabled}
                  id="recover-email"
                  name="email"
                  placeholder="name@example.com"
                  required
                  spellCheck={false}
                  type="email"
                />
              </div>
              <div className="privacy-note">
                <span aria-hidden="true">◎</span>
                <p>
                  为保护账号，无论邮箱是否存在，页面都会显示相同结果。恢复链接只通过邮件发送。
                </p>
              </div>
              <button className="button button--primary" disabled={disabled}>
                <span>{busy ? '正在安全提交…' : '发送恢复邮件'}</span>
                <span aria-hidden="true">↗</span>
              </button>
            </form>
          ) : null}

          {mode === 'reset' ? (
            <form className="auth-form" onSubmit={handlePasswordReset}>
              <PasswordField
                autoComplete="new-password"
                disabled={disabled}
                id="reset-password"
                label="新密码"
                minLength={12}
                name="newPassword"
                required
                showStrength
              />
              <PasswordField
                autoComplete="new-password"
                disabled={disabled}
                id="reset-password-confirm"
                label="再次输入新密码"
                minLength={12}
                name="confirmPassword"
                required
              />
              <div className="privacy-note">
                <span aria-hidden="true">↻</span>
                <p>密码更新成功后，所有旧会话都会被立即撤销。</p>
              </div>
              <button className="button button--primary" disabled={disabled}>
                <span>{busy ? '正在更新并撤销会话…' : '更新密码'}</span>
                <span aria-hidden="true">↗</span>
              </button>
            </form>
          ) : null}
        </div>

        <footer className="auth-card__footer">
          <span>Passkey</span>
          <span>设备管理</span>
          <span>数据导出</span>
        </footer>
      </div>
    </section>
  );
}

export function IdentityLoadingState() {
  return (
    <div className="auth-layout auth-layout--loading" aria-busy="true">
      <aside className="auth-brand auth-brand--loading">
        <a className="brand-lockup" href="/" aria-label="做成首页">
          <span aria-hidden="true">■</span>
          <b>做成</b>
          <small>STUDENT OS</small>
        </a>
        <div>
          <p className="auth-brand__kicker">从想法到可交付</p>
          <h2>正在打开你的创作现场</h2>
        </div>
        <div className="trust-strip">
          <span className="trust-strip__pulse" aria-hidden="true" />
          <div>
            <strong>正在恢复账号状态</strong>
            <small>请稍候</small>
          </div>
        </div>
      </aside>
      <section className="auth-card skeleton-panel" aria-label="页面加载中">
        <div className="skeleton skeleton--eyebrow" />
        <div className="skeleton skeleton--title" />
        <div className="skeleton skeleton--copy" />
        <div className="skeleton skeleton--tabs" />
        <div className="skeleton skeleton--field" />
        <div className="skeleton skeleton--field" />
        <div className="skeleton skeleton--button" />
        <p className="sr-only" role="status">
          正在恢复账号状态…
        </p>
      </section>
    </div>
  );
}

export interface SecurityCenterProps {
  busyAction: string | null;
  error: string | null;
  notice: string | null;
  errorKind?: IdentityFeedbackKind;
  errorTitle?: string | null;
  offline?: boolean;
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

function exportStatus(status: AccountExport['status']) {
  return {
    pending: ['任务已排队', '等待生成归档。'],
    processing: ['正在生成归档', '正在整理账号、项目与审计资料。'],
    ready: ['归档可以下载', '请在到期前下载，并核对 SHA-256。'],
    failed: ['生成未完成', '没有生成不完整的下载包，请重试。'],
    expired: ['下载已过期', '为了保护数据，旧下载入口已关闭。'],
  }[status];
}

function deletionStatus(status: AccountDeletion['status']) {
  return {
    pending: ['等待邮件确认', '尚未进入不可逆阶段，可在截止前取消。'],
    processing: ['已进入不可逆阶段', '会话正在撤销，项目与对象数据进入删除编排。'],
    cancelled: ['删除请求已取消', '账号与项目保持原状。'],
    completed: ['删除流程已完成', '仅保留必要的非敏感删除证明。'],
    failed: ['删除流程暂停', '请联系支持恢复处理。'],
  }[status];
}

function DeviceGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="3" y="4" width="18" height="13" rx="1" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

export function SecurityCenter({
  busyAction,
  error,
  notice,
  errorKind,
  errorTitle,
  offline = false,
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
  const disabled = busyAction !== null || offline;
  const handlePasskey: SubmitHandler = (event) => {
    event.preventDefault();
    onRegisterPasskey(formValue(event.currentTarget, 'displayName'));
  };
  const handleDeletion: SubmitHandler = (event) => {
    event.preventDefault();
    onRequestDeletion(passwordValue(event.currentTarget, 'password'));
  };
  const activeSessions = sessions.filter((session) => session.revokedAt === null);
  const otherSessions = activeSessions.filter((session) => !session.current);
  const exportCopy =
    accountExport === null ? null : exportStatus(accountExport.status);
  const deletionCopy =
    accountDeletion === null ? null : deletionStatus(accountDeletion.status);

  return (
    <section className="security-center" aria-labelledby="security-title">
      <nav className="security-nav" aria-label="账号导航">
        <a className="brand-lockup" href="/" aria-label="做成首页">
          <span aria-hidden="true">■</span>
          <b>做成</b>
          <small>STUDENT OS</small>
        </a>
        <div className="security-nav__actions">
          <span className="environment-pill">
            <i aria-hidden="true" />
            账号安全
          </span>
          <button
            className="button button--quiet button--compact"
            disabled={disabled}
            onClick={onLogout}
            type="button"
          >
            退出登录
          </button>
        </div>
      </nav>

      <header className="security-header">
        <div>
          <p className="eyebrow">Account command center / 账号控制中心</p>
          <h1 id="security-title">
            你的身份，
            <em>由你掌控。</em>
          </h1>
          <p>
            在账号与设备中心管理登录方式、活动设备、数据导出与账号删除。
          </p>
        </div>
        <div className="security-score" aria-label="安全状态">
          <span className="security-score__ring">
            <b>{activeSessions.length > 0 ? '已连接' : '待确认'}</b>
            <small>账号会话</small>
          </span>
          <div>
            <strong>安全状态</strong>
            <small>{otherSessions.length === 0 ? '未发现异常会话' : `有 ${String(otherSessions.length)} 个其他会话`}</small>
          </div>
        </div>
      </header>

      <div className="security-stats" aria-label="会话防护概览">
        <div>
          <span>设备</span>
          <strong>{String(devices.length)} 台设备</strong>
          <small>{devices.some((device) => device.current) ? '当前设备已识别' : '等待识别当前设备'}</small>
        </div>
        <div>
          <span>会话防护</span>
          <strong>{String(activeSessions.length)} 个活动会话</strong>
          <small>可逐个或全部撤销</small>
        </div>
        <div>
          <span>凭据策略</span>
          <strong>Passkey 就绪</strong>
          <small>私钥仅保留在认证器</small>
        </div>
      </div>

      <Feedback
        error={error}
        errorKind={errorKind ?? 'general'}
        errorTitle={errorTitle ?? null}
        notice={notice}
        offline={offline}
      />

      <div className="security-grid">
        <article
          aria-busy={busyAction === 'register-passkey'}
          className="security-card security-card--passkey"
        >
          <header className="security-card__header">
            <span className="card-index">01 / 登录凭据</span>
            <span className="status-pill status-pill--safe">推荐</span>
          </header>
          <div className="security-card__title">
            <span className="security-card__icon">
              <PasskeyIcon />
            </span>
            <div>
              <h2>添加 Passkey</h2>
              <p>使用面容、指纹或设备解锁完成抗钓鱼登录。</p>
            </div>
          </div>
          <ol className="process-list" aria-label="Passkey 添加过程">
            <li><span>1</span>命名这台设备</li>
            <li><span>2</span>在系统弹窗确认</li>
            <li><span>3</span>凭据由服务端验证</li>
          </ol>
          <form className="inline-form" onSubmit={handlePasskey}>
            <div className="field">
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
            </div>
            <button className="button button--primary" disabled={disabled}>
              {busyAction === 'register-passkey'
                ? '等待认证器确认…'
                : '添加 Passkey'}
            </button>
          </form>
        </article>

        <article
          aria-busy={
            busyAction === 'revoke-session' ||
            busyAction === 'revoke-others' ||
            busyAction === 'revoke-all'
          }
          className="security-card security-card--wide"
        >
          <header className="security-card__header">
            <span className="card-index">02 / 会话防护</span>
            <span className="status-pill">
              {String(activeSessions.length)} 活动
            </span>
          </header>
          <div className="section-heading">
            <div>
              <h2>设备与会话</h2>
              <p>识别每个登录位置，在丢失设备或发现异常时立即撤销。</p>
            </div>
          </div>

          {devices.length === 0 ? (
            <div className="empty-state">
              <span aria-hidden="true">◇</span>
              <div>
                <strong>还没有其他设备</strong>
                <p>在其他设备登录后，设备记录会出现在这里。</p>
              </div>
            </div>
          ) : (
            <ul className="device-list">
              {devices.map((device) => (
                <li key={device.id}>
                  <span className="device-list__icon">
                    <DeviceGlyph />
                  </span>
                  <div className="device-list__body">
                    <div>
                      <strong>{device.displayName}</strong>
                      {device.current ? (
                        <mark className="status-pill status-pill--safe">
                          当前设备
                        </mark>
                      ) : null}
                    </div>
                    <span>
                      {device.platform} · 最近活动 {formatTime(device.lastSeenAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="session-section">
            <h3>活动会话</h3>
            {activeSessions.length === 0 ? (
              <div className="empty-state empty-state--compact">
                <span aria-hidden="true">○</span>
                <div>
                  <strong>当前没有活动会话</strong>
                  <p>重新登录后，受保护会话会显示在这里。</p>
                </div>
              </div>
            ) : (
              <ul className="session-list" aria-label="活动会话">
                {activeSessions.map((session) => (
                  <li key={session.id}>
                    <span className="session-dot" aria-hidden="true" />
                    <div>
                      <strong>
                        {session.current
                          ? '当前浏览器会话'
                          : `会话 …${session.id.slice(-6)}`}
                      </strong>
                      <span>
                        最近活动 {formatTime(session.lastSeenAt)} · 到期{' '}
                        {formatTime(session.expiresAt)}
                      </span>
                    </div>
                    {session.current ? (
                      <span className="text-status">正在使用</span>
                    ) : (
                      <button
                        className="text-action"
                        disabled={disabled}
                        onClick={() => {
                          onRevokeSession(session.id);
                        }}
                        type="button"
                      >
                        撤销
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="action-row">
            <button
              className="button button--quiet"
              disabled={disabled || otherSessions.length === 0}
              onClick={onRevokeOthers}
              type="button"
            >
              撤销其他会话
            </button>
            <button
              className="button button--danger-outline"
              disabled={disabled || activeSessions.length === 0}
              onClick={onRevokeAll}
              type="button"
            >
              撤销全部会话
            </button>
          </div>
        </article>

        <article
          aria-busy={
            busyAction === 'export' ||
            accountExport?.status === 'processing'
          }
          className="security-card security-card--export"
        >
          <header className="security-card__header">
            <span className="card-index">03 / 数据权利</span>
            <span className="status-pill">可验证</span>
          </header>
          <h2>导出你的数据</h2>
          <p>
            生成账号、项目与审计资料的完整归档。密码、会话和 Provider
            密钥永不进入导出包。
          </p>
          <div className="export-visual" aria-hidden="true">
            <span>ACCOUNT</span>
            <span>PROJECTS</span>
            <span>AUDIT</span>
            <i>ZIP + SHA-256</i>
          </div>
          {accountExport === null ? (
            <div className="job-empty">
              <strong>还没有导出任务</strong>
              <span>创建后可在这里查看进度与校验值。</span>
            </div>
          ) : (
            <div className="job-status" data-status={accountExport.status} role="status">
              <span className="job-status__pulse" aria-hidden="true" />
              <div>
                <strong>{exportCopy?.[0]}</strong>
                <p>{exportCopy?.[1]}</p>
                <small>请求于 {formatTime(accountExport.requestedAt)}</small>
              </div>
              {accountExport.sha256 === null ? null : (
                <code>SHA-256 {accountExport.sha256}</code>
              )}
              {accountExport.downloadUrl === null ? null : (
                <a href={accountExport.downloadUrl}>下载已校验归档 ↗</a>
              )}
            </div>
          )}
          <button
            className="button button--primary"
            disabled={disabled}
            onClick={onExport}
            type="button"
          >
            {busyAction === 'export' ? '正在创建导出任务…' : '创建数据导出'}
          </button>
        </article>

        <article
          aria-busy={
            busyAction === 'request-deletion' ||
            busyAction === 'cancel-deletion' ||
            busyAction === 'confirm-deletion'
          }
          className="security-card security-card--danger"
        >
          <header className="security-card__header">
            <span className="card-index">04 / 危险区域</span>
            <span className="status-pill status-pill--danger">需重新验证</span>
          </header>
          <h2>删除账号</h2>
          <p id="deletion-impact">
            该操作会撤销所有会话、Passkey 与已关联账号，并进入项目和对象数据删除流程。
            需要重新验证；进入不可逆阶段后不能取消。
          </p>
          {accountDeletion === null ? (
            <form
              aria-describedby="deletion-impact"
              className="auth-form deletion-form"
              onSubmit={handleDeletion}
            >
              <PasswordField
                autoComplete="current-password"
                disabled={disabled}
                id="deletion-password"
                label="当前密码（用于重新验证）"
                name="password"
                required
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
                {busyAction === 'request-deletion'
                  ? '正在验证并发起…'
                  : '发起删除请求'}
              </button>
            </form>
          ) : (
            <div className="deletion-status" data-status={accountDeletion.status} role="status">
              <ol aria-label="删除流程">
                <li className="is-complete"><span>1</span>请求已创建</li>
                <li className={accountDeletion.status === 'pending' ? 'is-current' : 'is-complete'}><span>2</span>邮件确认</li>
                <li className={accountDeletion.status === 'processing' ? 'is-current' : undefined}><span>3</span>不可逆处理</li>
              </ol>
              <div className="deletion-status__copy">
                <strong>{deletionCopy?.[0]}</strong>
                <p>{deletionCopy?.[1]}</p>
                <small>请求于 {formatTime(accountDeletion.requestedAt)}</small>
              </div>
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

      <footer className="security-footer">
        <span>做成■ 身份控制中心</span>
        <span>账号、设备与数据管理</span>
      </footer>
    </section>
  );
}

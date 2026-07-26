import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthenticationPanel,
  IdentityLoadingState,
  SecurityCenter,
  passwordStrength,
  type AuthenticationPanelProps,
  type SecurityCenterProps,
} from './identity-views.js';

const authProps: AuthenticationPanelProps = {
  mode: 'login',
  busy: false,
  notice: null,
  error: null,
  onModeChange: vi.fn(),
  onLogin: vi.fn(),
  onRegister: vi.fn(),
  onRecoveryRequest: vi.fn(),
  onPasswordReset: vi.fn(),
  onPasskeyLogin: vi.fn(),
  onOAuth: vi.fn(),
};

const securityProps: SecurityCenterProps = {
  busyAction: null,
  error: null,
  notice: null,
  sessions: [
    {
      id: '01900000-0000-7000-8000-000000000003',
      userId: '01900000-0000-7000-8000-000000000002',
      deviceId: '01900000-0000-7000-8000-000000000005',
      createdAt: '2026-07-26T08:00:00.000Z',
      lastSeenAt: '2026-07-26T08:30:00.000Z',
      expiresAt: '2026-08-02T08:00:00.000Z',
      current: true,
      revokedAt: null,
    },
  ],
  devices: [
    {
      id: '01900000-0000-7000-8000-000000000005',
      displayName: 'Firefox on Windows',
      platform: 'Windows',
      lastSeenAt: '2026-07-26T08:30:00.000Z',
      current: true,
    },
  ],
  accountExport: null,
  accountDeletion: null,
  onRegisterPasskey: vi.fn(),
  onRevokeSession: vi.fn(),
  onRevokeOthers: vi.fn(),
  onRevokeAll: vi.fn(),
  onExport: vi.fn(),
  onRequestDeletion: vi.fn(),
  onCancelDeletion: vi.fn(),
  onConfirmDeletion: vi.fn(),
  onLogout: vi.fn(),
};

describe('student identity views', () => {
  it('renders a rich brand narrative and keyboard-operable secure login', () => {
    const html = renderToStaticMarkup(<AuthenticationPanel {...authProps} />);

    expect(html).toContain('从一张空白画布');
    expect(html).toContain('项目不会停在');
    expect(html).toContain('“差不多”');
    expect(html).toContain('安全会话');
    expect(html).toContain('aria-label="登录进度"');
    expect(html).toContain('data-mode="login"');
    expect(html).toContain('登录做成');
    expect(html).toContain('autoComplete="username webauthn"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('aria-controls="login-password"');
    expect(html).toContain('显示密码');
    expect(html).toContain('使用 Passkey');
    expect(html).toContain('Google');
    expect(html).toContain('GitHub');
    expect(html).toContain('Microsoft');
    expect(html.match(/<svg/g)).toHaveLength(5);
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('localStorage');
  });

  it('renders explicit registration with a non-persistent password strength meter and generic recovery states', () => {
    const registration = renderToStaticMarkup(
      <AuthenticationPanel {...authProps} mode="register" />,
    );
    const recovery = renderToStaticMarkup(
      <AuthenticationPanel
        {...authProps}
        mode="recover"
        notice="如果账号存在且邮件服务可用，你会收到恢复邮件。"
      />,
    );
    const reset = renderToStaticMarkup(
      <AuthenticationPanel {...authProps} mode="reset" />,
    );

    expect(registration).toContain('创建账号');
    expect(registration).toContain('autoComplete="name"');
    expect(registration).toContain('autoComplete="new-password"');
    expect(registration).toContain('密码强度');
    expect(registration).toContain('role="meter"');
    expect(registration).toContain('aria-controls="register-password"');
    expect(registration).toContain('我同意');
    expect(recovery).toContain('找回密码');
    expect(recovery).toContain('如果账号存在且邮件服务可用');
    expect(recovery).not.toContain('unknown@example.test');
    expect(reset).toContain('设置新密码');
    expect(reset.match(/autoComplete="new-password"/g)).toHaveLength(2);
    expect(reset.match(/aria-label="显示密码"/g)).toHaveLength(2);
  });

  it('scores password strength without retaining or returning the password', () => {
    expect(passwordStrength('short')).toEqual({
      score: 1,
      label: '较弱',
      hint: '继续增加长度，并混合不同类型的字符。',
    });
    expect(passwordStrength('Correct horse battery staple! 2026')).toEqual({
      score: 4,
      label: '很强',
      hint: '强度良好；请确认它没有在其他服务使用。',
    });
    expect(JSON.stringify(passwordStrength('Unique password value 2026!'))).not.toContain(
      'Unique password value 2026!',
    );
  });

  it('renders an honest offline state that disables identity mutations', () => {
    const html = renderToStaticMarkup(
      <AuthenticationPanel {...authProps} offline />,
    );

    expect(html).toContain('data-state="offline"');
    expect(html).toContain('网络已断开');
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-live="assertive"');
  });

  it('renders a branded skeleton while the real cookie session is checked', () => {
    const html = renderToStaticMarkup(<IdentityLoadingState />);

    expect(html).toContain('正在验证安全会话');
    expect(html).toContain('skeleton');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('从想法到可交付');
  });

  it('renders device/session revocation, passkey, real export state and guarded deletion', () => {
    const html = renderToStaticMarkup(<SecurityCenter {...securityProps} />);

    expect(html).toContain('账号与设备');
    expect(html).toContain('Firefox on Windows');
    expect(html).toContain('当前设备');
    expect(html).toContain('会话防护');
    expect(html).toContain('1 台设备');
    expect(html).toContain('安全状态');
    expect(html).toContain('添加 Passkey');
    expect(html).toContain('撤销其他会话');
    expect(html).toContain('撤销全部会话');
    expect(html).toContain('请求真实数据导出');
    expect(html).toContain('删除账号');
    expect(html).toContain('需要重新验证');
    expect(html).toContain('aria-describedby="deletion-impact"');
  });

  it('renders explicit empty and long-running account lifecycle states', () => {
    const empty = renderToStaticMarkup(
      <SecurityCenter
        {...securityProps}
        devices={[]}
        sessions={[]}
      />,
    );
    const processing = renderToStaticMarkup(
      <SecurityCenter
        {...securityProps}
        accountDeletion={{
          id: 'deletion-1',
          status: 'processing',
          requestedAt: '2026-07-26T08:30:00.000Z',
          cancellableUntil: null,
          irreversibleAt: '2026-07-26T08:31:00.000Z',
          completedAt: null,
        }}
        accountExport={{
          id: 'export-1',
          status: 'processing',
          requestedAt: '2026-07-26T08:30:00.000Z',
          completedAt: null,
          expiresAt: null,
          downloadUrl: null,
          sha256: null,
        }}
        busyAction="export"
      />,
    );

    expect(empty).toContain('还没有其他设备');
    expect(empty).toContain('当前没有活动会话');
    expect(processing).toContain('正在生成归档');
    expect(processing).toContain('已进入不可逆阶段');
    expect(processing).toContain('aria-busy="true"');
  });
});

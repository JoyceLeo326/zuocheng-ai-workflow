import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthenticationPanel,
  SecurityCenter,
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
  it('renders a keyboard-operable password, passkey and three-provider login', () => {
    const html = renderToStaticMarkup(<AuthenticationPanel {...authProps} />);

    expect(html).toContain('登录做成');
    expect(html).toContain('autoComplete="username webauthn"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('使用 Passkey');
    expect(html).toContain('Google');
    expect(html).toContain('GitHub');
    expect(html).toContain('Microsoft');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('localStorage');
  });

  it('renders explicit registration and generic recovery states', () => {
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
    expect(registration).toContain('我同意');
    expect(recovery).toContain('找回密码');
    expect(recovery).toContain('如果账号存在且邮件服务可用');
    expect(recovery).not.toContain('unknown@example.test');
    expect(reset).toContain('设置新密码');
    expect(reset.match(/autoComplete="new-password"/g)).toHaveLength(2);
  });

  it('renders device/session revocation, passkey, real export state and guarded deletion', () => {
    const html = renderToStaticMarkup(<SecurityCenter {...securityProps} />);

    expect(html).toContain('账号与设备');
    expect(html).toContain('Firefox on Windows');
    expect(html).toContain('当前设备');
    expect(html).toContain('添加 Passkey');
    expect(html).toContain('撤销其他会话');
    expect(html).toContain('撤销全部会话');
    expect(html).toContain('请求真实数据导出');
    expect(html).toContain('删除账号');
    expect(html).toContain('需要重新验证');
    expect(html).toContain('aria-describedby="deletion-impact"');
  });
});

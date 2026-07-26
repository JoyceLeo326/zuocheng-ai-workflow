import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IdentityApiError,
  type AccountDeletion,
  type AccountExport,
  type IdentityClient,
  type IdentityDevice,
  type IdentitySession,
  type OAuthProvider,
} from './identity-client.js';
import {
  AuthenticationPanel,
  IdentityLoadingState,
  SecurityCenter,
  type AuthenticationMode,
  type IdentityFeedbackKind,
} from './identity-views.js';
import {
  createPasskeyCredential,
  getPasskeyCredential,
  type JsonCreationOptions,
  type JsonRequestOptions,
} from './webauthn.js';

export interface IdentityLink {
  recoveryToken: string | null;
  deletionRequestId: string | null;
  confirmationToken: string | null;
  verificationCompleted: boolean;
}

const SENSITIVE_LINK_PARAMETERS = [
  'recoveryToken',
  'deletionRequestId',
  'confirmationToken',
] as const;

export function parseIdentityLink(rawUrl: string): IdentityLink {
  const url = new URL(rawUrl);
  return {
    recoveryToken: url.searchParams.get('recoveryToken'),
    deletionRequestId: url.searchParams.get('deletionRequestId'),
    confirmationToken: url.searchParams.get('confirmationToken'),
    verificationCompleted: url.searchParams.get('verified') === '1',
  };
}

export function sanitizedIdentityUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  for (const parameter of SENSITIVE_LINK_PARAMETERS) {
    url.searchParams.delete(parameter);
  }
  const search = url.searchParams.toString();
  return `${url.pathname}${search.length === 0 ? '' : `?${search}`}${url.hash}`;
}

export interface IdentityErrorPresentation {
  kind: IdentityFeedbackKind;
  title: string;
  message: string;
}

export function identityErrorPresentation(
  reason: unknown,
): IdentityErrorPresentation {
  if (reason instanceof IdentityApiError) {
    if (reason.code === 'RATE_LIMITED') {
      return {
        kind: 'rate-limit',
        title: '操作冷却中',
        message:
          reason.retryAfterSeconds === undefined
            ? '请求过于频繁，请稍后重试。'
            : `请求过于频繁，请在 ${String(reason.retryAfterSeconds)} 秒后重试。`,
      };
    }
    if (
      reason.code === 'EMAIL_PROVIDER_UNAVAILABLE' ||
      reason.code === 'MAIL_PROVIDER_UNAVAILABLE'
    ) {
      return {
        kind: 'provider-unavailable',
        title: '邮件服务暂不可用',
        message: '邮件服务暂时无法发送恢复邮件，请稍后重试。',
      };
    }
    if (
      reason.code === 'OAUTH_PROVIDER_UNAVAILABLE' ||
      reason.code === 'IDENTITY_PROVIDER_UNAVAILABLE'
    ) {
      return {
        kind: 'provider-unavailable',
        title: '登录方式暂不可用',
        message: '请稍后重试，或选择其他登录方式。',
      };
    }
    if (reason.code === 'VERIFICATION_TOKEN_INVALID') {
      return {
        kind: 'general',
        title: '验证链接不可用',
        message: '验证链接无效、已过期或已使用，请重新发起。',
      };
    }
    if (reason.code === 'RECENT_AUTH_REQUIRED') {
      return {
        kind: 'permission',
        title: '需要重新验证',
        message: '该操作需要重新验证身份。',
      };
    }
    if (reason.status === 401) {
      return {
        kind: 'permission',
        title: '会话已结束',
        message: '会话已失效，请重新登录。',
      };
    }
    if (reason.status === 403) {
      return {
        kind: 'permission',
        title: '没有执行权限',
        message: '当前账号没有执行此操作的权限。',
      };
    }
    if (reason.status === 404) {
      return {
        kind: 'unavailable',
        title: '账号服务暂不可用',
        message: '当前工作不会受影响，请稍后重试。',
      };
    }
    if (reason.status === 409) {
      return {
        kind: 'general',
        title: '状态已发生变化',
        message: '状态已在其他设备发生变化，页面将重新读取最新结果。',
      };
    }
    if (reason.status === 503) {
      return {
        kind: 'unavailable',
        title: '服务暂不可用',
        message: '账号服务暂时不可用，请稍后重试。',
      };
    }
    return {
      kind: 'general',
      title: '操作未完成',
      message: `操作未完成（${reason.code}）。请按页面提示重试。`,
    };
  }
  if (reason instanceof TypeError) {
    return {
      kind: 'offline',
      title: '无法连接网络',
      message:
        '网络连接失败。请检查网络后重试；未完成的操作不会显示为成功。',
    };
  }
  if (reason instanceof DOMException && reason.name === 'NotAllowedError') {
    return {
      kind: 'permission',
      title: '认证器未授权',
      message: '认证器未授权或操作已取消，没有创建或使用 Passkey。',
    };
  }
  return {
    kind: 'general',
    title: '操作未完成',
    message: '请重试；若问题持续，请记录当前时间并联系支持。',
  };
}

export function identityErrorMessage(reason: unknown) {
  return identityErrorPresentation(reason).message;
}

interface PortalRuntime {
  href: string;
  replaceUrl(url: string): void;
  navigate(url: string): void;
  credentials: CredentialsContainer;
}

export interface IdentityPortalProps {
  client: IdentityClient;
  initialMode?: AuthenticationMode;
  onExit?: () => void;
  runtime?: PortalRuntime;
}

function browserRuntime(): PortalRuntime {
  return {
    href: window.location.href,
    replaceUrl: (url) => {
      window.history.replaceState(null, '', url);
    },
    navigate: (url) => {
      window.location.assign(url);
    },
    credentials: navigator.credentials,
  };
}

function secureExternalUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error('The identity provider returned an unsafe redirect.');
  }
  return url.toString();
}

export function IdentityPortal({
  client,
  initialMode,
  onExit,
  runtime: suppliedRuntime,
}: IdentityPortalProps) {
  const runtime = useMemo(
    () => suppliedRuntime ?? browserRuntime(),
    [suppliedRuntime],
  );
  const [link] = useState(() => parseIdentityLink(runtime.href));
  const [mode, setMode] = useState<AuthenticationMode>(
    link.recoveryToken === null ? (initialMode ?? 'login') : 'reset',
  );
  const [phase, setPhase] = useState<'loading' | 'anonymous' | 'authenticated'>(
    'anonymous',
  );
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] =
    useState<IdentityFeedbackKind>('general');
  const [errorTitle, setErrorTitle] = useState<string | null>(null);
  const [offline, setOffline] = useState(
    () => typeof navigator !== 'undefined' && !navigator.onLine,
  );
  const [notice, setNotice] = useState<string | null>(
    link.verificationCompleted ? '邮箱已经验证，请登录继续。' : null,
  );
  const [sessions, setSessions] = useState<IdentitySession[]>([]);
  const [devices, setDevices] = useState<IdentityDevice[]>([]);
  const [accountExport, setAccountExport] = useState<AccountExport | null>(
    null,
  );
  const [accountDeletion, setAccountDeletion] =
    useState<AccountDeletion | null>(null);

  const perform = useCallback(
    async (name: string, action: () => Promise<void>) => {
      setBusyAction(name);
      setError(null);
      setErrorKind('general');
      setErrorTitle(null);
      setNotice(null);
      if (offline) {
        setErrorKind('offline');
        setErrorTitle('无法连接网络');
        setError(
          '网络已断开。恢复连接后再试；没有请求被标记为成功。',
        );
        setBusyAction(null);
        return;
      }
      try {
        await action();
      } catch (reason) {
        const presentation = identityErrorPresentation(reason);
        setErrorKind(presentation.kind);
        setErrorTitle(presentation.title);
        setError(presentation.message);
      } finally {
        setBusyAction(null);
      }
    },
    [offline],
  );

  const refreshSecurity = useCallback(async () => {
    const deletion = await client.getAccountDeletion().catch((reason: unknown) => {
      if (reason instanceof IdentityApiError && reason.status === 404) {
        return null;
      }
      throw reason;
    });
    const [nextSessions, nextDevices] = await Promise.all([
      client.listSessions(),
      client.listDevices(),
    ]);
    setSessions(nextSessions);
    setDevices(nextDevices);
    setAccountDeletion(deletion);
  }, [client]);

  useEffect(() => {
    const updateConnectivity = () => {
      setOffline(!navigator.onLine);
    };
    window.addEventListener('online', updateConnectivity);
    window.addEventListener('offline', updateConnectivity);
    return () => {
      window.removeEventListener('online', updateConnectivity);
      window.removeEventListener('offline', updateConnectivity);
    };
  }, []);

  useEffect(() => {
    runtime.replaceUrl(sanitizedIdentityUrl(runtime.href));
    let active = true;
    void client
      .getCurrentSession()
      .then(async () => {
        if (!active) {
          return;
        }
        await refreshSecurity();
        if (active) {
          setPhase('authenticated');
        }
      })
      .catch((reason: unknown) => {
        if (!active) {
          return;
        }
        if (reason instanceof IdentityApiError && reason.status === 401) {
          setPhase('anonymous');
          return;
        }
        setPhase('anonymous');
        const presentation = identityErrorPresentation(reason);
        setErrorKind(presentation.kind);
        setErrorTitle(presentation.title);
        setError(presentation.message);
      });
    return () => {
      active = false;
    };
  }, [client, refreshSecurity, runtime]);

  useEffect(() => {
    if (
      accountExport === null ||
      !['pending', 'processing'].includes(accountExport.status)
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void client
        .getAccountExport(accountExport.id)
        .then(setAccountExport)
        .catch((reason: unknown) => {
          const presentation = identityErrorPresentation(reason);
          setErrorKind(presentation.kind);
          setErrorTitle(presentation.title);
          setError(presentation.message);
        });
    }, 5_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [accountExport, client]);

  const authenticated = () => {
    setPhase('authenticated');
    return refreshSecurity();
  };

  if (phase === 'loading') {
    return (
      <main className="identity-shell" id="main-content">
        <IdentityLoadingState />
      </main>
    );
  }

  if (phase === 'anonymous') {
    return (
      <main className="identity-shell identity-shell--auth" id="main-content">
        <AuthenticationPanel
          {...(onExit === undefined ? {} : { onBack: onExit })}
          busy={busyAction !== null}
          error={error}
          errorKind={errorKind}
          errorTitle={errorTitle}
          mode={mode}
          notice={notice}
          offline={offline}
          onLogin={(input) => {
            void perform('login', async () => {
              await client.loginPassword(input);
              await authenticated();
            });
          }}
          onModeChange={(nextMode) => {
            setMode(nextMode);
            setError(null);
            setErrorKind('general');
            setErrorTitle(null);
            setNotice(null);
          }}
          onOAuth={(provider: OAuthProvider) => {
            void perform(`oauth-${provider}`, async () => {
              const result = await client.startOAuth(provider, {
                returnTo: '/account/security',
              });
              runtime.navigate(secureExternalUrl(result.authorizationUrl));
            });
          }}
          onPasskeyLogin={(input) => {
            void perform('passkey-login', async () => {
              const options =
                await client.createPasskeyAuthenticationOptions(input);
              const response = await getPasskeyCredential(
                options.publicKey as unknown as JsonRequestOptions,
                runtime.credentials,
              );
              await client.verifyPasskeyAuthentication({
                challengeId: options.challengeId,
                response,
              });
              await authenticated();
            });
          }}
          onPasswordReset={(input) => {
            void perform('password-reset', async () => {
              if (link.recoveryToken === null) {
                throw new Error('The recovery proof is missing.');
              }
              if (input.newPassword !== input.confirmPassword) {
                throw new Error('The passwords do not match.');
              }
              await client.completePasswordRecovery({
                token: link.recoveryToken,
                newPassword: input.newPassword,
              });
              setMode('login');
              setNotice('密码已更新，旧会话已撤销。请重新登录。');
            });
          }}
          onRecoveryRequest={(input) => {
            void perform('recovery', async () => {
              await client.requestPasswordRecovery(input);
              setNotice('如果账号存在且邮件服务可用，你会收到恢复邮件。');
            });
          }}
          onRegister={(input) => {
            void perform('register', async () => {
              await client.registerPassword(input);
              setNotice('验证邮件已发送，请从邮件链接完成验证。');
            });
          }}
        />
      </main>
    );
  }

  return (
    <main className="identity-shell" id="main-content">
      <SecurityCenter
        accountDeletion={accountDeletion}
        accountExport={accountExport}
        busyAction={busyAction}
        devices={devices}
        error={error}
        errorKind={errorKind}
        errorTitle={errorTitle}
        notice={notice}
        offline={offline}
        onCancelDeletion={() => {
          void perform('cancel-deletion', async () => {
            setAccountDeletion(await client.cancelAccountDeletion());
            setNotice('删除请求已在不可逆阶段前取消。');
          });
        }}
        onConfirmDeletion={() => {
          void perform('confirm-deletion', async () => {
            if (
              link.deletionRequestId === null ||
              link.confirmationToken === null
            ) {
              throw new Error('The deletion confirmation proof is missing.');
            }
            setAccountDeletion(
              await client.confirmAccountDeletion({
                deletionRequestId: link.deletionRequestId,
                confirmationToken: link.confirmationToken,
              }),
            );
            setNotice('删除流程已进入不可逆阶段，所有会话正在撤销。');
          });
        }}
        onExport={() => {
          void perform('export', async () => {
            setAccountExport(await client.requestAccountExport());
            setNotice('导出任务已创建；完成后将显示哈希与下载入口。');
          });
        }}
        onLogout={() => {
          void perform('logout', async () => {
            await client.logout();
            setSessions([]);
            setDevices([]);
            setPhase('anonymous');
            setNotice('已退出当前设备。');
          });
        }}
        onRegisterPasskey={(displayName) => {
          void perform('register-passkey', async () => {
            const options = await client.createPasskeyRegistrationOptions({
              displayName,
            });
            const response = await createPasskeyCredential(
              options.publicKey as unknown as JsonCreationOptions,
              runtime.credentials,
            );
            await client.verifyPasskeyRegistration({
              challengeId: options.challengeId,
              displayName,
              response,
            });
            setNotice('Passkey 已由认证器验证并保存。');
          });
        }}
        onRequestDeletion={(password) => {
          void perform('request-deletion', async () => {
            const recent = await client.verifyRecentPassword({ password });
            const result = await client.requestAccountDeletion({
              recentAuthToken: recent.recentAuthToken,
            });
            setAccountDeletion(result.deletion);
            setNotice('确认邮件已发送；请从邮件链接继续或在截止前取消。');
          });
        }}
        onRevokeAll={() => {
          void perform('revoke-all', async () => {
            await client.revokeAllSessions();
            setSessions([]);
            setDevices([]);
            setPhase('anonymous');
            setNotice('全部会话已撤销，请重新登录。');
          });
        }}
        onRevokeOthers={() => {
          void perform('revoke-others', async () => {
            await client.revokeOtherSessions();
            await refreshSecurity();
            setNotice('其他设备的会话已撤销。');
          });
        }}
        onRevokeSession={(sessionId) => {
          void perform('revoke-session', async () => {
            await client.revokeSession(sessionId);
            await refreshSecurity();
            setNotice('指定会话已撤销。');
          });
        }}
        sessions={sessions}
      />
    </main>
  );
}

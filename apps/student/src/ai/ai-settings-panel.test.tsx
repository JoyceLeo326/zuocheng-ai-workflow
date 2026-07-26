/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  BYOKCredentialPersistence,
  BYOKCredentialStore,
} from './byok-credential-store.js';
import {
  AISettingsPanel,
  createAISettingsActions,
  type AISettingsFeedback,
  type AISettingsPanelProps,
} from './ai-settings-panel.js';

const panelStyles = readFileSync(
  new URL('./ai-settings-panel.css', import.meta.url),
  'utf8',
);

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function credentialStore(
  initial: Readonly<{
    apiKey: string;
    persistence: BYOKCredentialPersistence;
  }> | null = null,
): BYOKCredentialStore {
  let credential = initial;
  return {
    save: vi.fn((input) => {
      credential = {
        apiKey: input.apiKey,
        persistence: input.persistence ?? 'session',
      };
    }),
    resolve: vi.fn(() => credential?.apiKey ?? null),
    has: vi.fn(() => credential !== null),
    persistenceOf: vi.fn(() => credential?.persistence ?? null),
    remove: vi.fn(() => {
      credential = null;
    }),
  };
}

function props(
  overrides: Partial<AISettingsPanelProps> = {},
): AISettingsPanelProps {
  return {
    providerId: 'personal-openai-compatible',
    displayName: '我的模型',
    credentials: credentialStore(),
    initialEndpoint: 'https://models.example.test/v1',
    initialModel: 'example-chat',
    onSaveConfig: vi.fn(async () => undefined),
    onDeleteConfig: vi.fn(async () => undefined),
    onTestConnection: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('AISettingsPanel', () => {
  it('renders a keyboard-native, masked BYOK form without exposing a stored key', () => {
    const storedKey = 'sk-stored-must-not-render';
    const html = renderToStaticMarkup(
      <AISettingsPanel
        {...props({
          credentials: credentialStore({
            apiKey: storedKey,
            persistence: 'local',
          }),
        })}
      />,
    );

    expect(html).toContain('连接你自己的模型');
    expect(html).toContain('请求会从此浏览器直接发送到你填写的模型地址');
    expect(html).toContain('模型地址');
    expect(html).toContain('模型名称');
    expect(html).toContain('API 密钥');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('aria-label="显示密钥"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('仅本次使用');
    expect(html).toContain('保存在此设备');
    expect(html).toMatch(
      /<input[^>]+type="radio"[^>]+name="persistence"[^>]+checked=""[^>]+value="local"/,
    );
    expect(html).toContain('测试连接');
    expect(html).toContain('保存设置');
    expect(html).toContain('删除连接');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain(storedKey);
    expect(html).not.toMatch(/项目所有者|成本|内部架构|服务端代理|Vercel/);
  });

  it('does not persist a draft key while a real injected connection test is pending', async () => {
    const gate = deferred();
    const credentials = credentialStore();
    const onTestConnection = vi.fn(() => gate.promise);
    const feedback: AISettingsFeedback[] = [];
    const actions = createAISettingsActions({
      providerId: 'personal-openai-compatible',
      displayName: '我的模型',
      credentials,
      onSaveConfig: vi.fn(),
      onDeleteConfig: vi.fn(),
      onTestConnection,
    });

    const operation = actions.testConnection(
      {
        endpoint: 'https://models.example.test/v1',
        model: 'example-chat',
        apiKey: 'sk-draft-only',
        persistence: 'session',
      },
      (next) => {
        feedback.push(next);
      },
    );

    await vi.waitFor(() => {
      expect(onTestConnection).toHaveBeenCalledTimes(1);
    });
    expect(feedback.at(-1)).toEqual({
      kind: 'pending',
      message: '正在测试连接…',
    });
    expect(credentials.save).not.toHaveBeenCalled();
    expect(credentials.resolve('personal-openai-compatible')).toBeNull();

    gate.resolve();
    await operation;

    expect(onTestConnection).toHaveBeenCalledWith({
      providerId: 'personal-openai-compatible',
      displayName: '我的模型',
      endpoint: 'https://models.example.test/v1',
      model: 'example-chat',
      apiKey: 'sk-draft-only',
    });
    expect(feedback.at(-1)).toEqual({
      kind: 'success',
      message: '连接成功，可以使用这个模型。',
    });
    expect(credentials.save).not.toHaveBeenCalled();
  });

  it('uses an already saved key for testing and reports a safe error after awaiting rejection', async () => {
    const leakedMessage = 'provider echoed sk-do-not-show';
    const gate = deferred();
    const onTestConnection = vi.fn(() => gate.promise);
    const feedback: AISettingsFeedback[] = [];
    const actions = createAISettingsActions({
      providerId: 'personal-openai-compatible',
      displayName: '我的模型',
      credentials: credentialStore({
        apiKey: 'sk-saved',
        persistence: 'session',
      }),
      onSaveConfig: vi.fn(),
      onDeleteConfig: vi.fn(),
      onTestConnection,
    });

    const operation = actions.testConnection(
      {
        endpoint: 'https://models.example.test/v1',
        model: 'example-chat',
        apiKey: '',
        persistence: 'session',
      },
      (next) => {
        feedback.push(next);
      },
    );
    gate.reject(new Error(leakedMessage));
    await operation;

    expect(onTestConnection).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-saved' }),
    );
    expect(feedback.at(-1)).toEqual({
      kind: 'error',
      message: '连接失败，请检查模型地址、模型名称和密钥。',
    });
    expect(JSON.stringify(feedback)).not.toContain(leakedMessage);
    expect(JSON.stringify(feedback)).not.toContain('sk-saved');
  });

  it('persists only on explicit save and keeps the key out of provider config', async () => {
    const gate = deferred();
    const credentials = credentialStore();
    const onSaveConfig = vi.fn(() => gate.promise);
    const actions = createAISettingsActions({
      providerId: 'personal-openai-compatible',
      displayName: '我的模型',
      credentials,
      onSaveConfig,
      onDeleteConfig: vi.fn(),
      onTestConnection: vi.fn(),
    });

    const operation = actions.save({
      endpoint: 'https://models.example.test/v1',
      model: 'example-chat',
      apiKey: 'sk-explicit-save',
      persistence: 'local',
    });

    await vi.waitFor(() => {
      expect(onSaveConfig).toHaveBeenCalledTimes(1);
    });
    expect(onSaveConfig).toHaveBeenCalledWith({
      providerId: 'personal-openai-compatible',
      displayName: '我的模型',
      endpoint: 'https://models.example.test/v1',
      model: 'example-chat',
    });
    expect(JSON.stringify(onSaveConfig.mock.calls)).not.toContain(
      'sk-explicit-save',
    );
    expect(credentials.save).not.toHaveBeenCalled();

    gate.resolve();
    await expect(operation).resolves.toBeUndefined();
    expect(credentials.save).toHaveBeenCalledWith({
      providerId: 'personal-openai-compatible',
      apiKey: 'sk-explicit-save',
      persistence: 'local',
    });
  });

  it('deletes the credential and then awaits injected config deletion', async () => {
    const gate = deferred();
    const credentials = credentialStore({
      apiKey: 'sk-delete',
      persistence: 'local',
    });
    const onDeleteConfig = vi.fn(() => gate.promise);
    const actions = createAISettingsActions({
      providerId: 'personal-openai-compatible',
      displayName: '我的模型',
      credentials,
      onSaveConfig: vi.fn(),
      onDeleteConfig,
      onTestConnection: vi.fn(),
    });

    const operation = actions.remove();
    expect(credentials.remove).toHaveBeenCalledWith(
      'personal-openai-compatible',
    );
    expect(onDeleteConfig).toHaveBeenCalledTimes(1);

    let settled = false;
    void operation.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    await operation;
    expect(settled).toBe(true);
    expect(credentials.resolve('personal-openai-compatible')).toBeNull();
  });

  it('rejects insecure or credential-bearing endpoints before invoking callbacks', async () => {
    const onTestConnection = vi.fn();
    const feedback: AISettingsFeedback[] = [];
    const actions = createAISettingsActions({
      providerId: 'personal-openai-compatible',
      displayName: '我的模型',
      credentials: credentialStore(),
      onSaveConfig: vi.fn(),
      onDeleteConfig: vi.fn(),
      onTestConnection,
    });

    await actions.testConnection(
      {
        endpoint: 'http://models.example.test/v1?api_key=leak',
        model: 'example-chat',
        apiKey: 'sk-draft',
        persistence: 'session',
      },
      (next) => {
        feedback.push(next);
      },
    );

    expect(onTestConnection).not.toHaveBeenCalled();
    expect(feedback.at(-1)?.kind).toBe('error');
    expect(JSON.stringify(feedback)).not.toContain('api_key');
    expect(JSON.stringify(feedback)).not.toContain('sk-draft');
  });

  it('ships visible focus, narrow-screen, reduced-motion and forced-color rules', () => {
    expect(panelStyles).toContain(':focus-visible');
    expect(panelStyles).toMatch(/@media\s+\(max-width:\s*40rem\)/);
    expect(panelStyles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(panelStyles).toContain('@media (forced-colors: active)');
    expect(panelStyles).toContain('ButtonText');
    expect(panelStyles).toContain('CanvasText');
  });
});

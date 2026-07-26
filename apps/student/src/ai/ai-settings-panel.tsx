import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type {
  BYOKCredentialPersistence,
  BYOKCredentialStore,
} from './byok-credential-store.js';
import { createOpenAICompatibleProvider } from './openai-compatible-provider.js';
import './ai-settings-panel.css';

export type AISettingsProviderConfig = Readonly<{
  providerId: string;
  displayName: string;
  endpoint: string;
  model: string;
}>;

export type AISettingsConnectionInput =
  AISettingsProviderConfig &
    Readonly<{
      apiKey: string;
    }>;

export type AISettingsFormInput = Readonly<{
  endpoint: string;
  model: string;
  apiKey: string;
  persistence: BYOKCredentialPersistence;
}>;

export type AISettingsFeedback = Readonly<{
  kind: 'idle' | 'pending' | 'success' | 'error';
  message: string;
}>;

export interface AISettingsActionDependencies {
  providerId: string;
  displayName: string;
  credentials: Pick<
    BYOKCredentialStore,
    'save' | 'resolve' | 'remove'
  >;
  onSaveConfig(config: AISettingsProviderConfig): void | Promise<void>;
  onDeleteConfig(): void | Promise<void>;
  onTestConnection(
    input: AISettingsConnectionInput,
  ): void | Promise<void>;
}

export interface AISettingsActions {
  save(input: AISettingsFormInput): Promise<void>;
  remove(): Promise<void>;
  testConnection(
    input: AISettingsFormInput,
    report: (feedback: AISettingsFeedback) => void,
  ): Promise<void>;
}

export interface AISettingsPanelProps
  extends AISettingsActionDependencies {
  credentials: BYOKCredentialStore;
  initialEndpoint?: string;
  initialModel?: string;
}

const IDLE_FEEDBACK: AISettingsFeedback = Object.freeze({
  kind: 'idle',
  message: '',
});

const TEST_PENDING_FEEDBACK: AISettingsFeedback = Object.freeze({
  kind: 'pending',
  message: '正在测试连接…',
});

const TEST_SUCCESS_FEEDBACK: AISettingsFeedback = Object.freeze({
  kind: 'success',
  message: '连接成功，可以使用这个模型。',
});

const TEST_ERROR_FEEDBACK: AISettingsFeedback = Object.freeze({
  kind: 'error',
  message: '连接失败，请检查模型地址、模型名称和密钥。',
});

export function createAISettingsActions(
  dependencies: AISettingsActionDependencies,
): AISettingsActions {
  return Object.freeze({
    async save(input: AISettingsFormInput): Promise<void> {
      const config = providerConfigAt(dependencies, input);
      const apiKey = credentialAt(
        input.apiKey,
        dependencies.providerId,
        dependencies.credentials,
      );

      await dependencies.onSaveConfig(config);
      dependencies.credentials.save({
        providerId: dependencies.providerId,
        apiKey,
        persistence: input.persistence,
      });
    },

    async remove(): Promise<void> {
      dependencies.credentials.remove(dependencies.providerId);
      await dependencies.onDeleteConfig();
    },

    async testConnection(
      input: AISettingsFormInput,
      report: (feedback: AISettingsFeedback) => void,
    ): Promise<void> {
      report(TEST_PENDING_FEEDBACK);
      try {
        const config = providerConfigAt(dependencies, input);
        const apiKey = credentialAt(
          input.apiKey,
          dependencies.providerId,
          dependencies.credentials,
        );
        await dependencies.onTestConnection(
          Object.freeze({ ...config, apiKey }),
        );
        report(TEST_SUCCESS_FEEDBACK);
      } catch {
        report(TEST_ERROR_FEEDBACK);
      }
    },
  });
}

export function AISettingsPanel({
  providerId,
  displayName,
  credentials,
  initialEndpoint = '',
  initialModel = '',
  onSaveConfig,
  onDeleteConfig,
  onTestConnection,
}: AISettingsPanelProps) {
  const fieldId = useId();
  const titleId = `${fieldId}-title`;
  const endpointId = `${fieldId}-endpoint`;
  const endpointHelpId = `${fieldId}-endpoint-help`;
  const modelId = `${fieldId}-model`;
  const keyId = `${fieldId}-key`;
  const keyHelpId = `${fieldId}-key-help`;
  const [initialCredentialState] = useState(() =>
    credentialStateAt(credentials, providerId),
  );
  const [endpoint, setEndpoint] = useState(initialEndpoint);
  const [model, setModel] = useState(initialModel);
  const [apiKey, setApiKey] = useState('');
  const [persistence, setPersistence] =
    useState<BYOKCredentialPersistence>(
      initialCredentialState.persistence ?? 'session',
    );
  const [hasSavedCredential, setHasSavedCredential] = useState(
    initialCredentialState.hasCredential,
  );
  const [keyVisible, setKeyVisible] = useState(false);
  const [busyAction, setBusyAction] = useState<
    'save' | 'delete' | 'test' | null
  >(null);
  const [feedback, setFeedback] =
    useState<AISettingsFeedback>(IDLE_FEEDBACK);
  const errorRef = useRef<HTMLDivElement>(null);

  const actions = createAISettingsActions({
    providerId,
    displayName,
    credentials,
    onSaveConfig,
    onDeleteConfig,
    onTestConnection,
  });
  const formInput = (): AISettingsFormInput => ({
    endpoint,
    model,
    apiKey,
    persistence,
  });
  const busy = busyAction !== null;

  useEffect(() => {
    if (feedback.kind === 'error') {
      errorRef.current?.focus();
    }
  }, [feedback]);

  async function handleSave(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (busy) {
      return;
    }
    setBusyAction('save');
    setFeedback({
      kind: 'pending',
      message: '正在保存设置…',
    });
    try {
      await actions.save(formInput());
      setApiKey('');
      setKeyVisible(false);
      setHasSavedCredential(true);
      setFeedback({
        kind: 'success',
        message: '设置已保存。',
      });
    } catch {
      setFeedback({
        kind: 'error',
        message: '保存失败，请检查填写内容和浏览器存储设置。',
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleTestConnection(): Promise<void> {
    if (busy) {
      return;
    }
    setBusyAction('test');
    try {
      await actions.testConnection(formInput(), setFeedback);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDelete(): Promise<void> {
    if (busy) {
      return;
    }
    setBusyAction('delete');
    setFeedback({
      kind: 'pending',
      message: '正在删除连接…',
    });
    try {
      await actions.remove();
      setApiKey('');
      setKeyVisible(false);
      setHasSavedCredential(false);
      setPersistence('session');
      setFeedback({
        kind: 'success',
        message: '已删除这个模型连接。',
      });
    } catch {
      setFeedback({
        kind: 'error',
        message: '删除未完成，请重试。',
      });
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section
      aria-busy={busy}
      aria-labelledby={titleId}
      className="ai-settings-panel"
    >
      <header className="ai-settings-panel__header">
        <div>
          <p className="ai-settings-panel__eyebrow">
            PERSONAL MODEL CONNECTION
          </p>
          <h2 id={titleId}>连接你自己的模型</h2>
          <p>
            请求会从此浏览器直接发送到你填写的模型地址。密钥只按你的选择保存在当前会话或这台设备的浏览器中。
          </p>
        </div>
        <span
          className="ai-settings-panel__connection-mark"
          data-connected={hasSavedCredential ? 'true' : 'false'}
        >
          <i aria-hidden="true" />
          {hasSavedCredential ? '已保存连接' : '尚未保存'}
        </span>
      </header>

      <form
        className="ai-settings-panel__form"
        onSubmit={(event) => {
          void handleSave(event);
        }}
      >
        <div className="ai-settings-panel__field ai-settings-panel__field--wide">
          <label htmlFor={endpointId}>模型地址</label>
          <input
            aria-describedby={endpointHelpId}
            autoComplete="url"
            disabled={busy}
            id={endpointId}
            inputMode="url"
            name="endpoint"
            onChange={(event) => {
              setEndpoint(event.currentTarget.value);
              setFeedback(IDLE_FEEDBACK);
            }}
            placeholder="https://你的模型地址/v1"
            required
            type="url"
            value={endpoint}
          />
          <small id={endpointHelpId}>
            使用 HTTPS；本机模型可使用 localhost 地址。
          </small>
        </div>

        <div className="ai-settings-panel__field">
          <label htmlFor={modelId}>模型名称</label>
          <input
            autoComplete="off"
            disabled={busy}
            id={modelId}
            maxLength={256}
            name="model"
            onChange={(event) => {
              setModel(event.currentTarget.value);
              setFeedback(IDLE_FEEDBACK);
            }}
            placeholder="例如：gpt-4.1-mini"
            required
            type="text"
            value={model}
          />
        </div>

        <div className="ai-settings-panel__field ai-settings-panel__key-field">
          <div className="ai-settings-panel__label-row">
            <label htmlFor={keyId}>API 密钥</label>
            <button
              aria-controls={keyId}
              aria-label={keyVisible ? '隐藏密钥' : '显示密钥'}
              aria-pressed={keyVisible}
              className="ai-settings-panel__key-toggle"
              disabled={busy}
              onClick={() => {
                setKeyVisible((current) => !current);
              }}
              type="button"
            >
              <KeyVisibilityIcon visible={keyVisible} />
              <span>{keyVisible ? '隐藏' : '显示'}</span>
            </button>
          </div>
          <input
            aria-describedby={keyHelpId}
            autoCapitalize="none"
            autoComplete="new-password"
            disabled={busy}
            id={keyId}
            name="apiKey"
            onChange={(event) => {
              setApiKey(event.currentTarget.value);
              setFeedback(IDLE_FEEDBACK);
            }}
            required={!hasSavedCredential}
            spellCheck={false}
            type={keyVisible ? 'text' : 'password'}
            value={apiKey}
          />
          <small id={keyHelpId}>
            {hasSavedCredential
              ? '已保存的密钥不会回填；留空会继续使用已保存的密钥。'
              : '只有点击保存后，密钥才会按你的选择写入浏览器存储。'}
          </small>
        </div>

        <fieldset
          className="ai-settings-panel__persistence"
          disabled={busy}
        >
          <legend>密钥保存方式</legend>
          <label>
            <input
              checked={persistence === 'session'}
              name="persistence"
              onChange={() => {
                setPersistence('session');
                setFeedback(IDLE_FEEDBACK);
              }}
              type="radio"
              value="session"
            />
            <span>
              <strong>仅本次使用</strong>
              <small>关闭这个标签页后清除</small>
            </span>
          </label>
          <label>
            <input
              checked={persistence === 'local'}
              name="persistence"
              onChange={() => {
                setPersistence('local');
                setFeedback(IDLE_FEEDBACK);
              }}
              type="radio"
              value="local"
            />
            <span>
              <strong>保存在此设备</strong>
              <small>下次在这个浏览器继续使用</small>
            </span>
          </label>
        </fieldset>

        <p className="ai-settings-panel__test-note">
          测试连接会向该模型地址发送一次请求；保存设置本身不会发送模型请求。
        </p>

        <div className="ai-settings-panel__actions">
          <button
            className="ai-settings-panel__button ai-settings-panel__button--test"
            disabled={busy}
            onClick={() => {
              void handleTestConnection();
            }}
            type="button"
          >
            {busyAction === 'test' ? '正在连接…' : '测试连接'}
          </button>
          <button
            className="ai-settings-panel__button ai-settings-panel__button--save"
            disabled={busy}
            type="submit"
          >
            {busyAction === 'save' ? '正在保存…' : '保存设置'}
          </button>
          <button
            className="ai-settings-panel__button ai-settings-panel__button--delete"
            disabled={busy}
            onClick={() => {
              void handleDelete();
            }}
            type="button"
          >
            {busyAction === 'delete' ? '正在删除…' : '删除连接'}
          </button>
        </div>
      </form>

      <div
        aria-atomic="true"
        aria-live="polite"
        className="ai-settings-panel__feedback"
      >
        {feedback.kind === 'idle' ? null : (
          <div
            className={`ai-settings-panel__feedback-message ai-settings-panel__feedback-message--${feedback.kind}`}
            ref={feedback.kind === 'error' ? errorRef : undefined}
            role={feedback.kind === 'error' ? 'alert' : 'status'}
            tabIndex={feedback.kind === 'error' ? -1 : undefined}
          >
            <span aria-hidden="true">
              {feedback.kind === 'pending'
                ? '…'
                : feedback.kind === 'success'
                  ? '✓'
                  : '!'}
            </span>
            <p>{feedback.message}</p>
          </div>
        )}
      </div>
    </section>
  );
}

function providerConfigAt(
  dependencies: Pick<
    AISettingsActionDependencies,
    'providerId' | 'displayName' | 'credentials'
  >,
  input: Pick<AISettingsFormInput, 'endpoint' | 'model'>,
): AISettingsProviderConfig {
  const provider = createOpenAICompatibleProvider({
    id: dependencies.providerId,
    displayName: dependencies.displayName,
    endpoint: input.endpoint.trim(),
    model: input.model.trim(),
    credentials: dependencies.credentials,
    credentialProviderId: dependencies.providerId,
  });
  const endpoint = provider.descriptor.endpoint;
  if (endpoint === null) {
    throw new Error('Invalid model connection');
  }
  return Object.freeze({
    providerId: provider.descriptor.id,
    displayName: provider.descriptor.displayName,
    endpoint,
    model: provider.descriptor.model,
  });
}

function credentialAt(
  draft: string,
  providerId: string,
  credentials: Pick<BYOKCredentialStore, 'resolve'>,
): string {
  const apiKey = draft.length > 0 ? draft : credentials.resolve(providerId);
  if (
    typeof apiKey !== 'string' ||
    apiKey.length === 0 ||
    apiKey.length > 16_384 ||
    apiKey !== apiKey.trim() ||
    hasControlCharacters(apiKey)
  ) {
    throw new Error('Invalid credential');
  }
  return apiKey;
}

function credentialStateAt(
  credentials: Pick<BYOKCredentialStore, 'persistenceOf'>,
  providerId: string,
): Readonly<{
  hasCredential: boolean;
  persistence: BYOKCredentialPersistence | null;
}> {
  try {
    const persistence = credentials.persistenceOf(providerId);
    return Object.freeze({
      hasCredential: persistence !== null,
      persistence,
    });
  } catch {
    return Object.freeze({
      hasCredential: false,
      persistence: null,
    });
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

function KeyVisibilityIcon({ visible }: { visible: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      {visible ? (
        <>
          <path d="M3 3 21 21" />
          <path d="M10.7 10.7a2 2 0 0 0 2.6 2.6" />
          <path d="M9.8 4.3A10.7 10.7 0 0 1 12 4c5.5 0 9 5.2 9 8a9 9 0 0 1-2 3.8M6.4 6.4C4.3 7.9 3 10.3 3 12c0 2.8 3.5 8 9 8 1.4 0 2.7-.3 3.8-.8" />
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

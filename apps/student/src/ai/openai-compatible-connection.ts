import type { AIProviderRequest } from './ai-provider.js';
import type {
  AISettingsConnectionInput,
  AISettingsProviderConfig,
} from './ai-settings-panel.js';
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleFetch,
} from './openai-compatible-provider.js';

export const OPENAI_COMPATIBLE_PROVIDER_ID =
  'student-openai-compatible';
export const OPENAI_COMPATIBLE_DISPLAY_NAME = '我的模型';

const CONFIG_STORAGE_KEY =
  'zuocheng:openai-compatible-config:v1';
const CONFIG_VERSION = 1;

export type OpenAICompatibleConnectionErrorCode =
  | 'INVALID_CONFIG'
  | 'STORAGE_UNAVAILABLE'
  | 'UNEXPECTED_RESPONSE';

export class OpenAICompatibleConnectionError extends Error {
  constructor(readonly code: OpenAICompatibleConnectionErrorCode) {
    super(`OpenAI-compatible connection rejected: ${code}`);
    this.name = 'OpenAICompatibleConnectionError';
  }
}

export interface OpenAICompatibleConfigStore {
  load(): AISettingsProviderConfig | null;
  save(config: AISettingsProviderConfig): void;
  remove(): void;
}

export type OpenAICompatibleConfigStoreOptions = Readonly<{
  storage?: Storage | null;
}>;

export type TestOpenAICompatibleConnectionOptions = Readonly<{
  fetcher?: OpenAICompatibleFetch;
  timeoutMs?: number;
}>;

const CONNECTION_TEST_REQUEST: AIProviderRequest = Object.freeze({
  runId: 'user-requested-connection-test',
  prompt:
    'Respond only with the JSON object {"connected":true}. Do not include any other fields or text.',
  promptVersion: 'connection-test-prompt-v1',
  input: Object.freeze({
    purpose: 'user_requested_connection_test',
  }),
  inputVersions: Object.freeze({
    settings: 1,
  }),
  retrievedChunkIds: Object.freeze([]),
  availableEvidenceCardIds: Object.freeze([]),
  schemaVersion: 'connection-test-response-v1',
});

export function createOpenAICompatibleConfigStore(
  options: OpenAICompatibleConfigStoreOptions = {},
): OpenAICompatibleConfigStore {
  const storage =
    options.storage === undefined
      ? browserLocalStorage()
      : options.storage;

  return Object.freeze({
    load(): AISettingsProviderConfig | null {
      if (storage === null) {
        return null;
      }
      let serialized: string | null;
      try {
        serialized = storage.getItem(CONFIG_STORAGE_KEY);
      } catch {
        return null;
      }
      if (serialized === null) {
        return null;
      }
      try {
        const value = JSON.parse(serialized) as unknown;
        return persistedConfigAt(value);
      } catch {
        return null;
      }
    },

    save(config: AISettingsProviderConfig): void {
      const validated = configAt(config);
      if (storage === null) {
        throw connectionError('STORAGE_UNAVAILABLE');
      }
      try {
        storage.setItem(
          CONFIG_STORAGE_KEY,
          JSON.stringify({
            version: CONFIG_VERSION,
            endpoint: validated.endpoint,
            model: validated.model,
          }),
        );
      } catch {
        throw connectionError('STORAGE_UNAVAILABLE');
      }
    },

    remove(): void {
      if (storage === null) {
        return;
      }
      try {
        storage.removeItem(CONFIG_STORAGE_KEY);
      } catch {
        throw connectionError('STORAGE_UNAVAILABLE');
      }
    },
  });
}

export async function testOpenAICompatibleConnection(
  input: AISettingsConnectionInput,
  signal: AbortSignal,
  options: TestOpenAICompatibleConnectionOptions = {},
): Promise<void> {
  const config = configAt(input);
  const provider = createOpenAICompatibleProvider({
    id: config.providerId,
    displayName: config.displayName,
    endpoint: config.endpoint,
    model: config.model,
    credentials: {
      resolve(providerId: string): string | null {
        return providerId === config.providerId
          ? input.apiKey
          : null;
      },
    },
    credentialProviderId: config.providerId,
    ...(options.fetcher === undefined
      ? {}
      : { fetcher: options.fetcher }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  });
  const response = await provider.invoke(CONNECTION_TEST_REQUEST, {
    signal,
  });
  if (!isPositiveAcknowledgement(response.output)) {
    throw connectionError('UNEXPECTED_RESPONSE');
  }
}

function configAt(
  value: Pick<
    AISettingsProviderConfig,
    'providerId' | 'displayName' | 'endpoint' | 'model'
  >,
): AISettingsProviderConfig {
  if (
    value.providerId !== OPENAI_COMPATIBLE_PROVIDER_ID ||
    value.displayName !== OPENAI_COMPATIBLE_DISPLAY_NAME
  ) {
    throw connectionError('INVALID_CONFIG');
  }
  try {
    const provider = createOpenAICompatibleProvider({
      id: value.providerId,
      displayName: value.displayName,
      endpoint: value.endpoint,
      model: value.model,
      credentials: { resolve: () => null },
    });
    const endpoint = provider.descriptor.endpoint;
    if (endpoint === null) {
      throw connectionError('INVALID_CONFIG');
    }
    return Object.freeze({
      providerId: provider.descriptor.id,
      displayName: provider.descriptor.displayName,
      endpoint,
      model: provider.descriptor.model,
    });
  } catch (error) {
    if (error instanceof OpenAICompatibleConnectionError) {
      throw error;
    }
    throw connectionError('INVALID_CONFIG');
  }
}

function persistedConfigAt(value: unknown): AISettingsProviderConfig {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw connectionError('INVALID_CONFIG');
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== CONFIG_VERSION ||
    typeof record.endpoint !== 'string' ||
    typeof record.model !== 'string' ||
    Object.keys(record).some(
      (key) =>
        key !== 'version' &&
        key !== 'endpoint' &&
        key !== 'model',
    )
  ) {
    throw connectionError('INVALID_CONFIG');
  }
  return configAt({
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    displayName: OPENAI_COMPATIBLE_DISPLAY_NAME,
    endpoint: record.endpoint,
    model: record.model,
  });
}

function isPositiveAcknowledgement(
  value: unknown,
): value is Readonly<{ connected: true }> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === 1 &&
    (value as Record<string, unknown>).connected === true
  );
}

function browserLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function connectionError(
  code: OpenAICompatibleConnectionErrorCode,
): OpenAICompatibleConnectionError {
  return new OpenAICompatibleConnectionError(code);
}

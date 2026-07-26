import {
  AIDomainError,
  AIProviderInvocationError,
  defineAIProvider,
  type AIJsonValue,
  type AIProvider,
  type AIProviderInvocationContext,
  type AIProviderKind,
  type AIProviderRequest,
  type AIProviderResponse,
  type AITokenUsage,
} from './ai-provider.js';
import type { BYOKCredentialStore } from './byok-credential-store.js';

export type OpenAICompatibleProviderErrorCode =
  | 'MISSING_CREDENTIAL'
  | 'AUTHENTICATION_FAILED'
  | 'RATE_LIMITED'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'INVALID_RESPONSE';

export class OpenAICompatibleProviderError extends AIProviderInvocationError {
  constructor(
    readonly reasonCode: OpenAICompatibleProviderErrorCode,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(
      reasonCode === 'RATE_LIMITED'
        ? 'QUOTA_EXHAUSTED'
        : 'PROVIDER_ERROR',
    );
    this.name = 'OpenAICompatibleProviderError';
  }
}

export type OpenAICompatibleFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type OpenAICompatibleProviderOptions = Readonly<{
  id: string;
  displayName: string;
  endpoint: string;
  model: string;
  credentials: Pick<BYOKCredentialStore, 'resolve'>;
  credentialProviderId?: string;
  kind?: Extract<
    AIProviderKind,
    'byok-openai-compatible' | 'self-hosted'
  >;
  fetcher?: OpenAICompatibleFetch;
  timeoutMs?: number;
}>;

type AbortScope = Readonly<{
  signal: AbortSignal;
  didTimeout(): boolean;
  didAbortExternally(): boolean;
  dispose(): void;
}>;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 15 * 60_000;

export function createOpenAICompatibleProvider(
  options: OpenAICompatibleProviderOptions,
): AIProvider {
  const kind = options.kind ?? 'byok-openai-compatible';
  assertEndpointHasNoCredentialQuery(options.endpoint);
  const descriptor = defineAIProvider({
    id: options.id,
    kind,
    displayName: options.displayName,
    endpoint: options.endpoint,
    model: options.model,
  });
  if (descriptor.endpoint === null) {
    throw new AIDomainError('INVALID_PROVIDER');
  }
  if (
    typeof options.credentials !== 'object' ||
    options.credentials === null ||
    typeof options.credentials.resolve !== 'function'
  ) {
    throw new AIDomainError('INVALID_PROVIDER');
  }
  const credentialProviderId =
    options.credentialProviderId ?? descriptor.id;
  assertNonEmptyString(credentialProviderId);
  const timeoutMs = timeoutAt(options.timeoutMs);
  const fetcher = options.fetcher ?? defaultFetch;
  if (typeof fetcher !== 'function') {
    throw new AIDomainError('INVALID_PROVIDER');
  }
  const url = completionUrl(descriptor.endpoint);

  return Object.freeze({
    descriptor,
    async invoke(
      request: AIProviderRequest,
      context: AIProviderInvocationContext,
    ): Promise<AIProviderResponse> {
      if (context.signal.aborted) {
        throw providerError('ABORTED');
      }
      const apiKey = resolveCredential(
        options.credentials,
        credentialProviderId,
      );
      const body = requestBody(descriptor.model, request);
      const abortScope = createAbortScope(context.signal, timeoutMs);
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: abortScope.signal,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
        });
        if (!response.ok) {
          throw httpError(response);
        }
        return await parseSuccessfulResponse(response);
      } catch (error) {
        if (
          abortScope.didAbortExternally() ||
          context.signal.aborted
        ) {
          throw providerError('ABORTED');
        }
        if (abortScope.didTimeout()) {
          throw providerError('TIMEOUT');
        }
        if (error instanceof OpenAICompatibleProviderError) {
          throw error;
        }
        throw providerError('NETWORK_ERROR');
      } finally {
        abortScope.dispose();
      }
    },
  });
}

function requestBody(
  model: string,
  request: AIProviderRequest,
): string {
  return JSON.stringify({
    model,
    stream: false,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: request.prompt,
      },
      {
        role: 'user',
        content: JSON.stringify({
          promptVersion: request.promptVersion,
          schemaVersion: request.schemaVersion,
          input: request.input,
          inputVersions: request.inputVersions,
          retrievedChunkIds: request.retrievedChunkIds,
          availableEvidenceCardIds: request.availableEvidenceCardIds,
        }),
      },
    ],
  });
}

async function parseSuccessfulResponse(
  response: Response,
): Promise<AIProviderResponse> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw providerError('INVALID_RESPONSE');
  }
  const object = plainObject(payload);
  if (object === null || !Array.isArray(object.choices)) {
    throw providerError('INVALID_RESPONSE');
  }
  const firstChoice = object.choices[0];
  const choice = plainObject(firstChoice);
  const message = plainObject(choice?.message);
  if (message === null) {
    throw providerError('INVALID_RESPONSE');
  }

  const output =
    message.parsed === undefined
      ? parseMessageContent(message.content)
      : jsonValue(message.parsed);
  const tokenUsage =
    object.usage === undefined || object.usage === null
      ? null
      : usageAt(object.usage);
  return Object.freeze({
    output,
    tokenUsage,
    actualCost: null,
  });
}

function parseMessageContent(value: unknown): AIJsonValue {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw providerError('INVALID_RESPONSE');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw providerError('INVALID_RESPONSE');
  }
  return jsonValue(parsed);
}

function usageAt(value: unknown): AITokenUsage {
  const object = plainObject(value);
  if (object === null) {
    throw providerError('INVALID_RESPONSE');
  }
  const inputTokens = tokenCount(object.prompt_tokens);
  const outputTokens = tokenCount(object.completion_tokens);
  const totalTokens = tokenCount(object.total_tokens);
  if (totalTokens !== inputTokens + outputTokens) {
    throw providerError('INVALID_RESPONSE');
  }
  return Object.freeze({
    inputTokens,
    outputTokens,
    totalTokens,
  });
}

function tokenCount(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw providerError('INVALID_RESPONSE');
  }
  return value;
}

function jsonValue(
  value: unknown,
  seen = new WeakSet<object>(),
): AIJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw providerError('INVALID_RESPONSE');
    }
    return value;
  }
  if (typeof value !== 'object' || seen.has(value)) {
    throw providerError('INVALID_RESPONSE');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => jsonValue(item, seen));
    seen.delete(value);
    return Object.freeze(result);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw providerError('INVALID_RESPONSE');
  }
  const result: Record<string, AIJsonValue> = {};
  for (const [key, item] of Object.entries(
    value as Record<string, unknown>,
  )) {
    result[key] = jsonValue(item, seen);
  }
  seen.delete(value);
  return Object.freeze(result);
}

function httpError(
  response: Response,
): OpenAICompatibleProviderError {
  const retryAfterSeconds = retryAfterAt(
    response.headers.get('Retry-After'),
  );
  if (response.status === 429) {
    return providerError(
      'RATE_LIMITED',
      response.status,
      retryAfterSeconds,
    );
  }
  if (response.status === 401 || response.status === 403) {
    return providerError(
      'AUTHENTICATION_FAILED',
      response.status,
      retryAfterSeconds,
    );
  }
  return providerError(
    'HTTP_ERROR',
    response.status,
    retryAfterSeconds,
  );
}

function retryAfterAt(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) {
    return null;
  }
  return Math.max(0, Math.ceil((date - Date.now()) / 1_000));
}

function createAbortScope(
  externalSignal: AbortSignal,
  timeoutMs: number,
): AbortScope {
  const controller = new AbortController();
  let timedOut = false;
  let abortedExternally = false;
  const abortFromExternal = () => {
    abortedExternally = true;
    controller.abort();
  };
  if (externalSignal.aborted) {
    abortFromExternal();
  } else {
    externalSignal.addEventListener('abort', abortFromExternal, {
      once: true,
    });
  }
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    didTimeout: () => timedOut,
    didAbortExternally: () => abortedExternally,
    dispose: () => {
      globalThis.clearTimeout(timeout);
      externalSignal.removeEventListener('abort', abortFromExternal);
    },
  });
}

function resolveCredential(
  credentials: Pick<BYOKCredentialStore, 'resolve'>,
  providerId: string,
): string {
  let apiKey: string | null;
  try {
    apiKey = credentials.resolve(providerId);
  } catch {
    throw providerError('MISSING_CREDENTIAL');
  }
  if (
    typeof apiKey !== 'string' ||
    apiKey.length === 0 ||
    apiKey !== apiKey.trim() ||
    hasControlCharacters(apiKey)
  ) {
    throw providerError('MISSING_CREDENTIAL');
  }
  return apiKey;
}

function completionUrl(endpoint: string): string {
  const url = new URL(endpoint);
  const basePath = url.pathname.replace(/\/+$/u, '');
  url.pathname = basePath.endsWith('/chat/completions')
    ? basePath
    : `${basePath}/chat/completions`;
  url.hash = '';
  return url.toString();
}

function assertEndpointHasNoCredentialQuery(endpoint: unknown): void {
  if (typeof endpoint !== 'string') {
    return;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return;
  }
  for (const key of url.searchParams.keys()) {
    const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
    if (
      normalized === 'key' ||
      normalized === 'apikey' ||
      normalized.includes('token') ||
      normalized.includes('secret') ||
      normalized.includes('password') ||
      normalized.includes('authorization')
    ) {
      throw new AIDomainError('PLAINTEXT_CREDENTIAL_FORBIDDEN');
    }
  }
}

function timeoutAt(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new AIDomainError('INVALID_PROVIDER');
  }
  return timeoutMs;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  return value as Record<string, unknown>;
}

function assertNonEmptyString(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new AIDomainError('INVALID_PROVIDER');
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

function providerError(
  reasonCode: OpenAICompatibleProviderErrorCode,
  status: number | null = null,
  retryAfterSeconds: number | null = null,
): OpenAICompatibleProviderError {
  return new OpenAICompatibleProviderError(
    reasonCode,
    status,
    retryAfterSeconds,
  );
}

async function defaultFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return globalThis.fetch(input, init);
}

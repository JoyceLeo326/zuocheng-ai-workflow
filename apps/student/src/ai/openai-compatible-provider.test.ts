import { describe, expect, it, vi } from 'vitest';
import type {
  AIDomainError,
  AIProviderRequest,
  AIReviewCandidate,
} from './ai-provider.js';
import { createBYOKCredentialStore } from './byok-credential-store.js';
import {
  OpenAICompatibleProviderError,
  createOpenAICompatibleProvider,
  type OpenAICompatibleFetch,
} from './openai-compatible-provider.js';

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

const CANDIDATE: AIReviewCandidate = {
  value: {
    summary: 'The verified pilot reduced waiting time.',
  },
  claims: [
    {
      id: 'claim-001',
      text: 'The verified pilot reduced waiting time.',
      evidenceCardIds: ['evidence-001'],
    },
  ],
  patches: [
    {
      operation: 'replace',
      path: '/pages/0/body',
      value: 'The verified pilot reduced waiting time.',
    },
  ],
};

const PROVIDER_REQUEST: AIProviderRequest = {
  runId: 'run-0001',
  prompt: 'Return one evidence-backed draft as JSON.',
  promptVersion: 'draft-prompt-v3',
  input: {
    task: 'Explain the pilot result.',
  },
  inputVersions: {
    project: 7,
  },
  retrievedChunkIds: ['chunk-001'],
  availableEvidenceCardIds: ['evidence-001'],
  schemaVersion: 'draft-candidate-v2',
};

function credentialStore(apiKey?: string) {
  const store = createBYOKCredentialStore({
    sessionStorage: new MemoryStorage(),
    localStorage: new MemoryStorage(),
  });
  if (apiKey !== undefined) {
    store.save({
      providerId: 'student-provider',
      apiKey,
    });
  }
  return store;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

async function invokeWith(
  fetcher: OpenAICompatibleFetch,
  options: Readonly<{ apiKey?: string; timeoutMs?: number }> = {},
) {
  const provider = createOpenAICompatibleProvider({
    id: 'student-provider',
    displayName: 'Student OpenAI-compatible provider',
    endpoint: 'https://models.example.test/v1',
    model: 'compatible-model',
    credentials: credentialStore(options.apiKey),
    fetcher,
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  });
  return provider.invoke(PROVIDER_REQUEST, {
    signal: new AbortController().signal,
  });
}

describe('OpenAI-compatible browser provider', () => {
  it('sends the key only in Authorization and parses structured JSON with usage', async () => {
    const apiKey = 'fixture-token-18';
    const fetcher = vi.fn<OpenAICompatibleFetch>(async () =>
      jsonResponse(200, {
        choices: [
          {
            message: {
              role: 'assistant',
              content: JSON.stringify(CANDIDATE),
            },
          },
        ],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 80,
          total_tokens: 200,
        },
      }),
    );
    const provider = createOpenAICompatibleProvider({
      id: 'student-provider',
      displayName: 'Student OpenAI-compatible provider',
      endpoint: 'https://models.example.test/v1',
      model: 'compatible-model',
      credentials: credentialStore(apiKey),
      fetcher,
      timeoutMs: 30_000,
    });

    const result = await provider.invoke(PROVIDER_REQUEST, {
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      output: CANDIDATE,
      tokenUsage: {
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
      },
      actualCost: null,
    });
    expect(provider.descriptor).toMatchObject({
      id: 'student-provider',
      kind: 'byok-openai-compatible',
      endpoint: 'https://models.example.test/v1',
      model: 'compatible-model',
    });
    expect(JSON.stringify(provider)).not.toContain(apiKey);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://models.example.test/v1/chat/completions',
    );
    expect(init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${apiKey}`);
    expect(headers.get('Content-Type')).toBe('application/json');
    const body = String(init?.body);
    expect(body).not.toContain(apiKey);
    const parsedBody = JSON.parse(body) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(parsedBody).toMatchObject({
      model: 'compatible-model',
      stream: false,
      response_format: { type: 'json_object' },
    });
    expect(parsedBody.messages[0]).toEqual({
      role: 'system',
      content: PROVIDER_REQUEST.prompt,
    });
    expect(parsedBody.messages[1]).toMatchObject({
      role: 'user',
    });
    expect(body).toContain(PROVIDER_REQUEST.schemaVersion);
    expect(body).toContain('evidence-001');
  });

  it('requires an explicitly saved credential and never calls fetch without one', async () => {
    const fetcher = vi.fn<OpenAICompatibleFetch>();
    const provider = createOpenAICompatibleProvider({
      id: 'student-provider',
      displayName: 'Student provider',
      endpoint: 'https://models.example.test/v1',
      model: 'compatible-model',
      credentials: credentialStore(),
      fetcher,
    });

    const error = await provider
      .invoke(PROVIDER_REQUEST, {
        signal: new AbortController().signal,
      })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(OpenAICompatibleProviderError);
    expect(error).toMatchObject({
      code: 'PROVIDER_ERROR',
      reasonCode: 'MISSING_CREDENTIAL',
      status: null,
      retryAfterSeconds: null,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(String(error)).not.toMatch(/sk-|bearer|authorization/iu);
  });

  it('enforces HTTPS remotely while allowing an HTTP localhost development endpoint', () => {
    expect(() =>
      createOpenAICompatibleProvider({
        id: 'remote-http',
        displayName: 'Remote HTTP',
        endpoint: 'http://models.example.test/v1',
        model: 'model',
        credentials: credentialStore('fixture-token-19'),
        fetcher: vi.fn<OpenAICompatibleFetch>(),
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AIDomainError>>({
        code: 'INSECURE_ENDPOINT',
      }),
    );

    expect(
      createOpenAICompatibleProvider({
        id: 'localhost-http',
        displayName: 'Localhost HTTP',
        endpoint: 'http://localhost:11434/v1',
        model: 'model',
        credentials: credentialStore('fixture-token-19'),
        fetcher: vi.fn<OpenAICompatibleFetch>(),
      }).descriptor.endpoint,
    ).toBe('http://localhost:11434/v1');

    const querySecret = 'fixture-token-20';
    let thrown: unknown;
    try {
      createOpenAICompatibleProvider({
        id: 'query-credential',
        displayName: 'Query credential',
        endpoint:
          `https://models.example.test/v1?key=${querySecret}`,
        model: 'model',
        credentials: credentialStore('fixture-token-19'),
        fetcher: vi.fn<OpenAICompatibleFetch>(),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'PLAINTEXT_CREDENTIAL_FORBIDDEN',
    });
    expect(String(thrown)).not.toContain(querySecret);
  });

  it.each([
    {
      status: 429,
      expectedReason: 'RATE_LIMITED',
      expectedCode: 'QUOTA_EXHAUSTED',
      headers: { 'Retry-After': '12' },
      retryAfterSeconds: 12,
    },
    {
      status: 401,
      expectedReason: 'AUTHENTICATION_FAILED',
      expectedCode: 'PROVIDER_ERROR',
      headers: {},
      retryAfterSeconds: null,
    },
    {
      status: 503,
      expectedReason: 'HTTP_ERROR',
      expectedCode: 'PROVIDER_ERROR',
      headers: {},
      retryAfterSeconds: null,
    },
  ] as const)(
    'maps HTTP $status without retaining the response body',
    async ({
      status,
      expectedReason,
      expectedCode,
      headers,
      retryAfterSeconds,
    }) => {
      const bodySecret = 'fixture-token-21';
      const error = await invokeWith(
        vi.fn(async () =>
          jsonResponse(status, { error: { message: bodySecret } }, headers),
        ),
        { apiKey: 'fixture-token-22' },
      ).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(OpenAICompatibleProviderError);
      expect(error).toMatchObject({
        code: expectedCode,
        reasonCode: expectedReason,
        status,
        retryAfterSeconds,
      });
      expect(String(error)).not.toContain(bodySecret);
      expect(JSON.stringify(error)).not.toContain(bodySecret);
    },
  );

  it('maps network failures and malformed provider payloads to safe errors', async () => {
    const networkSecret = 'fixture-token-23';
    const networkError = await invokeWith(
      vi.fn(async () => {
        throw new TypeError(networkSecret);
      }),
      { apiKey: 'fixture-token-22' },
    ).catch((reason: unknown) => reason);
    expect(networkError).toMatchObject({
      code: 'PROVIDER_ERROR',
      reasonCode: 'NETWORK_ERROR',
      status: null,
    });
    expect(String(networkError)).not.toContain(networkSecret);

    const invalidResponse = await invokeWith(
      vi.fn(async () =>
        jsonResponse(200, {
          choices: [{ message: { content: 'not valid JSON' } }],
        }),
      ),
      { apiKey: 'fixture-token-22' },
    ).catch((reason: unknown) => reason);
    expect(invalidResponse).toMatchObject({
      code: 'PROVIDER_ERROR',
      reasonCode: 'INVALID_RESPONSE',
    });
  });

  it('combines external AbortSignal cancellation with an independent timeout', async () => {
    const abortingFetcher = vi.fn<OpenAICompatibleFetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === null || signal === undefined) {
            reject(new Error('missing signal'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const provider = createOpenAICompatibleProvider({
      id: 'student-provider',
      displayName: 'Student provider',
      endpoint: 'https://models.example.test/v1',
      model: 'compatible-model',
      credentials: credentialStore('fixture-token-22'),
      fetcher: abortingFetcher,
      timeoutMs: 1_000,
    });
    const invocation = provider
      .invoke(PROVIDER_REQUEST, { signal: controller.signal })
      .catch((reason: unknown) => reason);
    controller.abort();
    await expect(invocation).resolves.toMatchObject({
      code: 'PROVIDER_ERROR',
      reasonCode: 'ABORTED',
    });

    const timeoutError = await invokeWith(abortingFetcher, {
      apiKey: 'fixture-token-22',
      timeoutMs: 5,
    }).catch((reason: unknown) => reason);
    expect(timeoutError).toMatchObject({
      code: 'PROVIDER_ERROR',
      reasonCode: 'TIMEOUT',
    });
  });
});

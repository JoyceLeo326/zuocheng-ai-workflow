import { describe, expect, it, vi } from 'vitest';
import {
  OPENAI_COMPATIBLE_DISPLAY_NAME,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAICompatibleConfigStore,
  testOpenAICompatibleConnection,
  type OpenAICompatibleConnectionError,
} from './openai-compatible-connection.js';
import type { OpenAICompatibleFetch } from './openai-compatible-provider.js';

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

const CONNECTION_INPUT = {
  providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
  displayName: OPENAI_COMPATIBLE_DISPLAY_NAME,
  endpoint: 'https://models.example.test/v1',
  model: 'example-chat',
  apiKey: 'sk-connection-only',
} as const;

function successfulResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: JSON.stringify({ connected: true }),
          },
        },
      ],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 4,
        total_tokens: 12,
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

describe('OpenAI-compatible connection integration', () => {
  it('stores only validated endpoint/model configuration and can remove it', () => {
    const storage = new MemoryStorage();
    const store = createOpenAICompatibleConfigStore({ storage });

    expect(store.load()).toBeNull();
    store.save({
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      displayName: OPENAI_COMPATIBLE_DISPLAY_NAME,
      endpoint: CONNECTION_INPUT.endpoint,
      model: CONNECTION_INPUT.model,
    });

    expect(store.load()).toEqual({
      providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
      displayName: OPENAI_COMPATIBLE_DISPLAY_NAME,
      endpoint: CONNECTION_INPUT.endpoint,
      model: CONNECTION_INPUT.model,
    });
    const serialized = storage.getItem(
      'zuocheng:openai-compatible-config:v1',
    );
    expect(serialized).not.toBeNull();
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain(CONNECTION_INPUT.apiKey);

    store.remove();
    expect(store.load()).toBeNull();
  });

  it('ignores malformed persisted configuration instead of blocking the workbench', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'zuocheng:openai-compatible-config:v1',
      JSON.stringify({
        version: 1,
        endpoint: 'javascript:alert(1)',
        model: 'bad',
      }),
    );

    const store = createOpenAICompatibleConfigStore({ storage });

    expect(store.load()).toBeNull();
  });

  it('uses the real adapter for a user-triggered minimal structured request', async () => {
    const fetcher = vi.fn<OpenAICompatibleFetch>(
      async () => successfulResponse(),
    );
    const controller = new AbortController();

    await expect(
      testOpenAICompatibleConnection(
        CONNECTION_INPUT,
        controller.signal,
        { fetcher },
      ),
    ).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://models.example.test/v1/chat/completions',
    );
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      `Bearer ${CONNECTION_INPUT.apiKey}`,
    );

    const body = JSON.parse(String(init?.body)) as {
      model: string;
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe(CONNECTION_INPUT.model);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0]?.content).toContain('{"connected":true}');
    expect(body.messages[1]?.content).toContain(
      'user_requested_connection_test',
    );
    const userPayload = JSON.parse(body.messages[1]!.content) as {
      input: unknown;
      retrievedChunkIds: unknown[];
      availableEvidenceCardIds: unknown[];
    };
    expect(userPayload).toMatchObject({
      input: { purpose: 'user_requested_connection_test' },
      retrievedChunkIds: [],
      availableEvidenceCardIds: [],
    });
    expect(JSON.stringify(userPayload.input)).not.toMatch(
      /project|draft|evidence|sourceChunk/i,
    );
  });

  it('cancels the real adapter request through the caller AbortSignal', async () => {
    const fetcher = vi.fn<OpenAICompatibleFetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const pending = testOpenAICompatibleConnection(
      CONNECTION_INPUT,
      controller.signal,
      { fetcher },
    );

    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      reasonCode: 'ABORTED',
    });
  });

  it('rejects a structurally valid but false connection acknowledgement', async () => {
    const fetcher = vi.fn<OpenAICompatibleFetch>(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({ connected: false }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(
      testOpenAICompatibleConnection(
        CONNECTION_INPUT,
        new AbortController().signal,
        { fetcher },
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<OpenAICompatibleConnectionError>>({
        code: 'UNEXPECTED_RESPONSE',
      }),
    );
  });
});

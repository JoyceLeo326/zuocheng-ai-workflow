import { describe, expect, it, vi } from 'vitest';
import {
  AIProviderInvocationError,
  AIRunOrchestrator,
  canTransitionAIRun,
  defineAIProvider,
  type AIDomainError,
  type AIOutputValidator,
  type AIProvider,
  type AIProviderDescriptor,
  type AIProviderResponse,
  type AIReviewCandidate,
  type EnqueueAIRunInput,
} from './ai-provider.js';

const ESTIMATED = {
  tokenUsage: {
    inputTokens: 120,
    outputTokens: 80,
    totalTokens: 200,
  },
  cost: {
    currency: 'USD',
    amountMicros: 1_200,
  },
} as const;

const ACTUAL_USAGE = {
  inputTokens: 108,
  outputTokens: 64,
  totalTokens: 172,
} as const;

const ACTUAL_COST = {
  currency: 'USD',
  amountMicros: 950,
} as const;

function remoteDescriptor(): AIProviderDescriptor {
  return defineAIProvider({
    id: 'student-openai-compatible',
    kind: 'byok-openai-compatible',
    displayName: 'Student provider',
    endpoint: 'https://models.example.test/v1',
    model: 'compatible-model',
  });
}

function request(
  provider = remoteDescriptor(),
): EnqueueAIRunInput {
  return {
    idempotencyKey: 'ai-run-key-0001',
    provider,
    promptVersion: 'draft-prompt-v3',
    prompt: 'Draft one evidence-backed conclusion.',
    input: {
      task: 'Explain the verified pilot result.',
    },
    inputVersions: {
      project: 7,
      source: 'sha256:abc123',
    },
    retrievedChunkIds: ['chunk-001'],
    availableEvidenceCardIds: ['evidence-001'],
    lockedPaths: ['/pages/0/title'],
    schemaVersion: 'draft-candidate-v2',
    estimated: ESTIMATED,
  };
}

function candidate(
  patchPath = '/pages/0/body',
  evidenceCardIds: readonly string[] = ['evidence-001'],
): AIReviewCandidate {
  return {
    value: {
      summary: 'The verified pilot reduced waiting time.',
    },
    claims: [
      {
        id: 'claim-001',
        text: 'The verified pilot reduced waiting time.',
        evidenceCardIds,
      },
    ],
    patches: [
      {
        operation: 'replace',
        path: patchPath,
        value: 'The verified pilot reduced waiting time.',
      },
    ],
  };
}

function response(
  output: unknown = candidate(),
): AIProviderResponse {
  return {
    output,
    tokenUsage: ACTUAL_USAGE,
    actualCost: ACTUAL_COST,
  };
}

function zodStyleValidator(): AIOutputValidator {
  return {
    safeParse(value: unknown) {
      return {
        success: true as const,
        data: value as AIReviewCandidate,
      };
    },
  };
}

function provider(
  descriptor: AIProviderDescriptor,
  invoke: AIProvider['invoke'] = vi.fn(async () => response()),
): AIProvider {
  return {
    descriptor,
    invoke,
  };
}

function orchestrator() {
  let id = 0;
  let tick = 0;
  const epoch = Date.parse('2026-07-27T04:00:00.000Z');
  return new AIRunOrchestrator({
    createId: () => {
      id += 1;
      return `run-${String(id).padStart(4, '0')}`;
    },
    now: () => {
      const value = new Date(epoch + tick * 1_000).toISOString();
      tick += 1;
      return value;
    },
  });
}

describe('AI provider descriptors', () => {
  it('unifies BYOK, browser-local and self-hosted providers without credential fields', () => {
    const byok = remoteDescriptor();
    const local = defineAIProvider({
      id: 'local-webgpu',
      kind: 'browser-local',
      displayName: 'Local WebGPU',
      endpoint: null,
      model: 'local-small-model',
    });
    const selfHosted = defineAIProvider({
      id: 'student-lab',
      kind: 'self-hosted',
      displayName: 'Student lab',
      endpoint: 'http://localhost:11434/v1',
      model: 'lab-model',
    });

    expect([byok.kind, local.kind, selfHosted.kind]).toEqual([
      'byok-openai-compatible',
      'browser-local',
      'self-hosted',
    ]);
    for (const descriptor of [byok, local, selfHosted]) {
      expect(JSON.stringify(descriptor)).not.toMatch(
        /api[-_]?key|authorization|bearer|secret/iu,
      );
    }
  });

  it('rejects insecure remote URLs, URL credentials and plaintext credential-shaped fields', () => {
    expect(() =>
      defineAIProvider({
        id: 'insecure',
        kind: 'self-hosted',
        displayName: 'Insecure',
        endpoint: 'http://models.example.test/v1',
        model: 'model',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AIDomainError>>({
        code: 'INSECURE_ENDPOINT',
      }),
    );
    expect(() =>
      defineAIProvider({
        id: 'url-credential',
        kind: 'byok-openai-compatible',
        displayName: 'Credential URL',
        endpoint: 'https://student:secret@models.example.test/v1',
        model: 'model',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AIDomainError>>({
        code: 'PLAINTEXT_CREDENTIAL_FORBIDDEN',
      }),
    );

    const plaintext = 'fixture-token-01';
    let thrown: unknown;
    try {
      defineAIProvider({
        id: 'extra-secret',
        kind: 'byok-openai-compatible',
        displayName: 'Extra secret',
        endpoint: 'https://models.example.test/v1',
        model: 'model',
        apiKey: plaintext,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'PLAINTEXT_CREDENTIAL_FORBIDDEN',
    });
    expect(String(thrown)).not.toContain(plaintext);
  });
});

describe('AI run orchestration', () => {
  it('persists the exact auditable run envelope and deduplicates identical enqueue calls', () => {
    const runs = orchestrator();
    const input = request();
    const first = runs.enqueue(input);
    const duplicate = runs.enqueue({
      ...input,
      input: { task: 'Explain the verified pilot result.' },
      inputVersions: { source: 'sha256:abc123', project: 7 },
    });

    expect(duplicate.id).toBe(first.id);
    expect(first).toMatchObject({
      id: 'run-0001',
      idempotencyKey: 'ai-run-key-0001',
      parentRunId: null,
      attempt: 1,
      provider: {
        id: 'student-openai-compatible',
        kind: 'byok-openai-compatible',
        endpoint: 'https://models.example.test/v1',
      },
      model: 'compatible-model',
      promptVersion: 'draft-prompt-v3',
      inputVersions: {
        project: 7,
        source: 'sha256:abc123',
      },
      retrievedChunkIds: ['chunk-001'],
      schemaVersion: 'draft-candidate-v2',
      tokenUsage: null,
      estimated: ESTIMATED,
      actualCost: null,
      errorCode: null,
      status: 'queued',
      candidate: null,
      claims: [],
      patches: [],
      times: {
        createdAt: '2026-07-27T04:00:00.000Z',
        queuedAt: '2026-07-27T04:00:00.000Z',
        updatedAt: '2026-07-27T04:00:00.000Z',
        startedAt: null,
        waitingForReviewAt: null,
        completedAt: null,
        failedAt: null,
        cancelledAt: null,
        quotaExhaustedAt: null,
        staleAt: null,
      },
    });
    expect(JSON.stringify(first)).not.toContain(input.prompt);
    expect(JSON.stringify(first)).not.toMatch(/api[-_]?key|authorization/iu);

    expect(() =>
      runs.enqueue({
        ...input,
        prompt: 'A conflicting prompt.',
      }),
    ).toThrowError(
      expect.objectContaining<Partial<AIDomainError>>({
        code: 'IDEMPOTENCY_CONFLICT',
      }),
    );
  });

  it('runs through review to completion and records model usage and cost', async () => {
    const runs = orchestrator();
    const descriptor = remoteDescriptor();
    const invoke = vi.fn<AIProvider['invoke']>(async (providerRequest) => {
      expect(providerRequest).toMatchObject({
        runId: 'run-0001',
        promptVersion: 'draft-prompt-v3',
        schemaVersion: 'draft-candidate-v2',
        retrievedChunkIds: ['chunk-001'],
      });
      expect(JSON.stringify(providerRequest)).not.toMatch(
        /api[-_]?key|authorization|bearer/iu,
      );
      return response();
    });
    const activeProvider = provider(descriptor, invoke);
    const queued = runs.enqueue(request(descriptor));

    const execution = runs.execute(
      queued.id,
      activeProvider,
      zodStyleValidator(),
    );
    const duplicateExecution = runs.execute(
      queued.id,
      activeProvider,
      zodStyleValidator(),
    );
    expect(duplicateExecution).toBe(execution);
    expect(runs.getRun(queued.id).status).toBe('running');
    const waiting = await execution;

    expect(waiting).toMatchObject({
      status: 'waiting_for_review',
      tokenUsage: ACTUAL_USAGE,
      actualCost: ACTUAL_COST,
      errorCode: null,
      candidate: {
        value: {
          summary: 'The verified pilot reduced waiting time.',
        },
      },
      claims: [
        {
          id: 'claim-001',
          evidenceCardIds: ['evidence-001'],
        },
      ],
      times: {
        startedAt: '2026-07-27T04:00:01.000Z',
        waitingForReviewAt: '2026-07-27T04:00:02.000Z',
      },
    });
    const completed = runs.approve(waiting.id);
    expect(completed).toMatchObject({
      status: 'completed',
      times: {
        completedAt: '2026-07-27T04:00:03.000Z',
      },
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('rejects insufficient or credential-bearing input before any provider call', async () => {
    const runs = orchestrator();
    const descriptor = remoteDescriptor();
    const invoke = vi.fn<AIProvider['invoke']>(async () => response());
    const activeProvider = provider(descriptor, invoke);
    const insufficient = runs.enqueue({
      ...request(descriptor),
      retrievedChunkIds: [],
    });

    expect(insufficient).toMatchObject({
      status: 'failed',
      errorCode: 'INSUFFICIENT_INPUT',
      times: {
        failedAt: '2026-07-27T04:00:01.000Z',
      },
    });
    await expect(
      runs.execute(
        insufficient.id,
        activeProvider,
        zodStyleValidator(),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'INSUFFICIENT_INPUT',
    });
    expect(invoke).not.toHaveBeenCalled();

    const plaintext = 'fixture-token-02';
    let thrown: unknown;
    try {
      runs.enqueue({
        ...request(descriptor),
        idempotencyKey: 'secret-input',
        input: { apiKey: plaintext },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'PLAINTEXT_CREDENTIAL_FORBIDDEN',
    });
    expect(String(thrown)).not.toContain(plaintext);
    expect(runs.listRuns()).toHaveLength(1);
  });

  it('fails closed when a claim has no available evidence binding', async () => {
    const runs = orchestrator();
    const descriptor = remoteDescriptor();
    const queued = runs.enqueue(request(descriptor));
    const unbound = candidate('/pages/0/body', []);

    const failed = await runs.execute(
      queued.id,
      provider(descriptor, vi.fn(async () => response(unbound))),
      zodStyleValidator(),
    );

    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: 'EVIDENCE_REQUIRED',
      candidate: null,
      claims: [],
      tokenUsage: ACTUAL_USAGE,
      actualCost: ACTUAL_COST,
    });
  });

  it('rejects patches that replace a locked path or one of its ancestors', async () => {
    const runs = orchestrator();
    const descriptor = remoteDescriptor();
    const queued = runs.enqueue(request(descriptor));
    const conflictsWithLockedTitle = candidate('/pages/0');
    const jsonSchemaStyleValidator: AIOutputValidator = (
      value: unknown,
    ): value is AIReviewCandidate =>
      typeof value === 'object' && value !== null;

    const failed = await runs.execute(
      queued.id,
      provider(
        descriptor,
        vi.fn(async () => response(conflictsWithLockedTitle)),
      ),
      jsonSchemaStyleValidator,
    );

    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: 'LOCKED_CONTENT_CONFLICT',
      candidate: null,
      patches: [],
    });
  });

  it('cancels an active invocation and ignores its late result', async () => {
    const runs = orchestrator();
    const descriptor = remoteDescriptor();
    let invocationSignal: AbortSignal | undefined;
    const invoke = vi.fn<AIProvider['invoke']>(
      async (_providerRequest, context) => {
        invocationSignal = context.signal;
        return await new Promise<AIProviderResponse>((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true },
          );
        });
      },
    );
    const cancel = vi.fn(async () => undefined);
    const activeProvider: AIProvider = {
      descriptor,
      invoke,
      cancel,
    };
    const queued = runs.enqueue(request(descriptor));

    const execution = runs.execute(
      queued.id,
      activeProvider,
      zodStyleValidator(),
    );
    expect(runs.getRun(queued.id).status).toBe('running');
    const cancelled = await runs.cancel(queued.id);

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      errorCode: 'CANCELLED',
      times: {
        cancelledAt: '2026-07-27T04:00:02.000Z',
      },
    });
    expect(invocationSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith(queued.id);
    await expect(execution).resolves.toMatchObject({
      status: 'cancelled',
      candidate: null,
    });
    expect(runs.getRun(queued.id).status).toBe('cancelled');
  });

  it('marks quota exhaustion and creates an idempotent retry as a new run', async () => {
    const runs = orchestrator();
    const descriptor = remoteDescriptor();
    const queued = runs.enqueue(request(descriptor));
    const quotaProvider = provider(
      descriptor,
      vi.fn(async () => {
        throw new AIProviderInvocationError('QUOTA_EXHAUSTED');
      }),
    );

    const exhausted = await runs.execute(
      queued.id,
      quotaProvider,
      zodStyleValidator(),
    );
    expect(exhausted).toMatchObject({
      status: 'quota_exhausted',
      errorCode: 'QUOTA_EXHAUSTED',
      times: {
        quotaExhaustedAt: '2026-07-27T04:00:02.000Z',
      },
    });

    const retry = runs.retry(exhausted.id, 'ai-run-retry-0001');
    const duplicateRetry = runs.retry(
      exhausted.id,
      'ai-run-retry-0001',
    );
    expect(retry).toMatchObject({
      id: 'run-0002',
      parentRunId: exhausted.id,
      attempt: 2,
      status: 'queued',
      errorCode: null,
      tokenUsage: null,
      actualCost: null,
    });
    expect(duplicateRetry.id).toBe(retry.id);
  });

  it('supports stale invalidation and enforces the published state machine', async () => {
    expect(canTransitionAIRun('queued', 'running')).toBe(true);
    expect(canTransitionAIRun('running', 'waiting_for_review')).toBe(
      true,
    );
    expect(canTransitionAIRun('waiting_for_review', 'completed')).toBe(
      true,
    );
    expect(canTransitionAIRun('completed', 'stale')).toBe(true);
    expect(canTransitionAIRun('completed', 'running')).toBe(false);
    expect(canTransitionAIRun('cancelled', 'running')).toBe(false);

    const runs = orchestrator();
    const descriptor = remoteDescriptor();
    const queued = runs.enqueue(request(descriptor));
    expect(() => runs.approve(queued.id)).toThrowError(
      expect.objectContaining<Partial<AIDomainError>>({
        code: 'INVALID_TRANSITION',
      }),
    );
    const waiting = await runs.execute(
      queued.id,
      provider(descriptor),
      zodStyleValidator(),
    );
    const completed = runs.approve(waiting.id);
    expect(
      runs.markStale(completed.id, completed.inputVersions).status,
    ).toBe('completed');

    const stale = runs.markStale(completed.id, {
      ...completed.inputVersions,
      project: 8,
    });
    expect(stale).toMatchObject({
      status: 'stale',
      errorCode: 'STALE_INPUT',
      times: {
        staleAt: '2026-07-27T04:00:04.000Z',
      },
    });
  });

  it('keeps usage and cost when schema validation fails, without persisting validator details', async () => {
    const runs = orchestrator();
    const descriptor = remoteDescriptor();
    const queued = runs.enqueue(request(descriptor));
    const validator: AIOutputValidator = {
      safeParse() {
        return {
          success: false as const,
          error: {
            detail: 'provider payload was invalid',
            apiKey: 'must-not-be-stored',
          },
        };
      },
    };

    const failed = await runs.execute(
      queued.id,
      provider(descriptor),
      validator,
    );
    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: 'VALIDATION_FAILED',
      tokenUsage: ACTUAL_USAGE,
      actualCost: ACTUAL_COST,
      candidate: null,
    });
    expect(JSON.stringify(failed)).not.toContain('must-not-be-stored');
    expect(JSON.stringify(failed)).not.toContain(
      'provider payload was invalid',
    );
  });
});

export type AIJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AIJsonValue[]
  | Readonly<{ [key: string]: AIJsonValue }>;

export const AI_PROVIDER_KINDS = [
  'byok-openai-compatible',
  'browser-local',
  'self-hosted',
] as const;

export type AIProviderKind = (typeof AI_PROVIDER_KINDS)[number];

export type AIProviderDescriptor = Readonly<{
  id: string;
  kind: AIProviderKind;
  displayName: string;
  endpoint: string | null;
  model: string;
}>;

export type AIRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'quota_exhausted'
  | 'stale';

export type AIRunErrorCode =
  | 'INSUFFICIENT_INPUT'
  | 'PROVIDER_ERROR'
  | 'VALIDATION_FAILED'
  | 'EVIDENCE_REQUIRED'
  | 'LOCKED_CONTENT_CONFLICT'
  | 'PLAINTEXT_CREDENTIAL_FORBIDDEN'
  | 'CANCELLED'
  | 'QUOTA_EXHAUSTED'
  | 'STALE_INPUT';

export type AIDomainErrorCode =
  | AIRunErrorCode
  | 'INVALID_PROVIDER'
  | 'INSECURE_ENDPOINT'
  | 'INVALID_RUN_INPUT'
  | 'INVALID_VALIDATOR'
  | 'RUN_NOT_FOUND'
  | 'PROVIDER_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_TRANSITION'
  | 'RETRY_NOT_ALLOWED';

export class AIDomainError extends Error {
  constructor(readonly code: AIDomainErrorCode) {
    super(`AI operation rejected: ${code}`);
    this.name = 'AIDomainError';
  }
}

export type AIProviderInvocationErrorCode =
  | 'QUOTA_EXHAUSTED'
  | 'PROVIDER_ERROR';

export class AIProviderInvocationError extends Error {
  constructor(readonly code: AIProviderInvocationErrorCode) {
    super(`AI provider invocation failed: ${code}`);
    this.name = 'AIProviderInvocationError';
  }
}

export type AITokenUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}>;

export type AICost = Readonly<{
  currency: string;
  amountMicros: number;
}>;

export type AIRunEstimate = Readonly<{
  tokenUsage: AITokenUsage | null;
  cost: AICost | null;
}>;

export type AIClaim = Readonly<{
  id: string;
  text: string;
  evidenceCardIds: readonly string[];
}>;

export type AIContentPatch =
  | Readonly<{
      operation: 'add' | 'replace';
      path: string;
      value: AIJsonValue;
    }>
  | Readonly<{
      operation: 'remove';
      path: string;
    }>;

export type AIReviewCandidate = Readonly<{
  value: AIJsonValue;
  claims: readonly AIClaim[];
  patches: readonly AIContentPatch[];
}>;

export type AIProviderRequest = Readonly<{
  runId: string;
  prompt: string;
  promptVersion: string;
  input: AIJsonValue;
  inputVersions: Readonly<Record<string, string | number>>;
  retrievedChunkIds: readonly string[];
  availableEvidenceCardIds: readonly string[];
  schemaVersion: string;
}>;

export type AIProviderResponse = Readonly<{
  output: unknown;
  tokenUsage: AITokenUsage | null;
  actualCost: AICost | null;
}>;

export type AIProviderInvocationContext = Readonly<{
  signal: AbortSignal;
}>;

export interface AIProvider {
  readonly descriptor: AIProviderDescriptor;
  invoke(
    request: AIProviderRequest,
    context: AIProviderInvocationContext,
  ): Promise<AIProviderResponse>;
  cancel?(runId: string): Promise<void> | void;
}

export type AISafeParseResult =
  | Readonly<{ success: true; data: AIReviewCandidate }>
  | Readonly<{ success: false; error?: unknown }>;

export type AIOutputValidator =
  | Readonly<{
      safeParse(value: unknown): AISafeParseResult;
    }>
  | ((value: unknown) => boolean);

export type AIRunTimes = Readonly<{
  createdAt: string;
  queuedAt: string;
  updatedAt: string;
  startedAt: string | null;
  waitingForReviewAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  quotaExhaustedAt: string | null;
  staleAt: string | null;
}>;

export type AIRunProviderSnapshot = Readonly<{
  id: string;
  kind: AIProviderKind;
  endpoint: string | null;
}>;

export type AIRun = Readonly<{
  id: string;
  idempotencyKey: string;
  parentRunId: string | null;
  attempt: number;
  provider: AIRunProviderSnapshot;
  model: string;
  promptVersion: string;
  inputVersions: Readonly<Record<string, string | number>>;
  retrievedChunkIds: readonly string[];
  schemaVersion: string;
  tokenUsage: AITokenUsage | null;
  estimated: AIRunEstimate | null;
  actualCost: AICost | null;
  times: AIRunTimes;
  errorCode: AIRunErrorCode | null;
  status: AIRunStatus;
  candidate: AIReviewCandidate | null;
  claims: readonly AIClaim[];
  patches: readonly AIContentPatch[];
}>;

export type EnqueueAIRunInput = Readonly<{
  idempotencyKey: string;
  provider: AIProviderDescriptor;
  promptVersion: string;
  prompt: string;
  input: AIJsonValue;
  inputVersions: Readonly<Record<string, string | number>>;
  retrievedChunkIds: readonly string[];
  availableEvidenceCardIds: readonly string[];
  lockedPaths: readonly string[];
  schemaVersion: string;
  estimated?: AIRunEstimate | null;
}>;

export type AIRunPersistenceSnapshot = Readonly<{
  run: AIRun;
  definition: EnqueueAIRunInput;
}>;

export type AIRunOrchestratorOptions = Readonly<{
  createId?: () => string;
  now?: () => string;
}>;

type NormalizedRunDefinition = Readonly<{
  idempotencyKey: string;
  provider: AIProviderDescriptor;
  promptVersion: string;
  prompt: string;
  input: AIJsonValue;
  inputVersions: Readonly<Record<string, string | number>>;
  retrievedChunkIds: readonly string[];
  availableEvidenceCardIds: readonly string[];
  lockedPaths: readonly string[];
  schemaVersion: string;
  estimated: AIRunEstimate | null;
  fingerprint: string;
  parentRunId: string | null;
  attempt: number;
}>;

type ActiveInvocation = Readonly<{
  controller: AbortController;
  cancelProvider: (() => Promise<void>) | null;
}>;

const PROVIDER_FIELDS = new Set([
  'id',
  'kind',
  'displayName',
  'endpoint',
  'model',
]);

const CREDENTIAL_FIELD =
  /^(?:api[-_]?key|authorization|bearer|client[-_]?secret|secret|access[-_]?token|refresh[-_]?token|password|credential)$/iu;

const RUN_TRANSITIONS: Readonly<
  Record<AIRunStatus, readonly AIRunStatus[]>
> = {
  queued: ['running', 'failed', 'cancelled', 'stale'],
  running: [
    'waiting_for_review',
    'failed',
    'cancelled',
    'quota_exhausted',
    'stale',
  ],
  waiting_for_review: ['completed', 'failed', 'cancelled', 'stale'],
  completed: ['stale'],
  failed: [],
  cancelled: [],
  quota_exhausted: [],
  stale: [],
};

const RETRYABLE_STATUSES = new Set<AIRunStatus>([
  'failed',
  'cancelled',
  'quota_exhausted',
  'stale',
]);

export function defineAIProvider(input: unknown): AIProviderDescriptor {
  assertNoCredentialFields(input);
  const object = plainObjectAt(input, 'provider', 'INVALID_PROVIDER');
  for (const key of Object.keys(object)) {
    if (!PROVIDER_FIELDS.has(key)) {
      throw new AIDomainError('INVALID_PROVIDER');
    }
  }
  const id = nonEmptyStringAt(
    object.id,
    'provider.id',
    'INVALID_PROVIDER',
  );
  const displayName = nonEmptyStringAt(
    object.displayName,
    'provider.displayName',
    'INVALID_PROVIDER',
  );
  const model = nonEmptyStringAt(
    object.model,
    'provider.model',
    'INVALID_PROVIDER',
  );
  const kind = object.kind;
  if (
    typeof kind !== 'string' ||
    !AI_PROVIDER_KINDS.includes(kind as AIProviderKind)
  ) {
    throw new AIDomainError('INVALID_PROVIDER');
  }
  const endpoint = endpointAt(object.endpoint, kind as AIProviderKind);
  return Object.freeze({
    id,
    kind: kind as AIProviderKind,
    displayName,
    endpoint,
    model,
  });
}

export function canTransitionAIRun(
  from: AIRunStatus,
  to: AIRunStatus,
): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export class AIRunOrchestrator {
  readonly #createId: () => string;
  readonly #now: () => string;
  readonly #runs = new Map<string, AIRun>();
  readonly #definitions = new Map<string, NormalizedRunDefinition>();
  readonly #idempotency = new Map<
    string,
    Readonly<{ runId: string; fingerprint: string }>
  >();
  readonly #executions = new Map<string, Promise<AIRun>>();
  readonly #active = new Map<string, ActiveInvocation>();

  constructor(options: AIRunOrchestratorOptions = {}) {
    this.#createId = options.createId ?? defaultCreateId;
    this.#now = options.now ?? defaultNow;
  }

  enqueue(input: EnqueueAIRunInput): AIRun {
    return this.#enqueue(input, null, 1);
  }

  getRun(runId: string): AIRun {
    const run = this.#runs.get(runId);
    if (run === undefined) {
      throw new AIDomainError('RUN_NOT_FOUND');
    }
    return run;
  }

  listRuns(): readonly AIRun[] {
    return Object.freeze([...this.#runs.values()]);
  }

  snapshot(runId: string): AIRunPersistenceSnapshot {
    const run = this.getRun(runId);
    const definition = this.#definition(runId);
    return Object.freeze({
      run,
      definition: publicRunDefinition(definition),
    });
  }

  restore(snapshot: AIRunPersistenceSnapshot): AIRun {
    assertNoCredentialFields(snapshot);
    const run = snapshot.run;
    if (
      typeof run !== 'object' ||
      run === null ||
      run.status === 'running' ||
      this.#runs.has(run.id)
    ) {
      throw new AIDomainError('INVALID_RUN_INPUT');
    }
    const definition = normalizeRunDefinition(
      snapshot.definition,
      run.parentRunId,
      run.attempt,
    );
    assertRunMatchesDefinition(run, definition);
    const candidate =
      run.candidate === null
        ? null
        : candidateAt(
            run.candidate,
            definition.availableEvidenceCardIds,
            definition.lockedPaths,
          );
    if (
      (run.status === 'waiting_for_review' ||
        run.status === 'completed') &&
      candidate === null
    ) {
      throw new AIDomainError('INVALID_RUN_INPUT');
    }
    const restored = freezeRun({
      ...run,
      candidate,
      claims: candidate?.claims ?? Object.freeze([]),
      patches: candidate?.patches ?? Object.freeze([]),
    });
    const existing = this.#idempotency.get(definition.idempotencyKey);
    if (
      existing !== undefined &&
      (existing.runId !== restored.id ||
        existing.fingerprint !== definition.fingerprint)
    ) {
      throw new AIDomainError('IDEMPOTENCY_CONFLICT');
    }
    this.#runs.set(restored.id, restored);
    this.#definitions.set(restored.id, definition);
    this.#idempotency.set(definition.idempotencyKey, {
      runId: restored.id,
      fingerprint: definition.fingerprint,
    });
    return restored;
  }

  execute(
    runId: string,
    provider: AIProvider,
    validator: AIOutputValidator,
  ): Promise<AIRun> {
    const activeExecution = this.#executions.get(runId);
    if (activeExecution !== undefined) {
      return activeExecution;
    }
    const current = this.getRun(runId);
    if (current.status !== 'queued') {
      return Promise.resolve(current);
    }
    this.#assertMatchingProvider(current, provider);
    assertValidator(validator);
    this.#setRun(
      transitionRun(current, 'running', this.#timestamp(), null),
    );

    const execution = this.#invoke(runId, provider, validator);
    this.#executions.set(runId, execution);
    void execution.then(
      () => {
        if (this.#executions.get(runId) === execution) {
          this.#executions.delete(runId);
        }
      },
      () => {
        if (this.#executions.get(runId) === execution) {
          this.#executions.delete(runId);
        }
      },
    );
    return execution;
  }

  async cancel(runId: string): Promise<AIRun> {
    const current = this.getRun(runId);
    if (current.status === 'cancelled') {
      return current;
    }
    if (
      current.status !== 'queued' &&
      current.status !== 'running' &&
      current.status !== 'waiting_for_review'
    ) {
      throw new AIDomainError('INVALID_TRANSITION');
    }
    const active = this.#active.get(runId);
    active?.controller.abort();
    const cancelled = transitionRun(
      current,
      'cancelled',
      this.#timestamp(),
      'CANCELLED',
    );
    this.#setRun(cancelled);
    if (active?.cancelProvider !== null && active?.cancelProvider !== undefined) {
      try {
        await active.cancelProvider();
      } catch {
        // Cancellation is authoritative locally. Provider details are not logged.
      }
    }
    return this.getRun(runId);
  }

  approve(runId: string): AIRun {
    const current = this.getRun(runId);
    if (current.status !== 'waiting_for_review') {
      throw new AIDomainError('INVALID_TRANSITION');
    }
    const completed = transitionRun(
      current,
      'completed',
      this.#timestamp(),
      null,
    );
    this.#setRun(completed);
    return completed;
  }

  markStale(
    runId: string,
    currentInputVersions: Readonly<Record<string, string | number>>,
  ): AIRun {
    const current = this.getRun(runId);
    const versions = normalizeInputVersions(currentInputVersions);
    if (
      stableSerialize(versionsToJson(versions)) ===
      stableSerialize(versionsToJson(current.inputVersions))
    ) {
      return current;
    }
    if (current.status === 'stale') {
      return current;
    }
    if (!canTransitionAIRun(current.status, 'stale')) {
      throw new AIDomainError('INVALID_TRANSITION');
    }
    this.#active.get(runId)?.controller.abort();
    const stale = transitionRun(
      current,
      'stale',
      this.#timestamp(),
      'STALE_INPUT',
    );
    this.#setRun(stale);
    return stale;
  }

  retry(runId: string, idempotencyKey: string): AIRun {
    const source = this.getRun(runId);
    if (!RETRYABLE_STATUSES.has(source.status)) {
      throw new AIDomainError('RETRY_NOT_ALLOWED');
    }
    const definition = this.#definition(runId);
    return this.#enqueue(
      {
        idempotencyKey,
        provider: definition.provider,
        promptVersion: definition.promptVersion,
        prompt: definition.prompt,
        input: definition.input,
        inputVersions: definition.inputVersions,
        retrievedChunkIds: definition.retrievedChunkIds,
        availableEvidenceCardIds: definition.availableEvidenceCardIds,
        lockedPaths: definition.lockedPaths,
        schemaVersion: definition.schemaVersion,
        estimated: definition.estimated,
      },
      source.id,
      source.attempt + 1,
    );
  }

  #enqueue(
    input: EnqueueAIRunInput,
    parentRunId: string | null,
    attempt: number,
  ): AIRun {
    const definition = normalizeRunDefinition(input, parentRunId, attempt);
    const existing = this.#idempotency.get(definition.idempotencyKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== definition.fingerprint) {
        throw new AIDomainError('IDEMPOTENCY_CONFLICT');
      }
      return this.getRun(existing.runId);
    }

    const id = nonEmptyStringAt(
      this.#createId(),
      'run.id',
      'INVALID_RUN_INPUT',
    );
    if (this.#runs.has(id)) {
      throw new AIDomainError('INVALID_RUN_INPUT');
    }
    const at = this.#timestamp();
    const run = createQueuedRun(id, definition, at);
    this.#runs.set(id, run);
    this.#definitions.set(id, definition);
    this.#idempotency.set(definition.idempotencyKey, {
      runId: id,
      fingerprint: definition.fingerprint,
    });

    if (!hasSufficientInput(definition)) {
      const failed = transitionRun(
        run,
        'failed',
        this.#timestamp(),
        'INSUFFICIENT_INPUT',
      );
      this.#setRun(failed);
      return failed;
    }
    return run;
  }

  async #invoke(
    runId: string,
    provider: AIProvider,
    validator: AIOutputValidator,
  ): Promise<AIRun> {
    const definition = this.#definition(runId);
    const controller = new AbortController();
    const cancelProvider =
      provider.cancel === undefined
        ? null
        : async () => {
            await provider.cancel?.(runId);
          };
    this.#active.set(
      runId,
      Object.freeze({
        controller,
        cancelProvider,
      }),
    );

    try {
      const providerResponse = await provider.invoke(
        createProviderRequest(runId, definition),
        Object.freeze({ signal: controller.signal }),
      );
      const current = this.getRun(runId);
      if (
        current.status === 'cancelled' ||
        current.status === 'stale'
      ) {
        return current;
      }

      const tokenUsage = tokenUsageAt(providerResponse.tokenUsage);
      const actualCost = costAt(providerResponse.actualCost);
      this.#setRun(
        freezeRun({
          ...current,
          tokenUsage,
          actualCost,
        }),
      );

      const validated = runValidator(validator, providerResponse.output);
      if (validated === null) {
        return this.#fail(runId, 'VALIDATION_FAILED');
      }

      let candidateResult: AIReviewCandidate;
      try {
        candidateResult = candidateAt(
          validated,
          definition.availableEvidenceCardIds,
          definition.lockedPaths,
        );
      } catch (error) {
        if (error instanceof AIDomainError) {
          if (
            error.code === 'EVIDENCE_REQUIRED' ||
            error.code === 'LOCKED_CONTENT_CONFLICT' ||
            error.code === 'PLAINTEXT_CREDENTIAL_FORBIDDEN'
          ) {
            return this.#fail(runId, error.code);
          }
        }
        return this.#fail(runId, 'VALIDATION_FAILED');
      }

      const withCandidate = freezeRun({
        ...this.getRun(runId),
        candidate: candidateResult,
        claims: candidateResult.claims,
        patches: candidateResult.patches,
      });
      const waiting = transitionRun(
        withCandidate,
        'waiting_for_review',
        this.#timestamp(),
        null,
      );
      this.#setRun(waiting);
      return waiting;
    } catch (error) {
      const current = this.getRun(runId);
      if (
        current.status === 'cancelled' ||
        current.status === 'stale'
      ) {
        return current;
      }
      if (
        error instanceof AIProviderInvocationError &&
        error.code === 'QUOTA_EXHAUSTED'
      ) {
        const exhausted = transitionRun(
          current,
          'quota_exhausted',
          this.#timestamp(),
          'QUOTA_EXHAUSTED',
        );
        this.#setRun(exhausted);
        return exhausted;
      }
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        const cancelled = transitionRun(
          current,
          'cancelled',
          this.#timestamp(),
          'CANCELLED',
        );
        this.#setRun(cancelled);
        return cancelled;
      }
      return this.#fail(runId, 'PROVIDER_ERROR');
    } finally {
      this.#active.delete(runId);
    }
  }

  #fail(runId: string, errorCode: AIRunErrorCode): AIRun {
    const current = this.getRun(runId);
    if (current.status !== 'running' && current.status !== 'waiting_for_review') {
      return current;
    }
    const failed = transitionRun(
      freezeRun({
        ...current,
        candidate: null,
        claims: Object.freeze([]),
        patches: Object.freeze([]),
      }),
      'failed',
      this.#timestamp(),
      errorCode,
    );
    this.#setRun(failed);
    return failed;
  }

  #definition(runId: string): NormalizedRunDefinition {
    const definition = this.#definitions.get(runId);
    if (definition === undefined) {
      throw new AIDomainError('RUN_NOT_FOUND');
    }
    return definition;
  }

  #assertMatchingProvider(run: AIRun, provider: AIProvider): void {
    if (typeof provider.invoke !== 'function') {
      throw new AIDomainError('INVALID_PROVIDER');
    }
    const descriptor = defineAIProvider(provider.descriptor);
    if (
      descriptor.id !== run.provider.id ||
      descriptor.kind !== run.provider.kind ||
      descriptor.endpoint !== run.provider.endpoint ||
      descriptor.model !== run.model
    ) {
      throw new AIDomainError('PROVIDER_MISMATCH');
    }
  }

  #setRun(run: AIRun): void {
    this.#runs.set(run.id, run);
  }

  #timestamp(): string {
    return isoDateTimeAt(this.#now());
  }
}

function normalizeRunDefinition(
  input: EnqueueAIRunInput,
  parentRunId: string | null,
  attempt: number,
): NormalizedRunDefinition {
  assertNoCredentialFields(input.input);
  const idempotencyKey = nonEmptyStringAt(
    input.idempotencyKey,
    'run.idempotencyKey',
    'INVALID_RUN_INPUT',
  );
  const provider = defineAIProvider(input.provider);
  const promptVersion = stringAt(
    input.promptVersion,
    'run.promptVersion',
    'INVALID_RUN_INPUT',
  );
  const prompt = stringAt(
    input.prompt,
    'run.prompt',
    'INVALID_RUN_INPUT',
  );
  const normalizedInput = jsonValueAt(input.input);
  const inputVersions = normalizeInputVersions(input.inputVersions);
  const retrievedChunkIds = uniqueStringListAt(
    input.retrievedChunkIds,
    'run.retrievedChunkIds',
  );
  const availableEvidenceCardIds = uniqueStringListAt(
    input.availableEvidenceCardIds,
    'run.availableEvidenceCardIds',
  );
  const lockedPaths = uniquePathListAt(input.lockedPaths);
  const schemaVersion = stringAt(
    input.schemaVersion,
    'run.schemaVersion',
    'INVALID_RUN_INPUT',
  );
  const estimated =
    input.estimated === undefined || input.estimated === null
      ? null
      : estimateAt(input.estimated);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new AIDomainError('INVALID_RUN_INPUT');
  }
  if (parentRunId !== null) {
    nonEmptyStringAt(
      parentRunId,
      'run.parentRunId',
      'INVALID_RUN_INPUT',
    );
  }
  const fingerprintValue: AIJsonValue = {
    parentRunId,
    provider: {
      id: provider.id,
      kind: provider.kind,
      displayName: provider.displayName,
      endpoint: provider.endpoint,
      model: provider.model,
    },
    promptVersion,
    prompt,
    input: normalizedInput,
    inputVersions: versionsToJson(inputVersions),
    retrievedChunkIds,
    availableEvidenceCardIds,
    lockedPaths,
    schemaVersion,
    estimated: estimateToJson(estimated),
    attempt,
  };
  const fingerprint = stableSerialize(fingerprintValue);
  return Object.freeze({
    idempotencyKey,
    provider,
    promptVersion,
    prompt,
    input: normalizedInput,
    inputVersions,
    retrievedChunkIds,
    availableEvidenceCardIds,
    lockedPaths,
    schemaVersion,
    estimated,
    fingerprint,
    parentRunId,
    attempt,
  });
}

function createQueuedRun(
  id: string,
  definition: NormalizedRunDefinition,
  at: string,
): AIRun {
  return freezeRun({
    id,
    idempotencyKey: definition.idempotencyKey,
    parentRunId: definition.parentRunId,
    attempt: definition.attempt,
    provider: Object.freeze({
      id: definition.provider.id,
      kind: definition.provider.kind,
      endpoint: definition.provider.endpoint,
    }),
    model: definition.provider.model,
    promptVersion: definition.promptVersion,
    inputVersions: definition.inputVersions,
    retrievedChunkIds: definition.retrievedChunkIds,
    schemaVersion: definition.schemaVersion,
    tokenUsage: null,
    estimated: definition.estimated,
    actualCost: null,
    times: Object.freeze({
      createdAt: at,
      queuedAt: at,
      updatedAt: at,
      startedAt: null,
      waitingForReviewAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
      quotaExhaustedAt: null,
      staleAt: null,
    }),
    errorCode: null,
    status: 'queued',
    candidate: null,
    claims: Object.freeze([]),
    patches: Object.freeze([]),
  });
}

function transitionRun(
  run: AIRun,
  nextStatus: AIRunStatus,
  at: string,
  errorCode: AIRunErrorCode | null,
): AIRun {
  if (!canTransitionAIRun(run.status, nextStatus)) {
    throw new AIDomainError('INVALID_TRANSITION');
  }
  const times: AIRunTimes = Object.freeze({
    ...run.times,
    updatedAt: at,
    startedAt:
      nextStatus === 'running' ? at : run.times.startedAt,
    waitingForReviewAt:
      nextStatus === 'waiting_for_review'
        ? at
        : run.times.waitingForReviewAt,
    completedAt:
      nextStatus === 'completed' ? at : run.times.completedAt,
    failedAt: nextStatus === 'failed' ? at : run.times.failedAt,
    cancelledAt:
      nextStatus === 'cancelled' ? at : run.times.cancelledAt,
    quotaExhaustedAt:
      nextStatus === 'quota_exhausted'
        ? at
        : run.times.quotaExhaustedAt,
    staleAt: nextStatus === 'stale' ? at : run.times.staleAt,
  });
  return freezeRun({
    ...run,
    status: nextStatus,
    errorCode,
    times,
  });
}

function freezeRun(run: AIRun): AIRun {
  return Object.freeze({
    ...run,
    provider: Object.freeze({ ...run.provider }),
    inputVersions: Object.freeze({ ...run.inputVersions }),
    retrievedChunkIds: Object.freeze([...run.retrievedChunkIds]),
    tokenUsage:
      run.tokenUsage === null
        ? null
        : Object.freeze({ ...run.tokenUsage }),
    estimated:
      run.estimated === null
        ? null
        : Object.freeze({
            tokenUsage:
              run.estimated.tokenUsage === null
                ? null
                : Object.freeze({ ...run.estimated.tokenUsage }),
            cost:
              run.estimated.cost === null
                ? null
                : Object.freeze({ ...run.estimated.cost }),
          }),
    actualCost:
      run.actualCost === null
        ? null
        : Object.freeze({ ...run.actualCost }),
    times: Object.freeze({ ...run.times }),
    candidate: run.candidate,
    claims: Object.freeze([...run.claims]),
    patches: Object.freeze([...run.patches]),
  });
}

function createProviderRequest(
  runId: string,
  definition: NormalizedRunDefinition,
): AIProviderRequest {
  return Object.freeze({
    runId,
    prompt: definition.prompt,
    promptVersion: definition.promptVersion,
    input: definition.input,
    inputVersions: definition.inputVersions,
    retrievedChunkIds: definition.retrievedChunkIds,
    availableEvidenceCardIds: definition.availableEvidenceCardIds,
    schemaVersion: definition.schemaVersion,
  });
}

function publicRunDefinition(
  definition: NormalizedRunDefinition,
): EnqueueAIRunInput {
  return Object.freeze({
    idempotencyKey: definition.idempotencyKey,
    provider: definition.provider,
    promptVersion: definition.promptVersion,
    prompt: definition.prompt,
    input: definition.input,
    inputVersions: definition.inputVersions,
    retrievedChunkIds: definition.retrievedChunkIds,
    availableEvidenceCardIds: definition.availableEvidenceCardIds,
    lockedPaths: definition.lockedPaths,
    schemaVersion: definition.schemaVersion,
    estimated: definition.estimated,
  });
}

function assertRunMatchesDefinition(
  run: AIRun,
  definition: NormalizedRunDefinition,
): void {
  const validStatus = Object.prototype.hasOwnProperty.call(
    RUN_TRANSITIONS,
    run.status,
  );
  if (
    !validStatus ||
    typeof run.id !== 'string' ||
    run.id.trim().length === 0 ||
    run.id !== run.id.trim() ||
    run.idempotencyKey !== definition.idempotencyKey ||
    run.provider.id !== definition.provider.id ||
    run.provider.kind !== definition.provider.kind ||
    run.provider.endpoint !== definition.provider.endpoint ||
    run.model !== definition.provider.model ||
    run.promptVersion !== definition.promptVersion ||
    run.schemaVersion !== definition.schemaVersion ||
    stableSerialize(versionsToJson(run.inputVersions)) !==
      stableSerialize(versionsToJson(definition.inputVersions)) ||
    stableSerialize(run.retrievedChunkIds) !==
      stableSerialize(definition.retrievedChunkIds) ||
    !Number.isSafeInteger(run.attempt) ||
    run.attempt < 1
  ) {
    throw new AIDomainError('INVALID_RUN_INPUT');
  }
}

function hasSufficientInput(
  definition: NormalizedRunDefinition,
): boolean {
  return (
    definition.prompt.trim().length > 0 &&
    isMeaningfulJson(definition.input) &&
    Object.keys(definition.inputVersions).length > 0 &&
    definition.retrievedChunkIds.length > 0 &&
    definition.availableEvidenceCardIds.length > 0
  );
}

function isMeaningfulJson(value: AIJsonValue): boolean {
  if (value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  return Array.isArray(value)
    ? value.length > 0
    : Object.keys(value).length > 0;
}

function runValidator(
  validator: AIOutputValidator,
  value: unknown,
): AIReviewCandidate | null {
  try {
    if (typeof validator === 'function') {
      return validator(value) ? (value as AIReviewCandidate) : null;
    }
    const result = validator.safeParse(value);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function assertValidator(validator: AIOutputValidator): void {
  if (
    typeof validator !== 'function' &&
    (typeof validator !== 'object' ||
      validator === null ||
      typeof validator.safeParse !== 'function')
  ) {
    throw new AIDomainError('INVALID_VALIDATOR');
  }
}

function candidateAt(
  value: unknown,
  availableEvidenceCardIds: readonly string[],
  lockedPaths: readonly string[],
): AIReviewCandidate {
  assertNoCredentialFields(value);
  const object = plainObjectAt(
    value,
    'candidate',
    'VALIDATION_FAILED',
  );
  const candidateValue = jsonValueAt(object.value);
  if (!Array.isArray(object.claims) || !Array.isArray(object.patches)) {
    throw new AIDomainError('VALIDATION_FAILED');
  }
  const availableEvidence = new Set(availableEvidenceCardIds);
  const claimIds = new Set<string>();
  const claims = object.claims.map((rawClaim) => {
    const claim = plainObjectAt(
      rawClaim,
      'candidate.claim',
      'VALIDATION_FAILED',
    );
    const id = nonEmptyStringAt(
      claim.id,
      'candidate.claim.id',
      'VALIDATION_FAILED',
    );
    if (claimIds.has(id)) {
      throw new AIDomainError('VALIDATION_FAILED');
    }
    claimIds.add(id);
    const text = nonEmptyStringAt(
      claim.text,
      'candidate.claim.text',
      'VALIDATION_FAILED',
    );
    const evidenceCardIds = uniqueStringListAt(
      claim.evidenceCardIds,
      'candidate.claim.evidenceCardIds',
    );
    if (
      evidenceCardIds.length === 0 ||
      evidenceCardIds.some((evidenceId) => !availableEvidence.has(evidenceId))
    ) {
      throw new AIDomainError('EVIDENCE_REQUIRED');
    }
    return Object.freeze({
      id,
      text,
      evidenceCardIds,
    });
  });
  const patches = object.patches.map((rawPatch) =>
    patchAt(rawPatch, lockedPaths),
  );
  return Object.freeze({
    value: candidateValue,
    claims: Object.freeze(claims),
    patches: Object.freeze(patches),
  });
}

function patchAt(
  value: unknown,
  lockedPaths: readonly string[],
): AIContentPatch {
  const object = plainObjectAt(
    value,
    'candidate.patch',
    'VALIDATION_FAILED',
  );
  const operation = object.operation;
  if (
    operation !== 'add' &&
    operation !== 'replace' &&
    operation !== 'remove'
  ) {
    throw new AIDomainError('VALIDATION_FAILED');
  }
  const path = jsonPointerAt(object.path, 'candidate.patch.path');
  if (lockedPaths.some((lockedPath) => pathsConflict(path, lockedPath))) {
    throw new AIDomainError('LOCKED_CONTENT_CONFLICT');
  }
  if (operation === 'remove') {
    return Object.freeze({ operation, path });
  }
  return Object.freeze({
    operation,
    path,
    value: jsonValueAt(object.value),
  });
}

function pathsConflict(left: string, right: string): boolean {
  return (
    left === right ||
    left === '/' ||
    right === '/' ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function endpointAt(
  value: unknown,
  kind: AIProviderKind,
): string | null {
  if (kind === 'browser-local') {
    if (value !== null) {
      throw new AIDomainError('INVALID_PROVIDER');
    }
    return null;
  }
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new AIDomainError('INVALID_PROVIDER');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AIDomainError('INVALID_PROVIDER');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new AIDomainError('PLAINTEXT_CREDENTIAL_FORBIDDEN');
  }
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_FIELD.test(key)) {
      throw new AIDomainError('PLAINTEXT_CREDENTIAL_FORBIDDEN');
    }
  }
  const localHost =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && localHost)
  ) {
    throw new AIDomainError('INSECURE_ENDPOINT');
  }
  return value;
}

function normalizeInputVersions(
  value: Readonly<Record<string, string | number>>,
): Readonly<Record<string, string | number>> {
  const object = plainObjectAt(
    value,
    'run.inputVersions',
    'INVALID_RUN_INPUT',
  );
  const result: Record<string, string | number> = {};
  for (const key of Object.keys(object).sort()) {
    const normalizedKey = nonEmptyStringAt(
      key,
      'run.inputVersions.key',
      'INVALID_RUN_INPUT',
    );
    const version = object[key];
    if (
      (typeof version === 'string' &&
        version.length > 0 &&
        version === version.trim()) ||
      (typeof version === 'number' &&
        Number.isSafeInteger(version) &&
        version >= 0)
    ) {
      result[normalizedKey] = version;
      continue;
    }
    throw new AIDomainError('INVALID_RUN_INPUT');
  }
  return Object.freeze(result);
}

function uniqueStringListAt(
  value: unknown,
  path: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new AIDomainError('INVALID_RUN_INPUT');
  }
  const result = value.map((item, index) =>
    nonEmptyStringAt(
      item,
      `${path}[${String(index)}]`,
      'INVALID_RUN_INPUT',
    ),
  );
  if (new Set(result).size !== result.length) {
    throw new AIDomainError('INVALID_RUN_INPUT');
  }
  return Object.freeze(result);
}

function uniquePathListAt(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new AIDomainError('INVALID_RUN_INPUT');
  }
  const result = value.map((item) =>
    jsonPointerAt(item, 'run.lockedPath'),
  );
  if (new Set(result).size !== result.length) {
    throw new AIDomainError('INVALID_RUN_INPUT');
  }
  return Object.freeze(result);
}

function jsonPointerAt(value: unknown, path: string): string {
  const pointer = stringAt(value, path, 'INVALID_RUN_INPUT');
  if (
    pointer.length === 0 ||
    !pointer.startsWith('/') ||
    pointer.includes('//')
  ) {
    throw new AIDomainError('INVALID_RUN_INPUT');
  }
  return pointer;
}

function tokenUsageAt(value: unknown): AITokenUsage | null {
  if (value === null) {
    return null;
  }
  const object = plainObjectAt(
    value,
    'provider.tokenUsage',
    'PROVIDER_ERROR',
  );
  const inputTokens = nonNegativeIntegerAt(object.inputTokens);
  const outputTokens = nonNegativeIntegerAt(object.outputTokens);
  const totalTokens = nonNegativeIntegerAt(object.totalTokens);
  if (totalTokens !== inputTokens + outputTokens) {
    throw new AIDomainError('PROVIDER_ERROR');
  }
  return Object.freeze({
    inputTokens,
    outputTokens,
    totalTokens,
  });
}

function costAt(value: unknown): AICost | null {
  if (value === null) {
    return null;
  }
  const object = plainObjectAt(
    value,
    'provider.cost',
    'PROVIDER_ERROR',
  );
  const currency = nonEmptyStringAt(
    object.currency,
    'provider.cost.currency',
    'PROVIDER_ERROR',
  ).toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new AIDomainError('PROVIDER_ERROR');
  }
  return Object.freeze({
    currency,
    amountMicros: nonNegativeIntegerAt(object.amountMicros),
  });
}

function estimateAt(value: unknown): AIRunEstimate {
  const object = plainObjectAt(
    value,
    'run.estimated',
    'INVALID_RUN_INPUT',
  );
  return Object.freeze({
    tokenUsage: tokenUsageAt(object.tokenUsage),
    cost: costAt(object.cost),
  });
}

function nonNegativeIntegerAt(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new AIDomainError('PROVIDER_ERROR');
  }
  return value;
}

function stringAt(
  value: unknown,
  _path: string,
  code: AIDomainErrorCode,
): string {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new AIDomainError(code);
  }
  return value;
}

function nonEmptyStringAt(
  value: unknown,
  path: string,
  code: AIDomainErrorCode,
): string {
  const result = stringAt(value, path, code);
  if (result.length === 0) {
    throw new AIDomainError(code);
  }
  return result;
}

function plainObjectAt(
  value: unknown,
  _path: string,
  code: AIDomainErrorCode,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new AIDomainError(code);
  }
  return value as Record<string, unknown>;
}

function jsonValueAt(
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
      throw new AIDomainError('INVALID_RUN_INPUT');
    }
    return value;
  }
  if (typeof value !== 'object' || value === null) {
    throw new AIDomainError('INVALID_RUN_INPUT');
  }
  if (seen.has(value)) {
    throw new AIDomainError('INVALID_RUN_INPUT');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item) => jsonValueAt(item, seen));
    seen.delete(value);
    return Object.freeze(result);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AIDomainError('INVALID_RUN_INPUT');
  }
  const result: Record<string, AIJsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = jsonValueAt(
      (value as Record<string, unknown>)[key],
      seen,
    );
  }
  seen.delete(value);
  return Object.freeze(result);
}

function assertNoCredentialFields(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoCredentialFields(item, seen);
    }
    return;
  }
  for (const [key, item] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (CREDENTIAL_FIELD.test(key)) {
      throw new AIDomainError('PLAINTEXT_CREDENTIAL_FORBIDDEN');
    }
    assertNoCredentialFields(item, seen);
  }
}

function versionsToJson(
  versions: Readonly<Record<string, string | number>>,
): AIJsonValue {
  const result: Record<string, AIJsonValue> = {};
  for (const [key, value] of Object.entries(versions)) {
    result[key] = value;
  }
  return result;
}

function estimateToJson(estimate: AIRunEstimate | null): AIJsonValue {
  if (estimate === null) {
    return null;
  }
  return {
    tokenUsage:
      estimate.tokenUsage === null
        ? null
        : {
            inputTokens: estimate.tokenUsage.inputTokens,
            outputTokens: estimate.tokenUsage.outputTokens,
            totalTokens: estimate.tokenUsage.totalTokens,
          },
    cost:
      estimate.cost === null
        ? null
        : {
            currency: estimate.cost.currency,
            amountMicros: estimate.cost.amountMicros,
          },
  };
}

function stableSerialize(value: AIJsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  const objectValue = value as Readonly<Record<string, AIJsonValue>>;
  return `{${Object.keys(objectValue)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableSerialize(objectValue[key] ?? null)}`,
    )
    .join(',')}}`;
}

function isoDateTimeAt(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AIDomainError('INVALID_RUN_INPUT');
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new AIDomainError('INVALID_RUN_INPUT');
  }
  return value;
}

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultCreateId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new AIDomainError('INVALID_RUN_INPUT');
  }
  return globalThis.crypto.randomUUID();
}

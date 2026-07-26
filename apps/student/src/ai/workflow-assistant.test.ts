import { describe, expect, it, vi } from 'vitest';
import type {
  AIProvider,
  AIProviderResponse,
} from './ai-provider.js';
import { AIProviderInvocationError } from './ai-provider.js';
import {
  WorkflowAssistant,
  createWorkflowCandidateValidator,
  type WorkflowAssistantApplyPort,
  type WorkflowAssistantSession,
} from './workflow-assistant.js';
import {
  MemoryWorkflowAssistantStore,
  type WorkflowAssistantStore,
} from './workflow-assistant-store.js';
import type {
  EvidenceCard,
  Project,
  SourceChunk,
} from '../workbench/project-model.js';

const PROJECT_ID = '01900000-0000-7000-8000-000000000101';
const TASK_ID = '01900000-0000-7000-8000-000000000102';
const FILE_ID = '01900000-0000-7000-8000-000000000103';
const RUBRIC_ID = '01900000-0000-7000-8000-000000000104';
const OUTLINE_ID = '01900000-0000-7000-8000-000000000105';
const ARTIFACT_ID = '01900000-0000-7000-8000-000000000106';
const CREATED_AT = '2026-07-27T01:00:00.000Z';

function id(index: number): string {
  return `01900000-0000-7000-8000-${String(index).padStart(12, '0')}`;
}

function chunks(): SourceChunk[] {
  return [0, 1, 2].map((index) => {
    const text = `第 ${String(index + 1)} 页的可核验资料，包含事实、数字与结论。`;
    return {
      id: id(200 + index),
      version: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      projectId: PROJECT_ID,
      sourceFileId: FILE_ID,
      sourceFileVersion: 1,
      ordinal: index,
      pageNumber: index + 1,
      pageLabel: String(index + 1),
      characterStart: index * 100,
      characterEnd: index * 100 + text.length,
      text,
      contentSha256: String(index + 1).repeat(64),
    };
  });
}

function evidence(sourceChunks: readonly SourceChunk[]): EvidenceCard[] {
  return Array.from({ length: 6 }, (_, index) => {
    const source = sourceChunks[index % sourceChunks.length]!;
    const quote = source.text.slice(0, Math.min(12, source.text.length));
    return {
      id: id(300 + index),
      version: 2,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      projectId: PROJECT_ID,
      sourceFileId: FILE_ID,
      sourceChunkId: source.id,
      sourceFileVersion: 1,
      pageNumber: source.pageNumber,
      characterStart: source.characterStart,
      characterEnd: source.characterStart + quote.length,
      quote,
      kind: index % 2 === 0 ? 'fact' : 'statistic',
      note: `证据 ${String(index + 1)}`,
      citation: `资料第 ${String(source.pageNumber)} 页`,
      status: 'verified',
      stance: 'support',
      confirmationStatus: 'confirmed',
      userConfirmedAt: CREATED_AT,
    };
  });
}

function project(): Project {
  const sourceChunks = chunks();
  const evidenceCards = evidence(sourceChunks);
  return {
    schemaVersion: 1,
    id: PROJECT_ID,
    version: 7,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    title: '课程汇报',
    status: 'active',
    statusBeforeTrash: null,
    trashedAt: null,
    taskDefinition: {
      id: TASK_ID,
      version: 2,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      taskName: '把资料整理成三页课堂汇报',
      audience: '授课教师与同学',
      dueAt: '2026-08-15T09:00:00.000Z',
      lengthTarget: { unit: 'pages', value: 3 },
      presentationDurationMinutes: 6,
      outputFormats: ['pptx', 'pdf'],
      rubric: [
        {
          id: RUBRIC_ID,
          version: 1,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          title: '论证与证据',
          description: '所有结论均需有来源',
          weightPercent: 100,
        },
      ],
      tone: '清晰、克制',
      mustInclude: ['核心结论'],
      mustAvoid: ['无来源数字'],
    },
    sourceFiles: [
      {
        id: FILE_ID,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        projectId: PROJECT_ID,
        fileName: '课程资料.txt',
        mediaType: 'text/plain',
        extension: 'txt',
        sizeBytes: 500,
        contentSha256: 'a'.repeat(64),
        blobId: 'blob:course',
        sourceVersion: 1,
        status: 'ready',
        parseProgress: 100,
        pageCount: 3,
        error: null,
        replacedByFileId: null,
      },
    ],
    sourceChunks,
    evidenceCards,
    outlines: [
      {
        id: OUTLINE_ID,
        version: 3,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        projectId: PROJECT_ID,
        title: '已确认大纲',
        status: 'locked',
        lockedAt: CREATED_AT,
        nodes: [0, 1, 2].map((index) => ({
          id: id(400 + index),
          version: 2,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          position: index,
          title: `第 ${String(index + 1)} 页`,
          conclusion: `结论 ${String(index + 1)}`,
          evidenceCardIds: [
            evidenceCards[index * 2]!.id,
            evidenceCards[index * 2 + 1]!.id,
          ],
          coveredRequirements: ['核心结论'],
          rubricCriterionIds: [RUBRIC_ID],
          locked: true,
        })),
      },
    ],
    activeOutlineId: OUTLINE_ID,
    artifacts: [
      {
        id: ARTIFACT_ID,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        projectId: PROJECT_ID,
        outlineId: OUTLINE_ID,
        outlineVersion: 3,
        kind: 'presentation',
        status: 'draft',
        payload: {
          format: 'zuocheng-draft-artifact',
          formatVersion: 1,
          id: ARTIFACT_ID,
          version: 1,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          pages: [],
        },
        blobId: null,
        contentSha256: null,
        staleBecause: [],
        errorCode: null,
      },
    ],
    verificationResults: [],
  };
}

function candidateFor(
  workflow: 'evidence' | 'outline' | 'draft',
  current: Project,
): unknown {
  const evidenceIds = current.evidenceCards.map((card) => card.id);
  const claims = [
    {
      id: 'claim-1',
      text: '候选内容来自已有证据',
      evidenceCardIds: [evidenceIds[0]],
    },
  ];
  if (workflow === 'evidence') {
    const chunk = current.sourceChunks[0]!;
    return {
      value: {
        kind: 'evidence_suggestions',
        completeness: 'complete',
        warnings: [],
        suggestions: [
          {
            candidateId: 'evidence-candidate-1',
            sourceChunkId: chunk.id,
            characterStart: chunk.characterStart,
            characterEnd: chunk.characterStart + 8,
            kind: 'fact',
            stance: 'supports',
            note: '可用于支撑核心结论',
            citation: '课程资料第 1 页',
          },
        ],
      },
      claims,
      patches: [
        {
          operation: 'add',
          path: '/evidenceCards/-',
          value: { candidateId: 'evidence-candidate-1' },
        },
      ],
    };
  }
  if (workflow === 'outline') {
    return {
      value: {
        kind: 'outline_options',
        completeness: 'complete',
        warnings: [],
        options: ['问题—证据—行动', '现状—判断—建议'].map(
          (title, optionIndex) => ({
            candidateId: `outline-${String(optionIndex + 1)}`,
            title,
            nodes: [0, 1, 2].map((index) => ({
              title: `${String(index + 1)}. ${title}`,
              conclusion: `结论 ${String(index + 1)}`,
              evidenceCardIds: [
                evidenceIds[index * 2],
                evidenceIds[index * 2 + 1],
              ],
              coveredRequirements: ['核心结论'],
              rubricCriterionIds: [RUBRIC_ID],
            })),
          }),
        ),
      },
      claims,
      patches: [
        {
          operation: 'add',
          path: '/outlines/-',
          value: { candidateId: 'outline-1' },
        },
      ],
    };
  }
  return {
    value: {
      kind: 'three_page_draft',
      completeness: 'complete',
      warnings: [],
      outlineId: OUTLINE_ID,
      pages: [0, 1, 2].map((index) => ({
        candidateId: `page-${String(index + 1)}`,
        outlineNodeId: current.outlines[0]!.nodes[index]!.id,
        title: `第 ${String(index + 1)} 页`,
        conclusion: `结论 ${String(index + 1)}`,
        body: `正文 ${String(index + 1)}`,
        evidenceCardIds: [
          evidenceIds[index * 2],
          evidenceIds[index * 2 + 1],
        ],
        visualNote: '使用简洁图示',
        speakerNotes: `讲解提示 ${String(index + 1)}`,
        estimatedSeconds: 90,
        rubricCriterionIds: [RUBRIC_ID],
      })),
    },
    claims,
    patches: [
      {
        operation: 'add',
        path: '/artifacts/-/pages/-',
        value: { count: 3 },
      },
    ],
  };
}

function provider(output: unknown): AIProvider {
  return {
    descriptor: {
      id: 'personal-openai-compatible',
      kind: 'byok-openai-compatible',
      displayName: '个人模型',
      endpoint: 'https://models.example.test/v1',
      model: 'example-chat',
    },
    invoke: vi.fn(
      async (): Promise<AIProviderResponse> => ({
        output,
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
        actualCost: null,
      }),
    ),
    cancel: vi.fn(),
  };
}

function applyPort(current: Project): WorkflowAssistantApplyPort {
  return {
    createEvidence: vi.fn(async () => current),
    createOutline: vi.fn(async () => current),
    ensureDraftArtifact: vi.fn(async () => current),
    insertDraftPage: vi.fn(async () => current),
  };
}

describe('workflow candidate schemas', () => {
  it('accepts structured candidates and rejects claims that cite unknown evidence', () => {
    const current = project();
    const validator = createWorkflowCandidateValidator('outline', current);
    expect(
      validator.safeParse(candidateFor('outline', current)).success,
    ).toBe(true);

    const invalid = candidateFor('outline', current) as {
      claims: Array<{ evidenceCardIds: string[] }>;
    };
    invalid.claims[0]!.evidenceCardIds = [id(999)];
    expect(validator.safeParse(invalid)).toMatchObject({
      success: false,
    });
  });

  it('rejects replacements and any candidate that targets locked content', () => {
    const current = project();
    const invalid = candidateFor('draft', current) as {
      patches: Array<Record<string, unknown>>;
    };
    invalid.patches = [
      {
        operation: 'replace',
        path: '/outlines/0/nodes/0/conclusion',
        value: '覆盖锁定结论',
      },
    ];
    expect(
      createWorkflowCandidateValidator('draft', current).safeParse(invalid),
    ).toMatchObject({ success: false });
  });
});

describe('WorkflowAssistant', () => {
  it('persists a waiting candidate and restores it after a refresh without storing credentials', async () => {
    const current = project();
    const store = new MemoryWorkflowAssistantStore();
    const assistant = new WorkflowAssistant({
      store,
      provider: provider(candidateFor('outline', current)),
      createId: () => id(700),
      now: () => '2026-07-27T02:00:00.000Z',
    });

    const queued = await assistant.prepare(
      current,
      'outline',
      'outline-request-1',
    );
    expect(queued.run.status).toBe('queued');
    const waiting = await assistant.execute(queued.id);
    expect(waiting.run.status).toBe('waiting_for_review');
    expect(waiting.inputSnapshot.projectVersion).toBe(7);

    const raw = JSON.stringify(await store.get(waiting.id));
    expect(raw).not.toMatch(/apiKey|authorization|bearer|secret/i);

    const refreshed = new WorkflowAssistant({
      store,
      provider: provider(candidateFor('outline', current)),
      createId: () => id(701),
      now: () => '2026-07-27T02:01:00.000Z',
    });
    await expect(refreshed.get(waiting.id)).resolves.toMatchObject({
      run: { status: 'waiting_for_review' },
      candidate: {
        value: { kind: 'outline_options' },
      },
    });
  });

  it('applies only the selected outline after approval and never updates locked content', async () => {
    const current = project();
    const store = new MemoryWorkflowAssistantStore();
    const assistant = new WorkflowAssistant({
      store,
      provider: provider(candidateFor('outline', current)),
      createId: () => id(710),
      now: () => '2026-07-27T02:00:00.000Z',
    });
    const queued = await assistant.prepare(
      current,
      'outline',
      'outline-request-apply',
    );
    const waiting = await assistant.execute(queued.id);
    const port = applyPort(current);

    const applied = await assistant.apply(waiting.id, current, port, {
      candidateIds: ['outline-2'],
    });
    expect(applied).toMatchObject({
      run: { status: 'completed' },
      application: { status: 'applied', appliedUnitIds: ['outline-2'] },
    });
    expect(port.createOutline).toHaveBeenCalledTimes(1);
    expect(port.createOutline).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ title: '现状—判断—建议' }),
    );
    expect(Object.keys(port)).not.toContain('updateOutlineNode');

    const refreshed = new WorkflowAssistant({
      store,
      provider: provider(candidateFor('outline', current)),
      createId: () => id(711),
    });
    await expect(refreshed.get(applied.id)).resolves.toMatchObject({
      run: { status: 'completed' },
      application: { status: 'applied' },
    });
  });

  it('records partial application and resumes only unapplied draft pages', async () => {
    const current = project();
    const store = new MemoryWorkflowAssistantStore();
    const assistant = new WorkflowAssistant({
      store,
      provider: provider(candidateFor('draft', current)),
      createId: () => id(720),
      now: () => '2026-07-27T02:00:00.000Z',
    });
    const queued = await assistant.prepare(
      current,
      'draft',
      'draft-request-1',
    );
    const waiting = await assistant.execute(queued.id);
    const port = applyPort(current);
    vi.mocked(port.insertDraftPage)
      .mockResolvedValueOnce(current)
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValue(current);

    const partial = await assistant.apply(waiting.id, current, port);
    expect(partial.application).toMatchObject({
      status: 'partial',
      appliedUnitIds: ['page-1'],
    });
    expect(partial.run.status).toBe('waiting_for_review');

    const resumed = await assistant.apply(waiting.id, current, port);
    expect(resumed.application).toMatchObject({
      status: 'applied',
      appliedUnitIds: ['page-1', 'page-2', 'page-3'],
    });
    expect(port.insertDraftPage).toHaveBeenCalledTimes(4);
  });

  it('supports cancellation, idempotent prepare and retry after quota exhaustion', async () => {
    const current = project();
    const store: WorkflowAssistantStore =
      new MemoryWorkflowAssistantStore();
    const quotaProvider = provider(candidateFor('evidence', current));
    vi.mocked(quotaProvider.invoke).mockRejectedValueOnce(
      new AIProviderInvocationError('QUOTA_EXHAUSTED'),
    );
    const assistant = new WorkflowAssistant({
      store,
      provider: quotaProvider,
      createId: (() => {
        let next = 730;
        return () => id(next++);
      })(),
      now: () => '2026-07-27T02:00:00.000Z',
    });

    const first = await assistant.prepare(
      current,
      'evidence',
      'same-request',
    );
    const duplicate = await assistant.prepare(
      current,
      'evidence',
      'same-request',
    );
    expect(duplicate.id).toBe(first.id);

    const exhausted = await assistant.execute(first.id);
    expect(exhausted.run.status).toBe('quota_exhausted');
    const retried = await assistant.retry(
      exhausted.id,
      'same-request-retry-1',
    );
    expect(retried.run.parentRunId).toBe(exhausted.run.id);

    const cancellable = await assistant.prepare(
      current,
      'evidence',
      'cancel-request',
    );
    await expect(assistant.cancel(cancellable.id)).resolves.toMatchObject({
      run: { status: 'cancelled', errorCode: 'CANCELLED' },
    });
  });

  it('fails before calling a provider when project inputs are insufficient', async () => {
    const current = project();
    current.evidenceCards = [];
    const invoke = vi.fn();
    const assistant = new WorkflowAssistant({
      store: new MemoryWorkflowAssistantStore(),
      provider: { ...provider({}), invoke },
      createId: () => id(740),
    });

    await expect(
      assistant.prepare(current, 'outline', 'insufficient'),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_EVIDENCE',
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

export type _SessionCompileAssertion = WorkflowAssistantSession;

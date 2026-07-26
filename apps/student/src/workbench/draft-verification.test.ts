import { describe, expect, it } from 'vitest';
import type {
  EvidenceCard,
  TaskDefinition,
} from './project-model.js';
import {
  createDraftPage,
  insertDraftPage,
  moveDraftPage,
  removeDraftPage,
  setDraftPageLocked,
  toProjectVerificationCheckDraft,
  updateDraftPage,
  verifyDraft,
} from './draft-verification.js';
import type {
  DraftDomainError,
  DraftPage,
} from './draft-verification.js';

const CREATED_AT = '2026-07-27T01:00:00.000Z';
const UPDATED_AT = '2026-07-27T02:00:00.000Z';
const EVIDENCE_A = '01900000-0000-7000-8000-000000000501';
const EVIDENCE_B = '01900000-0000-7000-8000-000000000502';
const RUBRIC_A = '01900000-0000-7000-8000-000000000503';
const RUBRIC_B = '01900000-0000-7000-8000-000000000504';

function taskDefinition(
  overrides: Partial<TaskDefinition> = {},
): TaskDefinition {
  return {
    id: '01900000-0000-7000-8000-000000000510',
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    taskName: '两页项目汇报',
    audience: '课程教师',
    dueAt: '2026-08-15T09:00:00.000Z',
    lengthTarget: { unit: 'pages', value: 2 },
    presentationDurationMinutes: 2,
    outputFormats: ['pptx'],
    rubric: [
      {
        id: RUBRIC_A,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        title: '论证',
        description: '结论有证据支持',
        weightPercent: 50,
      },
      {
        id: RUBRIC_B,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: UPDATED_AT,
        title: '表达',
        description: '结构清晰',
        weightPercent: 50,
      },
    ],
    tone: '清晰',
    mustInclude: ['核心结论'],
    mustAvoid: ['禁止词'],
    ...overrides,
  };
}

function evidenceCard(
  id: string,
  citation: string,
): EvidenceCard {
  return {
    id,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    projectId: '01900000-0000-7000-8000-000000000520',
    sourceFileId: '01900000-0000-7000-8000-000000000521',
    sourceChunkId: '01900000-0000-7000-8000-000000000522',
    sourceFileVersion: 1,
    pageNumber: 1,
    characterStart: 0,
    characterEnd: 10,
    quote: '可核验原文',
    kind: 'fact',
    note: '',
    citation,
    status: 'verified',
    stance: 'support',
    confirmationStatus: 'confirmed',
    userConfirmedAt: UPDATED_AT,
  };
}

function page(
  overrides: Partial<DraftPage> & Pick<DraftPage, 'id'>,
): DraftPage {
  return createDraftPage({
    title: '默认标题',
    conclusion: '默认结论',
    body: '默认正文',
    evidenceCardIds: [EVIDENCE_A],
    citations: [
      {
        evidenceCardId: EVIDENCE_A,
        label: '[1]',
      },
    ],
    visualNote: '使用简洁图表',
    speakerNotes: '正常语速说明',
    estimatedSeconds: 60,
    locked: false,
    rubricCriterionIds: [RUBRIC_A],
    claims: [
      {
        id: `${overrides.id}-claim`,
        text: overrides.conclusion ?? '默认结论',
        evidenceCardIds: [EVIDENCE_A],
        numericFacts: [],
      },
    ],
    ...overrides,
  });
}

describe('draft page domain operations', () => {
  it('supports insert, update, delete and reorder while protecting locked pages', () => {
    const first = page({ id: 'page-1' });
    const second = page({ id: 'page-2', title: '第二页' });

    let pages = insertDraftPage([], first, 0);
    pages = insertDraftPage(pages, second, 1);
    pages = moveDraftPage(pages, 'page-2', 0);
    expect(pages.map((candidate) => candidate.id)).toEqual([
      'page-2',
      'page-1',
    ]);

    pages = updateDraftPage(pages, 'page-2', {
      title: '更新后的第二页',
      estimatedSeconds: 75,
    });
    expect(pages[0]).toMatchObject({
      title: '更新后的第二页',
      estimatedSeconds: 75,
    });

    pages = setDraftPageLocked(pages, 'page-2', true);
    expect(() =>
      updateDraftPage(pages, 'page-2', { title: '不得覆盖' }),
    ).toThrow(expect.objectContaining({ code: 'PAGE_LOCKED' }));
    expect(() => removeDraftPage(pages, 'page-2')).toThrow(
      expect.objectContaining({ code: 'PAGE_LOCKED' }),
    );
    expect(() => moveDraftPage(pages, 'page-2', 1)).toThrow(
      expect.objectContaining({ code: 'PAGE_LOCKED' }),
    );

    pages = setDraftPageLocked(pages, 'page-2', false);
    pages = removeDraftPage(pages, 'page-2');
    expect(pages.map((candidate) => candidate.id)).toEqual(['page-1']);
    expect(Object.isFrozen(pages)).toBe(true);
    expect(Object.isFrozen(pages[0]?.claims)).toBe(true);
  });

  it('rejects duplicate identities and invalid operations explicitly', () => {
    const first = page({ id: 'page-1' });
    const pages = insertDraftPage([], first, 0);

    expect(() => insertDraftPage(pages, first, 1)).toThrow(
      expect.objectContaining<Partial<DraftDomainError>>({
        name: 'DraftDomainError',
        code: 'DUPLICATE_PAGE_ID',
      }),
    );
    expect(() => updateDraftPage(pages, 'missing', {})).toThrow(
      expect.objectContaining({ code: 'PAGE_NOT_FOUND' }),
    );
    expect(() => moveDraftPage(pages, 'page-1', 2)).toThrow(
      expect.objectContaining({ code: 'INVALID_PAGE_INDEX' }),
    );
  });
});

describe('deterministic draft verification', () => {
  it('returns passing checks for every required rule on a sound draft', () => {
    const pages = [
      page({
        id: 'page-1',
        title: '核心结论',
        conclusion: '方案能够降低等待时间',
        body: '依据来源说明实施路径。',
        rubricCriterionIds: [RUBRIC_A],
        claims: [
          {
            id: 'claim-1',
            text: '方案能够降低等待时间',
            evidenceCardIds: [EVIDENCE_A],
            numericFacts: [
              { metric: '样本量', value: 100, unit: '人' },
            ],
          },
        ],
      }),
      page({
        id: 'page-2',
        title: '实施建议',
        conclusion: '先进行小范围试点',
        body: '逐步验证并记录结果。',
        evidenceCardIds: [EVIDENCE_B],
        citations: [
          {
            evidenceCardId: EVIDENCE_B,
            label: '[2]',
          },
        ],
        rubricCriterionIds: [RUBRIC_B],
        claims: [
          {
            id: 'claim-2',
            text: '先进行小范围试点',
            evidenceCardIds: [EVIDENCE_B],
            numericFacts: [
              { metric: '样本量', value: 100, unit: '人' },
            ],
          },
        ],
      }),
    ];

    const checks = verifyDraft({
      pages,
      taskDefinition: taskDefinition(),
      evidenceCards: [
        evidenceCard(EVIDENCE_A, '来源 A，第 1 页'),
        evidenceCard(EVIDENCE_B, '来源 B，第 1 页'),
      ],
    });

    expect(checks).toHaveLength(10);
    expect(checks.map((check) => check.code)).toEqual([
      'SOURCE_TRACEABLE',
      'CITATION_EXISTS',
      'UNSUBSTANTIATED_CLAIM',
      'MUST_INCLUDE',
      'MUST_AVOID',
      'LENGTH_TARGET',
      'PRESENTATION_DURATION',
      'RUBRIC_COVERAGE',
      'DUPLICATE_CLAIM',
      'NUMERIC_CONSISTENCY',
    ]);
    expect(checks.every((check) => check.outcome === 'pass')).toBe(true);
    expect(checks.every((check) => check.severity === 'info')).toBe(true);
  });

  it('reports all deterministic failures with stable paths and repair hints', () => {
    const unknownEvidence = '01900000-0000-7000-8000-000000000599';
    const pages = [
      page({
        id: 'page-1',
        title: '第一部分',
        conclusion: '重复主张',
        body: '正文含有禁止词，且缺少规定内容。',
        evidenceCardIds: [unknownEvidence],
        citations: [],
        estimatedSeconds: 20,
        rubricCriterionIds: [RUBRIC_A],
        claims: [
          {
            id: 'claim-1',
            text: '重复主张',
            evidenceCardIds: [],
            numericFacts: [
              { metric: '完成率', value: 40, unit: '%' },
            ],
          },
        ],
      }),
      page({
        id: 'page-2',
        title: '第二部分',
        conclusion: '重复主张',
        body: '另一段正文。',
        evidenceCardIds: [EVIDENCE_A],
        citations: [],
        estimatedSeconds: 20,
        rubricCriterionIds: [],
        claims: [
          {
            id: 'claim-2',
            text: '重复  主张',
            evidenceCardIds: [EVIDENCE_A],
            numericFacts: [
              { metric: '完成率', value: 60, unit: '%' },
            ],
          },
        ],
      }),
    ];

    const checks = verifyDraft({
      pages,
      taskDefinition: taskDefinition({
        lengthTarget: { unit: 'pages', value: 3 },
      }),
      evidenceCards: [evidenceCard(EVIDENCE_A, '来源 A，第 1 页')],
    });

    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_TRACEABLE',
          outcome: 'fail',
          severity: 'error',
          artifactPath: 'draft.pages[0].evidenceCardIds[0]',
        }),
        expect.objectContaining({
          code: 'CITATION_EXISTS',
          outcome: 'fail',
          artifactPath: 'draft.pages[1].citations',
        }),
        expect.objectContaining({
          code: 'UNSUBSTANTIATED_CLAIM',
          outcome: 'fail',
          artifactPath: 'draft.pages[0].claims[0].evidenceCardIds',
        }),
        expect.objectContaining({
          code: 'MUST_INCLUDE',
          outcome: 'fail',
          artifactPath: 'taskDefinition.mustInclude[0]',
        }),
        expect.objectContaining({
          code: 'MUST_AVOID',
          outcome: 'fail',
          artifactPath: 'draft.pages[0].body',
        }),
        expect.objectContaining({
          code: 'LENGTH_TARGET',
          outcome: 'fail',
          artifactPath: 'taskDefinition.lengthTarget',
        }),
        expect.objectContaining({
          code: 'PRESENTATION_DURATION',
          outcome: 'fail',
          artifactPath: 'taskDefinition.presentationDurationMinutes',
        }),
        expect.objectContaining({
          code: 'RUBRIC_COVERAGE',
          outcome: 'fail',
          artifactPath: `taskDefinition.rubric[1]`,
        }),
        expect.objectContaining({
          code: 'DUPLICATE_CLAIM',
          outcome: 'warning',
          severity: 'warning',
          artifactPath: 'draft.pages[1].claims[0].text',
        }),
        expect.objectContaining({
          code: 'NUMERIC_CONSISTENCY',
          outcome: 'fail',
          artifactPath:
            'draft.pages[1].claims[0].numericFacts[0].value',
        }),
      ]),
    );
    expect(
      checks
        .filter((check) => check.outcome !== 'pass')
        .every((check) => check.fixHint.length > 0),
    ).toBe(true);
    expect(verifyDraft({
      pages,
      taskDefinition: taskDefinition({
        lengthTarget: { unit: 'pages', value: 3 },
      }),
      evidenceCards: [evidenceCard(EVIDENCE_A, '来源 A，第 1 页')],
    })).toEqual(checks);
  });

  it('maps domain checks directly to project VerificationCheck drafts', () => {
    const [check] = verifyDraft({
      pages: [
        page({
          id: 'page-1',
          evidenceCardIds: [],
          citations: [],
          claims: [
            {
              id: 'claim-1',
              text: '没有证据的主张',
              evidenceCardIds: [],
              numericFacts: [],
            },
          ],
        }),
      ],
      taskDefinition: taskDefinition({
        lengthTarget: { unit: 'pages', value: 1 },
        presentationDurationMinutes: 1,
        rubric: [
          {
            id: RUBRIC_A,
            version: 1,
            createdAt: CREATED_AT,
            updatedAt: UPDATED_AT,
            title: '论证',
            description: '结论有证据支持',
            weightPercent: 100,
          },
        ],
      }),
      evidenceCards: [],
    }).filter((candidate) => candidate.outcome === 'fail');

    if (check === undefined) {
      throw new Error('expected a failing check');
    }
    expect(toProjectVerificationCheckDraft(check)).toEqual({
      rule: check.rule,
      outcome: check.outcome,
      message: check.message,
      artifactPath: check.artifactPath,
      evidenceCardIds: check.evidenceCardIds,
    });
  });
});

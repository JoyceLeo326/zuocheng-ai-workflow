import type {
  EntityId,
  EvidenceCard,
  TaskDefinition,
  VerificationCheck,
  VerificationOutcome,
  VerificationRule,
} from './project-model.js';

const MAX_PAGE_ID_LENGTH = 128;
const MAX_PAGE_TEXT_LENGTH = 2_000_000;
const MAX_PAGE_SECONDS = 24 * 60 * 60;

export type DraftCitation = Readonly<{
  evidenceCardId: EntityId;
  label: string;
}>;

export type DraftNumericFact = Readonly<{
  metric: string;
  value: number;
  unit: string;
}>;

export type DraftClaim = Readonly<{
  id: string;
  text: string;
  evidenceCardIds: readonly EntityId[];
  numericFacts: readonly DraftNumericFact[];
}>;

export type DraftPage = Readonly<{
  id: string;
  title: string;
  conclusion: string;
  body: string;
  evidenceCardIds: readonly EntityId[];
  citations: readonly DraftCitation[];
  visualNote: string;
  speakerNotes: string;
  estimatedSeconds: number;
  locked: boolean;
  rubricCriterionIds: readonly EntityId[];
  claims: readonly DraftClaim[];
}>;

export type DraftDomainErrorCode =
  | 'INVALID_DRAFT_PAGE'
  | 'DUPLICATE_PAGE_ID'
  | 'DUPLICATE_CLAIM_ID'
  | 'PAGE_NOT_FOUND'
  | 'PAGE_LOCKED'
  | 'INVALID_PAGE_INDEX'
  | 'DUPLICATE_EVIDENCE_ID';

export class DraftDomainError extends Error {
  constructor(readonly code: DraftDomainErrorCode) {
    super(`Draft operation rejected: ${code}`);
    this.name = 'DraftDomainError';
  }
}

export function createDraftPage(input: DraftPage): DraftPage {
  assertIdentifier(input.id);
  assertPageText(input.title);
  assertPageText(input.conclusion);
  assertPageText(input.body);
  assertPageText(input.visualNote);
  assertPageText(input.speakerNotes);
  if (
    !Number.isSafeInteger(input.estimatedSeconds) ||
    input.estimatedSeconds < 0 ||
    input.estimatedSeconds > MAX_PAGE_SECONDS ||
    typeof input.locked !== 'boolean'
  ) {
    throw new DraftDomainError('INVALID_DRAFT_PAGE');
  }

  const evidenceCardIds = freezeUniqueIds(input.evidenceCardIds);
  const evidenceIdSet = new Set(evidenceCardIds);
  const citations = input.citations.map((citation) => {
    assertIdentifier(citation.evidenceCardId);
    assertNonEmptyText(citation.label);
    if (!evidenceIdSet.has(citation.evidenceCardId)) {
      throw new DraftDomainError('INVALID_DRAFT_PAGE');
    }
    return Object.freeze({
      evidenceCardId: citation.evidenceCardId,
      label: citation.label,
    });
  });
  assertNoDuplicates(
    citations.map((citation) => citation.evidenceCardId),
    'INVALID_DRAFT_PAGE',
  );

  const rubricCriterionIds = freezeUniqueIds(
    input.rubricCriterionIds,
  );
  const claimIds = new Set<string>();
  const claims = input.claims.map((claim) => {
    assertIdentifier(claim.id);
    if (claimIds.has(claim.id)) {
      throw new DraftDomainError('DUPLICATE_CLAIM_ID');
    }
    claimIds.add(claim.id);
    assertNonEmptyText(claim.text);
    const claimEvidenceIds = freezeUniqueIds(claim.evidenceCardIds);
    if (
      claimEvidenceIds.some(
        (evidenceCardId) => !evidenceIdSet.has(evidenceCardId),
      )
    ) {
      throw new DraftDomainError('INVALID_DRAFT_PAGE');
    }
    const numericFacts = claim.numericFacts.map((fact) => {
      assertNonEmptyText(fact.metric);
      assertNonEmptyText(fact.unit);
      if (!Number.isFinite(fact.value)) {
        throw new DraftDomainError('INVALID_DRAFT_PAGE');
      }
      return Object.freeze({
        metric: fact.metric,
        value: fact.value,
        unit: fact.unit,
      });
    });
    return Object.freeze({
      id: claim.id,
      text: claim.text,
      evidenceCardIds: claimEvidenceIds,
      numericFacts: Object.freeze(numericFacts),
    });
  });

  return Object.freeze({
    id: input.id,
    title: input.title,
    conclusion: input.conclusion,
    body: input.body,
    evidenceCardIds,
    citations: Object.freeze(citations),
    visualNote: input.visualNote,
    speakerNotes: input.speakerNotes,
    estimatedSeconds: input.estimatedSeconds,
    locked: input.locked,
    rubricCriterionIds,
    claims: Object.freeze(claims),
  });
}

export function insertDraftPage(
  pages: readonly DraftPage[],
  page: DraftPage,
  index: number,
): readonly DraftPage[] {
  assertInsertIndex(index, pages.length);
  if (pages.some((candidate) => candidate.id === page.id)) {
    throw new DraftDomainError('DUPLICATE_PAGE_ID');
  }
  const created = createDraftPage(page);
  return freezePages([
    ...pages.slice(0, index),
    created,
    ...pages.slice(index),
  ]);
}

export type DraftPagePatch = Partial<
  Omit<DraftPage, 'id' | 'locked'>
>;

export function updateDraftPage(
  pages: readonly DraftPage[],
  pageId: string,
  patch: DraftPagePatch,
): readonly DraftPage[] {
  const index = findPageIndex(pages, pageId);
  const page = pages[index];
  if (page === undefined) {
    throw new DraftDomainError('PAGE_NOT_FOUND');
  }
  if (page.locked) {
    throw new DraftDomainError('PAGE_LOCKED');
  }
  if ('id' in patch || 'locked' in patch) {
    throw new DraftDomainError('INVALID_DRAFT_PAGE');
  }
  const updated = createDraftPage({
    ...page,
    ...patch,
    id: page.id,
    locked: page.locked,
  });
  return freezePages(
    pages.map((candidate, candidateIndex) =>
      candidateIndex === index ? updated : candidate,
    ),
  );
}

export function removeDraftPage(
  pages: readonly DraftPage[],
  pageId: string,
): readonly DraftPage[] {
  const index = findPageIndex(pages, pageId);
  const page = pages[index];
  if (page === undefined) {
    throw new DraftDomainError('PAGE_NOT_FOUND');
  }
  if (page.locked) {
    throw new DraftDomainError('PAGE_LOCKED');
  }
  return freezePages([
    ...pages.slice(0, index),
    ...pages.slice(index + 1),
  ]);
}

export function moveDraftPage(
  pages: readonly DraftPage[],
  pageId: string,
  targetIndex: number,
): readonly DraftPage[] {
  if (
    !Number.isSafeInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= pages.length
  ) {
    throw new DraftDomainError('INVALID_PAGE_INDEX');
  }
  const sourceIndex = findPageIndex(pages, pageId);
  const page = pages[sourceIndex];
  if (page === undefined) {
    throw new DraftDomainError('PAGE_NOT_FOUND');
  }
  if (page.locked && sourceIndex !== targetIndex) {
    throw new DraftDomainError('PAGE_LOCKED');
  }
  if (sourceIndex === targetIndex) {
    return freezePages(pages);
  }
  const remaining = [
    ...pages.slice(0, sourceIndex),
    ...pages.slice(sourceIndex + 1),
  ];
  remaining.splice(targetIndex, 0, page);
  return freezePages(remaining);
}

export function setDraftPageLocked(
  pages: readonly DraftPage[],
  pageId: string,
  locked: boolean,
): readonly DraftPage[] {
  const index = findPageIndex(pages, pageId);
  const page = pages[index];
  if (page === undefined) {
    throw new DraftDomainError('PAGE_NOT_FOUND');
  }
  const updated = createDraftPage({
    ...page,
    locked,
  });
  return freezePages(
    pages.map((candidate, candidateIndex) =>
      candidateIndex === index ? updated : candidate,
    ),
  );
}

export type DraftVerificationCode =
  | 'SOURCE_TRACEABLE'
  | 'CITATION_EXISTS'
  | 'UNSUBSTANTIATED_CLAIM'
  | 'MUST_INCLUDE'
  | 'MUST_AVOID'
  | 'LENGTH_TARGET'
  | 'PRESENTATION_DURATION'
  | 'RUBRIC_COVERAGE'
  | 'DUPLICATE_CLAIM'
  | 'NUMERIC_CONSISTENCY';

export type DraftVerificationSeverity = 'info' | 'warning' | 'error';

export type DraftVerificationCheck = Readonly<{
  code: DraftVerificationCode;
  rule: VerificationRule;
  outcome: VerificationOutcome;
  severity: DraftVerificationSeverity;
  message: string;
  artifactPath: string;
  evidenceCardIds: readonly EntityId[];
  fixHint: string;
}>;

export function verifyDraft(input: Readonly<{
  pages: readonly DraftPage[];
  taskDefinition: TaskDefinition;
  evidenceCards: readonly EvidenceCard[];
}>): readonly DraftVerificationCheck[] {
  const pages = freezePages(input.pages.map(createDraftPage));
  const evidenceById = evidenceMap(input.evidenceCards);
  const checks = [
    ...verifySourceTraceability(pages, evidenceById),
    ...verifyCitations(pages, evidenceById),
    ...verifyClaimEvidence(pages),
    ...verifyMustInclude(pages, input.taskDefinition),
    ...verifyMustAvoid(pages, input.taskDefinition),
    ...verifyLengthTarget(pages, input.taskDefinition),
    ...verifyPresentationDuration(pages, input.taskDefinition),
    ...verifyRubricCoverage(pages, input.taskDefinition),
    ...verifyDuplicateClaims(pages),
    ...verifyNumericConsistency(pages),
  ];
  return Object.freeze(checks);
}

function verifySourceTraceability(
  pages: readonly DraftPage[],
  evidenceById: ReadonlyMap<EntityId, EvidenceCard>,
): readonly DraftVerificationCheck[] {
  const issues: DraftVerificationCheck[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    for (const [evidenceIndex, evidenceCardId] of page.evidenceCardIds.entries()) {
      const evidence = evidenceById.get(evidenceCardId);
      if (!isTraceableEvidence(evidence)) {
        issues.push(
          check({
            code: 'SOURCE_TRACEABLE',
            rule: 'source_traceable',
            outcome: 'fail',
            artifactPath:
              `draft.pages[${pageIndex}].evidenceCardIds[${evidenceIndex}]`,
            evidenceCardIds: [evidenceCardId],
            message: '引用的证据卡不存在、已拒绝或缺少可追溯来源锚点。',
            fixHint: '选择存在且未被拒绝、包含来源文件与原文锚点的证据卡。',
          }),
        );
      }
    }
  }
  return issues.length > 0
    ? issues
    : [
        passingCheck(
          'SOURCE_TRACEABLE',
          'source_traceable',
          'draft.pages',
          '所有证据引用均可追溯到来源卡片。',
        ),
      ];
}

function verifyCitations(
  pages: readonly DraftPage[],
  evidenceById: ReadonlyMap<EntityId, EvidenceCard>,
): readonly DraftVerificationCheck[] {
  const issues: DraftVerificationCheck[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    const citedIds = new Set(
      page.citations.map((citation) => citation.evidenceCardId),
    );
    for (const evidenceCardId of page.evidenceCardIds) {
      const evidence = evidenceById.get(evidenceCardId);
      if (
        !citedIds.has(evidenceCardId) ||
        evidence === undefined ||
        evidence.citation.trim().length === 0
      ) {
        issues.push(
          check({
            code: 'CITATION_EXISTS',
            rule: 'citation_exists',
            outcome: 'fail',
            artifactPath: `draft.pages[${pageIndex}].citations`,
            evidenceCardIds: [evidenceCardId],
            message: '页面使用的证据缺少稿件引用标记或来源引用文本。',
            fixHint: '为该证据添加页面引用标记，并补齐证据卡 citation。',
          }),
        );
      }
    }
  }
  return issues.length > 0
    ? issues
    : [
        passingCheck(
          'CITATION_EXISTS',
          'citation_exists',
          'draft.pages',
          '所有页面证据均具有引用标记。',
        ),
      ];
}

function verifyClaimEvidence(
  pages: readonly DraftPage[],
): readonly DraftVerificationCheck[] {
  const issues: DraftVerificationCheck[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    if (page.conclusion.trim().length > 0 && page.claims.length === 0) {
      issues.push(
        check({
          code: 'UNSUBSTANTIATED_CLAIM',
          rule: 'source_traceable',
          outcome: 'fail',
          artifactPath: `draft.pages[${pageIndex}].claims`,
          evidenceCardIds: [],
          message: '页面结论尚未登记为可核验主张。',
          fixHint: '为结论添加结构化 claim，并绑定支持它的证据卡。',
        }),
      );
    }
    for (const [claimIndex, claim] of page.claims.entries()) {
      if (claim.evidenceCardIds.length === 0) {
        issues.push(
          check({
            code: 'UNSUBSTANTIATED_CLAIM',
            rule: 'source_traceable',
            outcome: 'fail',
            artifactPath:
              `draft.pages[${pageIndex}].claims[${claimIndex}].evidenceCardIds`,
            evidenceCardIds: [],
            message: '主张没有绑定任何证据卡。',
            fixHint: '绑定至少一张能够直接支持该主张的证据卡。',
          }),
        );
      }
    }
  }
  return issues.length > 0
    ? issues
    : [
        passingCheck(
          'UNSUBSTANTIATED_CLAIM',
          'source_traceable',
          'draft.pages',
          '所有结构化主张均绑定了证据。',
        ),
      ];
}

function verifyMustInclude(
  pages: readonly DraftPage[],
  taskDefinition: TaskDefinition,
): readonly DraftVerificationCheck[] {
  const searchable = normalizeSearchText(
    pages.map(pageContent).join('\n'),
  );
  const issues = taskDefinition.mustInclude.flatMap(
    (requirement, requirementIndex) => {
      return searchable.includes(normalizeSearchText(requirement))
        ? []
        : [
            check({
              code: 'MUST_INCLUDE',
              rule: 'required_content',
              outcome: 'fail',
              artifactPath:
                `taskDefinition.mustInclude[${requirementIndex}]`,
              evidenceCardIds: [],
              message: `稿件缺少必含内容：“${requirement}”。`,
              fixHint: '在标题、结论、正文或讲稿中明确加入该内容。',
            }),
          ];
    },
  );
  return issues.length > 0
    ? issues
    : [
        passingCheck(
          'MUST_INCLUDE',
          'required_content',
          'taskDefinition.mustInclude',
          '所有必含内容均已出现。',
        ),
      ];
}

function verifyMustAvoid(
  pages: readonly DraftPage[],
  taskDefinition: TaskDefinition,
): readonly DraftVerificationCheck[] {
  const issues: DraftVerificationCheck[] = [];
  const fields = [
    'title',
    'conclusion',
    'body',
    'speakerNotes',
  ] as const;
  for (const [pageIndex, page] of pages.entries()) {
    for (const forbidden of taskDefinition.mustAvoid) {
      const normalizedForbidden = normalizeSearchText(forbidden);
      for (const field of fields) {
        if (
          normalizeSearchText(page[field]).includes(normalizedForbidden)
        ) {
          issues.push(
            check({
              code: 'MUST_AVOID',
              rule: 'forbidden_content',
              outcome: 'fail',
              artifactPath: `draft.pages[${pageIndex}].${field}`,
              evidenceCardIds: [],
              message: `稿件包含必须避免的内容：“${forbidden}”。`,
              fixHint: '删除该内容，或改写为不触发限制的准确表达。',
            }),
          );
        }
      }
    }
  }
  return issues.length > 0
    ? issues
    : [
        passingCheck(
          'MUST_AVOID',
          'forbidden_content',
          'taskDefinition.mustAvoid',
          '稿件未包含禁止内容。',
        ),
      ];
}

function verifyLengthTarget(
  pages: readonly DraftPage[],
  taskDefinition: TaskDefinition,
): readonly DraftVerificationCheck[] {
  const target = taskDefinition.lengthTarget;
  const actual =
    target.unit === 'pages'
      ? pages.length
      : countWords(pages.map(pageContent).join('\n'));
  if (actual === target.value) {
    return [
      passingCheck(
        'LENGTH_TARGET',
        'length_target',
        'taskDefinition.lengthTarget',
        `稿件篇幅符合目标：${actual} ${target.unit}。`,
      ),
    ];
  }
  return [
    check({
      code: 'LENGTH_TARGET',
      rule: 'length_target',
      outcome: 'fail',
      artifactPath: 'taskDefinition.lengthTarget',
      evidenceCardIds: [],
      message:
        `稿件实际篇幅为 ${actual} ${target.unit}，目标为 ` +
        `${target.value} ${target.unit}。`,
      fixHint:
        actual < target.value
          ? '补充必要内容直至达到目标篇幅。'
          : '合并或删减次要内容直至达到目标篇幅。',
    }),
  ];
}

function verifyPresentationDuration(
  pages: readonly DraftPage[],
  taskDefinition: TaskDefinition,
): readonly DraftVerificationCheck[] {
  const targetMinutes = taskDefinition.presentationDurationMinutes;
  if (targetMinutes === null) {
    return [
      check({
        code: 'PRESENTATION_DURATION',
        rule: 'presentation_duration',
        outcome: 'not_run',
        artifactPath: 'taskDefinition.presentationDurationMinutes',
        evidenceCardIds: [],
        message: '任务未设置演讲时长目标。',
        fixHint: '如需时长核验，请先设置 presentationDurationMinutes。',
      }),
    ];
  }
  const targetSeconds = targetMinutes * 60;
  const actualSeconds = pages.reduce(
    (total, page) => total + page.estimatedSeconds,
    0,
  );
  const toleranceSeconds = targetSeconds * 0.1;
  if (Math.abs(actualSeconds - targetSeconds) <= toleranceSeconds) {
    return [
      passingCheck(
        'PRESENTATION_DURATION',
        'presentation_duration',
        'taskDefinition.presentationDurationMinutes',
        `预计演讲 ${actualSeconds} 秒，符合 ${targetSeconds} 秒目标。`,
      ),
    ];
  }
  return [
    check({
      code: 'PRESENTATION_DURATION',
      rule: 'presentation_duration',
      outcome: 'fail',
      artifactPath: 'taskDefinition.presentationDurationMinutes',
      evidenceCardIds: [],
      message:
        `预计演讲 ${actualSeconds} 秒，与 ${targetSeconds} 秒目标偏差超过 10%。`,
      fixHint:
        actualSeconds < targetSeconds
          ? '补充必要讲解，或校准各页 estimatedSeconds。'
          : '压缩讲解内容，或校准各页 estimatedSeconds。',
    }),
  ];
}

function verifyRubricCoverage(
  pages: readonly DraftPage[],
  taskDefinition: TaskDefinition,
): readonly DraftVerificationCheck[] {
  const covered = new Set(
    pages.flatMap((page) => page.rubricCriterionIds),
  );
  const issues = taskDefinition.rubric.flatMap(
    (criterion, criterionIndex) =>
      covered.has(criterion.id)
        ? []
        : [
            check({
              code: 'RUBRIC_COVERAGE',
              rule: 'rubric_coverage',
              outcome: 'fail',
              artifactPath: `taskDefinition.rubric[${criterionIndex}]`,
              evidenceCardIds: [],
              message: `评分项“${criterion.title}”尚未被任何页面覆盖。`,
              fixHint: '在相关页面登记该 rubricCriterionId 并补齐对应内容。',
            }),
          ],
  );
  return issues.length > 0
    ? issues
    : [
        passingCheck(
          'RUBRIC_COVERAGE',
          'rubric_coverage',
          'taskDefinition.rubric',
          '所有评分项均已被页面覆盖。',
        ),
      ];
}

function verifyDuplicateClaims(
  pages: readonly DraftPage[],
): readonly DraftVerificationCheck[] {
  const firstClaimByText = new Map<
    string,
    Readonly<{
      pageIndex: number;
      claimIndex: number;
      evidenceCardIds: readonly EntityId[];
    }>
  >();
  const issues: DraftVerificationCheck[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    for (const [claimIndex, claim] of page.claims.entries()) {
      const normalized = normalizeClaimText(claim.text);
      const previous = firstClaimByText.get(normalized);
      if (previous === undefined) {
        firstClaimByText.set(
          normalized,
          Object.freeze({
            pageIndex,
            claimIndex,
            evidenceCardIds: claim.evidenceCardIds,
          }),
        );
        continue;
      }
      issues.push(
        check({
          code: 'DUPLICATE_CLAIM',
          rule: 'required_content',
          outcome: 'warning',
          artifactPath:
            `draft.pages[${pageIndex}].claims[${claimIndex}].text`,
          evidenceCardIds: unique([
            ...previous.evidenceCardIds,
            ...claim.evidenceCardIds,
          ]),
          message:
            `该主张与 draft.pages[${previous.pageIndex}]` +
            `.claims[${previous.claimIndex}] 重复。`,
          fixHint: '合并重复主张，或明确两处主张的不同范围与作用。',
        }),
      );
    }
  }
  return issues.length > 0
    ? issues
    : [
        passingCheck(
          'DUPLICATE_CLAIM',
          'required_content',
          'draft.pages',
          '未发现重复的结构化主张。',
        ),
      ];
}

function verifyNumericConsistency(
  pages: readonly DraftPage[],
): readonly DraftVerificationCheck[] {
  const firstFactByMetric = new Map<
    string,
    Readonly<{
      value: number;
      pageIndex: number;
      claimIndex: number;
      factIndex: number;
      evidenceCardIds: readonly EntityId[];
    }>
  >();
  const issues: DraftVerificationCheck[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    for (const [claimIndex, claim] of page.claims.entries()) {
      for (const [factIndex, fact] of claim.numericFacts.entries()) {
        const key =
          `${normalizeClaimText(fact.metric)}::` +
          normalizeClaimText(fact.unit);
        const previous = firstFactByMetric.get(key);
        if (previous === undefined) {
          firstFactByMetric.set(
            key,
            Object.freeze({
              value: fact.value,
              pageIndex,
              claimIndex,
              factIndex,
              evidenceCardIds: claim.evidenceCardIds,
            }),
          );
          continue;
        }
        if (previous.value === fact.value) {
          continue;
        }
        issues.push(
          check({
            code: 'NUMERIC_CONSISTENCY',
            rule: 'source_traceable',
            outcome: 'fail',
            artifactPath:
              `draft.pages[${pageIndex}].claims[${claimIndex}]` +
              `.numericFacts[${factIndex}].value`,
            evidenceCardIds: unique([
              ...previous.evidenceCardIds,
              ...claim.evidenceCardIds,
            ]),
            message:
              `指标“${fact.metric}（${fact.unit}）”同时出现 ` +
              `${previous.value} 与 ${fact.value}。`,
            fixHint:
              '核对两个数字的统计口径与来源；统一数值，或拆分为不同 metric。',
          }),
        );
      }
    }
  }
  return issues.length > 0
    ? issues
    : [
        passingCheck(
          'NUMERIC_CONSISTENCY',
          'source_traceable',
          'draft.pages',
          '同名同单位的结构化数字保持一致。',
        ),
      ];
}

type CheckInput = Readonly<{
  code: DraftVerificationCode;
  rule: VerificationRule;
  outcome: VerificationOutcome;
  artifactPath: string;
  evidenceCardIds: readonly EntityId[];
  message: string;
  fixHint: string;
}>;

function check(input: CheckInput): DraftVerificationCheck {
  return Object.freeze({
    ...input,
    severity:
      input.outcome === 'fail'
        ? 'error'
        : input.outcome === 'warning'
          ? 'warning'
          : 'info',
    evidenceCardIds: Object.freeze([...input.evidenceCardIds]),
  });
}

function passingCheck(
  code: DraftVerificationCode,
  rule: VerificationRule,
  artifactPath: string,
  message: string,
): DraftVerificationCheck {
  return check({
    code,
    rule,
    outcome: 'pass',
    artifactPath,
    evidenceCardIds: [],
    message,
    fixHint: '无需修改。',
  });
}

export type ProjectVerificationCheckDraft = Pick<
  VerificationCheck,
  'rule' | 'outcome' | 'message' | 'artifactPath' | 'evidenceCardIds'
>;

export function toProjectVerificationCheckDraft(
  source: DraftVerificationCheck,
): ProjectVerificationCheckDraft {
  return {
    rule: source.rule,
    outcome: source.outcome,
    message: source.message,
    artifactPath: source.artifactPath,
    evidenceCardIds: [...source.evidenceCardIds],
  };
}

function evidenceMap(
  evidenceCards: readonly EvidenceCard[],
): ReadonlyMap<EntityId, EvidenceCard> {
  const evidenceById = new Map<EntityId, EvidenceCard>();
  for (const evidence of evidenceCards) {
    if (evidenceById.has(evidence.id)) {
      throw new DraftDomainError('DUPLICATE_EVIDENCE_ID');
    }
    evidenceById.set(evidence.id, evidence);
  }
  return evidenceById;
}

function isTraceableEvidence(
  evidence: EvidenceCard | undefined,
): boolean {
  return (
    evidence !== undefined &&
    evidence.status !== 'rejected' &&
    evidence.sourceFileId.trim().length > 0 &&
    evidence.sourceChunkId.trim().length > 0 &&
    evidence.quote.trim().length > 0 &&
    evidence.characterEnd > evidence.characterStart
  );
}

function pageContent(page: DraftPage): string {
  return [
    page.title,
    page.conclusion,
    page.body,
    page.speakerNotes,
  ].join('\n');
}

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeClaimText(value: string): string {
  return normalizeSearchText(value).replace(/[\s\p{P}\p{S}]+/gu, '');
}

function countWords(value: string): number {
  return value.match(/\p{Script=Han}|[\p{L}\p{N}]+/gu)?.length ?? 0;
}

function freezePages(pages: readonly DraftPage[]): readonly DraftPage[] {
  const created = pages.map(createDraftPage);
  assertNoDuplicates(
    created.map((page) => page.id),
    'DUPLICATE_PAGE_ID',
  );
  return Object.freeze(created);
}

function freezeUniqueIds(values: readonly string[]): readonly string[] {
  for (const value of values) {
    assertIdentifier(value);
  }
  assertNoDuplicates(values, 'INVALID_DRAFT_PAGE');
  return Object.freeze([...values]);
}

function assertNoDuplicates(
  values: readonly string[],
  errorCode: DraftDomainErrorCode,
): void {
  if (new Set(values).size !== values.length) {
    throw new DraftDomainError(errorCode);
  }
}

function findPageIndex(
  pages: readonly DraftPage[],
  pageId: string,
): number {
  const index = pages.findIndex((page) => page.id === pageId);
  if (index === -1) {
    throw new DraftDomainError('PAGE_NOT_FOUND');
  }
  return index;
}

function assertInsertIndex(index: number, length: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index > length) {
    throw new DraftDomainError('INVALID_PAGE_INDEX');
  }
}

function assertIdentifier(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PAGE_ID_LENGTH ||
    value !== value.trim() ||
    hasControlCharacter(value)
  ) {
    throw new DraftDomainError('INVALID_DRAFT_PAGE');
  }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    );
  });
}

function assertNonEmptyText(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PAGE_TEXT_LENGTH ||
    value !== value.trim()
  ) {
    throw new DraftDomainError('INVALID_DRAFT_PAGE');
  }
}

function assertPageText(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length > MAX_PAGE_TEXT_LENGTH
  ) {
    throw new DraftDomainError('INVALID_DRAFT_PAGE');
  }
}

function unique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

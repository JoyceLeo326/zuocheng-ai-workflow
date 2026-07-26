import { describe, expect, it } from 'vitest';
import {
  PROJECT_SCHEMA_VERSION,
  ProjectModelError,
  parseArtifact,
  parseEvidenceCard,
  parseOutline,
  parseProject,
  parseSourceChunk,
  parseSourceFile,
  parseVerificationResult,
} from './project-model.js';

const PROJECT_ID = '01900000-0000-7000-8000-000000000101';
const TASK_ID = '01900000-0000-7000-8000-000000000102';
const RUBRIC_ID = '01900000-0000-7000-8000-000000000103';
const FILE_ID = '01900000-0000-7000-8000-000000000104';
const CHUNK_ID = '01900000-0000-7000-8000-000000000105';
const EVIDENCE_ID = '01900000-0000-7000-8000-000000000106';
const OUTLINE_ID = '01900000-0000-7000-8000-000000000107';
const NODE_ID = '01900000-0000-7000-8000-000000000108';
const ARTIFACT_ID = '01900000-0000-7000-8000-000000000109';
const RESULT_ID = '01900000-0000-7000-8000-000000000110';
const CHECK_ID = '01900000-0000-7000-8000-000000000111';
const CREATED_AT = '2026-07-27T01:00:00.000Z';
const UPDATED_AT = '2026-07-27T02:00:00.000Z';
const SHA256 = 'a'.repeat(64);

function metadata(id: string, version = 1) {
  return {
    id,
    version,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function taskDefinition() {
  return {
    ...metadata(TASK_ID),
    taskName: '三页课程汇报',
    audience: '课程教师与同学',
    dueAt: '2026-08-15T09:00:00.000Z',
    lengthTarget: {
      unit: 'pages',
      value: 3,
    },
    presentationDurationMinutes: 6,
    outputFormats: ['pptx', 'pdf'],
    rubric: [
      {
        ...metadata(RUBRIC_ID),
        title: '论证与证据',
        description: '结论必须由课程资料中的证据支持',
        weightPercent: 100,
      },
    ],
    tone: '清晰、克制、适合课堂讲述',
    mustInclude: ['核心结论', '来源索引'],
    mustAvoid: ['无来源数字', '夸大因果'],
  };
}

function sourceFile() {
  return {
    ...metadata(FILE_ID),
    projectId: PROJECT_ID,
    fileName: 'course-report.pdf',
    mediaType: 'application/pdf',
    extension: 'pdf',
    sizeBytes: 2048,
    contentSha256: SHA256,
    blobId: 'blob:course-report',
    sourceVersion: 1,
    status: 'ready',
    parseProgress: 100,
    pageCount: 1,
    error: null,
    replacedByFileId: null,
  };
}

function sourceChunk() {
  return {
    ...metadata(CHUNK_ID),
    projectId: PROJECT_ID,
    sourceFileId: FILE_ID,
    sourceFileVersion: 1,
    ordinal: 0,
    pageNumber: 1,
    pageLabel: '1',
    characterStart: 0,
    characterEnd: 24,
    text: '课程证据显示参与度提升。',
    contentSha256: SHA256,
  };
}

function evidenceCard() {
  return {
    ...metadata(EVIDENCE_ID),
    projectId: PROJECT_ID,
    sourceFileId: FILE_ID,
    sourceChunkId: CHUNK_ID,
    sourceFileVersion: 1,
    pageNumber: 1,
    characterStart: 0,
    characterEnd: 24,
    quote: '课程证据显示参与度提升。',
    kind: 'fact',
    note: '用于支持第一页结论',
    citation: '课程报告，第 1 页',
    status: 'verified',
    stance: 'support',
    confirmationStatus: 'confirmed',
    userConfirmedAt: UPDATED_AT,
  };
}

function outline() {
  return {
    ...metadata(OUTLINE_ID),
    projectId: PROJECT_ID,
    title: '问题—证据—行动',
    status: 'selected',
    lockedAt: null,
    nodes: [
      {
        ...metadata(NODE_ID),
        position: 0,
        title: '参与度为什么重要',
        conclusion: '参与度影响课程任务完成质量。',
        evidenceCardIds: [EVIDENCE_ID],
        coveredRequirements: ['核心结论', '来源索引'],
        rubricCriterionIds: [RUBRIC_ID],
        locked: false,
      },
    ],
  };
}

function artifact() {
  return {
    ...metadata(ARTIFACT_ID),
    projectId: PROJECT_ID,
    outlineId: OUTLINE_ID,
    outlineVersion: 1,
    kind: 'presentation',
    status: 'ready',
    payload: {
      pages: [
        {
          conclusion: '参与度影响课程任务完成质量。',
          evidenceCardIds: [EVIDENCE_ID],
        },
      ],
    },
    blobId: null,
    contentSha256: null,
    staleBecause: [],
    errorCode: null,
  };
}

function verificationResult() {
  return {
    ...metadata(RESULT_ID),
    projectId: PROJECT_ID,
    artifactId: ARTIFACT_ID,
    artifactVersion: 1,
    status: 'passed',
    checkedAt: UPDATED_AT,
    checks: [
      {
        ...metadata(CHECK_ID),
        rule: 'citation_exists',
        outcome: 'pass',
        message: '所有引用均可追溯。',
        artifactPath: 'pages[0]',
        evidenceCardIds: [EVIDENCE_ID],
      },
    ],
    summary: {
      passed: 1,
      warnings: 0,
      failed: 0,
      notRun: 0,
    },
  };
}

function project() {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    ...metadata(PROJECT_ID),
    title: '课程路演',
    status: 'active',
    taskDefinition: taskDefinition(),
    sourceFiles: [sourceFile()],
    sourceChunks: [sourceChunk()],
    evidenceCards: [evidenceCard()],
    outlines: [outline()],
    activeOutlineId: OUTLINE_ID,
    artifacts: [artifact()],
    verificationResults: [verificationResult()],
  };
}

describe('workbench project domain model', () => {
  it('parses a complete, stable and versioned project aggregate', () => {
    const parsed = parseProject(project());

    expect(parsed).toEqual(project());
    expect(parsed.taskDefinition).toMatchObject({
      taskName: '三页课程汇报',
      audience: '课程教师与同学',
      lengthTarget: { unit: 'pages', value: 3 },
      presentationDurationMinutes: 6,
      outputFormats: ['pptx', 'pdf'],
      tone: '清晰、克制、适合课堂讲述',
      mustInclude: ['核心结论', '来源索引'],
      mustAvoid: ['无来源数字', '夸大因果'],
    });
    expect(parsed.taskDefinition.rubric[0]).toMatchObject({
      id: RUBRIC_ID,
      weightPercent: 100,
    });
  });

  it.each([
    ['non UUIDv7 identity', { id: 'project-1' }],
    ['zero version', { version: 0 }],
    ['updated before creation', { updatedAt: '2026-07-26T23:00:00.000Z' }],
    ['unknown schema version', { schemaVersion: 99 }],
  ])('rejects %s', (_reason, patch) => {
    expect(() => parseProject({ ...project(), ...patch })).toThrow(
      ProjectModelError,
    );
  });

  it('enforces every task-definition field and rubric totals', () => {
    const missingAudience = project();
    missingAudience.taskDefinition.audience = '  ';
    expect(() => parseProject(missingAudience)).toThrow(/audience/u);

    const invalidLength = project();
    invalidLength.taskDefinition.lengthTarget.value = 0;
    expect(() => parseProject(invalidLength)).toThrow(/lengthTarget/u);

    const missingFormats = project();
    missingFormats.taskDefinition.outputFormats = [];
    expect(() => parseProject(missingFormats)).toThrow(/outputFormats/u);

    const badRubric = project();
    badRubric.taskDefinition.rubric[0]!.weightPercent = 80;
    expect(() => parseProject(badRubric)).toThrow(/rubric/u);

    const duplicateRequirement = project();
    duplicateRequirement.taskDefinition.mustAvoid = ['核心结论'];
    expect(() => parseProject(duplicateRequirement)).toThrow(
      /mustInclude/u,
    );
  });

  it('rejects impossible source-file lifecycle states', () => {
    expect(() =>
      parseSourceFile({
        ...sourceFile(),
        status: 'ready',
        parseProgress: 70,
      }),
    ).toThrow(/parseProgress/u);
    expect(() =>
      parseSourceFile({
        ...sourceFile(),
        status: 'failed',
        parseProgress: 40,
        error: null,
      }),
    ).toThrow(/error/u);
    expect(() =>
      parseSourceFile({
        ...sourceFile(),
        contentSha256: 'plaintext-file-id',
      }),
    ).toThrow(/contentSha256/u);
  });

  it('requires traceable chunk anchors and verified evidence citations', () => {
    expect(() =>
      parseSourceChunk({
        ...sourceChunk(),
        pageNumber: null,
      }),
    ).toThrow(/pageNumber/u);
    expect(() =>
      parseSourceChunk({
        ...sourceChunk(),
        characterEnd: 0,
      }),
    ).toThrow(/characterEnd/u);
    expect(() =>
      parseEvidenceCard({
        ...evidenceCard(),
        citation: '',
      }),
    ).toThrow(/citation/u);
    expect(() =>
      parseEvidenceCard({
        ...evidenceCard(),
        kind: 'unverified',
        status: 'verified',
      }),
    ).toThrow(/status/u);
  });

  it('persists evidence stance and requires explicit user confirmation before verification', () => {
    expect(parseEvidenceCard(evidenceCard())).toMatchObject({
      stance: 'support',
      confirmationStatus: 'confirmed',
      userConfirmedAt: UPDATED_AT,
      status: 'verified',
    });

    expect(() =>
      parseEvidenceCard({
        ...evidenceCard(),
        confirmationStatus: 'pending',
        userConfirmedAt: null,
      }),
    ).toThrow(/status/u);
    expect(() =>
      parseEvidenceCard({
        ...evidenceCard(),
        userConfirmedAt: null,
      }),
    ).toThrow(/userConfirmedAt/u);
    expect(() =>
      parseEvidenceCard({
        ...evidenceCard(),
        stance: 'invented',
      }),
    ).toThrow(/stance/u);

    const pending = parseEvidenceCard({
      ...evidenceCard(),
      status: 'selected',
      confirmationStatus: 'pending',
      userConfirmedAt: null,
    });
    expect(pending).toMatchObject({
      status: 'selected',
      confirmationStatus: 'pending',
      userConfirmedAt: null,
    });

    const legacyOperationCard = {
      ...evidenceCard(),
      stance: 'opposes',
      confirmedAt: UPDATED_AT,
    };
    delete (legacyOperationCard as { userConfirmedAt?: string }).userConfirmedAt;
    expect(parseEvidenceCard(legacyOperationCard)).toMatchObject({
      stance: 'oppose',
      confirmationStatus: 'confirmed',
      userConfirmedAt: UPDATED_AT,
    });
  });

  it('requires selected or locked outlines to bind evidence at every node', () => {
    const missingEvidence = outline();
    missingEvidence.nodes[0]!.evidenceCardIds = [];
    expect(() => parseOutline(missingEvidence)).toThrow(
      /evidenceCardIds/u,
    );

    expect(() =>
      parseOutline({
        ...outline(),
        status: 'locked',
        lockedAt: null,
      }),
    ).toThrow(/lockedAt/u);
    expect(
      parseOutline({
        ...outline(),
        status: 'draft',
        lockedAt: null,
        nodes: [],
      }).nodes,
    ).toEqual([]);
    expect(() =>
      parseOutline({
        ...outline(),
        status: 'selected',
        lockedAt: null,
        nodes: [],
      }),
    ).toThrow(/nodes/u);

    const duplicatePosition = outline();
    duplicatePosition.nodes.push({
      ...duplicatePosition.nodes[0]!,
      id: '01900000-0000-7000-8000-000000000112',
    });
    expect(() => parseOutline(duplicatePosition)).toThrow(/position/u);

    expect(() =>
      parseOutline({
        ...outline(),
        nodes: [
          {
            ...outline().nodes[0]!,
            coveredRequirements: ['核心结论', '核心结论'],
          },
        ],
      }),
    ).toThrow(/coveredRequirements/u);
  });

  it('persists verifiable delivery and rubric coverage on every outline node', () => {
    const parsed = parseOutline(outline());
    expect(parsed.nodes[0]).toMatchObject({
      coveredRequirements: ['核心结论', '来源索引'],
      rubricCriterionIds: [RUBRIC_ID],
    });

    const missingCoverage = project();
    missingCoverage.outlines[0]!.nodes[0]!.coveredRequirements = [
      '核心结论',
    ];
    expect(() => parseProject(missingCoverage)).toThrow(
      /coveredRequirements/u,
    );

    const inventedCoverage = project();
    inventedCoverage.outlines[0]!.nodes[0]!.coveredRequirements = [
      '核心结论',
      '来源索引',
      '不存在的要求',
    ];
    expect(() => parseProject(inventedCoverage)).toThrow(
      /coveredRequirements/u,
    );

    const unknownRubric = project();
    unknownRubric.outlines[0]!.nodes[0]!.rubricCriterionIds = [
      '01900000-0000-7000-8000-000000000199',
    ];
    expect(() => parseProject(unknownRubric)).toThrow(
      /rubricCriterionIds/u,
    );

    const unconfirmedEvidence = project();
    unconfirmedEvidence.evidenceCards[0]!.status = 'selected';
    unconfirmedEvidence.evidenceCards[0]!.confirmationStatus = 'pending';
    (
      unconfirmedEvidence.evidenceCards[0]! as {
        userConfirmedAt: string | null;
      }
    ).userConfirmedAt = null;
    expect(() => parseProject(unconfirmedEvidence)).toThrow(
      /evidenceCardIds/u,
    );
  });

  it('prevents artifact and verification states from claiming unsupported success', () => {
    expect(() =>
      parseArtifact({
        ...artifact(),
        status: 'exported',
        blobId: null,
        contentSha256: null,
      }),
    ).toThrow(/blobId/u);

    expect(() =>
      parseArtifact({
        ...artifact(),
        status: 'failed',
        errorCode: null,
      }),
    ).toThrow(/errorCode/u);

    const falsePass = verificationResult();
    falsePass.checks[0]!.outcome = 'fail';
    falsePass.summary = {
      passed: 0,
      warnings: 0,
      failed: 1,
      notRun: 0,
    };
    expect(() => parseVerificationResult(falsePass)).toThrow(/status/u);

    const badSummary = verificationResult();
    badSummary.summary.passed = 2;
    expect(() => parseVerificationResult(badSummary)).toThrow(/summary/u);
  });

  it('rejects cross-project references and duplicate identities in the aggregate', () => {
    const crossProject = project();
    crossProject.sourceFiles[0]!.projectId =
      '01900000-0000-7000-8000-000000000199';
    expect(() => parseProject(crossProject)).toThrow(/projectId/u);

    const duplicateEvidence = project();
    duplicateEvidence.evidenceCards.push({
      ...duplicateEvidence.evidenceCards[0]!,
    });
    expect(() => parseProject(duplicateEvidence)).toThrow(
      /evidenceCards/u,
    );

    const duplicateAcrossEntityTypes = project();
    duplicateAcrossEntityTypes.taskDefinition.id = FILE_ID;
    expect(() => parseProject(duplicateAcrossEntityTypes)).toThrow(
      /identities/u,
    );

    const inventedQuote = project();
    inventedQuote.evidenceCards[0]!.quote = '这段话并不存在于来源分块中';
    expect(() => parseProject(inventedQuote)).toThrow(/quote/u);

    const missingActiveOutline = project();
    missingActiveOutline.activeOutlineId =
      '01900000-0000-7000-8000-000000000198';
    expect(() => parseProject(missingActiveOutline)).toThrow(
      /activeOutlineId/u,
    );
  });

  it('keeps projects without evidence or outlines compatible', () => {
    const emptyProject = project();
    emptyProject.evidenceCards = [];
    emptyProject.outlines = [];
    (
      emptyProject as {
        activeOutlineId: string | null;
      }
    ).activeOutlineId = null;
    emptyProject.artifacts = [];
    emptyProject.verificationResults = [];

    expect(parseProject(emptyProject)).toEqual(emptyProject);
  });
});

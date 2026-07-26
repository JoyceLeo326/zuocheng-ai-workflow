import { describe, expect, it } from 'vitest';
import type { TaskDefinition } from './project-model.js';
import type { TraceableEvidenceCard } from './evidence-operations.js';
import {
  OutlineOperationError,
  addOutlineNode,
  assertValidOutline,
  deleteOutlineNode,
  reorderOutlineNode,
  updateOutlineNode,
  type EvidenceBoundOutline,
} from './outline-operations.js';

const PROJECT_ID = '01900000-0000-7000-8000-000000000301';
const TASK_ID = '01900000-0000-7000-8000-000000000302';
const RUBRIC_ID = '01900000-0000-7000-8000-000000000303';
const OUTLINE_ID = '01900000-0000-7000-8000-000000000304';
const NODE_A_ID = '01900000-0000-7000-8000-000000000305';
const NODE_B_ID = '01900000-0000-7000-8000-000000000306';
const NODE_C_ID = '01900000-0000-7000-8000-000000000307';
const EVIDENCE_A_ID = '01900000-0000-7000-8000-000000000308';
const EVIDENCE_B_ID = '01900000-0000-7000-8000-000000000309';
const FILE_ID = '01900000-0000-7000-8000-000000000310';
const CHUNK_A_ID = '01900000-0000-7000-8000-000000000311';
const CHUNK_B_ID = '01900000-0000-7000-8000-000000000312';
const CREATED_AT = '2026-07-27T03:00:00.000Z';
const UPDATED_AT = '2026-07-27T04:00:00.000Z';

function taskDefinition(): TaskDefinition {
  return {
    id: TASK_ID,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    taskName: '三页课程汇报',
    audience: '课程教师与同学',
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
        description: '每项结论都必须引用材料',
        weightPercent: 100,
      },
    ],
    tone: '清晰克制',
    mustInclude: ['核心结论', '来源索引'],
    mustAvoid: ['无来源数字'],
  };
}

function evidence(
  id: string,
  sourceChunkId: string,
): TraceableEvidenceCard {
  return {
    id,
    version: 2,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    projectId: PROJECT_ID,
    sourceFileId: FILE_ID,
    sourceChunkId,
    sourceFileVersion: 1,
    pageNumber: 1,
    characterStart: 0,
    characterEnd: 6,
    quote: '真实原文证据',
    kind: 'fact',
    note: '',
    citation: '课程报告，第 1 页',
    status: 'verified',
    stance: 'supports',
    confirmationStatus: 'confirmed',
    confirmedAt: UPDATED_AT,
  };
}

function outline(
  overrides: Partial<EvidenceBoundOutline> = {},
): EvidenceBoundOutline {
  return {
    id: OUTLINE_ID,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    projectId: PROJECT_ID,
    title: '问题—证据—行动',
    status: 'selected',
    lockedAt: null,
    nodes: [
      {
        id: NODE_A_ID,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        position: 0,
        title: '核心结论',
        conclusion: '参与度影响任务完成质量。',
        evidenceCardIds: [EVIDENCE_A_ID],
        coveredRequirements: ['核心结论'],
        rubricCriterionIds: [RUBRIC_ID],
        locked: false,
      },
      {
        id: NODE_B_ID,
        version: 1,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        position: 1,
        title: '来源索引',
        conclusion: '每项结论都列出材料来源。',
        evidenceCardIds: [EVIDENCE_B_ID],
        coveredRequirements: ['来源索引'],
        rubricCriterionIds: [],
        locked: false,
      },
    ],
    ...overrides,
  };
}

function validationContext(
  evidenceCards: TraceableEvidenceCard[] = [
    evidence(EVIDENCE_A_ID, CHUNK_A_ID),
    evidence(EVIDENCE_B_ID, CHUNK_B_ID),
  ],
) {
  return {
    taskDefinition: taskDefinition(),
    evidenceCards,
  };
}

describe('outline domain operations', () => {
  it('strictly validates evidence references and complete delivery/rubric coverage', () => {
    const candidate = outline();

    expect(assertValidOutline(candidate, validationContext())).toBe(candidate);
  });

  it('rejects missing, unknown or unconfirmed evidence instead of accepting unsourced nodes', () => {
    expect(() =>
      assertValidOutline(
        {
          ...outline(),
          nodes: [
            {
              ...outline().nodes[0]!,
              evidenceCardIds: [],
            },
            outline().nodes[1]!,
          ],
        },
        validationContext(),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'EVIDENCE_REQUIRED',
      }),
    );

    expect(() =>
      assertValidOutline(
        {
          ...outline(),
          nodes: [
            {
              ...outline().nodes[0]!,
              evidenceCardIds: [NODE_C_ID],
            },
            outline().nodes[1]!,
          ],
        },
        validationContext(),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'UNKNOWN_EVIDENCE',
      }),
    );

    expect(() =>
      assertValidOutline(
        outline(),
        validationContext([
          {
            ...evidence(EVIDENCE_A_ID, CHUNK_A_ID),
            confirmationStatus: 'pending',
            confirmedAt: null,
            status: 'selected',
          },
          evidence(EVIDENCE_B_ID, CHUNK_B_ID),
        ]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'UNCONFIRMED_EVIDENCE',
      }),
    );
  });

  it('rejects incomplete or invented delivery and rubric coverage', () => {
    expect(() =>
      assertValidOutline(
        {
          ...outline(),
          nodes: [
            outline().nodes[0]!,
            {
              ...outline().nodes[1]!,
              coveredRequirements: [],
            },
          ],
        },
        validationContext(),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'MISSING_DELIVERY_COVERAGE',
      }),
    );

    expect(() =>
      assertValidOutline(
        {
          ...outline(),
          nodes: outline().nodes.map((node) => ({
            ...node,
            rubricCriterionIds: [],
          })),
        },
        validationContext(),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'MISSING_RUBRIC_COVERAGE',
      }),
    );

    expect(() =>
      assertValidOutline(
        {
          ...outline(),
          nodes: [
            {
              ...outline().nodes[0]!,
              coveredRequirements: ['不存在的要求'],
            },
            outline().nodes[1]!,
          ],
        },
        validationContext(),
      ),
    ).toThrow(OutlineOperationError);
  });

  it('adds, updates, reorders and deletes nodes immutably with contiguous positions', () => {
    const initial = outline();
    const added = addOutlineNode(initial, {
      id: NODE_C_ID,
      title: '行动建议',
      conclusion: '下一步按证据调整课程任务。',
      evidenceCardIds: [EVIDENCE_A_ID],
      coveredRequirements: [],
      rubricCriterionIds: [],
      now: UPDATED_AT,
    });
    const updated = updateOutlineNode(
      added,
      NODE_C_ID,
      {
        title: '下一步行动',
        conclusion: '下一步按已确认的证据调整课程任务。',
        evidenceCardIds: [EVIDENCE_B_ID],
        coveredRequirements: [],
        rubricCriterionIds: [],
      },
      UPDATED_AT,
    );
    const reordered = reorderOutlineNode(
      updated,
      NODE_C_ID,
      0,
      UPDATED_AT,
    );
    const deleted = deleteOutlineNode(
      reordered,
      NODE_A_ID,
      UPDATED_AT,
    );

    expect(initial.nodes.map((node) => node.id)).toEqual([
      NODE_A_ID,
      NODE_B_ID,
    ]);
    expect(added.nodes.map((node) => node.position)).toEqual([0, 1, 2]);
    expect(updated.nodes[2]).toMatchObject({
      id: NODE_C_ID,
      title: '下一步行动',
      evidenceCardIds: [EVIDENCE_B_ID],
      version: 2,
    });
    expect(reordered.nodes.map((node) => node.id)).toEqual([
      NODE_C_ID,
      NODE_A_ID,
      NODE_B_ID,
    ]);
    expect(deleted.nodes.map((node) => [node.id, node.position])).toEqual([
      [NODE_C_ID, 0],
      [NODE_B_ID, 1],
    ]);
    expect(deleted).toMatchObject({
      version: 5,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
  });

  it('refuses to mutate locked outlines or locked nodes', () => {
    expect(() =>
      addOutlineNode(
        {
          ...outline(),
          status: 'locked',
          lockedAt: UPDATED_AT,
        },
        {
          id: NODE_C_ID,
          title: '行动',
          conclusion: '采取行动。',
          evidenceCardIds: [EVIDENCE_A_ID],
          coveredRequirements: [],
          rubricCriterionIds: [],
          now: UPDATED_AT,
        },
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'OUTLINE_LOCKED',
      }),
    );

    const lockedNodeOutline = {
      ...outline(),
      nodes: [
        {
          ...outline().nodes[0]!,
          locked: true,
        },
        outline().nodes[1]!,
      ],
    };
    expect(() =>
      updateOutlineNode(
        lockedNodeOutline,
        NODE_A_ID,
        { title: '不能修改' },
        UPDATED_AT,
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'NODE_LOCKED',
      }),
    );
    expect(() =>
      deleteOutlineNode(lockedNodeOutline, NODE_A_ID, UPDATED_AT),
    ).toThrow(
      expect.objectContaining({
        code: 'NODE_LOCKED',
      }),
    );
  });

  it('rejects blank authored content and non-contiguous or duplicate node positions', () => {
    expect(() =>
      addOutlineNode(outline(), {
        id: NODE_C_ID,
        title: '',
        conclusion: '',
        evidenceCardIds: [EVIDENCE_A_ID],
        coveredRequirements: [],
        rubricCriterionIds: [],
        now: UPDATED_AT,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_NODE_CONTENT',
      }),
    );

    expect(() =>
      assertValidOutline(
        {
          ...outline(),
          nodes: [
            outline().nodes[0]!,
            {
              ...outline().nodes[1]!,
              position: 0,
            },
          ],
        },
        validationContext(),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_NODE_ORDER',
      }),
    );
  });
});

import { describe, expect, it } from 'vitest';
import type { SourceChunk } from './project-model.js';
import {
  EvidenceOperationError,
  assertEvidenceTraceable,
  confirmEvidence,
  createEvidenceFromSource,
  updateEvidenceStance,
} from './evidence-operations.js';

const PROJECT_ID = '01900000-0000-7000-8000-000000000201';
const FILE_ID = '01900000-0000-7000-8000-000000000202';
const CHUNK_ID = '01900000-0000-7000-8000-000000000203';
const EVIDENCE_ID = '01900000-0000-7000-8000-000000000204';
const CREATED_AT = '2026-07-27T03:00:00.000Z';
const UPDATED_AT = '2026-07-27T04:00:00.000Z';
const TEXT = '数据显示，参与度提升了 18%。但样本规模有限。';

function sourceChunk(
  overrides: Partial<SourceChunk> = {},
): SourceChunk {
  return {
    id: CHUNK_ID,
    version: 1,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    projectId: PROJECT_ID,
    sourceFileId: FILE_ID,
    sourceFileVersion: 3,
    ordinal: 4,
    pageNumber: 7,
    pageLabel: '7',
    characterStart: 120,
    characterEnd: 120 + TEXT.length,
    text: TEXT,
    contentSha256: 'a'.repeat(64),
    ...overrides,
  };
}

function createSelectedEvidence() {
  const chunk = sourceChunk();
  const relativeStart = TEXT.indexOf('参与度');
  const relativeEnd = TEXT.indexOf('。') + 1;
  return createEvidenceFromSource({
    id: EVIDENCE_ID,
    projectId: PROJECT_ID,
    sourceChunk: chunk,
    characterStart: chunk.characterStart + relativeStart,
    characterEnd: chunk.characterStart + relativeEnd,
    kind: 'statistic',
    stance: 'supports',
    note: '支持第一页的参与度结论',
    citation: '课程报告，第 7 页',
    now: CREATED_AT,
  });
}

describe('evidence domain operations', () => {
  it('creates evidence only from an exact source-chunk selection and preserves every anchor', () => {
    const evidence = createSelectedEvidence();

    expect(evidence).toMatchObject({
      id: EVIDENCE_ID,
      version: 1,
      projectId: PROJECT_ID,
      sourceFileId: FILE_ID,
      sourceChunkId: CHUNK_ID,
      sourceFileVersion: 3,
      pageNumber: 7,
      characterStart: 125,
      quote: '参与度提升了 18%。',
      kind: 'statistic',
      stance: 'supports',
      confirmationStatus: 'pending',
      confirmedAt: null,
      status: 'selected',
    });
    expect(evidence.characterEnd - evidence.characterStart).toBe(
      evidence.quote.length,
    );
  });

  it.each([
    [
      'UNSOURCED_EVIDENCE',
      {
        sourceChunk: undefined as unknown as SourceChunk,
      },
    ],
    [
      'PROJECT_MISMATCH',
      {
        projectId: '01900000-0000-7000-8000-000000000299',
      },
    ],
    [
      'INVALID_SOURCE_RANGE',
      {
        characterStart: 0,
        characterEnd: 3,
      },
    ],
  ])('rejects evidence without a real source anchor: %s', (code, patch) => {
    const chunk = sourceChunk();
    expect(() =>
      createEvidenceFromSource({
        id: EVIDENCE_ID,
        projectId: PROJECT_ID,
        sourceChunk: chunk,
        characterStart: chunk.characterStart,
        characterEnd: chunk.characterEnd,
        kind: 'fact',
        stance: 'neutral',
        note: '',
        citation: '课程报告，第 7 页',
        now: CREATED_AT,
        ...patch,
      }),
    ).toThrow(
      expect.objectContaining({
        code,
      }),
    );
  });

  it('records an explicit user confirmation before evidence becomes verified', () => {
    const pending = createSelectedEvidence();
    const confirmed = confirmEvidence(pending, {
      decision: 'confirmed',
      now: UPDATED_AT,
    });

    expect(pending).toMatchObject({
      confirmationStatus: 'pending',
      status: 'selected',
      version: 1,
    });
    expect(confirmed).toMatchObject({
      confirmationStatus: 'confirmed',
      confirmedAt: UPDATED_AT,
      status: 'verified',
      version: 2,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
  });

  it('cannot confirm unverified or uncited material', () => {
    expect(() =>
      confirmEvidence(
        {
          ...createSelectedEvidence(),
          kind: 'unverified',
        },
        {
          decision: 'confirmed',
          now: UPDATED_AT,
        },
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'UNCONFIRMABLE_EVIDENCE',
      }),
    );

    expect(() =>
      confirmEvidence(
        {
          ...createSelectedEvidence(),
          citation: '',
        },
        {
          decision: 'confirmed',
          now: UPDATED_AT,
        },
      ),
    ).toThrow(EvidenceOperationError);
  });

  it('supports explicit supporting, opposing and neutral stances without changing the source quote', () => {
    const original = createSelectedEvidence();
    const opposing = updateEvidenceStance(original, 'opposes', UPDATED_AT);
    const neutral = updateEvidenceStance(opposing, 'neutral', UPDATED_AT);

    expect(original.stance).toBe('supports');
    expect(opposing).toMatchObject({
      stance: 'opposes',
      quote: original.quote,
      sourceChunkId: original.sourceChunkId,
      version: 2,
    });
    expect(neutral.stance).toBe('neutral');
  });

  it('strictly rejects any card whose quote, page or offsets drift from its source chunk', () => {
    const evidence = confirmEvidence(createSelectedEvidence(), {
      decision: 'confirmed',
      now: UPDATED_AT,
    });

    expect(assertEvidenceTraceable(evidence, [sourceChunk()])).toBe(evidence);
    expect(() =>
      assertEvidenceTraceable(
        {
          ...evidence,
          quote: '参与度提升了 81%。',
        },
        [sourceChunk()],
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'SOURCE_QUOTE_MISMATCH',
      }),
    );
    expect(() =>
      assertEvidenceTraceable(
        {
          ...evidence,
          pageNumber: 8,
        },
        [sourceChunk()],
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'SOURCE_ANCHOR_MISMATCH',
      }),
    );
  });
});

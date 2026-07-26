import type {
  EntityId,
  EvidenceCard,
  EvidenceKind,
  IsoDateTime,
  SourceChunk,
} from './project-model.js';

export type EvidenceStance = 'supports' | 'opposes' | 'neutral';
export type EvidenceConfirmationStatus =
  | 'pending'
  | 'confirmed'
  | 'rejected';

export interface TraceableEvidenceCard extends EvidenceCard {
  stance: EvidenceStance;
  confirmationStatus: EvidenceConfirmationStatus;
  confirmedAt: IsoDateTime | null;
}

export type EvidenceOperationErrorCode =
  | 'UNSOURCED_EVIDENCE'
  | 'PROJECT_MISMATCH'
  | 'INVALID_SOURCE_RANGE'
  | 'INVALID_EVIDENCE_INPUT'
  | 'INVALID_STANCE'
  | 'INVALID_CONFIRMATION_STATE'
  | 'UNCONFIRMABLE_EVIDENCE'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_ANCHOR_MISMATCH'
  | 'SOURCE_QUOTE_MISMATCH';

export class EvidenceOperationError extends Error {
  constructor(
    readonly code: EvidenceOperationErrorCode,
    readonly path: string,
  ) {
    super(`Evidence operation rejected at ${path}: ${code}`);
    this.name = 'EvidenceOperationError';
  }
}

export interface CreateEvidenceFromSourceInput {
  id: EntityId;
  projectId: EntityId;
  sourceChunk: SourceChunk;
  characterStart: number;
  characterEnd: number;
  kind: EvidenceKind;
  stance: EvidenceStance;
  note: string;
  citation: string;
  now: IsoDateTime;
}

export interface ConfirmEvidenceInput {
  decision: Exclude<EvidenceConfirmationStatus, 'pending'>;
  now: IsoDateTime;
}

const EVIDENCE_KINDS = new Set<EvidenceKind>([
  'fact',
  'opinion',
  'statistic',
  'case',
  'unverified',
]);
const EVIDENCE_STANCES = new Set<EvidenceStance>([
  'supports',
  'opposes',
  'neutral',
]);

export function createEvidenceFromSource(
  input: CreateEvidenceFromSourceInput,
): TraceableEvidenceCard {
  const chunk = input.sourceChunk;
  if (typeof chunk !== 'object' || chunk === null) {
    fail('UNSOURCED_EVIDENCE', 'sourceChunk');
  }
  if (input.projectId !== chunk.projectId) {
    fail('PROJECT_MISMATCH', 'projectId');
  }
  assertRequiredText(input.id, 'id');
  assertRequiredText(input.projectId, 'projectId');
  assertTimestamp(input.now, 'now');
  if (!EVIDENCE_KINDS.has(input.kind)) {
    fail('INVALID_EVIDENCE_INPUT', 'kind');
  }
  assertStance(input.stance);
  assertText(input.note, 'note', true);
  assertText(input.citation, 'citation', true);
  assertChunkTextAnchor(chunk);
  assertSelectionRange(
    input.characterStart,
    input.characterEnd,
    chunk,
  );

  const relativeStart = input.characterStart - chunk.characterStart;
  const relativeEnd = input.characterEnd - chunk.characterStart;
  const quote = chunk.text.slice(relativeStart, relativeEnd);
  if (quote.trim().length === 0) {
    fail('INVALID_SOURCE_RANGE', 'characterStart');
  }

  return {
    id: input.id,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
    projectId: input.projectId,
    sourceFileId: chunk.sourceFileId,
    sourceChunkId: chunk.id,
    sourceFileVersion: chunk.sourceFileVersion,
    pageNumber: chunk.pageNumber,
    characterStart: input.characterStart,
    characterEnd: input.characterEnd,
    quote,
    kind: input.kind,
    note: input.note,
    citation: input.citation,
    status: 'selected',
    stance: input.stance,
    confirmationStatus: 'pending',
    confirmedAt: null,
  };
}

export function confirmEvidence(
  evidence: TraceableEvidenceCard,
  input: ConfirmEvidenceInput,
): TraceableEvidenceCard {
  assertTimestamp(input.now, 'now');
  if (evidence.confirmationStatus !== 'pending') {
    fail('INVALID_CONFIRMATION_STATE', 'confirmationStatus');
  }
  if (input.decision === 'confirmed') {
    if (
      evidence.kind === 'unverified' ||
      evidence.citation.trim().length === 0
    ) {
      fail('UNCONFIRMABLE_EVIDENCE', 'confirmationStatus');
    }
    return {
      ...evidence,
      version: evidence.version + 1,
      updatedAt: input.now,
      status: 'verified',
      confirmationStatus: 'confirmed',
      confirmedAt: input.now,
    };
  }
  if (input.decision !== 'rejected') {
    fail('INVALID_CONFIRMATION_STATE', 'confirmationStatus');
  }
  return {
    ...evidence,
    version: evidence.version + 1,
    updatedAt: input.now,
    status: 'rejected',
    confirmationStatus: 'rejected',
    confirmedAt: null,
  };
}

export function updateEvidenceStance(
  evidence: TraceableEvidenceCard,
  stance: EvidenceStance,
  now: IsoDateTime,
): TraceableEvidenceCard {
  assertStance(stance);
  assertTimestamp(now, 'now');
  return {
    ...evidence,
    version: evidence.version + 1,
    updatedAt: now,
    stance,
  };
}

export function assertEvidenceTraceable(
  evidence: TraceableEvidenceCard,
  sourceChunks: readonly SourceChunk[],
): TraceableEvidenceCard {
  assertStance(evidence.stance);
  const chunk = sourceChunks.find(
    (candidate) => candidate.id === evidence.sourceChunkId,
  );
  if (chunk === undefined) {
    fail('SOURCE_NOT_FOUND', 'sourceChunkId');
  }
  assertChunkTextAnchor(chunk);
  if (
    evidence.projectId !== chunk.projectId ||
    evidence.sourceFileId !== chunk.sourceFileId ||
    evidence.sourceFileVersion !== chunk.sourceFileVersion ||
    evidence.pageNumber !== chunk.pageNumber
  ) {
    fail('SOURCE_ANCHOR_MISMATCH', 'sourceChunkId');
  }
  assertSelectionRange(
    evidence.characterStart,
    evidence.characterEnd,
    chunk,
  );
  const quote = chunk.text.slice(
    evidence.characterStart - chunk.characterStart,
    evidence.characterEnd - chunk.characterStart,
  );
  if (evidence.quote !== quote) {
    fail('SOURCE_QUOTE_MISMATCH', 'quote');
  }
  assertConfirmationState(evidence);
  return evidence;
}

function assertConfirmationState(evidence: TraceableEvidenceCard): void {
  if (evidence.confirmationStatus === 'pending') {
    if (
      evidence.confirmedAt !== null ||
      (evidence.status !== 'candidate' && evidence.status !== 'selected')
    ) {
      fail('INVALID_CONFIRMATION_STATE', 'confirmationStatus');
    }
    return;
  }
  if (evidence.confirmationStatus === 'confirmed') {
    if (
      evidence.confirmedAt === null ||
      evidence.status !== 'verified' ||
      evidence.kind === 'unverified' ||
      evidence.citation.trim().length === 0
    ) {
      fail('INVALID_CONFIRMATION_STATE', 'confirmationStatus');
    }
    assertTimestamp(evidence.confirmedAt, 'confirmedAt');
    return;
  }
  if (
    evidence.confirmationStatus !== 'rejected' ||
    evidence.status !== 'rejected' ||
    evidence.confirmedAt !== null
  ) {
    fail('INVALID_CONFIRMATION_STATE', 'confirmationStatus');
  }
}

function assertChunkTextAnchor(chunk: SourceChunk): void {
  if (
    !Number.isSafeInteger(chunk.characterStart) ||
    !Number.isSafeInteger(chunk.characterEnd) ||
    chunk.characterStart < 0 ||
    chunk.characterEnd <= chunk.characterStart ||
    chunk.characterEnd - chunk.characterStart !== chunk.text.length
  ) {
    fail('SOURCE_ANCHOR_MISMATCH', 'sourceChunk');
  }
}

function assertSelectionRange(
  characterStart: number,
  characterEnd: number,
  chunk: SourceChunk,
): void {
  if (
    !Number.isSafeInteger(characterStart) ||
    !Number.isSafeInteger(characterEnd) ||
    characterStart < chunk.characterStart ||
    characterEnd > chunk.characterEnd ||
    characterEnd <= characterStart
  ) {
    fail('INVALID_SOURCE_RANGE', 'characterStart');
  }
}

function assertStance(stance: EvidenceStance): void {
  if (!EVIDENCE_STANCES.has(stance)) {
    fail('INVALID_STANCE', 'stance');
  }
}

function assertRequiredText(value: string, path: string): void {
  assertText(value, path, false);
}

function assertText(
  value: string,
  path: string,
  allowEmpty: boolean,
): void {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    (!allowEmpty && value.length === 0)
  ) {
    fail('INVALID_EVIDENCE_INPUT', path);
  }
}

function assertTimestamp(value: IsoDateTime, path: string): void {
  if (typeof value !== 'string') {
    fail('INVALID_EVIDENCE_INPUT', path);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail('INVALID_EVIDENCE_INPUT', path);
  }
}

function fail(code: EvidenceOperationErrorCode, path: string): never {
  throw new EvidenceOperationError(code, path);
}

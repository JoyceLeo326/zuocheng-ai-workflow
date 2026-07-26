import type {
  EntityId,
  IsoDateTime,
  Outline,
  OutlineNode,
  TaskDefinition,
} from './project-model.js';
import type { TraceableEvidenceCard } from './evidence-operations.js';

export interface EvidenceBoundOutlineNode extends OutlineNode {
  coveredRequirements: string[];
  rubricCriterionIds: EntityId[];
}

export interface EvidenceBoundOutline extends Omit<Outline, 'nodes'> {
  nodes: EvidenceBoundOutlineNode[];
}

export interface OutlineValidationContext {
  taskDefinition: TaskDefinition;
  evidenceCards: readonly TraceableEvidenceCard[];
}

export interface AddOutlineNodeInput {
  id: EntityId;
  title: string;
  conclusion: string;
  evidenceCardIds: readonly EntityId[];
  coveredRequirements: readonly string[];
  rubricCriterionIds: readonly EntityId[];
  now: IsoDateTime;
}

export interface OutlineNodePatch {
  title?: string;
  conclusion?: string;
  evidenceCardIds?: readonly EntityId[];
  coveredRequirements?: readonly string[];
  rubricCriterionIds?: readonly EntityId[];
  locked?: boolean;
}

export type OutlineOperationErrorCode =
  | 'OUTLINE_LOCKED'
  | 'NODE_LOCKED'
  | 'NODE_NOT_FOUND'
  | 'DUPLICATE_NODE_ID'
  | 'INVALID_NODE_CONTENT'
  | 'INVALID_NODE_ORDER'
  | 'INVALID_NODE_REFERENCE'
  | 'EVIDENCE_REQUIRED'
  | 'UNKNOWN_EVIDENCE'
  | 'UNCONFIRMED_EVIDENCE'
  | 'UNKNOWN_DELIVERY_REQUIREMENT'
  | 'UNKNOWN_RUBRIC_CRITERION'
  | 'MISSING_DELIVERY_COVERAGE'
  | 'MISSING_RUBRIC_COVERAGE'
  | 'INVALID_OUTLINE_STATE'
  | 'CANNOT_DELETE_LAST_NODE';

export class OutlineOperationError extends Error {
  constructor(
    readonly code: OutlineOperationErrorCode,
    readonly path: string,
  ) {
    super(`Outline operation rejected at ${path}: ${code}`);
    this.name = 'OutlineOperationError';
  }
}

export function addOutlineNode(
  outline: EvidenceBoundOutline,
  input: AddOutlineNodeInput,
): EvidenceBoundOutline {
  assertOutlineMutable(outline);
  assertTimestamp(input.now, 'now');
  if (outline.nodes.some((node) => node.id === input.id)) {
    fail('DUPLICATE_NODE_ID', 'node.id');
  }
  const node: EvidenceBoundOutlineNode = {
    id: input.id,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
    position: outline.nodes.length,
    title: input.title,
    conclusion: input.conclusion,
    evidenceCardIds: [...input.evidenceCardIds],
    coveredRequirements: [...input.coveredRequirements],
    rubricCriterionIds: [...input.rubricCriterionIds],
    locked: false,
  };
  assertNodeShape(node, 'node');
  return bumpOutline(outline, [...outline.nodes, node], input.now);
}

export function updateOutlineNode(
  outline: EvidenceBoundOutline,
  nodeId: EntityId,
  patch: OutlineNodePatch,
  now: IsoDateTime,
): EvidenceBoundOutline {
  assertOutlineMutable(outline);
  assertTimestamp(now, 'now');
  const nodeIndex = findNodeIndex(outline, nodeId);
  const current = outline.nodes[nodeIndex]!;
  assertNodeMutable(current);
  const updated: EvidenceBoundOutlineNode = {
    ...current,
    version: current.version + 1,
    updatedAt: now,
    title: patch.title ?? current.title,
    conclusion: patch.conclusion ?? current.conclusion,
    evidenceCardIds:
      patch.evidenceCardIds === undefined
        ? [...current.evidenceCardIds]
        : [...patch.evidenceCardIds],
    coveredRequirements:
      patch.coveredRequirements === undefined
        ? [...current.coveredRequirements]
        : [...patch.coveredRequirements],
    rubricCriterionIds:
      patch.rubricCriterionIds === undefined
        ? [...current.rubricCriterionIds]
        : [...patch.rubricCriterionIds],
    locked: patch.locked ?? current.locked,
  };
  assertNodeShape(updated, `nodes[${String(nodeIndex)}]`);
  const nodes = outline.nodes.map((node, index) =>
    index === nodeIndex ? updated : node,
  );
  return bumpOutline(outline, nodes, now);
}

export function deleteOutlineNode(
  outline: EvidenceBoundOutline,
  nodeId: EntityId,
  now: IsoDateTime,
): EvidenceBoundOutline {
  assertOutlineMutable(outline);
  assertTimestamp(now, 'now');
  if (outline.nodes.length === 1) {
    fail('CANNOT_DELETE_LAST_NODE', 'nodes');
  }
  const nodeIndex = findNodeIndex(outline, nodeId);
  assertNodeMutable(outline.nodes[nodeIndex]!);
  if (
    outline.nodes.some(
      (node, index) => index > nodeIndex && node.locked,
    )
  ) {
    fail('NODE_LOCKED', 'nodes');
  }
  const nodes = normalizePositions(
    outline.nodes.filter((node) => node.id !== nodeId),
    now,
  );
  return bumpOutline(outline, nodes, now);
}

export function reorderOutlineNode(
  outline: EvidenceBoundOutline,
  nodeId: EntityId,
  targetPosition: number,
  now: IsoDateTime,
): EvidenceBoundOutline {
  assertOutlineMutable(outline);
  assertTimestamp(now, 'now');
  if (
    !Number.isSafeInteger(targetPosition) ||
    targetPosition < 0 ||
    targetPosition >= outline.nodes.length
  ) {
    fail('INVALID_NODE_ORDER', 'targetPosition');
  }
  const currentPosition = findNodeIndex(outline, nodeId);
  if (currentPosition === targetPosition) {
    return outline;
  }
  const firstAffected = Math.min(currentPosition, targetPosition);
  const lastAffected = Math.max(currentPosition, targetPosition);
  if (
    outline.nodes
      .slice(firstAffected, lastAffected + 1)
      .some((node) => node.locked)
  ) {
    fail('NODE_LOCKED', 'nodes');
  }
  const nodes = [...outline.nodes];
  const [moved] = nodes.splice(currentPosition, 1);
  if (moved === undefined) {
    fail('NODE_NOT_FOUND', 'nodeId');
  }
  nodes.splice(targetPosition, 0, moved);
  return bumpOutline(outline, normalizePositions(nodes, now), now);
}

export function assertValidOutline(
  outline: EvidenceBoundOutline,
  context: OutlineValidationContext,
): EvidenceBoundOutline {
  if (outline.nodes.length === 0) {
    fail('INVALID_OUTLINE_STATE', 'nodes');
  }
  assertLockState(outline);
  const nodeIds = new Set<EntityId>();
  for (const [index, node] of outline.nodes.entries()) {
    if (nodeIds.has(node.id)) {
      fail('DUPLICATE_NODE_ID', `nodes[${String(index)}].id`);
    }
    nodeIds.add(node.id);
    if (node.position !== index) {
      fail('INVALID_NODE_ORDER', `nodes[${String(index)}].position`);
    }
    assertNodeShape(node, `nodes[${String(index)}]`);
  }

  const evidenceById = new Map(
    context.evidenceCards.map((card) => [card.id, card]),
  );
  const allowedRequirements = new Set(
    context.taskDefinition.mustInclude,
  );
  const allowedRubricIds = new Set(
    context.taskDefinition.rubric.map((criterion) => criterion.id),
  );
  const coveredRequirements = new Set<string>();
  const coveredRubricIds = new Set<EntityId>();

  for (const [index, node] of outline.nodes.entries()) {
    for (const evidenceId of node.evidenceCardIds) {
      const evidence = evidenceById.get(evidenceId);
      if (
        evidence === undefined ||
        evidence.projectId !== outline.projectId
      ) {
        fail(
          'UNKNOWN_EVIDENCE',
          `nodes[${String(index)}].evidenceCardIds`,
        );
      }
      if (
        evidence.confirmationStatus !== 'confirmed' ||
        evidence.status !== 'verified'
      ) {
        fail(
          'UNCONFIRMED_EVIDENCE',
          `nodes[${String(index)}].evidenceCardIds`,
        );
      }
    }
    for (const requirement of node.coveredRequirements) {
      if (!allowedRequirements.has(requirement)) {
        fail(
          'UNKNOWN_DELIVERY_REQUIREMENT',
          `nodes[${String(index)}].coveredRequirements`,
        );
      }
      coveredRequirements.add(requirement);
    }
    for (const rubricId of node.rubricCriterionIds) {
      if (!allowedRubricIds.has(rubricId)) {
        fail(
          'UNKNOWN_RUBRIC_CRITERION',
          `nodes[${String(index)}].rubricCriterionIds`,
        );
      }
      coveredRubricIds.add(rubricId);
    }
  }

  if (
    context.taskDefinition.mustInclude.some(
      (requirement) => !coveredRequirements.has(requirement),
    )
  ) {
    fail('MISSING_DELIVERY_COVERAGE', 'coveredRequirements');
  }
  if (
    context.taskDefinition.rubric.some(
      (criterion) => !coveredRubricIds.has(criterion.id),
    )
  ) {
    fail('MISSING_RUBRIC_COVERAGE', 'rubricCriterionIds');
  }
  return outline;
}

function assertNodeShape(
  node: EvidenceBoundOutlineNode,
  path: string,
): void {
  if (
    !isRequiredText(node.id) ||
    !isRequiredText(node.title) ||
    !isRequiredText(node.conclusion)
  ) {
    fail('INVALID_NODE_CONTENT', path);
  }
  if (!Number.isSafeInteger(node.position) || node.position < 0) {
    fail('INVALID_NODE_ORDER', `${path}.position`);
  }
  assertUniqueRequiredStrings(
    node.evidenceCardIds,
    `${path}.evidenceCardIds`,
  );
  if (node.evidenceCardIds.length === 0) {
    fail('EVIDENCE_REQUIRED', `${path}.evidenceCardIds`);
  }
  assertUniqueRequiredStrings(
    node.coveredRequirements,
    `${path}.coveredRequirements`,
  );
  assertUniqueRequiredStrings(
    node.rubricCriterionIds,
    `${path}.rubricCriterionIds`,
  );
}

function assertUniqueRequiredStrings(
  values: readonly string[],
  path: string,
): void {
  if (
    !Array.isArray(values) ||
    values.some((value) => !isRequiredText(value)) ||
    new Set(values).size !== values.length
  ) {
    fail('INVALID_NODE_REFERENCE', path);
  }
}

function isRequiredText(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim()
  );
}

function assertOutlineMutable(outline: EvidenceBoundOutline): void {
  if (outline.status === 'locked' || outline.status === 'archived') {
    fail('OUTLINE_LOCKED', 'status');
  }
}

function assertNodeMutable(node: EvidenceBoundOutlineNode): void {
  if (node.locked) {
    fail('NODE_LOCKED', 'node.locked');
  }
}

function assertLockState(outline: EvidenceBoundOutline): void {
  if (outline.status === 'locked') {
    if (
      outline.lockedAt === null ||
      outline.nodes.some((node) => !node.locked)
    ) {
      fail('INVALID_OUTLINE_STATE', 'lockedAt');
    }
    return;
  }
  if (outline.lockedAt !== null) {
    fail('INVALID_OUTLINE_STATE', 'lockedAt');
  }
}

function findNodeIndex(
  outline: EvidenceBoundOutline,
  nodeId: EntityId,
): number {
  const index = outline.nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) {
    fail('NODE_NOT_FOUND', 'nodeId');
  }
  return index;
}

function normalizePositions(
  nodes: readonly EvidenceBoundOutlineNode[],
  now: IsoDateTime,
): EvidenceBoundOutlineNode[] {
  return nodes.map((node, position) =>
    node.position === position
      ? node
      : {
          ...node,
          version: node.version + 1,
          updatedAt: now,
          position,
        },
  );
}

function bumpOutline(
  outline: EvidenceBoundOutline,
  nodes: EvidenceBoundOutlineNode[],
  now: IsoDateTime,
): EvidenceBoundOutline {
  return {
    ...outline,
    version: outline.version + 1,
    updatedAt: now,
    nodes,
  };
}

function assertTimestamp(value: IsoDateTime, path: string): void {
  if (typeof value !== 'string') {
    fail('INVALID_NODE_CONTENT', path);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail('INVALID_NODE_CONTENT', path);
  }
}

function fail(code: OutlineOperationErrorCode, path: string): never {
  throw new OutlineOperationError(code, path);
}

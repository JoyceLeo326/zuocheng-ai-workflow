import {
  PROJECT_SCHEMA_VERSION,
  parseProject,
  type Artifact,
  type ArtifactKind,
  type IsoDateTime,
  type OutputFormat,
  type Outline,
  type Project,
  type EvidenceKind,
  type RubricCriterion,
  type SourceChunk,
  type SourceFile as ProjectSourceFile,
  type VerificationCheck,
  type VerificationResult,
  type VerificationStatus,
  type VerificationSummary,
} from './project-model.js';
import {
  ProjectNotFoundError,
  type ProjectStore,
} from './project-store.js';
import {
  activateProject as activateLifecycleProject,
  archiveProject as archiveLifecycleProject,
  requestPermanentDelete,
  restoreProject as restoreLifecycleProject,
  trashProject as trashLifecycleProject,
} from './project-lifecycle.js';
import {
  addOutlineNode as addNode,
  assertValidOutline,
  deleteOutlineNode as deleteNode,
  OutlineOperationError,
  reorderOutlineNode as reorderNode,
  updateOutlineNode as updateNode,
  type EvidenceBoundOutline,
  type OutlineNodePatch,
  type OutlineValidationContext,
} from './outline-operations.js';
import {
  beginSourceParsing,
  computeSourceFileSha256,
  createSourceFile,
  isDuplicateSourceHash,
  runPdfParsing,
  validateSourceUpload,
  type PdfParserPort,
  type SourceParserFailureCode,
  type ValidatedSourceUpload,
} from './source-file.js';
import {
  BrowserSourceParserError,
  parseBrowserSourceFile,
  type BrowserSourceParserErrorCode,
  type TraceableTextChunk,
} from './text-parsers.js';
import type { BrowserOfficeParserErrorCode } from './docx-pptx-parser.js';
import {
  createDraftPage,
  insertDraftPage as insertPage,
  moveDraftPage as movePage,
  removeDraftPage as removePage,
  setDraftPageLocked as setPageLocked,
  toProjectVerificationCheckDraft,
  updateDraftPage as updatePage,
  verifyDraft,
  type DraftPage,
  type DraftPagePatch,
} from './draft-verification.js';

export interface WorkbenchRubricFormInput {
  title: string;
  description: string;
  weightPercent: string | number;
}

export type WorkbenchOutputFormatInput =
  | 'presentation'
  | 'report'
  | 'document'
  | OutputFormat;

export interface WorkbenchProjectFormInput {
  projectTitle?: string;
  taskName: string;
  audience: string;
  deadline: string;
  scope: string;
  durationMinutes: string;
  outputFormat: WorkbenchOutputFormatInput;
  tone: string;
  rubric: readonly WorkbenchRubricFormInput[];
  requiredContent: string;
  forbiddenContent: string;
}

export interface WorkbenchEvidenceInput {
  sourceChunkId: string;
  quote: string;
  kind: EvidenceKind;
  stance: 'supports' | 'opposes' | 'neutral';
  note: string;
  citation: string;
  userConfirmed: boolean;
}

export interface WorkbenchOutlineNodeInput {
  title: string;
  conclusion: string;
  evidenceCardIds: readonly string[];
  coveredRequirements: readonly string[];
  rubricCriterionIds: readonly string[];
}

export interface WorkbenchCreateOutlineInput {
  title: string;
  nodes: readonly WorkbenchOutlineNodeInput[];
}

export interface WorkbenchOutlineNodePatchInput {
  title?: string;
  conclusion?: string;
  evidenceCardIds?: readonly string[];
  coveredRequirements?: readonly string[];
  rubricCriterionIds?: readonly string[];
}

export const DRAFT_ARTIFACT_FORMAT =
  'zuocheng-draft-artifact' as const;
export const DRAFT_ARTIFACT_FORMAT_VERSION = 1 as const;

export interface VersionedDraftPage {
  id: string;
  version: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  outlineNodeId: string;
  page: DraftPage;
}

export interface DraftArtifactPayload {
  format: typeof DRAFT_ARTIFACT_FORMAT;
  formatVersion: typeof DRAFT_ARTIFACT_FORMAT_VERSION;
  id: string;
  version: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  pages: readonly VersionedDraftPage[];
}

export interface WorkbenchInsertDraftPageInput {
  outlineNodeId: string;
  index: number;
  page: Omit<DraftPage, 'id' | 'locked'>;
}

export class DraftArtifactPayloadError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'DraftArtifactPayloadError';
  }
}

export function parseDraftArtifactPayload(
  input: unknown,
): DraftArtifactPayload {
  return parseDraftPayloadAt(input, 'draftArtifactPayload');
}

export function readDraftArtifactPayload(
  artifact: Artifact,
): DraftArtifactPayload {
  const payload = parseDraftArtifactPayload(artifact.payload);
  if (payload.id !== artifact.id) {
    failDraftPayload(
      'draftArtifactPayload.id',
      'must match artifact.id',
    );
  }
  if (payload.version !== artifact.version) {
    failDraftPayload(
      'draftArtifactPayload.version',
      'must match artifact.version',
    );
  }
  if (
    payload.createdAt !== artifact.createdAt ||
    payload.updatedAt !== artifact.updatedAt
  ) {
    failDraftPayload(
      'draftArtifactPayload.updatedAt',
      'timestamps must match the artifact',
    );
  }
  return payload;
}

export type SourceIngestionFailureCode =
  | SourceParserFailureCode
  | BrowserSourceParserErrorCode
  | BrowserOfficeParserErrorCode
  | 'INVALID_PARSER_OUTPUT';

export type SourceIngestionResult =
  | Readonly<{
      status: 'ready';
      project: Project;
      sourceFile: ProjectSourceFile;
      chunks: SourceChunk[];
    }>
  | Readonly<{
      status: 'failed';
      project: Project;
      sourceFile: ProjectSourceFile;
      errorCode: SourceIngestionFailureCode;
    }>
  | Readonly<{
      status: 'duplicate';
      project: Project;
      existingSourceFileId: string;
    }>;

export interface WorkbenchService {
  listProjects(): Promise<Project[]>;
  createProject(input: WorkbenchProjectFormInput): Promise<Project>;
  deleteProject(projectId: string): Promise<void>;
  createEvidence(
    projectId: string,
    input: WorkbenchEvidenceInput,
  ): Promise<Project>;
  createOutline(
    projectId: string,
    input: WorkbenchCreateOutlineInput,
  ): Promise<Project>;
  addOutlineNode(
    projectId: string,
    outlineId: string,
    input: WorkbenchOutlineNodeInput,
  ): Promise<Project>;
  updateOutlineNode(
    projectId: string,
    outlineId: string,
    nodeId: string,
    patch: WorkbenchOutlineNodePatchInput,
  ): Promise<Project>;
  deleteOutlineNode(
    projectId: string,
    outlineId: string,
    nodeId: string,
  ): Promise<Project>;
  reorderOutlineNode(
    projectId: string,
    outlineId: string,
    nodeId: string,
    targetPosition: number,
  ): Promise<Project>;
  selectOutline(projectId: string, outlineId: string): Promise<Project>;
  lockOutline(projectId: string, outlineId: string): Promise<Project>;
  ensureDraftArtifact(
    projectId: string,
    outlineId: string,
  ): Promise<Project>;
  insertDraftPage(
    projectId: string,
    artifactId: string,
    input: WorkbenchInsertDraftPageInput,
  ): Promise<Project>;
  updateDraftPage(
    projectId: string,
    artifactId: string,
    pageId: string,
    patch: DraftPagePatch,
  ): Promise<Project>;
  deleteDraftPage(
    projectId: string,
    artifactId: string,
    pageId: string,
  ): Promise<Project>;
  reorderDraftPage(
    projectId: string,
    artifactId: string,
    pageId: string,
    targetIndex: number,
  ): Promise<Project>;
  setDraftPageLocked(
    projectId: string,
    artifactId: string,
    pageId: string,
    locked: boolean,
  ): Promise<Project>;
  verifyDraftArtifact(
    projectId: string,
    artifactId: string,
  ): Promise<Project>;
  ingestSourceFile(
    projectId: string,
    file: File,
  ): Promise<SourceIngestionResult>;
}

export interface WorkbenchProjectLifecycleService
  extends WorkbenchService {
  copyProject(
    projectId: string,
    expectedVersion: number,
  ): Promise<Project>;
  archiveProject(
    projectId: string,
    expectedVersion: number,
  ): Promise<Project>;
  activateProject(
    projectId: string,
    expectedVersion: number,
  ): Promise<Project>;
  trashProject(
    projectId: string,
    expectedVersion: number,
  ): Promise<Project>;
  restoreProject(
    projectId: string,
    expectedVersion: number,
  ): Promise<Project>;
  permanentlyDeleteProject(
    projectId: string,
    expectedVersion: number,
  ): Promise<void>;
}

export type WorkbenchServiceInputErrorCode =
  | 'INVALID_LENGTH_TARGET'
  | 'INVALID_DURATION'
  | 'INVALID_RUBRIC_WEIGHT'
  | 'UNSUPPORTED_OUTPUT_FORMAT'
  | 'UNSUPPORTED_SOURCE_KIND'
  | 'INVALID_DEADLINE'
  | 'INVALID_CLOCK'
  | 'INVALID_PARSER_OUTPUT'
  | 'WEB_CRYPTO_UNAVAILABLE'
  | 'SOURCE_CHUNK_NOT_FOUND'
  | 'SOURCE_QUOTE_MISMATCH'
  | 'AMBIGUOUS_SOURCE_QUOTE'
  | 'DUPLICATE_EVIDENCE'
  | 'EVIDENCE_CONFIRMATION_REQUIRED'
  | 'OUTLINE_NOT_FOUND'
  | 'OUTLINE_NOT_SELECTED'
  | 'OUTLINE_NODE_NOT_FOUND'
  | 'DRAFT_ARTIFACT_NOT_FOUND'
  | 'DRAFT_ARTIFACT_NOT_EDITABLE'
  | 'DRAFT_EVIDENCE_NOT_FOUND'
  | 'DRAFT_RUBRIC_NOT_FOUND';

export class WorkbenchServiceInputError extends Error {
  constructor(readonly code: WorkbenchServiceInputErrorCode) {
    super(`Workbench input rejected: ${code}`);
    this.name = 'WorkbenchServiceInputError';
  }
}

export interface CreateWorkbenchServiceOptions {
  store: ProjectStore;
  pdfParser?: PdfParserPort;
  now?: () => Date;
  idFactory?: () => string;
  cryptoProvider?: Crypto;
}

export function createWorkbenchService(
  options: CreateWorkbenchServiceOptions,
): WorkbenchProjectLifecycleService {
  const cryptoProvider = options.cryptoProvider ?? globalThis.crypto;
  const now = options.now ?? (() => new Date());
  const idFactory =
    options.idFactory ??
    (() => createUuidV7(cryptoProvider, now().valueOf()));
  return new DefaultWorkbenchService(
    options.store,
    options.pdfParser ?? lazyPdfJsParser,
    now,
    idFactory,
    cryptoProvider,
  );
}

const lazyPdfJsParser: PdfParserPort = {
  async parsePdf(input) {
    const { PdfJsParser } = await import('./pdfjs-parser.js');
    return new PdfJsParser().parsePdf(input);
  },
};

class DefaultWorkbenchService
  implements WorkbenchProjectLifecycleService
{
  constructor(
    private readonly store: ProjectStore,
    private readonly pdfParser: PdfParserPort,
    private readonly now: () => Date,
    private readonly idFactory: () => string,
    private readonly cryptoProvider: Crypto | undefined,
  ) {}

  async listProjects(): Promise<Project[]> {
    return this.store.listProjects();
  }

  async createProject(input: WorkbenchProjectFormInput): Promise<Project> {
    const timestamp = this.timestamp();
    const rubric = parseRubric(input.rubric, timestamp, this.idFactory);
    const project = parseProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      id: this.idFactory(),
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      title: normalizedProjectTitle(input),
      status: 'active',
      statusBeforeTrash: null,
      trashedAt: null,
      taskDefinition: {
        id: this.idFactory(),
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        taskName: input.taskName,
        audience: input.audience,
        dueAt: parseDeadline(input.deadline),
        lengthTarget: parseLengthTarget(input.scope),
        presentationDurationMinutes: parseDuration(input.durationMinutes),
        outputFormats: parseOutputFormats(input.outputFormat),
        rubric,
        tone: input.tone,
        mustInclude: parseLines(input.requiredContent),
        mustAvoid: parseLines(input.forbiddenContent),
      },
      sourceFiles: [],
      sourceChunks: [],
      evidenceCards: [],
      outlines: [],
      activeOutlineId: null,
      artifacts: [],
      verificationResults: [],
    });
    return this.store.createProject(project);
  }

  async deleteProject(projectId: string): Promise<void> {
    const current = await this.requireProject(projectId);
    await this.permanentlyDeleteProject(projectId, current.version);
  }

  async copyProject(
    projectId: string,
    expectedVersion: number,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    return this.store.copyProject(projectId, {
      expectedVersion,
      now: this.timestampAfter(current.updatedAt),
      idFactory: this.idFactory,
    });
  }

  async archiveProject(
    projectId: string,
    expectedVersion: number,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const next = archiveLifecycleProject(current, {
      expectedVersion,
      now: this.timestampAfter(current.updatedAt),
    });
    return this.store.saveProject(next, expectedVersion);
  }

  async activateProject(
    projectId: string,
    expectedVersion: number,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const next = activateLifecycleProject(current, {
      expectedVersion,
      now: this.timestampAfter(current.updatedAt),
    });
    return this.store.saveProject(next, expectedVersion);
  }

  async trashProject(
    projectId: string,
    expectedVersion: number,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const next = trashLifecycleProject(current, {
      expectedVersion,
      now: this.timestampAfter(current.updatedAt),
    });
    return this.store.saveProject(next, expectedVersion);
  }

  async restoreProject(
    projectId: string,
    expectedVersion: number,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const next = restoreLifecycleProject(current, {
      expectedVersion,
      now: this.timestampAfter(current.updatedAt),
    });
    return this.store.saveProject(next, expectedVersion);
  }

  async permanentlyDeleteProject(
    projectId: string,
    expectedVersion: number,
  ): Promise<void> {
    const current = await this.requireProject(projectId);
    const intent = requestPermanentDelete(current, {
      expectedVersion,
      now: this.timestampAfter(current.updatedAt),
    });
    await this.store.deleteProject(intent);
  }

  async createEvidence(
    projectId: string,
    input: WorkbenchEvidenceInput,
  ): Promise<Project> {
    const current = await this.store.getProject(projectId);
    if (current === null) {
      throw new ProjectNotFoundError(projectId);
    }
    const chunk = current.sourceChunks.find(
      (candidate) => candidate.id === input.sourceChunkId,
    );
    if (chunk === undefined) {
      throw new WorkbenchServiceInputError('SOURCE_CHUNK_NOT_FOUND');
    }
    if (input.quote.trim().length === 0) {
      throw new WorkbenchServiceInputError('SOURCE_QUOTE_MISMATCH');
    }
    const relativeStart = chunk.text.indexOf(input.quote);
    if (relativeStart < 0) {
      throw new WorkbenchServiceInputError('SOURCE_QUOTE_MISMATCH');
    }
    if (chunk.text.lastIndexOf(input.quote) !== relativeStart) {
      throw new WorkbenchServiceInputError('AMBIGUOUS_SOURCE_QUOTE');
    }
    const characterStart = chunk.characterStart + relativeStart;
    const characterEnd = characterStart + input.quote.length;
    if (
      current.evidenceCards.some(
        (evidence) =>
          evidence.sourceChunkId === chunk.id &&
          evidence.characterStart === characterStart &&
          evidence.characterEnd === characterEnd,
      )
    ) {
      throw new WorkbenchServiceInputError('DUPLICATE_EVIDENCE');
    }
    if (
      input.userConfirmed &&
      (input.kind === 'unverified' ||
        input.citation.trim().length === 0)
    ) {
      throw new WorkbenchServiceInputError(
        'EVIDENCE_CONFIRMATION_REQUIRED',
      );
    }

    const updatedAt = this.timestampAfter(current.updatedAt);
    const next = parseProject({
      ...current,
      version: current.version + 1,
      updatedAt,
      evidenceCards: [
        ...current.evidenceCards,
        {
          id: this.idFactory(),
          version: 1,
          createdAt: updatedAt,
          updatedAt,
          projectId,
          sourceFileId: chunk.sourceFileId,
          sourceChunkId: chunk.id,
          sourceFileVersion: chunk.sourceFileVersion,
          pageNumber: chunk.pageNumber,
          characterStart,
          characterEnd,
          quote: input.quote,
          kind: input.kind,
          note: input.note.trim(),
          citation: input.citation.trim(),
          status: input.userConfirmed ? 'verified' : 'selected',
          stance: input.stance,
          confirmationStatus: input.userConfirmed
            ? 'confirmed'
            : 'pending',
          userConfirmedAt: input.userConfirmed ? updatedAt : null,
        },
      ],
    });
    return this.store.saveProject(next, current.version);
  }

  async createOutline(
    projectId: string,
    input: WorkbenchCreateOutlineInput,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const updatedAt = this.timestampAfter(current.updatedAt);
    let outline: EvidenceBoundOutline = {
      id: this.idFactory(),
      version: 1,
      createdAt: updatedAt,
      updatedAt,
      projectId,
      title: input.title,
      status: 'draft',
      lockedAt: null,
      nodes: [],
    };
    for (const node of input.nodes) {
      outline = addNode(outline, {
        id: this.idFactory(),
        title: node.title,
        conclusion: node.conclusion,
        evidenceCardIds: node.evidenceCardIds,
        coveredRequirements: node.coveredRequirements,
        rubricCriterionIds: node.rubricCriterionIds,
        now: updatedAt,
      });
    }
    outline = {
      ...outline,
      version: 1,
    };
    this.assertOutlineReferences(outline, current);
    return this.saveOutline(current, outline, updatedAt);
  }

  async addOutlineNode(
    projectId: string,
    outlineId: string,
    input: WorkbenchOutlineNodeInput,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const outline = this.findOutline(current, outlineId);
    const updatedAt = this.timestampAfter(current.updatedAt);
    const updated = addNode(outline, {
      id: this.idFactory(),
      title: input.title,
      conclusion: input.conclusion,
      evidenceCardIds: input.evidenceCardIds,
      coveredRequirements: input.coveredRequirements,
      rubricCriterionIds: input.rubricCriterionIds,
      now: updatedAt,
    });
    this.assertOutlineForPersistence(updated, current);
    return this.saveOutline(current, updated, updatedAt);
  }

  async updateOutlineNode(
    projectId: string,
    outlineId: string,
    nodeId: string,
    patch: WorkbenchOutlineNodePatchInput,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const outline = this.findOutline(current, outlineId);
    const updatedAt = this.timestampAfter(current.updatedAt);
    const operationPatch: OutlineNodePatch = {};
    if (patch.title !== undefined) {
      operationPatch.title = patch.title;
    }
    if (patch.conclusion !== undefined) {
      operationPatch.conclusion = patch.conclusion;
    }
    if (patch.evidenceCardIds !== undefined) {
      operationPatch.evidenceCardIds = patch.evidenceCardIds;
    }
    if (patch.coveredRequirements !== undefined) {
      operationPatch.coveredRequirements = patch.coveredRequirements;
    }
    if (patch.rubricCriterionIds !== undefined) {
      operationPatch.rubricCriterionIds = patch.rubricCriterionIds;
    }
    const updated = updateNode(
      outline,
      nodeId,
      operationPatch,
      updatedAt,
    );
    this.assertOutlineForPersistence(updated, current);
    return this.saveOutline(current, updated, updatedAt);
  }

  async deleteOutlineNode(
    projectId: string,
    outlineId: string,
    nodeId: string,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const outline = this.findOutline(current, outlineId);
    const updatedAt = this.timestampAfter(current.updatedAt);
    const updated = deleteNode(outline, nodeId, updatedAt);
    this.assertOutlineForPersistence(updated, current);
    return this.saveOutline(current, updated, updatedAt);
  }

  async reorderOutlineNode(
    projectId: string,
    outlineId: string,
    nodeId: string,
    targetPosition: number,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const outline = this.findOutline(current, outlineId);
    const updatedAt = this.timestampAfter(current.updatedAt);
    const updated = reorderNode(
      outline,
      nodeId,
      targetPosition,
      updatedAt,
    );
    this.assertOutlineForPersistence(updated, current);
    return this.saveOutline(current, updated, updatedAt);
  }

  async selectOutline(
    projectId: string,
    outlineId: string,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const outline = this.findOutline(current, outlineId);
    if (outline.status === 'locked' || outline.status === 'archived') {
      throw new OutlineOperationError('OUTLINE_LOCKED', 'status');
    }
    const updatedAt = this.timestampAfter(current.updatedAt);
    const selected: EvidenceBoundOutline = {
      ...outline,
      version: outline.version + 1,
      updatedAt,
      status: 'selected',
      lockedAt: null,
    };
    this.assertOutlineForPersistence(selected, current);
    return this.saveOutline(
      current,
      selected,
      updatedAt,
      selected.id,
    );
  }

  async lockOutline(
    projectId: string,
    outlineId: string,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const outline = this.findOutline(current, outlineId);
    if (outline.status === 'locked' || outline.status === 'archived') {
      throw new OutlineOperationError('OUTLINE_LOCKED', 'status');
    }
    if (
      outline.status !== 'selected' ||
      current.activeOutlineId !== outline.id
    ) {
      throw new WorkbenchServiceInputError('OUTLINE_NOT_SELECTED');
    }

    const updatedAt = this.timestampAfter(current.updatedAt);
    let withLockedNodes = outline;
    for (const node of outline.nodes) {
      withLockedNodes = updateNode(
        withLockedNodes,
        node.id,
        { locked: true },
        updatedAt,
      );
    }
    const locked: EvidenceBoundOutline = {
      ...withLockedNodes,
      version: outline.version + 1,
      updatedAt,
      status: 'locked',
      lockedAt: updatedAt,
    };
    this.assertOutlineForPersistence(locked, current);
    return this.saveOutline(current, locked, updatedAt, locked.id);
  }

  async ensureDraftArtifact(
    projectId: string,
    outlineId: string,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const outline = this.requireDraftOutline(current, outlineId);
    const existing = current.artifacts.find(
      (artifact) =>
        artifact.outlineId === outlineId &&
        isDraftPayloadCandidate(artifact.payload),
    );
    if (existing !== undefined) {
      this.requireEditableDraftArtifact(current, existing.id);
      return current;
    }

    const updatedAt = this.timestampAfter(current.updatedAt);
    const artifactId = this.idFactory();
    const payload: DraftArtifactPayload = {
      format: DRAFT_ARTIFACT_FORMAT,
      formatVersion: DRAFT_ARTIFACT_FORMAT_VERSION,
      id: artifactId,
      version: 1,
      createdAt: updatedAt,
      updatedAt,
      pages: [],
    };
    const artifact: Artifact = {
      id: artifactId,
      version: 1,
      createdAt: updatedAt,
      updatedAt,
      projectId,
      outlineId,
      outlineVersion: outline.version,
      kind: draftArtifactKind(current),
      status: 'draft',
      payload: draftPayloadJson(parseDraftArtifactPayload(payload)),
      blobId: null,
      contentSha256: null,
      staleBecause: [],
      errorCode: null,
    };
    const next = parseProject({
      ...current,
      version: current.version + 1,
      updatedAt,
      artifacts: [...current.artifacts, artifact],
    });
    return this.store.saveProject(next, current.version);
  }

  async insertDraftPage(
    projectId: string,
    artifactId: string,
    input: WorkbenchInsertDraftPageInput,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const { artifact, outline, payload } =
      this.requireEditableDraftArtifact(current, artifactId);
    const updatedAt = this.timestampAfter(current.updatedAt);
    const pageId = this.idFactory();
    const page = createDraftPage({
      ...input.page,
      id: pageId,
      locked: false,
    });
    const pages = insertPage(
      payload.pages.map((record) => record.page),
      page,
      input.index,
    );
    const inserted: VersionedDraftPage = {
      id: pageId,
      version: 1,
      createdAt: updatedAt,
      updatedAt,
      outlineNodeId: input.outlineNodeId,
      page,
    };
    const byId = new Map(
      payload.pages.map((record) => [record.id, record]),
    );
    byId.set(inserted.id, inserted);
    const records = pages.map((candidate) => byId.get(candidate.id)!);
    this.assertDraftPageReferences(records, current, outline);
    return this.saveDraftPages(
      current,
      artifact,
      payload,
      records,
      updatedAt,
    );
  }

  async updateDraftPage(
    projectId: string,
    artifactId: string,
    pageId: string,
    patch: DraftPagePatch,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const { artifact, outline, payload } =
      this.requireEditableDraftArtifact(current, artifactId);
    const updatedAt = this.timestampAfter(current.updatedAt);
    const pages = updatePage(
      payload.pages.map((record) => record.page),
      pageId,
      patch,
    );
    const records = payload.pages.map((record) => {
      if (record.id !== pageId) {
        return record;
      }
      const page = pages.find((candidate) => candidate.id === pageId)!;
      return {
        ...record,
        version: record.version + 1,
        updatedAt,
        page,
      };
    });
    this.assertDraftPageReferences(records, current, outline);
    return this.saveDraftPages(
      current,
      artifact,
      payload,
      records,
      updatedAt,
    );
  }

  async deleteDraftPage(
    projectId: string,
    artifactId: string,
    pageId: string,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const { artifact, outline, payload } =
      this.requireEditableDraftArtifact(current, artifactId);
    const updatedAt = this.timestampAfter(current.updatedAt);
    const pages = removePage(
      payload.pages.map((record) => record.page),
      pageId,
    );
    const recordsById = new Map(
      payload.pages.map((record) => [record.id, record]),
    );
    const records = pages.map((page) => recordsById.get(page.id)!);
    this.assertDraftPageReferences(records, current, outline);
    return this.saveDraftPages(
      current,
      artifact,
      payload,
      records,
      updatedAt,
    );
  }

  async reorderDraftPage(
    projectId: string,
    artifactId: string,
    pageId: string,
    targetIndex: number,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const { artifact, outline, payload } =
      this.requireEditableDraftArtifact(current, artifactId);
    const updatedAt = this.timestampAfter(current.updatedAt);
    const pages = movePage(
      payload.pages.map((record) => record.page),
      pageId,
      targetIndex,
    );
    const recordsById = new Map(
      payload.pages.map((record) => [record.id, record]),
    );
    const records = pages.map((page) => recordsById.get(page.id)!);
    this.assertDraftPageReferences(records, current, outline);
    return this.saveDraftPages(
      current,
      artifact,
      payload,
      records,
      updatedAt,
    );
  }

  async setDraftPageLocked(
    projectId: string,
    artifactId: string,
    pageId: string,
    locked: boolean,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const { artifact, outline, payload } =
      this.requireEditableDraftArtifact(current, artifactId);
    const updatedAt = this.timestampAfter(current.updatedAt);
    const pages = setPageLocked(
      payload.pages.map((record) => record.page),
      pageId,
      locked,
    );
    const records = payload.pages.map((record) => {
      if (record.id !== pageId) {
        return record;
      }
      const page = pages.find((candidate) => candidate.id === pageId)!;
      return {
        ...record,
        version: record.version + 1,
        updatedAt,
        page,
      };
    });
    this.assertDraftPageReferences(records, current, outline);
    return this.saveDraftPages(
      current,
      artifact,
      payload,
      records,
      updatedAt,
    );
  }

  async verifyDraftArtifact(
    projectId: string,
    artifactId: string,
  ): Promise<Project> {
    const current = await this.requireProject(projectId);
    const { artifact, outline, payload } =
      this.requireEditableDraftArtifact(current, artifactId);
    this.assertDraftPageReferences(payload.pages, current, outline);
    const checkedAt = this.timestampAfter(current.updatedAt);
    const drafts = verifyDraft({
      pages: payload.pages.map((record) => record.page),
      taskDefinition: current.taskDefinition,
      evidenceCards: current.evidenceCards,
    }).map(toProjectVerificationCheckDraft);
    const existing = current.verificationResults.find(
      (result) => result.artifactId === artifact.id,
    );
    const previousChecks = new Map<string, VerificationCheck[]>();
    for (const check of existing?.checks ?? []) {
      const key = verificationCheckKey(check);
      const matches = previousChecks.get(key) ?? [];
      matches.push(check);
      previousChecks.set(key, matches);
    }
    const checks: VerificationCheck[] = drafts.map((draft) => {
      const key = verificationCheckKey(draft);
      const matches = previousChecks.get(key);
      const previous = matches?.shift();
      return {
        id: previous?.id ?? this.idFactory(),
        version: previous === undefined ? 1 : previous.version + 1,
        createdAt: previous?.createdAt ?? checkedAt,
        updatedAt: checkedAt,
        ...draft,
        evidenceCardIds: [...draft.evidenceCardIds],
      };
    });
    const summary = verificationSummary(checks);
    const result: VerificationResult = {
      id: existing?.id ?? this.idFactory(),
      version: existing === undefined ? 1 : existing.version + 1,
      createdAt: existing?.createdAt ?? checkedAt,
      updatedAt: checkedAt,
      projectId,
      artifactId,
      artifactVersion: artifact.version,
      status: verificationStatus(summary),
      checkedAt,
      checks,
      summary,
    };
    const next = parseProject({
      ...current,
      version: current.version + 1,
      updatedAt: checkedAt,
      verificationResults: [
        ...current.verificationResults.filter(
          (candidate) => candidate.artifactId !== artifactId,
        ),
        result,
      ],
    });
    return this.store.saveProject(next, current.version);
  }

  async ingestSourceFile(
    projectId: string,
    file: File,
  ): Promise<SourceIngestionResult> {
    const current = await this.store.getProject(projectId);
    if (current === null) {
      throw new ProjectNotFoundError(projectId);
    }
    const upload = validateSourceUpload(file);
    const sha256 = await computeSourceFileSha256(
      file,
      this.cryptoProvider,
    );
    const existing = current.sourceFiles.find(
      (source) => source.contentSha256 === sha256,
    );
    if (
      isDuplicateSourceHash(
        sha256,
        current.sourceFiles.map((source) => ({
          sha256: source.contentSha256,
        })),
      )
    ) {
      if (existing === undefined) {
        throw new Error('duplicate source hash invariant failed');
      }
      return {
        status: 'duplicate',
        project: current,
        existingSourceFileId: existing.id,
      };
    }

    const sourceId = this.idFactory();
    const domainSource = createSourceFile({
      id: sourceId,
      upload,
      sha256,
    });
    const pendingAt = this.timestampAfter(current.updatedAt);
    const pendingSource = createProjectSourceFile({
      id: sourceId,
      projectId,
      upload,
      sha256,
      timestamp: pendingAt,
    });
    const pendingProject = await this.saveSourceState(
      current,
      pendingSource,
      pendingAt,
    );
    await this.store.putSourceBlob(projectId, sourceId, file);

    const parsingDomainSource = beginSourceParsing(domainSource);
    const parsingAt = this.timestampAfter(pendingProject.updatedAt);
    const parsingSource: ProjectSourceFile = {
      ...pendingSource,
      version: pendingSource.version + 1,
      updatedAt: parsingAt,
      status: 'parsing',
      parseProgress: 0,
    };
    const parsingProject = await this.saveSourceState(
      pendingProject,
      parsingSource,
      parsingAt,
    );
    const chunksAt = this.timestampAfter(parsingProject.updatedAt);
    let chunks: SourceChunk[];
    let pageCount: number;
    if (upload.kind === 'pdf') {
      const parsedDomainSource = await runPdfParsing(
        parsingDomainSource,
        file,
        this.pdfParser,
      );
      if (parsedDomainSource.parsing.status === 'failed') {
        return this.persistParseFailure(
          parsingProject,
          parsingSource,
          parsedDomainSource.parsing.code,
        );
      }
      if (parsedDomainSource.parsing.status !== 'parsed') {
        return this.persistParseFailure(
          parsingProject,
          parsingSource,
          'INVALID_PARSER_OUTPUT',
        );
      }
      pageCount = parsedDomainSource.parsing.pageCount;
      try {
        chunks = await this.createProjectChunks(
          parsingProject.id,
          parsingSource,
          parsedDomainSource.parsing.chunks,
          chunksAt,
        );
      } catch (error) {
        if (error instanceof WorkbenchServiceInputError) {
          return this.persistParseFailure(
            parsingProject,
            parsingSource,
            'INVALID_PARSER_OUTPUT',
          );
        }
        throw error;
      }
    } else if (upload.kind === 'docx' || upload.kind === 'pptx') {
      const {
        BrowserOfficeParserError,
        parseBrowserOfficeFile,
      } = await import('./docx-pptx-parser.js');
      try {
        const parsed = await parseBrowserOfficeFile(
          {
            file,
            source: parsingDomainSource,
            sourceFileVersion: parsingSource.sourceVersion,
          },
          this.cryptoProvider,
        );
        chunks = this.createTraceableProjectChunks(
          parsingProject.id,
          parsingSource,
          parsed.chunks,
          chunksAt,
        );
        pageCount = parsed.pageCount;
      } catch (error) {
        if (error instanceof BrowserOfficeParserError) {
          return this.persistParseFailure(
            parsingProject,
            parsingSource,
            error.code,
          );
        }
        throw error;
      }
    } else {
      try {
        const parsed = await parseBrowserSourceFile(
          {
            file,
            source: parsingDomainSource,
            sourceFileVersion: parsingSource.sourceVersion,
          },
          this.cryptoProvider,
        );
        if (parsed.status === 'ocr-required') {
          return this.persistParseFailure(
            parsingProject,
            parsingSource,
            'OCR_REQUIRED',
          );
        }
        chunks = this.createTraceableProjectChunks(
          parsingProject.id,
          parsingSource,
          parsed.chunks,
          chunksAt,
        );
        pageCount = new Set(
          parsed.chunks.map((chunk) => chunk.pageNumber),
        ).size;
      } catch (error) {
        if (error instanceof BrowserSourceParserError) {
          return this.persistParseFailure(
            parsingProject,
            parsingSource,
            error.code,
          );
        }
        throw error;
      }
    }

    const withChunks = await this.store.replaceSourceChunks(
      projectId,
      sourceId,
      chunks,
      parsingProject.version,
      chunksAt,
    );
    const readyAt = this.timestampAfter(withChunks.updatedAt);
    const readySource: ProjectSourceFile = {
      ...parsingSource,
      version: parsingSource.version + 1,
      updatedAt: readyAt,
      status: 'ready',
      parseProgress: 100,
      pageCount,
      error: null,
    };
    const readyProject = await this.saveSourceState(
      withChunks,
      readySource,
      readyAt,
    );
    return {
      status: 'ready',
      project: readyProject,
      sourceFile: findProjectSource(readyProject, sourceId),
      chunks: readyProject.sourceChunks.filter(
        (chunk) => chunk.sourceFileId === sourceId,
      ),
    };
  }

  private async requireProject(projectId: string): Promise<Project> {
    const project = await this.store.getProject(projectId);
    if (project === null) {
      throw new ProjectNotFoundError(projectId);
    }
    return project;
  }

  private requireDraftOutline(
    project: Project,
    outlineId: string,
  ): EvidenceBoundOutline {
    const outline = this.findOutline(project, outlineId);
    if (outline.status !== 'selected' && outline.status !== 'locked') {
      throw new WorkbenchServiceInputError('OUTLINE_NOT_SELECTED');
    }
    return outline;
  }

  private requireEditableDraftArtifact(
    project: Project,
    artifactId: string,
  ): Readonly<{
    artifact: Artifact;
    outline: EvidenceBoundOutline;
    payload: DraftArtifactPayload;
  }> {
    const artifact = project.artifacts.find(
      (candidate) => candidate.id === artifactId,
    );
    if (artifact === undefined || !isDraftPayloadCandidate(artifact.payload)) {
      throw new WorkbenchServiceInputError(
        'DRAFT_ARTIFACT_NOT_FOUND',
      );
    }
    if (artifact.status !== 'draft') {
      throw new WorkbenchServiceInputError(
        'DRAFT_ARTIFACT_NOT_EDITABLE',
      );
    }
    const outline = this.requireDraftOutline(
      project,
      artifact.outlineId,
    );
    return {
      artifact,
      outline,
      payload: readDraftArtifactPayload(artifact),
    };
  }

  private assertDraftPageReferences(
    records: readonly VersionedDraftPage[],
    project: Project,
    outline: EvidenceBoundOutline,
  ): void {
    const outlineNodeIds = new Set(
      outline.nodes.map((node) => node.id),
    );
    const evidenceIds = new Set(
      project.evidenceCards.map((evidence) => evidence.id),
    );
    const rubricIds = new Set(
      project.taskDefinition.rubric.map((criterion) => criterion.id),
    );
    for (const record of records) {
      if (!outlineNodeIds.has(record.outlineNodeId)) {
        throw new WorkbenchServiceInputError(
          'OUTLINE_NODE_NOT_FOUND',
        );
      }
      if (
        record.page.evidenceCardIds.some(
          (evidenceId) => !evidenceIds.has(evidenceId),
        )
      ) {
        throw new WorkbenchServiceInputError(
          'DRAFT_EVIDENCE_NOT_FOUND',
        );
      }
      if (
        record.page.rubricCriterionIds.some(
          (rubricId) => !rubricIds.has(rubricId),
        )
      ) {
        throw new WorkbenchServiceInputError(
          'DRAFT_RUBRIC_NOT_FOUND',
        );
      }
    }
  }

  private async saveDraftPages(
    current: Project,
    artifact: Artifact,
    payload: DraftArtifactPayload,
    pages: readonly VersionedDraftPage[],
    updatedAt: string,
  ): Promise<Project> {
    const version = artifact.version + 1;
    const nextPayload = parseDraftArtifactPayload({
      ...payload,
      version,
      updatedAt,
      pages,
    });
    const nextArtifact: Artifact = {
      ...artifact,
      version,
      updatedAt,
      payload: draftPayloadJson(nextPayload),
    };
    const verificationResults = current.verificationResults.map(
      (result): VerificationResult =>
        result.artifactId === artifact.id
          ? {
              ...result,
              version: result.version + 1,
              updatedAt,
              artifactVersion: version,
              status: 'stale',
            }
          : result,
    );
    const next = parseProject({
      ...current,
      version: current.version + 1,
      updatedAt,
      artifacts: current.artifacts.map((candidate) =>
        candidate.id === artifact.id ? nextArtifact : candidate,
      ),
      verificationResults,
    });
    return this.store.saveProject(next, current.version);
  }

  private findOutline(
    project: Project,
    outlineId: string,
  ): EvidenceBoundOutline {
    const outline = project.outlines.find(
      (candidate) => candidate.id === outlineId,
    );
    if (outline === undefined) {
      throw new WorkbenchServiceInputError('OUTLINE_NOT_FOUND');
    }
    return outline;
  }

  private assertOutlineForPersistence(
    outline: EvidenceBoundOutline,
    project: Project,
  ): void {
    this.assertOutlineReferences(outline, project);
    if (outline.status === 'selected' || outline.status === 'locked') {
      assertValidOutline(
        outline,
        this.outlineValidationContext(project),
      );
    }
  }

  private assertOutlineReferences(
    outline: EvidenceBoundOutline,
    project: Project,
  ): void {
    if (outline.nodes.length === 0) {
      if (outline.status === 'draft') {
        return;
      }
      throw new OutlineOperationError('INVALID_OUTLINE_STATE', 'nodes');
    }
    const evidenceById = new Map(
      project.evidenceCards.map((evidence) => [evidence.id, evidence]),
    );
    const allowedRequirements = new Set(
      project.taskDefinition.mustInclude,
    );
    const allowedRubricIds = new Set(
      project.taskDefinition.rubric.map((criterion) => criterion.id),
    );
    for (const [index, node] of outline.nodes.entries()) {
      if (node.evidenceCardIds.length === 0) {
        throw new OutlineOperationError(
          'EVIDENCE_REQUIRED',
          `nodes[${String(index)}].evidenceCardIds`,
        );
      }
      for (const evidenceId of node.evidenceCardIds) {
        const evidence = evidenceById.get(evidenceId);
        if (
          evidence === undefined ||
          evidence.projectId !== outline.projectId
        ) {
          throw new OutlineOperationError(
            'UNKNOWN_EVIDENCE',
            `nodes[${String(index)}].evidenceCardIds`,
          );
        }
        if (
          evidence.status !== 'verified' ||
          evidence.confirmationStatus !== 'confirmed' ||
          evidence.userConfirmedAt === null ||
          evidence.userConfirmedAt === undefined
        ) {
          throw new OutlineOperationError(
            'UNCONFIRMED_EVIDENCE',
            `nodes[${String(index)}].evidenceCardIds`,
          );
        }
      }
      for (const requirement of node.coveredRequirements) {
        if (!allowedRequirements.has(requirement)) {
          throw new OutlineOperationError(
            'UNKNOWN_DELIVERY_REQUIREMENT',
            `nodes[${String(index)}].coveredRequirements`,
          );
        }
      }
      for (const rubricId of node.rubricCriterionIds) {
        if (!allowedRubricIds.has(rubricId)) {
          throw new OutlineOperationError(
            'UNKNOWN_RUBRIC_CRITERION',
            `nodes[${String(index)}].rubricCriterionIds`,
          );
        }
      }
    }
  }

  private outlineValidationContext(
    project: Project,
  ): OutlineValidationContext {
    return {
      taskDefinition: project.taskDefinition,
      evidenceCards: project.evidenceCards.map((evidence) => ({
        ...evidence,
        stance:
          evidence.stance === 'support' ||
          evidence.stance === 'supports'
            ? 'supports'
            : evidence.stance === 'oppose' ||
                evidence.stance === 'opposes'
              ? 'opposes'
              : 'neutral',
        confirmationStatus: evidence.confirmationStatus ?? 'pending',
        confirmedAt: evidence.userConfirmedAt ?? null,
      })),
    };
  }

  private async saveOutline(
    current: Project,
    outline: EvidenceBoundOutline,
    updatedAt: string,
    activeOutlineId: string | null = current.activeOutlineId,
  ): Promise<Project> {
    const existing = current.outlines.some(
      (candidate) => candidate.id === outline.id,
    );
    const outlines: Outline[] = existing
      ? current.outlines.map((candidate) =>
          candidate.id === outline.id ? outline : candidate,
        )
      : [...current.outlines, outline];
    const next = parseProject({
      ...current,
      version: current.version + 1,
      updatedAt,
      outlines,
      activeOutlineId,
    });
    return this.store.saveProject(next, current.version);
  }

  private async persistParseFailure(
    project: Project,
    source: ProjectSourceFile,
    code: SourceIngestionFailureCode,
  ): Promise<SourceIngestionResult> {
    const failedAt = this.timestampAfter(project.updatedAt);
    const failedSource: ProjectSourceFile = {
      ...source,
      version: source.version + 1,
      updatedAt: failedAt,
      status: 'failed',
      parseProgress: 0,
      pageCount: null,
      error: {
        code,
        message: `Source parsing failed: ${code}`,
        retryable: true,
      },
    };
    const failedProject = await this.saveSourceState(
      project,
      failedSource,
      failedAt,
    );
    return {
      status: 'failed',
      project: failedProject,
      sourceFile: findProjectSource(failedProject, source.id),
      errorCode: code,
    };
  }

  private async saveSourceState(
    current: Project,
    source: ProjectSourceFile,
    updatedAt: string,
  ): Promise<Project> {
    const sourceFiles = current.sourceFiles.filter(
      (candidate) => candidate.id !== source.id,
    );
    const next = parseProject({
      ...current,
      version: current.version + 1,
      updatedAt,
      sourceFiles: [...sourceFiles, source],
    });
    return this.store.saveProject(next, current.version);
  }

  private async createProjectChunks(
    projectId: string,
    source: ProjectSourceFile,
    pages: readonly Readonly<{
      ordinal: number;
      pageNumber: number;
      text: string;
    }>[],
    timestamp: string,
  ): Promise<SourceChunk[]> {
    let characterOffset = 0;
    const chunks: SourceChunk[] = [];
    for (const page of pages) {
      if (page.text.length === 0) {
        throw new WorkbenchServiceInputError('INVALID_PARSER_OUTPUT');
      }
      const characterStart = characterOffset;
      const characterEnd = characterStart + page.text.length;
      chunks.push({
        id: this.idFactory(),
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        projectId,
        sourceFileId: source.id,
        sourceFileVersion: source.sourceVersion,
        ordinal: page.ordinal,
        pageNumber: page.pageNumber,
        pageLabel: String(page.pageNumber),
        characterStart,
        characterEnd,
        text: page.text,
        contentSha256: await this.hashText(page.text),
      });
      characterOffset = characterEnd + 1;
    }
    return chunks;
  }

  private createTraceableProjectChunks(
    projectId: string,
    source: ProjectSourceFile,
    inputs: readonly TraceableTextChunk[],
    timestamp: string,
  ): SourceChunk[] {
    return inputs.map((chunk) => ({
      id: this.idFactory(),
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      projectId,
      sourceFileId: source.id,
      sourceFileVersion: source.sourceVersion,
      ordinal: chunk.ordinal,
      pageNumber: chunk.pageNumber,
      pageLabel: chunk.pageLabel,
      characterStart: chunk.characterStart,
      characterEnd: chunk.characterEnd,
      text: chunk.text,
      contentSha256: chunk.contentSha256,
    }));
  }

  private async hashText(value: string): Promise<string> {
    if (this.cryptoProvider?.subtle === undefined) {
      throw new WorkbenchServiceInputError('WEB_CRYPTO_UNAVAILABLE');
    }
    const digest = await this.cryptoProvider.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value),
    );
    return hexadecimal(new Uint8Array(digest));
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
      throw new WorkbenchServiceInputError('INVALID_CLOCK');
    }
    return value.toISOString();
  }

  private timestampAfter(previous: string): string {
    const candidate = Date.parse(this.timestamp());
    const minimum = Date.parse(previous) + 1;
    return new Date(Math.max(candidate, minimum)).toISOString();
  }
}

const DRAFT_UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function parseDraftPayloadAt(
  input: unknown,
  path: string,
): DraftArtifactPayload {
  const object = draftObjectAt(input, path);
  assertDraftKeys(
    object,
    [
      'format',
      'formatVersion',
      'id',
      'version',
      'createdAt',
      'updatedAt',
      'pages',
    ],
    path,
  );
  if (object.format !== DRAFT_ARTIFACT_FORMAT) {
    failDraftPayload(
      `${path}.format`,
      `must equal ${DRAFT_ARTIFACT_FORMAT}`,
    );
  }
  if (object.formatVersion !== DRAFT_ARTIFACT_FORMAT_VERSION) {
    failDraftPayload(
      `${path}.formatVersion`,
      `must equal ${String(DRAFT_ARTIFACT_FORMAT_VERSION)}`,
    );
  }
  const createdAt = draftDateTimeAt(object.createdAt, `${path}.createdAt`);
  const updatedAt = draftDateTimeAt(object.updatedAt, `${path}.updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    failDraftPayload(
      `${path}.updatedAt`,
      'must not be before createdAt',
    );
  }
  const pages = draftArrayAt(object.pages, `${path}.pages`).map(
    (candidate, index) =>
      parseVersionedDraftPage(
        candidate,
        `${path}.pages[${String(index)}]`,
      ),
  );
  if (new Set(pages.map((page) => page.id)).size !== pages.length) {
    failDraftPayload(`${path}.pages`, 'must contain unique page ids');
  }
  if (
    pages.some(
      (page) =>
        Date.parse(page.createdAt) < Date.parse(createdAt) ||
        Date.parse(page.updatedAt) > Date.parse(updatedAt),
    )
  ) {
    failDraftPayload(
      `${path}.pages`,
      'page timestamps must remain within payload timestamps',
    );
  }
  return Object.freeze({
    format: DRAFT_ARTIFACT_FORMAT,
    formatVersion: DRAFT_ARTIFACT_FORMAT_VERSION,
    id: draftIdAt(object.id, `${path}.id`),
    version: draftPositiveIntegerAt(object.version, `${path}.version`),
    createdAt,
    updatedAt,
    pages: Object.freeze(pages),
  });
}

function parseVersionedDraftPage(
  input: unknown,
  path: string,
): VersionedDraftPage {
  const object = draftObjectAt(input, path);
  assertDraftKeys(
    object,
    [
      'id',
      'version',
      'createdAt',
      'updatedAt',
      'outlineNodeId',
      'page',
    ],
    path,
  );
  const id = draftIdAt(object.id, `${path}.id`);
  const createdAt = draftDateTimeAt(object.createdAt, `${path}.createdAt`);
  const updatedAt = draftDateTimeAt(object.updatedAt, `${path}.updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    failDraftPayload(
      `${path}.updatedAt`,
      'must not be before createdAt',
    );
  }
  const page = parsePersistedDraftPage(object.page, `${path}.page`);
  if (page.id !== id) {
    failDraftPayload(`${path}.page.id`, 'must match the page record id');
  }
  return Object.freeze({
    id,
    version: draftPositiveIntegerAt(object.version, `${path}.version`),
    createdAt,
    updatedAt,
    outlineNodeId: draftIdAt(
      object.outlineNodeId,
      `${path}.outlineNodeId`,
    ),
    page,
  });
}

function parsePersistedDraftPage(
  input: unknown,
  path: string,
): DraftPage {
  const object = draftObjectAt(input, path);
  assertDraftKeys(
    object,
    [
      'id',
      'title',
      'conclusion',
      'body',
      'evidenceCardIds',
      'citations',
      'visualNote',
      'speakerNotes',
      'estimatedSeconds',
      'locked',
      'rubricCriterionIds',
      'claims',
    ],
    path,
  );
  const citations = draftArrayAt(
    object.citations,
    `${path}.citations`,
  ).map((candidate, index) => {
    const citationPath = `${path}.citations[${String(index)}]`;
    const citation = draftObjectAt(candidate, citationPath);
    assertDraftKeys(
      citation,
      ['evidenceCardId', 'label'],
      citationPath,
    );
    return {
      evidenceCardId: draftIdAt(
        citation.evidenceCardId,
        `${citationPath}.evidenceCardId`,
      ),
      label: draftStringAt(citation.label, `${citationPath}.label`),
    };
  });
  const claims = draftArrayAt(object.claims, `${path}.claims`).map(
    (candidate, index) => {
      const claimPath = `${path}.claims[${String(index)}]`;
      const claim = draftObjectAt(candidate, claimPath);
      assertDraftKeys(
        claim,
        ['id', 'text', 'evidenceCardIds', 'numericFacts'],
        claimPath,
      );
      const numericFacts = draftArrayAt(
        claim.numericFacts,
        `${claimPath}.numericFacts`,
      ).map((factCandidate, factIndex) => {
        const factPath =
          `${claimPath}.numericFacts[${String(factIndex)}]`;
        const fact = draftObjectAt(factCandidate, factPath);
        assertDraftKeys(fact, ['metric', 'value', 'unit'], factPath);
        if (
          typeof fact.value !== 'number' ||
          !Number.isFinite(fact.value)
        ) {
          failDraftPayload(`${factPath}.value`, 'must be finite');
        }
        return {
          metric: draftStringAt(fact.metric, `${factPath}.metric`),
          value: fact.value,
          unit: draftStringAt(fact.unit, `${factPath}.unit`),
        };
      });
      return {
        id: draftStringAt(claim.id, `${claimPath}.id`),
        text: draftStringAt(claim.text, `${claimPath}.text`),
        evidenceCardIds: draftIdArrayAt(
          claim.evidenceCardIds,
          `${claimPath}.evidenceCardIds`,
        ),
        numericFacts,
      };
    },
  );
  if (typeof object.estimatedSeconds !== 'number') {
    failDraftPayload(
      `${path}.estimatedSeconds`,
      'must be a number',
    );
  }
  if (typeof object.locked !== 'boolean') {
    failDraftPayload(`${path}.locked`, 'must be a boolean');
  }
  try {
    return createDraftPage({
      id: draftIdAt(object.id, `${path}.id`),
      title: draftStringAt(object.title, `${path}.title`),
      conclusion: draftStringAt(
        object.conclusion,
        `${path}.conclusion`,
      ),
      body: draftStringAt(object.body, `${path}.body`),
      evidenceCardIds: draftIdArrayAt(
        object.evidenceCardIds,
        `${path}.evidenceCardIds`,
      ),
      citations,
      visualNote: draftStringAt(
        object.visualNote,
        `${path}.visualNote`,
      ),
      speakerNotes: draftStringAt(
        object.speakerNotes,
        `${path}.speakerNotes`,
      ),
      estimatedSeconds: object.estimatedSeconds,
      locked: object.locked,
      rubricCriterionIds: draftIdArrayAt(
        object.rubricCriterionIds,
        `${path}.rubricCriterionIds`,
      ),
      claims,
    });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
    ) {
      failDraftPayload(path, error.code);
    }
    throw error;
  }
}

function draftObjectAt(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    failDraftPayload(path, 'must be a plain object');
  }
  return value as Record<string, unknown>;
}

function draftArrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    failDraftPayload(path, 'must be an array');
  }
  return value;
}

function draftStringAt(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    failDraftPayload(path, 'must be a string');
  }
  return value;
}

function draftIdAt(value: unknown, path: string): string {
  const id = draftStringAt(value, path);
  if (!DRAFT_UUID_V7.test(id) || id !== id.toLowerCase()) {
    failDraftPayload(path, 'must be a canonical lowercase UUIDv7');
  }
  return id;
}

function draftIdArrayAt(value: unknown, path: string): string[] {
  const ids = draftArrayAt(value, path).map((candidate, index) =>
    draftIdAt(candidate, `${path}[${String(index)}]`),
  );
  if (new Set(ids).size !== ids.length) {
    failDraftPayload(path, 'must contain unique ids');
  }
  return ids;
}

function draftPositiveIntegerAt(value: unknown, path: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    failDraftPayload(path, 'must be a positive safe integer');
  }
  return value;
}

function draftDateTimeAt(value: unknown, path: string): string {
  const dateTime = draftStringAt(value, path);
  const parsed = new Date(dateTime);
  if (
    !Number.isFinite(parsed.valueOf()) ||
    parsed.toISOString() !== dateTime
  ) {
    failDraftPayload(path, 'must be a canonical ISO-8601 timestamp');
  }
  return dateTime;
}

function assertDraftKeys(
  object: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(object).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    failDraftPayload(
      path,
      `must contain exactly: ${sortedExpected.join(', ')}`,
    );
  }
}

function failDraftPayload(path: string, message: string): never {
  throw new DraftArtifactPayloadError(path, message);
}

function isDraftPayloadCandidate(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'format' in value &&
    value.format === DRAFT_ARTIFACT_FORMAT
  );
}

function draftPayloadJson(
  payload: DraftArtifactPayload,
): Artifact['payload'] {
  return payload as unknown as Artifact['payload'];
}

function draftArtifactKind(project: Project): ArtifactKind {
  const formats = project.taskDefinition.outputFormats;
  if (formats.includes('pptx')) {
    return 'presentation';
  }
  if (formats.includes('docx') || formats.includes('pdf')) {
    return 'document';
  }
  if (formats.includes('markdown')) {
    return 'markdown';
  }
  if (formats.includes('script')) {
    return 'script';
  }
  if (formats.includes('source-index')) {
    return 'source_index';
  }
  if (formats.includes('task-card')) {
    return 'task_definition';
  }
  if (formats.includes('verification-record')) {
    return 'verification_record';
  }
  return 'project_package';
}

function verificationCheckKey(
  check: Pick<
    VerificationCheck,
    'rule' | 'artifactPath' | 'evidenceCardIds'
  >,
): string {
  return [
    check.rule,
    check.artifactPath,
    ...check.evidenceCardIds,
  ].join('\u0000');
}

function verificationSummary(
  checks: readonly VerificationCheck[],
): VerificationSummary {
  return {
    passed: checks.filter((check) => check.outcome === 'pass').length,
    warnings: checks.filter((check) => check.outcome === 'warning').length,
    failed: checks.filter((check) => check.outcome === 'fail').length,
    notRun: checks.filter((check) => check.outcome === 'not_run').length,
  };
}

function verificationStatus(
  summary: VerificationSummary,
): VerificationStatus {
  if (summary.failed > 0) {
    return 'failed';
  }
  return summary.notRun > 0 ? 'stale' : 'passed';
}

function normalizedProjectTitle(input: WorkbenchProjectFormInput): string {
  return input.projectTitle === undefined ||
    input.projectTitle.trim().length === 0
    ? input.taskName
    : input.projectTitle;
}

function parseDeadline(value: string): string {
  const deadline = new Date(value);
  if (!Number.isFinite(deadline.valueOf())) {
    throw new WorkbenchServiceInputError('INVALID_DEADLINE');
  }
  return deadline.toISOString();
}

function parseLengthTarget(
  value: string,
): { unit: 'pages' | 'words'; value: number } {
  const match =
    /^\s*([1-9]\d*)\s*(页|頁|pages?|words?|字|字数)\s*$/iu.exec(value);
  if (match === null) {
    throw new WorkbenchServiceInputError('INVALID_LENGTH_TARGET');
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new WorkbenchServiceInputError('INVALID_LENGTH_TARGET');
  }
  const rawUnit = match[2]?.toLocaleLowerCase();
  return {
    unit:
      rawUnit === '页' ||
      rawUnit === '頁' ||
      rawUnit === 'page' ||
      rawUnit === 'pages'
        ? 'pages'
        : 'words',
    value: amount,
  };
}

function parseDuration(value: string): number | null {
  if (value.trim().length === 0) {
    return null;
  }
  if (!/^[1-9]\d*$/u.test(value.trim())) {
    throw new WorkbenchServiceInputError('INVALID_DURATION');
  }
  const duration = Number(value);
  if (!Number.isSafeInteger(duration) || duration > 24 * 60) {
    throw new WorkbenchServiceInputError('INVALID_DURATION');
  }
  return duration;
}

function parseOutputFormats(
  input: WorkbenchOutputFormatInput,
): OutputFormat[] {
  if (input === 'presentation') {
    return ['pptx', 'pdf'];
  }
  if (input === 'report') {
    return ['pdf'];
  }
  if (input === 'document') {
    return ['docx'];
  }
  const formats: readonly OutputFormat[] = [
    'pptx',
    'pdf',
    'docx',
    'markdown',
    'script',
    'source-index',
    'task-card',
    'verification-record',
    'project-package',
  ];
  if (!formats.includes(input as OutputFormat)) {
    throw new WorkbenchServiceInputError('UNSUPPORTED_OUTPUT_FORMAT');
  }
  return [input as OutputFormat];
}

function parseRubric(
  inputs: readonly WorkbenchRubricFormInput[],
  timestamp: string,
  idFactory: () => string,
): RubricCriterion[] {
  if (inputs.length === 0) {
    throw new WorkbenchServiceInputError('INVALID_RUBRIC_WEIGHT');
  }
  const rubric = inputs.map((input) => {
    const rawWeight =
      typeof input.weightPercent === 'number'
        ? String(input.weightPercent)
        : input.weightPercent.trim();
    if (!/^[1-9]\d*$/u.test(rawWeight)) {
      throw new WorkbenchServiceInputError('INVALID_RUBRIC_WEIGHT');
    }
    const weightPercent = Number(rawWeight);
    if (
      !Number.isSafeInteger(weightPercent) ||
      weightPercent < 1 ||
      weightPercent > 100
    ) {
      throw new WorkbenchServiceInputError('INVALID_RUBRIC_WEIGHT');
    }
    return {
      id: idFactory(),
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      title: input.title,
      description: input.description,
      weightPercent,
    };
  });
  if (
    rubric.reduce((total, criterion) => total + criterion.weightPercent, 0) !==
    100
  ) {
    throw new WorkbenchServiceInputError('INVALID_RUBRIC_WEIGHT');
  }
  return rubric;
}

function parseLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function createProjectSourceFile(input: {
  id: string;
  projectId: string;
  upload: ValidatedSourceUpload;
  sha256: string;
  timestamp: string;
}): ProjectSourceFile {
  return {
    id: input.id,
    version: 1,
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
    projectId: input.projectId,
    fileName: input.upload.name,
    mediaType: input.upload.mimeType,
    extension: input.upload.extension.slice(1),
    sizeBytes: input.upload.sizeBytes,
    contentSha256: input.sha256,
    blobId: `source-file:${input.id}`,
    sourceVersion: 1,
    status: 'pending',
    parseProgress: 0,
    pageCount: null,
    error: null,
    replacedByFileId: null,
  };
}

function findProjectSource(
  project: Project,
  sourceId: string,
): ProjectSourceFile {
  const source = project.sourceFiles.find(
    (candidate) => candidate.id === sourceId,
  );
  if (source === undefined) {
    throw new Error('persisted source file invariant failed');
  }
  return source;
}

function createUuidV7(
  cryptoProvider: Crypto | undefined,
  timestamp: number,
): string {
  if (
    cryptoProvider === undefined ||
    typeof cryptoProvider.getRandomValues !== 'function'
  ) {
    throw new WorkbenchServiceInputError('WEB_CRYPTO_UNAVAILABLE');
  }
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new WorkbenchServiceInputError('INVALID_CLOCK');
  }
  const bytes = cryptoProvider.getRandomValues(new Uint8Array(16));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = hexadecimal(bytes);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function hexadecimal(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export const PROJECT_SCHEMA_VERSION = 1 as const;

export type ProjectSchemaVersion = typeof PROJECT_SCHEMA_VERSION;
export type EntityId = string;
export type IsoDateTime = string;
export type Sha256 = string;

export interface VersionedEntity {
  id: EntityId;
  version: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface LengthTarget {
  unit: 'pages' | 'words';
  value: number;
}

export interface RubricCriterion extends VersionedEntity {
  title: string;
  description: string;
  weightPercent: number;
}

export type OutputFormat =
  | 'pptx'
  | 'pdf'
  | 'docx'
  | 'markdown'
  | 'script'
  | 'source-index'
  | 'task-card'
  | 'verification-record'
  | 'project-package';

export interface TaskDefinition extends VersionedEntity {
  taskName: string;
  audience: string;
  dueAt: IsoDateTime;
  lengthTarget: LengthTarget;
  presentationDurationMinutes: number | null;
  outputFormats: OutputFormat[];
  rubric: RubricCriterion[];
  tone: string;
  mustInclude: string[];
  mustAvoid: string[];
}

export interface SourceFileFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export type SourceFileStatus =
  | 'pending'
  | 'uploading'
  | 'queued'
  | 'parsing'
  | 'ready'
  | 'failed'
  | 'replaced';

export interface SourceFile extends VersionedEntity {
  projectId: EntityId;
  fileName: string;
  mediaType: string;
  extension: string;
  sizeBytes: number;
  contentSha256: Sha256;
  blobId: string;
  sourceVersion: number;
  status: SourceFileStatus;
  parseProgress: number;
  pageCount: number | null;
  error: SourceFileFailure | null;
  replacedByFileId: EntityId | null;
}

export interface SourceChunk extends VersionedEntity {
  projectId: EntityId;
  sourceFileId: EntityId;
  sourceFileVersion: number;
  ordinal: number;
  pageNumber: number;
  pageLabel: string;
  characterStart: number;
  characterEnd: number;
  text: string;
  contentSha256: Sha256;
}

export type EvidenceKind =
  | 'fact'
  | 'opinion'
  | 'statistic'
  | 'case'
  | 'unverified';
export type EvidenceStatus = 'candidate' | 'selected' | 'verified' | 'rejected';

export interface EvidenceCard extends VersionedEntity {
  projectId: EntityId;
  sourceFileId: EntityId;
  sourceChunkId: EntityId;
  sourceFileVersion: number;
  pageNumber: number;
  characterStart: number;
  characterEnd: number;
  quote: string;
  kind: EvidenceKind;
  note: string;
  citation: string;
  status: EvidenceStatus;
}

export interface OutlineNode extends VersionedEntity {
  position: number;
  title: string;
  conclusion: string;
  evidenceCardIds: EntityId[];
  locked: boolean;
}

export type OutlineStatus = 'draft' | 'selected' | 'locked' | 'archived';

export interface Outline extends VersionedEntity {
  projectId: EntityId;
  title: string;
  status: OutlineStatus;
  lockedAt: IsoDateTime | null;
  nodes: OutlineNode[];
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ArtifactKind =
  | 'presentation'
  | 'document'
  | 'markdown'
  | 'script'
  | 'source_index'
  | 'task_definition'
  | 'verification_record'
  | 'project_package';
export type ArtifactStatus = 'draft' | 'ready' | 'stale' | 'exported' | 'failed';

export interface Artifact extends VersionedEntity {
  projectId: EntityId;
  outlineId: EntityId;
  outlineVersion: number;
  kind: ArtifactKind;
  status: ArtifactStatus;
  payload: JsonValue;
  blobId: string | null;
  contentSha256: Sha256 | null;
  staleBecause: string[];
  errorCode: string | null;
}

export type VerificationRule =
  | 'citation_exists'
  | 'source_traceable'
  | 'required_content'
  | 'forbidden_content'
  | 'length_target'
  | 'presentation_duration'
  | 'rubric_coverage';
export type VerificationOutcome = 'pass' | 'warning' | 'fail' | 'not_run';
export type VerificationStatus = 'pending' | 'passed' | 'failed' | 'stale';

export interface VerificationCheck extends VersionedEntity {
  rule: VerificationRule;
  outcome: VerificationOutcome;
  message: string;
  artifactPath: string;
  evidenceCardIds: EntityId[];
}

export interface VerificationSummary {
  passed: number;
  warnings: number;
  failed: number;
  notRun: number;
}

export interface VerificationResult extends VersionedEntity {
  projectId: EntityId;
  artifactId: EntityId;
  artifactVersion: number;
  status: VerificationStatus;
  checkedAt: IsoDateTime;
  checks: VerificationCheck[];
  summary: VerificationSummary;
}

export type ProjectStatus = 'active' | 'archived';

export interface Project extends VersionedEntity {
  schemaVersion: ProjectSchemaVersion;
  title: string;
  status: ProjectStatus;
  taskDefinition: TaskDefinition;
  sourceFiles: SourceFile[];
  sourceChunks: SourceChunk[];
  evidenceCards: EvidenceCard[];
  outlines: Outline[];
  activeOutlineId: EntityId | null;
  artifacts: Artifact[];
  verificationResults: VerificationResult[];
}

export class ProjectModelError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ProjectModelError';
    this.path = path;
  }
}

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_HEX = /^[0-9a-f]{64}$/iu;
const SAFE_EXTENSION = /^[a-z0-9][a-z0-9.+_-]{0,31}$/u;
const SAFE_MEDIA_TYPE =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;

function fail(path: string, message: string): never {
  throw new ProjectModelError(path, message);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(path, 'must be an array');
  }
  return value;
}

function stringAt(
  value: unknown,
  path: string,
  options: { allowEmpty?: boolean; max?: number } = {},
): string {
  if (typeof value !== 'string') {
    fail(path, 'must be a string');
  }
  if (value !== value.trim()) {
    fail(path, 'must not contain surrounding whitespace');
  }
  if (!options.allowEmpty && value.length === 0) {
    fail(path, 'must not be empty');
  }
  if (value.length > (options.max ?? 20_000)) {
    fail(path, 'is too long');
  }
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    fail(path, 'must be a boolean');
  }
  return value;
}

function finiteNumberAt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, 'must be a finite number');
  }
  return value;
}

function integerAt(
  value: unknown,
  path: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const number = finiteNumberAt(value, path);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    fail(path, `must be an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

function enumAt<T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
): T {
  const string = stringAt(value, path);
  if (!values.includes(string as T)) {
    fail(path, `must be one of ${values.join(', ')}`);
  }
  return string as T;
}

function idAt(value: unknown, path: string): EntityId {
  const id = stringAt(value, path);
  if (!UUID_V7.test(id) || id !== id.toLowerCase()) {
    fail(path, 'must be a canonical lowercase UUIDv7');
  }
  return id;
}

function dateTimeAt(value: unknown, path: string): IsoDateTime {
  const dateTime = stringAt(value, path);
  const date = new Date(dateTime);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== dateTime) {
    fail(path, 'must be a canonical ISO-8601 UTC timestamp');
  }
  return dateTime;
}

function sha256At(value: unknown, path: string): Sha256 {
  const hash = stringAt(value, path);
  if (!SHA256_HEX.test(hash)) {
    fail(path, 'must be a 64-character hexadecimal SHA-256 digest');
  }
  return hash.toLowerCase();
}

function nullableAt<T>(
  value: unknown,
  parser: (candidate: unknown, path: string) => T,
  path: string,
): T | null {
  return value === null ? null : parser(value, path);
}

function stringListAt(
  value: unknown,
  path: string,
  options: { allowEmpty?: boolean; itemMax?: number } = {},
): string[] {
  const values = arrayAt(value, path).map((item, index) =>
    stringAt(item, `${path}[${index}]`, { max: options.itemMax ?? 2_000 }),
  );
  if (!options.allowEmpty && values.length === 0) {
    fail(path, 'must contain at least one item');
  }
  const normalized = values.map((item) => item.toLocaleLowerCase());
  if (new Set(normalized).size !== values.length) {
    fail(path, 'must not contain duplicates');
  }
  return values;
}

function idListAt(
  value: unknown,
  path: string,
  options: { allowEmpty?: boolean } = {},
): EntityId[] {
  const ids = arrayAt(value, path).map((item, index) =>
    idAt(item, `${path}[${index}]`),
  );
  if (!options.allowEmpty && ids.length === 0) {
    fail(path, 'must contain at least one identity');
  }
  if (new Set(ids).size !== ids.length) {
    fail(path, 'must not contain duplicate identities');
  }
  return ids;
}

function versionedAt(
  object: Record<string, unknown>,
  path: string,
): VersionedEntity {
  const createdAt = dateTimeAt(object.createdAt, `${path}.createdAt`);
  const updatedAt = dateTimeAt(object.updatedAt, `${path}.updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    fail(`${path}.updatedAt`, 'must be at or after createdAt');
  }
  return {
    id: idAt(object.id, `${path}.id`),
    version: integerAt(object.version, `${path}.version`, 1),
    createdAt,
    updatedAt,
  };
}

function assertUniqueIdentities(
  values: readonly VersionedEntity[],
  path: string,
): void {
  if (new Set(values.map((value) => value.id)).size !== values.length) {
    fail(path, 'must not contain duplicate identities');
  }
}

function parseRubricCriterion(
  input: unknown,
  path: string,
): RubricCriterion {
  const object = objectAt(input, path);
  return {
    ...versionedAt(object, path),
    title: stringAt(object.title, `${path}.title`, { max: 500 }),
    description: stringAt(object.description, `${path}.description`, {
      max: 5_000,
    }),
    weightPercent: integerAt(
      object.weightPercent,
      `${path}.weightPercent`,
      1,
      100,
    ),
  };
}

export function parseTaskDefinition(input: unknown): TaskDefinition {
  const path = 'taskDefinition';
  const object = objectAt(input, path);
  const target = objectAt(object.lengthTarget, `${path}.lengthTarget`);
  const outputFormats = arrayAt(
    object.outputFormats,
    `${path}.outputFormats`,
  ).map((item, index) =>
    enumAt(
      item,
      `${path}.outputFormats[${index}]`,
      [
        'pptx',
        'pdf',
        'docx',
        'markdown',
        'script',
        'source-index',
        'task-card',
        'verification-record',
        'project-package',
      ] as const,
    ),
  );
  if (outputFormats.length === 0) {
    fail(`${path}.outputFormats`, 'must contain at least one output format');
  }
  if (new Set(outputFormats).size !== outputFormats.length) {
    fail(`${path}.outputFormats`, 'must not contain duplicates');
  }

  const rubric = arrayAt(object.rubric, `${path}.rubric`).map((item, index) =>
    parseRubricCriterion(item, `${path}.rubric[${index}]`),
  );
  if (rubric.length === 0) {
    fail(`${path}.rubric`, 'must contain at least one criterion');
  }
  assertUniqueIdentities(rubric, `${path}.rubric`);
  if (
    rubric.reduce((total, criterion) => total + criterion.weightPercent, 0) !==
    100
  ) {
    fail(`${path}.rubric`, 'weightPercent values must total 100');
  }

  const mustInclude = stringListAt(
    object.mustInclude,
    `${path}.mustInclude`,
    { allowEmpty: true },
  );
  const mustAvoid = stringListAt(object.mustAvoid, `${path}.mustAvoid`, {
    allowEmpty: true,
  });
  const forbidden = new Set(
    mustAvoid.map((item) => item.toLocaleLowerCase()),
  );
  if (
    mustInclude.some((item) =>
      forbidden.has(item.toLocaleLowerCase()),
    )
  ) {
    fail(
      `${path}.mustInclude`,
      'must not overlap with taskDefinition.mustAvoid',
    );
  }

  return {
    ...versionedAt(object, path),
    taskName: stringAt(object.taskName, `${path}.taskName`, { max: 500 }),
    audience: stringAt(object.audience, `${path}.audience`, { max: 2_000 }),
    dueAt: dateTimeAt(object.dueAt, `${path}.dueAt`),
    lengthTarget: {
      unit: enumAt(target.unit, `${path}.lengthTarget.unit`, [
        'pages',
        'words',
      ] as const),
      value: integerAt(
        target.value,
        `${path}.lengthTarget.value`,
        1,
        1_000_000,
      ),
    },
    presentationDurationMinutes: nullableAt(
      object.presentationDurationMinutes,
      (value, valuePath) =>
        integerAt(value, valuePath, 1, 24 * 60),
      `${path}.presentationDurationMinutes`,
    ),
    outputFormats,
    rubric,
    tone: stringAt(object.tone, `${path}.tone`, { max: 2_000 }),
    mustInclude,
    mustAvoid,
  };
}

function parseSourceFileFailure(
  input: unknown,
  path: string,
): SourceFileFailure {
  const object = objectAt(input, path);
  const code = stringAt(object.code, `${path}.code`, { max: 64 });
  if (!ERROR_CODE.test(code)) {
    fail(`${path}.code`, 'must be a stable uppercase error code');
  }
  return {
    code,
    message: stringAt(object.message, `${path}.message`, { max: 2_000 }),
    retryable: booleanAt(object.retryable, `${path}.retryable`),
  };
}

export function parseSourceFile(input: unknown): SourceFile {
  const path = 'sourceFile';
  const object = objectAt(input, path);
  const status = enumAt(object.status, `${path}.status`, [
    'pending',
    'uploading',
    'queued',
    'parsing',
    'ready',
    'failed',
    'replaced',
  ] as const);
  const progress = integerAt(
    object.parseProgress,
    `${path}.parseProgress`,
    0,
    100,
  );
  const error = nullableAt(
    object.error,
    parseSourceFileFailure,
    `${path}.error`,
  );
  const replacedByFileId = nullableAt(
    object.replacedByFileId,
    idAt,
    `${path}.replacedByFileId`,
  );

  if (status === 'ready' && progress !== 100) {
    fail(`${path}.parseProgress`, 'must equal 100 when status is ready');
  }
  if (status === 'failed' && error === null) {
    fail(`${path}.error`, 'is required when status is failed');
  }
  if (status !== 'failed' && error !== null) {
    fail(`${path}.error`, 'is only allowed when status is failed');
  }
  if (status === 'replaced' && replacedByFileId === null) {
    fail(
      `${path}.replacedByFileId`,
      'is required when status is replaced',
    );
  }
  if (status !== 'replaced' && replacedByFileId !== null) {
    fail(
      `${path}.replacedByFileId`,
      'is only allowed when status is replaced',
    );
  }
  if (
    (status === 'pending' || status === 'queued') &&
    progress !== 0
  ) {
    fail(`${path}.parseProgress`, `must equal 0 when status is ${status}`);
  }
  if (
    (status === 'uploading' || status === 'parsing') &&
    progress >= 100
  ) {
    fail(`${path}.parseProgress`, `must be below 100 when status is ${status}`);
  }

  const fileName = stringAt(object.fileName, `${path}.fileName`, {
    max: 512,
  });
  if (hasSlashOrControl(fileName)) {
    fail(`${path}.fileName`, 'must be a base file name without control bytes');
  }
  const extension = stringAt(object.extension, `${path}.extension`, {
    max: 32,
  });
  if (!SAFE_EXTENSION.test(extension)) {
    fail(`${path}.extension`, 'must be a safe lowercase file extension');
  }
  const mediaType = stringAt(object.mediaType, `${path}.mediaType`, {
    max: 200,
  });
  if (!SAFE_MEDIA_TYPE.test(mediaType)) {
    fail(`${path}.mediaType`, 'must be a valid media type');
  }
  const pageCount = nullableAt(
    object.pageCount,
    (value, valuePath) => integerAt(value, valuePath, 1, 1_000_000),
    `${path}.pageCount`,
  );
  if (status === 'ready' && mediaType === 'application/pdf' && pageCount === null) {
    fail(`${path}.pageCount`, 'is required for a ready PDF');
  }

  const result: SourceFile = {
    ...versionedAt(object, path),
    projectId: idAt(object.projectId, `${path}.projectId`),
    fileName,
    mediaType,
    extension,
    sizeBytes: integerAt(object.sizeBytes, `${path}.sizeBytes`, 1),
    contentSha256: sha256At(
      object.contentSha256,
      `${path}.contentSha256`,
    ),
    blobId: stringAt(object.blobId, `${path}.blobId`, { max: 1_000 }),
    sourceVersion: integerAt(
      object.sourceVersion,
      `${path}.sourceVersion`,
      1,
    ),
    status,
    parseProgress: progress,
    pageCount,
    error,
    replacedByFileId,
  };
  if (result.replacedByFileId === result.id) {
    fail(`${path}.replacedByFileId`, 'must not refer to the same source file');
  }
  return result;
}

function hasSlashOrControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      character === '/' ||
      character === '\\' ||
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    );
  });
}

export function parseSourceChunk(input: unknown): SourceChunk {
  const path = 'sourceChunk';
  const object = objectAt(input, path);
  const characterStart = integerAt(
    object.characterStart,
    `${path}.characterStart`,
    0,
  );
  const characterEnd = integerAt(
    object.characterEnd,
    `${path}.characterEnd`,
    1,
  );
  if (characterEnd <= characterStart) {
    fail(`${path}.characterEnd`, 'must be greater than characterStart');
  }
  return {
    ...versionedAt(object, path),
    projectId: idAt(object.projectId, `${path}.projectId`),
    sourceFileId: idAt(object.sourceFileId, `${path}.sourceFileId`),
    sourceFileVersion: integerAt(
      object.sourceFileVersion,
      `${path}.sourceFileVersion`,
      1,
    ),
    ordinal: integerAt(object.ordinal, `${path}.ordinal`, 0),
    pageNumber: integerAt(object.pageNumber, `${path}.pageNumber`, 1),
    pageLabel: stringAt(object.pageLabel, `${path}.pageLabel`, { max: 100 }),
    characterStart,
    characterEnd,
    text: stringAt(object.text, `${path}.text`, { max: 2_000_000 }),
    contentSha256: sha256At(
      object.contentSha256,
      `${path}.contentSha256`,
    ),
  };
}

export function parseEvidenceCard(input: unknown): EvidenceCard {
  const path = 'evidenceCard';
  const object = objectAt(input, path);
  const characterStart = integerAt(
    object.characterStart,
    `${path}.characterStart`,
    0,
  );
  const characterEnd = integerAt(
    object.characterEnd,
    `${path}.characterEnd`,
    1,
  );
  if (characterEnd <= characterStart) {
    fail(`${path}.characterEnd`, 'must be greater than characterStart');
  }
  const kind = enumAt(object.kind, `${path}.kind`, [
    'fact',
    'opinion',
    'statistic',
    'case',
    'unverified',
  ] as const);
  const status = enumAt(object.status, `${path}.status`, [
    'candidate',
    'selected',
    'verified',
    'rejected',
  ] as const);
  const citation = stringAt(object.citation, `${path}.citation`, {
    allowEmpty: status !== 'verified',
    max: 5_000,
  });
  if (status === 'verified' && kind === 'unverified') {
    fail(`${path}.status`, 'cannot be verified while kind is unverified');
  }
  return {
    ...versionedAt(object, path),
    projectId: idAt(object.projectId, `${path}.projectId`),
    sourceFileId: idAt(object.sourceFileId, `${path}.sourceFileId`),
    sourceChunkId: idAt(object.sourceChunkId, `${path}.sourceChunkId`),
    sourceFileVersion: integerAt(
      object.sourceFileVersion,
      `${path}.sourceFileVersion`,
      1,
    ),
    pageNumber: integerAt(object.pageNumber, `${path}.pageNumber`, 1),
    characterStart,
    characterEnd,
    quote: stringAt(object.quote, `${path}.quote`, { max: 100_000 }),
    kind,
    note: stringAt(object.note, `${path}.note`, {
      allowEmpty: true,
      max: 20_000,
    }),
    citation,
    status,
  };
}

function parseOutlineNode(input: unknown, path: string): OutlineNode {
  const object = objectAt(input, path);
  return {
    ...versionedAt(object, path),
    position: integerAt(object.position, `${path}.position`, 0),
    title: stringAt(object.title, `${path}.title`, { max: 1_000 }),
    conclusion: stringAt(object.conclusion, `${path}.conclusion`, {
      max: 20_000,
    }),
    evidenceCardIds: idListAt(
      object.evidenceCardIds,
      `${path}.evidenceCardIds`,
      { allowEmpty: true },
    ),
    locked: booleanAt(object.locked, `${path}.locked`),
  };
}

export function parseOutline(input: unknown): Outline {
  const path = 'outline';
  const object = objectAt(input, path);
  const status = enumAt(object.status, `${path}.status`, [
    'draft',
    'selected',
    'locked',
    'archived',
  ] as const);
  const lockedAt = nullableAt(
    object.lockedAt,
    dateTimeAt,
    `${path}.lockedAt`,
  );
  if (status === 'locked' && lockedAt === null) {
    fail(`${path}.lockedAt`, 'is required when status is locked');
  }
  if (status !== 'locked' && lockedAt !== null) {
    fail(`${path}.lockedAt`, 'is only allowed when status is locked');
  }
  const nodes = arrayAt(object.nodes, `${path}.nodes`).map((item, index) =>
    parseOutlineNode(item, `${path}.nodes[${index}]`),
  );
  if (nodes.length === 0) {
    fail(`${path}.nodes`, 'must contain at least one node');
  }
  assertUniqueIdentities(nodes, `${path}.nodes`);
  const positions = nodes.map((node) => node.position);
  if (
    new Set(positions).size !== positions.length ||
    [...positions].sort((left, right) => left - right).some(
      (position, index) => position !== index,
    )
  ) {
    fail(`${path}.nodes.position`, 'positions must be unique and contiguous');
  }
  if (
    (status === 'selected' || status === 'locked') &&
    nodes.some((node) => node.evidenceCardIds.length === 0)
  ) {
    fail(
      `${path}.nodes.evidenceCardIds`,
      'every selected or locked node must bind evidence',
    );
  }
  if (status === 'locked' && nodes.some((node) => !node.locked)) {
    fail(`${path}.nodes.locked`, 'every node must be locked');
  }
  return {
    ...versionedAt(object, path),
    projectId: idAt(object.projectId, `${path}.projectId`),
    title: stringAt(object.title, `${path}.title`, { max: 1_000 }),
    status,
    lockedAt,
    nodes,
  };
}

function jsonValueAt(
  value: unknown,
  path: string,
  seen = new WeakSet<object>(),
): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail(path, 'must not contain non-finite numbers');
    }
    return value;
  }
  if (typeof value !== 'object') {
    fail(path, 'must be JSON-compatible');
  }
  if (seen.has(value)) {
    fail(path, 'must not contain cycles');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item, index) =>
      jsonValueAt(item, `${path}[${index}]`, seen),
    );
    seen.delete(value);
    return result;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    fail(path, 'must contain only plain JSON objects');
  }
  const result: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = jsonValueAt(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
  return result;
}

export function parseArtifact(input: unknown): Artifact {
  const path = 'artifact';
  const object = objectAt(input, path);
  const status = enumAt(object.status, `${path}.status`, [
    'draft',
    'ready',
    'stale',
    'exported',
    'failed',
  ] as const);
  const blobId = nullableAt(
    object.blobId,
    (value, valuePath) => stringAt(value, valuePath, { max: 1_000 }),
    `${path}.blobId`,
  );
  const contentSha256 = nullableAt(
    object.contentSha256,
    sha256At,
    `${path}.contentSha256`,
  );
  const staleBecause = stringListAt(
    object.staleBecause,
    `${path}.staleBecause`,
    { allowEmpty: true, itemMax: 500 },
  );
  const errorCode = nullableAt(
    object.errorCode,
    (value, valuePath) => {
      const code = stringAt(value, valuePath, { max: 64 });
      if (!ERROR_CODE.test(code)) {
        fail(valuePath, 'must be a stable uppercase error code');
      }
      return code;
    },
    `${path}.errorCode`,
  );
  if (status === 'exported' && blobId === null) {
    fail(`${path}.blobId`, 'is required when status is exported');
  }
  if (status === 'exported' && contentSha256 === null) {
    fail(`${path}.contentSha256`, 'is required when status is exported');
  }
  if (status === 'failed' && errorCode === null) {
    fail(`${path}.errorCode`, 'is required when status is failed');
  }
  if (status !== 'failed' && errorCode !== null) {
    fail(`${path}.errorCode`, 'is only allowed when status is failed');
  }
  if (status === 'stale' && staleBecause.length === 0) {
    fail(`${path}.staleBecause`, 'is required when status is stale');
  }
  if (status !== 'stale' && staleBecause.length !== 0) {
    fail(`${path}.staleBecause`, 'is only allowed when status is stale');
  }
  return {
    ...versionedAt(object, path),
    projectId: idAt(object.projectId, `${path}.projectId`),
    outlineId: idAt(object.outlineId, `${path}.outlineId`),
    outlineVersion: integerAt(
      object.outlineVersion,
      `${path}.outlineVersion`,
      1,
    ),
    kind: enumAt(object.kind, `${path}.kind`, [
      'presentation',
      'document',
      'markdown',
      'script',
      'source_index',
      'task_definition',
      'verification_record',
      'project_package',
    ] as const),
    status,
    payload: jsonValueAt(object.payload, `${path}.payload`),
    blobId,
    contentSha256,
    staleBecause,
    errorCode,
  };
}

function parseVerificationCheck(
  input: unknown,
  path: string,
): VerificationCheck {
  const object = objectAt(input, path);
  return {
    ...versionedAt(object, path),
    rule: enumAt(object.rule, `${path}.rule`, [
      'citation_exists',
      'source_traceable',
      'required_content',
      'forbidden_content',
      'length_target',
      'presentation_duration',
      'rubric_coverage',
    ] as const),
    outcome: enumAt(object.outcome, `${path}.outcome`, [
      'pass',
      'warning',
      'fail',
      'not_run',
    ] as const),
    message: stringAt(object.message, `${path}.message`, { max: 5_000 }),
    artifactPath: stringAt(object.artifactPath, `${path}.artifactPath`, {
      max: 2_000,
    }),
    evidenceCardIds: idListAt(
      object.evidenceCardIds,
      `${path}.evidenceCardIds`,
      { allowEmpty: true },
    ),
  };
}

export function parseVerificationResult(input: unknown): VerificationResult {
  const path = 'verificationResult';
  const object = objectAt(input, path);
  const status = enumAt(object.status, `${path}.status`, [
    'pending',
    'passed',
    'failed',
    'stale',
  ] as const);
  const checks = arrayAt(object.checks, `${path}.checks`).map((item, index) =>
    parseVerificationCheck(item, `${path}.checks[${index}]`),
  );
  assertUniqueIdentities(checks, `${path}.checks`);
  const summaryObject = objectAt(object.summary, `${path}.summary`);
  const summary: VerificationSummary = {
    passed: integerAt(
      summaryObject.passed,
      `${path}.summary.passed`,
      0,
    ),
    warnings: integerAt(
      summaryObject.warnings,
      `${path}.summary.warnings`,
      0,
    ),
    failed: integerAt(
      summaryObject.failed,
      `${path}.summary.failed`,
      0,
    ),
    notRun: integerAt(
      summaryObject.notRun,
      `${path}.summary.notRun`,
      0,
    ),
  };
  const actual: VerificationSummary = {
    passed: checks.filter((check) => check.outcome === 'pass').length,
    warnings: checks.filter((check) => check.outcome === 'warning').length,
    failed: checks.filter((check) => check.outcome === 'fail').length,
    notRun: checks.filter((check) => check.outcome === 'not_run').length,
  };
  if (
    summary.passed !== actual.passed ||
    summary.warnings !== actual.warnings ||
    summary.failed !== actual.failed ||
    summary.notRun !== actual.notRun
  ) {
    fail(`${path}.summary`, 'must exactly match check outcomes');
  }
  if (status === 'passed' && (actual.failed > 0 || actual.notRun > 0)) {
    fail(`${path}.status`, 'cannot pass with failed or unrun checks');
  }
  if (status === 'failed' && actual.failed === 0) {
    fail(`${path}.status`, 'requires at least one failed check');
  }
  if (
    status === 'pending' &&
    checks.length > 0 &&
    actual.notRun !== checks.length
  ) {
    fail(`${path}.status`, 'pending results may only contain unrun checks');
  }
  return {
    ...versionedAt(object, path),
    projectId: idAt(object.projectId, `${path}.projectId`),
    artifactId: idAt(object.artifactId, `${path}.artifactId`),
    artifactVersion: integerAt(
      object.artifactVersion,
      `${path}.artifactVersion`,
      1,
    ),
    status,
    checkedAt: dateTimeAt(object.checkedAt, `${path}.checkedAt`),
    checks,
    summary,
  };
}

function parseCollection<T>(
  value: unknown,
  path: string,
  parser: (candidate: unknown) => T,
): T[] {
  return arrayAt(value, path).map((item) => parser(item));
}

export function parseProject(input: unknown): Project {
  const path = 'project';
  const object = objectAt(input, path);
  const schemaVersion = integerAt(
    object.schemaVersion,
    `${path}.schemaVersion`,
    1,
  );
  if (schemaVersion !== PROJECT_SCHEMA_VERSION) {
    fail(
      `${path}.schemaVersion`,
      `unsupported schema version ${schemaVersion}`,
    );
  }
  const entity = versionedAt(object, path);
  const taskDefinition = parseTaskDefinition(object.taskDefinition);
  const sourceFiles = parseCollection(
    object.sourceFiles,
    `${path}.sourceFiles`,
    parseSourceFile,
  );
  const sourceChunks = parseCollection(
    object.sourceChunks,
    `${path}.sourceChunks`,
    parseSourceChunk,
  );
  const evidenceCards = parseCollection(
    object.evidenceCards,
    `${path}.evidenceCards`,
    parseEvidenceCard,
  );
  const outlines = parseCollection(
    object.outlines,
    `${path}.outlines`,
    parseOutline,
  );
  const artifacts = parseCollection(
    object.artifacts,
    `${path}.artifacts`,
    parseArtifact,
  );
  const verificationResults = parseCollection(
    object.verificationResults,
    `${path}.verificationResults`,
    parseVerificationResult,
  );
  assertUniqueIdentities(sourceFiles, `${path}.sourceFiles`);
  assertUniqueIdentities(sourceChunks, `${path}.sourceChunks`);
  assertUniqueIdentities(evidenceCards, `${path}.evidenceCards`);
  assertUniqueIdentities(outlines, `${path}.outlines`);
  assertUniqueIdentities(artifacts, `${path}.artifacts`);
  assertUniqueIdentities(
    verificationResults,
    `${path}.verificationResults`,
  );
  const allEntities: VersionedEntity[] = [
    entity,
    taskDefinition,
    ...taskDefinition.rubric,
    ...sourceFiles,
    ...sourceChunks,
    ...evidenceCards,
    ...outlines,
    ...outlines.flatMap((outline) => outline.nodes),
    ...artifacts,
    ...verificationResults,
    ...verificationResults.flatMap((result) => result.checks),
  ];
  if (
    new Set(allEntities.map((candidate) => candidate.id)).size !==
    allEntities.length
  ) {
    fail(
      `${path}.identities`,
      'must be globally unique across all project entity types',
    );
  }

  const collections: [string, readonly { projectId: EntityId }[]][] = [
    ['sourceFiles', sourceFiles],
    ['sourceChunks', sourceChunks],
    ['evidenceCards', evidenceCards],
    ['outlines', outlines],
    ['artifacts', artifacts],
    ['verificationResults', verificationResults],
  ];
  for (const [collectionName, collection] of collections) {
    if (collection.some((item) => item.projectId !== entity.id)) {
      fail(
        `${path}.${collectionName}.projectId`,
        'must refer to the containing project',
      );
    }
  }

  const filesById = new Map(sourceFiles.map((file) => [file.id, file]));
  const chunksById = new Map(sourceChunks.map((chunk) => [chunk.id, chunk]));
  const evidenceById = new Map(
    evidenceCards.map((evidence) => [evidence.id, evidence]),
  );
  const outlinesById = new Map(outlines.map((outline) => [outline.id, outline]));
  const artifactsById = new Map(
    artifacts.map((artifact) => [artifact.id, artifact]),
  );

  for (const chunk of sourceChunks) {
    const file = filesById.get(chunk.sourceFileId);
    if (file === undefined) {
      fail(
        `${path}.sourceChunks.sourceFileId`,
        'must refer to a project source file',
      );
    }
    if (file.sourceVersion !== chunk.sourceFileVersion) {
      fail(
        `${path}.sourceChunks.sourceFileVersion`,
        'must match the referenced source file version',
      );
    }
  }
  for (const evidence of evidenceCards) {
    const file = filesById.get(evidence.sourceFileId);
    const chunk = chunksById.get(evidence.sourceChunkId);
    if (file === undefined) {
      fail(
        `${path}.evidenceCards.sourceFileId`,
        'must refer to a project source file',
      );
    }
    if (chunk === undefined) {
      fail(
        `${path}.evidenceCards.sourceChunkId`,
        'must refer to a project source chunk',
      );
    }
    if (
      chunk.sourceFileId !== file.id ||
      evidence.sourceFileVersion !== file.sourceVersion ||
      chunk.sourceFileVersion !== file.sourceVersion
    ) {
      fail(
        `${path}.evidenceCards.sourceFileVersion`,
        'must match the referenced file and chunk',
      );
    }
    if (
      evidence.pageNumber !== chunk.pageNumber ||
      evidence.characterStart < chunk.characterStart ||
      evidence.characterEnd > chunk.characterEnd
    ) {
      fail(
        `${path}.evidenceCards.characterStart`,
        'must remain within the referenced chunk anchor',
      );
    }
    if (!chunk.text.includes(evidence.quote)) {
      fail(
        `${path}.evidenceCards.quote`,
        'must be an exact quotation contained by the referenced source chunk',
      );
    }
  }
  for (const outline of outlines) {
    for (const node of outline.nodes) {
      if (
        node.evidenceCardIds.some(
          (evidenceId) => !evidenceById.has(evidenceId),
        )
      ) {
        fail(
          `${path}.outlines.nodes.evidenceCardIds`,
          'must refer to project evidence cards',
        );
      }
    }
  }
  for (const artifact of artifacts) {
    const outline = outlinesById.get(artifact.outlineId);
    if (outline === undefined) {
      fail(
        `${path}.artifacts.outlineId`,
        'must refer to a project outline',
      );
    }
    if (outline.version !== artifact.outlineVersion) {
      fail(
        `${path}.artifacts.outlineVersion`,
        'must match the referenced outline version',
      );
    }
  }
  for (const result of verificationResults) {
    const artifact = artifactsById.get(result.artifactId);
    if (artifact === undefined) {
      fail(
        `${path}.verificationResults.artifactId`,
        'must refer to a project artifact',
      );
    }
    if (artifact.version !== result.artifactVersion) {
      fail(
        `${path}.verificationResults.artifactVersion`,
        'must match the referenced artifact version',
      );
    }
    if (
      result.checks.some((check) =>
        check.evidenceCardIds.some(
          (evidenceId) => !evidenceById.has(evidenceId),
        ),
      )
    ) {
      fail(
        `${path}.verificationResults.checks.evidenceCardIds`,
        'must refer to project evidence cards',
      );
    }
  }

  const activeOutlineId = nullableAt(
    object.activeOutlineId,
    idAt,
    `${path}.activeOutlineId`,
  );
  if (activeOutlineId !== null) {
    const activeOutline = outlinesById.get(activeOutlineId);
    if (
      activeOutline === undefined ||
      (activeOutline.status !== 'selected' &&
        activeOutline.status !== 'locked')
    ) {
      fail(
        `${path}.activeOutlineId`,
        'must refer to a selected or locked project outline',
      );
    }
  }

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    ...entity,
    title: stringAt(object.title, `${path}.title`, { max: 1_000 }),
    status: enumAt(object.status, `${path}.status`, [
      'active',
      'archived',
    ] as const),
    taskDefinition,
    sourceFiles,
    sourceChunks,
    evidenceCards,
    outlines,
    activeOutlineId,
    artifacts,
    verificationResults,
  };
}

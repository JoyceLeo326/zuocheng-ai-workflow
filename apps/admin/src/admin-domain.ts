export type AdminRole =
  | 'owner'
  | 'administrator'
  | 'operator'
  | 'content'
  | 'support'
  | 'finance'
  | 'auditor'
  | 'mentor'
  | 'member';

export type ContentKind = 'course' | 'lesson' | 'class' | 'template';
export type ContentStatus = 'draft' | 'published' | 'archived';
export type DeliveryKind = 'project' | 'assignment' | 'submission';
export type DeliveryStatus =
  | 'active'
  | 'submitted'
  | 'reviewing'
  | 'needs_revision'
  | 'completed'
  | 'archived';
export type FeedbackKind = 'feedback' | 'appeal' | 'support_ticket';
export type FeedbackStatus = 'open' | 'in_review' | 'resolved' | 'rejected';
export type JobKind = 'ai' | 'file_parse' | 'export' | 'notification';
export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_review'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'quota_exhausted'
  | 'stale';
export type CommercialKind = 'order' | 'refund' | 'subscription';
export type CommercialStatus =
  | 'pending'
  | 'paid'
  | 'failed'
  | 'refunded'
  | 'cancelled';

interface VersionedRecord {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUser extends VersionedRecord {
  displayName: string;
  email: string;
  roles: AdminRole[];
  status: 'active' | 'suspended';
}

export interface ContentRecord extends VersionedRecord {
  kind: ContentKind;
  title: string;
  status: ContentStatus;
  publishedAt?: string;
}

export interface DeliveryItem extends VersionedRecord {
  kind: DeliveryKind;
  title: string;
  ownerLabel: string;
  status: DeliveryStatus;
}

export interface FeedbackCase extends VersionedRecord {
  kind: FeedbackKind;
  subject: string;
  requester: string;
  detail: string;
  status: FeedbackStatus;
  resolution?: string;
}

export interface OperationJob extends VersionedRecord {
  kind: JobKind;
  title: string;
  workspaceId: string;
  status: JobStatus;
  attempts: number;
  estimatedCostMinor: number;
  safetyMarginMinor: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface UsageAccount extends VersionedRecord {
  workspaceId: string;
  workspaceName: string;
  period: string;
  quotaUnits: number;
  usedUnits: number;
  reservedUnits: number;
  balanceMinor: number;
  currency: 'CNY' | 'USD';
}

export interface UsageLedgerEntry {
  id: string;
  workspaceId: string;
  direction: 'credit' | 'debit' | 'reserve' | 'release';
  amountMinor: number;
  units: number;
  description: string;
  createdAt: string;
}

export interface CommercialRecord extends VersionedRecord {
  kind: CommercialKind;
  reference: string;
  workspaceId: string;
  status: CommercialStatus;
  amountMinor: number;
  currency: 'CNY' | 'USD';
  note: string;
}

export interface FeatureFlag extends VersionedRecord {
  key: string;
  enabled: boolean;
  scope: string;
  reason: string;
}

export interface AuditEvent {
  id: string;
  sequence: number;
  actor: string;
  action: AdminCommand['type'] | 'snapshot.import';
  targetType:
    | 'user'
    | 'content'
    | 'delivery'
    | 'feedback'
    | 'job'
    | 'usage'
    | 'commercial'
    | 'feature_flag'
    | 'system';
  targetId: string;
  outcome: 'success';
  summary: string;
  createdAt: string;
}

export interface AdminSnapshot {
  schemaVersion: 1;
  version: number;
  updatedAt: string;
  users: AdminUser[];
  contents: ContentRecord[];
  deliveryItems: DeliveryItem[];
  feedbackCases: FeedbackCase[];
  jobs: OperationJob[];
  usageAccounts: UsageAccount[];
  usageLedger: UsageLedgerEntry[];
  commercialRecords: CommercialRecord[];
  featureFlags: FeatureFlag[];
  auditEvents: AuditEvent[];
}

interface CommandEnvelope {
  expectedVersion: number;
  actor: string;
}

export type AdminCommand =
  | (CommandEnvelope & {
      type: 'user.create';
      payload: {
        displayName: string;
        email: string;
        roles: AdminRole[];
      };
    })
  | (CommandEnvelope & {
      type: 'user.roles';
      payload: {
        userId: string;
        roles: AdminRole[];
        confirmation: string;
      };
    })
  | (CommandEnvelope & {
      type: 'user.suspend';
      payload: { userId: string; confirmation: string };
    })
  | (CommandEnvelope & {
      type: 'user.restore';
      payload: { userId: string };
    })
  | (CommandEnvelope & {
      type: 'content.create';
      payload: { kind: ContentKind; title: string };
    })
  | (CommandEnvelope & {
      type: 'content.transition';
      payload: {
        contentId: string;
        status: ContentStatus;
        confirmation?: string;
      };
    })
  | (CommandEnvelope & {
      type: 'delivery.create';
      payload: {
        kind: DeliveryKind;
        title: string;
        ownerLabel: string;
        status?: DeliveryStatus;
      };
    })
  | (CommandEnvelope & {
      type: 'delivery.transition';
      payload: { deliveryId: string; status: DeliveryStatus };
    })
  | (CommandEnvelope & {
      type: 'feedback.create';
      payload: {
        kind: FeedbackKind;
        subject: string;
        requester: string;
        detail: string;
      };
    })
  | (CommandEnvelope & {
      type: 'feedback.transition';
      payload: {
        feedbackId: string;
        status: FeedbackStatus;
        resolution: string;
      };
    })
  | (CommandEnvelope & {
      type: 'job.create';
      payload: {
        kind: JobKind;
        title: string;
        workspaceId: string;
        estimatedCostMinor: number;
        safetyMarginMinor: number;
      };
    })
  | (CommandEnvelope & {
      type: 'job.transition';
      payload: {
        jobId: string;
        status: JobStatus;
        errorCode?: string;
        errorMessage?: string;
        confirmation?: string;
      };
    })
  | (CommandEnvelope & {
      type: 'usage.account.upsert';
      payload: {
        workspaceId: string;
        workspaceName: string;
        period: string;
        quotaUnits: number;
        usedUnits: number;
        reservedUnits: number;
        balanceMinor: number;
        currency: 'CNY' | 'USD';
      };
    })
  | (CommandEnvelope & {
      type: 'usage.ledger.record';
      payload: {
        workspaceId: string;
        direction: UsageLedgerEntry['direction'];
        amountMinor: number;
        units: number;
        description: string;
        confirmation: string;
      };
    })
  | (CommandEnvelope & {
      type: 'commercial.record';
      payload: {
        kind: CommercialKind;
        reference: string;
        workspaceId: string;
        status: CommercialStatus;
        amountMinor: number;
        currency: 'CNY' | 'USD';
        note: string;
        confirmation: string;
      };
    })
  | (CommandEnvelope & {
      type: 'feature-flag.upsert';
      payload: {
        key: string;
        enabled: boolean;
        scope: string;
        reason: string;
        confirmation?: string;
      };
    });

export interface AdminDomainRuntime {
  now: string;
  createId: () => string;
}

export class AdminDomainError extends Error {}

export class AdminValidationError extends AdminDomainError {}

export class AdminConflictError extends AdminDomainError {
  constructor(
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super(
      `数据版本已变化（期望 ${String(expectedVersion)}，当前 ${String(currentVersion)}），请刷新后重试。`,
    );
  }
}

export class AdminConfirmationError extends AdminDomainError {}

export class AdminQuotaError extends AdminDomainError {}

export function createEmptyAdminSnapshot(now: string): AdminSnapshot {
  return {
    schemaVersion: 1,
    version: 1,
    updatedAt: now,
    users: [],
    contents: [],
    deliveryItems: [],
    feedbackCases: [],
    jobs: [],
    usageAccounts: [],
    usageLedger: [],
    commercialRecords: [],
    featureFlags: [],
    auditEvents: [],
  };
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new AdminValidationError(`${label}不能为空。`);
  }
  return normalized;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new AdminValidationError(`${label}必须是非负数。`);
  }
  return value;
}

function assertConfirmation(actual: string | undefined, expected: string): void {
  if (actual?.trim() !== expected) {
    throw new AdminConfirmationError(`请输入“${expected}”确认此操作。`);
  }
}

function findRecord<T extends VersionedRecord>(
  records: T[],
  id: string,
  label: string,
): T {
  const record = records.find((candidate) => candidate.id === id);
  if (record === undefined) {
    throw new AdminValidationError(`未找到${label}。`);
  }
  return record;
}

function bump<T extends VersionedRecord>(
  record: T,
  now: string,
  patch: Partial<T>,
): T {
  return {
    ...record,
    ...patch,
    version: record.version + 1,
    updatedAt: now,
  };
}

function newRecord(
  id: string,
  now: string,
): Pick<VersionedRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'> {
  return { id, version: 1, createdAt: now, updatedAt: now };
}

interface CommandResult {
  targetType: AuditEvent['targetType'];
  targetId: string;
  summary: string;
}

function applyCommandBody(
  draft: AdminSnapshot,
  command: AdminCommand,
  runtime: AdminDomainRuntime,
): CommandResult {
  const { now, createId } = runtime;

  switch (command.type) {
    case 'user.create': {
      const email = required(command.payload.email, '邮箱').toLowerCase();
      if (draft.users.some((user) => user.email.toLowerCase() === email)) {
        throw new AdminValidationError('该邮箱已存在于当前管理员数据集。');
      }
      if (command.payload.roles.length === 0) {
        throw new AdminValidationError('至少选择一个角色。');
      }
      const user: AdminUser = {
        ...newRecord(createId(), now),
        displayName: required(command.payload.displayName, '姓名'),
        email,
        roles: [...new Set(command.payload.roles)],
        status: 'active',
      };
      draft.users.push(user);
      return {
        targetType: 'user',
        targetId: user.id,
        summary: `创建用户记录：${user.displayName}`,
      };
    }
    case 'user.roles': {
      const user = findRecord(draft.users, command.payload.userId, '用户');
      if (command.payload.roles.length === 0) {
        throw new AdminValidationError('至少选择一个角色。');
      }
      assertConfirmation(
        command.payload.confirmation,
        `授权 ${user.displayName}`,
      );
      draft.users = draft.users.map((candidate) =>
        candidate.id === user.id
          ? bump(candidate, now, {
              roles: [...new Set(command.payload.roles)],
            })
          : candidate,
      );
      return {
        targetType: 'user',
        targetId: user.id,
        summary: `更新用户权限：${user.displayName}`,
      };
    }
    case 'user.suspend': {
      const user = findRecord(draft.users, command.payload.userId, '用户');
      assertConfirmation(
        command.payload.confirmation,
        `停用 ${user.displayName}`,
      );
      draft.users = draft.users.map((candidate) =>
        candidate.id === user.id
          ? bump(candidate, now, { status: 'suspended' })
          : candidate,
      );
      return {
        targetType: 'user',
        targetId: user.id,
        summary: `停用用户：${user.displayName}`,
      };
    }
    case 'user.restore': {
      const user = findRecord(draft.users, command.payload.userId, '用户');
      draft.users = draft.users.map((candidate) =>
        candidate.id === user.id
          ? bump(candidate, now, { status: 'active' })
          : candidate,
      );
      return {
        targetType: 'user',
        targetId: user.id,
        summary: `恢复用户：${user.displayName}`,
      };
    }
    case 'content.create': {
      const content: ContentRecord = {
        ...newRecord(createId(), now),
        kind: command.payload.kind,
        title: required(command.payload.title, '内容名称'),
        status: 'draft',
      };
      draft.contents.push(content);
      return {
        targetType: 'content',
        targetId: content.id,
        summary: `创建${content.kind}草稿：${content.title}`,
      };
    }
    case 'content.transition': {
      const content = findRecord(
        draft.contents,
        command.payload.contentId,
        '内容',
      );
      if (command.payload.status === 'published') {
        assertConfirmation(
          command.payload.confirmation,
          `发布 ${content.title}`,
        );
      }
      if (command.payload.status === 'archived') {
        assertConfirmation(
          command.payload.confirmation,
          `归档 ${content.title}`,
        );
      }
      draft.contents = draft.contents.map((candidate) =>
        candidate.id === content.id
          ? bump(candidate, now, {
              status: command.payload.status,
              ...(command.payload.status === 'published'
                ? { publishedAt: candidate.publishedAt ?? now }
                : {}),
            })
          : candidate,
      );
      return {
        targetType: 'content',
        targetId: content.id,
        summary: `内容状态变更为 ${command.payload.status}：${content.title}`,
      };
    }
    case 'delivery.create': {
      const item: DeliveryItem = {
        ...newRecord(createId(), now),
        kind: command.payload.kind,
        title: required(command.payload.title, '项目或作业名称'),
        ownerLabel: required(command.payload.ownerLabel, '负责人或提交人'),
        status: command.payload.status ?? 'active',
      };
      draft.deliveryItems.push(item);
      return {
        targetType: 'delivery',
        targetId: item.id,
        summary: `登记${item.kind}：${item.title}`,
      };
    }
    case 'delivery.transition': {
      const item = findRecord(
        draft.deliveryItems,
        command.payload.deliveryId,
        '项目或作业',
      );
      draft.deliveryItems = draft.deliveryItems.map((candidate) =>
        candidate.id === item.id
          ? bump(candidate, now, { status: command.payload.status })
          : candidate,
      );
      return {
        targetType: 'delivery',
        targetId: item.id,
        summary: `交付状态变更为 ${command.payload.status}：${item.title}`,
      };
    }
    case 'feedback.create': {
      const feedback: FeedbackCase = {
        ...newRecord(createId(), now),
        kind: command.payload.kind,
        subject: required(command.payload.subject, '主题'),
        requester: required(command.payload.requester, '申请人'),
        detail: required(command.payload.detail, '问题描述'),
        status: 'open',
      };
      draft.feedbackCases.push(feedback);
      return {
        targetType: 'feedback',
        targetId: feedback.id,
        summary: `登记${feedback.kind}：${feedback.subject}`,
      };
    }
    case 'feedback.transition': {
      const feedback = findRecord(
        draft.feedbackCases,
        command.payload.feedbackId,
        '反馈或申诉',
      );
      const resolution = required(command.payload.resolution, '处理说明');
      draft.feedbackCases = draft.feedbackCases.map((candidate) =>
        candidate.id === feedback.id
          ? bump(candidate, now, {
              status: command.payload.status,
              resolution,
            })
          : candidate,
      );
      return {
        targetType: 'feedback',
        targetId: feedback.id,
        summary: `反馈状态变更为 ${command.payload.status}：${feedback.subject}`,
      };
    }
    case 'job.create': {
      const estimatedCostMinor = nonNegative(
        command.payload.estimatedCostMinor,
        '预计费用',
      );
      const safetyMarginMinor = nonNegative(
        command.payload.safetyMarginMinor,
        '安全余量',
      );
      const workspaceId = required(command.payload.workspaceId, 'Workspace');
      const account = draft.usageAccounts.find(
        (candidate) => candidate.workspaceId === workspaceId,
      );
      const reservationMinor = estimatedCostMinor + safetyMarginMinor;
      if (
        reservationMinor > 0 &&
        (account === undefined ||
          account.balanceMinor < reservationMinor)
      ) {
        throw new AdminQuotaError(
          '可用余额不足以覆盖预计费用和安全余量，任务未创建。',
        );
      }
      if (
        account !== undefined &&
        account.usedUnits + account.reservedUnits >= account.quotaUnits
      ) {
        throw new AdminQuotaError('当前周期配额已耗尽，任务未创建。');
      }
      const job: OperationJob = {
        ...newRecord(createId(), now),
        kind: command.payload.kind,
        title: required(command.payload.title, '任务名称'),
        workspaceId,
        status: 'queued',
        attempts: 0,
        estimatedCostMinor,
        safetyMarginMinor,
      };
      draft.jobs.push(job);
      if (account !== undefined && reservationMinor > 0) {
        draft.usageAccounts = draft.usageAccounts.map((candidate) =>
          candidate.id === account.id
            ? bump(candidate, now, {
                balanceMinor: candidate.balanceMinor - reservationMinor,
              })
            : candidate,
        );
        draft.usageLedger.push({
          id: createId(),
          workspaceId,
          direction: 'reserve',
          amountMinor: reservationMinor,
          units: 0,
          description: `任务预留：${job.title}`,
          createdAt: now,
        });
      }
      return {
        targetType: 'job',
        targetId: job.id,
        summary:
          reservationMinor > 0
            ? `创建任务并预留 ${String(reservationMinor)} 分：${job.title}`
            : `创建任务：${job.title}`,
      };
    }
    case 'job.transition': {
      const job = findRecord(draft.jobs, command.payload.jobId, '任务');
      if (
        command.payload.status === 'cancelled' ||
        ((job.status === 'failed' || job.status === 'quota_exhausted') &&
          command.payload.status === 'queued')
      ) {
        assertConfirmation(
          command.payload.confirmation,
          `${command.payload.status === 'cancelled' ? '取消' : '重试'} ${job.title}`,
        );
      }
      const attempts =
        (job.status === 'failed' || job.status === 'quota_exhausted') &&
        command.payload.status === 'queued'
          ? job.attempts + 1
          : job.attempts;
      draft.jobs = draft.jobs.map((candidate) =>
        candidate.id === job.id
          ? bump(candidate, now, {
              status: command.payload.status,
              attempts,
              ...(command.payload.errorCode === undefined
                ? {}
                : { errorCode: command.payload.errorCode }),
              ...(command.payload.errorMessage === undefined
                ? {}
                : { errorMessage: command.payload.errorMessage }),
            })
          : candidate,
      );
      return {
        targetType: 'job',
        targetId: job.id,
        summary: `任务状态变更为 ${command.payload.status}：${job.title}`,
      };
    }
    case 'usage.account.upsert': {
      const payload = command.payload;
      const account = draft.usageAccounts.find(
        (candidate) => candidate.workspaceId === payload.workspaceId,
      );
      const patch = {
        workspaceId: required(payload.workspaceId, 'Workspace'),
        workspaceName: required(payload.workspaceName, 'Workspace 名称'),
        period: required(payload.period, '计量周期'),
        quotaUnits: nonNegative(payload.quotaUnits, '配额'),
        usedUnits: nonNegative(payload.usedUnits, '已用量'),
        reservedUnits: nonNegative(payload.reservedUnits, '预留量'),
        balanceMinor: nonNegative(payload.balanceMinor, '余额'),
        currency: payload.currency,
      };
      if (patch.usedUnits + patch.reservedUnits > patch.quotaUnits) {
        throw new AdminValidationError('已用量与预留量之和不能超过配额。');
      }
      if (account === undefined) {
        const created: UsageAccount = {
          ...newRecord(createId(), now),
          ...patch,
        };
        draft.usageAccounts.push(created);
        return {
          targetType: 'usage',
          targetId: created.id,
          summary: `创建用量账户：${created.workspaceName}`,
        };
      }
      draft.usageAccounts = draft.usageAccounts.map((candidate) =>
        candidate.id === account.id ? bump(candidate, now, patch) : candidate,
      );
      return {
        targetType: 'usage',
        targetId: account.id,
        summary: `更新用量账户：${patch.workspaceName}`,
      };
    }
    case 'usage.ledger.record': {
      const account = draft.usageAccounts.find(
        (candidate) =>
          candidate.workspaceId === command.payload.workspaceId,
      );
      if (account === undefined) {
        throw new AdminValidationError('未找到对应的用量账户。');
      }
      assertConfirmation(
        command.payload.confirmation,
        `记账 ${account.workspaceName}`,
      );
      const amountMinor = nonNegative(command.payload.amountMinor, '金额');
      const units = nonNegative(command.payload.units, '用量');
      const balanceDelta =
        command.payload.direction === 'credit' ||
        command.payload.direction === 'release'
          ? amountMinor
          : command.payload.direction === 'debit' ||
              command.payload.direction === 'reserve'
            ? -amountMinor
            : 0;
      const usedDelta =
        command.payload.direction === 'debit' ? units : 0;
      const reservedDelta =
        command.payload.direction === 'reserve'
          ? units
          : command.payload.direction === 'release'
            ? -units
            : 0;
      const balanceMinor = account.balanceMinor + balanceDelta;
      const usedUnits = account.usedUnits + usedDelta;
      const reservedUnits = account.reservedUnits + reservedDelta;
      if (balanceMinor < 0) {
        throw new AdminQuotaError('余额不足，未记录扣款。');
      }
      if (
        usedUnits < 0 ||
        reservedUnits < 0 ||
        usedUnits + reservedUnits > account.quotaUnits
      ) {
        throw new AdminQuotaError('本次记录会超出可用配额，操作已阻止。');
      }
      draft.usageAccounts = draft.usageAccounts.map((candidate) =>
        candidate.id === account.id
          ? bump(candidate, now, {
              balanceMinor,
              usedUnits,
              reservedUnits,
            })
          : candidate,
      );
      const entry: UsageLedgerEntry = {
        id: createId(),
        workspaceId: account.workspaceId,
        direction: command.payload.direction,
        amountMinor,
        units,
        description: required(command.payload.description, '记账说明'),
        createdAt: now,
      };
      draft.usageLedger.push(entry);
      return {
        targetType: 'usage',
        targetId: account.id,
        summary: `记录用量账本：${entry.description}`,
      };
    }
    case 'commercial.record': {
      assertConfirmation(
        command.payload.confirmation,
        `记录 ${command.payload.reference.trim()}`,
      );
      const record: CommercialRecord = {
        ...newRecord(createId(), now),
        kind: command.payload.kind,
        reference: required(command.payload.reference, '业务单号'),
        workspaceId: required(command.payload.workspaceId, 'Workspace'),
        status: command.payload.status,
        amountMinor: nonNegative(command.payload.amountMinor, '金额'),
        currency: command.payload.currency,
        note: required(command.payload.note, '说明'),
      };
      draft.commercialRecords.push(record);
      return {
        targetType: 'commercial',
        targetId: record.id,
        summary: `记录${record.kind}：${record.reference}`,
      };
    }
    case 'feature-flag.upsert': {
      const key = required(command.payload.key, '功能标识');
      const existing = draft.featureFlags.find(
        (candidate) => candidate.key === key,
      );
      if (existing === undefined && command.payload.enabled) {
        assertConfirmation(command.payload.confirmation, `启用 ${key}`);
      }
      if (existing !== undefined && existing.enabled !== command.payload.enabled) {
        assertConfirmation(command.payload.confirmation, `切换 ${key}`);
      }
      const patch = {
        key,
        enabled: command.payload.enabled,
        scope: required(command.payload.scope, '作用域'),
        reason: required(command.payload.reason, '变更原因'),
      };
      if (existing === undefined) {
        const flag: FeatureFlag = {
          ...newRecord(createId(), now),
          ...patch,
        };
        draft.featureFlags.push(flag);
        return {
          targetType: 'feature_flag',
          targetId: flag.id,
          summary: `创建功能开关：${flag.key}`,
        };
      }
      draft.featureFlags = draft.featureFlags.map((candidate) =>
        candidate.id === existing.id
          ? bump(candidate, now, patch)
          : candidate,
      );
      return {
        targetType: 'feature_flag',
        targetId: existing.id,
        summary: `更新功能开关：${existing.key}`,
      };
    }
  }
}

export function applyAdminCommand(
  snapshot: AdminSnapshot,
  command: AdminCommand,
  runtime: AdminDomainRuntime,
): AdminSnapshot {
  if (command.expectedVersion !== snapshot.version) {
    throw new AdminConflictError(command.expectedVersion, snapshot.version);
  }
  const actor = required(command.actor, '操作人');
  const draft = structuredClone(snapshot);
  const result = applyCommandBody(draft, command, runtime);
  draft.version += 1;
  draft.updatedAt = runtime.now;
  draft.auditEvents.push({
    id: runtime.createId(),
    sequence: draft.auditEvents.length + 1,
    actor,
    action: command.type,
    targetType: result.targetType,
    targetId: result.targetId,
    outcome: 'success',
    summary: result.summary,
    createdAt: runtime.now,
  });
  return draft;
}

export interface AdminSnapshotSummary {
  activeUsers: number;
  publishedContents: number;
  openDeliveryItems: number;
  openFeedbackCases: number;
  pendingJobs: number;
  failedJobs: number;
  usedUnits: number;
  availableBalanceMinor: number;
  unsettledCommercialRecords: number;
  enabledFeatureFlags: number;
}

export function summarizeAdminSnapshot(
  snapshot: AdminSnapshot,
): AdminSnapshotSummary {
  return {
    activeUsers: snapshot.users.filter((user) => user.status === 'active')
      .length,
    publishedContents: snapshot.contents.filter(
      (content) => content.status === 'published',
    ).length,
    openDeliveryItems: snapshot.deliveryItems.filter(
      (item) =>
        item.status !== 'completed' && item.status !== 'archived',
    ).length,
    openFeedbackCases: snapshot.feedbackCases.filter(
      (item) => item.status === 'open' || item.status === 'in_review',
    ).length,
    pendingJobs: snapshot.jobs.filter((job) =>
      ['queued', 'running', 'waiting_for_review'].includes(job.status),
    ).length,
    failedJobs: snapshot.jobs.filter(
      (job) =>
        job.status === 'failed' || job.status === 'quota_exhausted',
    ).length,
    usedUnits: snapshot.usageAccounts.reduce(
      (total, account) => total + account.usedUnits,
      0,
    ),
    availableBalanceMinor: snapshot.usageAccounts.reduce(
      (total, account) => total + account.balanceMinor,
      0,
    ),
    unsettledCommercialRecords: snapshot.commercialRecords.filter(
      (record) => record.status === 'pending' || record.status === 'failed',
    ).length,
    enabledFeatureFlags: snapshot.featureFlags.filter((flag) => flag.enabled)
      .length,
  };
}

export function isAdminSnapshot(value: unknown): value is AdminSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<AdminSnapshot>;
  return (
    candidate.schemaVersion === 1 &&
    isPositiveInteger(candidate.version) &&
    isTimestamp(candidate.updatedAt) &&
    isArrayOf(candidate.users, isAdminUser) &&
    isArrayOf(candidate.contents, isContentRecord) &&
    isArrayOf(candidate.deliveryItems, isDeliveryItem) &&
    isArrayOf(candidate.feedbackCases, isFeedbackCase) &&
    isArrayOf(candidate.jobs, isOperationJob) &&
    isArrayOf(candidate.usageAccounts, isUsageAccount) &&
    isArrayOf(candidate.usageLedger, isUsageLedgerEntry) &&
    isArrayOf(candidate.commercialRecords, isCommercialRecord) &&
    isArrayOf(candidate.featureFlags, isFeatureFlag) &&
    isArrayOf(candidate.auditEvents, isAuditEvent) &&
    candidate.auditEvents.every(
      (event, index) => event.sequence === index + 1,
    )
  );
}

const ADMIN_ROLES = new Set<AdminRole>([
  'owner',
  'administrator',
  'operator',
  'content',
  'support',
  'finance',
  'auditor',
  'mentor',
  'member',
]);
const CONTENT_KINDS = new Set<ContentKind>([
  'course',
  'lesson',
  'class',
  'template',
]);
const CONTENT_STATUSES = new Set<ContentStatus>([
  'draft',
  'published',
  'archived',
]);
const DELIVERY_KINDS = new Set<DeliveryKind>([
  'project',
  'assignment',
  'submission',
]);
const DELIVERY_STATUSES = new Set<DeliveryStatus>([
  'active',
  'submitted',
  'reviewing',
  'needs_revision',
  'completed',
  'archived',
]);
const FEEDBACK_KINDS = new Set<FeedbackKind>([
  'feedback',
  'appeal',
  'support_ticket',
]);
const FEEDBACK_STATUSES = new Set<FeedbackStatus>([
  'open',
  'in_review',
  'resolved',
  'rejected',
]);
const JOB_KINDS = new Set<JobKind>([
  'ai',
  'file_parse',
  'export',
  'notification',
]);
const JOB_STATUSES = new Set<JobStatus>([
  'queued',
  'running',
  'waiting_for_review',
  'completed',
  'failed',
  'cancelled',
  'quota_exhausted',
  'stale',
]);
const COMMERCIAL_KINDS = new Set<CommercialKind>([
  'order',
  'refund',
  'subscription',
]);
const COMMERCIAL_STATUSES = new Set<CommercialStatus>([
  'pending',
  'paid',
  'failed',
  'refunded',
  'cancelled',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isString(value) && Number.isFinite(Date.parse(value));
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isArrayOf<T>(
  value: unknown,
  predicate: (entry: unknown) => entry is T,
): value is T[] {
  return Array.isArray(value) && value.every(predicate);
}

function isVersionedRecord(
  value: unknown,
): value is VersionedRecord & Record<string, unknown> {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isPositiveInteger(value.version) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
}

function isEnumMember<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
): value is T {
  return isString(value) && allowed.has(value as T);
}

function isAdminUser(value: unknown): value is AdminUser {
  return (
    isVersionedRecord(value) &&
    isNonEmptyString(value.displayName) &&
    isNonEmptyString(value.email) &&
    isArrayOf(
      value.roles,
      (role): role is AdminRole => isEnumMember(role, ADMIN_ROLES),
    ) &&
    value.roles.length > 0 &&
    (value.status === 'active' || value.status === 'suspended')
  );
}

function isContentRecord(value: unknown): value is ContentRecord {
  return (
    isVersionedRecord(value) &&
    isEnumMember(value.kind, CONTENT_KINDS) &&
    isNonEmptyString(value.title) &&
    isEnumMember(value.status, CONTENT_STATUSES) &&
    (value.publishedAt === undefined || isTimestamp(value.publishedAt))
  );
}

function isDeliveryItem(value: unknown): value is DeliveryItem {
  return (
    isVersionedRecord(value) &&
    isEnumMember(value.kind, DELIVERY_KINDS) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.ownerLabel) &&
    isEnumMember(value.status, DELIVERY_STATUSES)
  );
}

function isFeedbackCase(value: unknown): value is FeedbackCase {
  return (
    isVersionedRecord(value) &&
    isEnumMember(value.kind, FEEDBACK_KINDS) &&
    isNonEmptyString(value.subject) &&
    isNonEmptyString(value.requester) &&
    isNonEmptyString(value.detail) &&
    isEnumMember(value.status, FEEDBACK_STATUSES) &&
    (value.resolution === undefined || isNonEmptyString(value.resolution))
  );
}

function isOperationJob(value: unknown): value is OperationJob {
  return (
    isVersionedRecord(value) &&
    isEnumMember(value.kind, JOB_KINDS) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.workspaceId) &&
    isEnumMember(value.status, JOB_STATUSES) &&
    isNonNegativeNumber(value.attempts) &&
    Number.isSafeInteger(value.attempts) &&
    isNonNegativeNumber(value.estimatedCostMinor) &&
    isNonNegativeNumber(value.safetyMarginMinor) &&
    (value.errorCode === undefined || isNonEmptyString(value.errorCode)) &&
    (value.errorMessage === undefined || isNonEmptyString(value.errorMessage))
  );
}

function isUsageAccount(value: unknown): value is UsageAccount {
  return (
    isVersionedRecord(value) &&
    isNonEmptyString(value.workspaceId) &&
    isNonEmptyString(value.workspaceName) &&
    isNonEmptyString(value.period) &&
    isNonNegativeNumber(value.quotaUnits) &&
    isNonNegativeNumber(value.usedUnits) &&
    isNonNegativeNumber(value.reservedUnits) &&
    value.usedUnits + value.reservedUnits <= value.quotaUnits &&
    isNonNegativeNumber(value.balanceMinor) &&
    (value.currency === 'CNY' || value.currency === 'USD')
  );
}

function isUsageLedgerEntry(value: unknown): value is UsageLedgerEntry {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.workspaceId) &&
    ['credit', 'debit', 'reserve', 'release'].includes(
      typeof value.direction === 'string' ? value.direction : '',
    ) &&
    isNonNegativeNumber(value.amountMinor) &&
    isNonNegativeNumber(value.units) &&
    isNonEmptyString(value.description) &&
    isTimestamp(value.createdAt)
  );
}

function isCommercialRecord(value: unknown): value is CommercialRecord {
  return (
    isVersionedRecord(value) &&
    isEnumMember(value.kind, COMMERCIAL_KINDS) &&
    isNonEmptyString(value.reference) &&
    isNonEmptyString(value.workspaceId) &&
    isEnumMember(value.status, COMMERCIAL_STATUSES) &&
    isNonNegativeNumber(value.amountMinor) &&
    (value.currency === 'CNY' || value.currency === 'USD') &&
    isNonEmptyString(value.note)
  );
}

function isFeatureFlag(value: unknown): value is FeatureFlag {
  return (
    isVersionedRecord(value) &&
    isNonEmptyString(value.key) &&
    typeof value.enabled === 'boolean' &&
    isNonEmptyString(value.scope) &&
    isNonEmptyString(value.reason)
  );
}

function isAuditEvent(value: unknown): value is AuditEvent {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isPositiveInteger(value.sequence) &&
    isNonEmptyString(value.actor) &&
    isNonEmptyString(value.action) &&
    isNonEmptyString(value.targetType) &&
    isNonEmptyString(value.targetId) &&
    value.outcome === 'success' &&
    isNonEmptyString(value.summary) &&
    isTimestamp(value.createdAt)
  );
}

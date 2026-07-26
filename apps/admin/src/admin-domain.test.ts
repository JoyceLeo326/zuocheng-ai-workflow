import { describe, expect, it } from 'vitest';
import {
  AdminConflictError,
  AdminConfirmationError,
  AdminQuotaError,
  applyAdminCommand,
  createEmptyAdminSnapshot,
  isAdminSnapshot,
  summarizeAdminSnapshot,
  type AdminCommand,
} from './admin-domain.js';

const now = '2026-07-27T08:00:00.000Z';

function execute(
  command: AdminCommand,
  snapshot = createEmptyAdminSnapshot(now),
) {
  return applyAdminCommand(snapshot, command, {
    now,
    createId: () => crypto.randomUUID(),
  });
}

describe('admin domain', () => {
  it('starts with an honest empty snapshot', () => {
    const snapshot = createEmptyAdminSnapshot(now);

    expect(snapshot.version).toBe(1);
    expect(snapshot.users).toEqual([]);
    expect(snapshot.contents).toEqual([]);
    expect(snapshot.deliveryItems).toEqual([]);
    expect(snapshot.feedbackCases).toEqual([]);
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.usageAccounts).toEqual([]);
    expect(snapshot.commercialRecords).toEqual([]);
    expect(snapshot.featureFlags).toEqual([]);
    expect(snapshot.auditEvents).toEqual([]);
  });

  it('records every successful write in an immutable audit event', () => {
    const result = execute({
      type: 'user.create',
      expectedVersion: 1,
      actor: '本地管理员',
      payload: {
        displayName: '张同学',
        email: 'student@example.edu',
        roles: ['member'],
      },
    });

    expect(result.users).toHaveLength(1);
    expect(result.version).toBe(2);
    expect(result.auditEvents).toHaveLength(1);
    expect(result.auditEvents[0]).toMatchObject({
      actor: '本地管理员',
      action: 'user.create',
      targetType: 'user',
      targetId: result.users[0]?.id,
      outcome: 'success',
    });
  });

  it('rejects stale writes before changing state', () => {
    expect(() =>
      execute({
        type: 'content.create',
        expectedVersion: 4,
        actor: '管理员',
        payload: {
          kind: 'course',
          title: '证据驱动表达',
        },
      }),
    ).toThrow(AdminConflictError);
  });

  it('requires an exact confirmation phrase for dangerous actions', () => {
    const created = execute({
      type: 'user.create',
      expectedVersion: 1,
      actor: '管理员',
      payload: {
        displayName: '李同学',
        email: 'li@example.edu',
        roles: ['member'],
      },
    });
    const userId = created.users[0]?.id ?? '';

    expect(() =>
      execute(
        {
          type: 'user.suspend',
          expectedVersion: 2,
          actor: '管理员',
          payload: { userId, confirmation: '确认' },
        },
        created,
      ),
    ).toThrow(AdminConfirmationError);
  });

  it('blocks a paid task unless available balance covers estimate and safety margin', () => {
    const withAccount = execute({
      type: 'usage.account.upsert',
      expectedVersion: 1,
      actor: '财务管理员',
      payload: {
        workspaceId: 'workspace-1',
        workspaceName: '课程一班',
        period: '2026-07',
        quotaUnits: 100,
        usedUnits: 30,
        reservedUnits: 10,
        balanceMinor: 500,
        currency: 'CNY',
      },
    });

    expect(() =>
      execute(
        {
          type: 'job.create',
          expectedVersion: 2,
          actor: '运营管理员',
          payload: {
            kind: 'ai',
            title: '生成课程反馈',
            workspaceId: 'workspace-1',
            estimatedCostMinor: 450,
            safetyMarginMinor: 100,
          },
        },
        withAccount,
      ),
    ).toThrow(AdminQuotaError);
  });

  it('reserves prepaid balance atomically so queued tasks cannot overspend', () => {
    const withAccount = execute({
      type: 'usage.account.upsert',
      expectedVersion: 1,
      actor: '财务管理员',
      payload: {
        workspaceId: 'workspace-1',
        workspaceName: '课程一班',
        period: '2026-07',
        quotaUnits: 100,
        usedUnits: 0,
        reservedUnits: 0,
        balanceMinor: 500,
        currency: 'CNY',
      },
    });
    const withReservation = execute(
      {
        type: 'job.create',
        expectedVersion: 2,
        actor: '运营管理员',
        payload: {
          kind: 'export',
          title: '正式导出一',
          workspaceId: 'workspace-1',
          estimatedCostMinor: 350,
          safetyMarginMinor: 100,
        },
      },
      withAccount,
    );

    expect(withReservation.usageAccounts[0]?.balanceMinor).toBe(50);
    expect(withReservation.usageLedger[0]).toMatchObject({
      direction: 'reserve',
      amountMinor: 450,
      description: '任务预留：正式导出一',
    });
    expect(() =>
      execute(
        {
          type: 'job.create',
          expectedVersion: 3,
          actor: '运营管理员',
          payload: {
            kind: 'export',
            title: '正式导出二',
            workspaceId: 'workspace-1',
            estimatedCostMinor: 350,
            safetyMarginMinor: 100,
          },
        },
        withReservation,
      ),
    ).toThrow(AdminQuotaError);
  });

  it('requires confirmation before creating an enabled feature flag', () => {
    expect(() =>
      execute({
        type: 'feature-flag.upsert',
        expectedVersion: 1,
        actor: '平台管理员',
        payload: {
          key: 'course-review',
          enabled: true,
          scope: 'local-admin',
          reason: '启用人工复核流程',
        },
      }),
    ).toThrow(AdminConfirmationError);
  });

  it('summarizes only persisted records and never injects funnel data', () => {
    const snapshot = execute({
      type: 'feedback.create',
      expectedVersion: 1,
      actor: '客服管理员',
      payload: {
        kind: 'appeal',
        subject: '作业复核申请',
        requester: '匿名申请人',
        detail: '请求复核评分依据。',
      },
    });

    expect(summarizeAdminSnapshot(snapshot)).toEqual({
      activeUsers: 0,
      publishedContents: 0,
      openDeliveryItems: 0,
      openFeedbackCases: 1,
      pendingJobs: 0,
      failedJobs: 0,
      usedUnits: 0,
      availableBalanceMinor: 0,
      unsettledCommercialRecords: 0,
      enabledFeatureFlags: 0,
    });
  });

  it('rejects structurally incomplete imported records', () => {
    const snapshot = createEmptyAdminSnapshot(now);

    expect(
      isAdminSnapshot({
        ...snapshot,
        users: [{ id: 'forged-record' }],
      }),
    ).toBe(false);
  });

  it('persists the complete operational lifecycle with one audit per write', () => {
    let snapshot = createEmptyAdminSnapshot(now);
    const run = (command: Omit<AdminCommand, 'expectedVersion'>) => {
      snapshot = applyAdminCommand(
        snapshot,
        { ...command, expectedVersion: snapshot.version } as AdminCommand,
        {
          now,
          createId: () => crypto.randomUUID(),
        },
      );
    };

    run({
      type: 'content.create',
      actor: '内容管理员',
      payload: { kind: 'course', title: '真实课程' },
    });
    run({
      type: 'content.transition',
      actor: '内容管理员',
      payload: {
        contentId: snapshot.contents[0]?.id ?? '',
        status: 'published',
        confirmation: '发布 真实课程',
      },
    });
    run({
      type: 'delivery.create',
      actor: '运营管理员',
      payload: {
        kind: 'assignment',
        title: '第一课作业',
        ownerLabel: '课程一班',
      },
    });
    run({
      type: 'delivery.transition',
      actor: '运营管理员',
      payload: {
        deliveryId: snapshot.deliveryItems[0]?.id ?? '',
        status: 'reviewing',
      },
    });
    run({
      type: 'feedback.create',
      actor: '客服管理员',
      payload: {
        kind: 'support_ticket',
        subject: '导出失败',
        requester: '用户 A',
        detail: '用户报告导出没有完成。',
      },
    });
    run({
      type: 'feedback.transition',
      actor: '客服管理员',
      payload: {
        feedbackId: snapshot.feedbackCases[0]?.id ?? '',
        status: 'resolved',
        resolution: '核验后重新导出成功。',
      },
    });
    run({
      type: 'usage.account.upsert',
      actor: '财务管理员',
      payload: {
        workspaceId: 'workspace-actual',
        workspaceName: '真实 Workspace',
        period: '2026-07',
        quotaUnits: 100,
        usedUnits: 0,
        reservedUnits: 0,
        balanceMinor: 1_000,
        currency: 'CNY',
      },
    });
    run({
      type: 'usage.ledger.record',
      actor: '财务管理员',
      payload: {
        workspaceId: 'workspace-actual',
        direction: 'debit',
        amountMinor: 100,
        units: 2,
        description: '真实任务扣减',
        confirmation: '记账 真实 Workspace',
      },
    });
    run({
      type: 'job.create',
      actor: '运营管理员',
      payload: {
        kind: 'export',
        title: '正式导出',
        workspaceId: 'workspace-actual',
        estimatedCostMinor: 100,
        safetyMarginMinor: 50,
      },
    });
    run({
      type: 'job.transition',
      actor: '运营管理员',
      payload: {
        jobId: snapshot.jobs[0]?.id ?? '',
        status: 'failed',
        errorCode: 'EXPORT_FAILED',
        errorMessage: '导出器返回失败。',
      },
    });
    run({
      type: 'job.transition',
      actor: '运营管理员',
      payload: {
        jobId: snapshot.jobs[0]?.id ?? '',
        status: 'queued',
        confirmation: '重试 正式导出',
      },
    });
    run({
      type: 'commercial.record',
      actor: '财务管理员',
      payload: {
        kind: 'order',
        reference: 'ORDER-20260727-1',
        workspaceId: 'workspace-actual',
        status: 'paid',
        amountMinor: 1_000,
        currency: 'CNY',
        note: '支付提供方已确认。',
        confirmation: '记录 ORDER-20260727-1',
      },
    });
    run({
      type: 'feature-flag.upsert',
      actor: '平台管理员',
      payload: {
        key: 'course-review',
        enabled: false,
        scope: 'workspace-actual',
        reason: '准备评审功能。',
      },
    });
    run({
      type: 'feature-flag.upsert',
      actor: '平台管理员',
      payload: {
        key: 'course-review',
        enabled: true,
        scope: 'workspace-actual',
        reason: '评审流程已完成验收。',
        confirmation: '切换 course-review',
      },
    });

    expect(snapshot.contents[0]?.status).toBe('published');
    expect(snapshot.deliveryItems[0]?.status).toBe('reviewing');
    expect(snapshot.feedbackCases[0]?.status).toBe('resolved');
    expect(snapshot.usageLedger).toHaveLength(2);
    expect(snapshot.usageLedger[1]?.direction).toBe('reserve');
    expect(snapshot.jobs[0]).toMatchObject({ status: 'queued', attempts: 1 });
    expect(snapshot.commercialRecords).toHaveLength(1);
    expect(snapshot.featureFlags[0]?.enabled).toBe(true);
    expect(snapshot.auditEvents).toHaveLength(snapshot.version - 1);
  });
});

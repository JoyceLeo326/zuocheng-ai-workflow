/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SyncCenterView } from './sync-center.js';

const styles = readFileSync(
  new URL('./sync-center.css', import.meta.url),
  'utf8',
);

const callbacks = {
  onConnect: vi.fn(async () => undefined),
  onDisconnect: vi.fn(),
  onRefresh: vi.fn(async () => undefined),
  onPush: vi.fn(async () => undefined),
  onPull: vi.fn(async () => undefined),
  onOverwriteRemote: vi.fn(async () => undefined),
  onOverwriteLocal: vi.fn(async () => undefined),
  onFlushOutbox: vi.fn(async () => undefined),
  onDeleteRemote: vi.fn(async () => undefined),
  onCancel: vi.fn(),
};

describe('SyncCenterView', () => {
  it('renders connection, project, passphrase and empty remote controls without internal policy copy', () => {
    const html = renderToStaticMarkup(
      <SyncCenterView
        {...callbacks}
        auditEvents={[]}
        busyAction={null}
        connected={false}
        error={null}
        localProjects={[
          {
            id: '01900000-0000-7000-8000-000000000901',
            title: '课程汇报',
            version: 2,
            updatedAt: '2026-07-27T10:00:00.000Z',
          },
        ]}
        online
        outboxCount={0}
        remoteProjects={[]}
      />,
    );

    expect(html).toContain('同步项目');
    expect(html).toContain('连接 GitHub');
    expect(html).toContain('type="password"');
    expect(html).toContain('访问令牌');
    expect(html).toContain('同步口令');
    expect(html).toContain('课程汇报');
    expect(html).toContain('还没有远端项目');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toMatch(
      /零成本|固定成本|架构|无需登录|本地优先|演示|Demo|MVP/iu,
    );
  });

  it('renders offline, pending, conflict, outbox, cancellation, audit and two-step deletion states', () => {
    const html = renderToStaticMarkup(
      <SyncCenterView
        {...callbacks}
        auditEvents={[
          {
            id: 'audit-001',
            at: '2026-07-27T11:00:00.000Z',
            action: 'push',
            outcome: 'conflict',
            projectId: '01900000-0000-7000-8000-000000000901',
            gistId: 'gist-001',
            summary: '远端内容已变化，等待选择保留版本。',
          },
        ]}
        busyAction="pull"
        connected
        conflict={{
          kind: 'both_changed',
          projectId: '01900000-0000-7000-8000-000000000901',
          localVersion: 2,
          localUpdatedAt: '2026-07-27T10:00:00.000Z',
          remoteVersion: 3,
          remoteUpdatedAt: '2026-07-27T10:30:00.000Z',
          remoteRevision: 'revision-003',
          gistId: 'gist-001',
        }}
        error={null}
        localProjects={[
          {
            id: '01900000-0000-7000-8000-000000000901',
            title: '课程汇报',
            version: 2,
            updatedAt: '2026-07-27T10:00:00.000Z',
          },
        ]}
        online={false}
        outboxCount={2}
        remoteProjects={[
          {
            gistId: 'gist-001',
            etag: '"etag"',
            revision: 'revision-003',
            projectId: '01900000-0000-7000-8000-000000000901',
            projectVersion: 3,
            projectUpdatedAt: '2026-07-27T10:30:00.000Z',
            encryptedAt: '2026-07-27T10:31:00.000Z',
            encryptedBytes: 2048,
            lastModifiedAt: '2026-07-27T10:31:00.000Z',
          },
        ]}
      />,
    );

    expect(html).toContain('当前离线');
    expect(html).toContain('待同步 2 项');
    expect(html).toContain('正在拉取');
    expect(html).toContain('取消');
    expect(html).toContain('发现版本冲突');
    expect(html).toContain('保留此设备版本');
    expect(html).toContain('使用远端版本');
    expect(html).toContain('确认删除远端副本');
    expect(html).toContain('删除远端项目');
    expect(html).toContain('同步记录');
    expect(html).toContain('远端内容已变化');
    expect(html).toContain('role="alert"');
  });

  it('ships focus, narrow-screen, reduced-motion and forced-color treatment', () => {
    expect(styles).toContain(':focus-visible');
    expect(styles).toMatch(/@media\s+\(max-width:\s*48rem\)/u);
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('@media (forced-colors: active)');
    expect(styles).toContain('CanvasText');
    expect(styles).toContain('ButtonText');
  });
});

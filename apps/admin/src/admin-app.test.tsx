import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AdminWorkspace } from './admin-app.js';
import { createEmptyAdminSnapshot } from './admin-domain.js';

describe('admin workspace', () => {
  it('renders every operational area with actionable empty states', () => {
    const html = renderToStaticMarkup(
      <AdminWorkspace
        actor=""
        connectivity="online"
        notice={null}
        pending={false}
        readOnly={false}
        repositoryMode="local"
        services={[
          {
            id: 'network',
            label: '网络连接',
            status: 'healthy',
            detail: '浏览器报告网络可用。',
            observedAt: '2026-07-27T08:00:00.000Z',
          },
        ]}
        snapshot={createEmptyAdminSnapshot('2026-07-27T08:00:00.000Z')}
        activeSection="overview"
        onActorChange={() => undefined}
        onCommand={() => undefined}
        onExport={() => undefined}
        onImport={() => undefined}
        onReload={() => undefined}
        onSectionChange={() => undefined}
      />,
    );

    expect(html).toContain('用户与权限');
    expect(html).toContain('课程与内容');
    expect(html).toContain('项目与作业');
    expect(html).toContain('反馈与申诉');
    expect(html).toContain('任务与导出');
    expect(html).toContain('用量与限额');
    expect(html).toContain('订单与余额');
    expect(html).toContain('功能开关');
    expect(html).toContain('审计日志');
    expect(html).toContain('还没有运营记录');
    expect(html).not.toContain('ZC-01');
    expect(html).not.toContain('演示用户');
  });
});

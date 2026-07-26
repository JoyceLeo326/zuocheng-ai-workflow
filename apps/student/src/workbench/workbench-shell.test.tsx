import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkbenchShell,
  missingTaskFields,
  studentSurfaceForPath,
  type WorkbenchDraft,
} from './workbench-shell.js';

describe('WB-01 student workbench entry', () => {
  it('routes the product root to the workbench and explicit account paths to identity', () => {
    expect(studentSurfaceForPath('/')).toBe('workbench');
    expect(studentSurfaceForPath('/projects/new')).toBe('workbench');
    expect(studentSurfaceForPath('/account')).toBe('identity');
    expect(studentSurfaceForPath('/account/security')).toBe('identity');
    expect(studentSurfaceForPath('/auth')).toBe('identity');
    expect(studentSurfaceForPath('/auth/recovery')).toBe('identity');
    expect(studentSurfaceForPath('/accounting')).toBe('workbench');
    expect(studentSurfaceForPath('/author')).toBe('workbench');
  });

  it('renders the six-stage core workflow in product order', () => {
    const html = renderToStaticMarkup(
      <WorkbenchShell onLogin={vi.fn()} onRegister={vi.fn()} />,
    );
    const labels = [
      '定义任务',
      '材料解析',
      '选择证据',
      '组织结构',
      '编辑核验',
      '正式导出',
    ];

    expect(html).toContain('做成');
    expect(html).toContain('任务工作台');
    expect(html).toContain('aria-label="任务工作流"');
    for (const label of labels) {
      expect(html).toContain(label);
    }
    for (let index = 1; index < labels.length; index += 1) {
      expect(html.indexOf(labels[index - 1] ?? '')).toBeLessThan(
        html.indexOf(labels[index] ?? ''),
      );
    }
    expect(html).toContain('aria-current="step"');
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(6);
    expect(html).toContain('需先完成任务定义与材料处理');
    expect(html).not.toContain('导出成功');
  });

  it('renders a complete editable task definition and a real material file input', () => {
    const html = renderToStaticMarkup(
      <WorkbenchShell onLogin={vi.fn()} onRegister={vi.fn()} />,
    );

    for (const field of [
      '任务名称',
      '听众',
      '截止时间',
      '页面或字数',
      '演讲时长',
      '输出格式',
      '评分标准',
      '语气',
      '必须包含',
      '禁止包含',
    ]) {
      expect(html).toContain(field);
    }
    expect(html).toContain('type="file"');
    expect(html).toContain('multiple=""');
    expect(html).toContain('accept=".pdf,.docx,.pptx,.txt,.md,image/*"');
    expect(html).toContain('尚未添加材料');
    expect(html).toContain('待解析');
    expect(html).toContain('还缺少必填信息');
    expect(html).toContain(
      '请补充：任务名称、听众、截止时间、页面或字数、输出格式、评分标准、任务材料。',
    );
  });

  it('keeps authentication out of the default DOM and exposes only standard header actions', () => {
    const html = renderToStaticMarkup(
      <WorkbenchShell onLogin={vi.fn()} onRegister={vi.fn()} />,
    );

    expect(html).toContain('>登录</button>');
    expect(html).toContain('>注册</button>');
    expect(html).not.toContain('邮箱或用户名');
    expect(html).not.toContain('设置密码');
    expect(html).not.toContain('使用 Passkey');
  });

  it('opens save only when the deliverable and at least one traceable source are ready', () => {
    const completeDraft: WorkbenchDraft = {
      taskName: '人工智能课程期末汇报',
      audience: '课程老师与同学',
      deadline: '2026-08-15T17:30',
      scope: '3 页',
      durationMinutes: '6',
      outputFormat: 'presentation',
      tone: 'academic',
      rubric: '论证与证据 100%',
      requiredContent: '核心结论',
      forbiddenContent: '无来源数字',
    };

    expect(missingTaskFields(completeDraft, 1)).toEqual([]);
    expect(
      missingTaskFields(
        { ...completeDraft, scope: '', rubric: '   ' },
        0,
      ),
    ).toEqual(['页面或字数', '评分标准', '任务材料']);
  });
});

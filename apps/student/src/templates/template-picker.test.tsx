/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PROJECT_TEMPLATES } from './project-template.js';
import {
  ProjectTemplatePicker,
  templatePickerNextIndex,
} from './template-picker.js';

const pickerStyles = readFileSync(
  new URL('./templates.css', import.meta.url),
  'utf8',
);

describe('ProjectTemplatePicker', () => {
  it('renders search, filters, seven choices, a useful preview and explicit confirmation', () => {
    const html = renderToStaticMarkup(
      <ProjectTemplatePicker onConfirm={vi.fn()} />,
    );

    expect(html).toContain('选择一个项目模板');
    expect(html).toContain('type="search"');
    expect(html).toContain('aria-label="搜索项目模板"');
    expect(html).toContain('aria-label="筛选项目模板"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-label="项目模板"');
    expect(html.match(/role="option"/gu)).toHaveLength(7);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('验收清单');
    expect(html).toContain('建议结构');
    expect(html).toContain('使用“课堂汇报”');
    expect(html).toContain('需要你补充');
    expect(html).toContain('具体主题');
    expect(html).toContain('截止时间');
    expect(html).toContain('任务材料');
    expect(html).not.toMatch(/零成本|本地优先|真实性审计|Demo|MVP/u);
  });

  it('supports initial selection and category without hiding preview details', () => {
    const html = renderToStaticMarkup(
      <ProjectTemplatePicker
        initialCategory="career"
        initialTemplateId="job-showcase"
        onConfirm={vi.fn()}
      />,
    );

    expect(html).toContain('求职展示');
    expect(html).toContain('项目背景与职责边界');
    expect(html).toContain('投递岗位与目标受众');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('使用“求职展示”');
  });

  it('uses looping arrow navigation plus Home and End for the visible choices', () => {
    const count = PROJECT_TEMPLATES.length;

    expect(templatePickerNextIndex(0, 'ArrowRight', count)).toBe(1);
    expect(templatePickerNextIndex(0, 'ArrowDown', count)).toBe(1);
    expect(templatePickerNextIndex(0, 'ArrowLeft', count)).toBe(count - 1);
    expect(templatePickerNextIndex(0, 'ArrowUp', count)).toBe(count - 1);
    expect(templatePickerNextIndex(3, 'Home', count)).toBe(0);
    expect(templatePickerNextIndex(3, 'End', count)).toBe(count - 1);
    expect(templatePickerNextIndex(3, 'Enter', count)).toBeNull();
    expect(templatePickerNextIndex(0, 'ArrowRight', 0)).toBeNull();
  });

  it('ships focus, narrow-screen, reduced-motion and forced-color behavior', () => {
    expect(pickerStyles).toContain(':focus-visible');
    expect(pickerStyles).toMatch(/@media\s+\(max-width:\s*48rem\)/u);
    expect(pickerStyles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(pickerStyles).toContain('@media (forced-colors: active)');
  });
});

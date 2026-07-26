/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkflowAssistantPanel,
  type WorkflowAssistantPanelProps,
} from './workflow-assistant-panel.js';

const styles = readFileSync(
  new URL('./workflow-assistant-panel.css', import.meta.url),
  'utf8',
);

function props(
  overrides: Partial<WorkflowAssistantPanelProps> = {},
): WorkflowAssistantPanelProps {
  return {
    disabled: false,
    sessions: [],
    selectedWorkflow: 'evidence',
    onWorkflowChange: vi.fn(),
    onGenerate: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onApply: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

describe('WorkflowAssistantPanel', () => {
  it('shows three focused workflows without internal implementation language', () => {
    const html = renderToStaticMarkup(<WorkflowAssistantPanel {...props()} />);
    expect(html).toContain('工作流 AI 助手');
    expect(html).toContain('证据建议');
    expect(html).toContain('大纲方案');
    expect(html).toContain('三页草稿');
    expect(html).toContain('生成候选');
    expect(html).toContain('AI 只会提交候选，确认后才写入项目。');
    expect(html).not.toMatch(/Demo|MVP|零成本|本地优先|内部架构/i);
    expect(styles).toMatch(/:focus-visible/);
    expect(styles).toMatch(/prefers-reduced-motion/);
  });

  it('renders review, partial, quota and retry states with explicit actions', () => {
    const html = renderToStaticMarkup(
      <WorkflowAssistantPanel
        {...props({
          sessions: [
            {
              id: 'review',
              workflow: 'outline',
              status: 'waiting_for_review',
              title: '2 个大纲方案待确认',
              detail: '所有结论均已关联项目证据。',
              completeness: 'complete',
              appliedCount: 0,
              totalCount: 2,
            },
            {
              id: 'partial',
              workflow: 'draft',
              status: 'waiting_for_review',
              title: '草稿写入未完成',
              detail: '已写入 1/3 页，可继续完成。',
              completeness: 'partial',
              appliedCount: 1,
              totalCount: 3,
            },
            {
              id: 'quota',
              workflow: 'evidence',
              status: 'quota_exhausted',
              title: '本次调用未完成',
              detail: '模型服务暂时无法继续。',
              completeness: null,
              appliedCount: 0,
              totalCount: 0,
            },
          ],
        })}
      />,
    );
    expect(html).toContain('审核候选');
    expect(html).toContain('继续写入');
    expect(html).toContain('重试');
    expect(html).toContain('已写入 1/3');
    expect(html).toContain('aria-live="polite"');
  });
});

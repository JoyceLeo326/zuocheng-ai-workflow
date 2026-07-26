/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MemoryProductEventLedger } from './event-ledger.js';
import { ActivityPrivacyPanel } from './activity-privacy-panel.js';

const styles = readFileSync(
  new URL('./activity-privacy-panel.css', import.meta.url),
  'utf8',
);

describe('ActivityPrivacyPanel', () => {
  it('renders a concise privacy explanation and real management actions', () => {
    const html = renderToStaticMarkup(
      <ActivityPrivacyPanel ledger={new MemoryProductEventLedger()} />,
    );

    expect(html).toContain('活动记录与隐私');
    expect(html).toContain('任务正文');
    expect(html).toContain('文件内容');
    expect(html).toContain('模型密钥');
    expect(html).toContain('导出 JSON');
    expect(html).toContain('接收地址');
    expect(html).toContain('发送待同步记录');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toMatch(/零成本|真实性审计|Demo|MVP/u);
  });

  it('ships focus, narrow-screen, reduced-motion and forced-color rules', () => {
    expect(styles).toContain(':focus-visible');
    expect(styles).toMatch(/@media\s+\(max-width:\s*42rem\)/u);
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('@media (forced-colors: active)');
  });
});

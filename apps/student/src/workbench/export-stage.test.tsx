import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  DeliverableExportInput,
  DeliverableExportResult,
  DeliverableKind,
} from './deliverable-export.js';
import {
  DeliverableExportError,
  DELIVERABLE_KINDS,
} from './deliverable-export.js';
import {
  createDraftPage,
  type DraftPage,
  type DraftVerificationCheck,
} from './draft-verification.js';
import type { Project } from './project-model.js';
import {
  DeliverableExportCard,
  DownloadUrlRegistry,
  ExportStage,
  executeDeliverableExport,
  getDeliverableGate,
  type DeliverableExporter,
  type ExportEntryState,
} from './export-stage.js';

const EXPORTED_AT = '2026-07-27T06:30:00.000Z';

function project(): Project {
  return {
    schemaVersion: 1,
    id: 'project-1',
    version: 1,
    createdAt: EXPORTED_AT,
    updatedAt: EXPORTED_AT,
    title: '课程成果汇报',
    status: 'active',
    taskDefinition: {
      id: 'task-1',
      version: 1,
      createdAt: EXPORTED_AT,
      updatedAt: EXPORTED_AT,
      taskName: '课程成果汇报',
      audience: '课程教师',
      dueAt: '2026-08-01T09:00:00.000Z',
      lengthTarget: { unit: 'pages', value: 1 },
      presentationDurationMinutes: 1,
      outputFormats: ['pptx', 'pdf', 'docx'],
      rubric: [],
      tone: '清晰',
      mustInclude: [],
      mustAvoid: [],
    },
    sourceFiles: [],
    sourceChunks: [],
    evidenceCards: [],
    outlines: [],
    activeOutlineId: null,
    artifacts: [],
    verificationResults: [],
  };
}

function page(): DraftPage {
  return createDraftPage({
    id: 'page-1',
    title: '核心结论',
    conclusion: '课程参与度与完成质量同时改善。',
    body: '本页说明课程参与和任务完成情况。',
    evidenceCardIds: [],
    citations: [],
    visualNote: '使用简洁对比图。',
    speakerNotes: '先讲结论，再说明限制。',
    estimatedSeconds: 60,
    locked: true,
    rubricCriterionIds: [],
    claims: [],
  });
}

function check(
  outcome: DraftVerificationCheck['outcome'],
): DraftVerificationCheck {
  return {
    code: 'LENGTH_TARGET',
    rule: 'length_target',
    outcome,
    severity: outcome === 'fail' ? 'error' : 'info',
    message: outcome === 'fail' ? '篇幅不符合任务要求。' : '篇幅符合要求。',
    artifactPath: 'taskDefinition.lengthTarget',
    evidenceCardIds: [],
    fixHint: '调整页面数量后重新核验。',
  };
}

function result(
  kind: DeliverableKind,
  overrides: Partial<DeliverableExportResult> = {},
): DeliverableExportResult {
  return {
    kind,
    blob: new Blob(['hello']),
    fileName: `课程成果汇报.${kind}`,
    mimeType: 'application/octet-stream',
    sha256: 'a'.repeat(64),
    sizeBytes: 5,
    ...overrides,
  };
}

describe('export stage', () => {
  it('shows every real deliverable and a prominent complete-package action', () => {
    const html = renderToStaticMarkup(
      <ExportStage
        draftPages={[page()]}
        project={project()}
        verificationChecks={[check('pass')]}
      />,
    );

    expect(DELIVERABLE_KINDS).toHaveLength(10);
    expect(html).toContain('演示文稿 PPTX');
    expect(html).toContain('便携文档 PDF');
    expect(html).toContain('文档 DOCX');
    expect(html).toContain('Markdown 初稿');
    expect(html).toContain('讲稿');
    expect(html).toContain('来源索引');
    expect(html).toContain('任务卡');
    expect(html).toContain('核验记录');
    expect(html).toContain('Project JSON');
    expect(html).toContain('完整项目包');
    expect(html).toContain('aria-label="导出演示文稿 PPTX"');
    expect(html).toContain('aria-label="导出来源索引"');
    expect(html).toContain('>导出完整交付包</button>');
  });

  it('gates final deliverables truthfully while leaving independent records exportable', () => {
    for (const kind of [
      'pptx',
      'pdf',
      'docx',
      'markdown',
      'script',
      'project-package',
    ] as const) {
      expect(getDeliverableGate(kind, [], [check('pass')])).toEqual({
        allowed: false,
        reason: '尚无草稿页面，完成初稿后才能导出此项。',
      });
      expect(
        getDeliverableGate(kind, [page()], [check('fail')]),
      ).toEqual({
        allowed: false,
        reason: '核验仍有失败项，修复并重新核验后才能导出此项。',
      });
    }

    for (const kind of [
      'source-index',
      'task-card',
      'verification-report',
      'project-json',
    ] as const) {
      expect(getDeliverableGate(kind, [], [check('fail')])).toEqual({
        allowed: true,
        reason: null,
      });
    }

    const html = renderToStaticMarkup(
      <ExportStage
        draftPages={[]}
        project={project()}
        verificationChecks={[check('fail')]}
      />,
    );
    expect(html).toContain('当前没有草稿页面');
    expect(html).toContain('核验存在 1 个失败项');
    expect(html).toContain(
      '来源索引、任务卡、核验记录和 Project JSON 仍可独立导出。',
    );
  });

  it('awaits the injected exporter with the exact project snapshot and records real metadata', async () => {
    const expected = result('pptx');
    const exporter: DeliverableExporter = vi
      .fn()
      .mockResolvedValue(expected);
    const input: DeliverableExportInput = {
      kind: 'pptx',
      project: project(),
      draftPages: [page()],
      verificationChecks: [check('pass')],
      exportedAt: EXPORTED_AT,
    };

    await expect(
      executeDeliverableExport(exporter, input),
    ).resolves.toEqual({
      status: 'success',
      exportedAt: EXPORTED_AT,
      result: expected,
      error: null,
    });
    expect(exporter).toHaveBeenCalledOnce();
    expect(exporter).toHaveBeenCalledWith(input);
  });

  it('surfaces stable export errors without claiming success', async () => {
    const exporter = vi.fn(async () => {
      throw new DeliverableExportError('EMPTY_DRAFT');
    });
    const input: DeliverableExportInput = {
      kind: 'markdown',
      project: project(),
      draftPages: [],
      verificationChecks: [],
      exportedAt: EXPORTED_AT,
    };

    await expect(
      executeDeliverableExport(exporter, input),
    ).resolves.toEqual({
      status: 'error',
      exportedAt: EXPORTED_AT,
      result: null,
      error: '当前没有可导出的草稿页面。',
    });

    const errorState: ExportEntryState = {
      status: 'error',
      exportedAt: EXPORTED_AT,
      result: null,
      downloadUrl: null,
      error: '文件生成失败，请检查项目数据后重试。',
    };
    const html = renderToStaticMarkup(
      <DeliverableExportCard
        gate={{ allowed: true, reason: null }}
        kind="markdown"
        onExport={vi.fn()}
        state={errorState}
      />,
    );
    expect(html).toContain('导出失败');
    expect(html).toContain('文件生成失败，请检查项目数据后重试。');
    expect(html).not.toContain('下载文件');
  });

  it('renders real byte, time, digest, filename and Blob download metadata after success', () => {
    const successState: ExportEntryState = {
      status: 'success',
      exportedAt: EXPORTED_AT,
      result: result('pptx', {
        fileName: '课程成果汇报.pptx',
        sizeBytes: 5,
      }),
      downloadUrl: 'blob:export-one',
      error: null,
    };
    const html = renderToStaticMarkup(
      <DeliverableExportCard
        gate={{ allowed: true, reason: null }}
        kind="pptx"
        onExport={vi.fn()}
        state={successState}
      />,
    );

    expect(html).toContain('生成时间');
    expect(html).toContain(`dateTime="${EXPORTED_AT}"`);
    expect(html).toContain('5 字节');
    expect(html).toContain('a'.repeat(64));
    expect(html).toContain('href="blob:export-one"');
    expect(html).toContain('download="课程成果汇报.pptx"');
    expect(html).toContain('aria-label="下载文件：课程成果汇报.pptx"');
    expect(html).toContain('>下载文件</a>');
  });

  it('revokes replaced and released object URLs without leaking downloads', () => {
    const createObjectURL = vi
      .fn()
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second');
    const revokeObjectURL = vi.fn();
    const registry = new DownloadUrlRegistry({
      createObjectURL,
      revokeObjectURL,
    });

    expect(registry.replace('pptx', new Blob(['first']))).toBe(
      'blob:first',
    );
    expect(registry.replace('pptx', new Blob(['second']))).toBe(
      'blob:second',
    );
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:first');

    registry.releaseAll();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:second');
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});

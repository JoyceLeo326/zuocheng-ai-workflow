import { unzipSync } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { exportDeliverable } from './deliverable-export.js';
import { verifyDraft } from './draft-verification.js';
import { MemoryProjectStore } from './project-store.js';
import {
  readDraftArtifactPayload,
  createWorkbenchService,
} from './workbench-service.js';

function sequentialIds(): () => string {
  let sequence = 1;
  return () => {
    const suffix = String(sequence).padStart(12, '0');
    sequence += 1;
    return `01900000-0000-7000-8000-${suffix}`;
  };
}

async function createTwentyFivePagePdf(): Promise<File> {
  const document = await PDFDocument.create();
  document.setCreationDate(new Date(0));
  document.setModificationDate(new Date(0));
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= 25; pageNumber += 1) {
    const page = document.addPage([612, 792]);
    page.drawText(
      `Traceable finding ${String(pageNumber)} supports the course report.`,
      {
        x: 48,
        y: 720,
        size: 12,
        font,
      },
    );
  }
  const bytes = await document.save({ useObjectStreams: false });
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return new File([owned.buffer], '25-page-course-research.pdf', {
    type: 'application/pdf',
  });
}

describe('25-page to 3-page production golden path', () => {
  it('creates six traceable evidence cards, a verified three-page draft, and real PPTX/PDF files', async () => {
    const store = new MemoryProjectStore();
    const service = createWorkbenchService({
      store,
      idFactory: sequentialIds(),
      now: () => new Date('2026-07-27T01:00:00.000Z'),
    });
    let project = await service.createProject({
      projectTitle: '25 页资料到 3 页汇报',
      taskName: '完成问题、发现、建议三页课堂汇报',
      audience: '课程教师与同学',
      deadline: '2026-08-15T09:00:00.000Z',
      scope: '3 页',
      durationMinutes: '3',
      outputFormat: 'presentation',
      tone: '清晰、克制',
      rubric: [
        {
          title: '证据与表达',
          description: '每页结论均有可回溯证据，结构适合讲述',
          weightPercent: '100',
        },
      ],
      requiredContent: '核心结论',
      forbiddenContent: '无来源数字',
    });

    const source = await service.ingestSourceFile(
      project.id,
      await createTwentyFivePagePdf(),
    );
    expect(source.status).toBe('ready');
    if (source.status !== 'ready') {
      throw new Error('expected the generated PDF to parse');
    }
    expect(source.sourceFile.pageCount).toBe(25);
    expect(source.chunks).toHaveLength(25);
    expect(source.chunks.map((chunk) => chunk.pageNumber)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );

    project = source.project;
    for (const chunk of source.chunks.slice(0, 6)) {
      project = await service.createEvidence(project.id, {
        sourceChunkId: chunk.id,
        quote: chunk.text,
        kind: 'fact',
        stance: 'supports',
        note: `支撑第 ${String(chunk.pageNumber)} 页结论`,
        citation: `25 页课程资料，第 ${String(chunk.pageNumber)} 页`,
        userConfirmed: true,
      });
    }
    expect(project.evidenceCards).toHaveLength(6);
    expect(
      project.evidenceCards.every(
        (card) =>
          card.status === 'verified' &&
          card.confirmationStatus === 'confirmed' &&
          card.pageNumber !== null,
      ),
    ).toBe(true);

    const rubricId = project.taskDefinition.rubric[0]!.id;
    const pageDefinitions = [
      {
        title: '问题',
        conclusion: '核心结论：当前资料缺少统一的交付结构。',
        body: '先把任务要求、材料页码和评分标准放进同一条工作流。',
      },
      {
        title: '发现',
        conclusion: '核心结论：六条证据能够支撑主要判断。',
        body: '每条证据都保留原文件、页码、引用和确认状态。',
      },
      {
        title: '建议',
        conclusion: '核心结论：按证据组织三页汇报并在导出前核验。',
        body: '逐页检查引用、篇幅、时长与评分标准后再生成文件。',
      },
    ] as const;
    project = await service.createOutline(project.id, {
      title: '问题—发现—建议',
      nodes: pageDefinitions.map((page, index) => ({
        title: page.title,
        conclusion: page.conclusion,
        evidenceCardIds: project.evidenceCards
          .slice(index * 2, index * 2 + 2)
          .map((card) => card.id),
        coveredRequirements: ['核心结论'],
        rubricCriterionIds: [rubricId],
      })),
    });
    const outline = project.outlines[0]!;
    project = await service.selectOutline(project.id, outline.id);
    project = await service.lockOutline(project.id, outline.id);
    project = await service.ensureDraftArtifact(
      project.id,
      outline.id,
    );
    const artifactId = project.artifacts[0]!.id;

    for (const [index, definition] of pageDefinitions.entries()) {
      const evidenceCards = project.evidenceCards.slice(
        index * 2,
        index * 2 + 2,
      );
      project = await service.insertDraftPage(
        project.id,
        artifactId,
        {
          outlineNodeId: outline.nodes[index]!.id,
          index,
          page: {
            title: definition.title,
            conclusion: definition.conclusion,
            body: definition.body,
            evidenceCardIds: evidenceCards.map((card) => card.id),
            citations: evidenceCards.map((card, citationIndex) => ({
              evidenceCardId: card.id,
              label: `[${String(index * 2 + citationIndex + 1)}]`,
            })),
            visualNote: '用简洁的信息卡呈现本页结论与证据。',
            speakerNotes: '先讲结论，再说明证据页码与下一步。',
            estimatedSeconds: 60,
            rubricCriterionIds: [rubricId],
            claims: [
              {
                id: `claim-${String(index + 1)}`,
                text: definition.conclusion,
                evidenceCardIds: evidenceCards.map((card) => card.id),
                numericFacts: [],
              },
            ],
          },
        },
      );
    }

    project = await service.verifyDraftArtifact(
      project.id,
      artifactId,
    );
    const artifact = project.artifacts.find(
      (candidate) => candidate.id === artifactId,
    )!;
    const draftPages = readDraftArtifactPayload(artifact).pages.map(
      (record) => record.page,
    );
    expect(draftPages.map((page) => page.title)).toEqual([
      '问题',
      '发现',
      '建议',
    ]);
    const checks = verifyDraft({
      pages: draftPages,
      taskDefinition: project.taskDefinition,
      evidenceCards: project.evidenceCards,
    });
    expect(checks).toHaveLength(10);
    expect(checks.every((check) => check.outcome === 'pass')).toBe(
      true,
    );
    expect(project.verificationResults[0]?.summary).toEqual({
      passed: 10,
      warnings: 0,
      failed: 0,
      notRun: 0,
    });

    const exportedAt = '2026-07-27T02:00:00.000Z';
    const [pptx, pdf] = await Promise.all([
      exportDeliverable({
        kind: 'pptx',
        project,
        draftPages,
        verificationChecks: checks,
        exportedAt,
      }),
      exportDeliverable({
        kind: 'pdf',
        project,
        draftPages,
        verificationChecks: checks,
        exportedAt,
      }),
    ]);
    expect(pptx.sizeBytes).toBeGreaterThan(10_000);
    expect(pdf.sizeBytes).toBeGreaterThan(10_000);
    expect(Object.keys(unzipSync(
      new Uint8Array(await pptx.blob.arrayBuffer()),
    ))).toEqual(
      expect.arrayContaining([
        'ppt/slides/slide1.xml',
        'ppt/slides/slide2.xml',
        'ppt/slides/slide3.xml',
      ]),
    );
    const exportedPdf = await PDFDocument.load(
      await pdf.blob.arrayBuffer(),
    );
    expect(exportedPdf.getPageCount()).toBe(3);
    expect(pptx.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(pdf.sha256).toMatch(/^[0-9a-f]{64}$/u);

    const projectPackage = await service.exportProjectBundle(project.id);
    expect(projectPackage.project.sourceFiles).toHaveLength(1);
    expect(projectPackage.sourceBlobs).toHaveLength(1);
    expect(projectPackage.project.evidenceCards).toHaveLength(6);
  }, 30_000);
});

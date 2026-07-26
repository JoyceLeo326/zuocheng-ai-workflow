import { describe, expect, it } from 'vitest';
import {
  PROJECT_TEMPLATES,
  applyProjectTemplate,
  findProjectTemplate,
  filterProjectTemplates,
  templateCategories,
} from './project-template.js';

describe('project template domain', () => {
  it('offers seven distinct, useful project types with complete setup guidance', () => {
    expect(PROJECT_TEMPLATES.map((template) => template.name)).toEqual([
      '课堂汇报',
      '文献综述',
      '用户调研',
      '商赛分析',
      '项目答辩',
      '求职展示',
      '自定义项目',
    ]);
    expect(
      new Set(PROJECT_TEMPLATES.map((template) => template.id)).size,
    ).toBe(7);
    expect(templateCategories.map((category) => category.id)).toEqual([
      'all',
      'learning',
      'research',
      'business',
      'career',
      'custom',
    ]);

    for (const template of PROJECT_TEMPLATES) {
      expect(template.summary.trim().length).toBeGreaterThan(12);
      expect(template.taskDefaults.taskName.trim()).not.toBe('');
      expect(template.taskDefaults.audience.trim()).not.toBe('');
      expect(template.taskDefaults.scope.trim()).toMatch(/\d+\s*(页|字)/u);
      expect(template.taskDefaults.outputFormat).not.toBe('');
      expect(template.taskDefaults.tone.trim()).not.toBe('');
      expect(template.taskDefaults.rubric).not.toHaveLength(0);
      expect(
        template.taskDefaults.rubric.reduce(
          (total, criterion) =>
            total + Number(criterion.weightPercent),
          0,
        ),
      ).toBe(100);
      expect(template.acceptanceChecklist.length).toBeGreaterThanOrEqual(4);
      expect(template.suggestedStructure.length).toBeGreaterThanOrEqual(4);
      expect(template.requiredUserInputs).toEqual(
        expect.arrayContaining(['具体主题', '截止时间', '任务材料']),
      );
    }
  });

  it('creates an editable workbench form without adding sources, evidence or results', () => {
    const template = findProjectTemplate('user-research');
    const form = applyProjectTemplate(template, {
      taskName: '校园自习空间体验调研',
      deadline: '2026-08-18T18:00',
      projectTitle: '自习空间调研汇报',
    });

    expect(form).toMatchObject({
      projectTitle: '自习空间调研汇报',
      taskName: '校园自习空间体验调研',
      deadline: '2026-08-18T18:00',
      outputFormat: 'report',
    });
    expect(form.rubric.reduce((sum, item) => sum + Number(item.weightPercent), 0))
      .toBe(100);
    expect(form.requiredContent).toContain('调研问题与目标用户');
    expect(form.forbiddenContent).toContain('未实际发生的访谈');
    expect(Object.keys(form)).not.toEqual(
      expect.arrayContaining([
        'sourceFiles',
        'sourceChunks',
        'evidenceCards',
        'outlines',
        'artifacts',
        'verificationResults',
      ]),
    );
  });

  it('keeps unknown project details blank instead of guessing them', () => {
    const form = applyProjectTemplate(findProjectTemplate('literature-review'));

    expect(form.deadline).toBe('');
    expect(form.projectTitle).toBeUndefined();
    expect(form.requiredContent).toContain('检索范围与筛选标准');
    expect(form.forbiddenContent).toContain('未阅读文献的观点');
  });

  it('searches names, uses, tags and setup guidance, then combines category filters', () => {
    expect(filterProjectTemplates(PROJECT_TEMPLATES, '访谈', 'all')).toEqual([
      expect.objectContaining({ id: 'user-research' }),
    ]);
    expect(filterProjectTemplates(PROJECT_TEMPLATES, '作品集', 'career')).toEqual(
      [expect.objectContaining({ id: 'job-showcase' })],
    );
    expect(filterProjectTemplates(PROJECT_TEMPLATES, '', 'learning').map(
      (template) => template.id,
    )).toEqual(['class-presentation', 'defense']);
    expect(filterProjectTemplates(PROJECT_TEMPLATES, '不存在的模板', 'all')).toEqual(
      [],
    );
  });

  it('returns defensive copies so applying a template cannot mutate the catalog', () => {
    const template = findProjectTemplate('business-competition');
    const first = applyProjectTemplate(template);
    first.rubric[0]!.description = '被修改的评分项';
    const second = applyProjectTemplate(template);

    expect(second.rubric[0]!.description).not.toBe('被修改的评分项');
  });

  it('fails clearly for an unknown template identity', () => {
    expect(() => findProjectTemplate('missing-template')).toThrow(
      '找不到这个项目模板',
    );
  });
});

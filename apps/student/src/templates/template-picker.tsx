import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import type { WorkbenchProjectFormInput } from '../workbench/workbench-service.js';
import {
  PROJECT_TEMPLATES,
  applyProjectTemplate,
  filterProjectTemplates,
  templateCategories,
  type ProjectTemplate,
  type ProjectTemplateCategoryFilter,
} from './project-template.js';
import './templates.css';

export interface ProjectTemplatePickerProps {
  templates?: readonly ProjectTemplate[];
  initialCategory?: ProjectTemplateCategoryFilter;
  initialTemplateId?: string;
  onConfirm(
    template: ProjectTemplate,
    form: WorkbenchProjectFormInput,
  ): void;
  onCancel?(): void;
}

const navigableKeys = new Set([
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'End',
  'Home',
]);

export function templatePickerNextIndex(
  currentIndex: number,
  key: string,
  itemCount: number,
): number | null {
  if (
    itemCount < 1 ||
    !Number.isSafeInteger(currentIndex) ||
    currentIndex < 0 ||
    currentIndex >= itemCount
  ) {
    return null;
  }
  if (key === 'Home') {
    return 0;
  }
  if (key === 'End') {
    return itemCount - 1;
  }
  if (key === 'ArrowDown' || key === 'ArrowRight') {
    return (currentIndex + 1) % itemCount;
  }
  if (key === 'ArrowUp' || key === 'ArrowLeft') {
    return (currentIndex - 1 + itemCount) % itemCount;
  }
  return null;
}

export function ProjectTemplatePicker({
  templates = PROJECT_TEMPLATES,
  initialCategory = 'all',
  initialTemplateId,
  onConfirm,
  onCancel,
}: ProjectTemplatePickerProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] =
    useState<ProjectTemplateCategoryFilter>(initialCategory);
  const initialVisible = filterProjectTemplates(
    templates,
    '',
    initialCategory,
  );
  const [selectedId, setSelectedId] = useState(
    initialVisible.some((template) => template.id === initialTemplateId)
      ? initialTemplateId
      : initialVisible[0]?.id,
  );
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const visibleTemplates = useMemo(
    () => filterProjectTemplates(templates, query, category),
    [category, query, templates],
  );
  const selectedTemplate =
    visibleTemplates.find((template) => template.id === selectedId) ??
    visibleTemplates[0] ??
    null;

  function chooseCategory(nextCategory: ProjectTemplateCategoryFilter) {
    const nextTemplates = filterProjectTemplates(
      templates,
      query,
      nextCategory,
    );
    setCategory(nextCategory);
    setSelectedId(nextTemplates[0]?.id);
  }

  function updateQuery(event: ChangeEvent<HTMLInputElement>) {
    const nextQuery = event.currentTarget.value;
    const nextTemplates = filterProjectTemplates(
      templates,
      nextQuery,
      category,
    );
    setQuery(nextQuery);
    setSelectedId(nextTemplates[0]?.id);
  }

  function resetFilters() {
    setQuery('');
    setCategory('all');
    setSelectedId(templates[0]?.id);
  }

  function navigateOptions(
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) {
    if (!navigableKeys.has(event.key)) {
      return;
    }
    const nextIndex = templatePickerNextIndex(
      currentIndex,
      event.key,
      visibleTemplates.length,
    );
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    const nextTemplate = visibleTemplates[nextIndex];
    if (nextTemplate === undefined) {
      return;
    }
    setSelectedId(nextTemplate.id);
    optionRefs.current[nextIndex]?.focus();
  }

  return (
    <section className="template-picker" aria-labelledby="template-picker-title">
      <header className="template-picker__header">
        <div>
          <p className="template-picker__eyebrow">新建项目</p>
          <h2 id="template-picker-title">选择一个项目模板</h2>
          <p>先定好交付要求，后续内容仍可逐项修改。</p>
        </div>
        {onCancel === undefined ? null : (
          <button
            className="template-picker__close"
            type="button"
            onClick={onCancel}
            aria-label="关闭模板选择"
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </header>

      <div className="template-picker__toolbar">
        <label className="template-picker__search">
          <span className="sr-only">搜索项目模板</span>
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4 4" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={updateQuery}
            placeholder="搜索用途或模板"
            aria-label="搜索项目模板"
          />
        </label>
        <div
          className="template-picker__filters"
          role="group"
          aria-label="筛选项目模板"
        >
          {templateCategories.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={category === option.id}
              onClick={() => {
                chooseCategory(option.id);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {visibleTemplates.length === 0 ? (
        <div className="template-picker__empty" role="status">
          <span aria-hidden="true">⌕</span>
          <h3>没有找到匹配模板</h3>
          <p>换个关键词，或查看全部模板。</p>
          <button type="button" onClick={resetFilters}>
            查看全部模板
          </button>
        </div>
      ) : (
        <div className="template-picker__layout">
          <div
            className="template-picker__list"
            role="listbox"
            aria-label="项目模板"
          >
            <p className="template-picker__result-count">
              {visibleTemplates.length} 个模板
            </p>
            {visibleTemplates.map((template, index) => {
              const selected = template.id === selectedTemplate?.id;
              return (
                <button
                  key={template.id}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  id={`project-template-${template.id}`}
                  className="template-picker__option"
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => {
                    setSelectedId(template.id);
                  }}
                  onFocus={() => {
                    setSelectedId(template.id);
                  }}
                  onKeyDown={(event) => {
                    navigateOptions(event, index);
                  }}
                >
                  <span className="template-picker__option-index">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="template-picker__option-copy">
                    <strong>{template.name}</strong>
                    <small>{template.useFor}</small>
                  </span>
                  <span className="template-picker__option-arrow" aria-hidden="true">
                    →
                  </span>
                </button>
              );
            })}
          </div>

          {selectedTemplate === null ? null : (
            <article
              className="template-picker__preview"
              aria-live="polite"
              aria-labelledby="template-preview-title"
            >
              <div className="template-picker__preview-heading">
                <div>
                  <p>{categoryLabel(selectedTemplate.category)}</p>
                  <h3 id="template-preview-title">
                    {selectedTemplate.name}
                  </h3>
                </div>
                <span>{selectedTemplate.taskDefaults.scope}</span>
              </div>
              <p className="template-picker__summary">
                {selectedTemplate.summary}
              </p>

              <dl className="template-picker__defaults">
                <div>
                  <dt>适合</dt>
                  <dd>{selectedTemplate.useFor}</dd>
                </div>
                <div>
                  <dt>听众</dt>
                  <dd>{selectedTemplate.taskDefaults.audience}</dd>
                </div>
                <div>
                  <dt>交付</dt>
                  <dd>
                    {formatLabel(
                      selectedTemplate.taskDefaults.outputFormat,
                    )}
                    {selectedTemplate.taskDefaults.durationMinutes.length > 0
                      ? ` · ${selectedTemplate.taskDefaults.durationMinutes} 分钟`
                      : ''}
                  </dd>
                </div>
              </dl>

              <section className="template-picker__requirements">
                <h4>交付必须包含</h4>
                <ul>
                  {selectedTemplate.taskDefaults.requiredContent.map(
                    (item) => (
                      <li key={item}>{item}</li>
                    ),
                  )}
                </ul>
              </section>

              <div className="template-picker__preview-grid">
                <section>
                  <h4>验收清单</h4>
                  <ul className="template-picker__checklist">
                    {selectedTemplate.acceptanceChecklist.map((item) => (
                      <li key={item}>
                        <span aria-hidden="true">✓</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h4>建议结构</h4>
                  <ol className="template-picker__structure">
                    {selectedTemplate.suggestedStructure.map(
                      (item, index) => (
                        <li key={item.title}>
                          <span>{String(index + 1).padStart(2, '0')}</span>
                          <div>
                            <strong>{item.title}</strong>
                            <p>{item.purpose}</p>
                          </div>
                        </li>
                      ),
                    )}
                  </ol>
                </section>
              </div>

              <div className="template-picker__required">
                <strong>需要你补充</strong>
                <ul aria-label="需要补充的信息">
                  {selectedTemplate.requiredUserInputs.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>

              <footer className="template-picker__actions">
                <p>应用后可继续调整全部字段。</p>
                <button
                  type="button"
                  onClick={() => {
                    onConfirm(
                      selectedTemplate,
                      applyProjectTemplate(selectedTemplate),
                    );
                  }}
                >
                  使用“{selectedTemplate.name}”
                  <span aria-hidden="true">→</span>
                </button>
              </footer>
            </article>
          )}
        </div>
      )}
    </section>
  );
}

function categoryLabel(category: ProjectTemplate['category']): string {
  return (
    templateCategories.find((option) => option.id === category)?.label ??
    '项目模板'
  );
}

function formatLabel(
  format: ProjectTemplate['taskDefaults']['outputFormat'],
): string {
  const labels: Record<string, string> = {
    presentation: '演示文稿',
    report: '报告',
    document: '文档',
    pptx: 'PPTX',
    pdf: 'PDF',
    docx: 'DOCX',
    markdown: 'Markdown',
    script: '讲稿',
    'source-index': '来源索引',
    'task-card': '任务卡',
    'verification-record': '核验记录',
    'project-package': '项目包',
  };
  return labels[format] ?? format;
}

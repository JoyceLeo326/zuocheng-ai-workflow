import {
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ChangeEvent,
  type FormEvent,
  type SyntheticEvent,
} from 'react';
import type {
  EntityId,
  EvidenceCard,
  EvidenceKind,
  Project,
  SourceChunk,
  SourceFile,
} from './project-model.js';
import './evidence-stage.css';

export type EvidenceStageStance = 'supports' | 'opposes' | 'neutral';

export interface EvidenceStageCreateInput {
  sourceChunkId: EntityId;
  quote: string;
  kind: EvidenceKind;
  stance: EvidenceStageStance;
  note: string;
  citation: string;
  userConfirmed: boolean;
}

export interface EvidenceStageProps {
  project: Project;
  evidenceCards: readonly EvidenceCard[];
  onCreateEvidence(input: EvidenceStageCreateInput): Promise<void>;
  initialSearchQuery?: string;
  initialPageFilter?: PageFilter;
}

export type PageFilter = 'all' | number;

export interface EvidenceChunkView {
  chunk: SourceChunk;
  sourceFile: SourceFile;
}

export interface EvidenceQuoteSelection {
  sourceChunkId: EntityId;
  quote: string;
  characterStart: number;
  characterEnd: number;
}

export interface EvidenceStageSaveState {
  status: 'idle' | 'saving' | 'error';
  message: string | null;
}

export type EvidenceStageSaveAction =
  | { type: 'start' }
  | { type: 'succeed' }
  | { type: 'fail'; message: string };

interface EvidenceDraft extends EvidenceQuoteSelection {
  fileName: string;
  pageNumber: number;
  pageLabel: string;
}

interface EvidenceFormState {
  kind: EvidenceKind;
  stance: EvidenceStageStance;
  note: string;
  citation: string;
  userConfirmed: boolean;
}

interface TextSelection {
  start: number;
  end: number;
}

const KIND_OPTIONS: readonly {
  value: EvidenceKind;
  label: string;
}[] = [
  { value: 'fact', label: '事实' },
  { value: 'statistic', label: '数据' },
  { value: 'opinion', label: '观点' },
  { value: 'case', label: '案例' },
  { value: 'unverified', label: '待核验' },
];

const STANCE_OPTIONS: readonly {
  value: EvidenceStageStance;
  label: string;
}[] = [
  { value: 'supports', label: '支持' },
  { value: 'opposes', label: '反对' },
  { value: 'neutral', label: '中性' },
];

const INITIAL_FORM_STATE: EvidenceFormState = {
  kind: 'fact',
  stance: 'neutral',
  note: '',
  citation: '',
  userConfirmed: false,
};

export function filterEvidenceChunks(
  project: Project,
  searchQuery: string,
  pageFilter: PageFilter,
): EvidenceChunkView[] {
  const filesById = new Map(
    project.sourceFiles.map((sourceFile) => [
      sourceFile.id,
      sourceFile,
    ]),
  );
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();

  return project.sourceChunks.flatMap((chunk) => {
    const sourceFile = filesById.get(chunk.sourceFileId);
    if (sourceFile === undefined) {
      return [];
    }
    if (pageFilter !== 'all' && chunk.pageNumber !== pageFilter) {
      return [];
    }
    const searchableText =
      `${sourceFile.fileName}\n${chunk.pageLabel}\n${chunk.text}`.toLocaleLowerCase();
    if (
      normalizedQuery.length > 0 &&
      !searchableText.includes(normalizedQuery)
    ) {
      return [];
    }
    return [{ chunk, sourceFile }];
  });
}

export function selectEvidenceQuote(
  chunk: SourceChunk,
  relativeStart = 0,
  relativeEnd = chunk.text.length,
): EvidenceQuoteSelection {
  if (
    !Number.isSafeInteger(relativeStart) ||
    !Number.isSafeInteger(relativeEnd) ||
    relativeStart < 0 ||
    relativeEnd > chunk.text.length ||
    relativeEnd <= relativeStart
  ) {
    throw new Error('请选择一段非空的精确片段。');
  }
  const quote = chunk.text.slice(relativeStart, relativeEnd);
  if (quote.trim().length === 0) {
    throw new Error('请选择包含原文内容的精确片段。');
  }
  return {
    sourceChunkId: chunk.id,
    quote,
    characterStart: chunk.characterStart + relativeStart,
    characterEnd: chunk.characterStart + relativeEnd,
  };
}

export function evidenceStageSaveReducer(
  _state: EvidenceStageSaveState,
  action: EvidenceStageSaveAction,
): EvidenceStageSaveState {
  if (action.type === 'start') {
    return { status: 'saving', message: null };
  }
  if (action.type === 'fail') {
    return { status: 'error', message: action.message };
  }
  return { status: 'idle', message: null };
}

export async function submitEvidenceCreation(
  onCreateEvidence: (
    input: EvidenceStageCreateInput,
  ) => Promise<void>,
  input: EvidenceStageCreateInput,
): Promise<EvidenceStageSaveState> {
  try {
    await onCreateEvidence(input);
    return { status: 'idle', message: null };
  } catch (error) {
    return {
      status: 'error',
      message:
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : '保存证据失败，请重试。',
    };
  }
}

export function EvidenceStage({
  project,
  evidenceCards,
  onCreateEvidence,
  initialSearchQuery = '',
  initialPageFilter = 'all',
}: EvidenceStageProps) {
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [pageFilter, setPageFilter] =
    useState<PageFilter>(initialPageFilter);
  const [textSelections, setTextSelections] = useState<
    Readonly<Record<EntityId, TextSelection>>
  >({});
  const [draft, setDraft] = useState<EvidenceDraft | null>(null);
  const [formState, setFormState] =
    useState<EvidenceFormState>(INITIAL_FORM_STATE);
  const [pendingFocusChunkId, setPendingFocusChunkId] =
    useState<EntityId | null>(null);
  const [saveState, dispatchSave] = useReducer(
    evidenceStageSaveReducer,
    {
      status: 'idle',
      message: null,
    },
  );

  const sourceViews = useMemo(
    () => filterEvidenceChunks(project, searchQuery, pageFilter),
    [pageFilter, project, searchQuery],
  );
  const filesById = useMemo(
    () =>
      new Map(
        project.sourceFiles.map((sourceFile) => [
          sourceFile.id,
          sourceFile,
        ]),
      ),
    [project.sourceFiles],
  );
  const pageNumbers = useMemo(
    () =>
      [...new Set(project.sourceChunks.map((chunk) => chunk.pageNumber))].sort(
        (left, right) => left - right,
      ),
    [project.sourceChunks],
  );

  useEffect(() => {
    if (pendingFocusChunkId === null) {
      return;
    }
    const element = document.getElementById(
      sourceChunkElementId(pendingFocusChunkId),
    );
    if (element === null) {
      return;
    }
    element.focus();
    element.scrollIntoView({ block: 'nearest' });
    setPendingFocusChunkId(null);
  }, [pendingFocusChunkId, sourceViews]);

  const selectDraft = (
    view: EvidenceChunkView,
    selection: EvidenceQuoteSelection,
  ) => {
    setDraft({
      ...selection,
      fileName: view.sourceFile.fileName,
      pageNumber: view.chunk.pageNumber,
      pageLabel: view.chunk.pageLabel,
    });
    setFormState({
      ...INITIAL_FORM_STATE,
      citation: `${view.sourceFile.fileName}，第 ${view.chunk.pageLabel} 页`,
    });
    dispatchSave({ type: 'succeed' });
  };

  const handleTextSelection = (
    event: SyntheticEvent<HTMLTextAreaElement>,
    chunkId: EntityId,
  ) => {
    const target = event.currentTarget;
    setTextSelections((current) => ({
      ...current,
      [chunkId]: {
        start: target.selectionStart,
        end: target.selectionEnd,
      },
    }));
  };

  const handlePageFilter = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextValue = event.currentTarget.value;
    setPageFilter(nextValue === 'all' ? 'all' : Number(nextValue));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      draft === null ||
      !formState.userConfirmed ||
      saveState.status === 'saving'
    ) {
      return;
    }
    const input: EvidenceStageCreateInput = {
      sourceChunkId: draft.sourceChunkId,
      quote: draft.quote,
      kind: formState.kind,
      stance: formState.stance,
      note: formState.note.trim(),
      citation: formState.citation.trim(),
      userConfirmed: formState.userConfirmed,
    };
    dispatchSave({ type: 'start' });
    void submitEvidenceCreation(onCreateEvidence, input).then(
      (nextSaveState) => {
        if (nextSaveState.status === 'error') {
          dispatchSave({
            type: 'fail',
            message:
              nextSaveState.message ?? '保存证据失败，请重试。',
          });
          return;
        }
        dispatchSave({ type: 'succeed' });
        setDraft(null);
        setFormState(INITIAL_FORM_STATE);
      },
    );
  };

  const locateEvidence = (evidence: EvidenceCard) => {
    setSearchQuery('');
    setPageFilter(evidence.pageNumber);
    setPendingFocusChunkId(evidence.sourceChunkId);
  };

  const filtersActive =
    searchQuery.trim().length > 0 || pageFilter !== 'all';
  const formDisabled = draft === null || saveState.status === 'saving';
  const saveDisabled =
    formDisabled ||
    !formState.userConfirmed ||
    formState.citation.trim().length === 0;

  return (
    <section
      aria-labelledby="evidence-stage-title"
      className="evidence-stage"
    >
      <header className="evidence-stage__header">
        <div>
          <span className="evidence-stage__kicker">
            03 / EVIDENCE
          </span>
          <h2 id="evidence-stage-title">从原文选择证据</h2>
          <p>
            每条证据保留文件、页码、字符定位和原文；人工核对后才能保存。
          </p>
        </div>
        <div className="evidence-stage__metrics" aria-label="证据数量">
          <strong>{String(evidenceCards.length)}</strong>
          <span>已选证据</span>
        </div>
      </header>

      <div className="evidence-stage__tools" role="search">
        <div className="evidence-stage__field">
          <label htmlFor="evidence-search">搜索原文</label>
          <input
            autoComplete="off"
            id="evidence-search"
            onChange={(event) => {
              setSearchQuery(event.currentTarget.value);
            }}
            placeholder="搜索文件名或原文关键词"
            type="search"
            value={searchQuery}
          />
        </div>
        <div className="evidence-stage__field">
          <label htmlFor="evidence-page-filter">按页筛选</label>
          <select
            id="evidence-page-filter"
            onChange={handlePageFilter}
            value={pageFilter}
          >
            <option value="all">全部页面</option>
            {pageNumbers.map((pageNumber) => (
              <option key={pageNumber} value={pageNumber}>
                第 {String(pageNumber)} 页
              </option>
            ))}
          </select>
        </div>
        <span aria-live="polite" className="evidence-stage__result-count">
          {String(sourceViews.length)} 段原文
        </span>
      </div>

      <div className="evidence-stage__workspace">
        <section
          aria-labelledby="source-browser-title"
          className="evidence-source-browser"
        >
          <header className="evidence-stage__subheader">
            <div>
              <span>真实解析结果</span>
              <h3 id="source-browser-title">原文浏览器</h3>
            </div>
            <small>在原文框中拖选文字，可使用精确片段</small>
          </header>

          {sourceViews.length === 0 ? (
            <div className="evidence-stage__empty" role="status">
              <span aria-hidden="true">◇</span>
              <div>
                <strong>
                  {filtersActive
                    ? '没有匹配的原文'
                    : '尚无可选择原文'}
                </strong>
                <p>
                  {filtersActive
                    ? '调整关键词或页面筛选后重试。'
                    : '材料解析完成后，原文会按真实页码出现在这里。'}
                </p>
              </div>
            </div>
          ) : (
            <ol className="evidence-source-list">
              {sourceViews.map((view) => {
                const { chunk, sourceFile } = view;
                const textSelection = textSelections[chunk.id];
                const hasExactSelection =
                  textSelection !== undefined &&
                  textSelection.end > textSelection.start;
                return (
                  <li key={chunk.id}>
                    <article
                      className={
                        draft?.sourceChunkId === chunk.id
                          ? 'evidence-source-card is-selected'
                          : 'evidence-source-card'
                      }
                      id={sourceChunkElementId(chunk.id)}
                      tabIndex={-1}
                    >
                      <header>
                        <div>
                          <strong>{sourceFile.fileName}</strong>
                          <span>
                            第 {String(chunk.pageNumber)} 页 · 字符{' '}
                            {String(chunk.characterStart)}–
                            {String(chunk.characterEnd)}
                          </span>
                        </div>
                        <span className="evidence-source-card__ordinal">
                          #{String(chunk.ordinal + 1).padStart(2, '0')}
                        </span>
                      </header>
                      <label
                        className="evidence-source-card__text-label"
                        htmlFor={`source-text-${chunk.id}`}
                      >
                        原文，可拖选精确片段
                      </label>
                      <textarea
                        aria-label={`第 ${String(chunk.pageNumber)} 页原文，可选择精确片段`}
                        id={`source-text-${chunk.id}`}
                        onSelect={(event) => {
                          handleTextSelection(event, chunk.id);
                        }}
                        readOnly
                        rows={Math.min(
                          8,
                          Math.max(3, Math.ceil(chunk.text.length / 38)),
                        )}
                        value={chunk.text}
                      />
                      <footer>
                        <button
                          className="evidence-stage__button evidence-stage__button--quiet"
                          onClick={() => {
                            selectDraft(
                              view,
                              selectEvidenceQuote(chunk),
                            );
                          }}
                          type="button"
                        >
                          选择整段
                        </button>
                        <button
                          className="evidence-stage__button"
                          disabled={!hasExactSelection}
                          onClick={() => {
                            if (textSelection === undefined) {
                              return;
                            }
                            selectDraft(
                              view,
                              selectEvidenceQuote(
                                chunk,
                                textSelection.start,
                                textSelection.end,
                              ),
                            );
                          }}
                          type="button"
                        >
                          使用所选片段
                        </button>
                      </footer>
                    </article>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <aside
          aria-labelledby="evidence-editor-title"
          className="evidence-editor"
        >
          <header className="evidence-stage__subheader">
            <div>
              <span>证据卡</span>
              <h3 id="evidence-editor-title">核对并保存</h3>
            </div>
            <small>{draft === null ? '等待选择' : '待人工确认'}</small>
          </header>

          <div className="evidence-editor__selection" aria-live="polite">
            {draft === null ? (
              <p>先从原文浏览器选择整段或精确片段。</p>
            ) : (
              <>
                <span>
                  {draft.fileName} · 第 {String(draft.pageNumber)} 页 ·
                  字符 {String(draft.characterStart)}–
                  {String(draft.characterEnd)}
                </span>
                <blockquote>{draft.quote}</blockquote>
              </>
            )}
          </div>

          <form
            aria-busy={saveState.status === 'saving'}
            onSubmit={handleSubmit}
          >
            <fieldset disabled={formDisabled}>
              <legend className="sr-only">证据属性</legend>
              <div className="evidence-stage__field">
                <label htmlFor="evidence-kind">证据类型</label>
                <select
                  id="evidence-kind"
                  onChange={(event) => {
                    setFormState((current) => ({
                      ...current,
                      kind: event.currentTarget.value as EvidenceKind,
                    }));
                  }}
                  value={formState.kind}
                >
                  {KIND_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <fieldset className="evidence-stance">
                <legend>证据立场</legend>
                <div>
                  {STANCE_OPTIONS.map((option) => (
                    <label key={option.value}>
                      <input
                        checked={formState.stance === option.value}
                        name="evidence-stance"
                        onChange={() => {
                          setFormState((current) => ({
                            ...current,
                            stance: option.value,
                          }));
                        }}
                        type="radio"
                        value={option.value}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="evidence-stage__field">
                <label htmlFor="evidence-note">备注</label>
                <textarea
                  id="evidence-note"
                  maxLength={2_000}
                  onChange={(event) => {
                    setFormState((current) => ({
                      ...current,
                      note: event.currentTarget.value,
                    }));
                  }}
                  placeholder="说明这条证据用于支持或限制什么结论"
                  rows={3}
                  value={formState.note}
                />
              </div>

              <div className="evidence-stage__field">
                <label htmlFor="evidence-citation">引用</label>
                <input
                  id="evidence-citation"
                  maxLength={500}
                  onChange={(event) => {
                    setFormState((current) => ({
                      ...current,
                      citation: event.currentTarget.value,
                    }));
                  }}
                  placeholder="文件名，第 7 页"
                  required
                  value={formState.citation}
                />
              </div>

              <label className="evidence-confirmation">
                <input
                  checked={formState.userConfirmed}
                  onChange={(event) => {
                    setFormState((current) => ({
                      ...current,
                      userConfirmed: event.currentTarget.checked,
                    }));
                  }}
                  type="checkbox"
                />
                <span>
                  <strong>我已核对原文与定位</strong>
                  <small>确认引用内容与文件、页码和字符范围一致。</small>
                </span>
              </label>
            </fieldset>

            {saveState.status === 'error' ? (
              <div className="evidence-stage__error" role="alert">
                <strong>证据未保存</strong>
                <span>{saveState.message}</span>
              </div>
            ) : null}

            <button
              aria-live="polite"
              className="evidence-stage__button evidence-stage__button--save"
              disabled={saveDisabled}
              type="submit"
            >
              {saveState.status === 'saving'
                ? '保存证据中…'
                : '保存证据'}
            </button>
          </form>
        </aside>
      </div>

      <section
        aria-labelledby="selected-evidence-title"
        className="selected-evidence"
      >
        <header className="evidence-stage__subheader">
          <div>
            <span>项目证据</span>
            <h3 id="selected-evidence-title">
              已选证据 {String(evidenceCards.length)}
            </h3>
          </div>
          <small>仅显示项目中已保存的证据</small>
        </header>

        {evidenceCards.length === 0 ? (
          <div className="evidence-stage__empty">
            <span aria-hidden="true">◇</span>
            <div>
              <strong>尚未选择证据</strong>
              <p>从上方真实原文中选择并核对后保存。</p>
            </div>
          </div>
        ) : (
          <ol className="selected-evidence__list">
            {evidenceCards.map((evidence, index) => {
              const sourceFile = filesById.get(evidence.sourceFileId);
              return (
                <li key={evidence.id}>
                  <article>
                    <div className="selected-evidence__index">
                      {String(index + 1).padStart(2, '0')}
                    </div>
                    <div className="selected-evidence__body">
                      <div className="selected-evidence__meta">
                        <span>{kindLabel(evidence.kind)}</span>
                        <span>
                          {sourceFile?.fileName ?? '来源文件不存在'} · 第{' '}
                          {String(evidence.pageNumber)} 页 · 字符{' '}
                          {String(evidence.characterStart)}–
                          {String(evidence.characterEnd)}
                        </span>
                      </div>
                      <blockquote>{evidence.quote}</blockquote>
                      {evidence.note.length > 0 ? (
                        <p>{evidence.note}</p>
                      ) : null}
                      <small>{evidence.citation}</small>
                    </div>
                    <button
                      className="evidence-stage__button evidence-stage__button--quiet"
                      disabled={
                        !project.sourceChunks.some(
                          (chunk) =>
                            chunk.id === evidence.sourceChunkId,
                        )
                      }
                      onClick={() => {
                        locateEvidence(evidence);
                      }}
                      type="button"
                    >
                      定位来源
                    </button>
                  </article>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </section>
  );
}

function sourceChunkElementId(chunkId: EntityId): string {
  return `evidence-source-${chunkId}`;
}

function kindLabel(kind: EvidenceKind): string {
  return (
    KIND_OPTIONS.find((option) => option.value === kind)?.label ??
    '未知类型'
  );
}

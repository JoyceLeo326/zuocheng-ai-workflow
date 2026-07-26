import {
  useEffect,
  useMemo,
  useReducer,
  useState,
  type FormEvent,
} from 'react';
import type {
  EntityId,
  EvidenceCard,
  Outline,
  Project,
} from './project-model.js';
import {
  verifyDraft,
  type DraftClaim,
  type DraftNumericFact,
  type DraftPage,
  type DraftPagePatch,
  type DraftVerificationCheck,
} from './draft-verification.js';
import './draft-stage.css';

export interface DraftStagePage {
  outlineNodeId: EntityId;
  page: DraftPage;
}

export interface InsertDraftPageInput {
  outlineId: EntityId;
  outlineNodeId: EntityId;
  index: number;
  page: Omit<DraftPage, 'id' | 'locked'>;
}

export interface UpdateDraftPageInput {
  outlineId: EntityId;
  pageId: string;
  patch: DraftPagePatch;
}

export interface DeleteDraftPageInput {
  outlineId: EntityId;
  pageId: string;
}

export interface ReorderDraftPageInput {
  outlineId: EntityId;
  pageId: string;
  targetIndex: number;
}

export interface LockDraftPageInput {
  outlineId: EntityId;
  pageId: string;
  locked: boolean;
}

export interface DraftStageCallbacks {
  onInsertPage(input: InsertDraftPageInput): Promise<void>;
  onUpdatePage(input: UpdateDraftPageInput): Promise<void>;
  onDeletePage(input: DeleteDraftPageInput): Promise<void>;
  onReorderPage(input: ReorderDraftPageInput): Promise<void>;
  onSetPageLocked(input: LockDraftPageInput): Promise<void>;
}

export interface DraftStageProps extends DraftStageCallbacks {
  project: Project;
  pages: readonly DraftStagePage[];
}

export interface DraftStageActionState {
  status: 'idle' | 'saving' | 'error';
  actionKey: string | null;
  message: string | null;
}

export type DraftStageAction =
  | { type: 'start'; actionKey: string }
  | { type: 'succeed' }
  | { type: 'fail'; message: string };

export interface DraftVerificationSummary {
  passed: number;
  warnings: number;
  failed: number;
  notRun: number;
}

interface MutableNumericFact {
  metric: string;
  value: number;
  unit: string;
}

interface MutableClaim {
  id: string;
  text: string;
  evidenceCardIds: EntityId[];
  numericFacts: MutableNumericFact[];
}

interface PageDraft {
  title: string;
  conclusion: string;
  body: string;
  evidenceCardIds: EntityId[];
  visualNote: string;
  speakerNotes: string;
  estimatedSeconds: number;
  rubricCriterionIds: EntityId[];
  claims: MutableClaim[];
}

const EMPTY_PAGE_DRAFT: PageDraft = {
  title: '',
  conclusion: '',
  body: '',
  evidenceCardIds: [],
  visualNote: '',
  speakerNotes: '',
  estimatedSeconds: 0,
  rubricCriterionIds: [],
  claims: [],
};

const VERIFICATION_LABELS: Readonly<
  Record<DraftVerificationCheck['code'], string>
> = {
  SOURCE_TRACEABLE: '来源可追溯',
  CITATION_EXISTS: '引用存在',
  UNSUBSTANTIATED_CLAIM: '主张有证据',
  MUST_INCLUDE: '必含内容',
  MUST_AVOID: '禁止内容',
  LENGTH_TARGET: '篇幅目标',
  PRESENTATION_DURATION: '演讲时长',
  RUBRIC_COVERAGE: '评分标准覆盖',
  DUPLICATE_CLAIM: '重复主张',
  NUMERIC_CONSISTENCY: '数字一致性',
};

export function draftStageActionReducer(
  _state: DraftStageActionState,
  action: DraftStageAction,
): DraftStageActionState {
  if (action.type === 'start') {
    return {
      status: 'saving',
      actionKey: action.actionKey,
      message: null,
    };
  }
  if (action.type === 'fail') {
    return {
      status: 'error',
      actionKey: null,
      message: action.message,
    };
  }
  return {
    status: 'idle',
    actionKey: null,
    message: null,
  };
}

export async function executeDraftStageAction<T>(
  callback: (input: T) => Promise<void>,
  input: T,
): Promise<DraftStageActionState> {
  try {
    await callback(input);
    return {
      status: 'idle',
      actionKey: null,
      message: null,
    };
  } catch (error) {
    return {
      status: 'error',
      actionKey: null,
      message:
        error instanceof Error && error.message.trim().length > 0
          ? error.message
          : '初稿未保存，请重试。',
    };
  }
}

export function summarizeDraftVerification(
  checks: readonly Pick<DraftVerificationCheck, 'outcome'>[],
): DraftVerificationSummary {
  return {
    passed: checks.filter((check) => check.outcome === 'pass').length,
    warnings: checks.filter((check) => check.outcome === 'warning').length,
    failed: checks.filter((check) => check.outcome === 'fail').length,
    notRun: checks.filter((check) => check.outcome === 'not_run').length,
  };
}

export function pageIdForArtifactPath(
  artifactPath: string,
  pages: readonly DraftStagePage[],
): string | null {
  const match = /^draft\.pages\[(\d+)\]/u.exec(artifactPath);
  if (match === null) {
    return null;
  }
  const pageIndex = Number(match[1]);
  return pages[pageIndex]?.page.id ?? null;
}

export function DraftStage({
  project,
  pages,
  onInsertPage,
  onUpdatePage,
  onDeletePage,
  onReorderPage,
  onSetPageLocked,
}: DraftStageProps) {
  const activeOutline =
    project.outlines.find(
      (outline) => outline.id === project.activeOutlineId,
    ) ??
    project.outlines.find(
      (outline) =>
        outline.status === 'selected' || outline.status === 'locked',
    ) ??
    null;
  const [pageDrafts, setPageDrafts] = useState<
    Readonly<Record<string, PageDraft>>
  >(() => buildPageDrafts(pages));
  const [newPageDraft, setNewPageDraft] =
    useState<PageDraft>(EMPTY_PAGE_DRAFT);
  const [newPageNodeId, setNewPageNodeId] = useState<EntityId>(
    activeOutline?.nodes[0]?.id ?? '',
  );
  const [pendingFocusPageId, setPendingFocusPageId] =
    useState<string | null>(null);
  const [actionState, dispatchAction] = useReducer(
    draftStageActionReducer,
    {
      status: 'idle',
      actionKey: null,
      message: null,
    },
  );

  useEffect(() => {
    setPageDrafts(buildPageDrafts(pages));
  }, [pages]);

  useEffect(() => {
    if (
      activeOutline !== null &&
      !activeOutline.nodes.some((node) => node.id === newPageNodeId)
    ) {
      setNewPageNodeId(activeOutline.nodes[0]?.id ?? '');
    }
  }, [activeOutline, newPageNodeId]);

  useEffect(() => {
    if (pendingFocusPageId === null) {
      return;
    }
    const element = document.getElementById(
      draftPageElementId(pendingFocusPageId),
    );
    if (element === null) {
      return;
    }
    element.focus();
    element.scrollIntoView({ block: 'nearest' });
    setPendingFocusPageId(null);
  }, [pendingFocusPageId]);

  const usableEvidence = useMemo(
    () =>
      project.evidenceCards.filter(
        (evidence) => evidence.status !== 'rejected',
      ),
    [project.evidenceCards],
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
  const persistedPages = useMemo(
    () => pages.map((record) => record.page),
    [pages],
  );
  const verificationChecks = useMemo(
    () =>
      activeOutline === null
        ? []
        : verifyDraft({
            pages: persistedPages,
            taskDefinition: project.taskDefinition,
            evidenceCards: project.evidenceCards,
          }),
    [
      activeOutline,
      persistedPages,
      project.evidenceCards,
      project.taskDefinition,
    ],
  );
  const verificationSummary =
    summarizeDraftVerification(verificationChecks);
  const saving = actionState.status === 'saving';

  const runAction = async <T,>(
    actionKey: string,
    callback: (input: T) => Promise<void>,
    input: T,
    afterSuccess?: () => void,
  ) => {
    dispatchAction({ type: 'start', actionKey });
    const result = await executeDraftStageAction(callback, input);
    if (result.status === 'error') {
      dispatchAction({
        type: 'fail',
        message: result.message ?? '初稿未保存，请重试。',
      });
      return;
    }
    dispatchAction({ type: 'succeed' });
    afterSuccess?.();
  };

  const updatePageDraft = (
    pageId: string,
    updater: (current: PageDraft) => PageDraft,
  ) => {
    setPageDrafts((current) => {
      const draft = current[pageId];
      if (draft === undefined) {
        return current;
      }
      return {
        ...current,
        [pageId]: updater(draft),
      };
    });
  };

  const handleInsertPage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      activeOutline === null ||
      newPageNodeId.length === 0 ||
      !pageDraftIsSavable(newPageDraft, usableEvidence) ||
      saving
    ) {
      return;
    }
    const input: InsertDraftPageInput = {
      outlineId: activeOutline.id,
      outlineNodeId: newPageNodeId,
      index: pages.length,
      page: pagePayload(newPageDraft, usableEvidence),
    };
    void runAction('insert-page', onInsertPage, input, () => {
      setNewPageDraft(EMPTY_PAGE_DRAFT);
    });
  };

  return (
    <section
      aria-labelledby="draft-stage-title"
      className="draft-stage"
    >
      <header className="draft-stage__header">
        <div>
          <span className="draft-stage__kicker">05 / EDIT + VERIFY</span>
          <h2 id="draft-stage-title">编辑页面并核验</h2>
          <p>
            按结构节点编写页面；核验结果只来自当前已保存页面和确定性规则。
          </p>
        </div>
        <div className="draft-stage__metrics" aria-label="页面数量">
          <strong>{String(pages.length)}</strong>
          <span>已保存页面</span>
        </div>
      </header>

      {activeOutline === null ? (
        <div className="draft-stage__empty">
          <span aria-hidden="true">◇</span>
          <div>
            <strong>尚未选择结构方案</strong>
            <p>先在结构阶段选择或锁定一个方案，再开始编写页面。</p>
          </div>
        </div>
      ) : (
        <>
          <section
            aria-labelledby="draft-outline-title"
            className="draft-outline"
          >
            <header>
              <div>
                <span>
                  {activeOutline.status === 'locked'
                    ? '结构已锁定'
                    : '结构已选择'}
                </span>
                <h3 id="draft-outline-title">{activeOutline.title}</h3>
              </div>
              <small>
                {String(activeOutline.nodes.length)} 个节点 ·{' '}
                {String(pages.length)} 个页面
              </small>
            </header>
            <ol>
              {activeOutline.nodes.map((node, index) => {
                const nodePages = pages.filter(
                  (record) => record.outlineNodeId === node.id,
                );
                return (
                  <li key={node.id}>
                    <button
                      onClick={() => {
                        setNewPageNodeId(node.id);
                        const firstPage = nodePages[0]?.page;
                        if (firstPage !== undefined) {
                          setPendingFocusPageId(firstPage.id);
                        }
                      }}
                      type="button"
                    >
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      <span>
                        <strong>{node.title}</strong>
                        <small>{node.conclusion}</small>
                      </span>
                      <em>{String(nodePages.length)} 页</em>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>

          {usableEvidence.length === 0 ? (
            <div className="draft-stage__warning" role="status">
              <span aria-hidden="true">◇</span>
              <div>
                <strong>项目尚无证据</strong>
                <p>不能创建无来源页面；请先在证据阶段保存真实证据。</p>
              </div>
            </div>
          ) : null}

          {actionState.status === 'error' ? (
            <div className="draft-stage__error" role="alert">
              <strong>初稿未保存</strong>
              <span>{actionState.message}</span>
            </div>
          ) : null}

          <div className="draft-stage__workspace">
            <section
              aria-labelledby="draft-pages-title"
              className="draft-page-editor"
            >
              <header className="draft-stage__subheader">
                <div>
                  <span>PAGES</span>
                  <h3 id="draft-pages-title">页面编辑</h3>
                </div>
                <small>锁定页面后不可改写、删除或排序</small>
              </header>

              {pages.length === 0 ? (
                <div className="draft-stage__empty">
                  <span aria-hidden="true">◇</span>
                  <div>
                    <strong>当前结构还没有页面</strong>
                    <p>使用下方表单为结构节点插入第一个页面。</p>
                  </div>
                </div>
              ) : (
                <ol className="draft-page-list">
                  {pages.map((record, index) => {
                    const { page } = record;
                    const draft =
                      pageDrafts[page.id] ?? pageDraftFromPage(page);
                    const node = activeOutline.nodes.find(
                      (candidate) =>
                        candidate.id === record.outlineNodeId,
                    );
                    const saveKey = `update:${page.id}`;
                    return (
                      <li key={page.id}>
                        <article
                          className={
                            page.locked
                              ? 'draft-page-card is-locked'
                              : 'draft-page-card'
                          }
                          id={draftPageElementId(page.id)}
                          tabIndex={-1}
                        >
                          <header>
                            <div>
                              <span>PAGE</span>
                              <strong>
                                {String(index + 1).padStart(2, '0')}
                              </strong>
                            </div>
                            <div>
                              <span>
                                {node?.title ?? '结构节点不存在'}
                              </span>
                              <small>
                                {page.locked
                                  ? '页面已锁定'
                                  : '页面可编辑'}
                              </small>
                            </div>
                          </header>

                          <fieldset disabled={page.locked || saving}>
                            <legend className="sr-only">
                              编辑页面 {String(index + 1)}
                            </legend>
                            <PageDraftFields
                              draft={draft}
                              evidenceCards={usableEvidence}
                              filesById={filesById}
                              idPrefix={`page-${page.id}`}
                              onChange={(nextDraft) => {
                                setPageDrafts((current) => ({
                                  ...current,
                                  [page.id]: nextDraft,
                                }));
                              }}
                              project={project}
                            />
                          </fieldset>

                          <footer>
                            <div className="draft-page-card__move">
                              <button
                                className="draft-stage__button draft-stage__button--quiet"
                                disabled={
                                  page.locked || saving || index === 0
                                }
                                onClick={() => {
                                  void runAction(
                                    `move-up:${page.id}`,
                                    onReorderPage,
                                    {
                                      outlineId: activeOutline.id,
                                      pageId: page.id,
                                      targetIndex: index - 1,
                                    },
                                  );
                                }}
                                type="button"
                              >
                                上移
                              </button>
                              <button
                                className="draft-stage__button draft-stage__button--quiet"
                                disabled={
                                  page.locked ||
                                  saving ||
                                  index === pages.length - 1
                                }
                                onClick={() => {
                                  void runAction(
                                    `move-down:${page.id}`,
                                    onReorderPage,
                                    {
                                      outlineId: activeOutline.id,
                                      pageId: page.id,
                                      targetIndex: index + 1,
                                    },
                                  );
                                }}
                                type="button"
                              >
                                下移
                              </button>
                            </div>
                            <div className="draft-page-card__actions">
                              <button
                                className="draft-stage__button draft-stage__button--danger"
                                disabled={page.locked || saving}
                                onClick={() => {
                                  void runAction(
                                    `delete:${page.id}`,
                                    onDeletePage,
                                    {
                                      outlineId: activeOutline.id,
                                      pageId: page.id,
                                    },
                                  );
                                }}
                                type="button"
                              >
                                删除页面
                              </button>
                              <button
                                className="draft-stage__button draft-stage__button--quiet"
                                disabled={saving}
                                onClick={() => {
                                  void runAction(
                                    `lock:${page.id}`,
                                    onSetPageLocked,
                                    {
                                      outlineId: activeOutline.id,
                                      pageId: page.id,
                                      locked: !page.locked,
                                    },
                                  );
                                }}
                                type="button"
                              >
                                {page.locked ? '解锁页面' : '锁定页面'}
                              </button>
                              <button
                                className="draft-stage__button"
                                disabled={
                                  page.locked ||
                                  saving ||
                                  !pageDraftIsSavable(
                                    draft,
                                    usableEvidence,
                                  )
                                }
                                onClick={() => {
                                  void runAction(
                                    saveKey,
                                    onUpdatePage,
                                    {
                                      outlineId: activeOutline.id,
                                      pageId: page.id,
                                      patch: pagePayload(
                                        draft,
                                        usableEvidence,
                                      ),
                                    },
                                  );
                                }}
                                type="button"
                              >
                                {actionState.actionKey === saveKey
                                  ? '保存中…'
                                  : '保存页面'}
                              </button>
                            </div>
                          </footer>
                          {page.locked ? (
                            <p className="draft-page-card__lock-note">
                              页面已锁定；锁定后不可改写、删除或排序。
                            </p>
                          ) : null}
                        </article>
                      </li>
                    );
                  })}
                </ol>
              )}

              <form
                aria-busy={actionState.actionKey === 'insert-page'}
                className="draft-insert-page"
                onSubmit={handleInsertPage}
              >
                <header className="draft-stage__subheader">
                  <div>
                    <span>INSERT PAGE</span>
                    <h3>插入页面</h3>
                  </div>
                  <small>选择结构节点并绑定至少一条证据</small>
                </header>
                <fieldset disabled={saving}>
                  <legend className="sr-only">新页面内容</legend>
                  <div className="draft-stage__field">
                    <label htmlFor="new-page-node">对应结构节点</label>
                    <select
                      id="new-page-node"
                      onChange={(event) => {
                        setNewPageNodeId(event.currentTarget.value);
                      }}
                      value={newPageNodeId}
                    >
                      {activeOutline.nodes.map((node, index) => (
                        <option key={node.id} value={node.id}>
                          {String(index + 1).padStart(2, '0')} · {node.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <PageDraftFields
                    draft={newPageDraft}
                    evidenceCards={usableEvidence}
                    filesById={filesById}
                    idPrefix="new-page"
                    onChange={setNewPageDraft}
                    project={project}
                  />
                </fieldset>
                <button
                  className="draft-stage__button draft-stage__button--insert"
                  disabled={
                    saving ||
                    newPageNodeId.length === 0 ||
                    !pageDraftIsSavable(
                      newPageDraft,
                      usableEvidence,
                    )
                  }
                  type="submit"
                >
                  {actionState.actionKey === 'insert-page'
                    ? '插入中…'
                    : '插入页面'}
                </button>
              </form>
            </section>

            <aside
              aria-labelledby="draft-verification-title"
              className="draft-verification"
            >
              <header className="draft-stage__subheader">
                <div>
                  <span>RULE CHECKS</span>
                  <h3 id="draft-verification-title">确定性核验</h3>
                </div>
                <small>基于当前已保存页面</small>
              </header>
              <dl className="draft-verification__summary">
                <div>
                  <dt>通过</dt>
                  <dd>{String(verificationSummary.passed)}</dd>
                </div>
                <div>
                  <dt>警告</dt>
                  <dd>{String(verificationSummary.warnings)}</dd>
                </div>
                <div>
                  <dt>失败</dt>
                  <dd>{String(verificationSummary.failed)}</dd>
                </div>
                <div>
                  <dt>未运行</dt>
                  <dd>{String(verificationSummary.notRun)}</dd>
                </div>
              </dl>
              <ol className="draft-verification__checks">
                {verificationChecks.map((check, index) => {
                  const pageId = pageIdForArtifactPath(
                    check.artifactPath,
                    pages,
                  );
                  return (
                    <li
                      className={`is-${check.severity}`}
                      key={`${check.code}-${check.artifactPath}-${String(index)}`}
                    >
                      <article>
                        <header>
                          <strong>
                            {VERIFICATION_LABELS[check.code]}
                          </strong>
                          <span>{outcomeLabel(check.outcome)}</span>
                        </header>
                        <p>{check.message}</p>
                        <code>{check.artifactPath}</code>
                        <div>
                          <strong>修复提示</strong>
                          <span>{check.fixHint}</span>
                        </div>
                        <button
                          className="draft-stage__button draft-stage__button--quiet"
                          disabled={pageId === null}
                          onClick={() => {
                            if (pageId !== null) {
                              setPendingFocusPageId(pageId);
                            }
                          }}
                          type="button"
                        >
                          定位问题
                        </button>
                      </article>
                    </li>
                  );
                })}
              </ol>
            </aside>
          </div>
        </>
      )}
    </section>
  );
}

interface PageDraftFieldsProps {
  draft: PageDraft;
  evidenceCards: readonly EvidenceCard[];
  filesById: ReadonlyMap<EntityId, Project['sourceFiles'][number]>;
  idPrefix: string;
  project: Project;
  onChange(nextDraft: PageDraft): void;
}

function PageDraftFields({
  draft,
  evidenceCards,
  filesById,
  idPrefix,
  project,
  onChange,
}: PageDraftFieldsProps) {
  const update = <K extends keyof PageDraft>(
    key: K,
    value: PageDraft[K],
  ) => {
    onChange({ ...draft, [key]: value });
  };

  return (
    <div className="draft-page-fields">
      <div className="draft-stage__field">
        <label htmlFor={`${idPrefix}-title`}>页面标题</label>
        <input
          id={`${idPrefix}-title`}
          maxLength={300}
          onChange={(event) => {
            update('title', event.currentTarget.value);
          }}
          required
          value={draft.title}
        />
      </div>
      <div className="draft-stage__field">
        <label htmlFor={`${idPrefix}-conclusion`}>页面结论</label>
        <textarea
          id={`${idPrefix}-conclusion`}
          maxLength={4_000}
          onChange={(event) => {
            update('conclusion', event.currentTarget.value);
          }}
          rows={2}
          value={draft.conclusion}
        />
      </div>
      <div className="draft-stage__field draft-stage__field--wide">
        <label htmlFor={`${idPrefix}-body`}>正文 / 要点</label>
        <textarea
          id={`${idPrefix}-body`}
          maxLength={20_000}
          onChange={(event) => {
            update('body', event.currentTarget.value);
          }}
          required
          rows={5}
          value={draft.body}
        />
      </div>
      <div className="draft-stage__field">
        <label htmlFor={`${idPrefix}-visual-note`}>视觉说明</label>
        <textarea
          id={`${idPrefix}-visual-note`}
          maxLength={4_000}
          onChange={(event) => {
            update('visualNote', event.currentTarget.value);
          }}
          rows={3}
          value={draft.visualNote}
        />
      </div>
      <div className="draft-stage__field">
        <label htmlFor={`${idPrefix}-speaker-notes`}>讲述备注</label>
        <textarea
          id={`${idPrefix}-speaker-notes`}
          maxLength={10_000}
          onChange={(event) => {
            update('speakerNotes', event.currentTarget.value);
          }}
          rows={3}
          value={draft.speakerNotes}
        />
      </div>
      <div className="draft-stage__field">
        <label htmlFor={`${idPrefix}-seconds`}>预计时长（秒）</label>
        <input
          id={`${idPrefix}-seconds`}
          min="0"
          onChange={(event) => {
            update(
              'estimatedSeconds',
              Number(event.currentTarget.value),
            );
          }}
          type="number"
          value={draft.estimatedSeconds}
        />
      </div>

      <fieldset className="draft-binding-group">
        <legend>页面证据 IDs</legend>
        {evidenceCards.length === 0 ? (
          <div className="draft-binding-empty">项目尚无证据。</div>
        ) : (
          <div className="draft-evidence-options">
            {evidenceCards.map((evidence) => {
              const inputId = `${idPrefix}-evidence-${evidence.id}`;
              const sourceFile = filesById.get(evidence.sourceFileId);
              return (
                <label key={evidence.id} htmlFor={inputId}>
                  <input
                    checked={draft.evidenceCardIds.includes(evidence.id)}
                    id={inputId}
                    onChange={() => {
                      update(
                        'evidenceCardIds',
                        toggleValue(
                          draft.evidenceCardIds,
                          evidence.id,
                        ),
                      );
                    }}
                    type="checkbox"
                  />
                  <span>
                    <strong>{evidence.quote}</strong>
                    <small>
                      {sourceFile?.fileName ?? '来源文件不存在'} · 第{' '}
                      {String(evidence.pageNumber)} 页
                    </small>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </fieldset>

      <fieldset className="draft-binding-group">
        <legend>Rubric IDs</legend>
        {project.taskDefinition.rubric.length === 0 ? (
          <div className="draft-binding-empty">任务没有评分标准。</div>
        ) : (
          <div className="draft-rubric-options">
            {project.taskDefinition.rubric.map((criterion) => {
              const inputId = `${idPrefix}-rubric-${criterion.id}`;
              return (
                <label key={criterion.id} htmlFor={inputId}>
                  <input
                    checked={draft.rubricCriterionIds.includes(
                      criterion.id,
                    )}
                    id={inputId}
                    onChange={() => {
                      update(
                        'rubricCriterionIds',
                        toggleValue(
                          draft.rubricCriterionIds,
                          criterion.id,
                        ),
                      );
                    }}
                    type="checkbox"
                  />
                  <span>
                    {criterion.title}{' '}
                    <small>{String(criterion.weightPercent)}%</small>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </fieldset>

      <section
        aria-labelledby={`${idPrefix}-claims-title`}
        className="draft-claims"
      >
        <header>
          <div>
            <span>CLAIMS</span>
            <h4 id={`${idPrefix}-claims-title`}>结构化主张</h4>
          </div>
          <button
            className="draft-stage__button draft-stage__button--quiet"
            onClick={() => {
              update('claims', [
                ...draft.claims,
                {
                  id: nextClientClaimId(idPrefix),
                  text: '',
                  evidenceCardIds: [],
                  numericFacts: [],
                },
              ]);
            }}
            type="button"
          >
            添加主张
          </button>
        </header>
        {draft.claims.length === 0 ? (
          <div className="draft-binding-empty">
            尚未登记结构化主张；核验会提示无证据主张。
          </div>
        ) : (
          <ol>
            {draft.claims.map((claim, claimIndex) => (
              <li key={claim.id}>
                <article className="draft-claim-card">
                  <header>
                    <strong>主张 {String(claimIndex + 1)}</strong>
                    <button
                      className="draft-stage__text-button"
                      onClick={() => {
                        update(
                          'claims',
                          draft.claims.filter(
                            (candidate) => candidate.id !== claim.id,
                          ),
                        );
                      }}
                      type="button"
                    >
                      删除主张
                    </button>
                  </header>
                  <div className="draft-stage__field">
                    <label htmlFor={`${idPrefix}-claim-${claim.id}`}>
                      主张文本
                    </label>
                    <textarea
                      id={`${idPrefix}-claim-${claim.id}`}
                      onChange={(event) => {
                        updateClaim(
                          draft,
                          claim.id,
                          { text: event.currentTarget.value },
                          onChange,
                        );
                      }}
                      rows={2}
                      value={claim.text}
                    />
                  </div>
                  <fieldset>
                    <legend>主张证据 IDs</legend>
                    <div className="draft-claim-evidence">
                      {draft.evidenceCardIds.map((evidenceId) => {
                        const evidence = evidenceCards.find(
                          (candidate) => candidate.id === evidenceId,
                        );
                        const inputId =
                          `${idPrefix}-claim-${claim.id}-${evidenceId}`;
                        return (
                          <label key={evidenceId} htmlFor={inputId}>
                            <input
                              checked={claim.evidenceCardIds.includes(
                                evidenceId,
                              )}
                              id={inputId}
                              onChange={() => {
                                updateClaim(
                                  draft,
                                  claim.id,
                                  {
                                    evidenceCardIds: toggleValue(
                                      claim.evidenceCardIds,
                                      evidenceId,
                                    ),
                                  },
                                  onChange,
                                );
                              }}
                              type="checkbox"
                            />
                            <span>
                              {evidence?.quote ?? '证据不存在'}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                  <section className="draft-numeric-facts">
                    <header>
                      <strong>数值事实</strong>
                      <button
                        className="draft-stage__text-button"
                        onClick={() => {
                          updateClaim(
                            draft,
                            claim.id,
                            {
                              numericFacts: [
                                ...claim.numericFacts,
                                { metric: '', value: 0, unit: '' },
                              ],
                            },
                            onChange,
                          );
                        }}
                        type="button"
                      >
                        添加数值
                      </button>
                    </header>
                    {claim.numericFacts.map((fact, factIndex) => (
                      <div
                        className="draft-numeric-fact"
                        key={`${claim.id}-${String(factIndex)}`}
                      >
                        <label>
                          <span>指标</span>
                          <input
                            onChange={(event) => {
                              updateNumericFact(
                                draft,
                                claim.id,
                                factIndex,
                                {
                                  ...fact,
                                  metric: event.currentTarget.value,
                                },
                                onChange,
                              );
                            }}
                            value={fact.metric}
                          />
                        </label>
                        <label>
                          <span>数值</span>
                          <input
                            onChange={(event) => {
                              updateNumericFact(
                                draft,
                                claim.id,
                                factIndex,
                                {
                                  ...fact,
                                  value: Number(
                                    event.currentTarget.value,
                                  ),
                                },
                                onChange,
                              );
                            }}
                            type="number"
                            value={fact.value}
                          />
                        </label>
                        <label>
                          <span>单位</span>
                          <input
                            onChange={(event) => {
                              updateNumericFact(
                                draft,
                                claim.id,
                                factIndex,
                                {
                                  ...fact,
                                  unit: event.currentTarget.value,
                                },
                                onChange,
                              );
                            }}
                            value={fact.unit}
                          />
                        </label>
                        <button
                          aria-label={`删除数值事实 ${String(factIndex + 1)}`}
                          className="draft-stage__text-button"
                          onClick={() => {
                            updateClaim(
                              draft,
                              claim.id,
                              {
                                numericFacts:
                                  claim.numericFacts.filter(
                                    (_, index) => index !== factIndex,
                                  ),
                              },
                              onChange,
                            );
                          }}
                          type="button"
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </section>
                </article>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function buildPageDrafts(
  pages: readonly DraftStagePage[],
): Readonly<Record<string, PageDraft>> {
  return Object.fromEntries(
    pages.map(({ page }) => [page.id, pageDraftFromPage(page)]),
  );
}

function pageDraftFromPage(page: DraftPage): PageDraft {
  return {
    title: page.title,
    conclusion: page.conclusion,
    body: page.body,
    evidenceCardIds: [...page.evidenceCardIds],
    visualNote: page.visualNote,
    speakerNotes: page.speakerNotes,
    estimatedSeconds: page.estimatedSeconds,
    rubricCriterionIds: [...page.rubricCriterionIds],
    claims: page.claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
      evidenceCardIds: [...claim.evidenceCardIds],
      numericFacts: claim.numericFacts.map((fact) => ({ ...fact })),
    })),
  };
}

function pagePayload(
  draft: PageDraft,
  evidenceCards: readonly EvidenceCard[],
): Omit<DraftPage, 'id' | 'locked'> {
  const evidenceById = new Map(
    evidenceCards.map((evidence) => [evidence.id, evidence]),
  );
  return {
    title: draft.title.trim(),
    conclusion: draft.conclusion.trim(),
    body: draft.body.trim(),
    evidenceCardIds: [...draft.evidenceCardIds],
    citations: draft.evidenceCardIds.map((evidenceCardId) => ({
      evidenceCardId,
      label: evidenceById.get(evidenceCardId)?.citation.trim() ?? '',
    })),
    visualNote: draft.visualNote.trim(),
    speakerNotes: draft.speakerNotes.trim(),
    estimatedSeconds: draft.estimatedSeconds,
    rubricCriterionIds: [...draft.rubricCriterionIds],
    claims: draft.claims.map((claim) => ({
      id: claim.id,
      text: claim.text.trim(),
      evidenceCardIds: [...claim.evidenceCardIds],
      numericFacts: claim.numericFacts.map((fact) => ({
        metric: fact.metric.trim(),
        value: fact.value,
        unit: fact.unit.trim(),
      })),
    })),
  };
}

function pageDraftIsSavable(
  draft: PageDraft,
  evidenceCards: readonly EvidenceCard[],
): boolean {
  const evidenceById = new Map(
    evidenceCards.map((evidence) => [evidence.id, evidence]),
  );
  return (
    draft.title.trim().length > 0 &&
    draft.body.trim().length > 0 &&
    draft.evidenceCardIds.length > 0 &&
    draft.evidenceCardIds.every(
      (id) => (evidenceById.get(id)?.citation.trim().length ?? 0) > 0,
    ) &&
    Number.isSafeInteger(draft.estimatedSeconds) &&
    draft.estimatedSeconds >= 0 &&
    draft.claims.every(
      (claim) =>
        claim.text.trim().length > 0 &&
        claim.evidenceCardIds.every((id) =>
          draft.evidenceCardIds.includes(id),
        ) &&
        claim.numericFacts.every(
          (fact) =>
            fact.metric.trim().length > 0 &&
            Number.isFinite(fact.value) &&
            fact.unit.trim().length > 0,
        ),
    )
  );
}

function updateClaim(
  draft: PageDraft,
  claimId: string,
  patch: Partial<MutableClaim>,
  onChange: (nextDraft: PageDraft) => void,
): void {
  onChange({
    ...draft,
    claims: draft.claims.map((claim) =>
      claim.id === claimId ? { ...claim, ...patch } : claim,
    ),
  });
}

function updateNumericFact(
  draft: PageDraft,
  claimId: string,
  factIndex: number,
  fact: MutableNumericFact,
  onChange: (nextDraft: PageDraft) => void,
): void {
  onChange({
    ...draft,
    claims: draft.claims.map((claim) =>
      claim.id === claimId
        ? {
            ...claim,
            numericFacts: claim.numericFacts.map((current, index) =>
              index === factIndex ? fact : current,
            ),
          }
        : claim,
    ),
  });
}

function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

let clientClaimSequence = 0;

function nextClientClaimId(idPrefix: string): string {
  clientClaimSequence += 1;
  return `${idPrefix}-claim-${String(clientClaimSequence)}`;
}

function draftPageElementId(pageId: string): string {
  return `draft-page-${pageId}`;
}

function outcomeLabel(
  outcome: DraftVerificationCheck['outcome'],
): string {
  if (outcome === 'pass') {
    return '通过';
  }
  if (outcome === 'warning') {
    return '警告';
  }
  if (outcome === 'fail') {
    return '失败';
  }
  return '未运行';
}

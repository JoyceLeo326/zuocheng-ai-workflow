import {
  useEffect,
  useMemo,
  useReducer,
  useState,
  type FormEvent,
} from 'react';
import type {
  EntityId,
  Outline,
  OutlineNode,
  Project,
} from './project-model.js';
import './outline-stage.css';

export interface CreateOutlineInput {
  title: string;
}

export interface AddOutlineNodeInput {
  outlineId: EntityId;
  title: string;
  conclusion: string;
  evidenceCardIds: EntityId[];
  coveredRequirements: string[];
  rubricCriterionIds: EntityId[];
}

export interface UpdateOutlineNodeInput {
  outlineId: EntityId;
  nodeId: EntityId;
  patch: {
    title?: string;
    conclusion?: string;
    evidenceCardIds?: EntityId[];
    coveredRequirements?: string[];
    rubricCriterionIds?: EntityId[];
    locked?: boolean;
  };
}

export interface DeleteOutlineNodeInput {
  outlineId: EntityId;
  nodeId: EntityId;
}

export interface ReorderOutlineNodeInput {
  outlineId: EntityId;
  nodeId: EntityId;
  targetPosition: number;
}

export interface OutlineIdentityInput {
  outlineId: EntityId;
}

export interface OutlineStageCallbacks {
  onCreateOutline(input: CreateOutlineInput): Promise<void>;
  onAddNode(input: AddOutlineNodeInput): Promise<void>;
  onUpdateNode(input: UpdateOutlineNodeInput): Promise<void>;
  onDeleteNode(input: DeleteOutlineNodeInput): Promise<void>;
  onReorderNode(input: ReorderOutlineNodeInput): Promise<void>;
  onLockOutline(input: OutlineIdentityInput): Promise<void>;
  onSelectOutline(input: OutlineIdentityInput): Promise<void>;
}

export interface OutlineStageProps extends OutlineStageCallbacks {
  project: Project;
  outlines: readonly Outline[];
}

export interface OutlineSummary {
  nodeCount: number;
  evidenceCount: number;
  requirementCovered: number;
  requirementTotal: number;
  rubricCovered: number;
  rubricTotal: number;
}

export interface OutlineStageActionState {
  status: 'idle' | 'saving' | 'error';
  actionKey: string | null;
  message: string | null;
}

export type OutlineStageAction =
  | { type: 'start'; actionKey: string }
  | { type: 'succeed' }
  | { type: 'fail'; message: string };

interface NodeDraft {
  title: string;
  conclusion: string;
  evidenceCardIds: EntityId[];
  coveredRequirements: string[];
  rubricCriterionIds: EntityId[];
}

const EMPTY_NODE_DRAFT: NodeDraft = {
  title: '',
  conclusion: '',
  evidenceCardIds: [],
  coveredRequirements: [],
  rubricCriterionIds: [],
};

export function summarizeOutline(
  outline: Outline,
  project: Project,
): OutlineSummary {
  const evidenceIds = new Set(
    outline.nodes.flatMap((node) => node.evidenceCardIds),
  );
  const requirements = new Set(
    outline.nodes.flatMap((node) => node.coveredRequirements),
  );
  const rubricIds = new Set(
    outline.nodes.flatMap((node) => node.rubricCriterionIds),
  );
  return {
    nodeCount: outline.nodes.length,
    evidenceCount: evidenceIds.size,
    requirementCovered: project.taskDefinition.mustInclude.filter(
      (requirement) => requirements.has(requirement),
    ).length,
    requirementTotal: project.taskDefinition.mustInclude.length,
    rubricCovered: project.taskDefinition.rubric.filter((criterion) =>
      rubricIds.has(criterion.id),
    ).length,
    rubricTotal: project.taskDefinition.rubric.length,
  };
}

export function outlineStageActionReducer(
  _state: OutlineStageActionState,
  action: OutlineStageAction,
): OutlineStageActionState {
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

export async function executeOutlineStageAction<T>(
  callback: (input: T) => Promise<void>,
  input: T,
): Promise<OutlineStageActionState> {
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
          : '结构未保存，请重试。',
    };
  }
}

export async function selectAndLockOutline(
  outline: Outline,
  callbacks: Pick<
    OutlineStageCallbacks,
    'onSelectOutline' | 'onLockOutline'
  >,
): Promise<void> {
  const input = { outlineId: outline.id };
  if (outline.status === 'draft') {
    await callbacks.onSelectOutline(input);
  }
  await callbacks.onLockOutline(input);
}

export function OutlineStage({
  project,
  outlines,
  onCreateOutline,
  onAddNode,
  onUpdateNode,
  onDeleteNode,
  onReorderNode,
  onLockOutline,
  onSelectOutline,
}: OutlineStageProps) {
  const initialOutlineId =
    outlines.find((outline) => outline.id === project.activeOutlineId)
      ?.id ??
    outlines[0]?.id ??
    null;
  const [activeOutlineId, setActiveOutlineId] =
    useState<EntityId | null>(initialOutlineId);
  const [newOutlineTitle, setNewOutlineTitle] = useState('');
  const [nodeDrafts, setNodeDrafts] = useState<
    Readonly<Record<EntityId, NodeDraft>>
  >(() => buildNodeDrafts(outlines));
  const [newNodeDraft, setNewNodeDraft] =
    useState<NodeDraft>(EMPTY_NODE_DRAFT);
  const [actionState, dispatchAction] = useReducer(
    outlineStageActionReducer,
    {
      status: 'idle',
      actionKey: null,
      message: null,
    },
  );

  useEffect(() => {
    setNodeDrafts(buildNodeDrafts(outlines));
    if (
      activeOutlineId !== null &&
      outlines.some((outline) => outline.id === activeOutlineId)
    ) {
      return;
    }
    setActiveOutlineId(
      outlines.find(
        (outline) => outline.id === project.activeOutlineId,
      )?.id ??
        outlines[0]?.id ??
        null,
    );
  }, [activeOutlineId, outlines, project.activeOutlineId]);

  const activeOutline =
    outlines.find((outline) => outline.id === activeOutlineId) ?? null;
  const evidenceCards = useMemo(
    () =>
      project.evidenceCards.filter(
        (evidence) =>
          evidence.status === 'verified' &&
          evidence.confirmationStatus === 'confirmed' &&
          evidence.userConfirmedAt !== null &&
          evidence.userConfirmedAt !== undefined,
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
  const outlineLocked =
    activeOutline !== null &&
    (activeOutline.status === 'locked' ||
      activeOutline.status === 'archived' ||
      activeOutline.lockedAt !== null);
  const activeSummary =
    activeOutline === null
      ? null
      : summarizeOutline(activeOutline, project);
  const evidenceById = new Map(
    evidenceCards.map((evidence) => [evidence.id, evidence]),
  );
  const activeOutlineReadyToLock =
    activeOutline !== null &&
    activeSummary !== null &&
    activeOutline.nodes.length > 0 &&
    activeOutline.nodes.every(
      (node) =>
        node.evidenceCardIds.length > 0 &&
        node.evidenceCardIds.every((evidenceId) => {
          const evidence = evidenceById.get(evidenceId);
          return (
            evidence?.status === 'verified' &&
            evidence.confirmationStatus === 'confirmed' &&
            evidence.userConfirmedAt !== null &&
            evidence.userConfirmedAt !== undefined
          );
        }),
    ) &&
    activeSummary.requirementCovered ===
      activeSummary.requirementTotal &&
    activeSummary.rubricCovered === activeSummary.rubricTotal;
  const saving = actionState.status === 'saving';

  const runAction = async <T,>(
    actionKey: string,
    callback: (input: T) => Promise<void>,
    input: T,
    afterSuccess?: () => void,
  ) => {
    dispatchAction({ type: 'start', actionKey });
    const result = await executeOutlineStageAction(callback, input);
    if (result.status === 'error') {
      dispatchAction({
        type: 'fail',
        message: result.message ?? '结构未保存，请重试。',
      });
      return;
    }
    dispatchAction({ type: 'succeed' });
    afterSuccess?.();
  };

  const handleCreateOutline = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = newOutlineTitle.trim();
    if (title.length === 0 || saving) {
      return;
    }
    void runAction(
      'create-outline',
      onCreateOutline,
      { title },
      () => {
        setNewOutlineTitle('');
      },
    );
  };

  const handleAddNode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      activeOutline === null ||
      outlineLocked ||
      !nodeDraftIsSavable(newNodeDraft) ||
      saving
    ) {
      return;
    }
    const input = addNodeInput(activeOutline.id, newNodeDraft);
    void runAction('add-node', onAddNode, input, () => {
      setNewNodeDraft(EMPTY_NODE_DRAFT);
    });
  };

  const updateDraft = (
    nodeId: EntityId,
    updater: (current: NodeDraft) => NodeDraft,
  ) => {
    setNodeDrafts((current) => {
      const existing = current[nodeId];
      if (existing === undefined) {
        return current;
      }
      return {
        ...current,
        [nodeId]: updater(existing),
      };
    });
  };

  return (
    <section
      aria-labelledby="outline-stage-title"
      className="outline-stage"
    >
      <header className="outline-stage__header">
        <div>
          <span className="outline-stage__kicker">04 / OUTLINE</span>
          <h2 id="outline-stage-title">组织结构方案</h2>
          <p>
            比较多个真实方案；每个节点都写明结论、证据和交付覆盖后再锁定。
          </p>
        </div>
        <div className="outline-stage__metrics" aria-label="结构方案数量">
          <strong>{String(outlines.length)}</strong>
          <span>结构方案</span>
        </div>
      </header>

      {evidenceCards.length === 0 ? (
        <div className="outline-stage__warning" role="status">
          <span aria-hidden="true">◇</span>
          <div>
            <strong>项目尚无证据</strong>
            <p>可先创建方案；添加节点前需要回到证据阶段选择真实证据。</p>
          </div>
        </div>
      ) : null}

      <section
        aria-labelledby="outline-comparison-title"
        className="outline-comparison"
      >
        <header className="outline-stage__subheader">
          <div>
            <span>COMPARE</span>
            <h3 id="outline-comparison-title">方案比较</h3>
          </div>
          <small>逐项比较节点、证据及任务覆盖</small>
        </header>

        <div className="outline-comparison__content">
          {outlines.length === 0 ? (
            <div className="outline-stage__empty">
              <span aria-hidden="true">◇</span>
              <div>
                <strong>尚未创建结构方案</strong>
                <p>输入方案名称后创建第一个结构。</p>
              </div>
            </div>
          ) : (
            <ol className="outline-comparison__list">
              {outlines.map((outline, index) => {
                const summary = summarizeOutline(outline, project);
                const isActive = outline.id === activeOutlineId;
                return (
                  <li key={outline.id}>
                    <article
                      aria-current={isActive ? 'true' : undefined}
                      className={
                        isActive
                          ? 'outline-plan-card is-active'
                          : 'outline-plan-card'
                      }
                    >
                      <header>
                        <span>
                          方案 {String(index + 1).padStart(2, '0')}
                        </span>
                        <em>{outlineStatusLabel(outline)}</em>
                      </header>
                      <h4>{outline.title}</h4>
                      <dl>
                        <div>
                          <dt>节点</dt>
                          <dd>{String(summary.nodeCount)} 个节点</dd>
                        </div>
                        <div>
                          <dt>证据</dt>
                          <dd>{String(summary.evidenceCount)} 条证据</dd>
                        </div>
                        <div>
                          <dt>交付要求</dt>
                          <dd>
                            交付要求{' '}
                            {String(summary.requirementCovered)}/
                            {String(summary.requirementTotal)}
                          </dd>
                        </div>
                        <div>
                          <dt>评分标准</dt>
                          <dd>
                            评分标准 {String(summary.rubricCovered)}/
                            {String(summary.rubricTotal)}
                          </dd>
                        </div>
                      </dl>
                      {isActive ? (
                        <span className="outline-plan-card__active">
                          当前编辑
                        </span>
                      ) : (
                        <button
                          className="outline-stage__button outline-stage__button--quiet"
                          disabled={saving}
                          onClick={() => {
                            setActiveOutlineId(outline.id);
                            setNewNodeDraft(EMPTY_NODE_DRAFT);
                          }}
                          type="button"
                        >
                          {outline.status === 'archived'
                            ? '查看方案'
                            : '查看并编辑'}
                        </button>
                      )}
                    </article>
                  </li>
                );
              })}
            </ol>
          )}

          <form
            aria-busy={
              actionState.actionKey === 'create-outline'
            }
            className="outline-create-form"
            onSubmit={handleCreateOutline}
          >
            <div>
              <span>NEW PLAN</span>
              <h4>新建结构方案</h4>
            </div>
            <label htmlFor="new-outline-title">方案名称</label>
            <input
              id="new-outline-title"
              maxLength={160}
              onChange={(event) => {
                setNewOutlineTitle(event.currentTarget.value);
              }}
              placeholder="例如：问题—证据—行动"
              required
              value={newOutlineTitle}
            />
            <button
              className="outline-stage__button"
              disabled={newOutlineTitle.trim().length === 0 || saving}
              type="submit"
            >
              {actionState.actionKey === 'create-outline'
                ? '创建中…'
                : '创建方案'}
            </button>
          </form>
        </div>
      </section>

      {actionState.status === 'error' ? (
        <div className="outline-stage__error" role="alert">
          <strong>结构未保存</strong>
          <span>{actionState.message}</span>
        </div>
      ) : null}

      {activeOutline === null ? (
        <section className="outline-editor outline-editor--empty">
          <div className="outline-stage__empty">
            <span aria-hidden="true">◇</span>
            <div>
              <strong>选择或创建方案后编辑节点</strong>
              <p>结构节点只会来自你的明确输入和已选证据。</p>
            </div>
          </div>
        </section>
      ) : (
        <section
          aria-labelledby="active-outline-title"
          className="outline-editor"
        >
          <header className="outline-editor__header">
            <div>
              <span className="outline-stage__kicker">
                CURRENT PLAN
              </span>
              <h3 id="active-outline-title">{activeOutline.title}</h3>
              <p>
                {outlineLocked
                  ? '结构已锁定；锁定后不可改写、排序、复制或删除。'
                  : '逐个保存节点，确认覆盖完整后再锁定当前方案。'}
              </p>
            </div>
            {outlineLocked ? (
              <span className="outline-editor__locked">
                结构已锁定
              </span>
            ) : (
              <button
                className="outline-stage__button outline-stage__button--lock"
                disabled={saving || !activeOutlineReadyToLock}
                onClick={() => {
                  void runAction(
                    'lock-outline',
                    async () =>
                      selectAndLockOutline(activeOutline, {
                        onSelectOutline,
                        onLockOutline,
                      }),
                    undefined,
                  );
                }}
                type="button"
              >
                {actionState.actionKey === 'lock-outline'
                  ? '锁定中…'
                  : '锁定当前方案'}
              </button>
            )}
          </header>

          {activeOutline.nodes.length === 0 ? (
            <div className="outline-stage__empty">
              <span aria-hidden="true">◇</span>
              <div>
                <strong>当前方案还没有节点</strong>
                <p>使用下方表单写入第一条结论并绑定证据。</p>
              </div>
            </div>
          ) : (
            <ol className="outline-node-list">
              {activeOutline.nodes.map((node, index) => {
                const draft =
                  nodeDrafts[node.id] ?? nodeDraftFromNode(node);
                const nodeLocked = outlineLocked || node.locked;
                const saveKey = `update:${node.id}`;
                return (
                  <li key={node.id}>
                    <article
                      className={
                        nodeLocked
                          ? 'outline-node-card is-locked'
                          : 'outline-node-card'
                      }
                    >
                      <header>
                        <div className="outline-node-card__position">
                          <span>节点</span>
                          <strong>
                            {String(index + 1).padStart(2, '0')}
                          </strong>
                        </div>
                        <div>
                          <span>
                            {nodeLocked ? '已锁定' : '可编辑'}
                          </span>
                          <small>
                            {String(node.evidenceCardIds.length)} 条证据
                          </small>
                        </div>
                      </header>

                      <fieldset
                        disabled={nodeLocked || saving}
                        form={`node-form-${node.id}`}
                      >
                        <legend className="sr-only">
                          编辑节点 {String(index + 1)}
                        </legend>
                        <div className="outline-stage__field">
                          <label htmlFor={`node-title-${node.id}`}>
                            节点标题
                          </label>
                          <input
                            id={`node-title-${node.id}`}
                            maxLength={200}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              updateDraft(node.id, (current) => ({
                                ...current,
                                title: value,
                              }));
                            }}
                            value={draft.title}
                          />
                        </div>
                        <div className="outline-stage__field">
                          <label htmlFor={`node-conclusion-${node.id}`}>
                            节点结论
                          </label>
                          <textarea
                            id={`node-conclusion-${node.id}`}
                            maxLength={4_000}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              updateDraft(node.id, (current) => ({
                                ...current,
                                conclusion: value,
                              }));
                            }}
                            rows={3}
                            value={draft.conclusion}
                          />
                        </div>

                        <NodeBindings
                          draft={draft}
                          evidenceCards={evidenceCards}
                          filesById={filesById}
                          idPrefix={`node-${node.id}`}
                          onChange={(nextDraft) => {
                            setNodeDrafts((current) => ({
                              ...current,
                              [node.id]: nextDraft,
                            }));
                          }}
                          project={project}
                        />
                      </fieldset>

                      <footer>
                        <div className="outline-node-card__move">
                          <button
                            aria-label={`上移节点：${node.title}`}
                            className="outline-stage__button outline-stage__button--quiet"
                            disabled={nodeLocked || saving || index === 0}
                            onClick={() => {
                              void runAction(
                                `move-up:${node.id}`,
                                onReorderNode,
                                {
                                  outlineId: activeOutline.id,
                                  nodeId: node.id,
                                  targetPosition: index - 1,
                                },
                              );
                            }}
                            type="button"
                          >
                            上移
                          </button>
                          <button
                            aria-label={`下移节点：${node.title}`}
                            className="outline-stage__button outline-stage__button--quiet"
                            disabled={
                              nodeLocked ||
                              saving ||
                              index === activeOutline.nodes.length - 1
                            }
                            onClick={() => {
                              void runAction(
                                `move-down:${node.id}`,
                                onReorderNode,
                                {
                                  outlineId: activeOutline.id,
                                  nodeId: node.id,
                                  targetPosition: index + 1,
                                },
                              );
                            }}
                            type="button"
                          >
                            下移
                          </button>
                        </div>
                        <div className="outline-node-card__actions">
                          <button
                            className="outline-stage__button outline-stage__button--quiet"
                            disabled={
                              nodeLocked ||
                              saving ||
                              !nodeDraftIsSavable(draft)
                            }
                            onClick={() => {
                              void runAction(
                                `copy:${node.id}`,
                                onAddNode,
                                {
                                  ...addNodeInput(
                                    activeOutline.id,
                                    draft,
                                  ),
                                  title: `${draft.title}（副本）`,
                                },
                              );
                            }}
                            type="button"
                          >
                            复制
                          </button>
                          <button
                            className="outline-stage__button outline-stage__button--quiet"
                            disabled={nodeLocked || saving}
                            onClick={() => {
                              void runAction(
                                `lock-node:${node.id}`,
                                onUpdateNode,
                                {
                                  outlineId: activeOutline.id,
                                  nodeId: node.id,
                                  patch: { locked: true },
                                },
                              );
                            }}
                            type="button"
                          >
                            锁定节点
                          </button>
                          <button
                            className="outline-stage__button outline-stage__button--danger"
                            disabled={nodeLocked || saving}
                            onClick={() => {
                              void runAction(
                                `delete:${node.id}`,
                                onDeleteNode,
                                {
                                  outlineId: activeOutline.id,
                                  nodeId: node.id,
                                },
                              );
                            }}
                            type="button"
                          >
                            删除
                          </button>
                          <button
                            className="outline-stage__button"
                            disabled={
                              nodeLocked ||
                              saving ||
                              !nodeDraftIsSavable(draft)
                            }
                            onClick={() => {
                              void runAction(
                                saveKey,
                                onUpdateNode,
                                {
                                  outlineId: activeOutline.id,
                                  nodeId: node.id,
                                  patch: {
                                    title: draft.title.trim(),
                                    conclusion:
                                      draft.conclusion.trim(),
                                    evidenceCardIds: [
                                      ...draft.evidenceCardIds,
                                    ],
                                    coveredRequirements: [
                                      ...draft.coveredRequirements,
                                    ],
                                    rubricCriterionIds: [
                                      ...draft.rubricCriterionIds,
                                    ],
                                  },
                                },
                              );
                            }}
                            type="button"
                          >
                            {actionState.actionKey === saveKey
                              ? '保存中…'
                              : '保存节点'}
                          </button>
                        </div>
                      </footer>
                    </article>
                  </li>
                );
              })}
            </ol>
          )}

          <form
            aria-busy={actionState.actionKey === 'add-node'}
            className="outline-add-node"
            onSubmit={handleAddNode}
          >
            <header className="outline-stage__subheader">
              <div>
                <span>ADD NODE</span>
                <h3>添加节点</h3>
              </div>
              <small>结论和至少一条真实证据为必填项</small>
            </header>
            <fieldset disabled={outlineLocked || saving}>
              <legend className="sr-only">新节点内容</legend>
              <div className="outline-add-node__basics">
                <div className="outline-stage__field">
                  <label htmlFor="new-node-title">节点标题</label>
                  <input
                    id="new-node-title"
                    maxLength={200}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setNewNodeDraft((current) => ({
                        ...current,
                        title: value,
                      }));
                    }}
                    placeholder="例如：结论边界"
                    required
                    value={newNodeDraft.title}
                  />
                </div>
                <div className="outline-stage__field">
                  <label htmlFor="new-node-conclusion">节点结论</label>
                  <textarea
                    id="new-node-conclusion"
                    maxLength={4_000}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setNewNodeDraft((current) => ({
                        ...current,
                        conclusion: value,
                      }));
                    }}
                    placeholder="写下本节点要表达的明确结论"
                    required
                    rows={3}
                    value={newNodeDraft.conclusion}
                  />
                </div>
              </div>
              <NodeBindings
                draft={newNodeDraft}
                evidenceCards={evidenceCards}
                filesById={filesById}
                idPrefix="new-node"
                onChange={setNewNodeDraft}
                project={project}
              />
            </fieldset>
            <button
              className="outline-stage__button outline-stage__button--add"
              disabled={
                outlineLocked ||
                saving ||
                !nodeDraftIsSavable(newNodeDraft)
              }
              type="submit"
            >
              {actionState.actionKey === 'add-node'
                ? '添加中…'
                : '添加节点'}
            </button>
          </form>
        </section>
      )}
    </section>
  );
}

interface NodeBindingsProps {
  draft: NodeDraft;
  evidenceCards: Project['evidenceCards'];
  filesById: ReadonlyMap<EntityId, Project['sourceFiles'][number]>;
  idPrefix: string;
  project: Project;
  onChange(nextDraft: NodeDraft): void;
}

function NodeBindings({
  draft,
  evidenceCards,
  filesById,
  idPrefix,
  project,
  onChange,
}: NodeBindingsProps) {
  return (
    <div className="outline-node-bindings">
      <fieldset>
        <legend>证据多选</legend>
        {evidenceCards.length === 0 ? (
          <div className="outline-binding-empty">
            项目尚无证据，不能添加无来源节点。
          </div>
        ) : (
          <div className="outline-evidence-options">
            {evidenceCards.map((evidence) => {
              const inputId = `${idPrefix}-evidence-${evidence.id}`;
              const sourceFile = filesById.get(evidence.sourceFileId);
              return (
                <label key={evidence.id} htmlFor={inputId}>
                  <input
                    checked={draft.evidenceCardIds.includes(evidence.id)}
                    id={inputId}
                    onChange={() => {
                      onChange({
                        ...draft,
                        evidenceCardIds: toggleValue(
                          draft.evidenceCardIds,
                          evidence.id,
                        ),
                      });
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

      <fieldset>
        <legend>交付要求覆盖</legend>
        {project.taskDefinition.mustInclude.length === 0 ? (
          <div className="outline-binding-empty">
            任务没有必须包含项。
          </div>
        ) : (
          <div className="outline-coverage-options">
            {project.taskDefinition.mustInclude.map((requirement, index) => {
              const inputId = `${idPrefix}-requirement-${String(index)}`;
              return (
                <label key={requirement} htmlFor={inputId}>
                  <input
                    checked={draft.coveredRequirements.includes(requirement)}
                    id={inputId}
                    onChange={() => {
                      onChange({
                        ...draft,
                        coveredRequirements: toggleValue(
                          draft.coveredRequirements,
                          requirement,
                        ),
                      });
                    }}
                    type="checkbox"
                  />
                  <span>{requirement}</span>
                </label>
              );
            })}
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend>评分标准覆盖</legend>
        {project.taskDefinition.rubric.length === 0 ? (
          <div className="outline-binding-empty">
            任务没有评分标准。
          </div>
        ) : (
          <div className="outline-coverage-options">
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
                      onChange({
                        ...draft,
                        rubricCriterionIds: toggleValue(
                          draft.rubricCriterionIds,
                          criterion.id,
                        ),
                      });
                    }}
                    type="checkbox"
                  />
                  <span>
                    {criterion.title}{' '}
                    <small>
                      {String(criterion.weightPercent)}%
                    </small>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </fieldset>
    </div>
  );
}

function buildNodeDrafts(
  outlines: readonly Outline[],
): Readonly<Record<EntityId, NodeDraft>> {
  return Object.fromEntries(
    outlines.flatMap((outline) =>
      outline.nodes.map((node) => [
        node.id,
        nodeDraftFromNode(node),
      ]),
    ),
  );
}

function nodeDraftFromNode(node: OutlineNode): NodeDraft {
  return {
    title: node.title,
    conclusion: node.conclusion,
    evidenceCardIds: [...node.evidenceCardIds],
    coveredRequirements: [...node.coveredRequirements],
    rubricCriterionIds: [...node.rubricCriterionIds],
  };
}

function nodeDraftIsSavable(draft: NodeDraft): boolean {
  return (
    draft.title.trim().length > 0 &&
    draft.conclusion.trim().length > 0 &&
    draft.evidenceCardIds.length > 0
  );
}

function addNodeInput(
  outlineId: EntityId,
  draft: NodeDraft,
): AddOutlineNodeInput {
  return {
    outlineId,
    title: draft.title.trim(),
    conclusion: draft.conclusion.trim(),
    evidenceCardIds: [...draft.evidenceCardIds],
    coveredRequirements: [...draft.coveredRequirements],
    rubricCriterionIds: [...draft.rubricCriterionIds],
  };
}

function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

function outlineStatusLabel(outline: Outline): string {
  if (outline.status === 'locked') {
    return '已锁定';
  }
  if (outline.status === 'selected') {
    return '已选择';
  }
  if (outline.status === 'archived') {
    return '已归档';
  }
  return '草稿';
}

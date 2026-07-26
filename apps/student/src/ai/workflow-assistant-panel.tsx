import { useMemo, useState } from 'react';
import type { AIRunStatus } from './ai-provider.js';
import type {
  CandidateCompleteness,
  WorkflowAssistantKind,
  WorkflowAssistantSession,
} from './workflow-assistant.js';
import './workflow-assistant-panel.css';

export type WorkflowAssistantPanelOption = Readonly<{
  id: string;
  label: string;
  summary: string;
}>;

export type WorkflowAssistantPanelSession = Readonly<{
  id: string;
  workflow: WorkflowAssistantKind;
  status: AIRunStatus;
  title: string;
  detail: string;
  completeness: CandidateCompleteness | null;
  appliedCount: number;
  totalCount: number;
  options?: readonly WorkflowAssistantPanelOption[];
}>;

export type WorkflowAssistantPanelProps = Readonly<{
  disabled: boolean;
  sessions: readonly WorkflowAssistantPanelSession[];
  selectedWorkflow: WorkflowAssistantKind;
  onWorkflowChange(workflow: WorkflowAssistantKind): void;
  onGenerate(workflow: WorkflowAssistantKind): void | Promise<void>;
  onCancel(sessionId: string): void | Promise<void>;
  onRetry(sessionId: string): void | Promise<void>;
  onApply(
    sessionId: string,
    candidateIds: readonly string[],
  ): void | Promise<void>;
  onDismiss(sessionId: string): void | Promise<void>;
}>;

const WORKFLOWS: readonly Readonly<{
  id: WorkflowAssistantKind;
  label: string;
  detail: string;
}>[] = [
  {
    id: 'evidence',
    label: '证据建议',
    detail: '从已解析资料中找出可核验片段',
  },
  {
    id: 'outline',
    label: '大纲方案',
    detail: '比较多种论证结构，再选一种',
  },
  {
    id: 'draft',
    label: '三页草稿',
    detail: '沿用已确认大纲与证据生成三页内容',
  },
];

export function WorkflowAssistantPanel({
  disabled,
  sessions,
  selectedWorkflow,
  onWorkflowChange,
  onGenerate,
  onCancel,
  onRetry,
  onApply,
  onDismiss,
}: WorkflowAssistantPanelProps) {
  const [selectedCandidates, setSelectedCandidates] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const selectedDefinition = WORKFLOWS.find(
    (workflow) => workflow.id === selectedWorkflow,
  )!;

  return (
    <section
      aria-labelledby="workflow-assistant-title"
      className="workflow-assistant"
    >
      <header className="workflow-assistant__header">
        <div>
          <p className="workflow-assistant__eyebrow">AI WORKFLOW</p>
          <h2 id="workflow-assistant-title">工作流 AI 助手</h2>
          <p>AI 只会提交候选，确认后才写入项目。</p>
        </div>
        <span className="workflow-assistant__review-rule">
          先审核，再应用
        </span>
      </header>

      <div
        aria-label="选择生成内容"
        className="workflow-assistant__workflow-tabs"
        role="tablist"
      >
        {WORKFLOWS.map((workflow) => {
          const active = workflow.id === selectedWorkflow;
          return (
            <button
              aria-selected={active}
              className={active ? 'is-active' : undefined}
              disabled={disabled}
              key={workflow.id}
              onClick={() => {
                onWorkflowChange(workflow.id);
              }}
              role="tab"
              type="button"
            >
              <strong>{workflow.label}</strong>
              <span>{workflow.detail}</span>
            </button>
          );
        })}
      </div>

      <div className="workflow-assistant__generate">
        <div>
          <strong>{selectedDefinition.label}</strong>
          <span>{selectedDefinition.detail}</span>
        </div>
        <button
          disabled={disabled}
          onClick={() => {
            void onGenerate(selectedWorkflow);
          }}
          type="button"
        >
          生成候选
          <span aria-hidden="true">→</span>
        </button>
      </div>

      <div
        aria-live="polite"
        className="workflow-assistant__sessions"
      >
        {sessions.length === 0 ? (
          <div className="workflow-assistant__empty">
            <strong>还没有候选</strong>
            <span>选择一项任务开始，结果会保留在这里等待审核。</span>
          </div>
        ) : (
          sessions.map((session) => {
            const options = session.options ?? [];
            const selected =
              selectedCandidates[session.id] ??
              defaultSelection(session, options);
            return (
              <article
                className={`workflow-assistant__session workflow-assistant__session--${session.status}`}
                key={session.id}
              >
                <header>
                  <div>
                    <span>
                      {workflowLabel(session.workflow)} ·{' '}
                      {statusLabel(session)}
                    </span>
                    <h3>{session.title}</h3>
                  </div>
                  {session.completeness === 'partial' ? (
                    <b>部分完成</b>
                  ) : null}
                </header>
                <p>{session.detail}</p>

                {options.length > 0 &&
                session.status === 'waiting_for_review' ? (
                  <CandidateOptions
                    options={options}
                    selected={selected}
                    session={session}
                    onChange={(next) => {
                      setSelectedCandidates((current) => ({
                        ...current,
                        [session.id]: next,
                      }));
                    }}
                  />
                ) : null}

                {session.appliedCount > 0 ? (
                  <div className="workflow-assistant__progress">
                    <span>
                      已写入 {session.appliedCount}/{session.totalCount}
                    </span>
                    <progress
                      aria-label="写入进度"
                      max={Math.max(1, session.totalCount)}
                      value={session.appliedCount}
                    />
                  </div>
                ) : null}

                <footer>
                  <SessionActions
                    disabled={disabled}
                    selected={selected}
                    session={session}
                    onApply={onApply}
                    onCancel={onCancel}
                    onDismiss={onDismiss}
                    onRetry={onRetry}
                  />
                </footer>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

type CandidateOptionsProps = Readonly<{
  options: readonly WorkflowAssistantPanelOption[];
  selected: readonly string[];
  session: WorkflowAssistantPanelSession;
  onChange(next: readonly string[]): void;
}>;

function CandidateOptions({
  options,
  selected,
  session,
  onChange,
}: CandidateOptionsProps) {
  const isSingle = session.workflow === 'outline';
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  return (
    <fieldset className="workflow-assistant__options">
      <legend>{isSingle ? '选择一个方案' : '选择要写入的候选'}</legend>
      {options.map((option) => (
        <label key={option.id}>
          <input
            checked={selectedSet.has(option.id)}
            name={`assistant-candidate-${session.id}`}
            onChange={(event) => {
              if (isSingle) {
                onChange(event.currentTarget.checked ? [option.id] : []);
                return;
              }
              onChange(
                event.currentTarget.checked
                  ? [...selected, option.id]
                  : selected.filter((id) => id !== option.id),
              );
            }}
            type={isSingle ? 'radio' : 'checkbox'}
            value={option.id}
          />
          <span>
            <strong>{option.label}</strong>
            <small>{option.summary}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

type SessionActionsProps = Readonly<{
  disabled: boolean;
  selected: readonly string[];
  session: WorkflowAssistantPanelSession;
  onCancel(sessionId: string): void | Promise<void>;
  onRetry(sessionId: string): void | Promise<void>;
  onApply(
    sessionId: string,
    candidateIds: readonly string[],
  ): void | Promise<void>;
  onDismiss(sessionId: string): void | Promise<void>;
}>;

function SessionActions({
  disabled,
  selected,
  session,
  onCancel,
  onRetry,
  onApply,
  onDismiss,
}: SessionActionsProps) {
  if (session.status === 'queued' || session.status === 'running') {
    return (
      <button
        className="workflow-assistant__secondary"
        disabled={disabled}
        onClick={() => {
          void onCancel(session.id);
        }}
        type="button"
      >
        取消
      </button>
    );
  }
  if (session.status === 'waiting_for_review') {
    return (
      <>
        <button
          className="workflow-assistant__secondary"
          disabled={disabled}
          onClick={() => {
            void onDismiss(session.id);
          }}
          type="button"
        >
          放弃候选
        </button>
        <button
          className="workflow-assistant__primary"
          disabled={disabled || selected.length === 0}
          onClick={() => {
            void onApply(session.id, selected);
          }}
          type="button"
        >
          {session.appliedCount > 0 ? '继续写入' : '审核候选'}
        </button>
      </>
    );
  }
  if (
    session.status === 'failed' ||
    session.status === 'quota_exhausted' ||
    session.status === 'cancelled' ||
    session.status === 'stale'
  ) {
    return (
      <>
        <button
          className="workflow-assistant__secondary"
          disabled={disabled}
          onClick={() => {
            void onDismiss(session.id);
          }}
          type="button"
        >
          移除
        </button>
        <button
          className="workflow-assistant__primary"
          disabled={disabled}
          onClick={() => {
            void onRetry(session.id);
          }}
          type="button"
        >
          重试
        </button>
      </>
    );
  }
  return (
    <button
      className="workflow-assistant__secondary"
      disabled={disabled}
      onClick={() => {
        void onDismiss(session.id);
      }}
      type="button"
    >
      完成
    </button>
  );
}

export function workflowSessionToPanelItem(
  session: WorkflowAssistantSession,
): WorkflowAssistantPanelSession {
  const options = candidateOptions(session);
  const completeness =
    session.candidate?.value.completeness ?? null;
  return Object.freeze({
    id: session.id,
    workflow: session.workflow,
    status: session.run.status,
    title: sessionTitle(session, options.length),
    detail: sessionDetail(session),
    completeness,
    appliedCount: session.application.appliedUnitIds.length,
    totalCount: options.length,
    options,
  });
}

function candidateOptions(
  session: WorkflowAssistantSession,
): readonly WorkflowAssistantPanelOption[] {
  const value = session.candidate?.value;
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (value.kind === 'evidence_suggestions') {
    return Object.freeze(
      value.suggestions.map((suggestion) =>
        Object.freeze({
          id: suggestion.candidateId,
          label: suggestion.note || '证据候选',
          summary: `${suggestion.citation} · ${evidenceKindLabel(suggestion.kind)}`,
        }),
      ),
    );
  }
  if (value.kind === 'outline_options') {
    return Object.freeze(
      value.options.map((option) =>
        Object.freeze({
          id: option.candidateId,
          label: option.title,
          summary: `${String(option.nodes.length)} 个论证节点`,
        }),
      ),
    );
  }
  return Object.freeze(
    value.pages.map((page, index) =>
      Object.freeze({
        id: page.candidateId,
        label: `${String(index + 1).padStart(2, '0')} · ${page.title}`,
        summary: `${String(page.evidenceCardIds.length)} 条证据 · 约 ${String(page.estimatedSeconds)} 秒`,
      }),
    ),
  );
}

function defaultSelection(
  session: WorkflowAssistantPanelSession,
  options: readonly WorkflowAssistantPanelOption[],
): readonly string[] {
  const unapplied =
    session.appliedCount >= session.totalCount
      ? []
      : options.map((option) => option.id);
  return session.workflow === 'outline' ? unapplied.slice(0, 1) : unapplied;
}

function workflowLabel(workflow: WorkflowAssistantKind): string {
  return (
    WORKFLOWS.find((candidate) => candidate.id === workflow)?.label ??
    '候选'
  );
}

function statusLabel(session: WorkflowAssistantPanelSession): string {
  const labels: Record<AIRunStatus, string> = {
    queued: '等待开始',
    running: '生成中',
    waiting_for_review: '待审核',
    completed: '已应用',
    failed: '未完成',
    cancelled: '已取消',
    quota_exhausted: '服务受限',
    stale: '输入已变化',
  };
  return labels[session.status];
}

function sessionTitle(
  session: WorkflowAssistantSession,
  optionCount: number,
): string {
  if (session.run.status === 'waiting_for_review') {
    return `${String(optionCount)} 个候选待确认`;
  }
  if (session.run.status === 'running') {
    return '正在整理项目内容';
  }
  if (session.run.status === 'queued') {
    return '候选已进入队列';
  }
  if (session.run.status === 'completed') {
    return '候选已写入项目';
  }
  return '本次生成未完成';
}

function sessionDetail(session: WorkflowAssistantSession): string {
  if (session.application.status === 'partial') {
    return `已写入 ${String(session.application.appliedUnitIds.length)} 项，可继续完成。`;
  }
  if (session.run.status === 'quota_exhausted') {
    return '模型服务暂时无法继续，请稍后重试或检查可用额度。';
  }
  if (session.run.status === 'stale') {
    return '项目内容已经变化，请重新生成候选。';
  }
  if (session.run.status === 'failed') {
    return '候选未通过完整性检查，请调整输入后重试。';
  }
  if (session.run.status === 'waiting_for_review') {
    return '所有结论均需关联项目证据，确认后才会写入。';
  }
  return '生成记录会保留，刷新页面后仍可继续处理。';
}

function evidenceKindLabel(
  kind: 'fact' | 'opinion' | 'statistic' | 'case' | 'unverified',
): string {
  return {
    fact: '事实',
    opinion: '观点',
    statistic: '数据',
    case: '案例',
    unverified: '待核验',
  }[kind];
}

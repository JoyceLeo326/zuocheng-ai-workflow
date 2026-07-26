import {
  useCallback,
  useEffect,
  useState,
} from 'react';
import type { Project } from '../workbench/project-model.js';
import type { WorkbenchProjectLifecycleService } from '../workbench/workbench-service.js';
import { WorkflowAssistantError } from './workflow-assistant.js';
import type {
  WorkflowAssistant,
  WorkflowAssistantKind,
  WorkflowAssistantSession,
} from './workflow-assistant.js';
import {
  WorkflowAssistantPanel,
  workflowSessionToPanelItem,
} from './workflow-assistant-panel.js';

export type WorkflowAssistantWorkspaceProps = Readonly<{
  assistant?: WorkflowAssistant | undefined;
  project: Project | null;
  service?: WorkbenchProjectLifecycleService | undefined;
  onOpenSettings(): void;
  onProjectChange(project: Project): void;
  onReturnToWorkbench(): void;
}>;

export function WorkflowAssistantWorkspace({
  assistant,
  project,
  service,
  onOpenSettings,
  onProjectChange,
  onReturnToWorkbench,
}: WorkflowAssistantWorkspaceProps) {
  const [selectedWorkflow, setSelectedWorkflow] =
    useState<WorkflowAssistantKind>('evidence');
  const [sessions, setSessions] = useState<
    readonly WorkflowAssistantSession[]
  >([]);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    if (assistant === undefined || project === null) {
      setSessions([]);
      return;
    }
    setSessions(await assistant.list(project.id));
  }, [assistant, project]);

  useEffect(() => {
    let active = true;
    void refresh().catch((reason: unknown) => {
      if (active) {
        setMessage(workflowErrorMessage(reason));
      }
    });
    return () => {
      active = false;
    };
  }, [refresh]);

  const upsert = (next: WorkflowAssistantSession) => {
    setSessions((current) => {
      const remaining = current.filter(
        (candidate) => candidate.id !== next.id,
      );
      return [next, ...remaining].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
    });
  };

  if (project === null) {
    return (
      <WorkspaceNotice
        actionLabel="返回任务"
        description="先保存任务并加入材料，AI 才能基于真实项目内容生成候选。"
        onAction={onReturnToWorkbench}
        title="先准备项目内容"
      />
    );
  }

  if (assistant === undefined || service === undefined) {
    return (
      <WorkspaceNotice
        actionLabel="连接模型"
        description="连接你的 OpenAI 兼容模型后，可以生成证据建议、大纲方案和三页草稿。"
        onAction={onOpenSettings}
        title="启用工作流 AI 助手"
      />
    );
  }

  const runSession = async (
    session: WorkflowAssistantSession,
  ): Promise<void> => {
    upsert(session);
    try {
      upsert(await assistant.execute(session.id));
    } catch (reason) {
      setMessage(workflowErrorMessage(reason));
      await refresh();
    }
  };

  return (
    <div className="workflow-assistant-workspace">
      {message.length > 0 ? (
        <div className="workflow-assistant-workspace__message" role="alert">
          <span>{message}</span>
          <button onClick={() => setMessage('')} type="button">
            关闭
          </button>
        </div>
      ) : null}
      <WorkflowAssistantPanel
        disabled={false}
        onApply={async (sessionId, candidateIds) => {
          setMessage('');
          try {
            const updated = await assistant.apply(
              sessionId,
              project,
              service,
              { candidateIds },
            );
            upsert(updated);
            const current = (await service.listProjects()).find(
              (candidate) => candidate.id === project.id,
            );
            if (current !== undefined) {
              onProjectChange(current);
            }
          } catch (reason) {
            setMessage(workflowErrorMessage(reason));
            await refresh();
          }
        }}
        onCancel={async (sessionId) => {
          setMessage('');
          try {
            upsert(await assistant.cancel(sessionId));
          } catch (reason) {
            setMessage(workflowErrorMessage(reason));
          }
        }}
        onDismiss={async (sessionId) => {
          setMessage('');
          try {
            await assistant.dismiss(sessionId);
            setSessions((current) =>
              current.filter((candidate) => candidate.id !== sessionId),
            );
          } catch (reason) {
            setMessage(workflowErrorMessage(reason));
          }
        }}
        onGenerate={async (workflow) => {
          setMessage('');
          try {
            const queued = await assistant.prepare(
              project,
              workflow,
              requestKey(project.id, workflow),
            );
            await runSession(queued);
          } catch (reason) {
            setMessage(workflowErrorMessage(reason));
          }
        }}
        onRetry={async (sessionId) => {
          setMessage('');
          try {
            await runSession(
              await assistant.retry(
                sessionId,
                requestKey(project.id, 'retry'),
              ),
            );
          } catch (reason) {
            setMessage(workflowErrorMessage(reason));
          }
        }}
        onWorkflowChange={setSelectedWorkflow}
        selectedWorkflow={selectedWorkflow}
        sessions={sessions.map(workflowSessionToPanelItem)}
      />
    </div>
  );
}

function WorkspaceNotice({
  title,
  description,
  actionLabel,
  onAction,
}: Readonly<{
  title: string;
  description: string;
  actionLabel: string;
  onAction(): void;
}>) {
  return (
    <section className="workflow-assistant-workspace__notice">
      <p>AI WORKFLOW</p>
      <h2>{title}</h2>
      <span>{description}</span>
      <button onClick={onAction} type="button">
        {actionLabel}
      </button>
    </section>
  );
}

function requestKey(
  projectId: string,
  workflow: WorkflowAssistantKind | 'retry',
): string {
  const suffix =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${projectId}:${workflow}:${suffix}`;
}

function workflowErrorMessage(reason: unknown): string {
  if (reason instanceof WorkflowAssistantError) {
    const messages: Partial<
      Record<WorkflowAssistantError['code'], string>
    > = {
      INSUFFICIENT_SOURCE: '当前材料还不足以完成这项生成，请先补充内容。',
      INSUFFICIENT_EVIDENCE: '请先确认足够的证据，再生成后续内容。',
      OUTLINE_REQUIRED: '请先选择并锁定一个大纲，再生成三页草稿。',
      REVIEW_REQUIRED: '请先检查候选内容，再选择要写入的项目。',
      STALE_INPUT: '项目内容已经变化，请重新生成候选。',
      INVALID_SELECTION: '请选择至少一个尚未写入的候选。',
      RUN_NOT_EXECUTABLE: '这次生成无法继续，请重新发起。',
    };
    return messages[reason.code] ?? '本次生成未完成，请检查后重试。';
  }
  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message;
  }
  return '本次生成未完成，请稍后重试。';
}

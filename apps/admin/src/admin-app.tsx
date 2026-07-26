import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  AdminConflictError,
  AdminConfirmationError,
  AdminQuotaError,
  AdminValidationError,
  summarizeAdminSnapshot,
  type AdminCommand,
  type AdminRole,
  type AdminSnapshot,
  type ContentKind,
  type DeliveryKind,
  type DeliveryStatus,
  type FeedbackKind,
  type FeedbackStatus,
  type JobKind,
  type JobStatus,
} from './admin-domain.js';
import type {
  AdminService,
  AdminLoadResult,
  AdminServiceStatus,
} from './admin-service.js';
import { AdminPermissionError } from './admin-service.js';

export type AdminSection =
  | 'overview'
  | 'access'
  | 'content'
  | 'delivery'
  | 'feedback'
  | 'operations'
  | 'usage'
  | 'commerce'
  | 'controls'
  | 'audit'
  | 'system';

export interface AdminNotice {
  kind:
    | 'success'
    | 'error'
    | 'offline'
    | 'permission_denied'
    | 'quota_exhausted'
    | 'conflict';
  message: string;
}

const NAVIGATION: Array<{
  id: AdminSection;
  label: string;
  shortLabel: string;
}> = [
  { id: 'overview', label: '运营总览', shortLabel: '总览' },
  { id: 'access', label: '用户与权限', shortLabel: '用户' },
  { id: 'content', label: '课程与内容', shortLabel: '内容' },
  { id: 'delivery', label: '项目与作业', shortLabel: '交付' },
  { id: 'feedback', label: '反馈与申诉', shortLabel: '反馈' },
  { id: 'operations', label: '任务与导出', shortLabel: '任务' },
  { id: 'usage', label: '用量与限额', shortLabel: '用量' },
  { id: 'commerce', label: '订单与余额', shortLabel: '订单' },
  { id: 'controls', label: '功能开关', shortLabel: '开关' },
  { id: 'audit', label: '审计日志', shortLabel: '审计' },
  { id: 'system', label: '服务健康', shortLabel: '系统' },
];

const ROLE_OPTIONS: Array<{
  value: AdminRole;
  label: string;
  permission: string;
}> = [
  { value: 'owner', label: '所有者', permission: '全部权限与授权管理' },
  {
    value: 'administrator',
    label: '管理员',
    permission: '用户、内容、交付与系统配置',
  },
  { value: 'operator', label: '运营', permission: '任务、用量与通知' },
  { value: 'content', label: '内容', permission: '课程、班级与模板发布' },
  { value: 'support', label: '客服', permission: '反馈、申诉与工单' },
  { value: 'finance', label: '财务', permission: '订单、余额与退款记录' },
  { value: 'auditor', label: '审计员', permission: '只读查看与审计导出' },
  { value: 'mentor', label: '导师', permission: '作业评审与反馈' },
  { value: 'member', label: '成员', permission: '自己的项目和提交' },
];

const CONTENT_LABELS: Record<ContentKind, string> = {
  course: '课程',
  lesson: '课时',
  class: '班级',
  template: '模板',
};

const DELIVERY_LABELS: Record<DeliveryKind, string> = {
  project: '项目',
  assignment: '作业',
  submission: '提交',
};

const JOB_LABELS: Record<JobKind, string> = {
  ai: 'AI 任务',
  file_parse: '文件解析',
  export: '导出',
  notification: '通知',
};

function useAdminApplication(service: AdminService) {
  const [loadResult, setLoadResult] = useState<AdminLoadResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [notice, setNotice] = useState<AdminNotice | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await service.load();
      setLoadResult(result);
      setNotice(
        result.connectivity === 'offline'
          ? { kind: 'offline', message: '当前离线，远端管理数据不可用。' }
          : null,
      );
    } catch (error) {
      setNotice({
        kind: 'error',
        message: readableError(error),
      });
    } finally {
      setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onConnectivityChange = () => {
      void load();
    };
    window.addEventListener('online', onConnectivityChange);
    window.addEventListener('offline', onConnectivityChange);
    return () => {
      window.removeEventListener('online', onConnectivityChange);
      window.removeEventListener('offline', onConnectivityChange);
    };
  }, [load]);

  const execute = useCallback(
    async (command: AdminCommand) => {
      setMutating(true);
      try {
        const snapshot = await service.execute(command);
        setLoadResult((current) =>
          current === null ? current : { ...current, snapshot },
        );
        setNotice({ kind: 'success', message: '修改已保存并写入审计日志。' });
      } catch (error) {
        setNotice(noticeForError(error));
      } finally {
        setMutating(false);
      }
    },
    [service],
  );

  const importSnapshot = useCallback(
    async (file: File, confirmation: string, actor: string) => {
      setMutating(true);
      try {
        const parsed: unknown = JSON.parse(await file.text());
        const snapshot = await service.replaceWithImportedSnapshot(
          parsed,
          confirmation,
          actor,
        );
        setLoadResult((current) =>
          current === null ? current : { ...current, snapshot },
        );
        setNotice({
          kind: 'success',
          message: '数据包已校验、导入并写入审计日志。',
        });
      } catch (error) {
        setNotice(noticeForError(error));
      } finally {
        setMutating(false);
      }
    },
    [service],
  );

  return {
    loadResult,
    loading,
    notice,
    mutating,
    load,
    execute,
    importSnapshot,
  };
}

export function AdminApp({ service }: { service: AdminService }) {
  const application = useAdminApplication(service);
  const [actor, setActor] = useState('');
  const [section, setSection] = useState<AdminSection>('overview');

  if (application.loading && application.loadResult === null) {
    return <LoadingScreen />;
  }

  if (application.loadResult === null) {
    return (
      <FailureScreen
        message={application.notice?.message ?? '无法读取管理数据。'}
        onRetry={() => void application.load()}
      />
    );
  }

  return (
    <AdminWorkspace
      activeSection={section}
      actor={actor}
      connectivity={application.loadResult.connectivity}
      notice={application.notice}
      pending={application.mutating || application.loading}
      readOnly={application.loadResult.readOnly}
      repositoryMode={application.loadResult.repositoryMode}
      services={application.loadResult.services}
      snapshot={application.loadResult.snapshot}
      onActorChange={setActor}
      onCommand={(command) => void application.execute(command)}
      onExport={() => exportSnapshot(application.loadResult?.snapshot)}
      onImport={(file, confirmation) =>
        void application.importSnapshot(file, confirmation, actor)
      }
      onReload={() => void application.load()}
      onSectionChange={setSection}
    />
  );
}

interface AdminWorkspaceProps {
  activeSection: AdminSection;
  actor: string;
  connectivity: 'online' | 'offline';
  notice: AdminNotice | null;
  pending: boolean;
  readOnly: boolean;
  repositoryMode: 'local' | 'remote';
  services: AdminServiceStatus[];
  snapshot: AdminSnapshot;
  onActorChange: (actor: string) => void;
  onCommand: (command: AdminCommand) => void;
  onExport: () => void;
  onImport: (file: File, confirmation: string) => void;
  onReload: () => void;
  onSectionChange: (section: AdminSection) => void;
}

export function AdminWorkspace(props: AdminWorkspaceProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const canWrite =
    !props.readOnly && !props.pending && props.actor.trim().length > 0;
  const title =
    NAVIGATION.find((item) => item.id === props.activeSection)?.label ??
    '运营总览';

  return (
    <div className="admin-shell">
      <a className="skip-link" href="#admin-content">
        跳到主要内容
      </a>
      <aside className={menuOpen ? 'sidebar sidebar--open' : 'sidebar'}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ■
          </span>
          <div>
            <strong>做成</strong>
            <span>运营控制台</span>
          </div>
        </div>
        <nav aria-label="后台功能">
          {NAVIGATION.map((item) => (
            <button
              aria-current={props.activeSection === item.id ? 'page' : undefined}
              className={
                props.activeSection === item.id ? 'nav-link is-active' : 'nav-link'
              }
              key={item.id}
              type="button"
              onClick={() => {
                props.onSectionChange(item.id);
                setMenuOpen(false);
              }}
            >
              <span>{item.label}</span>
              <small>{item.shortLabel}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span
            className={`status-dot status-dot--${props.connectivity}`}
            aria-hidden="true"
          />
          {props.connectivity === 'online' ? '网络可用' : '当前离线'}
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <button
            aria-expanded={menuOpen}
            aria-label="打开后台导航"
            className="menu-button"
            type="button"
            onClick={() => setMenuOpen((current) => !current)}
          >
            菜单
          </button>
          <div className="topbar-title">
            <span>管理后台</span>
            <strong>{title}</strong>
          </div>
          <label className="actor-field">
            <span>操作人标识</span>
            <input
              aria-describedby={
                props.actor.trim().length === 0 ? 'actor-help' : undefined
              }
              autoComplete="off"
              placeholder="用于审计日志"
              value={props.actor}
              onChange={(event) => props.onActorChange(event.target.value)}
            />
          </label>
          <span className="source-pill">
            {props.repositoryMode === 'local' ? '当前浏览器数据' : '管理 API'}
            {props.readOnly ? ' · 只读' : ''}
            {props.pending ? ' · 保存中' : ''}
          </span>
        </header>

        <main aria-busy={props.pending} id="admin-content" tabIndex={-1}>
          {props.notice === null ? null : (
            <Notice notice={props.notice} onReload={props.onReload} />
          )}
          {!props.readOnly && props.actor.trim().length === 0 ? (
            <p className="inline-guidance" id="actor-help">
              修改前请填写操作人标识，保存后将写入审计日志。
            </p>
          ) : null}
          {renderSection(props, canWrite)}
        </main>
      </div>
    </div>
  );
}

function renderSection(props: AdminWorkspaceProps, canWrite: boolean) {
  const common = {
    actor: props.actor,
    canWrite,
    onCommand: props.onCommand,
    snapshot: props.snapshot,
  };
  switch (props.activeSection) {
    case 'overview':
      return (
        <OverviewSection
          onNavigate={props.onSectionChange}
          snapshot={props.snapshot}
          services={props.services}
        />
      );
    case 'access':
      return <AccessSection {...common} />;
    case 'content':
      return <ContentSection {...common} />;
    case 'delivery':
      return <DeliverySection {...common} />;
    case 'feedback':
      return <FeedbackSection {...common} />;
    case 'operations':
      return <OperationsSection {...common} repositoryMode={props.repositoryMode} />;
    case 'usage':
      return <UsageSection {...common} />;
    case 'commerce':
      return <CommerceSection {...common} />;
    case 'controls':
      return <ControlsSection {...common} />;
    case 'audit':
      return <AuditSection snapshot={props.snapshot} />;
    case 'system':
      return (
        <SystemSection
          actor={props.actor}
          canWrite={canWrite}
          onExport={props.onExport}
          onImport={props.onImport}
          services={props.services}
          snapshot={props.snapshot}
        />
      );
  }
}

interface SectionProps {
  actor: string;
  canWrite: boolean;
  snapshot: AdminSnapshot;
  onCommand: (command: AdminCommand) => void;
}

function SectionHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="section-header">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions}
    </div>
  );
}

function OverviewSection({
  snapshot,
  services,
  onNavigate,
}: {
  snapshot: AdminSnapshot;
  services: AdminServiceStatus[];
  onNavigate: (section: AdminSection) => void;
}) {
  const summary = summarizeAdminSnapshot(snapshot);
  const hasRecords =
    snapshot.users.length +
      snapshot.contents.length +
      snapshot.deliveryItems.length +
      snapshot.feedbackCases.length +
      snapshot.jobs.length +
      snapshot.usageAccounts.length +
      snapshot.commercialRecords.length >
    0;
  const metrics = [
    ['有效用户', summary.activeUsers, 'access'],
    ['已发布内容', summary.publishedContents, 'content'],
    ['进行中交付', summary.openDeliveryItems, 'delivery'],
    ['待处理反馈', summary.openFeedbackCases, 'feedback'],
    ['运行中任务', summary.pendingJobs, 'operations'],
    ['失败或配额阻断', summary.failedJobs, 'operations'],
    ['已用单位', summary.usedUnits, 'usage'],
    ['待结算业务', summary.unsettledCommercialRecords, 'commerce'],
  ] as const;
  return (
    <section>
      <SectionHeader
        eyebrow="OPERATIONS"
        title="运营数据，一处掌握"
        description="只汇总当前数据源中已保存的记录；空数据保持为空。"
      />
      {!hasRecords ? (
        <EmptyState
          title="还没有运营记录"
          description="从对应模块登记第一条实际记录，汇总会自动更新。"
          action={
            <button type="button" onClick={() => onNavigate('access')}>
              从用户与权限开始
            </button>
          }
        />
      ) : null}
      <div className="metric-grid" aria-label="运营指标">
        {metrics.map(([label, value, section]) => (
          <button
            className="metric-card"
            key={label}
            type="button"
            onClick={() => onNavigate(section)}
          >
            <span>{label}</span>
            <strong>{value.toLocaleString('zh-CN')}</strong>
            <small>查看记录 →</small>
          </button>
        ))}
      </div>
      <div className="split-grid">
        <article className="panel">
          <PanelHeading title="待处理事项" meta="来自现有记录" />
          <QueueRows
            rows={[
              {
                label: '反馈与申诉',
                value: summary.openFeedbackCases,
                section: 'feedback',
              },
              {
                label: '失败任务',
                value: summary.failedJobs,
                section: 'operations',
              },
              {
                label: '进行中交付',
                value: summary.openDeliveryItems,
                section: 'delivery',
              },
            ]}
            onNavigate={onNavigate}
          />
        </article>
        <article className="panel">
          <PanelHeading title="服务状态" meta="最近一次实际检查" />
          <ServiceList services={services} compact />
        </article>
      </div>
    </section>
  );
}

function AccessSection(props: SectionProps) {
  const [pending, setPending] = useState<ConfirmationRequest | null>(null);
  return (
    <section>
      <SectionHeader
        eyebrow="ACCESS"
        title="用户与权限"
        description="登记用户身份并按职责授予角色；敏感变更必须再次确认。"
      />
      <div className="content-grid">
        <article className="panel form-panel">
          <PanelHeading title="添加用户记录" meta="保存到当前数据源" />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              props.onCommand({
                type: 'user.create',
                actor: props.actor,
                expectedVersion: props.snapshot.version,
                payload: {
                  displayName: textValue(data, 'displayName'),
                  email: textValue(data, 'email'),
                  roles: [textValue(data, 'role') as AdminRole],
                },
              });
            }}
          >
            <Field label="姓名" name="displayName" required />
            <Field label="邮箱" name="email" required type="email" />
            <SelectField
              label="初始角色"
              name="role"
              options={ROLE_OPTIONS.map((role) => ({
                value: role.value,
                label: role.label,
              }))}
            />
            <SubmitButton disabled={!props.canWrite}>保存用户</SubmitButton>
          </form>
        </article>
        <article className="panel table-panel">
          <PanelHeading
            title="用户列表"
            meta={`${String(props.snapshot.users.length)} 条`}
          />
          {props.snapshot.users.length === 0 ? (
            <EmptyState
              compact
              title="暂无用户记录"
              description="添加实际用户后可配置角色与状态。"
            />
          ) : (
            <div className="record-list">
              {props.snapshot.users.map((user) => (
                <article className="record-card" key={user.id}>
                  <div className="record-main">
                    <div>
                      <strong>{user.displayName}</strong>
                      <span>{user.email}</span>
                    </div>
                    <StatusBadge status={user.status} />
                  </div>
                  <div className="tag-row">
                    {user.roles.map((role) => (
                      <span className="tag" key={role}>
                        {roleLabel(role)}
                      </span>
                    ))}
                  </div>
                  <div className="record-actions">
                    <button
                      disabled={!props.canWrite}
                      type="button"
                      onClick={() =>
                        setPending({
                          title: `更新 ${user.displayName} 的权限`,
                          phrase: `授权 ${user.displayName}`,
                          description:
                            '选择新角色后，现有角色将被替换。变更会进入审计日志。',
                          roleSelection: user.roles,
                          buildCommand: (confirmation, roles) => ({
                            type: 'user.roles',
                            actor: props.actor,
                            expectedVersion: props.snapshot.version,
                            payload: {
                              userId: user.id,
                              roles: roles ?? user.roles,
                              confirmation,
                            },
                          }),
                        })
                      }
                    >
                      角色与权限
                    </button>
                    {user.status === 'active' ? (
                      <button
                        className="danger-button"
                        disabled={!props.canWrite}
                        type="button"
                        onClick={() =>
                          setPending({
                            title: `停用 ${user.displayName}`,
                            phrase: `停用 ${user.displayName}`,
                            description:
                              '停用后该用户记录不可继续使用；历史记录和审计日志保留。',
                            buildCommand: (confirmation) => ({
                              type: 'user.suspend',
                              actor: props.actor,
                              expectedVersion: props.snapshot.version,
                              payload: { userId: user.id, confirmation },
                            }),
                          })
                        }
                      >
                        停用
                      </button>
                    ) : (
                      <button
                        disabled={!props.canWrite}
                        type="button"
                        onClick={() =>
                          props.onCommand({
                            type: 'user.restore',
                            actor: props.actor,
                            expectedVersion: props.snapshot.version,
                            payload: { userId: user.id },
                          })
                        }
                      >
                        恢复
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </article>
      </div>
      <article className="panel permission-panel">
        <PanelHeading title="角色权限边界" meta="最小权限原则" />
        <div className="permission-grid">
          {ROLE_OPTIONS.map((role) => (
            <div key={role.value}>
              <strong>{role.label}</strong>
              <span>{role.permission}</span>
            </div>
          ))}
        </div>
      </article>
      <ConfirmationDialog
        request={pending}
        onCancel={() => setPending(null)}
        onConfirm={(command) => {
          props.onCommand(command);
          setPending(null);
        }}
      />
    </section>
  );
}

function ContentSection(props: SectionProps) {
  const [pending, setPending] = useState<ConfirmationRequest | null>(null);
  return (
    <section>
      <SectionHeader
        eyebrow="CONTENT"
        title="课程与内容"
        description="统一管理课程、课时、班级和模板版本；发布前需明确确认。"
      />
      <div className="content-grid">
        <article className="panel form-panel">
          <PanelHeading title="新建内容草稿" meta="默认不发布" />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              props.onCommand({
                type: 'content.create',
                actor: props.actor,
                expectedVersion: props.snapshot.version,
                payload: {
                  kind: textValue(data, 'kind') as ContentKind,
                  title: textValue(data, 'title'),
                },
              });
            }}
          >
            <SelectField
              label="内容类型"
              name="kind"
              options={Object.entries(CONTENT_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <Field label="名称" name="title" required />
            <SubmitButton disabled={!props.canWrite}>创建草稿</SubmitButton>
          </form>
        </article>
        <article className="panel table-panel">
          <PanelHeading
            title="内容版本"
            meta={`${String(props.snapshot.contents.length)} 条`}
          />
          {props.snapshot.contents.length === 0 ? (
            <EmptyState
              compact
              title="暂无内容"
              description="创建草稿后，可在人工确认后发布。"
            />
          ) : (
            <RecordTable
              headers={['内容', '类型', '状态', '版本', '操作']}
              rows={props.snapshot.contents.map((content) => [
                content.title,
                CONTENT_LABELS[content.kind],
                <StatusBadge key="status" status={content.status} />,
                `v${String(content.version)}`,
                <div className="inline-actions" key="actions">
                  {content.status !== 'published' ? (
                    <button
                      disabled={!props.canWrite}
                      type="button"
                      onClick={() =>
                        setPending({
                          title: `发布 ${content.title}`,
                          phrase: `发布 ${content.title}`,
                          description:
                            '发布会让当前版本进入可用状态，请确认内容已完成审核。',
                          buildCommand: (confirmation) => ({
                            type: 'content.transition',
                            actor: props.actor,
                            expectedVersion: props.snapshot.version,
                            payload: {
                              contentId: content.id,
                              status: 'published',
                              confirmation,
                            },
                          }),
                        })
                      }
                    >
                      发布
                    </button>
                  ) : null}
                  {content.status !== 'archived' ? (
                    <button
                      disabled={!props.canWrite}
                      type="button"
                      onClick={() =>
                        setPending({
                          title: `归档 ${content.title}`,
                          phrase: `归档 ${content.title}`,
                          description:
                            '归档会让内容退出当前可用列表，历史版本和审计记录保留。',
                          buildCommand: (confirmation) => ({
                            type: 'content.transition',
                            actor: props.actor,
                            expectedVersion: props.snapshot.version,
                            payload: {
                              contentId: content.id,
                              status: 'archived',
                              confirmation,
                            },
                          }),
                        })
                      }
                    >
                      归档
                    </button>
                  ) : null}
                </div>,
              ])}
            />
          )}
        </article>
      </div>
      <ConfirmationDialog
        request={pending}
        onCancel={() => setPending(null)}
        onConfirm={(command) => {
          props.onCommand(command);
          setPending(null);
        }}
      />
    </section>
  );
}

function DeliverySection(props: SectionProps) {
  return (
    <section>
      <SectionHeader
        eyebrow="DELIVERY"
        title="项目与作业"
        description="跟踪项目、作业和提交的审核状态。"
      />
      <div className="content-grid">
        <article className="panel form-panel">
          <PanelHeading title="登记交付记录" meta="用于运营跟踪" />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              props.onCommand({
                type: 'delivery.create',
                actor: props.actor,
                expectedVersion: props.snapshot.version,
                payload: {
                  kind: textValue(data, 'kind') as DeliveryKind,
                  title: textValue(data, 'title'),
                  ownerLabel: textValue(data, 'ownerLabel'),
                },
              });
            }}
          >
            <SelectField
              label="类型"
              name="kind"
              options={Object.entries(DELIVERY_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <Field label="名称" name="title" required />
            <Field label="负责人或提交人" name="ownerLabel" required />
            <SubmitButton disabled={!props.canWrite}>保存记录</SubmitButton>
          </form>
        </article>
        <article className="panel table-panel">
          <PanelHeading
            title="交付状态"
            meta={`${String(props.snapshot.deliveryItems.length)} 条`}
          />
          {props.snapshot.deliveryItems.length === 0 ? (
            <EmptyState
              compact
              title="暂无项目或作业记录"
              description="登记实际交付后，可更新评审与完成状态。"
            />
          ) : (
            <RecordTable
              headers={['名称', '类型', '负责人', '状态', '更新']}
              rows={props.snapshot.deliveryItems.map((item) => [
                item.title,
                DELIVERY_LABELS[item.kind],
                item.ownerLabel,
                <StatusBadge key="status" status={item.status} />,
                <select
                  aria-label={`更新 ${item.title} 状态`}
                  disabled={!props.canWrite}
                  key="action"
                  value={item.status}
                  onChange={(event) =>
                    props.onCommand({
                      type: 'delivery.transition',
                      actor: props.actor,
                      expectedVersion: props.snapshot.version,
                      payload: {
                        deliveryId: item.id,
                        status: event.target.value as DeliveryStatus,
                      },
                    })
                  }
                >
                  {[
                    'active',
                    'submitted',
                    'reviewing',
                    'needs_revision',
                    'completed',
                    'archived',
                  ].map((status) => (
                    <option key={status} value={status}>
                      {statusLabel(status)}
                    </option>
                  ))}
                </select>,
              ])}
            />
          )}
        </article>
      </div>
    </section>
  );
}

function FeedbackSection(props: SectionProps) {
  return (
    <section>
      <SectionHeader
        eyebrow="SUPPORT"
        title="反馈与申诉"
        description="保留申请人原始描述、处理状态与处理结论，便于复核。"
      />
      <div className="content-grid">
        <article className="panel form-panel">
          <PanelHeading title="登记新事项" meta="反馈 / 申诉 / 工单" />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              props.onCommand({
                type: 'feedback.create',
                actor: props.actor,
                expectedVersion: props.snapshot.version,
                payload: {
                  kind: textValue(data, 'kind') as FeedbackKind,
                  subject: textValue(data, 'subject'),
                  requester: textValue(data, 'requester'),
                  detail: textValue(data, 'detail'),
                },
              });
            }}
          >
            <SelectField
              label="类型"
              name="kind"
              options={[
                { value: 'feedback', label: '产品反馈' },
                { value: 'appeal', label: '申诉' },
                { value: 'support_ticket', label: '客服工单' },
              ]}
            />
            <Field label="主题" name="subject" required />
            <Field label="申请人" name="requester" required />
            <TextAreaField label="原始描述" name="detail" required />
            <SubmitButton disabled={!props.canWrite}>登记事项</SubmitButton>
          </form>
        </article>
        <article className="panel table-panel">
          <PanelHeading
            title="处理队列"
            meta={`${String(props.snapshot.feedbackCases.length)} 条`}
          />
          {props.snapshot.feedbackCases.length === 0 ? (
            <EmptyState
              compact
              title="暂无反馈或申诉"
              description="新事项会按创建时间进入处理队列。"
            />
          ) : (
            <div className="record-list">
              {props.snapshot.feedbackCases.map((item) => (
                <article className="record-card" key={item.id}>
                  <div className="record-main">
                    <div>
                      <strong>{item.subject}</strong>
                      <span>
                        {item.requester} · {feedbackLabel(item.kind)}
                      </span>
                    </div>
                    <StatusBadge status={item.status} />
                  </div>
                  <p>{item.detail}</p>
                  {item.resolution === undefined ? null : (
                    <p className="resolution">
                      <strong>处理说明：</strong>
                      {item.resolution}
                    </p>
                  )}
                  <form
                    className="inline-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
                      props.onCommand({
                        type: 'feedback.transition',
                        actor: props.actor,
                        expectedVersion: props.snapshot.version,
                        payload: {
                          feedbackId: item.id,
                          status: textValue(data, 'status') as FeedbackStatus,
                          resolution: textValue(data, 'resolution'),
                        },
                      });
                    }}
                  >
                    <select
                      aria-label={`${item.subject} 的处理状态`}
                      defaultValue={item.status}
                      name="status"
                    >
                      <option value="open">待处理</option>
                      <option value="in_review">处理中</option>
                      <option value="resolved">已解决</option>
                      <option value="rejected">未支持</option>
                    </select>
                    <input
                      aria-label={`${item.subject} 的处理说明`}
                      defaultValue={item.resolution ?? ''}
                      name="resolution"
                      placeholder="填写处理依据或结论"
                      required
                    />
                    <button disabled={!props.canWrite} type="submit">
                      保存处理
                    </button>
                  </form>
                </article>
              ))}
            </div>
          )}
        </article>
      </div>
    </section>
  );
}

function OperationsSection(
  props: SectionProps & { repositoryMode: 'local' | 'remote' },
) {
  const [pending, setPending] = useState<ConfirmationRequest | null>(null);
  return (
    <section>
      <SectionHeader
        eyebrow="JOBS"
        title="任务与导出"
        description="查看 AI、文件解析、导出与通知任务的状态；付费任务创建时自动预留余额。"
      />
      {props.repositoryMode === 'local' ? (
        <p className="context-note">
          当前数据源只负责持久化任务记录，不会在后台调用执行器。连接管理 API
          后，由服务端队列执行任务。
        </p>
      ) : null}
      <div className="content-grid">
        <article className="panel form-panel">
          <PanelHeading title="登记任务" meta="创建前执行余额与配额校验" />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              props.onCommand({
                type: 'job.create',
                actor: props.actor,
                expectedVersion: props.snapshot.version,
                payload: {
                  kind: textValue(data, 'kind') as JobKind,
                  title: textValue(data, 'title'),
                  workspaceId: textValue(data, 'workspaceId'),
                  estimatedCostMinor: numberValue(data, 'estimatedCostMinor'),
                  safetyMarginMinor: numberValue(data, 'safetyMarginMinor'),
                },
              });
            }}
          >
            <SelectField
              label="任务类型"
              name="kind"
              options={Object.entries(JOB_LABELS).map(([value, label]) => ({
                value,
                label,
              }))}
            />
            <Field label="任务名称" name="title" required />
            <Field label="Workspace ID" name="workspaceId" required />
            <Field
              label="预计费用（分）"
              min="0"
              name="estimatedCostMinor"
              required
              type="number"
              value="0"
            />
            <Field
              label="安全余量（分）"
              min="0"
              name="safetyMarginMinor"
              required
              type="number"
              value="0"
            />
            <SubmitButton disabled={!props.canWrite}>校验并登记</SubmitButton>
          </form>
        </article>
        <article className="panel table-panel">
          <PanelHeading
            title="任务队列"
            meta={`${String(props.snapshot.jobs.length)} 条`}
          />
          {props.snapshot.jobs.length === 0 ? (
            <EmptyState
              compact
              title="暂无任务记录"
              description="不会使用模板结果填充空队列。"
            />
          ) : (
            <div className="record-list">
              {props.snapshot.jobs.map((job) => (
                <article className="record-card" key={job.id}>
                  <div className="record-main">
                    <div>
                      <strong>{job.title}</strong>
                      <span>
                        {JOB_LABELS[job.kind]} · {job.workspaceId}
                      </span>
                    </div>
                    <StatusBadge status={job.status} />
                  </div>
                  <dl className="record-facts">
                    <div>
                      <dt>尝试次数</dt>
                      <dd>{job.attempts}</dd>
                    </div>
                    <div>
                      <dt>费用上限</dt>
                      <dd>
                        {(job.estimatedCostMinor + job.safetyMarginMinor) / 100}
                      </dd>
                    </div>
                    <div>
                      <dt>错误代码</dt>
                      <dd>{job.errorCode ?? '—'}</dd>
                    </div>
                  </dl>
                  {job.errorMessage === undefined ? null : (
                    <p className="error-detail">{job.errorMessage}</p>
                  )}
                  <form
                    className="inline-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
                      const errorCode = optionalText(data, 'errorCode');
                      const errorMessage = optionalText(data, 'errorMessage');
                      props.onCommand({
                        type: 'job.transition',
                        actor: props.actor,
                        expectedVersion: props.snapshot.version,
                        payload: {
                          jobId: job.id,
                          status: textValue(data, 'status') as JobStatus,
                          ...(errorCode === undefined ? {} : { errorCode }),
                          ...(errorMessage === undefined ? {} : { errorMessage }),
                        },
                      });
                    }}
                  >
                    <select
                      aria-label={`${job.title} 的任务状态`}
                      defaultValue={job.status}
                      name="status"
                    >
                      {[
                        'queued',
                        'running',
                        'waiting_for_review',
                        'completed',
                        'failed',
                        'quota_exhausted',
                        'stale',
                      ].map((status) => (
                        <option key={status} value={status}>
                          {statusLabel(status)}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label={`${job.title} 的错误代码`}
                      defaultValue={job.errorCode ?? ''}
                      name="errorCode"
                      placeholder="错误代码（可选）"
                    />
                    <input
                      aria-label={`${job.title} 的错误详情`}
                      defaultValue={job.errorMessage ?? ''}
                      name="errorMessage"
                      placeholder="安全错误说明（可选）"
                    />
                    <button disabled={!props.canWrite} type="submit">
                      保存状态
                    </button>
                  </form>
                  <div className="record-actions">
                    {job.status === 'failed' ||
                    job.status === 'quota_exhausted' ? (
                      <button
                        disabled={!props.canWrite}
                        type="button"
                        onClick={() =>
                          setPending({
                            title: `重试 ${job.title}`,
                            phrase: `重试 ${job.title}`,
                            description:
                              '只有在失败原因或配额问题已处理后才应重新排队。',
                            buildCommand: (confirmation) => ({
                              type: 'job.transition',
                              actor: props.actor,
                              expectedVersion: props.snapshot.version,
                              payload: {
                                jobId: job.id,
                                status: 'queued',
                                confirmation,
                              },
                            }),
                          })
                        }
                      >
                        重试排队
                      </button>
                    ) : null}
                    {!['completed', 'cancelled'].includes(job.status) ? (
                      <button
                        className="danger-button"
                        disabled={!props.canWrite}
                        type="button"
                        onClick={() =>
                          setPending({
                            title: `取消 ${job.title}`,
                            phrase: `取消 ${job.title}`,
                            description:
                              '取消只改变任务记录；已产生的交付文件与审计事件不会删除。',
                            buildCommand: (confirmation) => ({
                              type: 'job.transition',
                              actor: props.actor,
                              expectedVersion: props.snapshot.version,
                              payload: {
                                jobId: job.id,
                                status: 'cancelled',
                                confirmation,
                              },
                            }),
                          })
                        }
                      >
                        取消任务
                      </button>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </article>
      </div>
      <ConfirmationDialog
        request={pending}
        onCancel={() => setPending(null)}
        onConfirm={(command) => {
          props.onCommand(command);
          setPending(null);
        }}
      />
    </section>
  );
}

function UsageSection(props: SectionProps) {
  const [pending, setPending] = useState<ConfirmationRequest | null>(null);
  return (
    <section>
      <SectionHeader
        eyebrow="USAGE"
        title="用量与限额"
        description="按 Workspace 管理周期配额、预留量与余额；超限或余额不足时阻止新任务。"
      />
      <div className="content-grid">
        <article className="panel form-panel">
          <PanelHeading title="设置用量账户" meta="创建或更新" />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              props.onCommand({
                type: 'usage.account.upsert',
                actor: props.actor,
                expectedVersion: props.snapshot.version,
                payload: {
                  workspaceId: textValue(data, 'workspaceId'),
                  workspaceName: textValue(data, 'workspaceName'),
                  period: textValue(data, 'period'),
                  quotaUnits: numberValue(data, 'quotaUnits'),
                  usedUnits: numberValue(data, 'usedUnits'),
                  reservedUnits: numberValue(data, 'reservedUnits'),
                  balanceMinor: numberValue(data, 'balanceMinor'),
                  currency: textValue(data, 'currency') as 'CNY' | 'USD',
                },
              });
            }}
          >
            <Field label="Workspace ID" name="workspaceId" required />
            <Field label="Workspace 名称" name="workspaceName" required />
            <Field label="计量周期" name="period" placeholder="2026-07" required />
            <Field label="总配额" min="0" name="quotaUnits" required type="number" />
            <Field
              label="已用量"
              min="0"
              name="usedUnits"
              required
              type="number"
              value="0"
            />
            <Field
              label="预留量"
              min="0"
              name="reservedUnits"
              required
              type="number"
              value="0"
            />
            <Field
              label="可用余额（分）"
              min="0"
              name="balanceMinor"
              required
              type="number"
              value="0"
            />
            <SelectField
              label="币种"
              name="currency"
              options={[
                { value: 'CNY', label: 'CNY' },
                { value: 'USD', label: 'USD' },
              ]}
            />
            <SubmitButton disabled={!props.canWrite}>保存账户</SubmitButton>
          </form>
        </article>
        <article className="panel table-panel">
          <PanelHeading
            title="配额账户"
            meta={`${String(props.snapshot.usageAccounts.length)} 个`}
          />
          {props.snapshot.usageAccounts.length === 0 ? (
            <EmptyState
              compact
              title="暂无用量账户"
              description="付费任务必须先有可校验的余额与配额记录。"
            />
          ) : (
            <div className="record-list">
              {props.snapshot.usageAccounts.map((account) => {
                const consumed = account.usedUnits + account.reservedUnits;
                const ratio =
                  account.quotaUnits === 0
                    ? 0
                    : Math.min(100, (consumed / account.quotaUnits) * 100);
                return (
                  <article className="record-card" key={account.id}>
                    <div className="record-main">
                      <div>
                        <strong>{account.workspaceName}</strong>
                        <span>
                          {account.workspaceId} · {account.period}
                        </span>
                      </div>
                      <div className="balance-value">
                        <span>可用余额</span>
                        <strong>
                          {(account.balanceMinor / 100).toLocaleString('zh-CN', {
                            style: 'currency',
                            currency: account.currency,
                          })}
                        </strong>
                      </div>
                    </div>
                    <div
                      aria-label={`已使用 ${String(consumed)} / ${String(account.quotaUnits)}`}
                      aria-valuemax={account.quotaUnits}
                      aria-valuemin={0}
                      aria-valuenow={consumed}
                      className="quota-track"
                      role="progressbar"
                    >
                      <span style={{ width: `${String(ratio)}%` }} />
                    </div>
                    <div className="quota-labels">
                      <span>已用 {account.usedUnits}</span>
                      <span>预留 {account.reservedUnits}</span>
                      <span>总量 {account.quotaUnits}</span>
                    </div>
                    <button
                      disabled={!props.canWrite}
                      type="button"
                      onClick={() =>
                        setPending({
                          title: `记录 ${account.workspaceName} 的账本`,
                          phrase: `记账 ${account.workspaceName}`,
                          description:
                            '金额单位为分，用量单位按当前 Workspace 配额定义。',
                          ledgerAccount: {
                            workspaceId: account.workspaceId,
                            workspaceName: account.workspaceName,
                          },
                          buildCommand: (confirmation, _roles, ledger) => ({
                            type: 'usage.ledger.record',
                            actor: props.actor,
                            expectedVersion: props.snapshot.version,
                            payload: {
                              workspaceId: account.workspaceId,
                              direction: ledger?.direction ?? 'credit',
                              amountMinor: ledger?.amountMinor ?? 0,
                              units: ledger?.units ?? 0,
                              description: ledger?.description ?? '',
                              confirmation,
                            },
                          }),
                        })
                      }
                    >
                      记一笔
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </article>
      </div>
      <article className="panel">
        <PanelHeading
          title="消费与余额流水"
          meta={`${String(props.snapshot.usageLedger.length)} 条`}
        />
        {props.snapshot.usageLedger.length === 0 ? (
          <EmptyState
            compact
            title="暂无流水"
            description="每次充值、扣减、预留或释放都会保留说明。"
          />
        ) : (
          <RecordTable
            headers={['时间', 'Workspace', '方向', '金额', '用量', '说明']}
            rows={[...props.snapshot.usageLedger].reverse().map((entry) => [
              formatTime(entry.createdAt),
              entry.workspaceId,
              directionLabel(entry.direction),
              `${String(entry.amountMinor)} 分`,
              entry.units,
              entry.description,
            ])}
          />
        )}
      </article>
      <ConfirmationDialog
        request={pending}
        onCancel={() => setPending(null)}
        onConfirm={(command) => {
          props.onCommand(command);
          setPending(null);
        }}
      />
    </section>
  );
}

function CommerceSection(props: SectionProps) {
  const [pending, setPending] = useState<ConfirmationRequest | null>(null);
  return (
    <section>
      <SectionHeader
        eyebrow="COMMERCE"
        title="订单与余额"
        description="记录订单、订阅与退款的实际状态；支付失败不影响已有数据导出。"
      />
      <div className="content-grid">
        <article className="panel form-panel">
          <PanelHeading title="登记商业记录" meta="不调用未配置的支付服务" />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const reference = textValue(data, 'reference');
              setPending({
                title: `记录 ${reference}`,
                phrase: `记录 ${reference}`,
                description: '请核对金额、币种、状态和业务单号。',
                buildCommand: (confirmation) => ({
                  type: 'commercial.record',
                  actor: props.actor,
                  expectedVersion: props.snapshot.version,
                  payload: {
                    kind: textValue(data, 'kind') as
                      | 'order'
                      | 'refund'
                      | 'subscription',
                    reference,
                    workspaceId: textValue(data, 'workspaceId'),
                    status: textValue(data, 'status') as
                      | 'pending'
                      | 'paid'
                      | 'failed'
                      | 'refunded'
                      | 'cancelled',
                    amountMinor: numberValue(data, 'amountMinor'),
                    currency: textValue(data, 'currency') as 'CNY' | 'USD',
                    note: textValue(data, 'note'),
                    confirmation,
                  },
                }),
              });
            }}
          >
            <SelectField
              label="类型"
              name="kind"
              options={[
                { value: 'order', label: '订单' },
                { value: 'subscription', label: '订阅' },
                { value: 'refund', label: '退款' },
              ]}
            />
            <Field label="业务单号" name="reference" required />
            <Field label="Workspace ID" name="workspaceId" required />
            <SelectField
              label="状态"
              name="status"
              options={[
                { value: 'pending', label: '待处理' },
                { value: 'paid', label: '已支付' },
                { value: 'failed', label: '失败' },
                { value: 'refunded', label: '已退款' },
                { value: 'cancelled', label: '已取消' },
              ]}
            />
            <Field
              label="金额（分）"
              min="0"
              name="amountMinor"
              required
              type="number"
            />
            <SelectField
              label="币种"
              name="currency"
              options={[
                { value: 'CNY', label: 'CNY' },
                { value: 'USD', label: 'USD' },
              ]}
            />
            <TextAreaField label="记录说明" name="note" required />
            <SubmitButton disabled={!props.canWrite}>核对并记录</SubmitButton>
          </form>
        </article>
        <article className="panel table-panel">
          <PanelHeading
            title="业务记录"
            meta={`${String(props.snapshot.commercialRecords.length)} 条`}
          />
          {props.snapshot.commercialRecords.length === 0 ? (
            <EmptyState
              compact
              title="暂无订单或退款"
              description="这里不会显示预置营收或模拟交易。"
            />
          ) : (
            <RecordTable
              headers={['单号', '类型', 'Workspace', '状态', '金额', '时间']}
              rows={[...props.snapshot.commercialRecords]
                .reverse()
                .map((record) => [
                  record.reference,
                  commercialLabel(record.kind),
                  record.workspaceId,
                  <StatusBadge key="status" status={record.status} />,
                  (record.amountMinor / 100).toLocaleString('zh-CN', {
                    style: 'currency',
                    currency: record.currency,
                  }),
                  formatTime(record.createdAt),
                ])}
            />
          )}
        </article>
      </div>
      <ConfirmationDialog
        request={pending}
        onCancel={() => setPending(null)}
        onConfirm={(command) => {
          props.onCommand(command);
          setPending(null);
        }}
      />
    </section>
  );
}

function ControlsSection(props: SectionProps) {
  const [pending, setPending] = useState<ConfirmationRequest | null>(null);
  return (
    <section>
      <SectionHeader
        eyebrow="CONTROLS"
        title="功能开关"
        description="所有开关都有作用域、原因、版本和审计记录；变更需要再次确认。"
      />
      <div className="content-grid">
        <article className="panel form-panel">
          <PanelHeading title="创建功能开关" meta="仅创建，不自动启用服务" />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              props.onCommand({
                type: 'feature-flag.upsert',
                actor: props.actor,
                expectedVersion: props.snapshot.version,
                payload: {
                  key: textValue(data, 'key'),
                  enabled: false,
                  scope: textValue(data, 'scope'),
                  reason: textValue(data, 'reason'),
                },
              });
            }}
          >
            <Field label="唯一标识" name="key" placeholder="course-review" required />
            <Field label="作用域" name="scope" placeholder="workspace:..." required />
            <TextAreaField label="创建原因" name="reason" required />
            <SubmitButton disabled={!props.canWrite}>创建开关</SubmitButton>
          </form>
        </article>
        <article className="panel table-panel">
          <PanelHeading
            title="开关列表"
            meta={`${String(props.snapshot.featureFlags.length)} 个`}
          />
          {props.snapshot.featureFlags.length === 0 ? (
            <EmptyState
              compact
              title="暂无功能开关"
              description="功能默认由产品配置决定，不会虚构灰度状态。"
            />
          ) : (
            <div className="record-list">
              {props.snapshot.featureFlags.map((flag) => (
                <article className="record-card" key={flag.id}>
                  <div className="record-main">
                    <div>
                      <strong>{flag.key}</strong>
                      <span>{flag.scope}</span>
                    </div>
                    <StatusBadge status={flag.enabled ? 'enabled' : 'disabled'} />
                  </div>
                  <p>{flag.reason}</p>
                  <button
                    disabled={!props.canWrite}
                    type="button"
                    onClick={() =>
                      setPending({
                        title: `${flag.enabled ? '停用' : '启用'} ${flag.key}`,
                        phrase: `切换 ${flag.key}`,
                        description: '变更会立即保存到当前数据源并写入审计日志。',
                        buildCommand: (confirmation) => ({
                          type: 'feature-flag.upsert',
                          actor: props.actor,
                          expectedVersion: props.snapshot.version,
                          payload: {
                            key: flag.key,
                            enabled: !flag.enabled,
                            scope: flag.scope,
                            reason: flag.reason,
                            confirmation,
                          },
                        }),
                      })
                    }
                  >
                    {flag.enabled ? '停用' : '启用'}
                  </button>
                </article>
              ))}
            </div>
          )}
        </article>
      </div>
      <ConfirmationDialog
        request={pending}
        onCancel={() => setPending(null)}
        onConfirm={(command) => {
          props.onCommand(command);
          setPending(null);
        }}
      />
    </section>
  );
}

function AuditSection({ snapshot }: { snapshot: AdminSnapshot }) {
  return (
    <section>
      <SectionHeader
        eyebrow="AUDIT"
        title="审计日志"
        description="按发生顺序保留操作人、动作、对象、结果与时间；界面不提供删除入口。"
      />
      <article className="panel">
        <PanelHeading
          title="不可在界面修改的事件记录"
          meta={`${String(snapshot.auditEvents.length)} 条`}
        />
        {snapshot.auditEvents.length === 0 ? (
          <EmptyState
            compact
            title="暂无审计事件"
            description="首次修改保存后，事件会自动出现。"
          />
        ) : (
          <RecordTable
            headers={['序号', '时间', '操作人', '动作', '对象', '摘要']}
            rows={[...snapshot.auditEvents].reverse().map((event) => [
              event.sequence,
              formatTime(event.createdAt),
              event.actor,
              event.action,
              `${event.targetType}:${event.targetId}`,
              event.summary,
            ])}
          />
        )}
      </article>
    </section>
  );
}

function SystemSection({
  actor,
  canWrite,
  services,
  snapshot,
  onExport,
  onImport,
}: {
  actor: string;
  canWrite: boolean;
  services: AdminServiceStatus[];
  snapshot: AdminSnapshot;
  onExport: () => void;
  onImport: (file: File, confirmation: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const failedJobs = snapshot.jobs.filter(
    (job) => job.status === 'failed' || job.status === 'quota_exhausted',
  );
  return (
    <section>
      <SectionHeader
        eyebrow="SYSTEM"
        title="服务健康与错误"
        description="只展示最近一次实际检查与已记录错误，不用预设数字表示服务正常。"
        actions={
          <button type="button" onClick={onExport}>
            导出数据与审计
          </button>
        }
      />
      <div className="split-grid">
        <article className="panel">
          <PanelHeading title="服务检查" meta="最近读取结果" />
          <ServiceList services={services} />
        </article>
        <article className="panel">
          <PanelHeading title="错误中心" meta={`${String(failedJobs.length)} 条`} />
          {failedJobs.length === 0 ? (
            <EmptyState
              compact
              title="没有已记录的失败任务"
              description="这不代表未配置服务可用；请同时查看服务检查。"
            />
          ) : (
            <div className="record-list">
              {failedJobs.map((job) => (
                <div className="error-row" key={job.id}>
                  <StatusBadge status={job.status} />
                  <div>
                    <strong>{job.title}</strong>
                    <span>
                      {job.errorCode ?? '未提供错误代码'} ·{' '}
                      {job.errorMessage ?? '未提供错误说明'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </article>
      </div>
      <article className="panel import-panel">
        <PanelHeading title="数据迁移" meta="JSON 数据包" />
        <p>
          导入会先校验 Schema，再完整覆盖当前数据集。请先导出备份，并输入确认词。
        </p>
        <div className="import-controls">
          <label>
            <span>选择数据包</span>
            <input
              accept="application/json,.json"
              type="file"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          <label>
            <span>
              输入 <strong>导入并覆盖</strong>
            </span>
            <input
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <button
            className="danger-button"
            disabled={
              !canWrite ||
              actor.trim().length === 0 ||
              file === null ||
              confirmation !== '导入并覆盖'
            }
            type="button"
            onClick={() => {
              if (file !== null) {
                onImport(file, confirmation);
              }
            }}
          >
            校验并导入
          </button>
        </div>
      </article>
    </section>
  );
}

interface ConfirmationRequest {
  title: string;
  phrase: string;
  description: string;
  roleSelection?: AdminRole[];
  ledgerAccount?: { workspaceId: string; workspaceName: string };
  buildCommand: (
    confirmation: string,
    roles?: AdminRole[],
    ledger?: {
      direction: 'credit' | 'debit' | 'reserve' | 'release';
      amountMinor: number;
      units: number;
      description: string;
    },
  ) => AdminCommand;
}

function ConfirmationDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: ConfirmationRequest | null;
  onCancel: () => void;
  onConfirm: (command: AdminCommand) => void;
}) {
  const [confirmation, setConfirmation] = useState('');
  const [roles, setRoles] = useState<AdminRole[]>([]);
  const [direction, setDirection] = useState<
    'credit' | 'debit' | 'reserve' | 'release'
  >('credit');
  const [amountMinor, setAmountMinor] = useState(0);
  const [units, setUnits] = useState(0);
  const [description, setDescription] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setConfirmation('');
    setRoles(request?.roleSelection ?? []);
    setDirection('credit');
    setAmountMinor(0);
    setUnits(0);
    setDescription('');
  }, [request]);

  useEffect(() => {
    if (request === null) {
      return;
    }
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current;
    const firstFocusable = dialog?.querySelector<HTMLElement>(
      'input, select, textarea, button, [tabindex]:not([tabindex="-1"])',
    );
    firstFocusable?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== 'Tab' || dialog === null) {
        return;
      }
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [onCancel, request]);

  if (request === null) {
    return null;
  }

  return (
    <div
      aria-labelledby="confirm-title"
      aria-modal="true"
      className="dialog-backdrop"
      role="alertdialog"
    >
      <div className="confirm-dialog" ref={dialogRef} tabIndex={-1}>
        <span className="eyebrow">REVIEW</span>
        <h2 id="confirm-title">{request.title}</h2>
        <p>{request.description}</p>
        {request.roleSelection === undefined ? null : (
          <fieldset>
            <legend>角色</legend>
            <div className="checkbox-grid">
              {ROLE_OPTIONS.map((role) => (
                <label key={role.value}>
                  <input
                    checked={roles.includes(role.value)}
                    type="checkbox"
                    onChange={(event) =>
                      setRoles((current) =>
                        event.target.checked
                          ? [...new Set([...current, role.value])]
                          : current.filter((candidate) => candidate !== role.value),
                      )
                    }
                  />
                  <span>{role.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {request.ledgerAccount === undefined ? null : (
          <div className="ledger-fields">
            <SelectField
              label="方向"
              name="ledgerDirection"
              options={[
                { value: 'credit', label: '充值' },
                { value: 'debit', label: '扣减' },
                { value: 'reserve', label: '预留' },
                { value: 'release', label: '释放' },
              ]}
              value={direction}
              onChange={(value) =>
                setDirection(
                  value as 'credit' | 'debit' | 'reserve' | 'release',
                )
              }
            />
            <label>
              <span>金额（分）</span>
              <input
                min="0"
                type="number"
                value={amountMinor}
                onChange={(event) => setAmountMinor(event.target.valueAsNumber)}
              />
            </label>
            <label>
              <span>用量单位</span>
              <input
                min="0"
                type="number"
                value={units}
                onChange={(event) => setUnits(event.target.valueAsNumber)}
              />
            </label>
            <label>
              <span>说明</span>
              <input
                required
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
          </div>
        )}
        <label>
          <span>
            输入 <strong>{request.phrase}</strong>
          </span>
          <input
            autoFocus
            autoComplete="off"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button
            className="danger-button"
            disabled={
              confirmation !== request.phrase ||
              (request.roleSelection !== undefined && roles.length === 0) ||
              (request.ledgerAccount !== undefined &&
                description.trim().length === 0)
            }
            type="button"
            onClick={() =>
              onConfirm(
                request.buildCommand(confirmation, roles, {
                  direction,
                  amountMinor: Number.isFinite(amountMinor) ? amountMinor : 0,
                  units: Number.isFinite(units) ? units : 0,
                  description,
                }),
              )
            }
          >
            确认并保存
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  name,
  type = 'text',
  required,
  placeholder,
  min,
  value,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  min?: string;
  value?: string;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        defaultValue={value}
        min={min}
        name={name}
        placeholder={placeholder}
        required={required}
        type={type}
      />
    </label>
  );
}

function TextAreaField({
  label,
  name,
  required,
}: {
  label: string;
  name: string;
  required?: boolean;
}) {
  return (
    <label>
      <span>{label}</span>
      <textarea name={name} required={required} rows={4} />
    </label>
  );
}

function SelectField({
  label,
  name,
  options,
  value,
  onChange,
}: {
  label: string;
  name: string;
  options: Array<{ value: string; label: string }>;
  value?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <select
        name={name}
        value={value}
        onChange={
          onChange === undefined ? undefined : (event) => onChange(event.target.value)
        }
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SubmitButton({
  disabled,
  children,
}: {
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <button className="primary-button" disabled={disabled} type="submit">
      {children}
    </button>
  );
}

function PanelHeading({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="panel-heading">
      <h2>{title}</h2>
      <span>{meta}</span>
    </div>
  );
}

function EmptyState({
  title,
  description,
  action,
  compact = false,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'empty-state empty-state--compact' : 'empty-state'}>
      <span aria-hidden="true">□</span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

function Notice({
  notice,
  onReload,
}: {
  notice: AdminNotice;
  onReload: () => void;
}) {
  return (
    <div
      aria-live={notice.kind === 'success' ? 'polite' : 'assertive'}
      className={`notice notice--${notice.kind}`}
      role={notice.kind === 'success' ? 'status' : 'alert'}
    >
      <span>{notice.message}</span>
      {notice.kind === 'conflict' || notice.kind === 'offline' ? (
        <button type="button" onClick={onReload}>
          重新读取
        </button>
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-badge--${status}`}>{statusLabel(status)}</span>;
}

function RecordTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: ReactNode[][];
}) {
  return (
    <div className="table-scroll" tabIndex={0}>
      <table>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ServiceList({
  services,
  compact = false,
}: {
  services: AdminServiceStatus[];
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'service-list service-list--compact' : 'service-list'}>
      {services.map((service) => (
        <article className="service-row" key={service.id}>
          <span
            className={`service-indicator service-indicator--${service.status}`}
            aria-hidden="true"
          />
          <div>
            <strong>{service.label}</strong>
            <span>{service.detail}</span>
          </div>
          <StatusBadge status={service.status} />
        </article>
      ))}
    </div>
  );
}

function QueueRows({
  rows,
  onNavigate,
}: {
  rows: Array<{ label: string; value: number; section: AdminSection }>;
  onNavigate: (section: AdminSection) => void;
}) {
  return (
    <div className="queue-rows">
      {rows.map((row) => (
        <button key={row.label} type="button" onClick={() => onNavigate(row.section)}>
          <span>{row.label}</span>
          <strong>{row.value}</strong>
        </button>
      ))}
    </div>
  );
}

function LoadingScreen() {
  return (
    <main className="state-screen" aria-busy="true">
      <span className="loading-mark" aria-hidden="true">
        ■
      </span>
      <h1>正在读取管理数据</h1>
      <p>校验本地数据库或受保护的管理 API。</p>
    </main>
  );
}

function FailureScreen({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <main className="state-screen">
      <span className="eyebrow">ERROR</span>
      <h1>管理数据不可用</h1>
      <p>{message}</p>
      <button type="button" onClick={onRetry}>
        重试
      </button>
    </main>
  );
}

function textValue(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}

function optionalText(data: FormData, name: string): string | undefined {
  const value = textValue(data, name).trim();
  return value.length === 0 ? undefined : value;
}

function numberValue(data: FormData, name: string): number {
  return Number(textValue(data, name));
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(date);
}

function roleLabel(role: AdminRole): string {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role;
}

function feedbackLabel(kind: FeedbackKind): string {
  return {
    feedback: '产品反馈',
    appeal: '申诉',
    support_ticket: '客服工单',
  }[kind];
}

function commercialLabel(kind: 'order' | 'refund' | 'subscription'): string {
  return { order: '订单', refund: '退款', subscription: '订阅' }[kind];
}

function directionLabel(
  direction: 'credit' | 'debit' | 'reserve' | 'release',
): string {
  return {
    credit: '充值',
    debit: '扣减',
    reserve: '预留',
    release: '释放',
  }[direction];
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: '有效',
    suspended: '已停用',
    draft: '草稿',
    published: '已发布',
    archived: '已归档',
    submitted: '已提交',
    reviewing: '评审中',
    needs_revision: '需修改',
    completed: '已完成',
    open: '待处理',
    in_review: '处理中',
    resolved: '已解决',
    rejected: '未支持',
    queued: '排队中',
    running: '运行中',
    waiting_for_review: '待审核',
    failed: '失败',
    cancelled: '已取消',
    quota_exhausted: '配额不足',
    stale: '已过期',
    pending: '待处理',
    paid: '已支付',
    refunded: '已退款',
    enabled: '已启用',
    disabled: '已停用',
    healthy: '正常',
    degraded: '降级',
    unavailable: '不可用',
    unconfigured: '未配置',
  };
  return labels[status] ?? status;
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误。';
}

function noticeForError(error: unknown): AdminNotice {
  if (error instanceof AdminConflictError) {
    return { kind: 'conflict', message: error.message };
  }
  if (error instanceof AdminQuotaError) {
    return { kind: 'quota_exhausted', message: error.message };
  }
  if (
    error instanceof AdminConfirmationError ||
    error instanceof AdminValidationError
  ) {
    return { kind: 'error', message: error.message };
  }
  if (error instanceof AdminPermissionError) {
    return { kind: 'permission_denied', message: error.message };
  }
  return { kind: 'error', message: readableError(error) };
}

function exportSnapshot(snapshot: AdminSnapshot | undefined): void {
  if (snapshot === undefined) {
    return;
  }
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `zuocheng-admin-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

import { useState, type ChangeEvent } from 'react';

export type StudentSurface = 'workbench' | 'identity';

export function studentSurfaceForPath(pathname: string): StudentSurface {
  return pathname.startsWith('/account') || pathname.startsWith('/auth')
    ? 'identity'
    : 'workbench';
}

export interface WorkbenchShellProps {
  onLogin(): void;
  onRegister(): void;
}

interface WorkflowStage {
  number: string;
  label: string;
  description: string;
  prerequisite: string | null;
}

const workflowStages: WorkflowStage[] = [
  {
    number: '01',
    label: '定义任务',
    description: '交付目标、听众与约束',
    prerequisite: null,
  },
  {
    number: '02',
    label: '材料解析',
    description: '文件、页码与原文锚点',
    prerequisite: '需先添加材料',
  },
  {
    number: '03',
    label: '选择证据',
    description: '原文、备注与引用格式',
    prerequisite: '需先完成任务定义与材料处理',
  },
  {
    number: '04',
    label: '组织结构',
    description: '排序、锁定与证据绑定',
    prerequisite: '需先选择可引用证据',
  },
  {
    number: '05',
    label: '编辑核验',
    description: '逐页编辑与规则检查',
    prerequisite: '需先建立内容结构',
  },
  {
    number: '06',
    label: '正式导出',
    description: '文件、讲稿与来源索引',
    prerequisite: '需先完成编辑核验',
  },
];

function formatFileSize(bytes: number) {
  if (bytes < 1_024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1_048_576) {
    return `${(bytes / 1_024).toFixed(1)} KB`;
  }
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function MaterialIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v5h5M9.5 13h6M9.5 16.5h6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

export function WorkbenchShell({
  onLogin,
  onRegister,
}: WorkbenchShellProps) {
  const [materials, setMaterials] = useState<File[]>([]);

  const handleMaterials = (event: ChangeEvent<HTMLInputElement>) => {
    setMaterials(Array.from(event.currentTarget.files ?? []));
  };

  return (
    <main className="workbench-shell" id="main-content">
      <header className="workbench-topbar">
        <a className="brand-lockup" href="/" aria-label="做成首页">
          <span aria-hidden="true">■</span>
          <b>做成</b>
          <small>STUDENT WORKBENCH</small>
        </a>
        <div className="workbench-topbar__context">
          <span>任务工作台</span>
          <i aria-hidden="true" />
          <strong>未命名任务</strong>
        </div>
        <nav className="workbench-account" aria-label="账号">
          <button
            className="button button--quiet button--compact"
            onClick={onLogin}
            type="button"
          >
            登录
          </button>
          <button
            className="button button--compact"
            onClick={onRegister}
            type="button"
          >
            注册
          </button>
        </nav>
      </header>

      <header className="workbench-project-header">
        <div>
          <p className="eyebrow">New task / 新任务</p>
          <h1>把交付先定义清楚。</h1>
          <p>
            填写任务要求并添加材料。证据、结构与导出会在所需信息准备好后开放。
          </p>
        </div>
        <div className="workbench-project-status" role="status">
          <span aria-hidden="true" />
          <div>
            <strong>未保存</strong>
            <small>当前填写尚未写入项目</small>
          </div>
        </div>
      </header>

      <div className="workbench-layout">
        <aside className="workflow-rail">
          <div className="workflow-rail__heading">
            <span>WORKFLOW</span>
            <strong>6 个阶段</strong>
          </div>
          <ol aria-label="任务工作流">
            {workflowStages.map((stage, index) => {
              const active = index === 0;
              return (
                <li className={active ? 'is-active' : undefined} key={stage.number}>
                  <button
                    aria-current={active ? 'step' : undefined}
                    disabled={!active}
                    type="button"
                  >
                    <span className="workflow-stage__number">{stage.number}</span>
                    <span className="workflow-stage__copy">
                      <strong>{stage.label}</strong>
                      <small>{stage.description}</small>
                      {stage.prerequisite === null ? null : (
                        <em>{stage.prerequisite}</em>
                      )}
                    </span>
                    <span className="workflow-stage__state" aria-hidden="true">
                      {active ? '●' : '○'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>

        <section className="workbench-canvas" aria-labelledby="task-definition-title">
          <header className="workbench-section-header">
            <div>
              <span className="section-kicker">01 / DEFINE</span>
              <h2 id="task-definition-title">任务定义与交付约束</h2>
              <p>这些字段将决定后续证据筛选、结构和核验标准。</p>
            </div>
            <span className="status-pill">填写中</span>
          </header>

          <form className="task-definition-form">
            <div className="field field--span-2">
              <label htmlFor="task-name">任务名称</label>
              <input
                id="task-name"
                maxLength={120}
                name="taskName"
                placeholder="例如：人工智能课程期末汇报"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="task-audience">听众</label>
              <input
                id="task-audience"
                maxLength={160}
                name="audience"
                placeholder="老师、同学、评委…"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="task-deadline">截止时间</label>
              <input id="task-deadline" name="deadline" required type="datetime-local" />
            </div>
            <div className="field">
              <label htmlFor="task-scope">页面或字数</label>
              <input
                id="task-scope"
                maxLength={80}
                name="scope"
                placeholder="例如：12 页 / 3000 字"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="task-duration">演讲时长</label>
              <div className="input-with-suffix">
                <input
                  id="task-duration"
                  min={1}
                  name="durationMinutes"
                  placeholder="10"
                  type="number"
                />
                <span>分钟</span>
              </div>
            </div>
            <div className="field">
              <label htmlFor="task-format">输出格式</label>
              <select defaultValue="" id="task-format" name="outputFormat" required>
                <option disabled value="">
                  选择格式
                </option>
                <option value="presentation">演示文稿</option>
                <option value="report">报告</option>
                <option value="document">文档</option>
                <option value="custom">自定义</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="task-tone">语气</label>
              <select defaultValue="" id="task-tone" name="tone">
                <option disabled value="">
                  选择语气
                </option>
                <option value="academic">学术严谨</option>
                <option value="concise">清晰简洁</option>
                <option value="persuasive">有说服力</option>
                <option value="narrative">叙事表达</option>
              </select>
            </div>
            <div className="field field--span-2">
              <label htmlFor="task-rubric">评分标准</label>
              <textarea
                id="task-rubric"
                maxLength={2_000}
                name="rubric"
                placeholder="粘贴评分表，或写下老师最看重的判断标准"
                rows={3}
              />
            </div>
            <div className="field">
              <label htmlFor="task-required">必须包含</label>
              <textarea
                id="task-required"
                maxLength={1_000}
                name="requiredContent"
                placeholder="每行一项"
                rows={3}
              />
            </div>
            <div className="field">
              <label htmlFor="task-forbidden">禁止包含</label>
              <textarea
                id="task-forbidden"
                maxLength={1_000}
                name="forbiddenContent"
                placeholder="每行一项"
                rows={3}
              />
            </div>
          </form>

          <section className="material-panel" aria-labelledby="materials-title">
            <header>
              <div>
                <span className="section-kicker">SOURCE MATERIALS</span>
                <h2 id="materials-title">添加任务材料</h2>
                <p>添加评分标准、课程要求、参考资料或已有草稿，用于选择证据和核对内容。</p>
              </div>
              <span
                aria-atomic="true"
                aria-live="polite"
                className="material-panel__count"
              >
                {String(materials.length)} 个文件
              </span>
            </header>

            <div className="material-picker">
              <input
                accept=".pdf,.docx,.pptx,.txt,.md,image/*"
                className="sr-only"
                id="source-files"
                multiple
                onChange={handleMaterials}
                type="file"
              />
              <label htmlFor="source-files">
                <span className="material-picker__icon">
                  <MaterialIcon />
                </span>
                <strong>选择材料文件</strong>
                <small>PDF、DOCX、PPTX、TXT、Markdown 或图片</small>
              </label>
            </div>

            {materials.length === 0 ? (
              <div className="material-empty">
                <span aria-hidden="true">◇</span>
                <div>
                  <strong>尚未添加材料</strong>
                  <p>添加材料后，可按文件名、类型和大小逐项检查，状态为待解析。</p>
                </div>
              </div>
            ) : (
              <ul className="material-list" aria-label="已选择材料">
                {materials.map((file, index) => (
                  <li key={`${file.name}-${String(file.lastModified)}-${String(index)}`}>
                    <span className="material-list__icon">
                      <MaterialIcon />
                    </span>
                    <div>
                      <strong>{file.name}</strong>
                      <small>
                        {file.type || '未知类型'} · {formatFileSize(file.size)}
                      </small>
                    </div>
                    <span className="status-pill">待解析</span>
                    <button
                      className="text-action"
                      onClick={() => {
                        setMaterials((current) =>
                          current.filter((_, materialIndex) => materialIndex !== index),
                        );
                      }}
                      type="button"
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <footer className="workbench-canvas__footer">
            <div>
              <strong>还缺少必填信息</strong>
              <span>请填写任务名称、听众、截止时间、输出格式和评分标准。</span>
            </div>
            <button
              aria-describedby="save-task-requirement"
              className="button button--primary"
              disabled
              type="button"
            >
              保存并继续
            </button>
            <span className="sr-only" id="save-task-requirement">
              请先填写任务名称、听众、截止时间、输出格式和评分标准
            </span>
          </footer>
        </section>

        <aside className="workbench-inspector">
          <header>
            <span className="section-kicker">DELIVERY CHECK</span>
            <h2>交付检查</h2>
          </header>
          <ul>
            {[
              '任务目标与听众明确',
              '截止与篇幅已填写',
              '输出格式已选择',
              '评分标准可核对',
              '至少一份材料可追溯',
            ].map((item) => (
              <li key={item}>
                <span className="check-placeholder">
                  <CheckIcon />
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <div className="workbench-inspector__next">
            <span>下一阶段</span>
            <strong>材料解析</strong>
            <p>添加材料并保存任务后开放。</p>
          </div>
        </aside>
      </div>
    </main>
  );
}

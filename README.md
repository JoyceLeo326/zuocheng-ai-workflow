# 做成■

> 别再收藏工具，先做成一件事。

![做成■｜从模糊待办到可交付结果](apps/marketing/assets/og-cover.jpg)

做成■ 是一套面向大学生真实任务的 AI 学习工作流。它不从模型参数或工具清单讲起，而是从课堂汇报、文献梳理、用户调研、商赛分析、答辩准备等近期必须提交的任务开始，带用户完成从 `□ 待办` 到 `■ 交付` 的完整闭环。

## 真实性边界

公开营销页原有内容是个人作品案例与教学演示，不是已上线运营产品的业绩报告。站内问卷、访谈、反馈、招募人数、完成率与增长漏斗等数字均为方案设计、界面占位或验证目标，用于说明方法与产品逻辑；不代表真实用户数据、已完成招募、已开展访谈或既有运营成绩。

仓库现已进入正式产品重构：ZC-01 只完成 monorepo、应用边界、只读 CI 和客户自托管部署骨架。身份、数据库、文件、AI、导出、课程、运营和商业闭环仍以[需求—证据台账](docs/requirements/zuocheng-requirements.md)为准；没有生产证据的功能不会被描述为完成。

## 成本策略

项目默认运行在 `COST_MODE=zero_owner_cost`，禁止所有者付费 Provider、自动充值和自动升级。个人本地模式继续在浏览器完成；免费托管只作为额度耗尽即停止的 Beta；商业正式路径由用户、学校或机构在其名下提供 API、数据库、BYOS、邮件、监控和备份资源。页面中的成本状态不展示虚构用量。完整边界见[ADR-0001](docs/adr/0001-zero-owner-cost-production.md)和[零所有者成本运行策略](docs/zero-owner-cost.md)。

## 产品结构

- **7 天起步课**：带着一项真实任务，每天推进一个关键节点，第 7 天形成可提交结果。
- **18 课系统课**：覆盖定义任务、寻找依据、组织结构、生成初稿、核验表达、沉淀复用六次闭环。
- **学科任务包**：按具体任务提供输入清单、步骤卡、提示结构、核验表与交付模板。

网站内置第一课“25 页资料 → 3 页课堂汇报”的完整工作台，也呈现海报、短视频分镜、社群触点、14 天上线节奏、增长漏斗与反馈迭代机制。

## 本地任务启动台

首页首先提供一个可直接操作的任务启动台。填写任务名称、截止日期、交付形式和关键约束后，页面会生成确定性的 7 步行动计划：同一参考日期与相同输入始终得到相同的每日动作、当日产出与排期，最后一步严格落在截止日。排期从当天均匀分布到截止日；不足 7 个自然日时，多个步骤会安排在同一天，已经过去的截止日会被拒绝。

- 计划由浏览器本地规则生成，并非 AI 模型输出，也不会向模型或远程接口发送任务内容。
- 任务字段和 7 天逐日完成状态保存在当前浏览器的 `localStorage` 中，刷新页面后可继续。
- “下载 Markdown”会导出任务信息、每日动作、当日产出和当前勾选进度。
- “重置当前任务”会同时清空表单、计划与该任务的本地进度。

这是一套通用的执行拆解规则，不替代用户对任务事实、质量标准和最终内容的核验。

## 本地运行

需要 Node `24.14+`（低于 25）和仓库锁定的 pnpm `11.9.0`：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
pnpm --filter @zuocheng/marketing dev
```

然后访问：

```text
http://localhost:4173
```

学生端和后台分别使用 `pnpm --filter @zuocheng/student dev`、`pnpm --filter @zuocheng/admin dev`。API/Worker 目前只是诚实的 ZC-01 边界；生产模式 `/readyz` 会在 ZC-02 数据库落地前返回 503。

## Vercel 部署

Vercel 部署只适用于个人非商业作品演示，并应使用不带付费附加项的 Hobby 配置。根 `vercel.json` 只构建 `apps/marketing` 的公开 allowlist，不发布内部审计和计划：

- Framework Preset：Other
- Build Command：`pnpm --filter @zuocheng/marketing build`
- Output Directory：`apps/marketing/dist`
- Install Command：`pnpm install --frozen-lockfile`

商业正式部署不使用 Vercel Hobby，采用部署客户名下的自托管/客户云资源，见 `deploy/README.md`。

## 文件结构

```text
.
├── apps
│   ├── marketing       # 原品牌页与课程资产的唯一构建源
│   ├── student         # 学生工作台边界
│   └── admin           # 运营后台边界
├── services
│   ├── api             # Hono API、存活/就绪/成本策略
│   └── worker          # 异步任务进程边界
├── packages
│   ├── contracts       # 跨端运行时契约
│   ├── config          # 启动即 fail-closed 的配置
│   └── db              # ZC-02 数据层边界
├── deploy              # 客户托管 Compose 骨架
├── qa                  # 基线和 monorepo 门禁
├── docs                # ADR、审计、计划与需求台账
├── Dockerfile
├── package.json
├── pnpm-lock.yaml
└── vercel.json         # 仅营销页非商业预览
```

## 设计与交互

- 核心符号：`□ → ■`，分别代表待办与完成。
- 颜色：暖纸白、石墨黑、钴蓝、完成绿与核验红。
- 交互：本地任务启动台、7 天路径、第一课工作台、资料证据切换、3 页汇报、短视频分镜、社群文案、上线日历、漏斗实验与反馈迭代。
- 可访问性：支持键盘焦点、语义化标签、状态播报与 `prefers-reduced-motion`。
- 进度：任务启动台和课程 7 天路径使用各自独立的浏览器本地记录。

## 产品文档

- [产品架构](docs/product-architecture.md)
- [内容系统](docs/content-system.md)
- [14 天上线手册](docs/launch-playbook.md)
- [指标与实验](docs/measurement.md)
- [零所有者成本运行策略](docs/zero-owner-cost.md)

## 发布前检查

1. 桌面端检查 1440px、1024px 两档布局。
2. 移动端检查 390px、430px 两档布局与横向任务导航。
3. 生成一个任务计划，逐日勾选后刷新恢复，分别验证 Markdown 下载与重置。
4. 完整点击 7 天路径、第一课五步、14 天日历和两版漏斗。
5. 在系统“减少动态效果”开启后确认内容仍完整可见。
6. 检查浏览器控制台无错误、所有站内锚点可达。

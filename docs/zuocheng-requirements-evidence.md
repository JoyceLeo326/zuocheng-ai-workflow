# 做成■需求实现与证据

更新日期：2026-07-27
范围：当前工作树中的营销站、学生端、管理端、API、Worker、共享包与 PostgreSQL 迁移。
判定原则：源码和自动测试可以证明“已实现并可复现”，不能代替生产外部资源、真实用户、支付到账或跨设备端到端证据。

## 可验证入口

| 入口 | 本地命令 | 作用 | 当前边界 |
|---|---|---|---|
| 营销站 `/` | `pnpm --filter @zuocheng/marketing dev` | 产品介绍、课程框架、规则化任务启动台 | 任务启动台使用 localStorage，不调用 AI |
| 学生端 `/app/` | `pnpm --filter @zuocheng/student dev` | 项目、资料、证据、结构、初稿、核验、导出、课程、模板、AI、同步 | 默认 IndexedDB；身份和远程 Provider 可选 |
| 管理端 `/admin/` | `pnpm --filter @zuocheng/admin dev` | 运营记录、权限、内容、任务、用量、订单、审计、健康状态 | 默认 IndexedDB，不是共享远程后台 |
| API | `pnpm --filter @zuocheng/api dev` | 身份和项目 HTTP 边界 | 正式运行需要客户数据库及身份适配器 |
| Worker | `pnpm --filter @zuocheng/worker dev` | 异步运行和成本策略边界 | 未作为 Vercel 静态包的一部分 |

统一发布构建使用：

```bash
pnpm build:vercel
pnpm verify:vercel-bundle
```

校验器要求 `dist/vercel` 同时包含 `/`、`/app/`、`/admin/`，以及工作台同源的 Service Worker、Tesseract worker、三种 WASM core 和中英文语言数据。

## 规格逐项状态

这里的“部分实现”只说明仓库内已有可运行能力；需求总账仍要求生产证据后才能标记“已满足”。

| 规格 | 当前仓库证据 | 仍缺的交付证据 | 判定 |
|---|---|---|---|
| ZC-R01 现状审计与资产保留 | 保留黑、米白、荧光绿品牌、首页、7 天、18 课与第一课；`docs/audit/2026-07-23-baseline.md` 记录迁移前基线 | 发布前后视觉差异、最新 release 记录 | 部分实现 |
| ZC-R02 产品定位与闭环 | 工作台可从任务定义推进到资料、证据、结构、初稿、核验和真实导出；7 类模板覆盖主要场景 | 八类项目的生产黄金路径、真实反馈和下一项目追踪 | 部分实现 |
| ZC-R03 成本保护 | 本地处理、浏览器导出、用户 BYOK、用户 Gist；配置和 Worker 拒绝所有者付费、自动充值和自动升级 | 实际账单证明、远程免费额度告警、真实预付支付链 | 部分实现 |
| ZC-R04 系统结构 | pnpm monorepo 包含 marketing、student、admin、api、worker、contracts、config、db；统一静态发布包 | 正式客户域、API/DB/存储/监控资源、镜像和回滚演练 | 部分实现 |
| ZC-R05 身份、项目与数据 | 本地项目稳定 UUID、版本、IndexedDB、冲突、复制、归档、回收站、恢复、永久删除和完整包迁移；身份路由、Better Auth、数据库会话、RLS 和账号权利代码存在 | 真实 OAuth、邮件、Passkey、客户 PostgreSQL、两设备会话和删除后枚举 | 部分实现 |
| ZC-R06 文件处理 | PDF、DOCX、PPTX、TXT、Markdown、图片 OCR、扫描 PDF OCR 和 URL；校验、SHA-256 去重、进度、取消、重试、替换、页码/页号/字符区间、原文和提示词注入标记 | 用户云盘大文件、生产对象存储、真实浏览器恶意样本报告 | 部分实现 |
| ZC-R07 任务工作台 | 完整任务字段、精确证据锚点和人工确认、多结构方案、锁定与排序、逐页初稿、确定性核验、十类真实导出 | release E2E trace、独立产物哈希、跨设备继续和删除复核 | 部分实现 |
| ZC-R08 AI 系统 | OpenAI-compatible BYOK、结构化候选、Schema 校验、审核后应用、证据绑定、锁定保护、取消、重试、幂等、配额、stale 和 IndexedDB 恢复 | 浏览器本地模型、免费云模型、服务端队列；密钥托管加密；真实 Provider E2E | 部分实现 |
| ZC-R09 课程产品 | 7 天 18 课、7 项作业、项目绑定、进度、提交/退回/重交、评论与通知数据、结营门禁和真实 PDF 证书 | 远程 CMS、班级权限、导师端操作、正式数据库和通知投递 | 部分实现 |
| ZC-R10 运营与用户服务 | 11 个管理区、IndexedDB/可选 HTTP 适配器、版本冲突、危险操作确认、审计、预付余额预留；十事件本地活动账本 | 生产管理 API、RBAC 会话、共享数据、真实漏斗 SQL、客服和通知闭环 | 部分实现 |
| ZC-R11 商业模式 | 订单、余额、预留、释放、退款状态和费用安全边际的领域规则 | 支付 Provider、签名 Webhook、对账、退款和用户账单生产证据 | 部分实现 |
| ZC-R12 体验、安全与测试 | loading/empty/error/offline/conflict/quota/retry 等状态；焦点、窄屏、reduced-motion、forced-colors；解析、证据、AI、导出、冲突和安全测试 | 完整 WCAG 2.2 AA 审计、axe/辅助技术报告、生产黄金 E2E、备份恢复 | 部分实现 |
| ZC-R13 最终交付 | README、成本策略、需求台账、身份验证记录和统一构建校验存在 | 最新生产部署、测试账号、外部资源、监控、备份、回滚和逐项签收 | 未完成 |

## 浏览器任务与资料

### 项目数据

`apps/student/src/workbench/project-model.ts` 定义版本化项目聚合；`project-store.ts` 的 Memory 和 IndexedDB 实现共享契约。保存使用期望版本，过期写会报冲突；远程覆盖通过一个 IndexedDB 事务替换项目、源文件 Blob、分块和编辑历史。

项目管理支持：

- 活跃、归档、回收站三个生命周期；
- 复制完整聚合并重映射标识；
- 二次确认永久删除；
- 带 manifest 和 SHA-256 的完整 ZIP 导出；
- 导入前校验所有条目，损坏或篡改时不写入；
- 导出/导入保留来源 Blob、分块和编辑记录。

证据文件：

- `apps/student/src/workbench/project-store.test.ts`
- `apps/student/src/workbench/project-lifecycle.test.ts`
- `apps/student/src/workbench/project-manager-controller.test.ts`
- `apps/student/src/workbench/project-manager.test.tsx`

### 文件与网页

普通上传由 `workbench-service.ts` 调用 PDF.js、OOXML 和文本解析器；OCR/URL 由 `apps/student/src/acquisition` 提供。OCR 的 worker、core 和 `chi_sim`/`eng` 数据均由应用同源发布，不向项目方 OCR 服务发送资料。

可证明的行为：

- 上传前检查名称、媒体类型、大小和空文件；
- Web Crypto SHA-256 去重；
- 25 页 PDF 形成 25 个带真实页码的 SourceChunk；
- DOCX 按段落/表格顺序，PPTX 按页号和形状顺序提取；
- UTF-8 BOM 与 GB18030 文本解码；
- 图片与扫描 PDF 进行实际 Tesseract OCR，支持进度和取消；
- URL 保存规范化地址、抓取时间、标题、原文和哈希；
- CORS 失败时明确提示，可使用用户阅读端点或人工粘贴正文；
- 原文保持不变，另行标记疑似提示词注入并提供安全视图；
- 用户检查识别/抓取结果并确认后才加入项目。

证据文件：

- `apps/student/src/workbench/pdfjs-parser.test.ts`
- `apps/student/src/workbench/docx-pptx-parser.test.ts`
- `apps/student/src/workbench/text-parsers.test.ts`
- `apps/student/src/workbench/source-file.test.ts`
- `apps/student/src/acquisition/*.test.ts`

## 证据、结构、初稿和核验

证据只能来自当前版本 SourceChunk 的原文选区。保存时验证文件、版本、页码、offset、quote 和 hash；用户确认时间是“已核验”的必要条件。替换或删除来源会使相关证据、结构、产物和核验结果变为 stale。

结构阶段支持多个方案、节点增删和排序、证据绑定、交付要求/评分标准覆盖、节点锁定、整份锁定与方案选择。初稿按页保存结论、证据、图表、视觉、引用、讲述备注和时长；锁定页不会被改写。

核验为确定性规则，不调用模型。规则覆盖：

- 引用和证据绑定；
- 无证据主张；
- 数字是否可回溯且一致；
- 将相关关系误写为因果；
- 页面结论和内容重复；
- 总讲述时长；
- 交付要求和评分标准覆盖；
- 敏感或不适当内容。

证据文件：

- `apps/student/src/workbench/evidence-operations.test.ts`
- `apps/student/src/workbench/outline-operations.test.ts`
- `apps/student/src/workbench/draft-verification.test.ts`
- 对应的 `*-stage.test.tsx`

## 真实导出

`apps/student/src/workbench/deliverable-export.ts` 生成以下 Blob：

| 产物 | 验证方式 |
|---|---|
| PPTX | 解开 OOXML，检查页面文字和 speaker notes |
| PDF | PDF.js 重新打开，检查页数和文字；嵌入中文字体 |
| DOCX | 解开 OOXML，检查初稿和引用 |
| Markdown 初稿 | 检查页面、证据和引用文本 |
| 讲稿 | 检查逐页讲述备注与引用 |
| 来源索引 | 检查来源、页码与证据 |
| 任务定义卡 | 检查任务字段和评分标准 |
| 核验记录 | 检查规则结果与修复建议 |
| JSON 快照 | 检查完整项目聚合 |
| ZIP 项目包 | 重新打开并校验 manifest、条目哈希和来源 Blob |

未通过核验的最终产物会被阻止；独立记录仍可导出。`golden-path.test.ts` 会生成并解析真实 25 页 PDF，创建 6 条精确证据、严格三页“问题—发现—建议”草稿，通过 10 项核验后重新打开生成的三页 PPTX/PDF。其他导出测试见 `deliverable-export.test.ts` 和 `export-stage.test.tsx`。

## AI 候选与密钥边界

当前实现只接入用户指定的 OpenAI-compatible 服务：

- 远程地址必须为 HTTPS，开发时只放行 localhost HTTP；
- Key 只进入 `Authorization` 请求头，不进入配置、AI 记录或构建产物；
- 配置和候选结果不包含凭据形状字段；
- 结构化结果先通过项目上下文、Evidence ID 和锁定路径校验；
- 支持证据候选、结构候选和初稿候选；
- 候选停留在 `waiting_for_review`，只有用户选择后才应用；
- 部分应用、取消、重试、幂等、quota_exhausted、stale 和刷新恢复有持久化状态；
- 文档内容在提示中按不可信输入处理，不接受材料中的指令改变系统规则。

当前没有 WebLLM/Transformers.js、本地模型包、平台免费云模型或服务端 AI 队列。`localStorage` 的持久 Key 选项也不满足服务端 KMS 意义上的加密保存。

证据文件：

- `apps/student/src/ai/ai-provider.test.ts`
- `apps/student/src/ai/openai-compatible-provider.test.ts`
- `apps/student/src/ai/byok-credential-store.test.ts`
- `apps/student/src/ai/workflow-assistant.test.ts`
- `apps/student/src/ai/workflow-assistant-store.test.ts`

## 课程、模板、同步和活动记录

课程中心将 18 课分布在 7 天内，包含 7 个需提交的作业。进度和提交保存在 IndexedDB，提交可以被退回后重交；项目绑定、导师/同伴评论、班级通知和证书资格由领域规则校验。证书由浏览器生成实际 PDF，而非仅显示状态。

模板中心包含七类模板，并支持搜索、分类、键盘选择、预览和确认。模板只写入任务定义草稿和结构建议，不创建来源或证据。

同步流程使用用户 GitHub Secret Gist。上传前先导出完整项目包再加密；远端 revision 与本地 baseline 不一致时要求用户选择，不能静默覆盖。离线操作进入 outbox，恢复网络后仍需明确刷新或推送。

活动记录只接受：

```text
signup_completed
project_created
file_uploaded
task_defined
evidence_added
outline_created
artifact_generated
artifact_exported
course_completed
second_project_started
```

事件只在成功业务操作后写入，不记录页面浏览或失败尝试；演示数据不会自动进入账本。没有配置 HTTPS 接收端时只保存在本地。

证据文件：

- `apps/student/src/course/*.test.ts`
- `apps/student/src/templates/*.test.ts*`
- `apps/student/src/sync/*.test.ts*`
- `apps/student/src/analytics/*.test.ts*`

## 身份、API 和 PostgreSQL

仓库包含以下边界，但它们不是静态 Vercel 包中的已连接服务：

- Better Auth 1.6.25 与 Passkey 插件；
- 密码注册、邮箱验证、Passkey、Google/GitHub/Microsoft OAuth、会话/设备、密码恢复、近期认证、账号导出和删除的 HTTP 契约与学生端界面；
- PostgreSQL 迁移 `0000_foundation.sql`、`0001_identity.sql`、`0002_account_rights.sql`；
- tenant/user 会话主体、Membership 复核、RLS/ACL、项目 ETag/409、幂等和账号权利 repository；
- 缺数据库、可信域、OAuth、邮件回执或客户密钥能力时的 fail-closed 装配。

已存在的数据库和路由测试不能证明生产 OAuth、邮件或 Passkey 已运行。详细边界见 `docs/qa/zc03-identity-persistence.md`。

## 管理端

管理端包含 11 个功能区：

1. 运营总览；
2. 用户与权限；
3. 课程与内容；
4. 项目与作业；
5. 反馈与申诉；
6. 任务与导出；
7. 用量与限额；
8. 订单与余额；
9. 功能开关；
10. 审计日志；
11. 服务健康。

每次成功写入产生审计事件；过期版本被拒绝；危险操作需要精确确认；有成本任务只有在可用余额覆盖预估费用和安全边际后才可原子预留。默认适配器是本地 IndexedDB，可选 HTTP 适配器需要外部管理 API。没有管理 API 和认证会话时，这不是跨用户共享后台。

证据文件：

- `apps/admin/src/admin-domain.test.ts`
- `apps/admin/src/admin-service.test.ts`
- `apps/admin/src/admin-app.test.tsx`

## 复现命令

快速验证：

```bash
pnpm --filter @zuocheng/student test
pnpm --filter @zuocheng/admin test
pnpm --filter @zuocheng/api test
node --test qa/*.mjs
pnpm build:vercel
pnpm verify:vercel-bundle
```

完整仓库门禁：

```bash
pnpm verify
```

发布验收还必须人工或 E2E 验证：

- `375×812`、`768×1024`、`1024×768`、`1440×900`；
- 键盘、焦点、减少动态、强制颜色和无横向溢出；
- 上传真实 25 页 PDF，选择 6 条证据并完成 3 页初稿；
- 修改、核验并重新解析 PPTX/PDF/DOCX；
- 离线重开、本地项目包往返、Gist 冲突和删除；
- 如果启用身份：两个独立设备的注册、验证、会话撤销、导出、删除和残留复核；
- 如果启用商业能力：真实支付、Webhook 幂等、对账、退款和额度耗尽；
- 对生产地址记录 commit、部署 ID、资源 ID、迁移版本、产物哈希和 trace。

## 已知未完成项

1. 当前静态发布没有正式 API、数据库、对象存储、队列、监控和备份。
2. 身份功能缺生产 OAuth、邮件、Passkey、客户数据库和两设备端到端证据。
3. 没有浏览器本地模型、平台免费模型或服务端 AI 任务执行器。
4. API Key 的设备持久化选项不是加密密钥库。
5. 没有 Google Drive、OneDrive、WebDAV 或 S3-compatible 连接器。
6. 课程没有生产 CMS、真实导师组织、班级权限和通知投递。
7. 管理端没有已部署的共享管理 API 和生产 RBAC 会话。
8. 没有支付 Provider、Webhook、对账和退款端到端。
9. 没有完整 WCAG 2.2 AA 报告、全链路 release E2E、监控告警、备份恢复和回滚演练。
10. 最新代码是否已经在正式域生效，必须由本次部署 ID 和生产 smoke 证明，不能从仓库文件推断。

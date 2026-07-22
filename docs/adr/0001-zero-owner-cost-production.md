# ADR-0001：零所有者固定成本的正式产品架构

- 状态：Accepted for implementation
- 日期：2026-07-23
- 决策范围：做成■正式产品运行、身份、数据、文件、AI、邮件、监控、备份与付费门禁

## 背景与不可同时偷换的概念

终极规格要求正式产品可供真实用户完成任务，同时项目所有者不支付服务器、数据库、AI API、对象存储、邮件、监控等固定费用，并且不自动超额。这里的“项目所有者支出为 0”不等于所有计算、域名、带宽和运维的社会总成本为 0。

免费托管不提供可永久承诺的商业 SLA，也不能保证配额、价格、账号状态和服务条款不变。免费层可用于硬停 Beta 和非关键预览；关键生产的正式路径必须由用户、学校、团队或部署机构在其名下提供运行资源并承担资源责任。

## 决策

采用“同一产品、三种部署模式”，共享领域契约和测试：

1. `local`：PWA＋IndexedDB＋浏览器导出＋本地模型/用户直连 Provider，适合个人离线使用；不宣称跨设备或集中备份。
2. `hosted-beta`：项目所有者可在当前免费层提供硬停试运行；所有动态能力在额度未知或耗尽时拒绝或排队，不提供商业 SLA，不保存所有者付费 Provider。
3. `tenant-managed-production`：正式主路径。客户/学校/机构名下运行 API、Worker、PostgreSQL、BYOS、SMTP、监控和备份；可使用客户云或自托管服务器。项目所有者交付软件与升级包，不替客户垫付基础设施。

默认且不可静默更改：

```text
COST_MODE=zero_owner_cost
OWNER_BILLING_MODE=deny
ALLOW_OWNER_BILLED_PROVIDER=false
ALLOW_AUTO_TOPUP=false
ALLOW_AUTO_UPGRADE=false
PROVIDER_CREDENTIAL_SOURCE=tenant_only
REMOTE_UNKNOWN_QUOTA=deny
STORAGE_DEFAULT=tenant_byos
REQUIRE_LEDGER_RESERVATION=true
TENANT_CONTEXT_REQUIRED=true
```

任何所有者付费密钥、自动充值或未知预算 Provider 出现在正式环境时，API 必须拒绝启动。任何额度未知或额度耗尽的远程任务必须拒绝、停止或明确排队到重置，不得降级为固定模板或切换到所有者账户。

## 正式主架构

```text
PWA / 学生端 / 管理端
  ├─ IndexedDB 工作副本与 Outbox
  └─ HTTPS、同源安全 Cookie
               │
               ▼
API（Hono/Node + Better Auth）
  ├─ PostgreSQL：身份、租户、项目、版本、同步、账本、审计、任务表
  ├─ BYOS Broker：客户 S3 兼容存储或客户文件系统的短期签名访问
  ├─ Mail Outbox：客户 SMTP/事务邮件账户
  └─ Transactional Outbox / Job Lease
               │
               ▼
Worker
  ├─ 隔离文件解析/OCR
  ├─ 客户本地或自托管模型（BYOI）
  └─ 客户 BYOK，且先通过余额/硬预算预留
```

产品 monorepo 将包含 `apps/marketing`、`apps/student`、`apps/admin`、`services/api`、`services/worker` 与共享 `packages/*`。本地工作副本不保存秘密；云端业务数据全部带租户上下文、版本和审计。

## 身份与数据边界

- Better Auth 作为身份框架，支持密码、Passkey/WebAuthn、Google/GitHub/Microsoft OAuth、找回、会话吊销和注销流程。
- 正式密码重置必须配置客户 SMTP；邮件不可用时不得显示“已发送”的假成功，只能给不泄露账户存在性的通用状态和可操作错误。
- 所有业务表强制 `tenant_id NOT NULL`，唯一键/外键包含租户；PostgreSQL `FORCE ROW LEVEL SECURITY`，应用角色不是表所有者且无 `BYPASSRLS`。
- API 只从已验证 Session/Membership 生成租户上下文，不信任客户端自报租户。
- 所有可变资源有版本/ETag；跨设备并发冲突返回 409 并保留两版。IndexedDB 用于工作副本和 Outbox，不再把 localStorage 当正式数据源。

参考：[Better Auth 安全说明](https://better-auth.com/docs/reference/security)、[Passkey 插件](https://better-auth.com/docs/plugins/passkey)、[PostgreSQL Row Security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)。

## 文件、队列与 AI

- 默认 BYOS。浏览器使用 5—10 分钟、绑定租户/对象键/大小/MIME 的预签名 URL 直传客户存储；对象键使用租户 UUID、文件 UUID 和版本，不使用原文件名。
- Worker 解析容器禁网或严格白名单，限制 CPU/内存/页数/压缩比/超时，执行魔数校验、查毒、PDF/Office/图片/OCR 解析，并保存输入哈希、解析器版本和页锚。
- 队列使用 PostgreSQL transactional outbox、`FOR UPDATE SKIP LOCKED`、租约/心跳/重试/DLQ，避免额外 Redis 固定资源；客户平台也可替换成其已有队列。
- AI 支持 BYOK、本地模型与 OpenAI-compatible BYOI。租户秘密信封加密，主密钥由部署客户掌握；Worker 单次解密，日志、前端构建与备份不得含明文。
- 所有 AI 输出经过严格 JSON Schema/Zod 校验，服务端重新核验 Evidence UUID、租户、源版本和锚点，不能相信模型返回的权限或成本字段。

参考：[S3 预签名上传](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html)、[PostgreSQL SKIP LOCKED](https://www.postgresql.org/docs/15/sql-select.html)。

## 成本账本与 fail-closed 门禁

远程付费任务使用不可变双录账本和预留：

1. 按输入上限、最大输出、价格版本和安全余量计算最坏报价。
2. 锁定租户余额，只有可用余额或 Provider 可验证的硬预算覆盖报价才创建 reservation。
3. reservation、Job 和 outbox 在同一数据库事务提交。
4. Worker 执行前再次核验租户密钥归属、价格版本、余额预留和 Provider 硬限额。
5. 成功按实际费用结算并释放差额；失败释放；重复外部事件由唯一键幂等。
6. 无余额、无用户 Key、价格未知、配额未知、配额耗尽或核验过期，一律 `quota_exhausted`/明确错误并阻断。

平台不直接发行余额时，“预付”是租户向其 Provider 预付，产品只镜像余额并二次门禁。若未来由平台收款发行余额，必须另行完成商户准入、税务、退款、争议和储值合规；不能仅凭代码声称完成。

## hosted-beta 的边界

Cloudflare Workers/D1/Queues 免费层可以作为当前硬停 Beta 候选：D1 免费层达到日限额会报错而非自动收费，Queues 免费层也有明确日配额；运行时必须把限额错误映射为可恢复的 quota 状态。所有限制在每次发布时从官方页面重新核验，不在代码中承诺为永久数字。

Cloudflare 对免费套餐的定位不等于关键商业生产承诺；Vercel Hobby 也不能承担商业正式环境。因此 Beta 只能展示为“试运行/无 SLA/达到额度停止”，tenant-managed-production 才是商业生产边界。

参考：[Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)、[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)、[Cloudflare plans](https://www.cloudflare.com/plans/)、[Vercel Hobby](https://vercel.com/docs/plans/hobby)。

## 邮件、监控、备份与回滚

- 邮件由客户 SMTP/事务邮件账户发送，客户配置 SPF/DKIM/DMARC；Outbox 负责幂等、重试和退信状态。
- API 提供 `/livez`、`/readyz`、`/metrics`；客户提供外部探针与告警接收方。日志仅保存 request/job/租户不可逆标识，禁止正文、令牌、Key 和完整邮箱。
- PostgreSQL 使用一致快照备份，关键部署增加 WAL/PITR；对象存储启用客户版本控制并备份到不同故障域。备份完成不等于可恢复，必须以隔离环境恢复演练为证。
- OCI 镜像按 digest 发布，迁移使用 expand-contract；蓝绿/金丝雀升级。破坏性迁移前必须有验证过的备份，代码回滚不得假设数据库可无损倒退。

参考：[Docker Compose production](https://docs.docker.com/compose/how-tos/production/)、[PostgreSQL SQL dump](https://www.postgresql.org/docs/17/backup-dump.html)、[PITR](https://www.postgresql.org/docs/17/continuous-archiving.html)。

## 商业生产边界

项目所有者可以承诺：不持有会产生第三方费用的共享生产资源；不自动超额、不自动充值；所有者账单为 0；代码在客户资源上支持正式多租户产品；免费 Beta 达限硬停。

项目所有者不能仅靠代码承诺：免费层永久存在、域名/OAuth/邮件审批通过、任何 AI Provider 都有可查硬预算、支付与储值合规、异地备份和值班响应、客户机器电费和运维为 0。以下外部条件由正式部署客户创建或授权：

- 稳定域名、DNS、TLS 与 OAuth 应用；
- API/Worker/PostgreSQL 的服务器或客户商业云；
- S3 兼容存储、SMTP、外部监控和异地备份；
- 主密钥、凭据轮换和灾难恢复负责人；
- 可选 AI Provider 预付项目/硬预算或本地模型；
- 若发行平台余额，则另需支付商户、KYC、退款/争议/税务与当地合规能力。

## 后果与验收

优点：所有者不会被静默扣费；正式运行责任清晰；同一产品既可本地使用，也可由机构正式托管；免费 Beta 仍可公开体验。

代价：正式云端能力需要部署客户提供资源和配置；OAuth、邮件、域名、支付与合规不能在无人授权的代码仓库内完成；自托管部署需要真实恢复演练和运维负责人。

ZC-01 起所有部署、Provider、队列、账本和测试都必须遵守本 ADR。若实现需要所有者付费账户或会在未知额度下继续调用，该实现不得合并。


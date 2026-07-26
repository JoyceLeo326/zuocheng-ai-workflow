# 零所有者成本运行策略

## 目标与适用范围

`COST_MODE=zero_owner_cost` 是仓库的开发和部署约束：项目所有者不承担服务器、数据库、文件存储、AI、邮件、监控或媒体处理的固定账单，也不允许自动充值、自动升级或免费额度用尽后的所有者代付。

这个约束不进入普通用户营销文案。用户界面只说明完成当前操作所需的连接、权限、用量和错误，不展示“项目所有者成本”等内部决策。

## 当前能力与费用归属

| 能力 | 当前执行位置 | 费用与凭据边界 |
|---|---|---|
| 首页规则化计划 | 浏览器 | 不调用远程服务 |
| 项目、课程、活动记录 | IndexedDB / localStorage | 当前设备存储 |
| PDF、DOCX、PPTX、TXT、Markdown 解析 | 浏览器 | 不调用项目方后端 |
| 图片和扫描 PDF OCR | 浏览器 Tesseract.js | worker、WASM 和语言数据随应用发布 |
| PPTX、PDF、DOCX、Markdown、ZIP 导出 | 浏览器 | 不调用项目方后端 |
| AI 候选 | 用户连接的 OpenAI-compatible HTTPS 端点 | 请求和 Key 由用户的 Provider 承担 |
| 加密同步 | 用户的 GitHub Secret Gist | GitHub token 和远程存储属于用户账户 |
| URL 资料 | 浏览器直连或用户阅读端点 | 受 CORS、目标站和用户服务约束 |
| 身份、团队与远程项目 | 客户自托管运行时 | 客户提供 PostgreSQL、OAuth、邮件、密钥和域名 |

没有配置远程服务时，本地项目、资料、课程和已有文件导出仍可使用。远程能力失败或额度耗尽时必须返回明确状态，不能生成固定文本、固定证据或模拟用量冒充成功。

## 默认配置和 fail-closed 规则

- `.env.example` 固定 `COST_MODE=zero_owner_cost` 和 `ALLOW_AUTOMATIC_BILLING=false`。
- `packages/config` 与 Worker 策略禁止所有者付费 Provider、自动充值和自动升级。
- 营销站的 `cost-policy.js` 保留静态能力的运行时默认策略；它不加载到普通用户页面，也不作为用户功能宣传。
- API 正式装配缺少客户数据库、可信域、身份 Provider、邮件回执或密钥能力时拒绝启动或返回不可用，不能回退为进程内假持久化。
- 管理后台中的余额、预留和订单规则只处理已有业务记录。没有支付 Provider、真实到账和幂等 Webhook 时，不能创建会产生第三方费用的生产任务。

远程免费额度未知、无法验证或额度耗尽时，对应操作必须拒绝或停止；绝不自动切换到付费套餐。

## 用户自带资源

### BYOK

当前学生端支持用户连接 OpenAI-compatible HTTPS 端点。Key 只随用户触发的请求发送到指定端点，不进入 Provider 配置、AI 运行记录或静态构建包。

默认的当前标签页选项使用 `sessionStorage`；用户明确选择设备持久化时使用 `localStorage`。这两种方式都不等于硬件密钥库或加密保险箱，因此共享设备应使用会话存储并在结束后删除 Key。生产团队若要求托管密钥，必须由其自己的 KMS/AAD 适配器承担。

### BYOS

当前跨设备路径使用 GitHub Secret Gist。完整项目包在上传前使用 PBKDF2-SHA-256 和 AES-256-GCM 加密，内容分块并校验摘要；GitHub token 只保存在会话存储，同步口令不持久化。

这是一条用户主动连接的个人同步路径，不是团队数据库、共享对象存储、自动备份或商业 SLA。Google Drive、OneDrive、WebDAV 和 S3-compatible 仍是外部扩展方向，当前仓库不能宣称已接通。

## 托管边界

Vercel Hobby 只用于本项目的个人、非商业作品演示；发布前应复核 [Vercel Hobby 文档](https://vercel.com/docs/plans/hobby) 和 [Vercel 当前限制](https://vercel.com/docs/limits)。统一 Vercel 包是静态营销站、学生端和管理端，不包含正式 PostgreSQL、对象存储、身份 API 或 Worker。

商业使用应选择客户名下的 Cloudflare Pages 静态托管或自托管环境。使用 Cloudflare Pages 时，不应默认启用可能计费的 Functions、Workers 或附加项；以 [Cloudflare Pages 限制](https://developers.cloudflare.com/pages/platform/limits/) 和 [Pages Functions 计费](https://developers.cloudflare.com/pages/functions/pricing/) 为准。

托管方案和免费配额会变化，本文不固化请求数、带宽、构建时长或存储容量。每次发布必须重新核对官方条款和项目账单设置；任何边界无法确认时，保留静态本地能力并停止远程集成。

## 不得夸大的能力

- 免费静态部署不等于生产身份、云数据库、团队协作或跨设备自动同步。
- GitHub Gist 同步不等于平台托管备份；用户需保管 token、口令和本地项目包。
- 管理后台中的余额和订单不等于支付渠道已经接通。
- API、数据库迁移和客户适配器源码不等于生产资源已经创建。
- 单元测试、浏览器本地验证不等于真实 Provider、邮件、OAuth、Passkey 或支付端到端已通过。

## 发布检查

1. 运行 `pnpm verify`、`pnpm build:vercel` 和 `pnpm verify:vercel-bundle`。
2. 确认公开首页没有内部成本策略、所有者费用或本地架构说明。
3. 确认统一静态包只包含 `/`、`/app/`、`/admin/` 及其同源资源。
4. 检查环境配置未包含项目所有者 AI Key、GitHub token、OAuth secret、支付密钥或自动计费开关。
5. 验证未连接 Provider、错误 Key、额度耗尽、离线和远端冲突均不会产生假成功。
6. 验证用户不连接账号也可导出已有本地数据。
7. 若启用客户 API，记录客户资源 ID、迁移版本、健康检查、备份恢复、监控和回滚证据。
8. 发布前重新检查 Vercel、Cloudflare 和所有外部 Provider 的最新条款；额度耗尽时停止或拒绝操作。

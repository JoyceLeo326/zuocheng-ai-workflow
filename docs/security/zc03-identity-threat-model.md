# ZC-03 身份系统威胁模型与正式运行契约

状态：实施中  
适用范围：做成■学生端、API、PostgreSQL 身份数据、客户提供的邮件/OAuth/KMS
资源。  
判定原则：本文件定义安全门槛，不代表 ZC-03 已完成。

## 固定版本与官方依据

正式运行时只允许使用精确版本：

- `better-auth@1.6.25`
- `@better-auth/passkey@1.6.25`

不得自动采用 `next`、`beta` 或 `rc`。升级必须重新执行数据库迁移、两设备会话、
三种 OAuth、Passkey、恢复、导出和删除回归。

实现依据：

- [Better Auth database schema](https://www.better-auth.com/docs/concepts/database)
- [Email and password](https://www.better-auth.com/docs/authentication/email-password)
- [Passkey plugin](https://www.better-auth.com/docs/plugins/passkey)
- [Security controls](https://www.better-auth.com/docs/reference/security)
- [Session management](https://www.better-auth.com/docs/concepts/session-management)
- [Cookies](https://www.better-auth.com/docs/concepts/cookies)
- [Generic OAuth and Microsoft Entra helper](https://www.better-auth.com/docs/plugins/generic-oauth)

## 信任边界

| 边界 | 可信输入 | 不可信输入 | 强制措施 |
|---|---|---|---|
| 浏览器 → API | 无 | 请求体、Header、Cookie、Origin、OAuth callback、WebAuthn assertion | HTTPS、Host-only Cookie、Origin/CSRF、限流、大小限制、Schema 校验 |
| API → PostgreSQL | tenant/user 数据库主体和参数化 SQL | 客户端传入的 tenant/user/role、任意 SQL 片段 | 独立 login、FORCE RLS、最小权限、事务内身份绑定 |
| API → OAuth | 固定 issuer、客户注册的 client、服务端生成的 state/nonce/PKCE | profile claims、redirect、authorization code、错误字段 | 精确 redirect allowlist、state/nonce/PKCE、issuer 校验、单次 callback |
| API → 邮件 | 客户 SMTP/邮件适配器返回的真实结果 | 收件地址、模板变量、未知投递状态 | 不枚举账户、真实发送才记录成功、未知状态 fail closed |
| API → KMS | 客户密钥标识和已验证的加解密结果 | OAuth access/refresh token、任意 ciphertext | 明文不落库/日志；无 KMS 时禁用需要持久 token 的能力 |
| API → Passkey | WebAuthn 验证库校验后的 credential | challenge、origin、RP ID、counter、transport | 单次 challenge、RP/origin 精确匹配、counter/replay 检测、credential 唯一 |
| 用户 → 数据权利任务 | recent-auth、当前用户、幂等键 | 导出范围、删除 ID、取消时点 | 服务端计算范围、不可逆阶段门禁、全会话撤销、删除后复核 |

## 受保护资产

- 密码摘要、恢复/验证 token 摘要和未消费 challenge。
- Better Auth secret、旧 secret 轮换集合、session token。
- Passkey credential public key、counter、RP/设备元数据；私钥只存在认证器中。
- OAuth client secret、authorization code、access/refresh token。
- 客户 KMS ciphertext 和 key reference。
- `user_id`、`tenant_id`、membership、`activeTenantId`、账号状态和授权角色。
- 数据导出包、删除任务、身份审计和最小删除证明。

## 主要攻击与拒绝条件

### 账号接管与枚举

- 注册、登录、验证、找回密码和 OAuth linking 返回等价的外部错误，不泄露邮箱
  是否存在、账号是否软删或 Provider 是否已经关联。
- 修改密码、邮箱、Passkey、OAuth link、导出和删除必须 recent-auth。
- 邮箱密码账号验证后才能进入正式工作区；OAuth 邮箱 claim 不能直接授予租户角色。
- Microsoft 账号以经过 issuer 校验的 `tid` 与 `oid` 组合锚定，不以可变 email
  作为授权主键。

### CSRF、Origin 与开放重定向

- 禁止 `disableCSRFCheck` 和 `disableOriginCheck`。
- 正式环境 `trustedOrigins` 只接受显式 HTTPS origin，不允许通配符、localhost、
  由请求头动态拼接或用户提供的值。
- 回调、完成页和密码恢复 redirect 都从服务端 allowlist 选择。
- Cookie 使用 `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`、Host-only；
  session/bearer token 不进入 URL、localStorage 或可读 Cookie。

### OAuth callback、linking 与 token 泄漏

- Google、GitHub、Microsoft 使用独立客户 client，精确 callback URI。
- callback 必须校验 state；支持时同时使用 nonce、PKCE 和 issuer 校验；state/code
  只能消费一次并受 TTL 限制。
- link 只允许 recent-auth 的当前用户发起，callback 绑定发起用户与 Provider。
- Better Auth 不承担 OAuth token 静态加密保证：正式环境若需要持久 access/refresh
  token，必须先经客户 KMS envelope encryption；无 KMS 时拒绝该 Provider 配置，
  或配置为不持久 token 且由验收测试证明。

### 密码、恢复和会话

- 密码由 Better Auth 当前默认强密码散列实现处理；应用不得自行降级为快速哈希。
- verification/recovery token 数据库只保存不可逆摘要、用途、用户、过期时间和
  消费时间；成功消费与密码修改位于同一事务。
- 密码重置、账号删除确认和安全事件撤销所有已有会话。
- 会话使用数据库后端。正式环境无法连接身份数据库时启动失败，不允许退化为
  stateless session。
- 列出设备只返回用户自己的脱敏元数据；撤销设备必须同时使该 session 后续请求
  失败。

### 限流与资源耗尽

- 注册、登录、验证、恢复、Passkey options/verify、OAuth start/callback 和数据
  权利端点均使用持久化限流。
- 限流存储不可用时 fail closed；不以内存计数器冒充多实例生产限流。
- 在认证或业务调用前执行 Content-Type、流式请求体大小、Origin 和限流检查。
- 限流错误采用统一 Problem Details、`Retry-After` 和 `private, no-store`。

### 跨租户与服务端字段覆盖

- `tenant_id`、`user_id`、角色、账号状态和 `activeTenantId` 均来自已验证会话和
  数据库 membership，永不采信请求体或 OAuth profile 的同名字段。
- 身份表与业务表使用 tenant/user 数据库主体和 FORCE RLS；普通应用主体不能
  读取 token 摘要、OAuth 明文密钥或其他用户身份审计。
- 跨租户资源统一表现为不存在，不能用 `403` 暴露资源存在性。

### 导出和删除假完成

- 导出包由服务端枚举用户的正式数据，生成 manifest、条目哈希与包哈希；不得
  包含 token、密码摘要、OAuth 密文、KMS 引用或内部安全字段。
- 删除先撤销会话与凭据，再编排业务库、对象/BYOS、通知和保留策略；不可逆阶段
  之后不接受取消。
- 仅当数据库、对象存储、旧签名 URL 和两台设备的复核均完成，才可显示完成。
- 备份保留无法立即物理清除时必须明确保留范围、截止时间和隔离方式，禁止回报
  “已经完全删除”。

## 客户资源配置契约

正式部署使用 `IDENTITY_RESOURCE_MODE=tenant_managed`。配置值必须来自运行时密钥
注入，不得进入客户端 `VITE_*`、镜像层、仓库、构建日志或错误响应。

| 能力 | 必需配置 | 缺失时行为 |
|---|---|---|
| Better Auth | `BETTER_AUTH_BASE_URL`、当前 secret、可选旧 secret、身份数据库连接 | 启动失败 |
| Trusted origins | 显式 HTTPS origin 列表 | 启动失败 |
| 邮箱验证/恢复 | 客户 mail adapter/SMTP secret、验证过的 sender | 邮箱注册/恢复端点返回 provider unavailable |
| Google | 客户 client ID/secret、精确 callback | Google 入口不可用，不生成假 URL |
| GitHub | 客户 client ID/secret、精确 callback | GitHub 入口不可用，不生成假 URL |
| Microsoft | 客户 Entra client ID/secret、tenant/issuer、精确 callback | Microsoft 入口不可用，不生成假 URL |
| OAuth token persistence | 客户 KMS adapter 与 key reference | 需要持久 token 的 Provider 启动失败 |
| 数据库限流 | 客户 PostgreSQL/正式限流表 | 受限请求 fail closed |
| 数据导出 | 客户 BYOS 或浏览器可验证流式下载 | 异步导出不可用；不得回报已生成 |

以下情况一律拒绝：

- 项目所有者 OAuth、SMTP、KMS 或付费 Provider 凭据。
- 示例 secret、测试 secret、默认 secret、长度不足的 secret。
- 正式 origin 使用 HTTP、localhost、IP 通配符或任意子域通配符。
- Provider callback 不在服务端固定 allowlist。
- `COST_MODE` 不是 `zero_owner_cost`，或允许自动付费/自动升级。
- 未知免费额度继续执行、邮件发送状态未知却回报成功、KMS 未验证却写入 OAuth
  token。

## 必需安全证据

ZC-03 不得因单元测试通过而标记完成。最少还需要：

1. PostgreSQL 17 原生迁移与两连接最小权限报告。
2. 两个独立浏览器上下文的 session 撤销、换设备、恢复、导出、删除 trace。
3. Google、GitHub、Microsoft 客户沙箱资源 ID 和脱敏 callback transcript。
4. Passkey 的 RP/origin/challenge/replay 负向测试。
5. 依赖锁、secret 扫描、客户端 bundle 扫描和日志泄漏扫描。
6. 导出 manifest/hash、删除后数据库/BYOS/旧 URL/旧凭据复核。
7. 客户资源与所有者资源分账证明，以及未知/耗尽额度的 hard-stop 记录。

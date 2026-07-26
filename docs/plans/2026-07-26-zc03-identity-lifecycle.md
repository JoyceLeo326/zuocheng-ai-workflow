# ZC-03 正式身份与账号生命周期实施计划

上位计划：`docs/plans/2026-07-23-zuocheng-full-production.md`
权威规格：终极提示词“做成■ / 正式身份与账号生命周期”
执行原则：RED → GREEN → REFACTOR → 原子提交 → 正确性 QA → 质量 QA。

## 不可降级约束

- 正式 Web 会话只使用 `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/`
  的 Host-only Cookie；长期令牌、OAuth token、Passkey 私钥材料不得进入
  localStorage、日志、前端包或错误响应。
- 密码登录、Passkey、Google、GitHub、Microsoft 三种 OAuth 均必须由真实
  Better Auth 路径或明确的客户 Provider 适配器执行；未配置必须 fail-closed，
  不得返回假发送、假跳转或假成功。
- 项目所有者不承担 SMTP、OAuth、数据库、短信或托管固定费用。正式生产使用
  客户/机构身份基础设施；本地模式只能提供真实本地能力和明确限制。
- 账号、会话、验证、恢复、Passkey、OAuth 账户和删除请求必须持久化；敏感
  bearer/verification/recovery token 只保存单向摘要，OAuth token 必须由客户
  密钥系统加密或明确禁用持久化。
- 所有高风险变更要求最近验证、CSRF/Origin 防护、持久化限流、幂等、审计和
  全会话撤销；错误不能泄露账号是否存在。
- “已完成”需要真实数据库、两设备、注销/撤销、恢复、数据导出、账号删除和
  三种 OAuth/Passkey 的生产或客户沙箱证据。

## 原子任务

### ID-01 官方版本、威胁模型与 Provider 契约

- 固定 Better Auth 当前稳定版与 Passkey 插件精确版本。
- 记录数据库 schema、CSRF/Origin、OAuth state/PKCE、Cookie、session
  rotation/revocation 的官方依据。
- 定义客户身份适配器：Better Auth secret rotation、SMTP、Google/GitHub/
  Microsoft、tenant+user 数据库主体、token encryption/KMS、trusted origins。
- RED：生产缺任一必需适配器、来源不可信、localhost origin、项目方密钥、
  未知发送状态时启动或请求必须失败。

### ID-02 身份数据库与最小权限

- 新迁移建立 Better Auth core user/session/account/verification 映射、Passkey、
  device/session revocation、恢复、账号数据请求、账号删除请求和 append-only
  identity audit。
- 连接现有 `zuocheng.user`、membership 与 runtime principal；服务端字段
  `accountStatus`/`activeTenantId` 不允许客户端或 OAuth profile 写入。
- Token 摘要、唯一键、TTL、单次消费、并发、清理与最小权限角色。
- RED：重放恢复 token、会话跨用户、Passkey credential 重复、OAuth account
  takeover、软删后登录、普通 app 读取 token/OAuth 密文。

### ID-03 Better Auth 正式运行时

- 数据库后端、email+password（验证后登录）、Passkey、Google/GitHub、
  Microsoft Entra、数据库 session、secret rotation。
- 明确 baseURL/trustedOrigins；保持 CSRF/Origin 检查开启；OAuth 使用 state、
  nonce、PKCE 与 issuer validation。
- SMTP/Provider/KMS 全部来自客户适配器；无适配器返回明确 unavailable。
- RED：stateless fallback、测试密钥、明文 OAuth token、`disableCSRFCheck`、
  `disableOriginCheck`、不安全 Cookie、Provider credential 进入日志/构建。

### ID-04 HTTP 契约与持久化限流

- 注册/登录/验证/恢复/Passkey/OAuth、session/device 列表与撤销、logout。
- 数据导出、账号删除请求/取消/确认与状态查询。
- 认证、Origin/CSRF、幂等、Content-Type、流式 body limit、持久化限流先于
  业务处理；统一 ProblemDetails 和 `private, no-store`。
- RED：账号枚举、匿名超大 body、错误 Origin、无幂等、限流存储故障、
  Provider/邮件未配置、重复 callback/token。

### ID-05 账号数据权利与删除编排

- 导出包含账号、workspace/member、项目、版本、审计、课程、用量/账本索引；
  生成真实 manifest/hash，敏感凭据和 token 永不导出。
- 删除要求 recent-auth，撤销全部 session/Passkey/OAuth token，排队删除项目、
  BYOS/对象、通知与备份保留；保留最小非敏感删除证明。
- 失败可恢复、可取消（进入不可逆阶段前）、幂等、可审计。
- RED：导出泄密、删除后旧 Cookie/Passkey/OAuth 仍可用、两设备残留、取消
  越过不可逆点、备份保留状态假完成。

### ID-06 学生端账号与设备体验

- 注册、登录、验证、恢复、Passkey、三种 OAuth、设备列表、撤销、导出、删除
  的真实 UI。
- loading/empty/error/offline/permission/rate-limit/provider-unavailable 状态；
  键盘、焦点、错误摘要、WCAG 2.2 AA 和四视口。
- UI 不缓存 token，不用 Toast 冒充后台动作。

页面风格、展示与交互同样是完成门槛：

- 延续黑/米白/荧光绿品牌，但必须形成清晰的品牌侧栏、主任务层、信任/成本说明、
  状态区和安全操作区，不能只是居中表单或组件堆叠。
- 注册、登录、恢复、Passkey、Provider、设备、导出与删除都必须展示当前步骤、
  真实后端状态、下一步和可恢复路径；不得使用随机数字、假进度、固定成功文案。
- 密码可见性、密码强度、模式切换、焦点移动、表单错误、请求取消/重试、会话撤销、
  导出轮询和删除阶段要有可感知交互；密码、token 和敏感证明不得持久化或进入日志。
- `375×812`、`768×1024`、`1024×768`、`1440×900` 分别做截图、无横向溢出、
  触控目标、内容折行和关键动作可达性检查，不以单一桌面宽度代表响应式完成。
- 支持 `prefers-reduced-motion`、forced colors、键盘全流程、错误摘要/焦点回归、
  `aria-live`，并执行自动 axe 与人工对比度/读屏抽查。
- 页面明确项目所有者账单为 deny；正式数据库、邮件、OAuth、KMS、对象存储由客户
  自带，未知或耗尽额度停止。不得把免费预览写成商业 SLA 或暗示项目方兜底付费。

### ID-07 原生与生产等价 E2E

- PostgreSQL 17 新迁移与最小权限 gate。
- 两浏览器设备：注册 → 验证 → 登录 → 加 Passkey → 第二设备登录 → 撤销第一
  设备 → 恢复密码 → 全会话撤销 → 导出 → 删除 → 旧凭据全部失败。
- Google/GitHub/Microsoft 客户沙箱回调与 account linking；state/PKCE/issuer
  攻击用例。
- 交付脱敏 transcript、Playwright trace、数据库断言、导出 hash、删除后枚举、
  外部客户资源 ID 和零项目方账单证据。

## 完成判据

ID-01—ID-07 全部有 RED/GREEN、实现提交、两阶段 QA 和生产/客户沙箱证据前，
ZC-03 只能标记“部分满足”。ZC-03 完成也不代表做成■完成；仍需继续 ZC-04—
ZC-12。

# ZC-03 身份持久化与运行时验证记录

日期：2026-07-26  
范围：ID-01 至 ID-04 的数据库、HTTP、Better Auth 运行时和学生端契约。  
状态：部分通过。本文不代表 ZC-03 或做成■已完成。

## 固定实现

- `better-auth@1.6.25`
- `@better-auth/passkey@1.6.25`
- PostgreSQL 17 原生门禁
- 数据库 session；正式环境禁止 stateless fallback
- Google、GitHub、Microsoft Entra 客户 Provider 契约
- 客户邮件投递回执、客户数据库适配器和客户 KMS/AAD envelope 契约
- 安全 Host-only Cookie；Origin/CSRF 和持久化限流端口

## 自动验证

在提交 `4e2fd1d`、`faa64c8`、`8d32963` 及学生端对应提交组成的工作树上：

| 范围 | 结果 |
|---|---|
| `@zuocheng/config` | 33/33 |
| `@zuocheng/db` | 61/61 |
| `@zuocheng/api` | 118/118 |
| `@zuocheng/student` | 13/13 |
| API typecheck/build | 通过 |
| DB typecheck/build | 通过 |
| Student typecheck/build | 通过 |

测试包含：

- 缺客户数据库、secret rotation、邮件回执、三种 OAuth 或可信 origin 时拒绝。
- 禁止项目方身份凭据、示例 secret、不安全 Cookie、关闭 CSRF/Origin。
- 邮件返回 `undefined` 或未知状态时失败，不回报已发送。
- verification selector 使用 Better Auth 1.6.25 的 SHA-256 base64url 43 字符格式。
- OAuth token/state 要求版本化 ciphertext 和 purpose/provider/user/tenant AAD
  能力；明文、伪造 tenant、key version substitution 被拒绝。
- 恢复/验证 token 过期和重放、Passkey credential 重复、已撤销/删除账号会话、
  普通应用主体读取身份密文等负向用例。
- HTTP 的注册、邮箱验证 completion、密码、Passkey、三种 OAuth、会话/设备、
  恢复、recent-auth、导出和删除契约。
- 学生端不暴露 session token，WebAuthn base64url 边界、敏感 URL 参数清除、
  三种 Provider 和数据权利 UI。

## PostgreSQL 17 原生门禁

使用 PostgreSQL 17.10 x86_64 Windows 临时隔离实例：

- 地址：`127.0.0.1:55432`
- 数据库：`zc03_identity_gate_20260726`
- 数据库由门禁前新建，不复用旧 schema。
- 依次应用 `0000_foundation.sql`、`0001_identity.sql`。

实际结果：

```text
PostgreSQL 17 ordered migrations, identity attacks, FORCE RLS and two-connection CAS gate passed
```

原生门禁覆盖：

- 有序迁移和 15 个 FORCE RLS 表检查。
- 跨 tenant/user 两连接隔离。
- 普通应用 login 无法读取 account token ciphertext、verification payload 或身份
  审计。
- OAuth/PKCE 明文和不合规 ciphertext 被数据库约束拒绝。
- verification 的过期、重放与原子单次消费。
- 删除确认 token 的过期和单次消费。
- 已撤销 session、删除账号、无效 membership 无法通过数据库 session gate。
- 现有项目 CAS/ETag 双连接竞争门禁仍通过。

## 浏览器界面验证

本地学生端在 `375×812`、`768×1024`、`1024×768`、`1440×900` 四个视口检查：

- 无横向溢出。
- 登录、注册、恢复、Passkey 和三个 Provider 有可访问名称。
- 手机端主要按钮高度 48px，模式按钮高度 51px。
- API 未连接时明确显示“身份 API 尚未连接”，不会进入本地假登录模式。
- 注册表单包含 name/email/new-password autocomplete、明确同意项和邮件验证说明。
- 保留黑/米白/荧光绿品牌，并支持 `prefers-reduced-motion`、forced colors 和
  skip link。

该浏览器记录只证明匿名界面与错误态，不是生产认证或真实 Provider 证据。

## 尚未满足

以下证据缺失时 ZC-03 继续标记“部分满足”：

1. 仓库内完整 `IdentityLifecycleService` 与账号导出/删除编排；不能要求客户自己
   实现全部 29 个业务方法。
2. 实际客户 PostgreSQL Better Auth adapter 与 AAD/KMS envelope 的原生 round-trip。
3. Google、GitHub、Microsoft 客户沙箱 state/PKCE/issuer/linking 证据。
4. 实际 SMTP/邮件 Provider delivery ID、验证、恢复和删除确认链接。
5. 硬件或平台 Passkey 的 RP/origin/challenge/replay E2E。
6. 两个独立浏览器上下文的注册、验证、第二设备登录、撤销、恢复、导出、删除和
   旧凭据复核。
7. 数据导出 manifest/hash、BYOS/对象删除、备份保留和删除后枚举。
8. Node 24 release 环境复验；本次进程版本不是声明的 release Node 24。

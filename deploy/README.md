# 客户托管部署骨架

此目录是 `tenant-managed-production` 的 ZC-01 运行边界，不是已经通过生产验收的部署。所有镜像、主机、Registry、PostgreSQL、邮件、BYOS、监控和备份资源必须归部署客户；不得把示例占位值用于正式环境。

当前 API 的 `/livez` 可证明进程存活；在 ZC-02 正式数据库、迁移与 RLS 完成前，`/readyz` 会在 `tenant-managed-production` 模式诚实返回 503。Compose 暂以 `/livez` 检查容器，不能把容器存活解释为产品就绪。

使用顺序：

1. 客户审阅并构建 API/Worker OCI 镜像，保存 digest 与 SBOM。
2. 客户把 `.env.production.example` 复制为 `.env.production`，填入其 Registry digest 与数据库秘密。
3. 运行 `docker compose --env-file .env.production -f compose.yaml config`，确认没有 `latest` 或占位值。
4. ZC-02 加入向前兼容迁移后，先备份、再运行 migrator、最后启动 API/Worker。
5. `/readyz`、黄金路径和恢复演练全部通过后，才能把该 release 标为可用。

禁止自动超额、所有者 Provider Key、自动充值、从线上制品回写源码，以及数据库 down migration 式回滚。

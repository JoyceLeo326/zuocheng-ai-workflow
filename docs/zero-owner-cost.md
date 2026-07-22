# 零所有者成本运行策略

## 目标与真实边界

本项目默认 `COST_MODE=zero_owner_cost`，目标是让项目所有者承担零固定成本且不产生自动账单。当前任务规划、进度保存、Markdown 导出与重置全部在浏览器本地执行；没有远程 Provider、服务端函数、数据库或按量 API。

页面只显示可由当前架构直接证明的状态：`本地 0 成本`、`远程服务用量不适用`。项目不展示成本仪表盘，也不把模拟数字包装成真实用量、余额或节省金额。

## 两处一致的默认配置

- 静态浏览器运行时以 `cost-policy.js` 中的 `DEFAULT_COST_CONFIG` 为实际默认配置。
- `.env.example` 为未来构建或托管配置提供同一份部署契约：`COST_MODE=zero_owner_cost`、`ALLOW_AUTOMATIC_BILLING=false`、`REMOTE_PROVIDER=none`。
- 仅设置环境变量不能绕过运行时策略；未来 Provider 必须先通过 `authorize()`。

## Provider 与额度的 fail-closed 规则

1. 本地能力直接允许，所有者成本记录为 0，远程用量记为不适用。
2. 零成本模式下，付费、按量计费或可能向所有者收费的远程 Provider 一律拒绝。
3. 只有明确标记为免费且能验证剩余额度的远程 Provider 才可能获准。
4. 额度耗尽时立即拒绝远程调用；额度未知、无法读取或格式异常时同样关闭，不能自动切换到付费模式。
5. 项目不得保存支付方式、启用自动充值或静默升级套餐。

## 托管边界

Vercel Hobby 只用于本项目的个人非商业作品演示。Vercel 官方说明 Hobby 受个人、非商业用途限制，发布前应复核 [Vercel Hobby 文档](https://vercel.com/docs/plans/hobby) 与 [Vercel 当前限制](https://vercel.com/docs/limits)。本仓库不启用会产生远程计算或按量费用的能力。

商业使用不应继续依赖 Vercel Hobby；推荐保持纯静态架构并迁移到 Cloudflare Pages，或部署到所有者可控的自托管环境。选择 Cloudflare Pages 时不要启用 Pages Functions、付费 Workers 或其他付费附加项，并以 [Cloudflare Pages 限制](https://developers.cloudflare.com/pages/platform/limits/) 和 [Pages Functions 计费说明](https://developers.cloudflare.com/pages/functions/pricing/) 为准。

平台方案、免费层与配额都可能变化，因此本文不固化项目数、请求数或流量数值。每次部署前必须回读上述官方页面；一旦免费边界无法确认，就保持静态本地能力并停止远程集成。

## 发布检查

- 确认 `COST_MODE=zero_owner_cost`，且自动账单为关闭状态。
- 确认页面没有 `fetch`、XHR、WebSocket、远程 SDK 或服务端函数依赖。
- 确认任务内容与进度只进入浏览器 `localStorage`。
- 确认公开页同时显示成本边界和“个人作品案例 · 教学演示”真实性边界。
- 若新增 Provider，先增加付费拒绝、额度耗尽和额度未知三类自动化测试；测试未通过不得部署。

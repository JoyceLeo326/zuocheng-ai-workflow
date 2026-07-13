# 做成■

> 别再收藏工具，先做成一件事。

![做成■｜从模糊待办到可交付结果](assets/og-cover.jpg)

做成■ 是一套面向大学生真实任务的 AI 学习工作流。它不从模型参数或工具清单讲起，而是从课堂汇报、文献梳理、用户调研、商赛分析、答辩准备等近期必须提交的任务开始，带用户完成从 `□ 待办` 到 `■ 交付` 的完整闭环。

## 产品结构

- **7 天起步课**：带着一项真实任务，每天推进一个关键节点，第 7 天形成可提交结果。
- **18 课系统课**：覆盖定义任务、寻找依据、组织结构、生成初稿、核验表达、沉淀复用六次闭环。
- **学科任务包**：按具体任务提供输入清单、步骤卡、提示结构、核验表与交付模板。

网站内置第一课“25 页资料 → 3 页课堂汇报”的完整工作台，也呈现海报、短视频分镜、社群触点、14 天上线节奏、增长漏斗与反馈迭代机制。

## 本地运行

这是一个无构建步骤、无第三方依赖的静态网站。

```bash
python3 -m http.server 4173
```

然后访问：

```text
http://localhost:4173
```

直接打开 `index.html` 也可以浏览，但使用本地服务器能更接近线上环境。

## Vercel 部署

仓库导入 Vercel 后无需选择框架，也无需填写构建命令：

- Framework Preset：Other
- Build Command：留空
- Output Directory：`.`
- Install Command：留空

`vercel.json` 已配置静态路由与常用安全响应头。

## 文件结构

```text
.
├── index.html
├── styles.css
├── script.js
├── vercel.json
├── assets
│   ├── og-cover.png
│   ├── og-cover.jpg
│   ├── og-cover.svg
│   └── 做成-AI学习工作流.pdf
└── docs
    ├── product-architecture.md
    ├── content-system.md
    ├── launch-playbook.md
    └── measurement.md
```

## 设计与交互

- 核心符号：`□ → ■`，分别代表待办与完成。
- 颜色：暖纸白、石墨黑、钴蓝、完成绿与核验红。
- 交互：7 天路径、第一课工作台、资料证据切换、3 页汇报、短视频分镜、社群文案、上线日历、漏斗实验与反馈迭代。
- 可访问性：支持键盘焦点、语义化标签、状态播报与 `prefers-reduced-motion`。
- 进度：7 天路径的完成状态会保存在浏览器本地。

## 产品文档

- [产品架构](docs/product-architecture.md)
- [内容系统](docs/content-system.md)
- [14 天上线手册](docs/launch-playbook.md)
- [指标与实验](docs/measurement.md)

## 发布前检查

1. 桌面端检查 1440px、1024px 两档布局。
2. 移动端检查 390px、430px 两档布局与横向任务导航。
3. 完整点击 7 天路径、第一课五步、14 天日历和两版漏斗。
4. 在系统“减少动态效果”开启后确认内容仍完整可见。
5. 检查浏览器控制台无错误、所有站内锚点可达。

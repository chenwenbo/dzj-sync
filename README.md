# Markdown 多平台同步（精简版）

基于开源项目 [Wechatsync（文章同步助手）](https://github.com/wechatsync/Wechatsync) 精简而来的 Chrome 扩展：

**上传 Markdown 文档 → 选择平台 → 一键保存草稿或直接发布。**

- 使用浏览器中已登录的账号，不需要输入各平台密码，不经过任何第三方服务器
- 支持 frontmatter、本地图片、多篇文档批量同步
- 支持「保存草稿」和「直接发布」两种模式
- 支持 AI 工作流：命令行 CLI、MCP Server（Claude Code / Claude Desktop 等）、Claude Skill

## 使用方法

1. 安装扩展（见下文「构建与安装」），在浏览器中登录需要同步的平台
2. 点击扩展图标，打开「Markdown 多平台同步」页面
3. 拖入 `.md` 文件（文章引用了本地图片时，把图片一起拖进来，或直接「选择文件夹」）
4. 检查标题、标签、分类、摘要、封面，可切换到「预览」查看效果
5. 勾选目标平台，选择「保存草稿」或「直接发布」，点击按钮开始同步
6. 在「同步结果」中查看每个平台的状态和文章链接

### frontmatter

```markdown
---
title: 文章标题            # 不写则使用第一个一级标题，再没有则使用文件名
tags: [JavaScript, 前端]   # 也支持 "JavaScript, 前端"
category: 前端             # 掘金分类（前端 / 后端 / Android / iOS / 人工智能 / 开发工具 / 代码人生 / 阅读）
summary: 文章摘要          # 也支持 description / excerpt
cover: ./images/cover.png  # 图片 URL 或本地相对路径
---

正文……

![示意图](./images/demo.png)
```

## 支持的平台

| 平台 | 保存草稿 | 直接发布 | 发布时需要 / 说明 |
|-----|:---:|:---:|-----|
| 掘金 | ✅ | ✅ | 至少 1 个 `tags`，摘要不少于 50 字；发布后进入审核 |
| CSDN | ✅ | ✅ | 至少 1 个 `tags`；发布后进入审核 |
| 知乎 | ✅ | ✅ | `tags` 会自动匹配为知乎话题（知乎通常要求至少一个话题） |
| 博客园 | ✅ | ✅ | 发布为「随笔」 |
| 语雀 | ✅ | ✅ | 发布到第一个常用知识库 |
| 微信公众号 | ✅ | ✅ | 「发表」（不推送粉丝）；需在后台 **关闭「群发消息保护」**，否则每次需管理员扫码，此时保留草稿 |
| 微博头条文章 | ✅ | ✅ | 需要封面：`cover` 或正文中的微博图片；可能触发人机验证 |
| B站专栏 | ✅ | ✅ | `category` 可选（分类名，默认 科技·数码）；发布后进入审核，可能被风控拦截 |
| 百家号 | ✅ | ✅ | 需要封面：`cover` 或正文图片；发布后进入审核，新账号首次可能需验证码 |
| 豆瓣日记 | ✅ | ✅ | 公开发布，`tags` 作为日记标签；标题不超过 100 字 |
| 雪球 | ✅ | ✅ | 可能要求验证码 |
| SegmentFault | ✅ | ✅ | 至少 1 个已存在的思否标签（`tags`） |
| 开源中国 | ✅ | ✅ | `category` 匹配博客分类，默认文章最多的分类；草稿箱会保留一份草稿 |
| 51CTO | ✅ | ✅ | 至少 1 个 `tags`；`category` 匹配分类，否则用上次使用的分类 |
| WordPress / Typecho / MetaWeblog | ✅ | ✅ | XML-RPC |
| 搜狐号、人人都是产品经理、东方财富、慕课网 | ✅ | — | 没有找到公开的发布接口，仅草稿 |

直接发布的规则：

- 先保存草稿，再调用平台的发布接口
- 发布失败（缺少标签、平台拒绝等）时 **草稿会保留**，结果中显示失败原因，可到平台上手动发布
- 选择「直接发布」时，不支持发布的平台会自动保存为草稿并提示

> 各平台的发布接口来自其网页编辑器，参考了多个开源项目的实现（代码注释中注明了来源），但未在正式账号上逐一验证；平台改版后也可能失效。
> 建议先用「保存草稿」确认排版，再使用直接发布；发布失败时草稿会保留，结果中会给出原因。

## AI 能力：CLI / MCP / Skill

扩展页面右侧的「AI 连接」开启后，扩展会连接本地的 `ws://localhost:9527`，CLI 和 MCP Server 通过它同步文章。
请求需要携带 Token（在「AI 连接」中复制，配置为环境变量 `WECHATSYNC_TOKEN`），所有数据只在本机传输。

```
Claude / 终端 ──> MCP Server 或 CLI ──WebSocket(9527)──> Chrome 扩展 ──> 各平台（使用浏览器登录态）
```

### CLI

```bash
pnpm build && cd packages/cli && npm link      # 安装 wechatsync 命令
export WECHATSYNC_TOKEN="扩展中复制的 token"

wechatsync platforms --auth                          # 登录状态，「可发布」表示支持直接发布
wechatsync sync post.md -p juejin,csdn               # 保存草稿
wechatsync sync post.md -p juejin,csdn --publish     # 直接发布（会二次确认，-y 跳过）
wechatsync sync post.md -p juejin --tags "JavaScript,前端" --category 前端 --publish -y
wechatsync sync post.md -p juejin --dry-run          # 只预览，不同步
```

本地图片、frontmatter 与页面上传一致；自建站使用 `wechatsync platforms` 显示的 id（如 `cms_1712345678`）。

### MCP Server

```bash
claude mcp add wechatsync -e WECHATSYNC_TOKEN="你的 token" -- node /path/to/dzj-sync/packages/mcp-server/dist/index.js
```

提供的工具：

| 工具 | 说明 |
|-----|-----|
| `list_platforms` | 平台与自建站列表、登录状态、是否支持直接发布（`canPublish`） |
| `check_auth` | 检查单个平台登录状态 |
| `sync_markdown_file` | 同步本地 Markdown / HTML 文件（推荐，自动处理 frontmatter 和本地图片） |
| `sync_article` | 同步传入的 Markdown / HTML 内容 |
| `upload_image_file` | 上传本地图片到指定平台图床 |

同步类工具默认保存草稿，传 `publish: true` 才直接发布；还支持 `title`、`tags`、`category`、`summary`、`cover` 参数。详见 [packages/mcp-server/README.md](packages/mcp-server/README.md)。

### Claude Skill

[`skills/wechatsync/SKILL.md`](skills/wechatsync/SKILL.md) 让 Claude 通过 CLI 完成同步。仓库根目录带有 `.claude-plugin`，可作为 Claude Code 插件安装：

```bash
claude plugin marketplace add chenwenbo/dzj-sync
claude plugin install sync@dzj-sync
```

## 构建与安装

需要 Node.js 20+ 和 pnpm。

```bash
pnpm install
pnpm build        # 构建扩展、MCP Server 和 CLI
```

在 Chrome（或 Edge 等 Chromium 内核浏览器）打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择 `packages/extension/dist`。

## 开发

```bash
pnpm dev         # 开发模式
pnpm test        # 单元测试（Markdown 解析、各平台发布流程）
pnpm typecheck   # 类型检查
```

项目结构：

```
packages/
├── core/        # Markdown 解析、平台适配器（adapters/platforms/*）、运行时接口
├── extension/   # Chrome 扩展
│   └── src/
│       ├── app/         # 同步页面（上传、预览、选择平台、结果、AI 连接设置）
│       ├── background/  # Service Worker：登录检查、执行同步
│       ├── offscreen/   # 为 MCP / CLI 请求提供 DOM（Markdown 渲染与按平台预处理）
│       ├── mcp/         # 与 MCP Server / CLI 的 WebSocket 连接
│       └── adapters/    # 适配器注册、自建站（WordPress / Typecho / MetaWeblog）
├── mcp-server/  # MCP Server（stdio / SSE）
└── cli/         # wechatsync 命令行
skills/          # Claude Skill
```

新增或修复平台请参考 [docs/adapter-spec.md](docs/adapter-spec.md)。

## 相比原项目移除的功能

网页文章提取（含 CLI `extract` / MCP `extract_article`）、公众号 / 头条页面内按钮、在线编辑器、悬浮按钮、同步历史、数据统计、远程配置、版本检查、Markdown ZIP 下载、私有适配器子模块。

## License

[GPL-3.0](LICENSE)

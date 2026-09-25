# Markdown 多平台同步（精简版）

基于开源项目 [Wechatsync（文章同步助手）](https://github.com/wechatsync/Wechatsync) 精简而来的 Chrome 扩展：

**上传 Markdown 文档 → 选择平台 → 一键保存草稿或直接发布。**

- 使用浏览器中已登录的账号，不需要输入各平台密码，不经过任何第三方服务器
- 支持 frontmatter、本地图片、多篇文档批量同步
- 支持「保存草稿」和「直接发布」两种模式

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

| 平台 | 保存草稿 | 直接发布 | 说明 |
|-----|:---:|:---:|-----|
| 掘金 | ✅ | ✅ | 发布需要至少 1 个标签、摘要不少于 50 字；发布后进入审核 |
| CSDN | ✅ | ✅ | 发布需要至少 1 个标签；发布后进入审核 |
| 知乎 | ✅ | ✅ | |
| 博客园 | ✅ | ✅ | 直接发布为「随笔」 |
| 语雀 | ✅ | ✅ | 发布到第一个常用知识库 |
| WordPress | ✅ | ✅ | XML-RPC，建议使用应用密码 |
| Typecho | ✅ | ✅ | XML-RPC |
| MetaWeblog | ✅ | ✅ | 兼容 MetaWeblog API 的博客 |
| 微信公众号 | ✅ | — | 群发需管理员扫码确认，只能保存草稿 |
| 微博、B站专栏、百家号、豆瓣、搜狐号、雪球、人人都是产品经理、51CTO、慕课网、开源中国、SegmentFault、东方财富 | ✅ | — | 仅草稿 |

直接发布的规则：

- 先保存草稿，再调用平台的发布接口
- 发布失败（缺少标签、平台拒绝等）时 **草稿会保留**，结果中显示失败原因，可到平台上手动发布
- 选择「直接发布」时，不支持发布的平台会自动保存为草稿并提示

> 各平台的发布接口来自其网页编辑器，平台改版后可能失效。建议先用「保存草稿」确认排版，再使用直接发布。

## 构建与安装

需要 Node.js 20+ 和 pnpm。

```bash
pnpm install
pnpm build
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
└── extension/   # Chrome 扩展
    └── src/
        ├── app/         # 同步页面（上传、预览、选择平台、结果）
        ├── background/  # Service Worker：登录检查、执行同步
        └── adapters/    # 适配器注册、自建站（WordPress / Typecho / MetaWeblog）
```

新增或修复平台请参考 [docs/adapter-spec.md](docs/adapter-spec.md)。

## 相比原项目移除的功能

网页文章提取、公众号 / 头条页面内按钮、在线编辑器、悬浮按钮、同步历史、CLI、MCP Server、Claude Skill、数据统计、远程配置、版本检查、Markdown ZIP 下载、私有适配器子模块。

## License

[GPL-3.0](LICENSE)

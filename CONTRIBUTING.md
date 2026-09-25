# 开发指南

## 项目结构

使用 pnpm workspace 管理，代码在 `packages` 目录下：

- `packages/core`：Markdown 文档解析、各平台适配器、运行时抽象
- `packages/extension`：Chrome 扩展（同步页面 + Background Service Worker + MCP 连接）
- `packages/mcp-server`：MCP Server，桥接 Claude 等 AI 工具与扩展
- `packages/cli`：`wechatsync` 命令行
- `skills/`：Claude Skill

## 本地开发

```bash
pnpm install        # 安装依赖
pnpm dev            # 开发模式（热更新）
pnpm build          # 构建 MCP Server、CLI 和扩展（扩展产物在 packages/extension/dist）
pnpm test           # 运行 core 单元测试
pnpm typecheck      # 类型检查
```

在 `chrome://extensions` 中打开「开发者模式」，选择「加载已解压的扩展程序」，指向 `packages/extension/dist`。

## 新增 / 修复平台

参考 [docs/adapter-spec.md](docs/adapter-spec.md)。支持直接发布的平台需要声明 `'publish'` 能力，
并通过 `finishWithPublish` 完成发布，确保发布失败时草稿不会丢失。

## 代码提交

提交信息遵循 conventional commits：

```
<type>(scope): <description>
```

- type：feat / fix / perf / refactor / test / build / docs / chore
- scope：core / extension / mcp / cli / skill / 平台 ID（如 juejin）

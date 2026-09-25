# MCP Server

让 Claude Code、Claude Desktop 等支持 MCP 的 AI 工具通过「Markdown 多平台同步」Chrome 扩展同步或发布文章。

```
Claude ──stdio / SSE──> MCP Server ──WebSocket(9527, token)──> Chrome 扩展 ──> 各平台
```

## 配置

1. 构建：仓库根目录执行 `pnpm install && pnpm build`
2. 扩展页面右侧「AI 连接」→ 开启 → 复制 Token
3. 添加到 Claude Code：

```bash
claude mcp add wechatsync -e WECHATSYNC_TOKEN="你的 token" -- node /path/to/dzj-sync/packages/mcp-server/dist/index.js
```

Claude Desktop（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "wechatsync": {
      "command": "node",
      "args": ["/path/to/dzj-sync/packages/mcp-server/dist/index.js"],
      "env": { "WECHATSYNC_TOKEN": "你的 token" }
    }
  }
}
```

SSE 模式：`node dist/index.js --sse`，然后 `claude mcp add --transport sse wechatsync http://localhost:9528/sse`。

## 工具

| 工具 | 参数 | 说明 |
|-----|-----|-----|
| `list_platforms` | — | 平台和自建站列表、登录状态、`canPublish` |
| `check_auth` | `platform` | 单个平台登录状态 |
| `sync_markdown_file` | `filePath`, `platforms`, 同步参数 | 同步本地文件（推荐），自动读取 frontmatter、上传本地图片 |
| `sync_article` | `markdown` 或 `content`, `platforms`, 同步参数 | 同步传入内容，本地图片需为 data URI |
| `upload_image_file` | `filePath`, `platform` | 上传图片到指定平台图床，返回 URL |

同步参数：`publish`（默认 false，只保存草稿）、`title`、`tags`、`category`、`summary`、`cover`。

返回每个平台的 `success`、`postUrl`、`draftOnly`（false 表示已发布）、`message`（如「草稿已保存，但直接发布失败：…」）和 `error`。

## 环境变量

- `WECHATSYNC_TOKEN`（或 `MCP_TOKEN`）：与扩展中的 Token 一致（必需）
- `SYNC_WS_PORT`：WebSocket 端口，默认 9527
- `SYNC_HTTP_PORT`：SSE 模式 HTTP 端口，默认 9528

## 远程桥接

MCP Server 在远程机器上运行时，在扩展「AI 连接」中把桥接地址改为 `ws://远程地址:9527`。Token 以明文传输，建议配合 SSH 隧道：`ssh -R 9527:localhost:9527 user@remote`。

# wechatsync CLI

命令行同步 Markdown / HTML 文章到多个平台，支持保存草稿或直接发布。需要配合「Markdown 多平台同步」Chrome 扩展使用。

## 安装

```bash
# 仓库根目录
pnpm install && pnpm build
cd packages/cli && npm link
```

在扩展页面右侧「AI 连接」中开启并复制 Token：

```bash
export WECHATSYNC_TOKEN="你的 token"
```

## 命令

### sync

```bash
wechatsync sync post.md -p juejin,csdn                 # 保存草稿（默认）
wechatsync sync post.md -p juejin,csdn --publish       # 直接发布（会确认，-y 跳过）
wechatsync sync post.md -p juejin -t "标题" --tags "JavaScript,前端" --category 前端 --summary "摘要" --publish -y
wechatsync sync post.md -p zhihu --cover ./cover.png
wechatsync sync page.html -p cnblogs                   # HTML 文件（<style> 会内联到元素上）
wechatsync sync post.md --dry-run                      # 只预览
```

- 标题、标签、分类、摘要、封面默认读取 frontmatter，命令行参数优先
- 本地图片（`![](./img/a.png)`、frontmatter 中的 `cover`）会上传到各目标平台
- 不支持直接发布的平台会保存为草稿；发布失败时草稿保留，结果中给出原因
- 有平台失败时退出码为 1

### platforms / auth

```bash
wechatsync platforms --auth    # 列出平台、登录状态、是否支持直接发布
wechatsync auth juejin         # 检查单个平台
```

## 工作原理

```
wechatsync ──WebSocket(localhost:9527, token)──> Chrome 扩展 ──> 各平台 API（浏览器登录态）
```

环境变量：`WECHATSYNC_TOKEN`（必需）、`SYNC_WS_PORT`（默认 9527）。

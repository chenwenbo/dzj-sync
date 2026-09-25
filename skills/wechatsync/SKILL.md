---
name: wechatsync
description: "Multi-platform Markdown publisher. Sync or directly publish Markdown/HTML articles to Juejin (掘金), CSDN, Zhihu (知乎), Cnblogs (博客园), Yuque (语雀), WordPress, Typecho, WeChat Official Account (微信公众号, draft only), Weibo, Bilibili and more. Use when the user wants to publish, sync, cross-post or distribute an article (文章同步 / 多平台发布 / 一键发布 / 直接发布 / 保存草稿), or check which platforms they are logged into."
metadata:
  openclaw:
    requires:
      env:
        - WECHATSYNC_TOKEN
      bins:
        - wechatsync
    primaryEnv: WECHATSYNC_TOKEN
    emoji: "\U0001F4DD"
    homepage: https://github.com/chenwenbo/dzj-sync
---

# Markdown 多平台同步

Sync Markdown/HTML files to multiple content platforms via the `wechatsync` CLI. Articles are saved as **drafts** by default; `--publish` publishes them directly.

## Prerequisites

The user must set these up themselves (do not install anything without explicit consent):

1. **Chrome extension** "Markdown 多平台同步" built from https://github.com/chenwenbo/dzj-sync and loaded in Chrome
2. **CLI**: `packages/cli` from the same repository (`pnpm build`, then `npm link` or run `node packages/cli/dist/index.js`)
3. **Token**: open the extension page → 「AI 连接」→ enable → copy token, then `export WECHATSYNC_TOKEN="..."`
4. **Platform logins**: log in to target platforms in the same browser (the extension uses existing cookies; no credentials are stored or transmitted)

Everything runs locally: CLI ⇄ extension over `ws://localhost:9527`, the extension calls platform APIs from the browser.

## Commands

```bash
wechatsync platforms --auth                          # login status; "可发布" = supports direct publish
wechatsync auth juejin                               # check one platform

wechatsync sync post.md -p juejin,csdn               # save as drafts
wechatsync sync post.md -p juejin,csdn --publish -y  # publish directly (-y skips the confirmation prompt)
wechatsync sync post.md -p juejin --tags "JavaScript,前端" --category 前端 --summary "..." --publish -y
wechatsync sync post.md -p zhihu --cover ./cover.png
wechatsync sync post.md -p juejin --dry-run          # preview only
```

## Front matter

```markdown
---
title: 文章标题        # else first "# heading", else file name
tags: [JavaScript, 前端]
category: 前端
summary: 摘要
cover: ./cover.png
---
```

Local images (`![](./img/a.png)`) are uploaded automatically to each target platform.

## Platforms

| Direct publish | Draft only |
|---|---|
| juejin, csdn, zhihu, cnblogs, yuque, self-hosted WordPress / Typecho / MetaWeblog (ids shown by `platforms`) | weixin, weibo, bilibili, baijiahao, douban, sohu, xueqiu, woshipm, 51cto, imooc, oschina, segmentfault, eastmoney |

Publishing requirements: juejin needs ≥1 tag and a summary ≥50 characters; csdn needs ≥1 tag. Juejin/CSDN articles go through platform review after publishing.

## Workflow

1. Confirm prerequisites (ask if unsure)
2. `wechatsync platforms --auth` to see which targets are logged in
3. **Default to drafts.** Only use `--publish` when the user explicitly asks to publish; publishing makes the article public
4. Run `wechatsync sync <file> -p <ids> [--publish -y]`
5. Report each platform's result and URL. A result with a message like「草稿已保存，但直接发布失败：…」means the draft exists but publishing failed — tell the user the reason (e.g. missing tags) and offer to fix and retry

Example prompts:
- "把这篇文章同步到掘金和 CSDN 草稿箱"
- "把 post.md 直接发布到掘金、知乎和我的 WordPress"
- "我在哪些平台登录了？"

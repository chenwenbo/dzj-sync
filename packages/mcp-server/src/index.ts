/**
 * Sync Assistant MCP Server
 *
 * 支持两种模式：
 * 1. stdio 模式（推荐）: claude mcp add sync-assistant node dist/index.js
 * 2. SSE 模式: 先启动服务，再 claude mcp add --transport sse sync-assistant http://localhost:9528/sse
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import express, { type Request, type Response } from 'express'
import fs from 'fs'
import path from 'path'
import { ExtensionBridge } from './ws-bridge.js'
import { imageFileToDataUri, loadArticleFile } from './markdown-file.js'
import type { PlatformInfo, SyncResult } from './types.js'

const WS_PORT = parseInt(process.env.SYNC_WS_PORT || '9527', 10)
const HTTP_PORT = parseInt(process.env.SYNC_HTTP_PORT || '9528', 10)

/** sync_article / sync_markdown_file 共用的参数 */
const ARTICLE_OPTION_PROPERTIES = {
  platforms: {
    type: 'array',
    items: { type: 'string' },
    description: '目标平台 ID 列表，如 ["juejin", "csdn"]；自建站使用 list_platforms 返回的 id',
  },
  publish: {
    type: 'boolean',
    description: '是否直接发布。默认 false（只保存草稿）。直接发布会公开文章，调用前应先征得用户同意',
  },
  title: { type: 'string', description: '文章标题（可选，默认取 frontmatter title 或第一个一级标题）' },
  tags: {
    type: 'array',
    items: { type: 'string' },
    description: '标签（可选）。掘金、CSDN 直接发布时至少需要 1 个',
  },
  category: { type: 'string', description: '分类（可选），如掘金的 前端 / 后端' },
  summary: { type: 'string', description: '摘要（可选）。掘金直接发布要求不少于 50 字，默认从正文截取' },
  cover: { type: 'string', description: '封面图 URL、本地路径或 data URI（可选）' },
} as const

interface ArticleOptions {
  platforms: string[]
  publish?: boolean
  title?: string
  tags?: string[]
  category?: string
  summary?: string
  cover?: string
}

/**
 * 转发同步请求到扩展
 */
async function requestSync(options: ArticleOptions, body: { markdown?: string; content?: string }, baseDir?: string) {
  let cover = options.cover
  if (cover && baseDir && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(cover)) {
    const dataUri = imageFileToDataUri(cover, baseDir)
    if (!dataUri) throw new Error(`Cover image not found: ${cover}`)
    cover = dataUri
  }
  return bridge.request<{ results: SyncResult[] }>('syncArticle', {
    platforms: options.platforms,
    draftOnly: options.publish !== true,
    article: {
      title: options.title,
      markdown: body.markdown,
      content: body.content,
      tags: options.tags,
      category: options.category,
      summary: options.summary,
      cover,
    },
  })
}

// 检查是否是 SSE 模式
const isSSEMode = process.argv.includes('--sse')

// Extension WebSocket 桥接
const bridge = new ExtensionBridge(WS_PORT)

/**
 * 创建 MCP Server
 */
function createServer(): Server {
  const server = new Server(
    {
      name: 'sync-assistant',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  )

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'list_platforms',
          description: '列出所有平台（含已添加的 WordPress / Typecho 等自建站）及登录状态。canPublish=true 表示支持直接发布，否则只能保存草稿。',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'check_auth',
          description: '检查指定平台的登录状态',
          inputSchema: {
            type: 'object',
            properties: {
              platform: {
                type: 'string',
                description: '平台 ID，如 zhihu, juejin, csdn, cnblogs, yuque',
              },
            },
            required: ['platform'],
          },
        },
        {
          name: 'sync_markdown_file',
          description: '把本地 Markdown / HTML 文件同步到指定平台（推荐）。自动读取 frontmatter（title / tags / category / summary / cover），本地图片自动上传到各平台图床。默认保存为草稿，publish=true 时直接发布。',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: { type: 'string', description: '文件的绝对路径，如 /Users/xxx/post.md' },
              ...ARTICLE_OPTION_PROPERTIES,
            },
            required: ['filePath', 'platforms'],
          },
        },
        {
          name: 'sync_article',
          description: '同步文章内容到指定平台。默认保存为草稿，publish=true 时直接发布（不支持发布的平台会保存为草稿）。markdown 可以包含 frontmatter；本地图片必须转换为 base64 data URI（如 ![img](data:image/png;base64,xxx)），有本地文件时优先使用 sync_markdown_file。',
          inputSchema: {
            type: 'object',
            properties: {
              markdown: {
                type: 'string',
                description: '文章内容（Markdown，推荐）。不要重复包含标题行；可以包含 frontmatter',
              },
              content: {
                type: 'string',
                description: '文章内容（HTML，可选）。提供了 markdown 时忽略',
              },
              ...ARTICLE_OPTION_PROPERTIES,
            },
            required: ['platforms'],
          },
        },
        {
          name: 'upload_image_file',
          description: '从本地文件路径上传图片到图床平台，返回可公开访问的 URL。推荐使用此方法，无需手动转换 base64。',
          inputSchema: {
            type: 'object',
            properties: {
              filePath: {
                type: 'string',
                description: '本地图片文件的绝对路径，如 /Users/xxx/image.png',
              },
              platform: {
                type: 'string',
                description: '上传到哪个平台作为图床，默认 weibo。可选: weibo, zhihu, juejin, jianshu, woshipm',
              },
            },
            required: ['filePath'],
          },
        },
      ],
    }
  })

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    try {
      // 检查 Extension 是否连接
      if (!bridge.isConnected()) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Chrome Extension 未连接。请确保：\n1. 已安装 Markdown 多平台同步扩展\n2. 在扩展页面的「AI 连接」中已开启，并把 Token 配置为 WECHATSYNC_TOKEN',
              }),
            },
          ],
          isError: true,
        }
      }

      let result: unknown

      switch (name) {
        case 'list_platforms':
          result = await bridge.request<PlatformInfo[]>('listPlatforms')
          break

        case 'check_auth':
          result = await bridge.request<PlatformInfo>('checkAuth', {
            platform: (args as { platform: string }).platform,
          })
          break

        case 'sync_markdown_file': {
          const options = args as unknown as ArticleOptions & { filePath: string }
          const file = loadArticleFile(options.filePath)
          const response = await requestSync(
            options,
            file.format === 'markdown' ? { markdown: file.content } : { content: file.content },
            path.dirname(path.resolve(options.filePath))
          )
          result = { ...response, missingImages: file.missing }
          break
        }

        case 'sync_article': {
          const options = args as unknown as ArticleOptions & { markdown?: string; content?: string }
          result = await requestSync(options, { markdown: options.markdown, content: options.content })
          break
        }

        case 'upload_image_file': {
          // 从文件路径读取图片并上传
          const filePath = (args as { filePath: string }).filePath
          const platform = (args as { platform?: string }).platform || 'weibo'

          // 检查文件是否存在
          if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`)
          }

          // 读取文件并转为 base64
          const fileBuffer = fs.readFileSync(filePath)
          const imageData = fileBuffer.toString('base64')

          // 根据扩展名确定 MIME 类型
          const ext = path.extname(filePath).toLowerCase()
          const mimeTypes: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
          }
          const mimeType = mimeTypes[ext] || 'image/png'

          // 使用分片上传
          result = await bridge.uploadImageChunked(imageData, mimeType, platform)
          break
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: (error as Error).message }),
          },
        ],
        isError: true,
      }
    }
  })

  return server
}

/**
 * stdio 模式启动
 */
async function startStdioMode() {
  // 启动 WebSocket 服务器（Extension 连接）
  await bridge.start()

  const server = createServer()
  const transport = new StdioServerTransport()

  await server.connect(transport)

  // 日志输出到 stderr（不影响 stdio 通信）
  console.error('[MCP] Sync Assistant started (stdio mode)')
  console.error(`[MCP] Extension WebSocket: ws://localhost:${WS_PORT}`)
}

/**
 * SSE 模式启动
 */
async function startSSEMode() {
  // 启动 WebSocket 服务器（Extension 连接）
  await bridge.start()

  const server = createServer()
  const app = express()
  let transport: SSEServerTransport | null = null

  // SSE 端点
  app.get('/sse', async (req: Request, res: Response) => {
    console.error('[MCP] New SSE connection from Claude Code')
    transport = new SSEServerTransport('/message', res)

    res.on('close', () => {
      console.error('[MCP] SSE connection closed')
      transport = null
    })

    await server.connect(transport)
  })

  // 消息端点
  app.post('/message', express.json(), async (req: Request, res: Response) => {
    if (transport) {
      await transport.handlePostMessage(req, res)
    } else {
      res.status(400).json({ error: 'No active SSE connection' })
    }
  })

  // 健康检查
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      extensionConnected: bridge.isConnected(),
    })
  })

  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'Sync Assistant MCP Server',
      version: '1.0.0',
      extensionConnected: bridge.isConnected(),
    })
  })

  app.listen(HTTP_PORT, () => {
    console.error('[MCP] Sync Assistant started (SSE mode)')
    console.error(`[MCP] HTTP Server: http://localhost:${HTTP_PORT}`)
    console.error(`[MCP] Claude Code: http://localhost:${HTTP_PORT}/sse`)
    console.error(`[MCP] Extension WebSocket: ws://localhost:${WS_PORT}`)
  })
}

// 启动
if (isSSEMode) {
  startSSEMode().catch((error) => {
    console.error('[MCP] Failed to start:', error)
    process.exit(1)
  })
} else {
  startStdioMode().catch((error) => {
    console.error('[MCP] Failed to start:', error)
    process.exit(1)
  })
}

// 处理退出信号
process.on('SIGINT', () => {
  console.error('[MCP] Shutting down...')
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.error('[MCP] Shutting down...')
  process.exit(0)
})

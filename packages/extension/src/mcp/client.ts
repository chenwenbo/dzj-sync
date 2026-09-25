/**
 * MCP WebSocket Client - 连接本地 MCP Server / CLI
 *
 * 支持的方法：listPlatforms、checkAuth、syncArticle（草稿 / 直接发布）、uploadImage
 */
import { parseMarkdownDocument, splitFrontmatter } from '@wechatsync/core'
import { checkAllPlatformsAuth, checkPlatformAuth, getAdapter } from '../adapters'
import { getCmsAccounts } from '../lib/cms-accounts'
import { extractDataUris, type ArticleInput } from '../lib/messages'
import { createLogger } from '../lib/logger'
import { prepareArticleOffscreen } from '../background/offscreen'
import { syncArticle } from '../background/sync'

const logger = createLogger('MCPClient')

// 消息类型
interface RequestMessage {
  id: string
  method: string
  token?: string  // 安全验证 token
  params?: Record<string, unknown>
}

interface ResponseMessage {
  id: string
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

// 分片上传会话
interface PendingUpload {
  chunks: Map<number, string>  // chunkIndex -> data
  totalChunks: number
  mimeType: string
  platform: string
  createdAt: number
  timeoutId: ReturnType<typeof setTimeout>
}

const DEFAULT_SERVER_URL = 'ws://localhost:9527'

/** MCP / CLI 传入的文章 */
interface McpArticle {
  title?: string
  /** Markdown 正文，可包含 frontmatter；本地图片需为 data URI */
  markdown?: string
  /** HTML 正文（没有 markdown 时使用） */
  content?: string
  cover?: string
  tags?: string[] | string
  category?: string
  summary?: string
}

/**
 * 列出内置平台和自建站（带登录状态和是否支持直接发布）
 */
async function listPlatforms() {
  const platforms = (await checkAllPlatformsAuth()).map(p => ({
    id: p.id,
    name: p.name,
    homepage: p.homepage,
    isAuthenticated: p.isAuthenticated,
    username: p.username,
    error: p.error,
    canPublish: p.capabilities.includes('publish'),
  }))
  const sites = (await getCmsAccounts()).map(a => ({
    id: a.id,
    name: `${a.name}（${a.type}）`,
    homepage: a.url,
    isAuthenticated: true,
    username: a.username,
    canPublish: true,
  }))
  return [...platforms, ...sites]
}

/**
 * 整理文章：解析 frontmatter / 标题，显式参数优先；内联图片抽出为占位 URL
 */
function buildArticleInput(a: McpArticle): ArticleInput {
  const images: Record<string, string> = {}
  const tagList = (tags: unknown): string[] | undefined => {
    if (Array.isArray(tags)) return tags.map(String).map(t => t.trim()).filter(Boolean)
    if (typeof tags === 'string') return tags.split(/[,，]/).map(t => t.trim()).filter(Boolean)
    return undefined
  }

  let title = a.title?.trim() || ''
  let markdown: string | undefined
  let html: string | undefined
  let meta: { summary?: string; cover?: string; tags?: string[]; category?: string } = {}

  if (a.markdown) {
    const doc = parseMarkdownDocument(a.markdown)
    const hasOwnTitle = !!doc.frontmatter.title || doc.title !== '未命名文章'
    markdown = doc.markdown
    if (title && !doc.frontmatter.title && doc.title !== title) {
      // 第一个一级标题不是文章标题，保留在正文中
      markdown = splitFrontmatter(a.markdown).body
    }
    if (!title && hasOwnTitle) title = doc.title
    meta = { summary: doc.summary, cover: doc.cover, tags: doc.tags.length ? doc.tags : undefined, category: doc.category }
  } else if (a.content) {
    html = a.content
  } else {
    throw new Error('Missing article content (markdown or content required)')
  }
  if (!title) throw new Error('Missing article title')

  const cover = a.cover || meta.cover
  return {
    title,
    markdown: markdown !== undefined ? extractDataUris(markdown, images) : undefined,
    html: html !== undefined ? extractDataUris(html, images) : undefined,
    summary: a.summary || meta.summary,
    cover: cover ? extractDataUris(cover, images) : undefined,
    tags: tagList(a.tags) ?? meta.tags,
    category: a.category || meta.category,
    images,
  }
}

class McpClient {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private serverUrl = DEFAULT_SERVER_URL

  // 安全验证 token
  private token: string | null = null

  // 温热/冷却双阶段重连配置
  private reconnectAttempts = 0
  private lastConnectedAt = 0 // 上次成功连接的时间戳
  private activelyWatched = false // 用户正在查看设置页
  private readonly WARM_WINDOW = 5 * 60 * 1000 // 5 分钟内视为温热
  // 温热阶段：刚断开，快速重连
  private readonly warmMinInterval = 500   // 500ms
  private readonly warmMaxInterval = 5000  // 5s 封顶
  // 冷却阶段：长时间未连接，减少资源消耗
  private readonly coldMinInterval = 10000 // 10s
  private readonly coldMaxInterval = 60000 // 60s 封顶
  private readonly maxReconnectAttempts = Infinity // mcpEnabled=true 时永远重试

  // 分片上传管理
  private pendingUploads = new Map<string, PendingUpload>()
  private readonly UPLOAD_TIMEOUT = 60000  // 60 秒超时
  private readonly MAX_CONCURRENT_UPLOADS = 5  // 最大并发上传数

  /**
   * 设置安全验证 token
   */
  setToken(token: string): void {
    this.token = token
    logger.debug('Token set')
  }

  /**
   * 清除 token
   */
  clearToken(): void {
    this.token = null
  }

  /**
   * 设置服务器地址（支持远程桥接）
   */
  setServerUrl(url: string): void {
    this.serverUrl = url || DEFAULT_SERVER_URL
    logger.debug(`Server URL set to ${this.serverUrl}`)
  }

  /**
   * 获取当前服务器地址
   */
  getServerUrl(): string {
    return this.serverUrl
  }

  /**
   * 连接到 MCP Server
   */
  connect(): void {
    // 清理旧连接
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        logger.debug('Already connected')
        return
      }
      // 清理非 OPEN 状态的连接
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.onmessage = null
      this.ws.onopen = null
      if (this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
      this.ws = null
    }

    logger.debug(`Connecting to ${this.serverUrl} (attempt ${this.reconnectAttempts + 1})`)

    try {
      this.ws = new WebSocket(this.serverUrl)

      this.ws.onopen = () => {
        logger.debug('Connected to MCP Server')
        this.reconnectAttempts = 0 // 重置重连计数
        this.lastConnectedAt = Date.now() // 记录连接时间
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer)
          this.reconnectTimer = null
        }
      }

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data)
      }

      this.ws.onclose = (event) => {
        logger.debug(`Disconnected (code: ${event.code}), scheduling reconnect...`)
        this.ws = null
        this.scheduleReconnect()
      }

      this.ws.onerror = () => {
        // error 事件后通常会触发 close，不需要在这里重连
        logger.debug('Connection error')
      }
    } catch (error) {
      logger.error('Connection failed:', error)
      this.ws = null
      this.scheduleReconnect()
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    this.reconnectAttempts = this.maxReconnectAttempts // 防止自动重连
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onclose = null // 防止触发重连
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * 检查是否已连接
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /**
   * 计划重连（指数退避）
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.debug('Max reconnect attempts reached, stopping')
      return
    }

    // 只在 MCP 启用时重连，避免无意义的后台重试消耗资源
    chrome.storage.local.get('mcpEnabled').then(storage => {
      if (!storage.mcpEnabled) {
        logger.debug('MCP disabled, skip reconnect')
        return
      }
      this._doScheduleReconnect()
    }).catch(() => this._doScheduleReconnect())
  }

  private _doScheduleReconnect(): void {
    // 温热/冷却双阶段退避
    const timeSinceLastConnection = Date.now() - this.lastConnectedAt
    const isWarm = this.activelyWatched
      || (this.lastConnectedAt > 0 && timeSinceLastConnection < this.WARM_WINDOW)

    let interval: number
    if (isWarm) {
      // 温热：刚断开，server 可能在重启，快速重连
      // 500ms, 1s, 2s, 4s, 5s, 5s, ...
      interval = Math.min(
        this.warmMinInterval * Math.pow(2, this.reconnectAttempts),
        this.warmMaxInterval
      )
    } else {
      // 冷却：长时间未连接，server 可能没启动，慢速重试
      // 10s, 20s, 40s, 60s, 60s, ...
      interval = Math.min(
        this.coldMinInterval * Math.pow(2, this.reconnectAttempts),
        this.coldMaxInterval
      )
    }

    logger.debug(`Reconnecting in ${interval / 1000}s (${isWarm ? 'warm' : 'cold'})...`)

    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, interval)
  }

  /**
   * 设置用户是否正在关注连接状态（如打开设置页）
   * 关注时使用温热策略快速重连
   */
  setActivelyWatched(active: boolean): void {
    this.activelyWatched = active
    // 开始关注时，如果未连接，立即尝试重连
    if (active && !this.isConnected()) {
      this.reconnectAttempts = 0
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      this.connect()
    }
  }

  /**
   * 重置重连计数（供外部调用）
   */
  resetReconnect(): void {
    this.reconnectAttempts = 0
    if (!this.isConnected()) {
      this.connect()
    }
  }

  /**
   * 处理来自 MCP Server 的请求
   */
  private async handleMessage(data: string): Promise<void> {
    try {
      const message: RequestMessage = JSON.parse(data)
      logger.debug('Received:', message.method)

      let result: unknown
      let error: { code: number; message: string } | undefined

      // Token 验证
      if (!this.token) {
        error = {
          code: 401,
          message: 'MCP token not configured',
        }
      } else if (message.token !== this.token) {
        logger.warn('Invalid token received')
        error = {
          code: 403,
          message: 'Invalid or missing token',
        }
      } else {
        try {
          result = await this.handleMethod(message.method, message.params)
        } catch (e) {
          error = {
            code: -1,
            message: (e as Error).message,
          }
        }
      }

      const response: ResponseMessage = {
        id: message.id,
        result,
        error,
      }

      this.ws?.send(JSON.stringify(response))
    } catch (error) {
      logger.error('Failed to handle message:', error)
    }
  }

  /**
   * 处理具体方法调用
   */
  private async handleMethod(
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    switch (method) {
      case 'listPlatforms':
        return await listPlatforms()

      case 'checkAuth': {
        const platform = params?.platform as string
        if (!platform) throw new Error('Missing platform parameter')
        const cms = (await getCmsAccounts()).find(a => a.id === platform)
        if (cms) return { isAuthenticated: true, username: cms.username }
        return await checkPlatformAuth(platform)
      }

      case 'syncArticle': {
        const platforms = params?.platforms as string[]
        if (!platforms?.length) throw new Error('Missing platforms parameter')
        // 默认只保存草稿，显式传 draftOnly: false 才直接发布
        const draftOnly = params?.draftOnly !== false
        const input = buildArticleInput((params?.article || {}) as McpArticle)

        const cmsIds = new Set((await getCmsAccounts()).map(a => a.id))
        const article = await prepareArticleOffscreen(input, platforms.filter(id => !cmsIds.has(id)))
        const results = await syncArticle({ article, platforms, draftOnly })
        return { results }
      }

      case 'extractArticle':
        throw new Error('精简版不包含网页文章提取功能，请直接传入 Markdown 内容')

      case 'uploadImage': {
        const imageData = params?.imageData as string
        const mimeType = params?.mimeType as string
        const platform = (params?.platform as string) || 'weibo'

        if (!imageData) throw new Error('Missing imageData parameter')
        if (!mimeType) throw new Error('Missing mimeType parameter')

        return await this.performImageUpload(imageData, mimeType, platform)
      }

      // 分片上传：开始会话
      case 'uploadImage:start': {
        const uploadId = params?.uploadId as string
        const totalChunks = params?.totalChunks as number
        const mimeType = params?.mimeType as string
        const platform = (params?.platform as string) || 'weibo'

        if (!uploadId) throw new Error('Missing uploadId')
        if (!totalChunks) throw new Error('Missing totalChunks')
        if (!mimeType) throw new Error('Missing mimeType')

        // 检查并发上传数
        if (this.pendingUploads.size >= this.MAX_CONCURRENT_UPLOADS) {
          throw new Error(`Too many concurrent uploads (max: ${this.MAX_CONCURRENT_UPLOADS})`)
        }

        // 设置超时清理
        const timeoutId = setTimeout(() => {
          this.cleanupUpload(uploadId, 'timeout')
        }, this.UPLOAD_TIMEOUT)

        // 创建上传会话
        this.pendingUploads.set(uploadId, {
          chunks: new Map(),
          totalChunks,
          mimeType,
          platform,
          createdAt: Date.now(),
          timeoutId,
        })

        logger.debug(`Chunked upload started: ${uploadId}, ${totalChunks} chunks`)
        return { success: true }
      }

      // 分片上传：接收分片
      case 'uploadImage:chunk': {
        const uploadId = params?.uploadId as string
        const chunkIndex = params?.chunkIndex as number
        const data = params?.data as string

        if (!uploadId) throw new Error('Missing uploadId')
        if (chunkIndex === undefined) throw new Error('Missing chunkIndex')
        if (!data) throw new Error('Missing chunk data')

        const upload = this.pendingUploads.get(uploadId)
        if (!upload) {
          throw new Error(`Upload session not found: ${uploadId}`)
        }

        // 存储分片
        upload.chunks.set(chunkIndex, data)
        logger.debug(`Chunk received: ${uploadId} [${chunkIndex + 1}/${upload.totalChunks}]`)

        return { success: true, received: upload.chunks.size, total: upload.totalChunks }
      }

      // 分片上传：完成并上传
      case 'uploadImage:complete': {
        const uploadId = params?.uploadId as string

        if (!uploadId) throw new Error('Missing uploadId')

        const upload = this.pendingUploads.get(uploadId)
        if (!upload) {
          throw new Error(`Upload session not found: ${uploadId}`)
        }

        // 检查是否所有分片都已接收
        if (upload.chunks.size !== upload.totalChunks) {
          throw new Error(`Incomplete upload: received ${upload.chunks.size}/${upload.totalChunks} chunks`)
        }

        // 合并分片
        const sortedChunks: string[] = []
        for (let i = 0; i < upload.totalChunks; i++) {
          const chunk = upload.chunks.get(i)
          if (!chunk) {
            throw new Error(`Missing chunk ${i}`)
          }
          sortedChunks.push(chunk)
        }
        const imageData = sortedChunks.join('')

        logger.debug(`Chunks merged: ${uploadId}, total size: ${imageData.length}`)

        // 清理会话
        this.cleanupUpload(uploadId, 'completed')

        // 执行实际上传
        return await this.performImageUpload(imageData, upload.mimeType, upload.platform)
      }

      default:
        throw new Error(`Unknown method: ${method}`)
    }
  }

  /**
   * 执行图片上传
   * 将 base64 转为 Blob，使用统一的 uploadImage 方法
   */
  private async performImageUpload(
    imageData: string,
    mimeType: string,
    platform: string
  ): Promise<{ url: string; platform: string }> {
    // 获取适配器
    const adapter = await getAdapter(platform)
    if (!adapter) {
      throw new Error(`Platform not found: ${platform}`)
    }

    // 检查适配器是否支持图片上传
    if (typeof adapter.uploadImage !== 'function') {
      throw new Error(`Platform ${platform} does not support image upload`)
    }

    // base64 转 Blob
    const binaryStr = atob(imageData)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }
    const blob = new Blob([bytes], { type: mimeType })

    // 调用统一的 uploadImage 接口
    const url = await adapter.uploadImage(blob)
    return { url, platform }
  }

  /**
   * 清理上传会话
   */
  private cleanupUpload(uploadId: string, reason: 'completed' | 'timeout' | 'error'): void {
    const upload = this.pendingUploads.get(uploadId)
    if (upload) {
      clearTimeout(upload.timeoutId)
      // 清理 chunks 以释放内存
      upload.chunks.clear()
      this.pendingUploads.delete(uploadId)
      logger.debug(`Upload cleanup: ${uploadId} (${reason})`)
    }
  }
}

// 单例
export const mcpClient = new McpClient()

// 启动连接（在 background 中调用）
export function startMcpClient(): void {
  mcpClient.resetReconnect()
}

// 停止连接
export function stopMcpClient(): void {
  mcpClient.disconnect()
}

// 获取连接状态
export function getMcpStatus(): { connected: boolean; serverUrl: string } {
  return {
    connected: mcpClient.isConnected(),
    serverUrl: mcpClient.getServerUrl(),
  }
}

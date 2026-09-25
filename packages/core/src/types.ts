/**
 * 文章内容
 *
 * 内容格式说明：
 * - markdown: 主要内容格式，来自用户上传的 Markdown 文档（已去除 frontmatter）
 * - html: 由 Markdown 渲染并按平台预处理后的 HTML，供需要 HTML 的平台使用
 * - summary / cover / tags / category: 来自 frontmatter，直接发布时部分平台需要
 */
export interface Article {
  title: string
  markdown: string    // Markdown 格式内容（主要）
  html?: string       // 渲染后的 HTML（用于需要 HTML 的平台）
  summary?: string
  cover?: string
  tags?: string[]
  category?: string
}

/**
 * 同步结果
 */
export interface SyncResult {
  platform: string
  success: boolean
  postId?: string
  postUrl?: string
  draftOnly?: boolean  // 是否只保存了草稿（false 表示已直接发布）
  error?: string
  message?: string  // 额外提示信息
  timestamp: number
}

/**
 * 认证状态
 */
export interface AuthResult {
  isAuthenticated: boolean
  username?: string
  userId?: string
  avatar?: string
  error?: string
}

/**
 * 平台能力
 */
export type PlatformCapability =
  | 'article'      // 发布文章
  | 'draft'        // 草稿支持
  | 'publish'      // 支持直接发布（不仅是草稿）
  | 'image_upload' // 图片上传
  | 'categories'   // 分类
  | 'tags'         // 标签
  | 'cover'        // 封面图
  | 'schedule'     // 定时发布

/**
 * 平台元信息
 */
export interface PlatformMeta {
  id: string
  name: string
  icon: string
  homepage: string
  capabilities: PlatformCapability[]
}

/**
 * Cookie
 */
export interface Cookie {
  name: string
  value: string
  domain: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
}

/**
 * Header 规则
 */
export interface HeaderRule {
  id?: string
  urlFilter: string
  headers: Record<string, string>
  resourceTypes?: string[]
}

/**
 * 请求选项
 */
export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: BodyInit | Record<string, unknown>
  timeout?: number
}

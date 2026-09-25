/**
 * MCP Server 与 Extension 通讯的消息类型
 */

// 请求消息
export interface RequestMessage {
  id: string
  method: string
  token?: string  // 安全验证 token
  params?: Record<string, unknown>
}

// 响应消息
export interface ResponseMessage {
  id: string
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

// 平台信息
export interface PlatformInfo {
  id: string
  name: string
  homepage: string
  isAuthenticated: boolean
  username?: string
  error?: string
  /** 是否支持直接发布 */
  canPublish?: boolean
}

// 同步结果
export interface SyncResult {
  platform: string
  platformName?: string
  success: boolean
  postUrl?: string
  /** true: 草稿；false: 已直接发布 */
  draftOnly?: boolean
  /** 额外提示，如「草稿已保存，但直接发布失败：...」 */
  message?: string
  error?: string
}

// Extension 支持的方法
export type ExtensionMethod =
  | 'listPlatforms'
  | 'checkAuth'
  | 'syncArticle'
  | 'uploadImage'

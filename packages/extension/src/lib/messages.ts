/**
 * 页面与 Background 之间的消息类型
 */

/** 按平台预处理后的内容 */
export interface PlatformContent {
  html: string
  markdown: string
}

export interface SyncArticlePayload {
  article: {
    title: string
    /** 原始 Markdown（本地图片为占位 URL，见 images） */
    markdown: string
    /** Markdown 渲染出的通用 HTML（自建站使用） */
    html: string
    summary?: string
    cover?: string
    tags?: string[]
    category?: string
    /** 各平台预处理后的内容（Markdown 平台直接使用 markdown / html，不单独提供） */
    platformContents?: Record<string, PlatformContent>
    /** 本地图片：占位 URL → data URI（只传一份，Background 按平台替换） */
    images?: Record<string, string>
  }
  platforms: string[]
  /** true: 只保存草稿；false: 直接发布 */
  draftOnly: boolean
}

export interface SyncResultItem {
  platform: string
  platformName?: string
  success: boolean
  postUrl?: string
  draftOnly?: boolean
  message?: string
  error?: string
}

export type SyncStage = 'starting' | 'uploading_images' | 'completed' | 'failed'

export interface SyncProgress {
  platform: string
  stage: SyncStage
  imageProgress?: { current: number; total: number }
  result?: SyncResultItem
}

/** 本地图片占位 URL 前缀（.invalid 域名保证不会被真实解析） */
export const LOCAL_IMAGE_PREFIX = 'https://local-image.invalid/'

/**
 * 把占位 URL 替换为 data URI
 */
export function expandLocalImages(content: string, images: Record<string, string> | undefined): string {
  if (!images || !content.includes(LOCAL_IMAGE_PREFIX)) return content
  return content.replace(/https:\/\/local-image\.invalid\/\d+/g, url => images[url] ?? url)
}

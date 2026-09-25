/**
 * 文章准备（需要 DOM：在同步页面或 Offscreen Document 中运行）
 *
 * Markdown → HTML → 按各平台预处理配置生成定制 HTML
 */
import { markdownToHtml, htmlToMarkdownNative } from '@wechatsync/core'
import { getPlatformPreprocessConfigs } from '../adapters'
import { preprocessForPlatform } from './content-processor'
import type { ArticleInput, PlatformContent, PreparedArticle } from './messages'

/**
 * @param input 文章内容（本地图片已替换为占位 URL）
 * @param platformIds 目标内置平台（自建站不需要预处理）
 */
export function prepareArticle(input: ArticleInput, platformIds: string[]): PreparedArticle {
  const html = input.markdown !== undefined ? markdownToHtml(input.markdown) : input.html || ''
  const markdown = input.markdown ?? htmlToMarkdownNative(html)

  // Markdown 平台直接使用原文，避免 HTML ↔ Markdown 往返造成格式损失；HTML 平台按配置预处理
  const platformContents: Record<string, PlatformContent> = {}
  const configs = getPlatformPreprocessConfigs(platformIds)
  for (const [platformId, config] of Object.entries(configs)) {
    if (config.outputFormat !== 'markdown') {
      platformContents[platformId] = { html: preprocessForPlatform(html, config), markdown }
    }
  }

  return {
    title: input.title,
    markdown,
    html,
    summary: input.summary,
    cover: input.cover,
    tags: input.tags,
    category: input.category,
    platformContents,
    images: input.images,
  }
}

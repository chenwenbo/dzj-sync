/**
 * Offscreen Document：为 Service Worker 提供 DOM 环境
 * MCP / CLI 发起的同步在这里完成 Markdown 渲染和按平台预处理
 */
import { prepareArticle } from '../lib/prepare-article'
import type { ArticleInput } from '../lib/messages'

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'OFFSCREEN_PREPARE_ARTICLE') return false

  const { input, platformIds } = message.payload as { input: ArticleInput; platformIds: string[] }
  try {
    sendResponse({ article: prepareArticle(input, platformIds) })
  } catch (error) {
    sendResponse({ error: (error as Error).message })
  }
  return false
})

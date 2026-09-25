/**
 * 在 Offscreen Document 中准备文章（Service Worker 没有 DOM）
 */
import type { ArticleInput, PreparedArticle } from '../lib/messages'

const OFFSCREEN_PATH = 'src/offscreen/index.html'

let creating: Promise<void> | null = null

async function ensureOffscreenDocument(): Promise<void> {
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification: '将 Markdown 渲染为 HTML 并按平台预处理',
      })
      .catch((error: Error) => {
        // 已存在时直接复用
        if (!/single offscreen document/i.test(error.message)) throw error
      })
      .finally(() => {
        creating = null
      })
  }
  await creating
}

export async function prepareArticleOffscreen(input: ArticleInput, platformIds: string[]): Promise<PreparedArticle> {
  await ensureOffscreenDocument()
  const response = await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_PREPARE_ARTICLE',
    payload: { input, platformIds },
  }) as { article?: PreparedArticle; error?: string } | undefined

  if (!response?.article) {
    throw new Error(response?.error || '文章预处理失败')
  }
  return response.article
}

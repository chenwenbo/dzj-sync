/**
 * Background Service Worker
 *
 * 只负责三件事：
 * 1. 点击扩展图标时打开 Markdown 同步页面
 * 2. 查询各平台登录状态
 * 3. 执行同步（保存草稿 / 直接发布），并把进度推送给页面
 */
import type { Article, SyncResult } from '@wechatsync/core'
import { checkAllPlatformsAuth, getAllPlatformMetas, syncToPlatform } from '../adapters'
import * as wordpressAdapter from '../adapters/cms/wordpress'
import * as metaweblogAdapter from '../adapters/cms/metaweblog'
import { getCmsAccounts, getCmsPassword, type CMSAccount } from '../lib/cms-accounts'
import { expandLocalImages, type SyncArticlePayload, type SyncProgress, type SyncResultItem } from '../lib/messages'
import { createLogger } from '../lib/logger'

const logger = createLogger('Background')

const APP_PATH = 'src/app/index.html'
const CONCURRENCY_LIMIT = 3

let abortController: AbortController | null = null

// ============ 打开同步页面 ============

chrome.action.onClicked.addListener(async () => {
  const appUrl = chrome.runtime.getURL(APP_PATH)
  const [existing] = await chrome.tabs.query({ url: appUrl })
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true })
    if (existing.windowId) await chrome.windows.update(existing.windowId, { focused: true })
  } else {
    await chrome.tabs.create({ url: appUrl })
  }
})

// 启动时清理上次残留的请求头规则
async function clearOrphanedRules() {
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules()
    if (rules.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map(r => r.id) })
    }
  } catch (error) {
    logger.warn('Failed to clear dynamic rules:', error)
  }
}
chrome.runtime.onInstalled.addListener(clearOrphanedRules)
chrome.runtime.onStartup.addListener(clearOrphanedRules)

// ============ 消息处理 ============

type Message =
  | { type: 'GET_PLATFORMS' }
  | { type: 'SYNC_ARTICLE'; payload: SyncArticlePayload }
  | { type: 'CANCEL_SYNC' }

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(error => sendResponse({ error: (error as Error).message }))
  return true
})

async function handleMessage(message: Message) {
  switch (message.type) {
    case 'GET_PLATFORMS': {
      const platforms = await checkAllPlatformsAuth()
      const cmsAccounts = await getCmsAccounts()
      return { platforms, cmsAccounts }
    }

    case 'SYNC_ARTICLE':
      return { results: await syncArticle(message.payload) }

    case 'CANCEL_SYNC': {
      abortController?.abort()
      return { cancelled: !!abortController }
    }

    default:
      return { error: 'Unknown message' }
  }
}

// ============ 同步 ============

function sendProgress(progress: SyncProgress) {
  chrome.runtime.sendMessage({ type: 'SYNC_PROGRESS', payload: progress }).catch(() => {})
}

async function syncArticle(payload: SyncArticlePayload): Promise<SyncResultItem[]> {
  const { article, platforms, draftOnly } = payload
  abortController = new AbortController()
  const signal = abortController.signal

  const metas = getAllPlatformMetas()
  const cmsAccounts = await getCmsAccounts()

  const tasks = platforms.map(id => {
    const cms = cmsAccounts.find(a => a.id === id)
    const name = cms?.name || metas.find(m => m.id === id)?.name || id
    return { id, name, run: () => (cms ? syncToCms(cms, article, draftOnly) : syncToDsl(id, name, article, draftOnly)) }
  })

  const results: SyncResultItem[] = []

  for (let i = 0; i < tasks.length; i += CONCURRENCY_LIMIT) {
    const batch = tasks.slice(i, i + CONCURRENCY_LIMIT)
    const batchResults = await Promise.all(batch.map(async task => {
      let result: SyncResultItem
      if (signal.aborted) {
        result = { platform: task.id, platformName: task.name, success: false, error: '已取消' }
      } else {
        sendProgress({ platform: task.id, stage: 'starting' })
        try {
          result = { ...(await task.run()), platformName: task.name }
        } catch (error) {
          result = { platform: task.id, platformName: task.name, success: false, error: (error as Error).message }
        }
      }
      sendProgress({ platform: task.id, stage: result.success ? 'completed' : 'failed', result })
      return result
    }))
    results.push(...batchResults)
  }

  abortController = null
  return results
}

/**
 * 同步到内置平台
 */
async function syncToDsl(
  platformId: string,
  platformName: string,
  article: SyncArticlePayload['article'],
  draftOnly: boolean
): Promise<SyncResultItem> {
  const content = article.platformContents?.[platformId]
  const platformArticle: Article = {
    title: article.title,
    markdown: expandLocalImages(content?.markdown ?? article.markdown, article.images),
    html: expandLocalImages(content?.html ?? article.html, article.images),
    summary: article.summary,
    cover: article.cover && expandLocalImages(article.cover, article.images),
    tags: article.tags,
    category: article.category,
  }

  const result: SyncResult = await syncToPlatform(platformId, platformArticle, {
    draftOnly,
    onImageProgress: (current, total) =>
      sendProgress({ platform: platformId, stage: 'uploading_images', imageProgress: { current, total } }),
  })

  return {
    platform: platformId,
    platformName,
    success: result.success,
    postUrl: result.postUrl,
    draftOnly: result.draftOnly ?? true,
    message: result.message,
    error: result.error,
  }
}

/**
 * 同步到自建站（WordPress / Typecho / MetaWeblog）
 */
async function syncToCms(
  account: CMSAccount,
  article: SyncArticlePayload['article'],
  draftOnly: boolean
): Promise<SyncResultItem> {
  const password = await getCmsPassword(account.id)
  if (!password) {
    return { platform: account.id, platformName: account.name, success: false, error: '密码未找到，请重新添加账户' }
  }

  const credentials = { url: account.url, username: account.username, password }
  const cmsArticle = { title: article.title, content: expandLocalImages(article.html, article.images) }
  const options = {
    draftOnly,
    onImageProgress: (current: number, total: number) =>
      sendProgress({ platform: account.id, stage: 'uploading_images', imageProgress: { current, total } }),
  }

  let result: { success: boolean; postUrl?: string; message?: string; error?: string }
  switch (account.type) {
    case 'wordpress':
      result = await wordpressAdapter.publish(credentials, cmsArticle, options)
      break
    case 'typecho':
      result = await metaweblogAdapter.publishToTypecho(credentials, cmsArticle, options)
      break
    case 'metaweblog':
      result = await metaweblogAdapter.publish(credentials, cmsArticle, options)
      break
    default:
      result = { success: false, error: '不支持的站点类型' }
  }

  return {
    platform: account.id,
    platformName: account.name,
    success: result.success,
    postUrl: result.postUrl,
    draftOnly,
    message: result.message,
    error: result.error,
  }
}

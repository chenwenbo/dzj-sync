/**
 * Background Service Worker
 *
 * 1. 点击扩展图标时打开 Markdown 同步页面
 * 2. 查询各平台登录状态
 * 3. 执行同步（保存草稿 / 直接发布），并把进度推送给页面
 * 4. 维护与 MCP Server / CLI 的连接（AI 工具调用）
 */
import { checkAllPlatformsAuth } from '../adapters'
import { getCmsAccounts } from '../lib/cms-accounts'
import type { SyncArticlePayload } from '../lib/messages'
import { createLogger } from '../lib/logger'
import { cancelSync, syncArticle } from './sync'
import { mcpClient, startMcpClient, stopMcpClient, getMcpStatus } from '../mcp/client'

const logger = createLogger('Background')

const APP_PATH = 'src/app/index.html'

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

// ============ MCP 连接（CLI / Claude 等 AI 工具） ============

const MCP_KEEPALIVE_ALARM = 'mcp_keepalive'

async function getMcpSettings() {
  const storage = await chrome.storage.local.get(['mcpEnabled', 'mcpToken', 'mcpServerUrl'])
  return {
    enabled: (storage.mcpEnabled as boolean | undefined) ?? false,
    token: storage.mcpToken as string | undefined,
    serverUrl: (storage.mcpServerUrl as string | undefined) || '',
  }
}

/**
 * 启用时连接 MCP Server（Service Worker 每次启动都会调用）
 */
async function initMcpIfEnabled() {
  const settings = await getMcpSettings()
  if (!settings.enabled) return

  let token = settings.token
  if (!token) {
    token = crypto.randomUUID()
    await chrome.storage.local.set({ mcpToken: token })
  }
  mcpClient.setToken(token)
  if (settings.serverUrl) mcpClient.setServerUrl(settings.serverUrl)
  if (!mcpClient.isConnected()) startMcpClient()
  // Service Worker 空闲时会被回收，用定时器保活并在断开后重连
  chrome.alarms.create(MCP_KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === MCP_KEEPALIVE_ALARM) initMcpIfEnabled().catch(() => {})
})

initMcpIfEnabled().catch(error => logger.warn('MCP init failed:', error))

// ============ 消息处理 ============

type Message =
  | { type: 'GET_PLATFORMS' }
  | { type: 'SYNC_ARTICLE'; payload: SyncArticlePayload }
  | { type: 'CANCEL_SYNC' }
  | { type: 'MCP_STATUS' }
  | { type: 'MCP_ENABLE' }
  | { type: 'MCP_DISABLE' }
  | { type: 'MCP_SET_SERVER_URL'; payload: { url: string } }
  | { type: 'MCP_WATCH'; payload: { active: boolean } }

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

    case 'CANCEL_SYNC':
      return { cancelled: cancelSync() }

    case 'MCP_STATUS': {
      const settings = await getMcpSettings()
      return { ...settings, connected: getMcpStatus().connected }
    }

    case 'MCP_ENABLE': {
      await chrome.storage.local.set({ mcpEnabled: true })
      await initMcpIfEnabled()
      mcpClient.resetReconnect()
      return { success: true, token: (await getMcpSettings()).token }
    }

    case 'MCP_DISABLE': {
      // 只断开连接，保留 token，下次启用时复用
      await chrome.storage.local.set({ mcpEnabled: false })
      await chrome.alarms.clear(MCP_KEEPALIVE_ALARM)
      mcpClient.clearToken()
      stopMcpClient()
      return { success: true }
    }

    case 'MCP_SET_SERVER_URL': {
      await chrome.storage.local.set({ mcpServerUrl: message.payload.url || '' })
      mcpClient.setServerUrl(message.payload.url)
      mcpClient.disconnect()
      if ((await getMcpSettings()).enabled) mcpClient.resetReconnect()
      return { success: true }
    }

    case 'MCP_WATCH':
      // 设置面板打开时加快重连
      if ((await getMcpSettings()).enabled) mcpClient.setActivelyWatched(message.payload.active)
      return { success: true }

    default:
      return { error: 'Unknown message' }
  }
}

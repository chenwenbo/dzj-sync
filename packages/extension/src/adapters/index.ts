/**
 * 适配器系统初始化
 */
import {
  adapterRegistry,
  type PlatformAdapter,
  type PlatformMeta,
  type Article,
  type SyncResult,
  DoubanAdapter,
  XueqiuAdapter,
  SohuAdapter,
  WoshipmAdapter,
  ZhihuAdapter,
  JuejinAdapter,
  CSDNAdapter,
  WeiboAdapter,
  BilibiliAdapter,
  BaijiahaoAdapter,
  YuqueAdapter,
  WeixinAdapter,
  Cto51Adapter,
  ImoocAdapter,
  OschinaAdapter,
  SegmentfaultAdapter,
  CnblogsAdapter,
  EastmoneyAdapter,
} from '@wechatsync/core'
import { createExtensionRuntime } from '../runtime/extension'
import { createLogger } from '../lib/logger'

const logger = createLogger('Adapters')

type AdapterConstructor = new () => PlatformAdapter

// 支持直接发布的平台排在前面
const ADAPTER_CLASSES: AdapterConstructor[] = [
  JuejinAdapter,
  CSDNAdapter,
  ZhihuAdapter,
  CnblogsAdapter,
  YuqueAdapter,
  WeixinAdapter,
  WeiboAdapter,
  BilibiliAdapter,
  BaijiahaoAdapter,
  DoubanAdapter,
  XueqiuAdapter,
  SegmentfaultAdapter,
  OschinaAdapter,
  Cto51Adapter,
  // 仅草稿
  SohuAdapter,
  WoshipmAdapter,
  ImoocAdapter,
  EastmoneyAdapter,
]

const runtime = createExtensionRuntime()
let initialized = false

/**
 * 初始化适配器系统
 */
export function initAdapters(): void {
  if (initialized) return

  adapterRegistry.setRuntime(runtime)
  for (const AdapterClass of ADAPTER_CLASSES) {
    try {
      const instance = new AdapterClass()
      adapterRegistry.register({
        meta: instance.meta,
        factory: () => new AdapterClass(),
        preprocessConfig: instance.preprocessConfig,
      })
    } catch (error) {
      logger.error('Failed to register adapter:', error)
    }
  }

  initialized = true
}

/**
 * 获取适配器
 */
export async function getAdapter(platformId: string): Promise<PlatformAdapter | null> {
  initAdapters()
  return adapterRegistry.get(platformId)
}

/**
 * 获取所有平台元信息
 */
export function getAllPlatformMetas(): PlatformMeta[] {
  initAdapters()
  return adapterRegistry.getAllMeta()
}

/**
 * 获取多个平台的预处理配置
 */
export function getPlatformPreprocessConfigs(platformIds: string[]) {
  initAdapters()
  return adapterRegistry.getPreprocessConfigs(platformIds)
}

const AUTH_CHECK_CONCURRENCY = 6
const AUTH_CHECK_TIMEOUT = 10 * 1000
const PUBLISH_TIMEOUT = 10 * 60 * 1000 // 单个平台发布超时（包含图片上传）

function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorMessage)), ms)
    promise
      .then(result => resolve(result))
      .catch(error => reject(error))
      .finally(() => clearTimeout(timer))
  })
}

export type PlatformStatus = PlatformMeta & {
  isAuthenticated: boolean
  username?: string
  error?: string
}

/**
 * 检查所有平台登录状态（分批并行）
 */
export async function checkAllPlatformsAuth(): Promise<PlatformStatus[]> {
  const metas = getAllPlatformMetas()
  const results: PlatformStatus[] = []

  for (let i = 0; i < metas.length; i += AUTH_CHECK_CONCURRENCY) {
    const batch = metas.slice(i, i + AUTH_CHECK_CONCURRENCY)
    results.push(...await Promise.all(batch.map(async (meta) => {
      try {
        const adapter = await getAdapter(meta.id)
        if (!adapter) return { ...meta, isAuthenticated: false, error: 'Adapter not found' }
        const auth = await withTimeout(adapter.checkAuth(), AUTH_CHECK_TIMEOUT, '登录检查超时')
        return { ...meta, isAuthenticated: auth.isAuthenticated, username: auth.username, error: auth.error }
      } catch (error) {
        return { ...meta, isAuthenticated: false, error: (error as Error).message }
      }
    })))
  }

  return results
}

/**
 * 检查单个平台登录状态
 */
export async function checkPlatformAuth(platformId: string) {
  const adapter = await getAdapter(platformId)
  if (!adapter) return { isAuthenticated: false, error: 'Platform not found' }
  try {
    return await withTimeout(adapter.checkAuth(), AUTH_CHECK_TIMEOUT, '登录检查超时')
  } catch (error) {
    return { isAuthenticated: false, error: (error as Error).message }
  }
}

/**
 * 同步到单个平台
 */
export async function syncToPlatform(
  platformId: string,
  article: Article,
  options: { draftOnly: boolean; onImageProgress?: (current: number, total: number) => void }
): Promise<SyncResult> {
  const adapter = await getAdapter(platformId)
  if (!adapter) {
    return { platform: platformId, success: false, error: 'Platform not found', timestamp: Date.now() }
  }

  try {
    const result = await withTimeout(
      adapter.publish(article, {
        draftOnly: options.draftOnly,
        onImageProgress: options.onImageProgress,
      }),
      PUBLISH_TIMEOUT,
      `发布超时（${PUBLISH_TIMEOUT / 60000}分钟）`
    )

    // 平台不支持直接发布时明确提示
    if (!options.draftOnly && result.success && !adapter.meta.capabilities.includes('publish')) {
      return { ...result, draftOnly: true, message: result.message || '该平台暂不支持直接发布，已保存为草稿' }
    }
    return result
  } catch (error) {
    return { platform: platformId, success: false, error: (error as Error).message, timestamp: Date.now() }
  }
}

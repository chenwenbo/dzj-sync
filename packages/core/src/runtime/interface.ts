import type { Cookie, HeaderRule } from '../types'

/**
 * 运行时接口抽象
 * 适配器通过它发起请求、读取 Cookie、设置请求头规则
 */
export interface RuntimeInterface {
  /** 运行时类型标识 */
  readonly type: 'extension' | 'node'

  /**
   * HTTP 请求
   * 在扩展环境自动携带 cookies，Node 环境需手动管理
   */
  fetch(url: string, options?: RequestInit): Promise<Response>

  /**
   * Cookie 管理
   */
  cookies: {
    get(domain: string): Promise<Cookie[]>
    set(cookie: Cookie): Promise<void>
    remove(name: string, domain: string): Promise<void>
  }

  /**
   * 获取单个 Cookie 值（便捷方法）
   * @param domain Cookie 域名
   * @param name Cookie 名称
   * @returns Cookie 值，不存在返回 null
   */
  getCookie?(domain: string, name: string): Promise<string | null>

  /**
   * 持久化存储
   */
  storage: {
    get<T>(key: string): Promise<T | null>
    set<T>(key: string, value: T): Promise<void>
    remove(key: string): Promise<void>
  }

  /**
   * Header 规则管理 (用于请求拦截)
   * 仅扩展环境支持
   */
  headerRules?: {
    add(rule: HeaderRule): Promise<string>
    remove(ruleId: string): Promise<void>
    clear(): Promise<void>
  }
}

/**
 * 创建运行时的工厂函数类型
 */
export type RuntimeFactory = (config?: RuntimeConfig) => RuntimeInterface

/**
 * 运行时配置
 */
export interface RuntimeConfig {
  /** Node 环境：预加载的 cookies */
  cookies?: Record<string, Cookie[]>
  /** 请求超时时间 (ms) */
  timeout?: number
  /** 用户代理 */
  userAgent?: string
}

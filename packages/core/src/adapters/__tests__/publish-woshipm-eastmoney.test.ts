/**
 * 人人都是产品经理 / 东方财富财富号：直接发布能力测试（使用模拟的 runtime.fetch，不访问真实平台）
 *
 * 这两个平台目前没有找到可靠的公开「提交发布 / 提交审核」接口格式，
 * 因此只支持保存草稿。这里锁定：
 * - 不声明 publish 能力（前端会提示「仅支持草稿」）
 * - 默认和 draftOnly: false 时都只保存草稿，不发出任何额外的发布请求
 */
import { describe, it, expect } from 'vitest'
import type { RuntimeInterface } from '../../runtime/interface'
import type { PlatformAdapter } from '../types'
import { WoshipmAdapter, EastmoneyAdapter } from '../platforms'
import type { Article } from '../../types'
import { setLoggerConfig } from '../../lib/logger'

setLoggerConfig({ enabled: false })

type Route = (url: string, init: RequestInit) => Response | undefined

interface Call {
  method: string
  url: string
  body?: any
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function createRuntime(route: Route, cookies: Record<string, string> = {}) {
  const calls: Call[] = []
  const runtime: RuntimeInterface = {
    type: 'extension',
    async fetch(url, init = {}) {
      let body: any = init.body
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body)
        } catch {
          // 保留原始字符串
        }
      } else if (body instanceof URLSearchParams) {
        body = Object.fromEntries(body.entries())
      }
      calls.push({ method: (init.method || 'GET').toUpperCase(), url, body })
      const res = route(url, init)
      if (!res) throw new Error(`Unexpected request: ${init.method || 'GET'} ${url}`)
      return res
    },
    cookies: { get: async () => [], set: async () => {}, remove: async () => {} },
    getCookie: async (_domain, name) => cookies[name] ?? null,
    storage: { get: async () => null, set: async () => {}, remove: async () => {} },
  }
  return { runtime, calls }
}

async function setup<T extends PlatformAdapter>(adapter: T, route: Route, cookies?: Record<string, string>) {
  const { runtime, calls } = createRuntime(route, cookies)
  await adapter.init(runtime)
  return { adapter, calls }
}

const article: Article = {
  title: '测试文章',
  markdown: '# 小节\n\n正文',
  html: '<h1>小节</h1><p>正文</p>',
  tags: ['产品'],
  category: '产品设计',
}

// ============ 人人都是产品经理 ============

const woshipmRoute: Route = (url) => {
  if (url === 'https://www.woshipm.com/wp-admin/admin-ajax.php') {
    return json({ post_id: 12345, url: 'https://www.woshipm.com/writing?pid=12345' })
  }
  return undefined
}

describe('人人都是产品经理 直接发布', () => {
  it('未声明 publish 能力（未找到可靠的发布接口）', () => {
    expect(new WoshipmAdapter().meta.capabilities).not.toContain('publish')
  })

  it('默认只保存草稿', async () => {
    const { adapter, calls } = await setup(new WoshipmAdapter(), woshipmRoute)
    const result = await adapter.publish(article)

    expect(result).toMatchObject({
      success: true,
      postId: '12345',
      postUrl: 'https://www.woshipm.com/writing?pid=12345',
      draftOnly: true,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toMatchObject({ action: 'add_draft', post_title: '测试文章' })
    expect(calls[0].body.post_content).toContain('<p>正文</p>')
  })

  it('draftOnly: false 时仍只保存草稿，不发出发布请求', async () => {
    const { adapter, calls } = await setup(new WoshipmAdapter(), woshipmRoute)
    const result = await adapter.publish(article, { draftOnly: false })

    expect(result.success).toBe(true)
    expect(result.draftOnly).toBe(true)
    expect(result.postUrl).toBe('https://www.woshipm.com/writing?pid=12345')
    expect(calls).toHaveLength(1)
    expect(calls.every(c => c.body?.action === 'add_draft')).toBe(true)
  })

  it('草稿保存失败时返回错误', async () => {
    const { adapter } = await setup(new WoshipmAdapter(), (url) =>
      url.includes('admin-ajax.php') ? json({ error: '请先登录' }) : undefined
    )
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result.success).toBe(false)
    expect(result.error).toContain('请先登录')
  })
})

// ============ 东方财富财富号 ============

const EM_COOKIES = { ct: 'ctoken-1', ut: 'utoken-1' }

function eastmoneyDraftResponse(draftId: string): Response {
  return json({
    RRquestSuccess: true,
    RCode: 200,
    RData: JSON.stringify({ error_code: 0, draft_id: draftId }),
  })
}

const eastmoneyRoute: Route = (url) => {
  if (url.startsWith('https://emfront.eastmoney.com/apifront/Tran/GetData')) {
    return eastmoneyDraftResponse('D-888')
  }
  return undefined
}

describe('东方财富 直接发布', () => {
  it('未声明 publish 能力（未找到可靠的发布接口）', () => {
    expect(new EastmoneyAdapter().meta.capabilities).not.toContain('publish')
  })

  it('默认只保存草稿（创建 + 更新两次 SaveDraft）', async () => {
    const { adapter, calls } = await setup(new EastmoneyAdapter(), eastmoneyRoute, EM_COOKIES)
    const result = await adapter.publish(article)

    expect(result).toMatchObject({
      success: true,
      postId: 'D-888',
      postUrl: 'https://mp.eastmoney.com/collect/pc_article/index.html#/?id=D-888',
      draftOnly: true,
    })
    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.body.path)).toEqual([
      'draft/api/Article/SaveDraft',
      'draft/api/Article/SaveDraft',
    ])
    const parm = JSON.parse(calls[1].body.parm) as Array<Record<string, string>>
    const merged = Object.assign({}, ...parm)
    expect(merged).toMatchObject({ draftid: 'D-888', ctoken: 'ctoken-1', utoken: 'utoken-1' })
    expect(decodeURIComponent(merged.text)).toContain('<p>正文</p>')
  })

  it('draftOnly: false 时仍只保存草稿，不发出发布请求', async () => {
    const { adapter, calls } = await setup(new EastmoneyAdapter(), eastmoneyRoute, EM_COOKIES)
    const result = await adapter.publish(article, { draftOnly: false })

    expect(result.success).toBe(true)
    expect(result.draftOnly).toBe(true)
    expect(result.postUrl).toBe('https://mp.eastmoney.com/collect/pc_article/index.html#/?id=D-888')
    expect(calls).toHaveLength(2)
    expect(calls.every(c => c.body.path === 'draft/api/Article/SaveDraft')).toBe(true)
  })

  it('草稿业务错误时返回失败', async () => {
    const { adapter } = await setup(
      new EastmoneyAdapter(),
      (url) =>
        url.includes('Tran/GetData')
          ? json({ RRquestSuccess: true, RCode: 200, RData: JSON.stringify({ error_code: 1, me: '标题过长' }) })
          : undefined,
      EM_COOKIES
    )
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result.success).toBe(false)
    expect(result.error).toContain('标题过长')
  })
})

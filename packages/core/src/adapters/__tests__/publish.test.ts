/**
 * 直接发布流程测试（使用模拟的 runtime.fetch，不访问真实平台）
 */
import { describe, it, expect } from 'vitest'
import type { RuntimeInterface } from '../../runtime/interface'
import type { PlatformAdapter } from '../types'
import { JuejinAdapter, CSDNAdapter, ZhihuAdapter, CnblogsAdapter, YuqueAdapter } from '../platforms'
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
  markdown: '# 小节\n\n这是一段足够长的正文内容，用来生成摘要。'.repeat(3),
  html: '<h1>小节</h1><p>正文</p>',
  tags: ['JavaScript'],
  category: '前端',
}

// ============ 掘金 ============

function juejinRoute(extra?: Route): Route {
  return (url, init) => {
    const custom = extra?.(url, init)
    if (custom) return custom
    if (url.includes('/user_api/v1/sys/token')) {
      return new Response(null, { headers: { 'x-ware-csrf-token': '0,csrf123,86370000,success,sid' } })
    }
    if (url.includes('query_category_briefs')) {
      return json({ data: [{ category_id: 'c-backend', category_name: '后端' }, { category_id: 'c-fe', category_name: '前端' }] })
    }
    if (url.includes('query_tag_list')) {
      return json({ data: [{ tag_id: 't-js', tag: { tag_name: 'JavaScript' } }] })
    }
    if (url.includes('article_draft/create')) return json({ err_no: 0, data: { id: 'd1' } })
    if (url.includes('content_api/v1/article/publish')) return json({ err_no: 0, data: { article_id: 'a1' } })
    return undefined
  }
}

describe('Juejin', () => {
  it('saves draft only by default', async () => {
    const { adapter, calls } = await setup(new JuejinAdapter(), juejinRoute())
    const result = await adapter.publish(article)
    expect(result).toMatchObject({ success: true, draftOnly: true, postUrl: 'https://juejin.cn/editor/drafts/d1' })
    expect(calls.some(c => c.url.includes('article/publish'))).toBe(false)
  })

  it('publishes with category, tags and brief', async () => {
    const { adapter, calls } = await setup(new JuejinAdapter(), juejinRoute())
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: false, postUrl: 'https://juejin.cn/post/a1' })

    const create = calls.find(c => c.url.includes('article_draft/create'))!
    expect(create.body.category_id).toBe('c-fe')
    expect(create.body.tag_ids).toEqual(['t-js'])
    expect(Array.from(create.body.brief_content as string).length).toBeGreaterThanOrEqual(50)

    const publish = calls.find(c => c.url.includes('article/publish'))!
    expect(publish.body.draft_id).toBe('d1')
  })

  it('keeps the draft when tags are missing', async () => {
    const { adapter, calls } = await setup(new JuejinAdapter(), juejinRoute())
    const result = await adapter.publish({ ...article, tags: [] }, { draftOnly: false })
    expect(result.success).toBe(true)
    expect(result.draftOnly).toBe(true)
    expect(result.message).toContain('标签')
    expect(calls.some(c => c.url.includes('article/publish'))).toBe(false)
  })

  it('keeps the draft when publish API fails', async () => {
    const { adapter } = await setup(
      new JuejinAdapter(),
      juejinRoute(url => (url.includes('article/publish') ? json({ err_no: 1, err_msg: '内容审核中' }) : undefined))
    )
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: true, postUrl: 'https://juejin.cn/editor/drafts/d1' })
    expect(result.message).toContain('内容审核中')
  })
})

// ============ CSDN ============

describe('CSDN', () => {
  const route: Route = (url) => {
    if (url.includes('getBaseInfo')) return json({ code: 200, data: { name: 'user1', nickname: 'U', avatar: '' } })
    if (url.includes('saveArticle')) return json({ code: 200, data: { id: 42 } })
    return undefined
  }

  it('saves draft, then saves again with publish status', async () => {
    const { adapter, calls } = await setup(new CSDNAdapter(), route)
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({
      success: true,
      draftOnly: false,
      postUrl: 'https://blog.csdn.net/user1/article/details/42',
    })

    const saves = calls.filter(c => c.url.includes('saveArticle'))
    expect(saves).toHaveLength(2)
    expect(saves[0].body).toMatchObject({ status: 2, pubStatus: 'draft' })
    expect(saves[1].body).toMatchObject({ id: '42', status: 0, pubStatus: 'publish', tags: 'JavaScript' })
  })

  it('only saves once in draft mode', async () => {
    const { adapter, calls } = await setup(new CSDNAdapter(), route)
    const result = await adapter.publish(article, { draftOnly: true })
    expect(result).toMatchObject({ success: true, draftOnly: true, postUrl: 'https://editor.csdn.net/md?articleId=42' })
    expect(calls.filter(c => c.url.includes('saveArticle'))).toHaveLength(1)
  })
})

// ============ 知乎 ============

describe('Zhihu', () => {
  it('falls back to the legacy publish endpoint', async () => {
    const { adapter, calls } = await setup(new ZhihuAdapter(), (url, init) => {
      if (url.endsWith('/api/articles/drafts')) return json({ id: '123' })
      if (url.endsWith('/api/articles/123/draft')) return new Response(null, { status: 204 })
      if (url.includes('/api/v4/content/publish')) return json({ error: { message: 'bad' } }, { status: 400 })
      if (url.endsWith('/api/articles/123/publish') && init.method === 'PUT') return json({})
      return undefined
    })
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: false, postUrl: 'https://zhuanlan.zhihu.com/p/123' })
    expect(calls.map(c => c.method + ' ' + c.url).filter(c => c.includes('publish'))).toHaveLength(2)
  })
})

// ============ 博客园 ============

describe('Cnblogs', () => {
  it('creates a draft post and then publishes it', async () => {
    const { adapter, calls } = await setup(
      new CnblogsAdapter(),
      (url, init) => {
        if (url === 'https://i.cnblogs.com/posts/edit') return new Response('ok')
        if (url === 'https://i.cnblogs.com/api/posts') {
          const body = JSON.parse(init.body as string)
          return json(body.isPublished ? { id: 7, url: '//www.cnblogs.com/me/p/7' } : { id: 7, blogId: 99 })
        }
        return undefined
      },
      { 'XSRF-TOKEN': 'xsrf' }
    )
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: false, postUrl: 'https://www.cnblogs.com/me/p/7' })

    const saves = calls.filter(c => c.url === 'https://i.cnblogs.com/api/posts')
    expect(saves[0].body).toMatchObject({ postType: 1, isPublished: false, isDraft: true })
    expect(saves[1].body).toMatchObject({ id: 7, blogId: 99, isPublished: true, isDraft: false, tags: ['JavaScript'] })
  })
})

// ============ 语雀 ============

describe('Yuque', () => {
  it('keeps the draft when publishing is rejected', async () => {
    const { adapter } = await setup(
      new YuqueAdapter(),
      (url) => {
        if (url.includes('/api/mine/common_used')) {
          return json({ data: { books: [{ target_id: 1, user: { id: 1, name: 'u', avatar_url: '' } }] } })
        }
        if (url === 'https://www.yuque.com/api/docs') return json({ data: { id: 5 } })
        if (url.includes('/api/docs/convert')) return json({ data: { content: '<p>x</p>' } })
        if (url.includes('/api/docs/5/content')) return json({ data: {} })
        if (url.includes('/api/docs/5/publish')) return json({ message: '无权限' }, { status: 403 })
        return undefined
      },
      { yuque_ctoken: 'ctoken' }
    )
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: true, postUrl: 'https://www.yuque.com/go/doc/5/edit' })
    expect(result.message).toContain('无权限')
  })
})

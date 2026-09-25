/**
 * 思否 / 开源中国 / 51CTO / 慕课手记 直接发布流程测试（模拟 runtime.fetch，不访问真实平台）
 */
import { describe, it, expect } from 'vitest'
import type { RuntimeInterface } from '../../runtime/interface'
import type { PlatformAdapter } from '../types'
import { SegmentfaultAdapter } from '../platforms/segmentfault'
import { OschinaAdapter } from '../platforms/oschina'
import { Cto51Adapter } from '../platforms/cto51'
import { ImoocAdapter } from '../platforms/imooc'
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

function createRuntime(route: Route) {
  const calls: Call[] = []
  const runtime: RuntimeInterface = {
    type: 'extension',
    async fetch(url, init = {}) {
      let body: any = init.body
      if (typeof body === 'string') {
        try {
          body = JSON.parse(body)
        } catch {
          // 表单等非 JSON 字符串保持原样
        }
      }
      calls.push({ method: (init.method || 'GET').toUpperCase(), url, body })
      const res = route(url, init)
      if (!res) throw new Error(`Unexpected request: ${init.method || 'GET'} ${url}`)
      return res
    },
    cookies: { get: async () => [], set: async () => {}, remove: async () => {} },
    getCookie: async () => null,
    storage: { get: async () => null, set: async () => {}, remove: async () => {} },
  }
  return { runtime, calls }
}

async function setup<T extends PlatformAdapter>(adapter: T, route: Route) {
  const { runtime, calls } = createRuntime(route)
  await adapter.init(runtime)
  return { adapter, calls }
}

/** 按 method + URL 片段组合路由，extra 优先 */
function withOverride(base: Route, extra?: Route): Route {
  return (url, init) => extra?.(url, init) ?? base(url, init)
}

const isPost = (init: RequestInit) => (init.method || 'GET').toUpperCase() === 'POST'

const article: Article = {
  title: '测试文章',
  markdown: '# 小节\n\n这是一段足够长的正文内容，用来生成摘要。'.repeat(3),
  html: '<h1>小节</h1><p>正文</p>',
  tags: ['JavaScript'],
  category: '前端',
}

// ============ 思否 ============

const sfBase: Route = (url, init) => {
  if (url === 'https://segmentfault.com/write') {
    return new Response('<script>{"serverData":{"Token":"tok123"}}</script>')
  }
  if (url === 'https://segmentfault.com/gateway/draft' && isPost(init)) return json({ id: 'd1' })
  if (url.startsWith('https://segmentfault.com/gateway/tags?')) {
    return json({ rows: [{ id: '100', name: 'javascript-tools' }, { id: '200', name: 'javascript' }] })
  }
  if (url === 'https://segmentfault.com/gateway/article' && isPost(init)) return json({ id: 'a1' }, { status: 201 })
  return undefined
}

describe('Segmentfault', () => {
  it('declares publish capability', () => {
    expect(new SegmentfaultAdapter().meta.capabilities).toContain('publish')
  })

  it('saves draft only by default', async () => {
    const { adapter, calls } = await setup(new SegmentfaultAdapter(), sfBase)
    const result = await adapter.publish(article)
    expect(result).toMatchObject({
      success: true,
      draftOnly: true,
      postId: 'd1',
      postUrl: 'https://segmentfault.com/write?draftId=d1',
    })
    expect(calls.some(c => c.url.includes('/gateway/article'))).toBe(false)
    expect(calls.some(c => c.url.includes('/gateway/tags'))).toBe(false)
    const draft = calls.find(c => c.url.endsWith('/gateway/draft'))!
    expect(draft.body).toMatchObject({ title: '测试文章', tags: [], type: 'article' })
  })

  it('publishes the draft with resolved tag ids', async () => {
    const { adapter, calls } = await setup(new SegmentfaultAdapter(), sfBase)
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({
      success: true,
      draftOnly: false,
      postId: 'a1',
      postUrl: 'https://segmentfault.com/a/a1',
    })

    const tagSearch = calls.find(c => c.url.includes('/gateway/tags'))!
    expect(tagSearch.url).toBe('https://segmentfault.com/gateway/tags?query=search&q=JavaScript')

    const publish = calls.find(c => c.url.endsWith('/gateway/article'))!
    expect(publish.method).toBe('POST')
    expect(publish.body).toMatchObject({
      tags: ['200'], // 名称完全一致的标签优先
      title: '测试文章',
      text: article.markdown,
      draft_id: 'd1',
      blog_id: '0',
      type: 1,
      license: 1,
    })
  })

  it('accepts the { data: { id } } response shape', async () => {
    const { adapter } = await setup(
      new SegmentfaultAdapter(),
      withOverride(sfBase, (url, init) =>
        url.endsWith('/gateway/article') && isPost(init) ? json({ data: { id: 'a2' } }, { status: 201 }) : undefined
      )
    )
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: false, postUrl: 'https://segmentfault.com/a/a2' })
  })

  it('keeps the draft when tags are missing', async () => {
    const { adapter, calls } = await setup(new SegmentfaultAdapter(), sfBase)
    const result = await adapter.publish({ ...article, tags: [] }, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: true, postUrl: 'https://segmentfault.com/write?draftId=d1' })
    expect(result.message).toContain('tags')
    expect(calls.some(c => c.url.endsWith('/gateway/article'))).toBe(false)
  })

  it('keeps the draft when the publish API fails', async () => {
    const { adapter } = await setup(
      new SegmentfaultAdapter(),
      withOverride(sfBase, (url, init) =>
        url.endsWith('/gateway/article') && isPost(init) ? json({ message: '标题过短' }, { status: 422 }) : undefined
      )
    )
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: true, postUrl: 'https://segmentfault.com/write?draftId=d1' })
    expect(result.message).toContain('标题过短')
  })
})

// ============ 开源中国 ============

const oscBase: Route = (url, init) => {
  if (url.endsWith('/oschinapi/user/myDetails')) {
    return json({ success: true, result: { userId: 5, userVo: { name: 'me', portraitUrl: '' } } })
  }
  if (url.endsWith('/oschinapi/api/draft/save_draft') && isPost(init)) return json({ success: true, result: { id: 9 } })
  if (url.endsWith('/oschinapi/blog_catalog/list_by_user')) {
    return json({
      success: true,
      result: [
        { id: 1, name: '前端', blogCount: 0 },
        { id: 2, name: '工作日志', blogCount: 10 },
      ],
    })
  }
  if (url.endsWith('/oschinapi/blog/web/add') && isPost(init)) return json({ success: true, code: 200, result: 77 })
  return undefined
}

describe('Oschina', () => {
  it('declares publish capability', () => {
    expect(new OschinaAdapter().meta.capabilities).toContain('publish')
  })

  it('saves draft only by default', async () => {
    const { adapter, calls } = await setup(new OschinaAdapter(), oscBase)
    const result = await adapter.publish(article)
    expect(result).toMatchObject({
      success: true,
      draftOnly: true,
      postId: '9',
      postUrl: 'https://my.oschina.net/u/5/blog/write/draft/9',
    })
    expect(calls.some(c => c.url.includes('/blog/web/add'))).toBe(false)
    const draft = calls.find(c => c.url.endsWith('/save_draft'))!
    expect(draft.body).toMatchObject({ contentType: 1, catalog: 0, user: 5 })
  })

  it('publishes to the catalog matching the category', async () => {
    const { adapter, calls } = await setup(new OschinaAdapter(), oscBase)
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({
      success: true,
      draftOnly: false,
      postId: '77',
      postUrl: 'https://my.oschina.net/u/5/blog/77',
    })

    const publish = calls.find(c => c.url.endsWith('/blog/web/add'))!
    expect(publish.method).toBe('POST')
    expect(publish.body).toMatchObject({
      title: '测试文章',
      content: article.markdown,
      contentType: 1,
      type: '1',
      catalog: 1,
      privacy: true,
      disableComment: false,
      user: 5,
    })
  })

  it('falls back to the catalog with the most posts', async () => {
    const { adapter, calls } = await setup(new OschinaAdapter(), oscBase)
    await adapter.publish({ ...article, category: '不存在' }, { draftOnly: false })
    const publish = calls.find(c => c.url.endsWith('/blog/web/add'))!
    expect(publish.body.catalog).toBe(2)
  })

  it('keeps the draft when the publish API fails', async () => {
    const { adapter } = await setup(
      new OschinaAdapter(),
      withOverride(oscBase, (url, init) =>
        url.endsWith('/blog/web/add') && isPost(init)
          ? json({ success: false, code: 40005, message: '用户被封禁' })
          : undefined
      )
    )
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({
      success: true,
      draftOnly: true,
      postUrl: 'https://my.oschina.net/u/5/blog/write/draft/9',
    })
    expect(result.message).toContain('用户被封禁')
  })
})

// ============ 51CTO ============

const ctoPage = `
<html><head><meta name="csrf-token" content="csrf-abc"></head><body>
<li class="more user"><a href="https://blog.51cto.com/me"><img src="https://avatar/a.png"></a></li>
<div class="types-select-box">
  <div class="select_item" value="8">前端</div>
  <div class="select_item" value="9">后端</div>
</div>
<script>var submitForm = { title: '', pid: '31', cate_id: '5', tag: '' };</script>
</body></html>`

const ctoBase: Route = (url, init) => {
  if (url === 'https://blog.51cto.com/blogger/publish' && !isPost(init)) return new Response(ctoPage)
  if (url === 'https://blog.51cto.com/blogger/draft' && isPost(init)) return json({ status: 1, data: { did: 11 } })
  if (url === 'https://blog.51cto.com/blogger/publish' && isPost(init)) {
    return json({
      status: 1,
      msg: 'success',
      data: { blog_id: 123, did: 11, request: 'https://blog.51cto.com/blogger/success/123' },
    })
  }
  return undefined
}

const form = (call: Call) => Object.fromEntries(new URLSearchParams(call.body as string))

describe('51CTO', () => {
  it('declares publish capability', () => {
    expect(new Cto51Adapter().meta.capabilities).toContain('publish')
  })

  it('saves draft only by default', async () => {
    const { adapter, calls } = await setup(new Cto51Adapter(), ctoBase)
    const result = await adapter.publish(article)
    expect(result).toMatchObject({
      success: true,
      draftOnly: true,
      postId: '11',
      postUrl: 'https://blog.51cto.com/blogger/draft/11',
    })
    expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/blogger/publish'))).toBe(false)
    const draft = form(calls.find(c => c.url.endsWith('/blogger/draft'))!)
    expect(draft).toMatchObject({ title: '测试文章', tag: '', cate_id: '', _csrf: 'csrf-abc' })
  })

  it('publishes the draft with tags and category', async () => {
    const { adapter, calls } = await setup(new Cto51Adapter(), ctoBase)
    const result = await adapter.publish(
      { ...article, tags: ['JavaScript', 'Vue'] },
      { draftOnly: false }
    )
    expect(result).toMatchObject({
      success: true,
      draftOnly: false,
      postId: '123',
      postUrl: 'https://blog.51cto.com/me/123',
    })

    const publish = calls.find(c => c.method === 'POST' && c.url.endsWith('/blogger/publish'))!
    const body = form(publish)
    expect(body).toMatchObject({
      title: '测试文章',
      content: article.markdown,
      did: '11',
      pid: '31',
      cate_id: '8',
      tag: 'JavaScript,Vue',
      blog_type: '1',
      check: '1',
      _csrf: 'csrf-abc',
    })
    expect(body.abstract.length).toBeGreaterThan(0)
  })

  it('uses the remembered default category when the category is unknown', async () => {
    const { adapter, calls } = await setup(new Cto51Adapter(), ctoBase)
    const result = await adapter.publish({ ...article, category: '不存在' }, { draftOnly: false })
    expect(result.draftOnly).toBe(false)
    expect(result.message).toContain('不存在')
    const body = form(calls.find(c => c.method === 'POST' && c.url.endsWith('/blogger/publish'))!)
    expect(body.cate_id).toBe('5')
  })

  it('keeps the draft when tags are missing', async () => {
    const { adapter, calls } = await setup(new Cto51Adapter(), ctoBase)
    const result = await adapter.publish({ ...article, tags: [] }, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: true, postUrl: 'https://blog.51cto.com/blogger/draft/11' })
    expect(result.message).toContain('标签')
    expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/blogger/publish'))).toBe(false)
  })

  it('keeps the draft when the publish API fails', async () => {
    const { adapter } = await setup(
      new Cto51Adapter(),
      withOverride(ctoBase, (url, init) =>
        url.endsWith('/blogger/publish') && isPost(init) ? json({ status: 0, msg: '请绑定手机号' }) : undefined
      )
    )
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: true, postUrl: 'https://blog.51cto.com/blogger/draft/11' })
    expect(result.message).toContain('请绑定手机号')
  })
})

// ============ 慕课手记（仅草稿） ============

describe('Imooc', () => {
  const route: Route = (url, init) => {
    if (url === 'https://www.imooc.com/article/savedraft' && isPost(init)) return json({ result: 0, data: 55 })
    return undefined
  }

  it('does not declare publish capability', () => {
    expect(new ImoocAdapter().meta.capabilities).not.toContain('publish')
  })

  it('only saves a draft even when publishing is requested', async () => {
    const { adapter, calls } = await setup<PlatformAdapter>(new ImoocAdapter(), route)
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({
      success: true,
      draftOnly: true,
      postId: 55,
      postUrl: 'https://www.imooc.com/article/draft/id/55',
    })
    expect(calls).toHaveLength(1)
  })
})

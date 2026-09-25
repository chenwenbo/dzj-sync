/**
 * B站 / 微博 / 豆瓣 直接发布流程测试（使用模拟的 runtime.fetch，不访问真实平台）
 */
import { describe, it, expect } from 'vitest'
import type { RuntimeInterface } from '../../runtime/interface'
import type { PlatformAdapter } from '../types'
import { BilibiliAdapter } from '../platforms/bilibili'
import { WeiboAdapter } from '../platforms/weibo'
import { DoubanAdapter } from '../platforms/douban'
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

function form(call: Call | undefined): Record<string, string> {
  expect(call).toBeDefined()
  return Object.fromEntries(new URLSearchParams(call!.body as URLSearchParams))
}

function createRuntime(route: Route, cookies: Record<string, string> = {}) {
  const calls: Call[] = []
  const runtime: RuntimeInterface = {
    type: 'extension',
    async fetch(url, init = {}) {
      calls.push({ method: (init.method || 'GET').toUpperCase(), url, body: init.body })
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
  markdown: '# 小节\n\n正文内容',
  html: '<h1>小节</h1><p>正文</p>',
  summary: '文章摘要',
  tags: ['JavaScript', '前端'],
  category: '学习',
}

// ============ B站 ============

describe('Bilibili', () => {
  const route = (submit: () => Response): Route => (url) => {
    if (url.includes('/x/web-interface/nav')) {
      return json({ code: 0, data: { mid: 1, uname: 'u', face: '', isLogin: true } })
    }
    if (url.includes('/x/article/creative/draft/addupdate')) return json({ code: 0, data: { aid: 100 } })
    if (url.includes('/x/article/creative/article/submit')) return submit()
    return undefined
  }
  const cookies = { bili_jct: 'csrf-token' }
  const draftUrl = 'https://member.bilibili.com/platform/upload/text/edit?aid=100'

  it('saves draft only by default', async () => {
    const { adapter, calls } = await setup(new BilibiliAdapter(), route(() => json({ code: 0 })), cookies)
    const result = await adapter.publish(article)
    expect(result).toMatchObject({ success: true, draftOnly: true, postId: '100', postUrl: draftUrl })
    expect(calls.some(c => c.url.includes('article/submit'))).toBe(false)

    const draft = form(calls.find(c => c.url.includes('draft/addupdate')))
    expect(draft).toEqual({
      tid: '4', title: '测试文章', content: '<h1>小节</h1><p>正文</p>', csrf: 'csrf-token', save: '0', pgc_id: '0',
    })
  })

  it('submits the draft with category, tags and summary', async () => {
    const { adapter, calls } = await setup(
      new BilibiliAdapter(),
      route(() => json({ code: 0, data: { aid: 555, state: -2 } })),
      cookies
    )
    const result = await adapter.publish(
      { ...article, cover: 'https://i0.hdslb.com/bfs/article/cover.jpg' },
      { draftOnly: false }
    )
    expect(result).toMatchObject({
      success: true,
      draftOnly: false,
      postId: '555',
      postUrl: 'https://www.bilibili.com/read/cv555',
    })
    expect(result.message).toContain('审核')

    const submit = form(calls.find(c => c.url === 'https://api.bilibili.com/x/article/creative/article/submit'))
    expect(submit).toMatchObject({
      aid: '100',
      title: '测试文章',
      content: '<h1>小节</h1><p>正文</p>',
      summary: '文章摘要',
      banner_url: 'https://i0.hdslb.com/bfs/article/cover.jpg',
      tid: '34',
      category: '34',
      tags: 'JavaScript,前端',
      original: '1',
      csrf: 'csrf-token',
    })
  })

  it('uses the default category (数码) when none is set', async () => {
    const { adapter, calls } = await setup(new BilibiliAdapter(), route(() => json({ code: 0, data: { aid: 7, state: 0 } })), cookies)
    const result = await adapter.publish({ ...article, category: undefined }, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: false, postUrl: 'https://www.bilibili.com/read/cv7' })
    expect(form(calls.find(c => c.url.includes('article/submit'))).category).toBe('26')
  })

  it('keeps the draft when the category is unknown', async () => {
    const { adapter, calls } = await setup(new BilibiliAdapter(), route(() => json({ code: 0 })), cookies)
    const result = await adapter.publish({ ...article, category: '不存在' }, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: true, postUrl: draftUrl })
    expect(result.message).toContain('category')
    expect(calls.some(c => c.url.includes('article/submit'))).toBe(false)
  })

  it('keeps the draft when submit fails', async () => {
    const { adapter } = await setup(
      new BilibiliAdapter(),
      route(() => json({ code: 37130, message: '文章内容存在外链' })),
      cookies
    )
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: true, postId: '100', postUrl: draftUrl })
    expect(result.message).toContain('文章内容存在外链')
  })

  it('reports risk-control (412) and keeps the draft', async () => {
    const { adapter } = await setup(
      new BilibiliAdapter(),
      route(() => new Response('', { status: 412, statusText: 'Precondition Failed' })),
      cookies
    )
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: true, postUrl: draftUrl })
    expect(result.message).toContain('412')
  })
})

// ============ 微博 ============

describe('Weibo', () => {
  const editorHtml = `<script>window.__INIT__ = { config: JSON.parse('{"uid":12345,"nick":"u","avatar_large":""}') }</script>`
  const route = (publish: () => Response): Route => (url) => {
    if (url === 'https://card.weibo.com/article/v5/editor') return new Response(editorHtml)
    if (url.includes('/aj/editor/draft/create')) return json({ code: 100000, data: { id: '888' } })
    if (url.includes('/aj/editor/draft/save')) return json({ code: '100000', data: {} })
    if (url.includes('/aj/editor/draft/publish')) return publish()
    return undefined
  }
  const withImage: Article = {
    ...article,
    html: '<p>正文</p><figure class="image"><img src="https://wx3.sinaimg.cn/large/abc.jpg" /></figure>',
  }
  const draftUrl = 'https://card.weibo.com/article/v5/editor#/draft/888'

  it('saves draft only by default', async () => {
    const { adapter, calls } = await setup(new WeiboAdapter(), route(() => json({ code: 100000 })))
    const result = await adapter.publish(withImage)
    expect(result).toMatchObject({ success: true, draftOnly: true, postId: '888', postUrl: draftUrl })
    expect(calls.some(c => c.url.includes('draft/publish'))).toBe(false)

    const saves = calls.filter(c => c.url.includes('draft/save'))
    expect(saves).toHaveLength(1)
    expect(form(saves[0])).toMatchObject({ action: '1', follow_to_read: '1', cover: '', summary: '' })
  })

  it('saves with action=2 and publishes the draft', async () => {
    const { adapter, calls } = await setup(new WeiboAdapter(), route(() => json({ code: '100000', data: {} })))
    const result = await adapter.publish(withImage, { draftOnly: false })
    expect(result).toMatchObject({
      success: true,
      draftOnly: false,
      postId: '888',
      postUrl: 'https://weibo.com/u/12345?tabtype=article',
    })

    const saves = calls.filter(c => c.url.includes('draft/save'))
    expect(saves).toHaveLength(2)
    expect(form(saves[1])).toMatchObject({
      id: '888',
      action: '2',
      follow_to_read: '0',
      cover: 'https://wx3.sinaimg.cn/large/abc.jpg',
      summary: '文章摘要',
    })

    const publish = calls.find(c => c.url.includes('draft/publish'))!
    expect(publish.url).toMatch(/^https:\/\/card\.weibo\.com\/article\/v5\/aj\/editor\/draft\/publish\?uid=12345&id=888&_rid=/)
    expect(form(publish)).toMatchObject({
      id: '888',
      text: '发布了头条文章：《测试文章》',
      follow_to_read: '0',
      sync_wb: '0',
      is_original: '0',
      time: '',
    })
  })

  it('uses the returned article url when present', async () => {
    const { adapter } = await setup(
      new WeiboAdapter(),
      route(() => json({ code: 'A00006', data: { url: 'https://weibo.com/ttarticle/p/show?id=2309404888' } }))
    )
    const result = await adapter.publish(withImage, { draftOnly: false })
    expect(result).toMatchObject({ draftOnly: false, postUrl: 'https://weibo.com/ttarticle/p/show?id=2309404888' })
  })

  it('keeps the draft when no cover is available', async () => {
    const { adapter, calls } = await setup(new WeiboAdapter(), route(() => json({ code: 100000 })))
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: true, postUrl: draftUrl })
    expect(result.message).toContain('cover')
    expect(calls.some(c => c.url.includes('draft/publish'))).toBe(false)
  })

  it('keeps the draft when publish fails or needs captcha', async () => {
    const failed = await setup(new WeiboAdapter(), route(() => json({ code: 100001, msg: '内容违规' })))
    const r1 = await failed.adapter.publish(withImage, { draftOnly: false })
    expect(r1).toMatchObject({ success: true, draftOnly: true, postUrl: draftUrl })
    expect(r1.message).toContain('内容违规')

    const captcha = await setup(new WeiboAdapter(), route(() => json({ code: 100000, data: { geetest: { gt: 'x' } } })))
    const r2 = await captcha.adapter.publish(withImage, { draftOnly: false })
    expect(r2).toMatchObject({ success: true, draftOnly: true })
    expect(r2.message).toContain('验证')
  })
})

// ============ 豆瓣 ============

describe('Douban', () => {
  const createHtml = `
    <script>var _USER_NAME = 'tester'; var _USER_AVATAR = 'https://img.doubanio.com/a.jpg';</script>
    <form><input type="hidden" name="note_id" value="9001"><input type="hidden" name="ck" value="ck1">
    <input type="hidden" name="action" value="new"></form>`
  const route = (publish: () => Response): Route => (url) => {
    if (url === 'https://www.douban.com/note/create') return new Response(createHtml)
    if (url === 'https://www.douban.com/j/note/autosave') return json({ r: 0 })
    if (url === 'https://www.douban.com/j/note/publish') return publish()
    return undefined
  }

  it('saves draft only by default', async () => {
    const { adapter, calls } = await setup(new DoubanAdapter(), route(() => json({ r: 0 })))
    const result = await adapter.publish(article)
    expect(result).toMatchObject({
      success: true,
      draftOnly: true,
      postId: '9001',
      postUrl: 'https://www.douban.com/note/create',
    })
    expect(calls.some(c => c.url.includes('/j/note/publish'))).toBe(false)
    expect(form(calls.find(c => c.url.includes('/j/note/autosave')))).toMatchObject({ author_tags: '', ck: 'ck1' })
  })

  it('publishes the pre-allocated note', async () => {
    const { adapter, calls } = await setup(
      new DoubanAdapter(),
      route(() => json({ r: 0, url: '/note/9001/' }))
    )
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({
      success: true,
      draftOnly: false,
      postId: '9001',
      postUrl: 'https://www.douban.com/note/9001/',
    })

    const autosave = form(calls.find(c => c.url.includes('/j/note/autosave')))
    const publish = calls.find(c => c.url === 'https://www.douban.com/j/note/publish')!
    expect(publish.method).toBe('POST')
    const body = form(publish)
    expect(body).toMatchObject({
      is_rich: '1',
      note_id: '9001',
      note_title: '测试文章',
      note_privacy: 'P',
      author_tags: 'JavaScript 前端',
      ck: 'ck1',
      action: 'new',
    })
    expect(body.note_text).toBe(autosave.note_text)
  })

  it('keeps the draft when publish fails', async () => {
    const { adapter } = await setup(new DoubanAdapter(), route(() => json({ r: 1, err: '需要验证' })))
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({
      success: true,
      draftOnly: true,
      postId: '9001',
      postUrl: 'https://www.douban.com/note/create',
    })
    expect(result.message).toContain('需要验证')
  })
})

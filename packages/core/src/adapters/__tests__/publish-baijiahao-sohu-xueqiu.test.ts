/**
 * 百家号 / 搜狐号 / 雪球 直接发布流程测试（使用模拟的 runtime.fetch，不访问真实平台）
 */
import { describe, it, expect } from 'vitest'
import type { RuntimeInterface } from '../../runtime/interface'
import type { PlatformAdapter } from '../types'
import { BaijiahaoAdapter, SohuAdapter, XueqiuAdapter } from '../platforms'
import type { Article } from '../../types'
import { setLoggerConfig } from '../../lib/logger'

setLoggerConfig({ enabled: false })

type Route = (url: string, init: RequestInit) => Response | undefined

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body?: any
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function text(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init })
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
          // 保留原始字符串
        }
      }
      calls.push({
        method: (init.method || 'GET').toUpperCase(),
        url,
        headers: (init.headers || {}) as Record<string, string>,
        body,
      })
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

const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

// ============ 百家号 ============

const BJH_IMG = 'https://pic.rmb.bdstatic.com/bjh/abc.jpeg'

const bjhArticle: Article = {
  title: '测试文章',
  markdown: '正文',
  html: `<p>正文</p><img src="${BJH_IMG}">`,
  summary: '摘要',
}

function bjhRoute(extra?: Route): Route {
  return (url, init) => {
    const custom = extra?.(url, init)
    if (custom) return custom
    if (url.includes('/builder/app/appinfo')) {
      return json({ errno: 0, errmsg: 'success', data: { user: { userid: 'u1', name: 'bjh', avatar: '' } } })
    }
    if (url.includes('/builder/rc/edit')) {
      return text(`<script>window.__BJH__INIT__AUTH__ = 'page-token';</script>`)
    }
    if (url.includes('/pcui/article/save')) {
      return text('bjhdraft({"errno":0,"errmsg":"success","ret":{"article_id":"a1"}})')
    }
    if (url.includes('/pcui/article/edit')) {
      return text('{}', { headers: { token: 'publish-token' } })
    }
    if (url.includes('/pcui/picture/uploadproxy')) {
      return json({ errno: 0, errmsg: 'success', ret: { https_url: 'https://pic.rmb.bdstatic.com/bjh/cover.png' } })
    }
    if (url.includes('/pcui/article/publish')) {
      return text('bjhpublish({"errno":0,"errmsg":"success","ret":{"id":"a1","url":"https://baijiahao.baidu.com/s?id=1700000000000"}})')
    }
    return undefined
  }
}

describe('Baijiahao', () => {
  it('saves draft only by default', async () => {
    const { adapter, calls } = await setup(new BaijiahaoAdapter(), bjhRoute())
    const result = await adapter.publish(bjhArticle)
    expect(result).toMatchObject({
      success: true,
      draftOnly: true,
      postId: 'a1',
      postUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=a1',
    })
    expect(calls.some(c => c.url.includes('/pcui/article/publish'))).toBe(false)
    expect(calls.some(c => c.url.includes('/pcui/article/edit'))).toBe(false)
  })

  it('publishes the draft with the first content image as cover', async () => {
    const { adapter, calls } = await setup(new BaijiahaoAdapter(), bjhRoute())
    const result = await adapter.publish(bjhArticle, { draftOnly: false })
    expect(result).toMatchObject({
      success: true,
      draftOnly: false,
      postId: 'a1',
      postUrl: 'https://baijiahao.baidu.com/s?id=1700000000000',
    })

    const save = calls.find(c => c.url.includes('/pcui/article/save'))!
    const publish = calls.find(c => c.url.includes('/pcui/article/publish'))!
    expect(publish.method).toBe('POST')
    expect(publish.url).toBe('https://baijiahao.baidu.com/pcui/article/publish?type=news&callback=bjhpublish')
    expect(publish.headers.token).toBe('publish-token')

    const body = publish.body as URLSearchParams
    expect(body.get('article_id')).toBe('a1')
    expect(body.get('title')).toBe('测试文章')
    expect(body.get('content')).toBe((save.body as URLSearchParams).get('content'))
    expect(body.get('type')).toBe('news')
    expect(body.get('abstract')).toBe('摘要')
    expect(body.get('cover_layout')).toBe('one')
    expect(JSON.parse(body.get('cover_images')!)[0].src).toBe(BJH_IMG)
    expect(JSON.parse(body.get('_cover_images_map')!)[0]).toEqual({ src: BJH_IMG, origin_src: BJH_IMG })
  })

  it('uploads the frontmatter cover before publishing', async () => {
    const { adapter, calls } = await setup(new BaijiahaoAdapter(), bjhRoute())
    const result = await adapter.publish({ ...bjhArticle, cover: PNG_DATA_URI }, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: false })

    expect(calls.some(c => c.url.includes('/pcui/picture/uploadproxy'))).toBe(true)
    const publish = calls.find(c => c.url.includes('/pcui/article/publish'))!
    const cover = JSON.parse((publish.body as URLSearchParams).get('cover_images')!)[0]
    expect(cover.src).toBe('https://pic.rmb.bdstatic.com/bjh/cover.png')
  })

  it('keeps the draft when no cover is available', async () => {
    const { adapter, calls } = await setup(new BaijiahaoAdapter(), bjhRoute())
    const result = await adapter.publish({ ...bjhArticle, html: '<p>没有图片</p>' }, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: true, postId: 'a1' })
    expect(result.message).toContain('cover')
    expect(calls.some(c => c.url.includes('/pcui/article/publish'))).toBe(false)
  })

  it('keeps the draft when publish is blocked by risk control', async () => {
    const { adapter } = await setup(
      new BaijiahaoAdapter(),
      bjhRoute(url =>
        url.includes('/pcui/article/publish')
          ? text('bjhpublish({"errno":10000015,"errmsg":"您所在网络环境异常，请完成验证","data":{"hit_rule":"新号弹码"}})')
          : undefined
      )
    )
    const result = await adapter.publish(bjhArticle, { draftOnly: false })
    expect(result).toMatchObject({
      success: true,
      draftOnly: true,
      postUrl: 'https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=a1',
    })
    expect(result.message).toContain('风控')
    expect(result.message).toContain('请完成验证')
  })

  it('keeps the draft when publish API returns an error', async () => {
    const { adapter } = await setup(
      new BaijiahaoAdapter(),
      bjhRoute(url =>
        url.includes('/pcui/article/publish')
          ? text('bjhpublish({"errno":20001,"errmsg":"标题字数不符合要求"})')
          : undefined
      )
    )
    const result = await adapter.publish(bjhArticle, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: true })
    expect(result.message).toContain('标题字数不符合要求')
  })
})

// ============ 搜狐号 ============

describe('Sohu', () => {
  const route: Route = (url) => {
    if (url.includes('/mpbp/bp/account/list')) {
      return json({ code: 2000000, data: { data: [{ accounts: [{ id: '9', nickName: 'sohu', avatar: '' }] }] } })
    }
    if (url.includes('/news/draft/v2')) return json({ success: true, data: 88 })
    return undefined
  }

  it('does not declare publish capability', () => {
    expect(new SohuAdapter().meta.capabilities).not.toContain('publish')
  })

  it('stays draft-only even when publishing is requested', async () => {
    const { adapter, calls } = await setup(new SohuAdapter(), route)
    const result = await adapter.publish(bjhArticle, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: true, postId: '88' })
    expect(calls.filter(c => c.method === 'POST').map(c => c.url)).toEqual([
      'https://mp.sohu.com/mpbp/bp/news/v4/news/draft/v2?accountId=9',
    ])
  })
})

// ============ 雪球 ============

const xqArticle: Article = {
  title: '雪球长文',
  markdown: '# 小节\n\n正文内容',
  html: '<h1>小节</h1><p>正文内容</p>',
}

function xqRoute(extra?: Route): Route {
  return (url, init) => {
    const custom = extra?.(url, init)
    if (custom) return custom
    if (url === 'https://mp.xueqiu.com/writeV2') {
      return text('<script>window.UOM_CURRENTUSER = {"currentUser":{"id":123,"screen_name":"xq"}}</script>')
    }
    if (url.includes('/xq/statuses/draft/save.json')) return json({ id: 55 })
    if (url.includes('/xq/provider/session/token.json')) return json({ session_token: 'st-1' })
    if (url.includes('/xq/photo/upload.json')) return json({ url: '//xqimg.imedao.com', filename: 'cover.png' })
    if (url.includes('/xq/statuses/update.json')) return json({ id: 777, user_id: 123 })
    return undefined
  }
}

describe('Xueqiu', () => {
  it('saves draft only by default', async () => {
    const { adapter, calls } = await setup(new XueqiuAdapter(), xqRoute())
    const result = await adapter.publish(xqArticle)
    expect(result).toMatchObject({
      success: true,
      draftOnly: true,
      postId: '55',
      postUrl: 'https://mp.xueqiu.com/write/draft/55',
    })
    expect(calls.some(c => c.url.includes('statuses/update.json'))).toBe(false)
    expect(calls.some(c => c.url.includes('session/token.json'))).toBe(false)
  })

  it('publishes the long text with a session token', async () => {
    const { adapter, calls } = await setup(new XueqiuAdapter(), xqRoute())
    const result = await adapter.publish(xqArticle, { draftOnly: false })
    expect(result).toMatchObject({
      success: true,
      draftOnly: false,
      postId: '777',
      postUrl: 'https://xueqiu.com/123/777',
    })

    const token = calls.find(c => c.url.includes('session/token.json'))!
    expect(token.url).toContain('api_path=%2Fstatuses%2Fupdate.json')

    const draft = calls.find(c => c.url.includes('draft/save.json'))!
    const update = calls.find(c => c.url.includes('statuses/update.json'))!
    expect(update.method).toBe('POST')
    const body = update.body as URLSearchParams
    expect(body.get('title')).toBe('雪球长文')
    expect(body.get('status')).toBe((draft.body as URLSearchParams).get('text'))
    expect(body.get('session_token')).toBe('st-1')
    expect(body.get('draft_id')).toBe('55')
    expect(body.get('cover_pic')).toBe('')
    expect(body.get('show_cover_pic')).toBe('0')
  })

  it('uploads the frontmatter cover', async () => {
    const { adapter, calls } = await setup(new XueqiuAdapter(), xqRoute())
    const result = await adapter.publish({ ...xqArticle, cover: PNG_DATA_URI }, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: false })
    const body = calls.find(c => c.url.includes('statuses/update.json'))!.body as URLSearchParams
    expect(body.get('cover_pic')).toBe('https://xqimg.imedao.com/cover.png')
    expect(body.get('show_cover_pic')).toBe('1')
  })

  it('keeps the draft when publish fails', async () => {
    const { adapter } = await setup(
      new XueqiuAdapter(),
      xqRoute(url =>
        url.includes('statuses/update.json')
          ? json({ error_code: '20105', error_description: '请输入验证码' })
          : undefined
      )
    )
    const result = await adapter.publish(xqArticle, { draftOnly: false })
    expect(result).toMatchObject({
      success: true,
      draftOnly: true,
      postId: '55',
      postUrl: 'https://mp.xueqiu.com/write/draft/55',
    })
    expect(result.message).toContain('请输入验证码')
  })
})

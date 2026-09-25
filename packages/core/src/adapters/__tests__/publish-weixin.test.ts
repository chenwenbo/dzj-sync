/**
 * 直接发布流程测试（使用模拟的 runtime.fetch，不访问真实平台）
 */
import { describe, it, expect } from 'vitest'
import type { RuntimeInterface } from '../../runtime/interface'
import type { PlatformAdapter } from '../types'
import { WeixinAdapter } from '../platforms'
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

// ============ 微信公众号 ============

const HOME_HTML = `<script>window.wx = { data: { t: "tok123" }, ticket: "tk", user_name: "gh_1", nick_name: "测试号", time: "1700000000" }</script>`

function weixinRoute(massPage: object, masssend: object = { base_resp: { ret: 0 } }): Route {
  return (url) => {
    if (url === 'https://mp.weixin.qq.com/') return new Response(HOME_HTML)
    if (url.includes('operate_appmsg')) return json({ appMsgId: 555, base_resp: { ret: 0 } })
    if (url.includes('masssendpage')) return json(massPage)
    if (url.includes('misc/safeassistant')) return json({ operation_seq: 999, base_resp: { ret: 0 } })
    if (url.includes('cgi-bin/masssend?')) return json(masssend)
    return undefined
  }
}

describe('Weixin', () => {
  it('only saves the draft by default', async () => {
    const { adapter, calls } = await setup(new WeixinAdapter(), weixinRoute({ need_scan_qrcode: 0, operation_seq: '1' }))
    const result = await adapter.publish(article)
    expect(result).toMatchObject({ success: true, draftOnly: true, postId: '555' })
    expect(calls.some(c => c.url.includes('masssend'))).toBe(false)
  })

  it('publishes the draft via masssend when mass-send protection is off', async () => {
    const { adapter, calls } = await setup(
      new WeixinAdapter(),
      weixinRoute({ base_resp: { ret: 0 }, need_scan_qrcode: 0, operation_seq: '777', protect_status: 0 })
    )
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: false, postId: '555' })

    const send = calls.find(c => c.url.includes('cgi-bin/masssend?'))!
    expect(send.url).toContain('is_release_publish_page=1')
    const form = new URLSearchParams(send.body.toString())
    expect(form.get('appmsgid')).toBe('555')
    expect(form.get('isFreePublish')).toBe('true')
    expect(form.get('operation_seq')).toBe('777')
    expect(form.get('token')).toBe('tok123')
  })

  it('fetches operation_seq when the mass-send page does not provide it', async () => {
    const { adapter, calls } = await setup(new WeixinAdapter(), weixinRoute({ need_scan_qrcode: 0 }))
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result.draftOnly).toBe(false)
    const form = new URLSearchParams(calls.find(c => c.url.includes('cgi-bin/masssend?'))!.body.toString())
    expect(form.get('operation_seq')).toBe('999')
  })

  it('keeps the draft when mass-send protection requires a QR scan', async () => {
    const { adapter, calls } = await setup(new WeixinAdapter(), weixinRoute({ need_scan_qrcode: 1, protect_status: 2 }))
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: true, postId: '555' })
    expect(result.message).toContain('群发消息保护')
    expect(calls.some(c => c.url.includes('cgi-bin/masssend?'))).toBe(false)
  })

  it('keeps the draft when masssend is rejected', async () => {
    const { adapter } = await setup(
      new WeixinAdapter(),
      weixinRoute({ need_scan_qrcode: 0, operation_seq: '1' }, { base_resp: { ret: 154011, err_msg: 'system error' } })
    )
    const result = await adapter.publish(article, { draftOnly: false })
    expect(result).toMatchObject({ success: true, draftOnly: true })
    expect(result.message).toContain('system error')
  })
})

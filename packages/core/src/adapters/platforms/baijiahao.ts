/**
 * 百家号适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Baijiahao')

interface BaijiahaoUserInfo {
  userid: string
  name: string
  avatar: string
}

export class BaijiahaoAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'baijiahao',
    name: '百家号',
    icon: 'https://www.baidu.com/favicon.ico',
    homepage: 'https://baijiahao.baidu.com/',
    capabilities: ['article', 'draft', 'publish', 'image_upload', 'cover'],
  }

  /** 预处理配置: 百家号使用 HTML 格式 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  private userInfo: BaijiahaoUserInfo | null = null
  private authToken: string = ''

  /** 百家号 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://baijiahao.baidu.com/*',
      headers: {
        'Origin': 'https://baijiahao.baidu.com',
        'Referer': 'https://baijiahao.baidu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const res = await this.get<{
        errno: number
        errmsg: string
        data?: { user: BaijiahaoUserInfo }
      }>(`https://baijiahao.baidu.com/builder/app/appinfo?_=${Date.now()}`)

      logger.debug('checkAuth response:', res)

      if (res.errmsg === 'success' && res.data?.user) {
        this.userInfo = res.data.user
        return {
          isAuthenticated: true,
          userId: res.data.user.userid,
          username: res.data.user.name,
          avatar: res.data.user.avatar,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  private async fetchAuthToken(): Promise<string> {
    const response = await this.runtime.fetch('https://baijiahao.baidu.com/builder/rc/edit', {
      credentials: 'include',
    })
    const html = await response.text()

    const match = html.match(/window\.__BJH__INIT__AUTH__\s*=\s*['"]([^'"]+)['"]/)
    if (!match) {
      throw new Error('登录失效，请重新登录百家号')
    }

    const token = match[1]
    logger.debug('Auth token obtained')
    return token
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      if (!this.userInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录百家号')
        }
      }

      this.authToken = await this.fetchAuthToken()

      // Use pre-processed HTML content directly
      let content = article.html || ''

      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['baijiahao.baidu.com', 'bdstatic.com', 'bcebos.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // 草稿与发布共用的表单字段（草稿模式下与原实现完全一致）
      const baseFields: Record<string, string> = {
        title: article.title,
        content: content,
        feed_cat: '1',
        len: String(content.length),
        activity_list: JSON.stringify([{ id: 408, is_checked: 0 }]),
        source_reprinted_allow: '0',
        original_status: '0',
        original_handler_status: '1',
        isBeautify: 'false',
        subtitle: '',
        bjhtopic_id: '',
        bjhtopic_info: '',
        type: 'news',
      }

      const response = await this.runtime.fetch(
        'https://baijiahao.baidu.com/pcui/article/save?callback=bjhdraft',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'token': this.authToken,
          },
          body: new URLSearchParams(baseFields),
        }
      )

      const text = await response.text()
      const jsonStr = text.replace(/^bjhdraft\(/, '').replace(/\)$/, '')
      const res = JSON.parse(jsonStr) as {
        errno: number
        errmsg: string
        ret?: { article_id: string }
      }

      logger.debug('Save response:', res)

      if (res.errmsg !== 'success' || !res.ret?.article_id) {
        throw new Error(res.errmsg || '保存草稿失败')
      }

      const postId = res.ret.article_id
      const draftUrl = `https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=${postId}`

      return this.finishWithPublish({ postId, postUrl: draftUrl }, options, () =>
        this.publishArticle(postId, baseFields, article, content)
      )
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  // ============ 直接发布 ============

  /**
   * 直接发布（草稿已保存后调用）
   *
   * 请求格式来自编辑器「发布」按钮的抓包（公开逆向资料）：
   *   POST /pcui/article/publish?type=news&callback=bjhpublish
   *   Content-Type: application/x-www-form-urlencoded，请求头 token
   *   表单：与草稿保存相同的文章字段 + 封面字段（cover_layout / cover_images / _cover_images_map）
   *   响应（JSONP）：{ errno: 0, ret: { id | article_id, url? } }；errno=10000015 为风控弹码
   *
   * 默认值：
   * - 封面：frontmatter cover 优先，否则取正文第一张图（百家号发布必须有封面，单图模式 cover_layout=one）
   * - 原创声明 / 转载许可沿用草稿字段（original_status=0、source_reprinted_allow=0）
   * - 带上 article_id，让刚保存的草稿直接转为发布，避免产生重复文章
   */
  private async publishArticle(
    postId: string,
    baseFields: Record<string, string>,
    article: Article,
    content: string
  ): Promise<{ postId?: string; postUrl: string; message?: string }> {
    const cover = await this.resolveCover(article, content)
    const publishToken = await this.fetchPublishToken()

    const coverImages = JSON.stringify([
      {
        src: cover.src,
        ...(cover.crop ? { cropData: cover.crop } : {}),
        machine_chooseimg: 0,
        isLegal: 0,
        cover_source_tag: 'local',
      },
    ])

    const response = await this.runtime.fetch(
      'https://baijiahao.baidu.com/pcui/article/publish?type=news&callback=bjhpublish',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'token': publishToken,
        },
        body: new URLSearchParams({
          ...baseFields,
          article_id: postId,
          abstract: article.summary || '',
          cover_layout: 'one',
          cover_images: coverImages,
          _cover_images_map: JSON.stringify([{ src: cover.src, origin_src: cover.origin }]),
          cover_source: 'upload',
        }),
      }
    )

    const text = await response.text()
    let res: {
      errno?: number | string
      errmsg?: string
      ret?: { id?: string | number; article_id?: string | number; url?: string }
      data?: { hit_rule?: string }
    }
    try {
      res = JSON.parse(this.stripJsonp(text))
    } catch {
      throw new Error(`发布接口返回异常（HTTP ${response.status}）`)
    }

    logger.debug('Publish response:', res)

    const errno = Number(res.errno)
    if (errno === 10000015) {
      const hit = res.data?.hit_rule ? `（${res.data.hit_rule}）` : ''
      throw new Error(`百家号风控拦截：${res.errmsg || '需要验证'}${hit}，请先在浏览器中打开百家号完成验证后重试`)
    }
    if (errno !== 0) {
      throw new Error(res.errmsg || `发布失败（errno ${res.errno}）`)
    }

    const publishedId = String(res.ret?.id ?? res.ret?.article_id ?? postId)
    const url = res.ret?.url
    if (url && /^https?:\/\//.test(url)) {
      return { postId: publishedId, postUrl: url }
    }
    // 百家号发布后需审核，审核通过前没有公开链接，指向内容管理页
    return {
      postId: publishedId,
      postUrl: 'https://baijiahao.baidu.com/builder/rc/content',
      message: '已提交发布，百家号审核通过后可在内容管理中查看',
    }
  }

  /**
   * 发布用 token：带页面 token 请求编辑接口，响应头 token 即发布 token；
   * 取不到时回退为页面 token（与草稿保存相同）
   */
  private async fetchPublishToken(): Promise<string> {
    try {
      const response = await this.runtime.fetch('https://baijiahao.baidu.com/pcui/article/edit?type=news', {
        method: 'GET',
        credentials: 'include',
        headers: { token: this.authToken },
      })
      return response.headers.get('token') || this.authToken
    } catch (error) {
      logger.debug('fetchPublishToken failed, fallback to page token:', error)
      return this.authToken
    }
  }

  /**
   * 解析封面：frontmatter cover 优先，否则正文第一张图；均无则报错（草稿保留）
   */
  private async resolveCover(
    article: Article,
    content: string
  ): Promise<{ src: string; origin: string; crop?: { x: number; y: number; width: number; height: number } }> {
    let origin = ''
    if (article.cover) {
      origin = this.isBaijiahaoImage(article.cover)
        ? article.cover
        : (await this.uploadImageByUrl(article.cover)).url
    } else {
      const first = content.match(/<img[^>]+src="([^"]+)"/i)?.[1]
      if (first) {
        origin = this.isBaijiahaoImage(first) ? first : (await this.uploadImageByUrl(first)).url
      }
    }
    if (!origin) {
      throw new Error('百家号发布需要封面图：请在 frontmatter 中设置 cover，或在正文中插入至少一张图片')
    }

    // 按编辑器默认的 3:2 横版比例居中裁剪；无法获取尺寸或裁剪失败时直接使用原图
    const size = await this.getImageSize(origin)
    if (size) {
      const crop = this.centerCrop(size.width, size.height, 1.5)
      try {
        const res = await this.runtime.fetch('https://baijiahao.baidu.com/pcui/Picture/CuttingPicproxy', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', token: this.authToken },
          body: new URLSearchParams({
            auto: 'true',
            x: String(crop.x),
            y: String(crop.y),
            w: String(crop.width),
            h: String(crop.height),
            src: origin,
            type: 'newsRow',
            cutting_type: 'cover_image',
          }),
        })
        const data = await res.json() as { errno?: number; data?: { https_src?: string } }
        if (Number(data.errno) === 0 && data.data?.https_src) {
          return { src: data.data.https_src, origin, crop }
        }
      } catch (error) {
        logger.debug('Cover crop failed, using original image:', error)
      }
    }
    return { src: origin, origin }
  }

  private isBaijiahaoImage(src: string): boolean {
    return /^https?:\/\//.test(src) && ['bdstatic.com', 'bcebos.com', 'baijiahao.baidu.com'].some(h => src.includes(h))
  }

  /** 获取图片尺寸（Service Worker 下用 createImageBitmap；不可用时返回 null） */
  private async getImageSize(src: string): Promise<{ width: number; height: number } | null> {
    if (typeof createImageBitmap !== 'function') return null
    try {
      const blob = await (await fetch(src)).blob()
      const bitmap = await createImageBitmap(blob)
      const size = { width: bitmap.width, height: bitmap.height }
      bitmap.close?.()
      return size.width > 0 && size.height > 0 ? size : null
    } catch {
      return null
    }
  }

  private centerCrop(width: number, height: number, ratio: number) {
    if (width / height > ratio) {
      const w = Math.floor(height * ratio)
      return { x: Math.floor((width - w) / 2), y: 0, width: w, height }
    }
    const h = Math.floor(width / ratio)
    return { x: 0, y: Math.floor((height - h) / 2), width, height: h }
  }

  /** 去掉 JSONP 包裹：bjhpublish({...}) → {...} */
  private stripJsonp(text: string): string {
    const trimmed = text.trim()
    const match = trimmed.match(/^[\w$.]+\(([\s\S]*)\)\s*;?$/)
    return match ? match[1] : trimmed
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    const formData = new FormData()
    formData.append('media', imageBlob, 'image.jpg')
    formData.append('type', 'image')
    formData.append('app_id', '1589639493090963')
    formData.append('is_waterlog', '1')
    formData.append('save_material', '1')
    formData.append('no_compress', '0')
    formData.append('is_events', '')
    formData.append('article_type', 'news')

    const uploadUrl = 'https://baijiahao.baidu.com/pcui/picture/uploadproxy'
    const uploadResponse = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })

    const res = await uploadResponse.json() as {
      errno: number
      errmsg: string
      ret?: { https_url: string }
    }

    logger.debug('Image upload response:', res)

    if (res.errmsg !== 'success' || !res.ret?.https_url) {
      throw new Error(res.errmsg || '图片上传失败')
    }

    return {
      url: res.ret.https_url,
    }
  }
}

/**
 * B站适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Bilibili')

/**
 * 专栏分类（/x/article/categories）名称 → 子分类 ID
 *
 * 提交接口的 `category` 字段才真正决定分类，且只接受子分类 ID（父分类会被拒绝）。
 * 父分类名映射到其下最常用的子分类（科技→数码、生活→日常）。
 * 未设置 frontmatter `category` 时默认 26（科技 · 数码），适合技术文章。
 */
const BILIBILI_CATEGORIES: Record<string, number> = {
  '数码': 26, '科技': 26, '学习': 34, '人文历史': 25, '自然': 33, '汽车': 27,
  '日常': 15, '生活': 15, '美食': 13, '时尚': 14, '运动': 22, '萌宠': 21,
  '兴趣': 23, '绘画': 23, '手工': 24, '摄影': 38, '音乐舞蹈': 39, '模型手办': 11,
  '动画': 4, '动漫杂谈': 4, '动漫资讯': 5, '动画技术': 31,
  '游戏': 6, '单机游戏': 6, '电子竞技': 7, '手机游戏': 8, '网络游戏': 9, '桌游棋牌': 10,
  '影视': 12, '电影': 12, '电视剧': 35, '纪录片': 36, '综艺': 37,
  '轻小说': 18, '原创连载': 18, '同人连载': 19, '短篇小说': 32, '小说杂谈': 20,
  '笔记': 41,
}
const BILIBILI_DEFAULT_CATEGORY = 26

/** 专栏稿件状态（投稿管理中的 state），只有 0/1 表示已公开 */
const BILIBILI_ARTICLE_STATES: Record<number, string> = {
  0: '已发布', 1: '已发布', [-1]: '未通过', [-2]: '待审核', [-3]: '锁定', [-4]: '已删除',
}

interface BilibiliUserInfo {
  mid: number
  uname: string
  face: string
  isLogin: boolean
}

export class BilibiliAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'bilibili',
    name: '哔哩哔哩',
    icon: 'https://www.bilibili.com/favicon.ico',
    homepage: 'https://member.bilibili.com/platform/upload/text',
    capabilities: ['article', 'draft', 'publish', 'image_upload', 'categories', 'tags', 'cover'],
  }

  /** 预处理配置: B站使用 HTML，移除外链 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeLinks: true,
  }

  private userInfo: BilibiliUserInfo | null = null
  private csrf: string = ''

  /** B站 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://api.bilibili.com/*',
      headers: {
        'Origin': 'https://member.bilibili.com',
        'Referer': 'https://member.bilibili.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const res = await this.get<{
        code: number
        data?: BilibiliUserInfo
      }>('https://api.bilibili.com/x/web-interface/nav?build=0&mobi_app=web')

      logger.debug('checkAuth response:', res)

      if (res.code === 0 && res.data?.isLogin) {
        this.userInfo = res.data
        await this.fetchCsrf()

        return {
          isAuthenticated: true,
          userId: String(res.data.mid),
          username: res.data.uname,
          avatar: res.data.face,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  private async fetchCsrf(): Promise<void> {
    try {
      if (this.runtime.getCookie) {
        const value = await this.runtime.getCookie('.bilibili.com', 'bili_jct')
        this.csrf = value || ''
      }
      logger.debug('CSRF token:', this.csrf ? 'obtained' : 'not found')
    } catch (e) {
      logger.error('Failed to get CSRF:', e)
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      if (!this.userInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录B站')
        }
      }

      if (!this.csrf) {
        throw new Error('获取 CSRF token 失败，请刷新页面后重试')
      }

      // Use pre-processed HTML content directly
      let content = article.html || ''

      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['hdslb.com', 'bilibili.com', 'biliimg.com'],
          onProgress: options?.onImageProgress,
        }
      )

      const res = await this.postForm<{
        code: number
        message?: string
        data?: { aid: number }
      }>(
        'https://api.bilibili.com/x/article/creative/draft/addupdate',
        {
          tid: '4',
          title: article.title,
          content: content,
          csrf: this.csrf,
          save: '0',
          pgc_id: '0',
        }
      )

      logger.debug('Draft response:', res)

      if (res.code !== 0 || !res.data?.aid) {
        throw new Error(res.message || '保存草稿失败')
      }

      const draftUrl = `https://member.bilibili.com/platform/upload/text/edit?aid=${res.data.aid}`
      const draftId = res.data.aid

      return this.finishWithPublish({ postId: String(draftId), postUrl: draftUrl }, options, () =>
        this.submitArticle(draftId, article, content)
      )
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 解析 frontmatter category：支持子分类 ID（数字）或分类名称
   */
  private resolveCategory(category?: string): number {
    const value = category?.trim()
    if (!value) return BILIBILI_DEFAULT_CATEGORY
    if (/^\d+$/.test(value)) return Number(value)
    const id = BILIBILI_CATEGORIES[value]
    if (!id) {
      const names = Object.keys(BILIBILI_CATEGORIES).join('、')
      throw new Error(`未识别的B站专栏分类「${value}」，请在 frontmatter 的 category 中填写分类 ID 或以下名称之一：${names}`)
    }
    return id
  }

  /**
   * 提交草稿为正式专栏（投稿）
   *
   * POST https://api.bilibili.com/x/article/creative/article/submit
   * 字段与 draft/addupdate 相同，附带草稿 aid；`tid` 与 `category` 需一致，
   * 否则文章会被归到「生活」。成功返回 { code: 0, data: { aid: 专栏 cv 号, state } }，
   * 新稿件通常为 state -2（待审核），审核通过后 cv 链接才可公开访问。
   * 提交接口常被风控拦截（HTTP 412），此时草稿仍保留，可在网页编辑器中手动发布。
   */
  private async submitArticle(
    draftId: number,
    article: Article,
    content: string
  ): Promise<{ postId?: string; postUrl: string; message?: string }> {
    const category = String(this.resolveCategory(article.category))

    // 封面：B站需要站内图片地址，外链 / 本地图片先通过 upcover 上传
    let bannerUrl = ''
    if (article.cover) {
      if (/hdslb\.com|biliimg\.com|bilibili\.com/.test(article.cover)) {
        bannerUrl = article.cover
      } else {
        try {
          bannerUrl = (await this.uploadImageByUrl(article.cover)).url
        } catch (e) {
          logger.warn('Failed to upload cover:', e)
        }
      }
    }

    let res: {
      code: number
      message?: string
      data?: { aid?: number | string; state?: number }
    }
    try {
      res = await this.postForm('https://api.bilibili.com/x/article/creative/article/submit', {
        aid: String(draftId),
        title: article.title,
        content,
        summary: article.summary || '',
        banner_url: bannerUrl,
        tid: category,
        category,
        tags: (article.tags || []).join(','),
        list_id: '0',
        reprint: '0',
        original: '1',
        media_id: '0',
        spoiler: '0',
        save: '0',
        pgc_id: '0',
        csrf: this.csrf,
      })
    } catch (error) {
      const message = (error as Error).message
      if (message.includes('412')) {
        throw new Error('提交被B站风控拦截（HTTP 412），请稍后在网页编辑器中手动发布')
      }
      throw error
    }

    logger.debug('Submit response:', res)

    if (res.code !== 0) {
      if (res.code === -17) {
        throw new Error(`${res.message || '分类不可用'}，请在 frontmatter 的 category 中换一个B站专栏分类`)
      }
      throw new Error(res.message || `投稿失败 (错误码: ${res.code})`)
    }

    const state = typeof res.data?.state === 'number' ? res.data.state : undefined
    if (state !== undefined && state < 0 && state !== -2) {
      throw new Error(`投稿状态为「${BILIBILI_ARTICLE_STATES[state] || state}」，文章未公开`)
    }

    // 已发布的专栏 ID 与草稿 aid 不同，只信任接口返回的 ID
    const cvid = Number(res.data?.aid)
    if (!Number.isFinite(cvid) || cvid <= 0) {
      return {
        postUrl: 'https://member.bilibili.com/platform/upload-manager/article',
        message: '已提交投稿，但接口未返回文章 ID，请在投稿管理中查看',
      }
    }

    return {
      postId: String(cvid),
      postUrl: `https://www.bilibili.com/read/cv${cvid}`,
      message: state === -2 ? '已提交投稿，B站审核通过后文章链接才可公开访问' : undefined,
    }
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.csrf) {
      throw new Error('CSRF token 未获取')
    }

    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    const formData = new FormData()
    formData.append('binary', imageBlob, 'image.jpg')
    formData.append('csrf', this.csrf)

    const uploadUrl = 'https://api.bilibili.com/x/article/creative/article/upcover'
    const uploadResponse = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    })

    const res = await uploadResponse.json() as {
      code: number
      message?: string
      data?: {
        url: string
        size: number
      }
    }

    logger.debug('Image upload response:', res)

    if (res.code !== 0 || !res.data?.url) {
      throw new Error(res.message || '图片上传失败')
    }

    return {
      url: res.data.url,
      attrs: {
        size: String(res.data.size),
      },
    }
  }
}

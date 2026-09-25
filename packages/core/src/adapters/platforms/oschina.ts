/**
 * 开源中国适配器
 * https://my.oschina.net
 */
import { CodeAdapter, ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
export class OschinaAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: 'oschina',
    name: '开源中国',
    icon: 'https://www.oschina.net/favicon.ico',
    homepage: 'https://my.oschina.net',
    capabilities: ['article', 'draft', 'publish', 'image_upload'],
  }

  /** 预处理配置: 开源中国使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private userId: string | null = null

  /** 开源中国 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://apiv1.oschina.net/oschinapi/*',
      headers: {
        Origin: 'https://my.oschina.net',
        Referer: 'https://my.oschina.net/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /**
   * 检查登录状态
   */
  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch('https://apiv1.oschina.net/oschinapi/user/myDetails', {
        credentials: 'include',
      })
      const data = await response.json() as {
        success: boolean
        result?: {
          userId: number
          userVo?: {
            name: string
            portraitUrl: string
          }
        }
      }

      if (!data.success || !data.result?.userId) {
        return { isAuthenticated: false, error: '未登录' }
      }

      this.userId = String(data.result.userId)

      return {
        isAuthenticated: true,
        userId: this.userId,
        username: data.result.userVo?.name || this.userId,
        avatar: data.result.userVo?.portraitUrl,
      }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 上传图片
   */
  async uploadImageByUrl(url: string): Promise<ImageUploadResult> {
    if (!this.userId) {
      await this.checkAuth()
    }

    // 下载图片
    const imageResponse = await this.runtime.fetch(url)
    const blob = await imageResponse.blob()
    const filename = this.getFilenameFromUrl(url) || 'image'

    // 构建 FormData
    const formData = new FormData()
    formData.append('file', blob, filename)

    const response = await this.runtime.fetch(
      'https://apiv1.oschina.net/oschinapi/ai/creation/project/uploadDetail',
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )

    const res = await response.json() as {
      success?: boolean
      result?: string
      message?: string
    }

    if (!res.success || !res.result) {
      throw new Error(res.message || '图片上传失败')
    }

    return { url: res.result }
  }

  private getFilenameFromUrl(url: string): string | null {
    try {
      const pathname = new URL(url).pathname
      const name = pathname.split('/').pop()
      return name && name.trim() ? name : null
    } catch {
      return null
    }
  }

  /**
   * 发布文章
   *
   * 1. POST /api/draft/save_draft 保存草稿（默认只做这一步）
   * 2. draftOnly === false 时，再 POST /blog/web/add 发布博客
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      // 确保已获取用户 ID
      if (!this.userId) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('未登录')
        }
      }

      const rawMarkdown = article.markdown || ''
      const rawHtml = article.html || ''
      const useMarkdown = rawMarkdown.trim().length > 0

      let content = useMarkdown ? rawMarkdown : rawHtml
      content = await this.processImages(content, (src) => this.uploadImageByUrl(src))

      const response = await this.runtime.fetch(
        'https://apiv1.oschina.net/oschinapi/api/draft/save_draft',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            title: article.title,
            user: Number(this.userId),
            content,
            contentType: useMarkdown ? 1 : 2, // 1=markdown, 2=html
            catalog: 0,
            originUrl: '',
            privacy: true,
            disableComment: false,
          }),
        }
      )

      const res = await response.json() as {
        success?: boolean
        message?: string
        result?: { id?: number }
      }

      if (!res.success || !res.result?.id) {
        throw new Error(res.message || '发布失败')
      }

      const draftId = String(res.result.id)
      const draftUrl = `https://my.oschina.net/u/${this.userId}/blog/write/draft/${draftId}`

      return this.finishWithPublish({ postId: draftId, postUrl: draftUrl }, options, async () => {
        const blogId = await this.publishBlog(article, content, useMarkdown)
        return { postId: blogId, postUrl: `https://my.oschina.net/u/${this.userId}/blog/${blogId}` }
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 选择博客分类（目录）ID
   *
   * GET /oschinapi/blog_catalog/list_by_user → { result: [{ id, name, blogCount }] }
   * - frontmatter category 与某个分类同名时使用该分类
   * - 否则默认使用文章数最多的分类（通常是用户的主力分类）
   * 开源中国 2026-05 改版后发布接口的 catalog 为必填，传 0 会被拒绝。
   */
  private async resolveCatalogId(category?: string): Promise<number | string> {
    const response = await this.runtime.fetch(
      'https://apiv1.oschina.net/oschinapi/blog_catalog/list_by_user',
      {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      }
    )
    const data = await response.json() as {
      result?: Array<{ id: number | string; name?: string; blogCount?: number }>
      message?: string
    }
    const list = Array.isArray(data?.result) ? data.result : []
    if (list.length === 0) {
      throw new Error('未获取到开源中国博客分类，请先在开源中国博客中创建一个分类')
    }

    const wanted = category?.trim()
    if (wanted) {
      const hit = list.find(c => c.name?.trim() === wanted)
      if (hit) return hit.id
    }

    const best = list.reduce((a, b) => ((b.blogCount || 0) > (a.blogCount || 0) ? b : a), list[0])
    return best.id
  }

  /**
   * 发布博客
   *
   * POST https://apiv1.oschina.net/oschinapi/blog/web/add（Cookie 认证）
   * body: { title, content, contentType, type, originUrl, catalog, privacy, disableComment, user }
   * - contentType: 1 = Markdown, 0 = HTML（注意与草稿接口的 2 = HTML 不同）
   * - type: '1' 原创（默认）
   * - privacy: true 表示「公开」；disableComment: false 允许评论
   * 成功响应 { code: 200, result: blogId }，文章链接为 https://my.oschina.net/u/{uid}/blog/{blogId}
   * 发布接口不接受草稿 ID，因此重新提交完整内容，之前保存的草稿会保留在草稿箱中。
   * 参考：https://github.com/addozhang/omnipub/blob/main/extension/content-scripts/publishers/oschina.js
   */
  private async publishBlog(article: Article, content: string, useMarkdown: boolean): Promise<string> {
    const catalog = await this.resolveCatalogId(article.category)

    const response = await this.runtime.fetch('https://apiv1.oschina.net/oschinapi/blog/web/add', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        title: article.title,
        content,
        contentType: useMarkdown ? 1 : 0,
        type: '1',
        originUrl: '',
        catalog,
        privacy: true,
        disableComment: false,
        user: Number(this.userId),
      }),
    })

    let res: {
      success?: boolean
      code?: number
      message?: string
      result?: number | string | { id?: number | string }
    }
    try {
      res = await response.json()
    } catch {
      throw new Error(`发布接口返回异常（HTTP ${response.status}）`)
    }

    const result = res?.result
    const blogId = typeof result === 'object' && result !== null ? result.id : result
    const ok = res?.code === 200 || res?.success === true
    if (!ok || blogId === undefined || blogId === null || blogId === '') {
      throw new Error(res?.message || `发布失败（code=${res?.code ?? response.status}）`)
    }
    return String(blogId)
  }
}

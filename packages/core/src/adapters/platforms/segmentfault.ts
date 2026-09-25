/**
 * 思否 (Segmentfault) 适配器
 * https://segmentfault.com
 */
import { CodeAdapter, ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
export class SegmentfaultAdapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: 'segmentfault',
    name: '思否',
    icon: 'https://imgcache.iyiou.com/Company/2016-05-11/cf-segmentfault.jpg',
    homepage: 'https://segmentfault.com/user/draft',
    capabilities: ['article', 'draft', 'publish', 'image_upload'],
  }

  /** 预处理配置: 思否使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private sessionToken: string | null = null

  /** 思否 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://segmentfault.com/gateway/*',
      headers: {
        Origin: 'https://segmentfault.com',
        Referer: 'https://segmentfault.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /**
   * 检查登录状态
   */
  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch('https://segmentfault.com/user/settings', {
        credentials: 'include',
      })
      const html = await response.text()

      // 匹配用户链接 href="/u/username"
      const userLinkMatch = html.match(/href="\/u\/([^"]+)"/)
      if (!userLinkMatch) {
        return { isAuthenticated: false, error: '未登录' }
      }

      const uid = userLinkMatch[1]

      // 匹配头像 URL (avatar-static.segmentfault.com)
      const avatarMatch = html.match(/src="(https:\/\/avatar-static\.segmentfault\.com\/[^"]+)"/)
      const avatar = avatarMatch ? avatarMatch[1] : undefined

      return {
        isAuthenticated: true,
        userId: uid,
        username: uid,
        avatar: avatar,
      }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  /**
   * 获取 session token
   */
  private async getSessionToken(): Promise<string> {
    const response = await this.runtime.fetch('https://segmentfault.com/write', {
      credentials: 'include',
    })
    const html = await response.text()

    // 新版 token 格式: serverData":{"Token":"xxx"
    const tokenMatch = html.match(/serverData":\s*\{\s*"Token"\s*:\s*"([^"]+)"/)
    if (tokenMatch) {
      return tokenMatch[1]
    }

    // 兼容旧版格式
    const markStr = 'window.g_initialProps = '
    const authIndex = html.indexOf(markStr)
    if (authIndex === -1) {
      throw new Error('获取 session token 失败')
    }

    const endIndex = html.indexOf(';\n\t</script>', authIndex)
    if (endIndex === -1) {
      throw new Error('解析 session token 失败')
    }

    const configStr = html.substring(authIndex + markStr.length, endIndex)

    try {
      const config = JSON.parse(configStr)
      const token = config?.global?.sessionInfo?.key
      if (!token) {
        throw new Error('session token 为空')
      }
      return token
    } catch (e) {
      throw new Error('解析 session token 失败: ' + (e as Error).message)
    }
  }

  /**
   * 上传图片
   */
  async uploadImageByUrl(url: string): Promise<ImageUploadResult> {
    if (!this.sessionToken) {
      throw new Error('未获取 token')
    }

    // 下载图片
    const imageResponse = await this.runtime.fetch(url)
    const blob = await imageResponse.blob()

    // 构建 FormData
    const formData = new FormData()
    formData.append('image', blob)

    const response = await this.runtime.fetch(
      'https://segmentfault.com/gateway/image',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          token: this.sessionToken,
        },
        body: formData,
      }
    )

    // 处理异常响应
    const text = await response.text()
    if (text === 'Unauthorized' || text.includes('禁言') || text.includes('锁定')) {
      throw new Error(text === 'Unauthorized' ? '未授权' : text)
    }

    let res
    try {
      res = JSON.parse(text)
    } catch {
      throw new Error('图片上传失败: ' + text)
    }

    // 新版返回格式: { url: "/img/xxx", result: "https://..." }
    // 旧版返回格式: [0, url, id] 或 [1, error_message]
    const imageUrl = res.result || (Array.isArray(res) ? (res[0] === 1 ? null : res[1] || `https://image-static.segmentfault.com/${res[2]}`) : null)
    if (!imageUrl) {
      throw new Error(Array.isArray(res) ? (res[1] || '图片上传失败') : '图片上传失败')
    }
    return { url: imageUrl }
  }

  /**
   * 发布文章
   *
   * 1. POST /gateway/draft 保存草稿（默认只做这一步）
   * 2. draftOnly === false 时，再 POST /gateway/article 把草稿发布出去
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      // 获取 session token
      this.sessionToken = await this.getSessionToken()

      // 优先使用 markdown，处理图片
      let content = article.markdown || article.html || ''
      content = await this.processImages(content, (src) => this.uploadImageByUrl(src))

      const postData = {
        title: article.title,
        tags: [],
        text: content,
        object_id: '',
        type: 'article',
      }

      const res = await this.gatewayPost('https://segmentfault.com/gateway/draft', postData)

      // 处理数组格式响应 [1, "error_message"] / [0, data]
      let draftId: string | undefined
      if (Array.isArray(res)) {
        if (res[0] === 1) {
          throw new Error(res[1] || '发布失败')
        }
        if (res[1]?.id) draftId = String(res[1].id)
      }

      if (!draftId) {
        if (!res.id) {
          // 尝试多种错误字段
          const errorMsg = res.message || res.msg || res.error || res.errMsg || JSON.stringify(res)
          throw new Error(errorMsg)
        }
        draftId = String(res.id)
      }

      const draftUrl = `https://segmentfault.com/write?draftId=${draftId}`

      return this.finishWithPublish({ postId: draftId, postUrl: draftUrl }, options, async () => {
        const articleId = await this.publishDraft(article, content, draftId!)
        return { postId: articleId, postUrl: `https://segmentfault.com/a/${articleId}` }
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 调用思否 gateway 接口（JSON），统一处理未授权 / 禁言等纯文本响应
   */
  private async gatewayPost(url: string, body: unknown): Promise<any> {
    const response = await this.runtime.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        token: this.sessionToken || '',
        accept: '*/*',
      },
      body: JSON.stringify(body),
    })

    // 处理异常响应
    const text = await response.text()
    if (text === 'Unauthorized' || text.includes('禁言') || text.includes('锁定')) {
      throw new Error(text === 'Unauthorized' ? '未授权' : text)
    }

    try {
      return JSON.parse(text)
    } catch {
      throw new Error('发布失败: ' + text)
    }
  }

  /**
   * 把标签名解析为思否标签 ID
   *
   * GET /gateway/tags?query=search&q=<name> → { rows: [{ id, name }] }
   * 优先取名称完全一致（忽略大小写）的标签，否则取搜索结果第一条。
   */
  private async resolveTagIds(names: string[]): Promise<{ ids: string[]; missing: string[] }> {
    const ids: string[] = []
    const missing: string[] = []

    for (const name of names) {
      const response = await this.runtime.fetch(
        `https://segmentfault.com/gateway/tags?query=search&q=${encodeURIComponent(name)}`,
        {
          credentials: 'include',
          headers: { token: this.sessionToken || '', accept: '*/*' },
        }
      )
      let rows: Array<{ id?: string | number; name?: string }> = []
      try {
        const data = await response.json() as { rows?: typeof rows }
        rows = Array.isArray(data?.rows) ? data.rows : []
      } catch {
        rows = []
      }
      const lower = name.toLowerCase()
      const hit = rows.find(r => r.name?.toLowerCase() === lower) || rows[0]
      if (hit?.id != null) {
        const id = String(hit.id)
        if (!ids.includes(id)) ids.push(id)
      } else {
        missing.push(name)
      }
    }

    return { ids, missing }
  }

  /**
   * 发布草稿
   *
   * POST https://segmentfault.com/gateway/article （header: token）
   * body: { tags: [tagId], title, text, draft_id, blog_id: '0', type, url, cover, license, log }
   * - type: 1 原创 / 2 转载 / 3 翻译，默认 1（原创）
   * - blog_id: '0' 表示不投稿到专栏
   * - license: 1（沿用编辑器默认的版权声明）
   * 成功返回 HTTP 201，文章 ID 在 id 或 data.id；文章链接为 https://segmentfault.com/a/{id}
   * 参考：https://github.com/AndrewAndrea/FreeOpenWrite/blob/master/app_doc/spider/segfault_publish.py
   */
  private async publishDraft(article: Article, content: string, draftId: string): Promise<string> {
    // 思否发布文章至少需要 1 个标签，最多 5 个
    const tagNames = (article.tags || []).map(t => t.trim()).filter(Boolean).slice(0, 5)
    if (tagNames.length === 0) {
      throw new Error('思否发布文章至少需要 1 个标签，请在 frontmatter 中设置 tags')
    }

    const { ids: tagIds, missing } = await this.resolveTagIds(tagNames)
    if (tagIds.length === 0) {
      throw new Error(`思否未找到标签「${missing.join('、')}」，请在 frontmatter 的 tags 中使用思否已有的标签`)
    }

    // 封面：可选，上传到思否图床后使用；上传失败不影响发布
    let cover = ''
    if (article.cover) {
      try {
        cover = (await this.uploadImageByUrl(article.cover)).url
      } catch {
        cover = ''
      }
    }

    const res = await this.gatewayPost('https://segmentfault.com/gateway/article', {
      tags: tagIds,
      title: article.title,
      text: content,
      draft_id: draftId,
      blog_id: '0',
      type: 1,
      url: '',
      cover,
      license: 1,
      log: '',
    })

    if (Array.isArray(res)) {
      if (res[0] === 1) throw new Error(res[1] || '发布失败')
      if (res[1]?.id) return String(res[1].id)
    }

    const id = res?.data?.id ?? res?.id
    if (!id) {
      const errorMsg = res?.message || res?.msg || res?.error || res?.errMsg || JSON.stringify(res)
      throw new Error(errorMsg)
    }
    return String(id)
  }
}

/**
 * 雪球适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import { Remarkable } from 'remarkable'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Xueqiu')

interface XueqiuUser {
  id: string
  screen_name: string
  photo_domain: string
  profile_image_url: string
}

export class XueqiuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'xueqiu',
    name: '雪球',
    icon: 'https://xqdoc.imedao.com/17aebcfb84a145d33fc18679.ico',
    homepage: 'https://mp.xueqiu.com/writeV2',
    capabilities: ['article', 'draft', 'publish', 'image_upload', 'cover'],
  }

  /** 预处理配置: 雪球使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
    // doPreFilter + processDocCode (旧版)
    removeSpecialTags: true,
    removeSpecialTagsWithParent: true,
    processCodeBlocks: true,
  }

  private currentUser: XueqiuUser | null = null

  /** 雪球 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.xueqiu.com/xq/*',
      headers: {
        'Origin': 'https://mp.xueqiu.com',
        'Referer': 'https://mp.xueqiu.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(
        'https://mp.xueqiu.com/writeV2',
        {
          method: 'GET',
          credentials: 'include',
        }
      )

      const html = await response.text()

      // 解析 window.UOM_CURRENTUSER - 新版格式
      const userMatch = html.match(/window\.UOM_CURRENTUSER\s*=\s*(\{[\s\S]*?\})\s*<\/script>/)
      if (!userMatch) {
        return { isAuthenticated: false }
      }

      try {
        const state = JSON.parse(userMatch[1])
        const { currentUser } = state

        if (!currentUser?.id) {
          return { isAuthenticated: false }
        }

        this.currentUser = currentUser

        const avatar = currentUser.photo_domain && currentUser.profile_image_url
          ? `https:${currentUser.photo_domain}${currentUser.profile_image_url.split(',')[0]}`
          : ''

        return {
          isAuthenticated: true,
          userId: String(currentUser.id),
          username: currentUser.screen_name,
          avatar,
        }
      } catch (e) {
        logger.error(' Failed to parse user data:', e)
        return { isAuthenticated: false }
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      // 1. 确保已登录
      if (!this.currentUser) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录雪球')
        }
      }

      // Use pre-processed markdown content directly
      let markdown = article.markdown || ''

      // Process images in markdown
      markdown = await this.processImages(
        markdown,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['xueqiu.com', 'imedao.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // Convert Markdown to simplified HTML (Xueqiu format)
      const md = new Remarkable({
        html: true,
        breaks: true,
      })

      // 自定义渲染规则适配雪球格式
      // 所有标题都转为 h4
      md.renderer.rules.heading_open = () => '<h4>'
      md.renderer.rules.heading_close = () => '</h4>'

      // strong -> b
      md.renderer.rules.strong_open = () => '<b>'
      md.renderer.rules.strong_close = () => '</b>'

      // em -> i
      md.renderer.rules.em_open = () => '<i>'
      md.renderer.rules.em_close = () => '</i>'

      // 列表 - 移除列表包装，列表项内的 p 标签由 remarkable 自动处理
      md.renderer.rules.bullet_list_open = () => ''
      md.renderer.rules.bullet_list_close = () => ''
      md.renderer.rules.ordered_list_open = () => ''
      md.renderer.rules.ordered_list_close = () => ''
      md.renderer.rules.list_item_open = () => ''
      md.renderer.rules.list_item_close = () => ''

      // 移除 hr
      md.renderer.rules.hr = () => ''

      // 图片添加 class
      md.renderer.rules.image = (tokens: any[], idx: number) => {
        const src = tokens[idx].src || ''
        const alt = tokens[idx].alt || ''
        return `<img src="${src}" alt="${alt}" class="ke_img">`
      }

      let rendered = md.render(markdown)

      // Clean up: remove empty p tags and excessive newlines
      rendered = rendered
        .replace(/<p>\s*<\/p>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()

      const content = rendered

      // 4. 保存草稿
      const formData = new URLSearchParams({
        text: content,
        title: article.title,
        cover_pic: '',
        flags: 'false',
        original_event: '',
        status_id: '',
        legal_user_visible: 'false',
        is_private: 'false',
      })

      const response = await this.runtime.fetch(
        'https://mp.xueqiu.com/xq/statuses/draft/save.json',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData,
        }
      )

      const res = await response.json() as {
        id?: string | number
        error_description?: string
      }

      logger.debug(' Save response:', res)

      if (!res.id) {
        throw new Error(res.error_description || '保存失败')
      }

      const postId = res.id
      const draftUrl = `https://mp.xueqiu.com/write/draft/${postId}`

      return this.finishWithPublish({ postId: String(postId), postUrl: draftUrl }, options, () =>
        this.publishLongText(String(postId), article, content)
      )
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  // ============ 直接发布 ============

  /**
   * 直接发布长文（草稿已保存后调用）
   *
   * 雪球发帖接口需要一次性 session_token（公开逆向资料，xueqiu.com 与 mp.xueqiu.com/xq/ 代理路径一致，
   * 草稿 /xq/statuses/draft/save.json、图片 /xq/photo/upload.json 同理）：
   *   1. GET  /xq/provider/session/token.json?api_path=/statuses/update.json → { session_token }
   *   2. POST /xq/statuses/update.json（x-www-form-urlencoded）
   *      title、status(HTML 正文)、cover_pic、show_cover_pic、original、session_token ...
   *      成功返回帖子对象 { id, user_id, ... }，失败返回 { error_description, error_code }
   *   公开链接：https://xueqiu.com/{user_id}/{id}
   *
   * 默认值：
   * - 封面可选：frontmatter cover 存在时上传并展示（show_cover_pic=1），否则不设封面
   * - 不声明原创（original=0、original_declare=0），公开可见（is_private=false）
   * - draft_id 指向刚保存的草稿，发布后由平台清理草稿
   */
  private async publishLongText(
    draftId: string,
    article: Article,
    content: string
  ): Promise<{ postId?: string; postUrl: string; message?: string }> {
    let coverPic = ''
    if (article.cover) {
      coverPic = /^https?:\/\//.test(article.cover) && /xueqiu\.com|imedao\.com/.test(article.cover)
        ? article.cover
        : (await this.uploadImageByUrl(article.cover)).url
    }

    const tokenRes = await this.runtime.fetch(
      `https://mp.xueqiu.com/xq/provider/session/token.json?api_path=${encodeURIComponent('/statuses/update.json')}&_=${Date.now()}`,
      { method: 'GET', credentials: 'include' }
    )
    const tokenData = await tokenRes.json() as { session_token?: string; error_description?: string }
    if (!tokenData.session_token) {
      throw new Error(tokenData.error_description || '获取发布令牌失败，请重新登录雪球')
    }

    const response = await this.runtime.fetch('https://mp.xueqiu.com/xq/statuses/update.json', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        title: article.title,
        status: content,
        cover_pic: coverPic,
        show_cover_pic: coverPic ? '1' : '0',
        original: '0',
        original_declare: '0',
        right: '0',
        legal_user_visible: 'false',
        is_private: 'false',
        draft_id: draftId,
        session_token: tokenData.session_token,
      }),
    })

    const res = await response.json() as {
      id?: string | number
      user_id?: string | number
      user?: { id?: string | number }
      error_description?: string
      error_code?: string | number
    }

    logger.debug(' Publish response:', res)

    if (!res.id) {
      throw new Error(res.error_description || '发布失败')
    }

    // publish() 开头已确保登录，currentUser 一定存在
    const userId = res.user_id ?? res.user?.id ?? this.currentUser!.id
    return { postId: String(res.id), postUrl: `https://xueqiu.com/${userId}/${res.id}` }
  }

  /**
   * 通过 URL 上传图片
   */
  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    // 1. 下载图片
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 2. 上传到雪球
    const formData = new FormData()
    formData.append('file', imageBlob, 'image.jpg')

    const uploadResponse = await this.runtime.fetch(
      'https://mp.xueqiu.com/xq/photo/upload.json',
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )

    const res = await uploadResponse.json() as {
      url?: string
      filename?: string
    }

    logger.debug(' Image upload response:', res)

    if (!res.url || !res.filename) {
      throw new Error('图片上传失败')
    }

    // 雪球返回的 url 是 //开头，需要加 https:
    const fullUrl = res.url.startsWith('//') ? `https:${res.url}/${res.filename}` : `${res.url}/${res.filename}`

    return {
      url: fullUrl,
    }
  }
}

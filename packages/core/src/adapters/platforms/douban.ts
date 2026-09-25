/**
 * 豆瓣适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { DoubanImageData } from '../../lib'
import type { PublishOptions } from '../types'
import { markdownToDraft } from '../../lib'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Douban')

interface DoubanFormData {
  note_id: string
  ck: string
  /** 编辑页表单的提交 action（创建页为 new），发布时需要 */
  action?: string
}

interface DoubanPostParams {
  siteCookie: {
    value: string
  }
}

export class DoubanAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'douban',
    name: '豆瓣',
    icon: 'https://www.douban.com/favicon.ico',
    homepage: 'https://www.douban.com/note/create',
    capabilities: ['article', 'draft', 'publish', 'image_upload', 'tags'],
  }

  /** 预处理配置: 豆瓣使用 Markdown 格式 (转换为 Draft.js) */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private username: string = ''
  private avatar: string = ''
  private formData: DoubanFormData | null = null
  private postParams: DoubanPostParams | null = null

  /** 豆瓣 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://www.douban.com/*',
      headers: {
        'Origin': 'https://www.douban.com',
        'Referer': 'https://www.douban.com',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(
        'https://www.douban.com/note/create',
        {
          method: 'GET',
          credentials: 'include',
        }
      )

      const html = await response.text()

      // 解析页面中的 JavaScript 变量
      const userNameMatch = html.match(/_USER_NAME\s*=\s*['"]([^'"]+)['"]/)
      const userAvatarMatch = html.match(/_USER_AVATAR\s*=\s*['"]([^'"]+)['"]/)
      const noteIdMatch = html.match(/name="note_id"\s+value="(\d+)"/)
      const ckMatch = html.match(/name="ck"\s+value="([^"]+)"/)

      // 解析 _POST_PARAMS
      const postParamsMatch = html.match(/_POST_PARAMS\s*=\s*(\{[\s\S]*?\});/)

      if (!userNameMatch || !noteIdMatch || !ckMatch) {
        return { isAuthenticated: false }
      }

      this.username = userNameMatch[1]
      this.avatar = userAvatarMatch ? userAvatarMatch[1] : ''
      const actionMatch = html.match(/name="action"\s+value="([^"]+)"/)
        || postParamsMatch?.[1].match(/['"]?action['"]?\s*:\s*['"]([^'"]+)['"]/)
      this.formData = {
        note_id: noteIdMatch[1],
        ck: ckMatch[1],
        action: actionMatch ? actionMatch[1] : undefined,
      }

      // 解析 _POST_PARAMS 获取 upload_auth_token
      if (postParamsMatch) {
        try {
          // 简化解析，只提取 siteCookie.value
          const siteCookieMatch = postParamsMatch[1].match(/siteCookie[^}]*value\s*:\s*['"]([^'"]+)['"]/)
          if (siteCookieMatch) {
            this.postParams = {
              siteCookie: { value: siteCookieMatch[1] }
            }
          }
        } catch (e) {
          logger.warn('Failed to parse _POST_PARAMS:', e)
        }
      }

      logger.debug('Auth info:', {
        username: this.username,
        noteId: this.formData.note_id,
        hasPostParams: !!this.postParams,
      })

      return {
        isAuthenticated: true,
        userId: this.username,
        username: this.username,
        avatar: this.avatar,
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
      if (!this.formData) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录豆瓣')
        }
      }

      // Use pre-processed markdown content directly
      let content = article.markdown || ''

      // Process images - collect full image data
      const imageDataMap = new Map<string, DoubanImageData>()
      content = await this.processImages(
        content,
        async (src) => {
          const result = await this.uploadImageWithFullData(src)
          // 保存完整图片数据，用 newUrl 作为 key
          imageDataMap.set(result.url, result.imageData)
          return result
        },
        {
          skipPatterns: ['doubanio.com', 'douban.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // Markdown to Draft.js format (pass in image data)
      const draftContent = markdownToDraft(content, imageDataMap)

      // 6. 保存草稿
      const response = await this.runtime.fetch(
        'https://www.douban.com/j/note/autosave',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            is_rich: '1',
            note_id: this.formData!.note_id,
            note_title: article.title,
            note_text: draftContent,
            introduction: '',
            note_privacy: 'P',
            cannot_reply: '',
            author_tags: '',
            accept_donation: '',
            donation_notice: '',
            is_original: '',
            ck: this.formData!.ck,
          }),
        }
      )

      const res = await response.json() as { url?: string; r?: number }
      logger.debug('Save response:', res)

      // 豆瓣草稿只能在 /note/create 页面查看
      const draftUrl = 'https://www.douban.com/note/create'

      return this.finishWithPublish({ postId: this.formData!.note_id, postUrl: draftUrl }, options, () =>
        this.publishNote(article, draftContent)
      )
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 发布日记
   *
   * POST https://www.douban.com/j/note/publish（与 /j/note/autosave 字段相同，外加表单的 action，
   * 创建页为 new），发布的就是创建页预分配的 note_id。
   * 成功返回 { r: 0, url }；r 非 0 表示失败。公开地址为 https://www.douban.com/note/{note_id}/
   * 可见范围固定为所有人可见（note_privacy=P）；frontmatter tags 作为作者标签（空格分隔）。
   */
  private async publishNote(
    article: Article,
    draftContent: string
  ): Promise<{ postId: string; postUrl: string }> {
    const form = this.formData!
    const noteId = form.note_id

    if (Array.from(article.title).length > 100) {
      throw new Error('豆瓣日记标题不能超过 100 字，请缩短标题')
    }

    const response = await this.runtime.fetch('https://www.douban.com/j/note/publish', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams({
        is_rich: '1',
        note_id: noteId,
        note_title: article.title,
        note_text: draftContent,
        introduction: '',
        note_privacy: 'P',
        cannot_reply: '',
        author_tags: (article.tags || []).join(' '),
        accept_donation: '',
        donation_notice: '',
        is_original: '',
        ck: form.ck,
        action: form.action || 'new',
      }),
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}，请打开豆瓣草稿检查是否已发布`)
    }

    const text = await response.text()
    let res: { r?: number | boolean; url?: string; err?: string; message?: string; msg?: string }
    try {
      res = JSON.parse(text)
    } catch {
      throw new Error('发布响应无法解析，可能需要验证码，请打开豆瓣草稿手动发布')
    }
    logger.debug('Publish response:', res)

    if (res.r !== 0 && res.r !== false) {
      throw new Error(res.message || res.err || res.msg || `发布失败 (r=${res.r ?? '缺失'})`)
    }

    // 预分配的 note_id 已被使用，下次同步需重新读取创建页
    this.formData = null

    let postUrl = `https://www.douban.com/note/${noteId}/`
    if (res.url) {
      try {
        postUrl = new URL(res.url, 'https://www.douban.com/note/create').href
      } catch {
        // 保留默认地址
      }
    }

    return { postId: noteId, postUrl }
  }

  /**
   * 上传图片并返回完整数据
   */
  private async uploadImageWithFullData(src: string): Promise<ImageUploadResult & { imageData: DoubanImageData }> {
    if (!this.formData || !this.postParams) {
      throw new Error('未获取上传凭证')
    }

    // 1. 下载图片
    const imageResponse = await fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    // 2. 上传到豆瓣
    const formData = new FormData()
    formData.append('note_id', this.formData.note_id)
    formData.append('image_file', imageBlob, 'image.jpg')
    formData.append('ck', this.formData.ck)
    formData.append('upload_auth_token', this.postParams.siteCookie.value)

    const uploadResponse = await this.runtime.fetch(
      'https://www.douban.com/j/note/add_photo',
      {
        method: 'POST',
        credentials: 'include',
        body: formData,
      }
    )

    const res = await uploadResponse.json() as {
      photo?: {
        id: string
        url: string
        thumb: string
        width: number
        height: number
        file_name: string
        file_size: number
      }
    }

    logger.debug('Image upload response:', res)

    if (!res.photo?.url) {
      throw new Error('图片上传失败')
    }

    const photo = res.photo

    // 返回带完整图片数据
    return {
      url: photo.url,
      imageData: {
        id: photo.id,
        url: photo.url,
        thumb: photo.thumb,
        width: photo.width,
        height: photo.height,
        file_name: photo.file_name,
        file_size: photo.file_size,
      }
    }
  }
}

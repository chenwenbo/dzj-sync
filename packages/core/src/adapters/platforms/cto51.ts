/**
 * 51CTO 适配器
 * https://blog.51cto.com
 *
 * 新版图片上传流程:
 * 1. getUploadSign - 获取上传签名
 * 2. getUploadConfig - 获取腾讯云 COS 上传凭证
 * 3. 上传到腾讯云 COS
 */
import { CodeAdapter, ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { buildSummary } from '../../lib'

interface UploadSignResponse {
  code: number
  msg: string
  data: {
    allows: string
    sizeLimit: number
    sizeLimitMessage: string
    url: string
    sign: string
  }
}

interface UploadConfigResponse {
  code: number
  msg: string
  data: {
    url: string
    fields: {
      key: string
      policy: string
      'x-amz-algorithm': string
      'x-amz-signature': string
      'x-amz-credential': string
      'X-Amz-Date': string
    }
  }
}

export class Cto51Adapter extends CodeAdapter {
  meta: PlatformMeta = {
    id: '51cto',
    name: '51CTO',
    icon: 'https://blog.51cto.com/favicon.ico',
    homepage: 'https://blog.51cto.com/blogger/publish',
    capabilities: ['article', 'draft', 'publish', 'image_upload'],
  }

  /** 预处理配置: 51CTO 使用 Markdown 格式 */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private csrf: string | null = null
  private username: string | null = null

  /** 51CTO API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://blog.51cto.com/*',
      headers: {
        Origin: 'https://blog.51cto.com',
        Referer: 'https://blog.51cto.com/blogger/publish',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  /**
   * 检查登录状态
   */
  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch('https://blog.51cto.com/blogger/publish', {
        credentials: 'include',
      })
      const html = await response.text()

      // 解析页面获取用户信息
      const imgMatch = html.match(/<li class="more user">\s*<a[^>]*href="([^"]+)"[^>]*>\s*<img[^>]*src="([^"]+)"/)
      if (!imgMatch) {
        return { isAuthenticated: false, error: '未登录' }
      }

      const userLink = imgMatch[1]
      const avatar = imgMatch[2]
      const uid = userLink.split('/').filter(Boolean).pop() || ''
      this.username = uid || null

      // 获取 csrf token
      const csrfMatch = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/)
      if (csrfMatch) {
        this.csrf = csrfMatch[1]
      }

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
   * 获取上传签名
   */
  private async getUploadSign(): Promise<UploadSignResponse['data']> {
    const response = await this.runtime.fetch('https://blog.51cto.com/getUploadSign', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://blog.51cto.com/blogger/publish',
        'Origin': 'https://blog.51cto.com',
      },
      body: 'upload_type=image',
    })

    const res: UploadSignResponse = await response.json()
    if (res.code !== 0) {
      throw new Error(res.msg || '获取上传签名失败')
    }
    return res.data
  }

  /**
   * 获取上传配置 (腾讯云 COS 凭证)
   */
  private async getUploadConfig(
    uploadSign: string,
    ext: string,
    filename: string
  ): Promise<UploadConfigResponse['data']> {
    const response = await this.runtime.fetch('https://blog.51cto.com/getUploadConfig', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: new URLSearchParams({
        upload_type: 'image',
        upload_sign: uploadSign,
        ext: ext,
        name: filename,
      }).toString(),
    })

    const res: UploadConfigResponse = await response.json()
    if (res.code !== 0) {
      throw new Error(res.msg || '获取上传配置失败')
    }
    return res.data
  }

  /**
   * 上传图片到腾讯云 COS
   */
  private async uploadToCOS(
    cosUrl: string,
    fields: UploadConfigResponse['data']['fields'],
    file: File
  ): Promise<string> {
    const formData = new FormData()

    // 按顺序添加字段 (顺序很重要)
    formData.append('key', fields.key)
    formData.append('policy', fields.policy)
    formData.append('x-amz-algorithm', fields['x-amz-algorithm'])
    formData.append('x-amz-signature', fields['x-amz-signature'])
    formData.append('x-amz-credential', fields['x-amz-credential'])
    formData.append('X-Amz-Date', fields['X-Amz-Date'])
    formData.append('Content-Type', file.type)
    formData.append('file', file)

    const response = await this.runtime.fetch(cosUrl, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      throw new Error(`上传到 COS 失败: ${response.status}`)
    }

    // 返回图片 URL (通过 51cto CDN)
    return `https://s2.51cto.com/${fields.key}`
  }

  /**
   * 上传图片
   */
  async uploadImageByUrl(url: string): Promise<ImageUploadResult> {
    // 下载图片
    const imageResponse = await this.runtime.fetch(url)
    const blob = await imageResponse.blob()

    // 确定文件扩展名和 MIME 类型
    const mimeType = blob.type || 'image/jpeg'
    const ext = mimeType.split('/')[1] || 'jpeg'
    const filename = `${Date.now()}.${ext}`
    const file = new File([blob], filename, { type: mimeType })

    // Step 1: 获取上传签名
    const signData = await this.getUploadSign()

    // Step 2: 获取上传配置
    const configData = await this.getUploadConfig(signData.sign, mimeType, filename)

    // Step 3: 上传到腾讯云 COS
    const imageUrl = await this.uploadToCOS(configData.url, configData.fields, file)

    return { url: imageUrl }
  }

  /**
   * 发布文章
   *
   * 1. POST /blogger/draft 保存草稿（默认只做这一步）
   * 2. draftOnly === false 时，再 POST /blogger/publish（check=1）把草稿发布出去
   */
  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      // 确保已获取 csrf
      if (!this.csrf) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('未登录')
        }
      }

      // 优先使用 markdown，处理图片
      const hasMarkdown = !!article.markdown
      let content = article.markdown || article.html || ''
      content = await this.processImages(content, (src) => this.uploadImageByUrl(src))

      // 构建请求数据
      const postData: Record<string, string> = {
        title: article.title,
        content: content,
        pid: '',
        cate_id: '',
        custom_id: '0',
        tag: '',
        abstract: '',
        banner_type: '0',
        blog_type: '1',
        copy_code: '1',
        is_hide: '0',
        top_time: '0',
        is_comment: '0',
        is_old: hasMarkdown ? '0' : '2',
        blog_id: '',
        did: '',
        work_id: '',
        class_id: '',
        subjectId: '',
        import_type: '-1',
        invite_code: '',
        raffle: '',
        orig: '',
        _csrf: this.csrf || '',
      }

      const response = await this.runtime.fetch('https://blog.51cto.com/blogger/draft', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
        },
        body: new URLSearchParams(postData).toString(),
      })

      const res = await response.json()

      if (res.status !== 1 || !res.data) {
        throw new Error(res.msg || '发布失败')
      }

      const draftId = String(res.data.did)
      const draftUrl = `https://blog.51cto.com/blogger/draft/${draftId}`

      return this.finishWithPublish({ postId: draftId, postUrl: draftUrl }, options, async () => {
        return this.publishDraft(article, postData, draftId)
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 从写文章页面解析分类列表和 51CTO 记住的默认分类
   *
   * - 分类项形如 <div class="select_item" value="8">Java</div>（ID 在 value 属性上）
   * - 默认值来自页面内联脚本里的 submitForm（pid / cate_id，即上次使用的分类）
   * 解析失败时返回空，交给 51CTO 服务端校验并返回错误信息。
   */
  private parsePublishPage(html: string): {
    categories: Array<{ id: string; name: string }>
    defaultPid: string
    defaultCateId: string
  } {
    const categories: Array<{ id: string; name: string }> = []
    const itemRe = /<([a-z]+)\b([^>]*\bclass="[^"]*\bselect_item\b[^"]*"[^>]*)>([\s\S]*?)<\/\1>/gi
    let m: RegExpExecArray | null
    while ((m = itemRe.exec(html))) {
      const valueMatch = m[2].match(/\b(?:value|data-id)="(\d+)"/)
      const name = m[3].replace(/<[^>]+>/g, '').trim()
      if (valueMatch && name) categories.push({ id: valueMatch[1], name })
    }

    let defaultPid = ''
    let defaultCateId = ''
    const formMatch = html.match(/submitForm\s*=\s*\{([\s\S]*?)\}/)
    if (formMatch) {
      defaultPid = formMatch[1].match(/\bpid['"]?\s*:\s*['"]?(\d+)/)?.[1] || ''
      defaultCateId = formMatch[1].match(/\bcate_id['"]?\s*:\s*['"]?(\d+)/)?.[1] || ''
    }

    return { categories, defaultPid, defaultCateId }
  }

  /**
   * 发布草稿
   *
   * POST https://blog.51cto.com/blogger/publish（表单，X-Requested-With + _csrf）
   * 字段与 /blogger/draft 相同，另加：did = 草稿 ID、tag = 逗号分隔的标签名、
   * pid / cate_id = 分类、abstract = 摘要、check = 1（表示正式发布）
   * - blog_type: '1' 博客（'0' 为动态）；原创默认
   * 成功响应 { status: 1, msg: 'success', data: { blog_id, request } }
   * 注意 data.did 是草稿 ID，文章链接需用 blog_id：https://blog.51cto.com/{username}/{blog_id}
   * 参考：https://github.com/addozhang/omnipub/blob/main/extension/background/service-worker.js （51cto_directPublish）
   */
  private async publishDraft(
    article: Article,
    draftData: Record<string, string>,
    draftId: string
  ): Promise<{ postId: string; postUrl: string; message?: string }> {
    // 51CTO 发布必须填写标签（最多 5 个）
    const tags = (article.tags || []).map(t => t.trim()).filter(Boolean).slice(0, 5)
    if (tags.length === 0) {
      throw new Error('51CTO 发布文章必须填写标签，请在 frontmatter 中设置 tags')
    }

    // 重新读取写文章页：刷新 csrf，获取分类列表与默认分类
    const pageResponse = await this.runtime.fetch('https://blog.51cto.com/blogger/publish', {
      credentials: 'include',
    })
    const html = await pageResponse.text()
    const csrfMatch = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/)
    if (csrfMatch) this.csrf = csrfMatch[1]
    const userLink = html.match(/<li class="more user">\s*<a[^>]*href="([^"]+)"/)?.[1]
    if (userLink) this.username = userLink.split('/').filter(Boolean).pop() || this.username
    const { categories, defaultPid, defaultCateId } = this.parsePublishPage(html)

    // 分类：frontmatter category 与 51CTO 分类同名时使用，否则沿用 51CTO 记住的上次分类
    const pid = defaultPid
    let cateId = defaultCateId
    let message: string | undefined
    const wanted = article.category?.trim()
    if (wanted) {
      const hit = categories.find(c => c.name === wanted)
      if (hit) {
        cateId = hit.id
      } else {
        message = `51CTO 未找到分类「${wanted}」，已使用默认分类`
      }
    }
    // 与编辑器行为一致：cate_id 为空时回退为 pid
    if (!cateId) cateId = pid

    const body: Record<string, string> = {
      ...draftData,
      pid,
      cate_id: cateId,
      tag: tags.join(','),
      abstract: buildSummary(article, 200),
      img_urls: '',
      did: draftId,
      check: '1',
      _csrf: this.csrf || '',
    }

    const response = await this.runtime.fetch('https://blog.51cto.com/blogger/publish', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
      body: new URLSearchParams(body).toString(),
    })

    let res: { status?: number; msg?: string; data?: { blog_id?: string | number; request?: string } }
    try {
      res = await response.json()
    } catch {
      throw new Error(`发布接口返回异常（HTTP ${response.status}）`)
    }

    const blogId = res?.data?.blog_id
    if (res?.status !== 1 || !blogId) {
      // 页面上解析不到分类时交由服务端校验，失败时提示用户显式指定分类
      const hint = cateId ? '' : '（未能确定分类，请在 frontmatter 的 category 中填写 51CTO 的分类名称）'
      throw new Error((res?.msg || '发布失败') + hint)
    }

    const postUrl = this.username
      ? `https://blog.51cto.com/${this.username}/${blogId}`
      : (res.data?.request || `https://blog.51cto.com/blogger/success/${blogId}`)
    return { postId: String(blogId), postUrl, message }
  }
}

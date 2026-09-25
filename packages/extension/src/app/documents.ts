/**
 * Markdown 文档加载与文章准备
 *
 * - 读取用户选择的 .md 文件（可同时选择图片或整个文件夹）
 * - 解析 frontmatter / 标题
 * - 本地相对路径图片替换为占位 URL，图片数据只传一份，由 Background 替换为 data URI 后交给适配器上传
 * - 渲染 HTML，并按平台预处理配置生成各平台内容
 */
import {
  markdownToHtml,
  parseMarkdownDocument,
  resolveLocalImages,
  normalizeLocalPath,
  isLocalImagePath,
  parseMarkdownImages,
} from '@wechatsync/core'
import { getPlatformPreprocessConfigs } from '../adapters'
import { preprocessForPlatform } from '../lib/content-processor'
import { LOCAL_IMAGE_PREFIX, type PlatformContent, type SyncArticlePayload } from '../lib/messages'

const MARKDOWN_EXT = /\.(md|markdown|mdx|txt)$/i
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i

/** 可编辑的文章元信息 */
export interface DocumentMeta {
  title: string
  summary: string
  cover: string
  tags: string
  category: string
}

export interface MarkdownDoc {
  id: string
  fileName: string
  /** 文件在所选文件夹中的相对路径（用于解析相对图片路径） */
  path: string
  /** 正文 Markdown（不含 frontmatter） */
  markdown: string
  meta: DocumentMeta
  /** 找不到对应文件的本地图片 */
  missingImages: string[]
}

/** 本地图片文件：规范化后的相对路径 → File */
export type ImageFiles = Map<string, File>

function filePath(file: File): string {
  return normalizeLocalPath((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name)
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * 解析相对 md 文件所在目录的路径（处理 ./ 和 ../）
 */
function joinPath(dir: string, relative: string): string {
  const parts = dir ? dir.split('/') : []
  for (const segment of relative.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') parts.pop()
    else parts.push(segment)
  }
  return parts.join('/')
}

/**
 * 在已选择的图片中查找 Markdown 引用的本地图片
 * 先按相对路径精确匹配，再按文件名匹配
 */
export function findImageFile(images: ImageFiles, docPath: string, src: string): File | undefined {
  const cleaned = src.trim().split(/[?#]/)[0]
  let decoded = cleaned
  try {
    decoded = decodeURIComponent(cleaned)
  } catch {
    // 保留原值
  }

  const exact = images.get(joinPath(dirname(docPath), decoded))
  if (exact) return exact

  const name = basename(normalizeLocalPath(decoded))
  for (const [path, file] of images) {
    if (basename(path) === name) return file
  }
  return undefined
}

function collectMissingImages(markdown: string, docPath: string, images: ImageFiles): string[] {
  const missing = new Set<string>()
  for (const match of parseMarkdownImages(markdown)) {
    if (isLocalImagePath(match.src) && !findImageFile(images, docPath, match.src)) {
      missing.add(match.src)
    }
  }
  return [...missing]
}

/**
 * 读取用户选择的文件，拆分为 Markdown 文档与图片
 */
export async function loadFiles(
  files: File[],
  existingImages: ImageFiles
): Promise<{ docs: MarkdownDoc[]; images: ImageFiles }> {
  const images: ImageFiles = new Map(existingImages)
  for (const file of files) {
    if (IMAGE_EXT.test(file.name) || file.type.startsWith('image/')) {
      images.set(filePath(file), file)
    }
  }

  const docs: MarkdownDoc[] = []
  for (const file of files) {
    if (!MARKDOWN_EXT.test(file.name)) continue
    const path = filePath(file)
    const parsed = parseMarkdownDocument(await file.text(), file.name)
    docs.push({
      id: `${path}:${file.lastModified}:${Math.random().toString(36).slice(2, 8)}`,
      fileName: file.name,
      path,
      markdown: parsed.markdown,
      meta: {
        title: parsed.title,
        summary: parsed.summary || '',
        cover: parsed.cover || '',
        tags: parsed.tags.join(', '),
        category: parsed.category || '',
      },
      missingImages: collectMissingImages(parsed.markdown, path, images),
    })
  }

  return { docs, images }
}

/**
 * 新增图片后重新计算缺失图片
 */
export function refreshMissingImages(docs: MarkdownDoc[], images: ImageFiles): MarkdownDoc[] {
  return docs.map(doc => ({ ...doc, missingImages: collectMissingImages(doc.markdown, doc.path, images) }))
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/**
 * 把本地图片替换为 toUrl 返回的 URL（同步时为占位 URL，预览时为 object URL）
 */
async function inlineImages(
  doc: MarkdownDoc,
  images: ImageFiles,
  toUrl: (file: File) => Promise<string> | string
): Promise<string> {
  const urls = new Map<string, string>()
  for (const match of parseMarkdownImages(doc.markdown)) {
    if (!isLocalImagePath(match.src)) continue
    const file = findImageFile(images, doc.path, match.src)
    if (file) urls.set(normalizeLocalPath(match.src), await toUrl(file))
  }
  return resolveLocalImages(doc.markdown, path => urls.get(path)).markdown
}

/**
 * 为本地图片分配占位 URL，同一文件只读取一次
 */
function createImageRegistry() {
  const placeholders = new Map<File, string>()
  const images: Record<string, string> = {}
  return {
    images,
    async placeholder(file: File): Promise<string> {
      let url = placeholders.get(file)
      if (!url) {
        url = `${LOCAL_IMAGE_PREFIX}${placeholders.size}`
        placeholders.set(file, url)
        images[url] = await readAsDataUrl(file)
      }
      return url
    },
  }
}

/**
 * 生成预览 HTML（本地图片使用 object URL）
 */
export async function renderPreview(doc: MarkdownDoc, images: ImageFiles, objectUrls: Map<File, string>): Promise<string> {
  const markdown = await inlineImages(doc, images, file => {
    let url = objectUrls.get(file)
    if (!url) {
      url = URL.createObjectURL(file)
      objectUrls.set(file, url)
    }
    return url
  })
  return markdownToHtml(markdown)
}

export function parseTags(tags: string): string[] {
  return tags.split(/[,，]/).map(t => t.trim()).filter(Boolean)
}

/**
 * 生成发送给 Background 的同步数据
 * @param platformIds 选中的内置平台（自建站不需要预处理）
 */
export async function buildArticlePayload(
  doc: MarkdownDoc,
  images: ImageFiles,
  platformIds: string[]
): Promise<SyncArticlePayload['article']> {
  const registry = createImageRegistry()
  const markdown = await inlineImages(doc, images, file => registry.placeholder(file))
  const html = markdownToHtml(markdown)

  let cover = doc.meta.cover.trim()
  if (cover && isLocalImagePath(cover)) {
    const file = findImageFile(images, doc.path, cover)
    cover = file ? await registry.placeholder(file) : ''
  }

  // Markdown 平台直接使用原文，避免 HTML ↔ Markdown 往返造成格式损失；HTML 平台按配置预处理
  const platformContents: Record<string, PlatformContent> = {}
  const configs = getPlatformPreprocessConfigs(platformIds)
  for (const [platformId, config] of Object.entries(configs)) {
    if (config.outputFormat !== 'markdown') {
      platformContents[platformId] = { html: preprocessForPlatform(html, config), markdown }
    }
  }

  return {
    title: doc.meta.title.trim() || doc.fileName,
    markdown,
    html,
    summary: doc.meta.summary.trim() || undefined,
    cover: cover || undefined,
    tags: parseTags(doc.meta.tags),
    category: doc.meta.category.trim() || undefined,
    platformContents,
    images: registry.images,
  }
}

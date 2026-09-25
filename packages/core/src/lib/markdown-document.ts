/**
 * Markdown 文档解析
 *
 * 把用户上传的 .md 文件解析为可同步的文章：
 * - 解析 YAML frontmatter（title / tags / category / summary / cover 等）
 * - 标题优先级：frontmatter.title > 第一个一级标题 > 文件名
 * - 本地相对路径图片可通过 resolveLocalImages 替换为 data URI
 */
import { parse as parseYaml } from 'yaml'
import { parseMarkdownImages } from './markdown-images'

export interface MarkdownDocument {
  /** 文章标题 */
  title: string
  /** 正文 Markdown（已去除 frontmatter，以及被用作标题的一级标题） */
  markdown: string
  summary?: string
  cover?: string
  tags: string[]
  category?: string
  /** 原始 frontmatter */
  frontmatter: Record<string, unknown>
}

const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

/**
 * 拆分 frontmatter 与正文
 */
export function splitFrontmatter(source: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = source.match(FRONTMATTER_RE)
  if (!match) {
    return { frontmatter: {}, body: source.replace(/^﻿/, '') }
  }

  let frontmatter: Record<string, unknown> = {}
  try {
    const parsed = parseYaml(match[1])
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>
    }
  } catch {
    // frontmatter 格式错误时忽略，正文照常使用
  }

  return { frontmatter, body: source.slice(match[0].length) }
}

function pickString(fm: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = fm[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return undefined
}

function pickList(fm: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = fm[key]
    if (Array.isArray(value)) {
      return value.map(v => String(v).trim()).filter(Boolean)
    }
    if (typeof value === 'string' && value.trim()) {
      return value.split(/[,，]/).map(v => v.trim()).filter(Boolean)
    }
  }
  return []
}

/**
 * 解析 Markdown 文档
 * @param source 文件原始内容
 * @param filename 文件名（无标题时作为回退）
 */
export function parseMarkdownDocument(source: string, filename = ''): MarkdownDocument {
  const { frontmatter, body } = splitFrontmatter(source)
  let markdown = body.replace(/\r\n/g, '\n')

  let title = pickString(frontmatter, ['title'])
  if (!title) {
    // 使用正文第一个非空行的一级标题作为文章标题，并从正文移除，避免重复
    const h1 = markdown.match(/^\s*#[ \t]+(.+?)[ \t#]*(?:\n|$)/)
    if (h1) {
      title = h1[1].trim()
      markdown = markdown.slice(h1[0].length)
    }
  }
  if (!title) {
    title = filename.replace(/\.(md|markdown|mdx|txt)$/i, '').trim() || '未命名文章'
  }

  const categories = pickList(frontmatter, ['categories'])

  return {
    title,
    markdown: markdown.trim() + '\n',
    summary: pickString(frontmatter, ['summary', 'description', 'excerpt', 'abstract']),
    cover: pickString(frontmatter, ['cover', 'image', 'thumbnail', 'banner', 'cover_image']),
    tags: pickList(frontmatter, ['tags', 'tag', 'keywords']),
    category: pickString(frontmatter, ['category']) ?? categories[0],
    frontmatter,
  }
}

/**
 * 是否是需要从本地解析的图片路径（非 http(s) / data / blob / 协议相对 URL）
 */
export function isLocalImagePath(src: string): boolean {
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src.trim())
}

/**
 * 规范化本地路径，便于和上传的文件名匹配
 * "./images/a.png" → "images/a.png"，"../a%20b.png" → "a b.png"
 */
export function normalizeLocalPath(path: string): string {
  let p = path.trim().split(/[?#]/)[0]
  try {
    p = decodeURIComponent(p)
  } catch {
    // 保留原值
  }
  return p.replace(/\\/g, '/').replace(/^(?:\.\.?\/)+/, '').replace(/^\/+/, '')
}

/**
 * 替换 Markdown 中的本地图片
 * @param markdown 正文
 * @param resolve 根据规范化后的相对路径返回新的 URL（如 data URI），返回 undefined 表示找不到
 * @returns 替换后的正文，以及未能解析的本地图片路径
 */
export function resolveLocalImages(
  markdown: string,
  resolve: (normalizedPath: string) => string | undefined
): { markdown: string; missing: string[] } {
  const missing: string[] = []
  let result = markdown

  for (const match of parseMarkdownImages(markdown)) {
    if (!isLocalImagePath(match.src)) continue
    const url = resolve(normalizeLocalPath(match.src))
    if (url) {
      result = result.replace(match.full, `![${match.alt}](${url})`)
    } else if (!missing.includes(match.src)) {
      missing.push(match.src)
    }
  }

  return { markdown: result, missing }
}

/**
 * Markdown 转纯文本（用于自动生成摘要）
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~|]/g, '')
    .replace(/^-{3,}$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 生成摘要：优先使用 summary，否则从正文截取
 */
export function buildSummary(article: { summary?: string; markdown: string }, maxLength = 100): string {
  const text = (article.summary || markdownToPlainText(article.markdown)).trim()
  return Array.from(text).slice(0, maxLength).join('')
}

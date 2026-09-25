/**
 * 读取本地 Markdown / HTML 文件，并把本地图片内联为 data URI
 * （扩展会把 data URI 上传到各目标平台的图床）
 *
 * CLI 与 MCP 的 sync_markdown_file 共用
 */
import fs from 'fs'
import path from 'path'

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

export interface LoadedFile {
  format: 'markdown' | 'html'
  /** 文件内容（Markdown 保留 frontmatter，由扩展解析） */
  content: string
  /** 已内联的本地图片 */
  inlined: string[]
  /** 找不到或格式不支持的本地图片 */
  missing: string[]
}

function isRemote(src: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)
}

/**
 * 把本地图片路径转为 data URI，失败返回 null
 */
export function imageFileToDataUri(src: string, baseDir: string): string | null {
  let rel = src.trim().replace(/^<|>$/g, '').split(/[?#]/)[0]
  try {
    rel = decodeURIComponent(rel)
  } catch {
    // 保留原值
  }
  const abs = path.resolve(baseDir, rel)
  const mime = MIME_TYPES[path.extname(abs).toLowerCase()]
  if (!mime || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`
}

/**
 * 内联内容中的本地图片（Markdown ![](...)、HTML <img src>、frontmatter cover 等字段）
 */
export function inlineLocalImages(content: string, baseDir: string): { content: string; inlined: string[]; missing: string[] } {
  const inlined = new Set<string>()
  const missing = new Set<string>()

  const convert = (src: string): string | null => {
    if (!src || isRemote(src)) return null
    const dataUri = imageFileToDataUri(src, baseDir)
    if (dataUri) inlined.add(src)
    else missing.add(src)
    return dataUri
  }

  // Markdown 图片：![alt](path "title")
  let result = content.replace(/(!\[[^\]]*\]\()\s*(<[^>]+>|[^)\s]+)([^)]*\))/g, (full, head, src, tail) => {
    const dataUri = convert(src)
    return dataUri ? `${head}${dataUri}${tail}` : full
  })

  // HTML 图片：<img src="path">
  result = result.replace(/(<img\b[^>]*?\ssrc=)(["'])([^"']+)\2/gi, (full, head, quote, src) => {
    const dataUri = convert(src)
    return dataUri ? `${head}${quote}${dataUri}${quote}` : full
  })

  // frontmatter 中的封面图
  const fm = result.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    const replaced = fm[1].replace(
      /^((?:cover|image|thumbnail|banner|cover_image)[ \t]*:[ \t]*)(["']?)([^"'\r\n]+)\2[ \t]*$/gm,
      (full, head, _quote, src) => {
        const dataUri = convert(src.trim())
        return dataUri ? `${head}"${dataUri}"` : full
      }
    )
    result = result.replace(fm[1], () => replaced)
  }

  return { content: result, inlined: [...inlined], missing: [...missing] }
}

/**
 * 读取文件并内联本地图片
 */
export function loadArticleFile(filePath: string): LoadedFile {
  const abs = path.resolve(filePath)
  if (!fs.existsSync(abs)) {
    throw new Error(`File not found: ${abs}`)
  }
  const raw = fs.readFileSync(abs, 'utf-8')
  const ext = path.extname(abs).toLowerCase()
  const format = ext === '.html' || ext === '.htm' ? 'html' : 'markdown'
  const { content, inlined, missing } = inlineLocalImages(raw, path.dirname(abs))
  return { format, content, inlined, missing }
}

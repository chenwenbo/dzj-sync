import { describe, it, expect } from 'vitest'
import {
  parseMarkdownDocument,
  resolveLocalImages,
  isLocalImagePath,
  normalizeLocalPath,
  markdownToPlainText,
  buildSummary,
} from '../markdown-document'

describe('parseMarkdownDocument', () => {
  it('reads metadata from frontmatter', () => {
    const doc = parseMarkdownDocument(
      [
        '---',
        'title: Hello World',
        'tags: [JavaScript, 前端]',
        'category: 前端',
        'description: 一段摘要',
        'cover: ./cover.png',
        '---',
        '',
        '正文内容',
      ].join('\n'),
      'post.md'
    )
    expect(doc.title).toBe('Hello World')
    expect(doc.tags).toEqual(['JavaScript', '前端'])
    expect(doc.category).toBe('前端')
    expect(doc.summary).toBe('一段摘要')
    expect(doc.cover).toBe('./cover.png')
    expect(doc.markdown).toBe('正文内容\n')
  })

  it('accepts comma separated tags and categories list', () => {
    const doc = parseMarkdownDocument('---\ntags: a, b，c\ncategories:\n  - 后端\n  - 其他\n---\nbody')
    expect(doc.tags).toEqual(['a', 'b', 'c'])
    expect(doc.category).toBe('后端')
  })

  it('uses the first h1 as title and removes it from body', () => {
    const doc = parseMarkdownDocument('\n# 我的文章\n\n第一段\n\n# 另一个标题\n', 'x.md')
    expect(doc.title).toBe('我的文章')
    expect(doc.markdown).toBe('第一段\n\n# 另一个标题\n')
  })

  it('keeps h1 in body when frontmatter has a title', () => {
    const doc = parseMarkdownDocument('---\ntitle: T\n---\n# Heading\ntext')
    expect(doc.title).toBe('T')
    expect(doc.markdown).toContain('# Heading')
  })

  it('falls back to file name', () => {
    expect(parseMarkdownDocument('只有正文', '2024-01-01-hello.md').title).toBe('2024-01-01-hello')
  })

  it('handles CRLF, BOM and invalid frontmatter', () => {
    const crlf = parseMarkdownDocument('﻿---\r\ntitle: CRLF\r\n---\r\nline1\r\nline2')
    expect(crlf.title).toBe('CRLF')
    expect(crlf.markdown).toBe('line1\nline2\n')

    const invalid = parseMarkdownDocument('---\ntitle: [unclosed\n---\n# Real\nbody')
    expect(invalid.title).toBe('Real')
    expect(invalid.frontmatter).toEqual({})
  })

  it('does not treat a horizontal rule in the body as frontmatter', () => {
    const doc = parseMarkdownDocument('# T\n\ntext\n\n---\n\nmore')
    expect(doc.markdown).toContain('---')
    expect(doc.frontmatter).toEqual({})
  })
})

describe('local images', () => {
  it('detects local paths', () => {
    expect(isLocalImagePath('./a.png')).toBe(true)
    expect(isLocalImagePath('images/a.png')).toBe(true)
    expect(isLocalImagePath('/abs/a.png')).toBe(true)
    expect(isLocalImagePath('https://x.com/a.png')).toBe(false)
    expect(isLocalImagePath('//cdn.x.com/a.png')).toBe(false)
    expect(isLocalImagePath('data:image/png;base64,xx')).toBe(false)
  })

  it('normalizes paths', () => {
    expect(normalizeLocalPath('./images/a.png')).toBe('images/a.png')
    expect(normalizeLocalPath('../assets/a%20b.png?x=1')).toBe('assets/a b.png')
    expect(normalizeLocalPath('.\\img\\c.png')).toBe('img/c.png')
  })

  it('replaces resolvable images and reports missing ones', () => {
    const md = '![a](./a.png)\n![b](https://x.com/b.png)\n![c](img/c.png "title")\n![a2](./a.png)'
    const { markdown, missing } = resolveLocalImages(md, path => (path === 'a.png' ? 'data:image/png;base64,AAA' : undefined))
    expect(markdown).toBe('![a](data:image/png;base64,AAA)\n![b](https://x.com/b.png)\n![c](img/c.png "title")\n![a2](data:image/png;base64,AAA)')
    expect(missing).toEqual(['img/c.png'])
  })
})

describe('summary', () => {
  it('strips markdown syntax', () => {
    const text = markdownToPlainText('## 标题\n\n**加粗** 和 [链接](https://x.com)\n\n```js\ncode()\n```\n\n- 列表项\n![img](a.png)')
    expect(text).toBe('标题 加粗 和 链接 列表项')
  })

  it('prefers explicit summary and truncates by characters', () => {
    expect(buildSummary({ summary: '自定义摘要', markdown: '正文' })).toBe('自定义摘要')
    expect(buildSummary({ markdown: '一二三四五六' }, 3)).toBe('一二三')
  })
})

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Eye, Loader2, Pencil, Plus, Save, Send, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { addCmsAccount, removeCmsAccount, type CMSAccount } from '@/lib/cms-accounts'
import type { SyncProgress, SyncResultItem } from '@/lib/messages'
import type { PlatformStatus } from '../adapters'
import {
  buildArticlePayload,
  loadFiles,
  refreshMissingImages,
  renderPreview,
  type ImageFiles,
  type MarkdownDoc,
} from './documents'
import appIcon from '../../assets/icon-48.png'
import typechoIcon from '../../assets/typecho.ico'
import { McpPanel } from './McpPanel'
import { CmsForm, DocEditor, DocTabs, PlatformList, ResultList, UploadArea, type DocResult, type PlatformRow } from './components'

type Mode = 'draft' | 'publish'

const PREFS_KEY = 'syncPrefs'
const CMS_ICONS: Record<string, string> = {
  wordpress: 'https://s.w.org/favicon.ico',
  typecho: typechoIcon,
}

export default function App() {
  // 平台
  const [platforms, setPlatforms] = useState<PlatformRow[]>([])
  const [loadingPlatforms, setLoadingPlatforms] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<Mode>('draft')
  const [showCmsForm, setShowCmsForm] = useState(false)

  // 文档
  const [docs, setDocs] = useState<MarkdownDoc[]>([])
  const [images, setImages] = useState<ImageFiles>(new Map())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const [previewHtml, setPreviewHtml] = useState('')
  const objectUrls = useRef(new Map<File, string>())

  // 同步
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<Record<string, SyncProgress>>({})
  const [results, setResults] = useState<DocResult[]>([])
  const cancelled = useRef(false)

  const activeDoc = docs.find(d => d.id === activeId) || null

  // ---------- 平台加载 ----------

  const loadPlatforms = useCallback(async () => {
    setLoadingPlatforms(true)
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_PLATFORMS' }) as {
        platforms?: PlatformStatus[]
        cmsAccounts?: CMSAccount[]
        error?: string
      }
      const rows: PlatformRow[] = [
        ...(res.platforms || []).map(p => ({
          id: p.id,
          name: p.name,
          icon: p.icon,
          homepage: p.homepage,
          isAuthenticated: p.isAuthenticated,
          username: p.username,
          canPublish: p.capabilities.includes('publish'),
          isCms: false,
        })),
        ...(res.cmsAccounts || []).map(a => ({
          id: a.id,
          name: a.name,
          icon: CMS_ICONS[a.type],
          homepage: a.url,
          isAuthenticated: true,
          username: a.username,
          canPublish: true,
          isCms: true,
        })),
      ]
      setPlatforms(rows)
      // 移除已失效的选择
      setSelected(prev => new Set([...prev].filter(id => rows.some(r => r.id === id && r.isAuthenticated))))
    } finally {
      setLoadingPlatforms(false)
    }
  }, [])

  useEffect(() => {
    chrome.storage.local.get(PREFS_KEY).then(storage => {
      const prefs = storage[PREFS_KEY] as { selected?: string[]; mode?: Mode } | undefined
      if (prefs?.selected) setSelected(new Set(prefs.selected))
      if (prefs?.mode) setMode(prefs.mode)
      loadPlatforms()
    })
  }, [loadPlatforms])

  useEffect(() => {
    if (loadingPlatforms) return
    chrome.storage.local.set({ [PREFS_KEY]: { selected: [...selected], mode } }).catch(() => {})
  }, [selected, mode, loadingPlatforms])

  // ---------- 同步进度 ----------

  useEffect(() => {
    const listener = (message: { type?: string; payload?: SyncProgress }) => {
      if (message.type === 'SYNC_PROGRESS' && message.payload) {
        const p = message.payload
        setProgress(prev => ({ ...prev, [p.platform]: p }))
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  // ---------- 文档 ----------

  const handleFiles = async (files: File[]) => {
    const { docs: newDocs, images: allImages } = await loadFiles(files, images)
    const merged = refreshMissingImages([...docs, ...newDocs], allImages)
    setImages(allImages)
    setDocs(merged)
    if (newDocs.length > 0) setActiveId(newDocs[0].id)
    else if (files.length > 0 && merged.length === 0) alert('没有找到 Markdown 文件（.md / .markdown）')
  }

  const removeDoc = (id: string) => {
    const rest = docs.filter(d => d.id !== id)
    setDocs(rest)
    if (activeId === id) setActiveId(rest[0]?.id ?? null)
  }

  useEffect(() => {
    if (tab !== 'preview' || !activeDoc) return
    let stale = false
    renderPreview(activeDoc, images, objectUrls.current).then(html => {
      if (!stale) setPreviewHtml(html)
    })
    return () => {
      stale = true
    }
  }, [tab, activeDoc, images])

  // ---------- 同步 ----------

  const selectedRows = useMemo(() => platforms.filter(p => selected.has(p.id)), [platforms, selected])
  const draftOnlyRows = selectedRows.filter(p => !p.canPublish)

  const startSync = async () => {
    if (docs.length === 0 || selectedRows.length === 0) return
    const draftOnly = mode === 'draft'

    if (!draftOnly) {
      const lines = [
        `即将把 ${docs.length} 篇文章直接公开发布到 ${selectedRows.length} 个平台。`,
        draftOnlyRows.length > 0 ? `其中 ${draftOnlyRows.map(p => p.name).join('、')} 仅支持草稿，将保存为草稿。` : '',
        '确定继续吗？',
      ]
      if (!confirm(lines.filter(Boolean).join('\n'))) return
    }

    setSyncing(true)
    cancelled.current = false
    const platformIds = selectedRows.map(p => p.id)
    const dslIds = selectedRows.filter(p => !p.isCms).map(p => p.id)

    try {
      for (const doc of docs) {
        if (cancelled.current) break
        setActiveId(doc.id)
        setProgress({})

        let docResults: SyncResultItem[]
        try {
          const article = await buildArticlePayload(doc, images, dslIds)
          const res = await chrome.runtime.sendMessage({
            type: 'SYNC_ARTICLE',
            payload: { article, platforms: platformIds, draftOnly },
          }) as { results?: SyncResultItem[]; error?: string }
          docResults = res.results || [{ platform: 'error', platformName: '同步', success: false, error: res.error || '未知错误' }]
        } catch (error) {
          docResults = [{ platform: 'error', platformName: '同步', success: false, error: (error as Error).message }]
        }

        setResults(prev => [{ docTitle: doc.meta.title || doc.fileName, results: docResults }, ...prev])
      }
    } finally {
      setSyncing(false)
    }
  }

  const cancelSync = () => {
    cancelled.current = true
    chrome.runtime.sendMessage({ type: 'CANCEL_SYNC' }).catch(() => {})
  }

  // ---------- 渲染 ----------

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <header className="mb-5 flex items-center gap-3">
        <img src={appIcon} className="h-8 w-8" alt="" />
        <div>
          <h1 className="text-lg font-bold">Markdown 多平台同步</h1>
          <p className="text-xs text-muted-foreground">上传 Markdown 文档，一键保存草稿或直接发布到多个平台，使用浏览器中已登录的账号</p>
        </div>
      </header>

      <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
        {/* 左侧：文档 */}
        <section className="space-y-4">
          {docs.length === 0 ? (
            <UploadArea onFiles={handleFiles} />
          ) : (
            <>
              <DocTabs docs={docs} activeId={activeId} onSelect={setActiveId} onRemove={removeDoc} />
              {activeDoc && (
                <div className="card">
                  <div className="flex border-b px-2">
                    {(['edit', 'preview'] as const).map(t => (
                      <button
                        key={t}
                        className={cn(
                          'flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm',
                          tab === t ? 'border-primary font-medium' : 'border-transparent text-muted-foreground'
                        )}
                        onClick={() => setTab(t)}
                      >
                        {t === 'edit' ? <Pencil className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        {t === 'edit' ? '文章信息' : '预览'}
                      </button>
                    ))}
                    <span className="ml-auto self-center truncate px-2 text-xs text-muted-foreground">{activeDoc.path}</span>
                  </div>
                  <div className="p-4">
                    {tab === 'edit' ? (
                      <DocEditor
                        doc={activeDoc}
                        onChange={meta => setDocs(ds => ds.map(d => (d.id === activeDoc.id ? { ...d, meta } : d)))}
                      />
                    ) : (
                      <article className="preview max-h-[65vh] overflow-y-auto">
                        <h1>{activeDoc.meta.title}</h1>
                        <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
                      </article>
                    )}
                  </div>
                </div>
              )}
              <UploadArea onFiles={handleFiles} compact />
            </>
          )}
          <ResultList items={results} onClear={() => setResults([])} />
        </section>

        {/* 右侧：平台与操作 */}
        <aside className="space-y-4">
          <div className="card p-4">
            <PlatformList
              platforms={platforms}
              selected={selected}
              loading={loadingPlatforms}
              progress={progress}
              disabled={syncing}
              onToggle={id =>
                setSelected(prev => {
                  const next = new Set(prev)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })
              }
              onSelectAll={ids => setSelected(new Set(ids))}
              onRefresh={loadPlatforms}
              onRemoveCms={async id => {
                await removeCmsAccount(id)
                await loadPlatforms()
              }}
            />
            <div className="mt-3 border-t pt-3">
              {showCmsForm ? (
                <CmsForm
                  onCancel={() => setShowCmsForm(false)}
                  onSubmit={async input => {
                    const res = await addCmsAccount(input)
                    if (!res.success) return res.error || '连接失败'
                    setShowCmsForm(false)
                    await loadPlatforms()
                    return null
                  }}
                />
              ) : (
                <button className="btn-ghost w-full text-xs" onClick={() => setShowCmsForm(true)}>
                  <Plus className="h-3.5 w-3.5" /> 添加自建站（WordPress / Typecho / MetaWeblog）
                </button>
              )}
            </div>
          </div>

          <div className="card space-y-3 p-4">
            <h2 className="text-sm font-semibold">同步方式</h2>
            <div className="grid grid-cols-2 gap-2">
              {([
                { value: 'draft', label: '保存草稿', desc: '稍后在平台上确认发布', icon: Save },
                { value: 'publish', label: '直接发布', desc: '保存后立即公开发布', icon: Send },
              ] as const).map(opt => (
                <button
                  key={opt.value}
                  disabled={syncing}
                  className={cn(
                    'rounded-md border p-3 text-left transition-colors',
                    mode === opt.value ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent'
                  )}
                  onClick={() => setMode(opt.value)}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <opt.icon className="h-4 w-4" /> {opt.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{opt.desc}</span>
                </button>
              ))}
            </div>
            {mode === 'publish' && draftOnlyRows.length > 0 && (
              <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                {draftOnlyRows.map(p => p.name).join('、')} 暂不支持直接发布，将保存为草稿。
              </p>
            )}
            {mode === 'publish' && (
              <p className="text-xs text-muted-foreground">
                发布失败时会保留草稿并提示原因；掘金、CSDN 发布后需平台审核。
              </p>
            )}

            {syncing ? (
              <button className="btn-outline w-full" onClick={cancelSync}>
                <Square className="h-4 w-4" /> 停止（当前平台完成后停止）
              </button>
            ) : (
              <button
                className="btn-primary w-full py-2"
                disabled={docs.length === 0 || selectedRows.length === 0}
                onClick={startSync}
              >
                {mode === 'draft' ? <Save className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                {mode === 'draft' ? '同步为草稿' : '直接发布'}
                {docs.length > 1 && `（${docs.length} 篇）`}
              </button>
            )}
            {syncing && (
              <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在同步「{activeDoc?.meta.title}」…
              </p>
            )}
          </div>
          <McpPanel />
        </aside>
      </div>
    </div>
  )
}

import { useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileText,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CMSType } from '@/lib/cms-accounts'
import type { SyncProgress } from '@/lib/messages'
import type { DocumentMeta, MarkdownDoc } from './documents'

// ============ 上传 ============

export function UploadArea({ onFiles, compact }: { onFiles: (files: File[]) => void; compact?: boolean }) {
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const pick = (input: HTMLInputElement | null) => {
    if (!input) return
    input.value = ''
    input.click()
  }

  return (
    <div
      className={cn(
        'card flex flex-col items-center justify-center gap-3 border-dashed text-center transition-colors',
        compact ? 'p-4' : 'p-10',
        dragging && 'border-primary bg-primary/5'
      )}
      onDragOver={e => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => {
        e.preventDefault()
        setDragging(false)
        onFiles(Array.from(e.dataTransfer.files))
      }}
    >
      {!compact && <Upload className="h-10 w-10 text-muted-foreground" />}
      <div>
        <p className="text-sm font-medium">拖拽 Markdown 文件到这里</p>
        <p className="mt-1 text-xs text-muted-foreground">
          支持 .md / .markdown，可同时选择文章引用的本地图片，或直接选择整个文件夹
        </p>
      </div>
      <div className="flex gap-2">
        <button className="btn-outline" onClick={() => pick(fileInput.current)}>
          <FileText className="h-4 w-4" /> 选择文件
        </button>
        <button className="btn-outline" onClick={() => pick(folderInput.current)}>
          <FolderOpen className="h-4 w-4" /> 选择文件夹
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".md,.markdown,.mdx,.txt,image/*"
        className="hidden"
        onChange={e => onFiles(Array.from(e.target.files || []))}
      />
      <input
        ref={folderInput}
        type="file"
        className="hidden"
        // @ts-expect-error webkitdirectory 不在 React 类型中
        webkitdirectory=""
        onChange={e => onFiles(Array.from(e.target.files || []))}
      />
    </div>
  )
}

// ============ 文档 ============

export function DocTabs({
  docs,
  activeId,
  onSelect,
  onRemove,
}: {
  docs: MarkdownDoc[]
  activeId: string | null
  onSelect: (id: string) => void
  onRemove: (id: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {docs.map(doc => (
        <div
          key={doc.id}
          className={cn(
            'flex max-w-[260px] items-center gap-1 rounded-md border bg-white pl-3 text-sm',
            doc.id === activeId && 'border-primary ring-1 ring-primary'
          )}
        >
          <button className="truncate py-1.5 text-left" title={doc.path} onClick={() => onSelect(doc.id)}>
            {doc.meta.title || doc.fileName}
          </button>
          <button className="btn-ghost px-1.5" title="移除" onClick={() => onRemove(doc.id)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between text-xs font-medium text-muted-foreground">
        {label}
        {hint && <span className="font-normal">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

export function DocEditor({ doc, onChange }: { doc: MarkdownDoc; onChange: (meta: DocumentMeta) => void }) {
  const set = (key: keyof DocumentMeta) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    onChange({ ...doc.meta, [key]: e.target.value })

  return (
    <div className="space-y-3">
      <Field label="标题">
        <input className="input" value={doc.meta.title} onChange={set('title')} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="标签" hint="逗号分隔，掘金 / CSDN / 思否 / 51CTO 发布必填，知乎用作话题">
          <input className="input" value={doc.meta.tags} onChange={set('tags')} placeholder="JavaScript, 前端" />
        </Field>
        <Field label="分类" hint="掘金 / B站 / 开源中国 / 51CTO 的分类名">
          <input className="input" value={doc.meta.category} onChange={set('category')} placeholder="后端" />
        </Field>
      </div>
      <Field label="摘要" hint="掘金要求 50 字以上，留空则从正文截取">
        <textarea className="input h-16 resize-none" value={doc.meta.summary} onChange={set('summary')} />
      </Field>
      <Field label="封面图" hint="URL 或本地路径，微博 / 百家号发布必填（可用正文图片）">
        <input className="input" value={doc.meta.cover} onChange={set('cover')} />
      </Field>
      {doc.missingImages.length > 0 && (
        <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">有 {doc.missingImages.length} 张本地图片未找到，同步时会被跳过：</p>
            <p className="mt-1 break-all">{doc.missingImages.join('、')}</p>
            <p className="mt-1">请把图片文件一起拖进来，或直接选择文章所在的文件夹。</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ============ 平台 ============

export interface PlatformRow {
  id: string
  name: string
  icon?: string
  homepage: string
  isAuthenticated: boolean
  username?: string
  canPublish: boolean
  isCms: boolean
}

function StageIcon({ progress }: { progress?: SyncProgress }) {
  if (!progress) return null
  if (progress.stage === 'completed') return <CheckCircle2 className="h-4 w-4 text-green-600" />
  if (progress.stage === 'failed') return <XCircle className="h-4 w-4 text-red-500" />
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {progress.imageProgress && `图片 ${progress.imageProgress.current}/${progress.imageProgress.total}`}
    </span>
  )
}

export function PlatformList({
  platforms,
  selected,
  loading,
  progress,
  disabled,
  onToggle,
  onSelectAll,
  onRefresh,
  onRemoveCms,
}: {
  platforms: PlatformRow[]
  selected: Set<string>
  loading: boolean
  progress: Record<string, SyncProgress>
  disabled: boolean
  onToggle: (id: string) => void
  onSelectAll: (ids: string[]) => void
  onRefresh: () => void
  onRemoveCms: (id: string) => void
}) {
  const loggedIn = platforms.filter(p => p.isAuthenticated)
  const loggedOut = platforms.filter(p => !p.isAuthenticated)
  const allSelected = loggedIn.length > 0 && loggedIn.every(p => selected.has(p.id))

  const row = (p: PlatformRow) => (
    <label
      key={p.id}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        p.isAuthenticated ? 'cursor-pointer hover:bg-accent' : 'opacity-60'
      )}
    >
      <input
        type="checkbox"
        className="accent-[hsl(var(--primary))]"
        checked={selected.has(p.id)}
        disabled={!p.isAuthenticated || disabled}
        onChange={() => onToggle(p.id)}
      />
      {p.icon ? (
        <img
          src={p.icon}
          className="h-4 w-4 rounded-sm"
          alt=""
          onError={e => (e.currentTarget.style.visibility = 'hidden')}
        />
      ) : (
        <span className="h-4 w-4" />
      )}
      <span className="font-medium">{p.name}</span>
      {p.isAuthenticated ? (
        <span className="truncate text-xs text-muted-foreground">{p.username}</span>
      ) : (
        <a href={p.homepage} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">
          去登录
        </a>
      )}
      <span className="ml-auto flex items-center gap-2">
        <StageIcon progress={progress[p.id]} />
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px]',
            p.canPublish ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
          )}
        >
          {p.canPublish ? '可发布' : '仅草稿'}
        </span>
        {p.isCms && (
          <button
            className="text-muted-foreground hover:text-red-500"
            title="删除站点"
            onClick={e => {
              e.preventDefault()
              if (confirm(`确定删除站点「${p.name}」？`)) onRemoveCms(p.id)
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </span>
    </label>
  )

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          目标平台 <span className="font-normal text-muted-foreground">（已选 {selected.size}）</span>
        </h2>
        <div className="flex gap-1">
          <button
            className="btn-ghost px-2 text-xs"
            disabled={disabled || loggedIn.length === 0}
            onClick={() => onSelectAll(allSelected ? [] : loggedIn.map(p => p.id))}
          >
            {allSelected ? '取消全选' : '全选已登录'}
          </button>
          <button className="btn-ghost px-2" title="刷新登录状态" disabled={loading} onClick={onRefresh}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </button>
        </div>
      </div>
      {loading && platforms.length === 0 ? (
        <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> 正在检查各平台登录状态…
        </p>
      ) : (
        <div className="space-y-0.5">
          {loggedIn.map(row)}
          {loggedOut.length > 0 && (
            <details className="pt-1">
              <summary className="cursor-pointer px-2 text-xs text-muted-foreground">
                未登录的平台（{loggedOut.length}）— 在浏览器中登录后点刷新
              </summary>
              <div className="mt-1 space-y-0.5">{loggedOut.map(row)}</div>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

// ============ 自建站 ============

const CMS_TYPES: Array<{ value: CMSType; label: string; hint: string }> = [
  { value: 'wordpress', label: 'WordPress', hint: '需开启 XML-RPC，建议使用应用密码' },
  { value: 'typecho', label: 'Typecho', hint: '需在后台开启 XML-RPC' },
  { value: 'metaweblog', label: 'MetaWeblog', hint: '博客园等兼容 MetaWeblog 的站点' },
]

export function CmsForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (input: { type: CMSType; name: string; url: string; username: string; password: string }) => Promise<string | null>
  onCancel: () => void
}) {
  const [type, setType] = useState<CMSType>('wordpress')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    setError(null)
    const err = await onSubmit({
      type,
      name: name.trim() || url.replace(/^https?:\/\//, ''),
      url: url.trim().replace(/\/$/, ''),
      username: username.trim(),
      password,
    })
    setSaving(false)
    if (err) setError(err)
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3">
      <div className="flex gap-1">
        {CMS_TYPES.map(t => (
          <button
            key={t.value}
            className={cn('btn px-2 text-xs', type === t.value ? 'bg-primary text-primary-foreground' : 'btn-outline')}
            onClick={() => setType(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{CMS_TYPES.find(t => t.value === type)?.hint}</p>
      <input className="input" placeholder="站点地址，如 https://blog.example.com" value={url} onChange={e => setUrl(e.target.value)} />
      <input className="input" placeholder="显示名称（可选）" value={name} onChange={e => setName(e.target.value)} />
      <div className="grid grid-cols-2 gap-2">
        <input className="input" placeholder="用户名" value={username} onChange={e => setUsername(e.target.value)} />
        <input className="input" type="password" placeholder="密码" value={password} onChange={e => setPassword(e.target.value)} />
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button className="btn-ghost" onClick={onCancel}>取消</button>
        <button className="btn-primary" disabled={saving || !url || !username || !password} onClick={submit}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          测试并添加
        </button>
      </div>
    </div>
  )
}

// ============ 结果 ============

export interface DocResult {
  docTitle: string
  results: Array<{
    platform: string
    platformName?: string
    success: boolean
    postUrl?: string
    draftOnly?: boolean
    message?: string
    error?: string
  }>
}

export function ResultList({ items, onClear }: { items: DocResult[]; onClear: () => void }) {
  if (items.length === 0) return null
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold">同步结果</h2>
        <button className="btn-ghost px-2 text-xs" onClick={onClear}>清空</button>
      </div>
      <div className="space-y-4">
        {items.map((item, index) => (
          <div key={index}>
            <p className="mb-1 truncate text-sm font-medium">{item.docTitle}</p>
            <div className="divide-y rounded-md border">
              {item.results.map(r => (
                <div key={r.platform} className="flex items-start gap-2 px-3 py-2 text-sm">
                  {r.success ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.platformName || r.platform}</span>
                      {r.success && (
                        <span
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[10px]',
                            r.draftOnly ? 'bg-slate-100 text-slate-600' : 'bg-green-100 text-green-700'
                          )}
                        >
                          {r.draftOnly ? '草稿' : '已发布'}
                        </span>
                      )}
                    </div>
                    {(r.error || r.message) && (
                      <p className={cn('mt-0.5 break-all text-xs', r.error ? 'text-red-600' : 'text-amber-700')}>
                        {r.error || r.message}
                      </p>
                    )}
                  </div>
                  {r.postUrl && (
                    <a href={r.postUrl} target="_blank" rel="noreferrer" className="btn-ghost shrink-0 px-2 text-xs">
                      {r.draftOnly ? '编辑' : '查看'} <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

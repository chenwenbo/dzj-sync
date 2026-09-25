import { useCallback, useEffect, useState } from 'react'
import { Bot, Check, ChevronDown, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

interface McpStatus {
  enabled: boolean
  connected: boolean
  token?: string
  serverUrl: string
}

const DEFAULT_SERVER_URL = 'ws://localhost:9527'

/**
 * AI 连接设置：开启后扩展连接本地 MCP Server / CLI（Claude Code、Claude Desktop、Skill 等通过它同步文章）
 */
export function McpPanel() {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [serverUrl, setServerUrl] = useState('')
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(async () => {
    const res = await chrome.runtime.sendMessage({ type: 'MCP_STATUS' }) as McpStatus
    setStatus(res)
    return res
  }, [])

  useEffect(() => {
    refresh().then(res => setServerUrl(res.serverUrl))
  }, [refresh])

  // 面板展开时轮询连接状态，并让扩展加快重连
  useEffect(() => {
    if (!open) return
    chrome.runtime.sendMessage({ type: 'MCP_WATCH', payload: { active: true } }).catch(() => {})
    const timer = setInterval(refresh, 1500)
    return () => {
      clearInterval(timer)
      chrome.runtime.sendMessage({ type: 'MCP_WATCH', payload: { active: false } }).catch(() => {})
    }
  }, [open, refresh])

  const toggle = async () => {
    if (!status) return
    const enable = !status.enabled
    setStatus({ ...status, enabled: enable, connected: false })
    await chrome.runtime.sendMessage({ type: enable ? 'MCP_ENABLE' : 'MCP_DISABLE' })
    await refresh()
  }

  const saveServerUrl = async () => {
    await chrome.runtime.sendMessage({ type: 'MCP_SET_SERVER_URL', payload: { url: serverUrl.trim() } })
    await refresh()
  }

  const copyToken = async () => {
    if (!status?.token) return
    await navigator.clipboard.writeText(status.token)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const dot = !status?.enabled ? 'bg-slate-300' : status.connected ? 'bg-green-500' : 'bg-amber-400'
  const label = !status?.enabled ? '未开启' : status.connected ? '已连接' : '等待 CLI / MCP 连接'

  return (
    <div className="card p-4">
      <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(o => !o)}>
        <Bot className="h-4 w-4" />
        <span className="text-sm font-semibold" title="CLI / MCP / Claude Skill">AI 连接</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn('h-2 w-2 rounded-full', dot)} />
          {label}
        </span>
        <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} />
      </button>

      {open && status && (
        <div className="mt-3 space-y-3 border-t pt-3 text-xs">
          <p className="text-muted-foreground">开启后，命令行 CLI、MCP Server（Claude Code / Claude Desktop 等）和 Claude Skill 可以通过本扩展同步或发布文章。</p>
          <label className="flex items-center justify-between">
            <span>允许 CLI / MCP 调用本扩展同步文章</span>
            <input type="checkbox" className="accent-[hsl(var(--primary))]" checked={status.enabled} onChange={toggle} />
          </label>

          {status.enabled && (
            <>
              <div>
                <p className="mb-1 font-medium text-muted-foreground">Token（设置为环境变量 WECHATSYNC_TOKEN）</p>
                <div className="flex gap-1">
                  <code className="flex-1 truncate rounded bg-muted px-2 py-1.5">{status.token}</code>
                  <button className="btn-outline px-2" title="复制" onClick={copyToken}>
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
              <div>
                <p className="mb-1 font-medium text-muted-foreground">桥接地址</p>
                <div className="flex gap-1">
                  <input
                    className="input py-1 text-xs"
                    placeholder={DEFAULT_SERVER_URL}
                    value={serverUrl}
                    onChange={e => setServerUrl(e.target.value)}
                  />
                  <button className="btn-outline px-2 text-xs" onClick={saveServerUrl}>保存</button>
                </div>
              </div>
              <pre className="overflow-x-auto rounded bg-slate-900 p-2 text-[11px] leading-5 text-slate-100">
{`export WECHATSYNC_TOKEN="${status.token}"
# 命令行
wechatsync sync post.md -p juejin,csdn --publish
# Claude Code
claude mcp add wechatsync -e WECHATSYNC_TOKEN=$WECHATSYNC_TOKEN \\
  -- node /path/to/dzj-sync/packages/mcp-server/dist/index.js`}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, CircleDashed, Database, Loader2, Plug, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { TABS, type TabId } from './nav'

interface StatusCheck {
  key: string
  label: string
  state: 'up' | 'down' | 'off'
  detail: string
}

interface StatusDto {
  ok: boolean
  checkedAt: string
  checks: StatusCheck[]
  zoho: { mcpConfigured: boolean; mcpMissing: string[]; mcpUrl: string | null; createdAfter: string }
  scheduler: { enabled: boolean }
}

function StatusDot({ state }: { state: StatusCheck['state'] }) {
  if (state === 'up') return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
  if (state === 'down') return <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
  return <CircleDashed className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
}

/**
 * What is actually wired up.
 *
 * `off` is not an error — several integrations are optional, and showing them as failures
 * trained the eye to ignore the panel. Only `down` (the database) reads as a problem.
 */
function IntegrationPanel() {
  const [status, setStatus] = useState<StatusDto | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/status')
      if (res.ok) setStatus((await res.json()) as StatusDto)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const mcpConnected = status?.zoho.mcpConfigured ?? false

  return (
    <div className="rounded-xl border border-sidebar-border bg-card/60 p-3">
      <div className="flex items-center justify-between mb-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <Plug className="h-3.5 w-3.5" /> Connections
        </p>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={load}
          disabled={loading}
          aria-label="Re-check connections"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </Button>
      </div>

      {!status ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> checking…
        </div>
      ) : (
        <ul className="space-y-1.5">
          {status.checks.map((c) => (
            <li key={c.key} className="flex items-start gap-2">
              <StatusDot state={c.state} />
              <div className="min-w-0 flex-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <p className="truncate text-xs font-medium leading-tight">{c.label}</p>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="max-w-xs">
                    {c.detail}
                  </TooltipContent>
                </Tooltip>
                <p className="truncate text-[11px] leading-tight text-muted-foreground">{c.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {status && !mcpConnected ? (
        <a
          href="/api/zoho/mcp/connect"
          className="mt-3 flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-accent-foreground"
        >
          <Plug className="h-3.5 w-3.5" /> Connect Zoho MCP
        </a>
      ) : null}

      {status?.scheduler ? (
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Database className="h-3 w-3" />
          Scheduler {status.scheduler.enabled ? 'on' : 'off'}
          {status.checkedAt ? ` · checked ${new Date(status.checkedAt).toLocaleTimeString()}` : ''}
        </p>
      ) : null}
    </div>
  )
}

export function AppSidebar({
  tab,
  onTabChange,
  nudgeCount,
}: {
  tab: TabId
  onTabChange: (t: TabId) => void
  nudgeCount?: { total: number; active: number }
}) {
  return (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="flex items-center gap-3 px-1 pt-1">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-primary to-chart-2 text-primary-foreground shadow-sm">
          <BellRingMark />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">Nudge Engine</p>
          <p className="truncate text-[11px] text-muted-foreground">EPS onboarding nudges</p>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5">
        {TABS.map((t) => {
          const Icon = t.icon
          const active = tab === t.id
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onTabChange(t.id)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground'
              )}
            >
              {/* Active marker: a brand bar, so the current tab is obvious at a glance. */}
              <span
                className={cn(
                  'absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-primary transition-opacity',
                  active ? 'opacity-100' : 'opacity-0'
                )}
              />
              <Icon className={cn('h-4 w-4 shrink-0', active && 'text-primary')} />
              <span className="truncate">{t.label}</span>
              {t.id === 'nudges' && nudgeCount ? (
                <Badge variant="secondary" className="ml-auto h-5 px-1.5 text-[10px] font-medium">
                  {nudgeCount.active}/{nudgeCount.total}
                </Badge>
              ) : null}
            </button>
          )
        })}
      </nav>

      <IntegrationPanel />
    </div>
  )
}

/** Small inline mark — avoids depending on a logo asset that may not exist in the build. */
function BellRingMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}

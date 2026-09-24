'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  Mail,
  MessageCircle,
  RefreshCw,
  RotateCcw,
  Search,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'

interface Failure {
  id: string
  channel: string
  nudgeKey: string
  nudgeName: string
  nudgeEnabled: boolean
  to: string | null
  lead: string | null
  subject: string | null
  templateName: string | null
  messageNumber: number
  sendError: string | null
  createdAt: string
  errorLabel: string | null
  errorDetail: string | null
  retryable: boolean
  resolved: boolean
  resolvedAt: string | null
}

interface Payload {
  ok: boolean
  count: number
  resolvedHidden: number
  retryableCount: number
  byCause: Array<{ label: string; detail: string | null; count: number; retryable: boolean }>
  failures: Failure[]
}

interface RetryResponse {
  ok: boolean
  error?: string
  requested: number
  attempted: number
  sent: number
  failed: number
  skipped: number
  message?: string
  outcomes: Array<{ logId: string; ok: boolean; reason?: string; to: string | null }>
}

function ChannelIcon({ channel }: { channel: string }) {
  return channel === 'whatsapp' ? (
    <MessageCircle className="h-4 w-4 shrink-0 text-success" />
  ) : (
    <Mail className="h-4 w-4 shrink-0 text-primary" />
  )
}

export function FailuresTab({ refreshKey, onChanged }: { refreshKey: number; onChanged?: () => void }) {
  const { toast } = useToast()
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [channel, setChannel] = useState<'all' | 'email' | 'whatsapp'>('all')
  const [q, setQ] = useState('')
  const [showResolved, setShowResolved] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [retrying, setRetrying] = useState(false)
  const [confirmAll, setConfirmAll] = useState(false)
  const [lastResult, setLastResult] = useState<RetryResponse | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (channel !== 'all') params.set('channel', channel)
      if (showResolved) params.set('includeResolved', '1')
      if (q.trim()) params.set('q', q.trim())
      const res = await fetch(`/api/logs/failures?${params.toString()}`)
      if (res.ok) {
        setData((await res.json()) as Payload)
        setSelected(new Set())
      }
    } finally {
      setLoading(false)
    }
  }, [channel, q, showResolved])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  const rows = data?.failures ?? []
  const selectableRows = useMemo(() => rows.filter((r) => !r.resolved), [rows])

  const runRetry = useCallback(
    async (body: Record<string, unknown>, label: string) => {
      setRetrying(true)
      setLastResult(null)
      try {
        const res = await fetch('/api/logs/retry', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const result = (await res.json()) as RetryResponse

        if (!result.ok) {
          toast({ title: 'Retry failed', description: result.error, variant: 'destructive' })
          return
        }

        setLastResult(result)
        toast({
          title: result.message || `${result.sent} sent`,
          description:
            result.failed || result.skipped
              ? `${result.failed} still failing, ${result.skipped} skipped. See the results below.`
              : `${label} completed.`,
          variant: result.sent ? 'default' : 'destructive',
        })
        await load()
        onChanged?.()
      } catch (err) {
        toast({
          title: 'Retry failed',
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        })
      } finally {
        setRetrying(false)
        setConfirmAll(false)
      }
    },
    [toast, load, onChanged]
  )

  const selectedRetryable = [...selected].filter((id) => {
    const row = rows.find((r) => r.id === id)
    return row && !row.resolved && row.retryable
  })

  return (
    <div className="space-y-4">
      {/* --- header / actions --- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Failed deliveries</h3>
          <p className="field-hint">
            Every failed send on both channels. Retrying re-sends through the nudge it originally belonged to,
            and skips anyone who has since replied.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="icon" onClick={load} disabled={loading} aria-label="Reload failures">
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
          <Button
            variant="outline"
            onClick={() => runRetry({ ids: selectedRetryable }, 'Selected retry')}
            disabled={retrying || selectedRetryable.length === 0}
            className="gap-1.5"
          >
            {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            Retry selected{selectedRetryable.length ? ` (${selectedRetryable.length})` : ''}
          </Button>
          <Button
            onClick={() => setConfirmAll(true)}
            disabled={retrying || !data?.retryableCount}
            className="gap-1.5"
          >
            {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
            Retry all failed{data?.retryableCount ? ` (${data.retryableCount})` : ''}
          </Button>
        </div>
      </div>

      {/* --- summary of causes --- */}
      {data?.byCause?.length ? (
        <div className="flex flex-wrap gap-2">
          {data.byCause.map((c) => (
            <Tooltip key={c.label}>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    'flex cursor-default items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs',
                    c.retryable ? 'border-warning/30 bg-warning/10 text-warning' : 'border-border bg-muted text-muted-foreground'
                  )}
                >
                  {c.retryable ? <RefreshCw className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                  <b className="tabular">{c.count}</b>
                  {c.label}
                  {!c.retryable ? <span className="opacity-70">· not retryable</span> : null}
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-sm">
                {c.detail || 'No further detail recorded.'}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      ) : null}

      {/* --- filters --- */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="flex rounded-lg border border-border p-0.5">
            {(['all', 'email', 'whatsapp'] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setChannel(c)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors',
                  channel === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search address, lead or error…"
              className="h-9 pl-8"
            />
          </div>

          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--primary)]"
            />
            Show already recovered
            {data?.resolvedHidden ? <span className="tabular">({data.resolvedHidden} hidden)</span> : null}
          </label>

          {selectableRows.length ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setSelected((prev) => (prev.size === selectableRows.length ? new Set() : new Set(selectableRows.map((r) => r.id))))
              }
            >
              {selected.size === selectableRows.length ? 'Clear selection' : 'Select all'}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {/* --- last retry result --- */}
      {lastResult ? <RetrySummary result={lastResult} /> : null}

      {/* --- the list --- */}
      {loading && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <CheckCircle2 className="h-8 w-8 text-success" />
            <p className="text-sm font-medium">No failures here</p>
            <p className="field-hint max-w-md">
              {showResolved
                ? 'Nothing has failed on this filter.'
                : 'Every failure on this filter has since been recovered by a retry. Tick "Show already recovered" to see them.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((f) => (
            <FailureRow
              key={f.id}
              failure={f}
              selected={selected.has(f.id)}
              onToggle={() =>
                setSelected((prev) => {
                  const next = new Set(prev)
                  if (next.has(f.id)) next.delete(f.id)
                  else next.add(f.id)
                  return next
                })
              }
              onRetry={() => runRetry({ ids: [f.id] }, 'Single retry')}
              busy={retrying}
            />
          ))}
        </div>
      )}

      {/* --- confirm bulk retry --- */}
      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retry every failed message?</AlertDialogTitle>
            <AlertDialogDescription>
              This re-sends up to {data?.retryableCount ?? 0} messages through their original nudges, one at a time.
              Already-recovered failures and errors that cannot succeed (undeliverable numbers, missing credentials)
              are skipped. Anyone who replied is skipped too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={retrying}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                runRetry({ all: true, channel: channel === 'all' ? undefined : channel }, 'Bulk retry')
              }}
              disabled={retrying}
            >
              {retrying ? 'Retrying…' : 'Retry now'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function RetrySummary({ result }: { result: RetryResponse }) {
  const problems = result.outcomes.filter((o) => !o.ok && o.reason)
  return (
    <Card className={cn(result.sent ? 'border-success/40' : 'border-destructive/40')}>
      <CardContent className="space-y-2 p-4">
        <p className="text-sm font-medium">
          {result.sent} sent · {result.failed} still failing · {result.skipped} skipped
          <span className="field-hint ml-2">of {result.attempted} attempted</span>
        </p>
        {problems.length ? (
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {problems.slice(0, 20).map((o, i) => (
              <p key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
                <span className="mono">{o.to || '?'}</span>
                <span className="min-w-0 flex-1 truncate">{o.reason}</span>
              </p>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function FailureRow({
  failure: f,
  selected,
  onToggle,
  onRetry,
  busy,
}: {
  failure: Failure
  selected: boolean
  onToggle: () => void
  onRetry: () => void
  busy: boolean
}) {
  return (
    <Card className={cn('panel-hover', f.resolved && 'opacity-70')}>
      <CardContent className="flex flex-wrap items-start gap-3 p-3.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          disabled={f.resolved}
          aria-label={`Select ${f.to}`}
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--primary)]"
        />

        <ChannelIcon channel={f.channel} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono truncate font-medium">{f.to || 'unknown recipient'}</span>
            {f.lead ? <span className="truncate text-xs text-muted-foreground">{f.lead}</span> : null}
            {f.resolved ? (
              <Badge className="bg-success text-success-foreground hover:bg-success">recovered</Badge>
            ) : f.retryable ? (
              <Badge className="bg-warning text-warning-foreground hover:bg-warning">{f.errorLabel || 'failed'}</Badge>
            ) : (
              <Badge variant="secondary">{f.errorLabel || 'failed'} · not retryable</Badge>
            )}
          </div>

          <p className="mt-1 truncate text-xs text-muted-foreground">
            <span className="font-medium">{f.nudgeName}</span>
            <span className="mono"> · {f.nudgeKey}</span>
            {f.templateName ? <span className="mono"> · {f.templateName}</span> : null}
            {!f.nudgeEnabled ? <span className="text-warning"> · nudge is disabled</span> : null}
          </p>

          <Tooltip>
            <TooltipTrigger asChild>
              <p className="mt-1 line-clamp-2 cursor-help text-xs text-muted-foreground/90">
                {f.errorDetail || f.sendError || 'No error text recorded.'}
              </p>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-md">
              <p className="font-medium">{f.sendError || 'no raw error'}</p>
              {f.errorDetail ? <p className="mt-1 opacity-90">{f.errorDetail}</p> : null}
            </TooltipContent>
          </Tooltip>

          <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground">
            <span>attempted {new Date(f.createdAt).toLocaleString()}</span>
            {f.resolvedAt ? <span className="text-success">recovered {new Date(f.resolvedAt).toLocaleString()}</span> : null}
          </p>
        </div>

        {!f.resolved ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={onRetry} disabled={busy} className="gap-1.5">
                <RotateCcw className="h-3.5 w-3.5" />
                Retry
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-xs">
              {f.retryable
                ? `Re-send this ${f.channel} message through "${f.nudgeName}".`
                : 'This error cannot be fixed by re-sending — the raw error explains why.'}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1 text-xs text-success">
                <Info className="h-3.5 w-3.5" /> done
              </span>
            </TooltipTrigger>
            <TooltipContent side="left">A later send to this address on this nudge succeeded.</TooltipContent>
          </Tooltip>
        )}
      </CardContent>
    </Card>
  )
}

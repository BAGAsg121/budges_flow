'use client'

import { useCallback, useEffect, useState } from 'react'
import { CalendarDays, Download, FileSpreadsheet, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'

/** yyyy-mm-dd for the IST day containing `date` — used to jump the range to a known-active day. */
function istDayOffsetFor(date: Date): string {
  return new Date(date.getTime() + (5 * 60 + 30) * 60 * 1000).toISOString().slice(0, 10)
}

/** yyyy-mm-dd for the IST day `daysAgo` days back, matching the server's IST day boundaries. */
function istDayOffset(daysAgo: number): string {
  return istDayOffsetFor(new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000))
}

const PRESETS = [
  { id: 'today', label: 'Today', from: () => istDayOffset(0), to: () => istDayOffset(0) },
  { id: 'yesterday', label: 'Yesterday', from: () => istDayOffset(1), to: () => istDayOffset(1) },
  { id: '7d', label: 'Last 7 days', from: () => istDayOffset(6), to: () => istDayOffset(0) },
  { id: '30d', label: 'Last 30 days', from: () => istDayOffset(29), to: () => istDayOffset(0) },
  { id: 'custom', label: 'Custom', from: null, to: null },
] as const

type PresetId = (typeof PRESETS)[number]['id']

interface NudgeOption {
  id: string
  key: string
  name: string
  channel: string
}

export function ExportLogsDialog({
  open,
  onOpenChange,
  /** Pre-select a nudge, e.g. when exporting from a nudge's own row. */
  initialNudgeKey,
  initialChannel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialNudgeKey?: string
  initialChannel?: string
}) {
  const { toast } = useToast()
  const [preset, setPreset] = useState<PresetId>('yesterday')
  const [from, setFrom] = useState(istDayOffset(1))
  const [to, setTo] = useState(istDayOffset(1))
  const [nudgeKey, setNudgeKey] = useState(initialNudgeKey || 'all')
  const [channel, setChannel] = useState(initialChannel || 'all')
  const [status, setStatus] = useState('all')
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx')
  const [nudges, setNudges] = useState<NudgeOption[]>([])
  const [preview, setPreview] = useState<{ rowCount: number; truncated: boolean; latestAt: string | null } | null>(null)
  const [counting, setCounting] = useState(false)
  const [downloading, setDownloading] = useState(false)

  // Load the nudge list once the dialog is opened, so the select is not empty on first paint.
  useEffect(() => {
    if (!open || nudges.length) return
    fetch('/api/nudges')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { nudges?: NudgeOption[] } | null) => {
        if (d?.nudges) {
          setNudges(d.nudges.map((n) => ({ id: n.id, key: n.key, name: n.name, channel: n.channel })))
        }
      })
      .catch(() => {
        // The export still works; the operator just picks "all nudges".
      })
  }, [open, nudges.length])

  const applyPreset = useCallback((id: PresetId) => {
    setPreset(id)
    const p = PRESETS.find((x) => x.id === id)
    if (p?.from && p?.to) {
      setFrom(p.from())
      setTo(p.to())
    }
  }, [])

  const query = useCallback(
    (extra: Record<string, string> = {}) => {
      const params = new URLSearchParams({ from, to, ...extra })
      if (nudgeKey !== 'all') params.set('nudgeKey', nudgeKey)
      if (channel !== 'all') params.set('channel', channel)
      if (status !== 'all') params.set('status', status)
      return params.toString()
    },
    [from, to, nudgeKey, channel, status]
  )

  // Live count, so a mistyped range shows as an obviously wrong number before downloading.
  useEffect(() => {
    if (!open) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      setPreview(null)
      return
    }
    let cancelled = false
    setCounting(true)
    const t = setTimeout(() => {
      fetch(`/api/logs/export?${query({ countOnly: '1' })}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { rowCount?: number; truncated?: boolean; latestAt?: string | null } | null) => {
          if (!cancelled && d && typeof d.rowCount === 'number') {
            setPreview({ rowCount: d.rowCount, truncated: Boolean(d.truncated), latestAt: d.latestAt ?? null })
          }
        })
        .catch(() => {
          if (!cancelled) setPreview(null)
        })
        .finally(() => {
          if (!cancelled) setCounting(false)
        })
    }, 350) // debounce while the operator types a date
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [open, from, to, query])

  const download = useCallback(() => {
    setDownloading(true)
    try {
      // A same-origin navigation, so the browser's Basic-auth credentials ride along and the
      // server's Content-Disposition names the file.
      const url = `/api/logs/export?${query({ format })}`
      const a = document.createElement('a')
      a.href = url
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
      onOpenChange(false)
    } catch (err) {
      toast({
        title: 'Export failed',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    } finally {
      // The download is handed to the browser, so there is nothing to wait for.
      setTimeout(() => setDownloading(false), 600)
    }
  }, [query, format, toast, onOpenChange])

  const nudgesForChannel = channel === 'all' ? nudges : nudges.filter((n) => n.channel === channel)
  const nothingMatched = preview?.rowCount === 0
  // Captured as a const: narrowing a property access does not survive into the onClick closure
  // below, but narrowing a const does.
  const latestAt = preview?.latestAt ?? null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-primary" /> Export logs
          </DialogTitle>
          <DialogDescription>
            Download a spreadsheet of message logs. Dates are IST calendar days, inclusive at both ends.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Date range */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <CalendarDays className="h-3.5 w-3.5" /> Date range (IST)
            </Label>
            <div className="flex flex-wrap gap-1">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p.id)}
                  className={cn(
                    'rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                    preset === p.id
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value)
                  setPreset('custom')
                }}
                className="h-9"
                aria-label="From date"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value)
                  setPreset('custom')
                }}
                className="h-9"
                aria-label="To date"
              />
            </div>
          </div>

          {/* Nudge + channel */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Nudge</Label>
              <Select value={nudgeKey} onValueChange={setNudgeKey}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All nudges</SelectItem>
                  {nudgesForChannel.map((n) => (
                    <SelectItem key={n.id} value={n.key}>
                      <span className="mono text-xs">{n.key}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Channel</Label>
              <Select
                value={channel}
                onValueChange={(v) => {
                  setChannel(v)
                  // Drop a nudge selection the new channel filter would exclude, so the two
                  // controls cannot contradict each other (which would always return 0 rows).
                  if (v !== 'all' && nudgeKey !== 'all') {
                    const selected = nudges.find((n) => n.key === nudgeKey)
                    if (selected && selected.channel !== v) setNudgeKey('all')
                  }
                }}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All channels</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Status + format */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="opened">Opened</SelectItem>
                  <SelectItem value="replied">Replied</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Format</Label>
              <Select value={format} onValueChange={(v) => setFormat(v as 'xlsx' | 'csv')}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="xlsx">Excel (.xlsx)</SelectItem>
                  <SelectItem value="csv">CSV (.csv)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Live count. When a range comes back empty or thin, say where the data actually is —
              an export of a quiet day otherwise reads as "the logs have been deleted". */}
          <div
            className={cn(
              'flex flex-col gap-1 rounded-lg border px-3 py-2 text-xs',
              nothingMatched ? 'border-warning/30 bg-warning/10 text-warning' : 'border-border bg-muted/40 text-muted-foreground'
            )}
          >
            <div className="flex items-center gap-2">
              {counting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> counting…
                </>
              ) : preview ? (
                nothingMatched ? (
                  <>
                    <b>No logs</b> in this range for this selection.
                  </>
                ) : (
                  <>
                    <b className="tabular">{preview.rowCount.toLocaleString()}</b> row(s) will be exported · detail sheet + a
                    summary tab
                    {preview.truncated ? ' · this range is very large and will be truncated' : ''}
                  </>
                )
              ) : (
                <>Pick a valid date range to see how many rows match.</>
              )}
            </div>

            {latestAt && !counting ? (
              <p className={cn('flex flex-wrap items-center gap-1', nothingMatched && 'text-warning')}>
                Most recent activity for this selection:{' '}
                <b>{new Date(latestAt).toLocaleString()}</b>
                {nothingMatched ? ' — widen the range to include it.' : ''}
                {nothingMatched ? (
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto p-0 text-xs font-semibold underline"
                    onClick={() => {
                      const d = istDayOffsetFor(new Date(latestAt))
                      setFrom(d)
                      setTo(d)
                      setPreset('custom')
                    }}
                  >
                    Jump to that day
                  </Button>
                ) : null}
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={download} disabled={downloading || nothingMatched} className="gap-1.5">
            {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Download {format === 'xlsx' ? 'Excel' : 'CSV'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

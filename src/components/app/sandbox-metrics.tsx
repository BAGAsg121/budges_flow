'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { MessageCircle, MousePointerClick, RefreshCw, TriangleAlert } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { cn } from '@/lib/utils'
import { seriesIsEmpty, type DayBucket } from '@/lib/engagement-stats'

/* ─────────────────────────────── types ─────────────────────────────── */

interface Totals {
  nudgeKey: string
  nudgeName: string | null
  sent: number
  failed: number
  opened: number
  opensTotal: number
  replied: number
  capped: number
  clicked: number
  clicks: number
  lastSentAt: string | null
}

interface SandboxNudge {
  key: string
  label: string
  enabled: boolean
  templateName: string
  capApplies: boolean
  max: number | null
  followUpDays: number | null
  liveMatchEstimate: number | null
  totals: Totals
  /** This nudge's OWN buckets. There is deliberately no combined series in the payload. */
  series: DayBucket[]
}

interface Payload {
  ok: boolean
  days: number
  nudges: SandboxNudge[]
  missing: string[]
}

/* ────────────────────────────── the chart ────────────────────────────── */

const chartConfig = {
  sent: { label: 'Sent', color: 'var(--chart-1)' },
  opened: { label: 'Read', color: 'var(--chart-2)' },
  clicked: { label: 'Clicked', color: 'var(--chart-3)' },
  failed: { label: 'Failed', color: 'var(--chart-4)' },
} satisfies ChartConfig

/**
 * Sent / read / failed over time for ONE sandbox nudge.
 *
 * Each nudge gets its own series rather than sharing one: these are separate campaigns with
 * separate templates, so a combined line would answer a question nobody asked and hide the
 * per-template comparison this section exists for.
 */
function NudgeChart({ series }: { series: DayBucket[] }) {
  const data = useMemo(
    () =>
      series.map((d) => {
        const label = new Date(`${d.date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
        return { day: label, sent: d.waSent, opened: d.waOpened, clicked: d.waClicked, failed: d.waFailed }
      }),
    [series]
  )

  if (seriesIsEmpty(series)) {
    return (
      <p className="py-8 text-center text-xs text-muted-foreground">Nothing sent in this window.</p>
    )
  }

  return (
    <ChartContainer config={chartConfig} className="h-[150px] w-full">
      <BarChart data={data} margin={{ left: -22, right: 4, top: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={6} fontSize={10} />
        <YAxis tickLine={false} axisLine={false} fontSize={10} allowDecimals={false} width={30} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="sent" fill="var(--color-sent)" radius={[3, 3, 0, 0]} maxBarSize={16} />
        <Bar dataKey="opened" fill="var(--color-opened)" radius={[3, 3, 0, 0]} maxBarSize={16} />
        <Bar dataKey="clicked" fill="var(--color-clicked)" radius={[3, 3, 0, 0]} maxBarSize={16} />
        <Bar dataKey="failed" fill="var(--color-failed)" radius={[3, 3, 0, 0]} maxBarSize={16} />
      </BarChart>
    </ChartContainer>
  )
}

/* ────────────────────────────── one nudge ────────────────────────────── */

function NudgeCard({ nudge }: { nudge: SandboxNudge }) {
  const t = nudge.totals
  const attempted = t.sent + t.failed
  const delivered = attempted ? Math.round((t.sent / attempted) * 100) : null
  const readRate = t.sent > 0 ? Math.round((t.opened / t.sent) * 100) : 0
  const clickRate = t.sent > 0 ? Math.round((t.clicked / t.sent) * 100) : 0

  const cells = [
    { label: 'Sent', value: t.sent, tone: t.sent ? 'text-success' : 'text-muted-foreground' },
    { label: 'Failed', value: t.failed, tone: t.failed ? 'text-destructive' : 'text-muted-foreground' },
    { label: 'Read', value: t.opened, tone: t.opened ? 'text-info' : 'text-muted-foreground' },
    { label: 'Replied', value: t.replied, tone: t.replied ? 'text-success' : 'text-muted-foreground' },
    { label: 'Clicked', value: t.clicked, tone: t.clicked ? 'text-info' : 'text-muted-foreground' },
  ]

  return (
    <Card className="overflow-hidden">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h4 className="flex items-center gap-1.5 text-sm font-semibold">
              <MessageCircle className="h-3.5 w-3.5 shrink-0 text-success" />
              <span className="truncate">{nudge.label}</span>
            </h4>
            {/* The key and the template, so the split between nudges is auditable rather than
                taken on trust — the same reason the family charts print their source key. */}
            <p className="mono mt-0.5 truncate text-[11px] text-muted-foreground">{nudge.key}</p>
            <p className="truncate text-[11px] text-muted-foreground" title={nudge.templateName}>
              template: {nudge.templateName}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
            {nudge.enabled ? (
              <Badge className="h-5 bg-success px-1.5 text-[10px] text-success-foreground hover:bg-success">on</Badge>
            ) : (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                off
              </Badge>
            )}
            {!nudge.capApplies ? (
              <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-medium">
                once per recipient
              </Badge>
            ) : nudge.max !== null ? (
              <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-medium">
                max {nudge.max}/lead{nudge.followUpDays ? ` · every ${nudge.followUpDays}d` : ''}
              </Badge>
            ) : null}
            {t.capped ? (
              <Badge className="h-5 bg-warning px-1.5 text-[10px] text-warning-foreground hover:bg-warning">
                {t.capped} capped
              </Badge>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {cells.map((c) => (
            <div key={c.label} className="rounded-lg border border-border bg-muted/30 px-2.5 py-1.5">
              <p className="text-[10px] font-medium text-muted-foreground">{c.label}</p>
              <p className={cn('tabular text-lg font-semibold leading-tight', c.tone)}>{c.value}</p>
            </div>
          ))}
        </div>

        <NudgeChart series={nudge.series} />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>{delivered === null ? 'no attempts yet' : `${delivered}% accepted of ${attempted}`}</span>
          {t.sent > 0 ? <span>read {readRate}%</span> : null}
          {t.sent > 0 ? <span>clicked {clickRate}%</span> : null}
          {t.clicks > t.clicked ? <span>{t.clicks} total taps</span> : null}
          {nudge.liveMatchEstimate !== null ? <span>~{nudge.liveMatchEstimate} match the criteria</span> : null}
          {t.lastSentAt ? <span>last sent {new Date(t.lastSentAt).toLocaleString()}</span> : null}
        </div>
      </CardContent>
    </Card>
  )
}

/* ────────────────────────────── section ────────────────────────────── */

export function SandboxMetrics({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState(14)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/stats/sandbox?days=${days}`)
      if (res.ok) setData((await res.json()) as Payload)
    } finally {
      setLoading(false)
    }
  }, [days])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      </div>
    )
  }
  if (!data) return null

  const sum = data.nudges.reduce(
    (acc, n) => {
      acc.sent += n.totals.sent
      acc.failed += n.totals.failed
      acc.opened += n.totals.opened
      acc.replied += n.totals.replied
      acc.clicked += n.totals.clicked
      acc.capped += n.totals.capped
      return acc
    },
    { sent: 0, failed: 0, opened: 0, replied: 0, clicked: 0, capped: 0 }
  )

  const summary = [
    { label: 'Sent', value: sum.sent, tone: sum.sent ? 'text-success' : 'text-muted-foreground' },
    { label: 'Failed', value: sum.failed, tone: sum.failed ? 'text-destructive' : 'text-muted-foreground' },
    { label: 'Read', value: sum.opened, tone: sum.opened ? 'text-info' : 'text-muted-foreground' },
    { label: 'Replied', value: sum.replied, tone: sum.replied ? 'text-success' : 'text-muted-foreground' },
    { label: 'Clicked', value: sum.clicked, tone: sum.clicked ? 'text-info' : 'text-muted-foreground' },
    { label: 'Capped', value: sum.capped, tone: sum.capped ? 'text-warning' : 'text-muted-foreground' },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <MessageCircle className="h-4 w-4 text-success" />
            Sandbox WhatsApp nudges
          </h3>
          <p className="field-hint">
            Every sandbox nudge, each with its own template and audience. <b>Read</b> is Meta&apos;s read
            receipt, <b>Clicked</b> is a tap on the template&apos;s tracked button, and <b>Capped</b> is Meta
            dropping a send for engagement reasons (retried later).
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="flex rounded-lg border border-border p-0.5">
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  days === d ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {d}d
              </button>
            ))}
          </div>
          <Button variant="ghost" size="icon" onClick={load} aria-label="Reload sandbox engagement">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {data.missing.length ? (
        <p className="flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Configured in code but not in the database: {data.missing.join(', ')}. Run{' '}
            <code className="mono">npm run seed:nudges</code>.
          </span>
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {summary.map((c) => (
          <div key={c.label} className="rounded-xl border border-border bg-muted/30 px-3 py-2">
            <p className="text-[11px] font-medium text-muted-foreground">{c.label}</p>
            <p className={cn('tabular text-xl font-semibold leading-tight', c.tone)}>{c.value}</p>
          </div>
        ))}
      </div>

      {data.nudges.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No sandbox nudges are configured.</p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {data.nudges.map((n) => (
            <NudgeCard key={n.key} nudge={n} />
          ))}
        </div>
      )}

      {sum.sent === 0 && sum.failed === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MousePointerClick className="h-3.5 w-3.5" />
          Nothing has been sent by a sandbox nudge yet in this window. They ship disabled — enable one, or run it
          once from the Nudges tab.
        </p>
      ) : null}
    </div>
  )
}

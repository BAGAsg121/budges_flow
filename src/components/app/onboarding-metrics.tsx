'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { Mail, MessageCircle, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
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
  lastSentAt: string | null
}

interface Family {
  id: string
  label: string
  email: Totals
  whatsapp: Totals
  config: {
    emailMax: number | null
    emailFollowUpDays: number | null
    whatsappMax: number | null
    whatsappFollowUpDays: number | null
    /** False when the nudge is sheet-driven and no cap is enforced. */
    emailCapApplies: boolean
    whatsappCapApplies: boolean
  }
  /** The two nudge keys this family counts. Shown in the UI so the split is auditable. */
  nudgeKeys: string[]
  /**
   * This family's OWN daily buckets. There is deliberately no combined series in the payload:
   * one used to exist and both families rendered it, so the two charts were identical.
   */
  series: DayBucket[]
}

interface Payload {
  ok: boolean
  days: number
  families: Family[]
  missingNudges: string[]
}

/* ────────────────────────────── the chart ────────────────────────────── */

const chartConfig = {
  sent: { label: 'Sent', color: 'var(--chart-1)' },
  opened: { label: 'Opened', color: 'var(--chart-2)' },
  failed: { label: 'Failed', color: 'var(--chart-4)' },
} satisfies ChartConfig

/**
 * Sent / opened / failed over time, per channel.
 *
 * Email and WhatsApp are a toggle rather than six series on one axis: at 14 days they would
 * overlap into noise, and the question ("is WhatsApp or email getting the response?") is
 * answered better by flipping between them.
 */
function HistoryChart({ family, series }: { family: Family; series: DayBucket[] }) {
  const [channel, setChannel] = useState<'email' | 'whatsapp'>('email')

  const data = useMemo(
    () =>
      series.map((d) => {
        const label = new Date(`${d.date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
        return channel === 'email'
          ? { day: label, sent: d.emailSent, opened: d.emailOpened, failed: d.emailFailed }
          : { day: label, sent: d.waSent, opened: d.waOpened, failed: d.waFailed }
      }),
    [series, channel]
  )

  const hasAny = !seriesIsEmpty(series)

  // Which nudge key this chart is counting, so the split between the two families is visible
  // rather than taken on trust.
  const sourceKey = channel === 'email' ? family.nudgeKeys[0] : family.nudgeKeys[1]

  return (
    <Card>
      <CardContent className="p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="panel-title">
              {channel === 'email' ? <Mail className="h-4 w-4 text-muted-foreground" /> : <MessageCircle className="h-4 w-4 text-success" />}
              {family.label}
            </h4>
            <p className="field-hint mt-0.5">
              {channel === 'email' ? 'Email' : 'WhatsApp'} · last {series.length} day(s)
              {channel === 'whatsapp' ? ' · opened = read receipt' : ''}
            </p>
            <p className="mono mt-0.5 text-[11px] text-muted-foreground">{sourceKey}</p>
          </div>
          <div className="flex rounded-lg border border-border p-0.5">
            {(['email', 'whatsapp'] as const).map((c) => (
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
        </div>

        {!hasAny ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Nothing sent on {channel} yet for this nudge.
          </p>
        ) : (
          <ChartContainer config={chartConfig} className="h-[220px] w-full">
            <BarChart data={data} margin={{ left: -18, right: 6, top: 6 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} />
              <YAxis tickLine={false} axisLine={false} fontSize={11} allowDecimals={false} width={34} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="sent" fill="var(--color-sent)" radius={[3, 3, 0, 0]} maxBarSize={22} />
              <Bar dataKey="opened" fill="var(--color-opened)" radius={[3, 3, 0, 0]} maxBarSize={22} />
              <Bar dataKey="failed" fill="var(--color-failed)" radius={[3, 3, 0, 0]} maxBarSize={22} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

/* ────────────────────────────── metric tiles ────────────────────────────── */

function ChannelBlock({
  channel,
  totals,
  max,
  followUpDays,
  capApplies,
}: {
  channel: 'email' | 'whatsapp'
  totals: Totals
  max: number | null
  followUpDays: number | null
  /** False for sheet nudges, whose cap nothing enforces. */
  capApplies: boolean
}) {
  const isWa = channel === 'whatsapp'
  const attempted = totals.sent + totals.failed
  const delivered = attempted ? Math.round((totals.sent / attempted) * 100) : null

  const cells = [
    { label: 'Sent', value: totals.sent, tone: 'text-success' },
    { label: 'Failed', value: totals.failed, tone: totals.failed ? 'text-destructive' : 'text-muted-foreground' },
    { label: isWa ? 'Read' : 'Opened', value: totals.opened, tone: totals.opened ? 'text-info' : 'text-muted-foreground' },
    { label: 'Replied', value: totals.replied, tone: totals.replied ? 'text-success' : 'text-muted-foreground' },
  ]

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3.5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          {isWa ? <MessageCircle className="h-3.5 w-3.5 text-success" /> : <Mail className="h-3.5 w-3.5 text-primary" />}
          {isWa ? 'WhatsApp' : 'Email'}
          <span className="mono font-normal text-muted-foreground">{totals.nudgeKey}</span>
        </p>
        <div className="flex items-center gap-1.5">
          {!capApplies ? (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-medium">
              once per recipient
            </Badge>
          ) : max !== null ? (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-medium">
              max {max}/lead{followUpDays ? ` · every ${followUpDays}d` : ''}
            </Badge>
          ) : null}
          {isWa && totals.capped ? (
            <Badge className="h-5 bg-warning px-1.5 text-[10px] text-warning-foreground hover:bg-warning">
              {totals.capped} capped
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {cells.map((c) => (
          <div key={c.label} className="rounded-lg bg-card px-2.5 py-2">
            <p className="text-[11px] font-medium text-muted-foreground">{c.label}</p>
            <p className={cn('tabular text-xl font-semibold leading-tight', c.tone)}>{c.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          {delivered === null ? 'no attempts yet' : `${delivered}% accepted of ${attempted} attempt(s)`}
        </span>
        {totals.opensTotal > totals.opened ? <span>{totals.opensTotal} total opens</span> : null}
        {totals.lastSentAt ? <span>last sent {new Date(totals.lastSentAt).toLocaleString()}</span> : null}
      </div>
    </div>
  )
}

/* ───────────────────────────────── section ───────────────────────────────── */

export function OnboardingMetrics({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [days, setDays] = useState(14)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/stats/onboarding?days=${days}`)
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
        <Skeleton className="h-64" />
        <Skeleton className="h-72" />
      </div>
    )
  }
  if (!data) return null

  const totalsOf = (pick: (f: Family) => Totals) =>
    data.families.reduce(
      (acc, f) => {
        const t = pick(f)
        acc.sent += t.sent
        acc.failed += t.failed
        acc.opened += t.opened
        acc.replied += t.replied
        return acc
      },
      { sent: 0, failed: 0, opened: 0, replied: 0 }
    )

  const wa = totalsOf((f) => f.whatsapp)
  const em = totalsOf((f) => f.email)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Activation-fee nudges</h3>
          <p className="field-hint">
            The two onboarding nudges and their WhatsApp twins. <b>Opened</b> is the email tracking pixel;
            for WhatsApp it is Meta&apos;s read receipt.
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
          <Button variant="ghost" size="icon" onClick={load} aria-label="Reload engagement">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {data.missingNudges.length ? (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          These nudges are not in the database: {data.missingNudges.join(', ')}. Run{' '}
          <code className="mono">npm run seed:nudges</code>.
        </p>
      ) : null}

      {data.families.map((f) => (
        <Card key={f.id}>
          <CardContent className="space-y-3 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold">{f.label}</h4>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {em.sent + wa.sent > 0 ? <TrendingUp className="h-3.5 w-3.5 text-success" /> : null}
                {data.days}d window below
              </div>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <ChannelBlock
                channel="email"
                totals={f.email}
                max={f.config.emailMax}
                followUpDays={f.config.emailFollowUpDays}
                capApplies={f.config.emailCapApplies}
              />
              <ChannelBlock
                channel="whatsapp"
                totals={f.whatsapp}
                max={f.config.whatsappMax}
                followUpDays={f.config.whatsappFollowUpDays}
                capApplies={f.config.whatsappCapApplies}
              />
            </div>
          </CardContent>
        </Card>
      ))}

      <div className="grid gap-4 lg:grid-cols-2">
        {data.families.map((f) => (
          <HistoryChart key={f.id} family={f} series={f.series} />
        ))}
      </div>

      {em.sent + wa.sent === 0 && em.failed + wa.failed === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <TrendingDown className="h-3.5 w-3.5" />
          Nothing has been sent by these four nudges yet. Run one from the Nudges tab — the two WhatsApp ones
          send from a Google Sheet, the two email ones too.
        </p>
      ) : null}
    </div>
  )
}

'use client'

/**
 * V2 — the Journey Analytics tab.
 *
 * The macro view, in four blocks:
 *   1. Stage funnel        — how many leads are in each CRM stage right now
 *   2. Average time/stage  — how long leads typically spend before leaving a stage
 *   3. Top converting nudges — ranked by attributed conversion rate
 *   4. Score distribution  — how many leads are Cold / Warming / Engaged / Hot
 *
 * Every block states its own caveat in place rather than in a footnote, because this tab is the one
 * most likely to be screenshotted into a decision. Conversion is attribution, not causation, and the
 * ranking excludes low-volume nudges on purpose — a nudge that sent once and converted once is not
 * a 100% success story.
 */
import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { RefreshCw, TrendingUp, GitBranch, Clock, ChevronRight } from 'lucide-react'
import { ScoreBadge, bandDot } from '@/components/app/score-badge'
import { LeadJourneyDrawer } from '@/components/app/lead-journey-drawer'
import { CONFIDENCE_LABEL, SCORE_BAND_LABEL, type ConfidenceBand, type ScoreBand } from '@/lib/journey'
import { cn } from '@/lib/utils'

interface ImpactRow {
  nudge: string
  name: string
  channel: string
  totalSends: number
  leadsWhoChangedStatus: number
  conversionRate: string
  avgHoursToStatusChange: number | null
  breakdownByMessageNumber: Record<string, { sends: number; conversions: number; rate: string }>
}

interface ImpactPayload {
  ok: boolean
  attributionWindowHours: number
  minSendsForRanking: number
  totals: { sends: number; attributedChanges: number; organicChanges: number }
  topConvertingNudges: ImpactRow[]
  nudges: ImpactRow[]
}

interface FlowPayload {
  ok: boolean
  recentTransitions: TransitionRow[]
  currentStages: { status: string; leads: number }[]
  transitions: { from: string; to: string; leads: number; avgHoursInFromStage: number | null }[]
  avgHoursInStage: { status: string; avgHours: number | null; transitions: number }[]
  note: string
}

/** A recorded transition, as the report returns it — with enough to open the lead's story. */
interface TransitionRow {
  id: string
  leadId: string
  leadName: string
  fromStatus: string | null
  toStatus: string
  detectedAt: string
  timeInPrevStageHours: number | null
  attributedNudgeKey: string | null
  attributedChannel: string | null
  hoursSinceNudge: number | null
  confidenceScore: number | null
  confidenceBand: string | null
  nudgesBeforeCount: number
}

const BANDS: ScoreBand[] = ['cold', 'warming', 'engaged', 'hot']

export function JourneyTab({ refreshKey }: { refreshKey: number }) {
  const [impact, setImpact] = useState<ImpactPayload | null>(null)
  const [flow, setFlow] = useState<FlowPayload | null>(null)
  const [bands, setBands] = useState<Record<string, number> | null>(null)
  const [loading, setLoading] = useState(true)
  /** Which lead's lifecycle drawer is open, and which transition to highlight in it. */
  const [openLeadId, setOpenLeadId] = useState<string | null>(null)
  const [focusTransitionId, setFocusTransitionId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [i, f, ...bandCounts] = await Promise.all([
        fetch('/api/reports/nudge-impact').then((r) => r.json()),
        fetch('/api/reports/stage-flow').then((r) => r.json()),
        ...BANDS.map((b) => fetch(`/api/leads?band=${b}&limit=1`).then((r) => r.json())),
      ])
      setImpact(i as ImpactPayload)
      setFlow(f as FlowPayload)
      // Each band query returns its own `count`, so the histogram needs no extra endpoint.
      const counts: Record<string, number> = {}
      BANDS.forEach((b, idx) => {
        counts[b] = (bandCounts[idx] as { count?: number })?.count ?? 0
      })
      setBands(counts)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  if (loading && !impact) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-56" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  const totalLeads = bands ? BANDS.reduce((n, b) => n + (bands[b] ?? 0), 0) : 0
  const maxStage = flow?.currentStages[0]?.leads ?? 1

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Journey analytics</h3>
          <p className="field-hint">
            Attribution is <b>probabilistic</b>: a stage change is credited to the last nudge sent before it, within{' '}
            {impact?.attributionWindowHours ?? 72}h. It records what preceded a change, not what caused it.
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={load} aria-label="Reload journey analytics">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* --- score distribution ------------------------------------------------ */}
      <Card>
        <CardContent className="p-4 sm:p-5 space-y-3">
          <h4 className="panel-title">
            <TrendingUp className="h-4 w-4 text-success" /> Score distribution
          </h4>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {BANDS.map((b) => (
              <div key={b} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <span aria-hidden>{bandDot(b)}</span>
                  {SCORE_BAND_LABEL[b]}
                </p>
                <p className="tabular text-xl font-semibold leading-tight">{bands?.[b] ?? 0}</p>
              </div>
            ))}
          </div>
          <p className="field-hint">
            Across {totalLeads} lead(s) with a calculated score. Cold 0–20 · Warming 21–45 · Engaged 46–70 · Hot 71+.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* --- stage funnel ---------------------------------------------------- */}
        <Card>
          <CardContent className="p-4 sm:p-5 space-y-3">
            <h4 className="panel-title">
              <GitBranch className="h-4 w-4 text-info" /> Leads per stage (now)
            </h4>
            {!flow?.currentStages.length ? (
              <p className="text-xs text-muted-foreground">No leads synced yet.</p>
            ) : (
              <div className="space-y-1.5">
                {flow.currentStages.map((s) => (
                  <div key={s.status} className="space-y-0.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="truncate">{s.status}</span>
                      <span className="tabular-nums font-semibold">{s.leads}</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-info"
                        style={{ width: `${Math.max(2, Math.round((s.leads / maxStage) * 100))}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* --- time per stage -------------------------------------------------- */}
        <Card>
          <CardContent className="p-4 sm:p-5 space-y-3">
            <h4 className="panel-title">
              <Clock className="h-4 w-4 text-warning" /> Average time per stage
            </h4>
            {!flow?.avgHoursInStage.length ? (
              <p className="text-xs text-muted-foreground">
                No transitions detected yet. Averages appear once leads actually move stage under observation —
                a stage nothing has left reports no average rather than zero.
              </p>
            ) : (
              <div className="space-y-1.5">
                {flow.avgHoursInStage.map((s) => (
                  <div key={s.status} className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-xs">
                    <span className="truncate">{s.status}</span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums font-semibold">
                        {s.avgHours === null ? '—' : s.avgHours < 48 ? `${s.avgHours}h` : `${Math.round((s.avgHours / 24) * 10) / 10}d`}
                      </span>
                      <span className="text-muted-foreground">({s.transitions} left)</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p className="field-hint">{flow?.note}</p>
          </CardContent>
        </Card>
      </div>

      {/* --- recorded transitions: click one to open the lead's whole story --------- */}
      <Card>
        <CardContent className="p-4 sm:p-5 space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h4 className="panel-title">Recorded transitions</h4>
              <p className="field-hint">
                Newest first. Click any one to open that lead&apos;s full lifecycle — every nudge it received,
                when, and how strongly each can be credited for the move.
              </p>
            </div>
          </div>

          {!flow?.recentTransitions?.length ? (
            <p className="text-xs text-muted-foreground">
              No transitions recorded yet. The history starts from the first sync that sees a lead change
              stage — it cannot show moves that happened before it was watching.
            </p>
          ) : (
            <div className="space-y-1">
              {flow.recentTransitions.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setOpenLeadId(t.leadId)
                    setFocusTransitionId(t.id)
                  }}
                  className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border px-2.5 py-2 text-left text-xs transition-colors hover:border-primary/50 hover:bg-primary/5"
                >
                  <span className="font-medium">{t.leadName}</span>
                  {t.confidenceScore !== null ? (
                    <Badge
                      variant="outline"
                      className={cn(
                        'h-5 px-1.5 text-[10px] font-normal',
                        t.confidenceBand === 'strong' && 'border-success/40 bg-success/10 text-success',
                        t.confidenceBand === 'moderate' && 'border-info/40 bg-info/10 text-info',
                        t.confidenceBand === 'weak' && 'border-warning/40 bg-warning/10 text-warning'
                      )}
                    >
                      {t.confidenceBand ? CONFIDENCE_LABEL[t.confidenceBand as ConfidenceBand] : '—'} ·{' '}
                      {t.confidenceScore}%
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal text-muted-foreground">
                      un-attributed
                    </Badge>
                  )}
                  <span className="text-muted-foreground">
                    {t.fromStatus ?? '(first seen)'} → <b className="text-foreground">{t.toStatus}</b>
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-muted-foreground">
                    {new Date(t.detectedAt).toLocaleString(undefined, {
                      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                  {t.timeInPrevStageHours !== null ? (
                    <span className="text-muted-foreground">
                      · took{' '}
                      {t.timeInPrevStageHours < 48
                        ? `${Math.round(t.timeInPrevStageHours * 10) / 10}h`
                        : `${Math.round((t.timeInPrevStageHours / 24) * 10) / 10}d`}
                    </span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
                    {t.nudgesBeforeCount > 0 ? (
                      <span>
                        {t.nudgesBeforeCount} nudge{t.nudgesBeforeCount === 1 ? '' : 's'} before
                      </span>
                    ) : (
                      <span>no nudge in window</span>
                    )}
                    {t.attributedNudgeKey ? (
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                        {t.attributedNudgeKey}
                      </Badge>
                    ) : null}
                    <ChevronRight className="h-3.5 w-3.5" />
                  </span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* --- stage transitions --------------------------------------------------- */}
      <Card>
        <CardContent className="p-4 sm:p-5 space-y-3">
          <h4 className="panel-title">Stage transitions observed</h4>
          {!flow?.transitions.length ? (
            <p className="text-xs text-muted-foreground">No transitions recorded yet.</p>
          ) : (
            <div className="max-h-72 overflow-y-auto space-y-1">
              {flow.transitions.map((t, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
                  <span className="font-medium">{t.from}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="font-semibold">{t.to}</span>
                  <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">{t.leads} lead(s)</Badge>
                  {t.avgHoursInFromStage !== null ? (
                    <span className="text-muted-foreground">
                      after {t.avgHoursInFromStage < 48 ? `${t.avgHoursInFromStage}h` : `${Math.round((t.avgHoursInFromStage / 24) * 10) / 10}d`}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* --- nudge impact -------------------------------------------------------- */}
      <Card>
        <CardContent className="p-4 sm:p-5 space-y-3">
          <h4 className="panel-title">Nudge impact — attributed stage changes</h4>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              <b className="text-foreground">{impact?.totals.sends ?? 0}</b> successful send(s)
            </span>
            <span>
              <b className="text-foreground">{impact?.totals.attributedChanges ?? 0}</b> attributed change(s)
            </span>
            <span>
              <b className="text-foreground">{impact?.totals.organicChanges ?? 0}</b> organic (no nudge in window)
            </span>
          </div>

          {!impact?.nudges.length ? (
            <p className="text-xs text-muted-foreground">Nothing has been sent, so there is nothing to attribute.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Nudge</th>
                    <th className="py-1.5 pr-3 font-medium">Channel</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Sends</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Changes</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Rate</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Avg time to change</th>
                    <th className="py-1.5 font-medium">By message #</th>
                  </tr>
                </thead>
                <tbody>
                  {impact.nudges.map((n) => (
                    <tr key={n.nudge} className="border-b border-border/50">
                      <td className="py-1.5 pr-3">
                        <span className="font-medium">{n.nudge}</span>
                        <span className="block text-[10px] text-muted-foreground">{n.name}</span>
                      </td>
                      <td className="py-1.5 pr-3">{n.channel}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{n.totalSends}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{n.leadsWhoChangedStatus}</td>
                      <td className={cn('py-1.5 pr-3 text-right tabular-nums font-semibold', parseFloat(n.conversionRate) > 0 ? 'text-success' : 'text-muted-foreground')}>
                        {n.conversionRate}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        {n.avgHoursToStatusChange === null ? '—' : `${n.avgHoursToStatusChange}h`}
                      </td>
                      <td className="py-1.5">
                        <span className="flex flex-wrap gap-1">
                          {Object.entries(n.breakdownByMessageNumber)
                            .sort(([a], [b]) => Number(a) - Number(b))
                            .map(([msg, v]) => (
                              <Badge key={msg} variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                                #{msg}: {v.conversions}/{v.sends}
                              </Badge>
                            ))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="field-hint">
            Ranked below by conversion rate, but only among nudges with at least {impact?.minSendsForRanking ?? 20}{' '}
            sends — one send and one change is 100% and means nothing.
          </p>
          {impact?.topConvertingNudges.length ? (
            <div className="space-y-1">
              {impact.topConvertingNudges.map((n, i) => (
                <div key={n.nudge} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
                  <span className="tabular-nums text-muted-foreground">#{i + 1}</span>
                  <span className="font-medium">{n.nudge}</span>
                  <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">{n.channel}</Badge>
                  <span className="ml-auto tabular-nums font-semibold text-success">{n.conversionRate}</span>
                  <span className="text-muted-foreground">
                    ({n.leadsWhoChangedStatus}/{n.totalSends})
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No nudge has reached the {impact?.minSendsForRanking ?? 20}-send threshold yet, so nothing is ranked.
            </p>
          )}
        </CardContent>
      </Card>

      <p className="field-hint">
        The engagement score and all attribution are <b>reporting signals only</b>. They never change who is nudged —
        eligibility stays with each nudge&apos;s own filters.
      </p>

      {/* Opened by clicking a recorded transition above, on that transition. */}
      <LeadJourneyDrawer
        leadId={openLeadId}
        focusTransitionId={focusTransitionId}
        onClose={() => {
          setOpenLeadId(null)
          setFocusTransitionId(null)
        }}
      />
    </div>
  )
}

export { ScoreBadge }

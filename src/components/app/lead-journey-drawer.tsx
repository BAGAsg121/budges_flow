'use client'

/**
 * V2 — the lead journey drawer.
 *
 * Opened by clicking a lead in the Leads tab. Shows, in the order an operator actually asks for it:
 * the score and what produced it, the stage timeline with the nudge attributed to each change, every
 * message sent, and the last nudge summary.
 *
 * TWO LABELLING RULES, both about not overclaiming:
 *   • An attributed nudge is shown as "last nudge before this change", never "caused by". The API
 *     sets `attributionIsProbabilistic` and the footer says so in words.
 *   • A stage change with NO attributed nudge says "no nudge in the window — organic change" rather
 *     than being left blank, so an empty cell never reads as "we don't know" when we do.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { MessageCircle, Mail, MousePointerClick, Eye, Reply, AlertTriangle } from 'lucide-react'
import { ScoreBadge } from '@/components/app/score-badge'
import { CONFIDENCE_LABEL, SCORE_BAND_LABEL, SCORE_WEIGHTS, type ConfidenceBand, type ScoreBand } from '@/lib/journey'
import { cn } from '@/lib/utils'

interface NudgeBefore {
  id: string
  nudgeKey: string | null
  nudgeName: string | null
  channel: string
  messageNumber: number
  sentAt: string
  hoursBeforeChange: number
  opened: boolean
  replied: boolean
  ctaClicks: number
  templateName: string | null
}

interface Confidence {
  score: number
  band: 'weak' | 'moderate' | 'strong'
  factors: { label: string; points: number; max: number; detail: string }[]
}

interface StageRow {
  id: string
  fromStatus: string | null
  toStatus: string
  detectedAt: string
  timeInPrevStageHours: number | null
  attributedNudgeKey: string | null
  attributedNudgeName: string | null
  attributedChannel: string | null
  attributedMessageNumber: number | null
  hoursSinceNudge: number | null
  /** Every nudge inside the attribution window before this change, newest first. */
  nudgesBefore: NudgeBefore[]
  /** The one credited, so it can be marked in the list. */
  attributedLogId: string | null
  confidence: Confidence | null
}

interface NudgeRow {
  id: string
  nudgeKey: string | null
  channel: string
  messageNumber: number
  sentAt: string | null
  sentOk: boolean
  opened: boolean
  replied: boolean
  ctaClicks: number
  ctaClickedAt: string | null
  templateName: string | null
  subject: string | null
  error: string | null
  reply: string | null
}

interface JourneyPayload {
  ok: boolean
  error?: string
  lead: {
    id: string
    name: string
    email: string | null
    mobile: string | null
    company: string | null
    currentStatus: string | null
    firstNudgeSentAt: string | null
    lastStatusChangedAt: string | null
    totalDaysToConvert: number | null
    converted: boolean
  }
  score: {
    value: number
    band: ScoreBand
    breakdown: Record<string, number>
    counts: Record<string, number>
    capped: boolean
    calculatedAt: string | null
  }
  stageHistory: StageRow[]
  /** Chronological lifecycle summary, oldest first. */
  timeline: {
    id: string
    fromStatus: string | null
    toStatus: string
    detectedAt: string
    timeInPrevStageHours: number | null
    attributedNudgeKey: string | null
    attributedChannel: string | null
    confidenceScore: number | null
    confidenceBand: string | null
    nudgesBeforeCount: number
  }[]
  nudgeHistory: NudgeRow[]
  lastNudge: {
    nudgeKey: string | null
    channel: string
    messageNumber: number
    sentAt: string | null
    templateName: string | null
    opened: boolean
    replied: boolean
    ctaClicks: number
  } | null
  attributionWindowHours: number
  attributionIsProbabilistic: boolean
}

const SIGNAL_LABEL: Record<string, string> = {
  whatsappSent: `WhatsApp sent (+${SCORE_WEIGHTS.whatsappSent}/msg, max +${SCORE_WEIGHTS.whatsappSentCap})`,
  emailSent: `Email sent (+${SCORE_WEIGHTS.emailSent}/msg)`,
  opened: `Opened / read (+${SCORE_WEIGHTS.opened} each)`,
  replied: `Replied (+${SCORE_WEIGHTS.replied})`,
  ctaClicked: `CTA clicked (+${SCORE_WEIGHTS.ctaClicked})`,
  ctaRepeatBonus: `CTA clicked 2+ times (+${SCORE_WEIGHTS.ctaRepeatBonus})`,
  statusChanged: `CRM status changed (+${SCORE_WEIGHTS.statusChanged})`,
}

const hours = (n: number | null) =>
  n === null ? '—' : n < 48 ? `${Math.round(n * 10) / 10}h` : `${Math.round((n / 24) * 10) / 10}d`

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

export function LeadJourneyDrawer({
  leadId,
  onClose,
  focusTransitionId = null,
}: {
  leadId: string | null
  onClose: () => void
  /** The transition the operator clicked, highlighted so the drawer opens on the right one. */
  focusTransitionId?: string | null
}) {
  const [data, setData] = useState<JourneyPayload | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/leads/${id}/journey`)
      const payload = (await res.json()) as JourneyPayload
      setData(payload.ok ? payload : null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (leadId) {
      setData(null)
      load(leadId)
    }
  }, [leadId, load])

  return (
    <Dialog open={!!leadId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        {loading && !data ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : !data ? (
          <DialogHeader>
            <DialogTitle>Could not load this lead&apos;s journey</DialogTitle>
          </DialogHeader>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {data.lead.name}
                <ScoreBadge score={data.score.value} band={data.score.band} />
                {data.score.capped ? (
                  <Badge variant="outline" className="text-[10px] font-normal">at ceiling</Badge>
                ) : null}
              </DialogTitle>
              <DialogDescription className="flex flex-wrap gap-x-3 gap-y-0.5">
                <span>{data.lead.company || '—'}</span>
                <span>·</span>
                <span>{data.lead.email || data.lead.mobile || 'no contact'}</span>
                <span>·</span>
                <span>
                  now: <b>{data.lead.currentStatus || 'unknown'}</b>
                </span>
                {data.lead.totalDaysToConvert !== null ? (
                  <>
                    <span>·</span>
                    <span>
                      converted in <b>{data.lead.totalDaysToConvert}</b> day(s)
                    </span>
                  </>
                ) : null}
              </DialogDescription>
            </DialogHeader>

            {/* --- score breakdown ------------------------------------------------- */}
            <section className="space-y-2">
              <h4 className="panel-title">Why this score</h4>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {Object.entries(data.score.breakdown).map(([signal, points]) => (
                  <div
                    key={signal}
                    className={cn(
                      'flex items-center justify-between rounded-md border px-2.5 py-1.5 text-xs',
                      points > 0 ? 'border-border bg-muted/30' : 'border-border/50 text-muted-foreground'
                    )}
                  >
                    <span>{SIGNAL_LABEL[signal] ?? signal}</span>
                    <span className={cn('tabular-nums font-semibold', points > 0 ? 'text-foreground' : 'text-muted-foreground')}>
                      +{points}
                    </span>
                  </div>
                ))}
              </div>
              <p className="field-hint">
                {data.score.counts.whatsappSent} WhatsApp + {data.score.counts.emailSent} email send(s) ·{' '}
                {data.score.counts.opened} opened · {data.score.counts.ctaClicks} CTA tap(s)
                {data.score.calculatedAt ? ` · calculated ${when(data.score.calculatedAt)}` : ''}
              </p>
            </section>

            <Separator />

            {/* --- stage timeline: the customer lifecycle, one card per transition -------- */}
            <section className="space-y-2">
              <h4 className="panel-title">Stage history</h4>
              {data.stageHistory.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No stage changes detected yet. A change is recorded only when a sync sees a different
                  CRM status from the one stored — so this fills in as leads move.
                </p>
              ) : (
                <ol className="space-y-2">
                  {data.stageHistory.map((h) => {
                    const focused = h.id === focusTransitionId
                    return (
                      <li
                        key={h.id}
                        className={cn(
                          'rounded-md border px-3 py-2.5 text-xs',
                          focused ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-border bg-muted/20'
                        )}
                      >
                        {/* 1. which lead, from where to where, how long it took */}
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-medium">{h.fromStatus || '(first seen)'}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="font-semibold">{h.toStatus}</span>
                          {h.confidence ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                'h-5 px-1.5 text-[10px] font-normal',
                                h.confidence.band === 'strong' && 'border-success/40 bg-success/10 text-success',
                                h.confidence.band === 'moderate' && 'border-info/40 bg-info/10 text-info',
                                h.confidence.band === 'weak' && 'border-warning/40 bg-warning/10 text-warning'
                              )}
                            >
                              {CONFIDENCE_LABEL[h.confidence.band]} · {h.confidence.score}%
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                              no attribution
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-muted-foreground">
                          <span>{when(h.detectedAt)}</span>
                          {h.timeInPrevStageHours !== null ? (
                            <>
                              <span>·</span>
                              <span>spent {hours(h.timeInPrevStageHours)} in the previous stage</span>
                            </>
                          ) : null}
                        </div>

                        {/* 2. what we were told, and when */}
                        {h.nudgesBefore.length === 0 ? (
                          <p className="mt-1.5 inline-flex items-center gap-1 text-muted-foreground">
                            <AlertTriangle className="h-3 w-3" />
                            no nudge was sent within {data.attributionWindowHours}h of this change — nothing we did
                            preceded it, so it is un-attributed
                          </p>
                        ) : (
                          <div className="mt-2 space-y-1">
                            <p className="text-muted-foreground">
                              {h.nudgesBefore.length} nudge{h.nudgesBefore.length === 1 ? '' : 's'} in the{' '}
                              {data.attributionWindowHours}h window before this change:
                            </p>
                            {h.nudgesBefore.map((n) => {
                              const credited = n.id === h.attributedLogId
                              return (
                                <div
                                  key={n.id}
                                  className={cn(
                                    'flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded px-2 py-1',
                                    credited ? 'bg-primary/10 ring-1 ring-primary/25' : 'bg-background/60'
                                  )}
                                >
                                  {n.channel === 'whatsapp' ? (
                                    <MessageCircle className="h-3.5 w-3.5 shrink-0 text-success" />
                                  ) : (
                                    <Mail className="h-3.5 w-3.5 shrink-0 text-primary" />
                                  )}
                                  <span className={cn('font-medium', credited && 'text-primary')}>
                                    {n.nudgeKey ?? '—'}
                                  </span>
                                  <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                                    #{n.messageNumber}
                                  </Badge>
                                  <span className="text-muted-foreground">
                                    sent {hours(n.hoursBeforeChange)} before the change
                                  </span>
                                  {credited ? (
                                    <Badge className="h-4 bg-primary px-1 text-[10px] text-primary-foreground hover:bg-primary">
                                      credited
                                    </Badge>
                                  ) : null}
                                  {n.opened ? (
                                    <span className="inline-flex items-center gap-0.5 text-info">
                                      <Eye className="h-3 w-3" />opened
                                    </span>
                                  ) : null}
                                  {n.replied ? (
                                    <span className="inline-flex items-center gap-0.5 text-success">
                                      <Reply className="h-3 w-3" />replied
                                    </span>
                                  ) : null}
                                  {n.ctaClicks > 0 ? (
                                    <span className="inline-flex items-center gap-0.5 text-info">
                                      <MousePointerClick className="h-3 w-3" />CTA ×{n.ctaClicks}
                                    </span>
                                  ) : null}
                                </div>
                              )
                            })}
                            <p className="text-muted-foreground">
                              {when(h.nudgesBefore[h.nudgesBefore.length - 1]?.sentAt ?? null)} → {when(h.detectedAt)}
                            </p>
                          </div>
                        )}

                        {/* 3. how much of the credit that nudge can actually take */}
                        {h.confidence ? (
                          <div className="mt-2 rounded border border-border bg-background/60 px-2 py-1.5">
                            <p className="mb-1 font-medium">
                              Can this nudge be credited? {CONFIDENCE_LABEL[h.confidence.band]} ·{' '}
                              {h.confidence.score}%
                            </p>
                            <div className="grid gap-1 sm:grid-cols-3">
                              {h.confidence.factors.map((f) => (
                                <div key={f.label} className="rounded bg-muted/40 px-1.5 py-1">
                                  <p className="flex items-center justify-between gap-1">
                                    <span className="font-medium">{f.label}</span>
                                    <span className="tabular-nums">
                                      {f.points}/{f.max}
                                    </span>
                                  </p>
                                  <p className="text-[10px] text-muted-foreground">{f.detail}</p>
                                  <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                                    <div
                                      className={cn(
                                        'h-full rounded-full',
                                        h.confidence!.band === 'strong'
                                          ? 'bg-success'
                                          : h.confidence!.band === 'moderate'
                                            ? 'bg-info'
                                            : 'bg-warning'
                                      )}
                                      style={{ width: `${Math.round((f.points / f.max) * 100)}%` }}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                            <p className="mt-1 text-[10px] text-muted-foreground">
                              A heuristic, not proof: it weighs how soon after the send the change happened, whether
                              the lead engaged with that nudge, and how many other nudges were competing to explain it.
                            </p>
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
                </ol>
              )}
            </section>

            <Separator />

            {/* --- send history ----------------------------------------------------- */}
            <section className="space-y-2">
              <h4 className="panel-title">
                Nudge history{data.lastNudge ? ` · last: ${data.lastNudge.nudgeKey ?? '—'}` : ''}
              </h4>
              {data.nudgeHistory.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing has been sent to this lead.</p>
              ) : (
                <div className="space-y-1">
                  {data.nudgeHistory.map((n) => (
                    <div key={n.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
                      {n.channel === 'whatsapp' ? (
                        <MessageCircle className="h-3.5 w-3.5 shrink-0 text-success" />
                      ) : (
                        <Mail className="h-3.5 w-3.5 shrink-0 text-primary" />
                      )}
                      <span className="font-medium">{n.nudgeKey ?? '—'}</span>
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">#{n.messageNumber}</Badge>
                      <span className="text-muted-foreground">{when(n.sentAt)}</span>
                      {!n.sentOk ? (
                        <Badge variant="destructive" className="h-5 px-1.5 text-[10px] font-normal">failed</Badge>
                      ) : null}
                      {n.opened ? (
                        <span className="inline-flex items-center gap-1 text-info"><Eye className="h-3 w-3" />opened</span>
                      ) : null}
                      {n.replied ? (
                        <span className="inline-flex items-center gap-1 text-success"><Reply className="h-3 w-3" />replied</span>
                      ) : null}
                      {n.ctaClicks > 0 ? (
                        <span className="inline-flex items-center gap-1 text-info">
                          <MousePointerClick className="h-3 w-3" />CTA ×{n.ctaClicks}
                        </span>
                      ) : null}
                      {n.templateName ? <span className="mono text-[10px] text-muted-foreground">{n.templateName}</span> : null}
                      {n.reply ? (
                        <span className="w-full truncate text-muted-foreground">&ldquo;{n.reply}&rdquo;</span>
                      ) : null}
                      {n.error ? <span className="w-full text-destructive">{n.error}</span> : null}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <p className="field-hint">
              Attribution is the last nudge sent before a change, within {data.attributionWindowHours} hours — it is
              probabilistic, <b>not proof</b> that the nudge caused the change. The score is a reporting signal and
              never decides who gets nudged.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export { SCORE_BAND_LABEL }

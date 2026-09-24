'use client'

import { useCallback, useEffect, useState } from 'react'
import { Users, Send, MailOpen, Reply, TrendingUp, RefreshCw, Mail, MessageCircle, Clock, TriangleAlert } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import type { SchedulerStatusDto, StatsDto } from '@/lib/app-types'
import { OnboardingMetrics } from '@/components/app/onboarding-metrics'

/**
 * One headline number.
 *
 * The accent is passed in rather than guessed from the label, so the colour actually means
 * something: brand for volume, success for things that worked, warning for attention.
 */
function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent = 'primary',
}: {
  icon: React.ElementType
  label: string
  value: string | number
  sub?: string
  accent?: 'primary' | 'success' | 'warning' | 'info' | 'destructive'
}) {
  const chip = {
    primary: 'bg-primary/10 text-primary',
    success: 'bg-success/12 text-success',
    warning: 'bg-warning/15 text-warning',
    info: 'bg-info/12 text-info',
    destructive: 'bg-destructive/12 text-destructive',
  }[accent]

  return (
    <Card className="panel-hover overflow-hidden">
      <CardContent className="flex items-start gap-3 p-4">
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${chip}`}>
          <Icon className="h-[18px] w-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
          <p className="stat-value mt-1">{value}</p>
          {sub ? <p className="mt-1 truncate text-xs text-muted-foreground">{sub}</p> : null}
        </div>
      </CardContent>
    </Card>
  )
}

function statusBadge(s: string, sentOk: boolean, opens: number) {
  if (!sentOk) return <Badge variant="destructive">failed</Badge>
  if (s === 'replied') return <Badge className="bg-success text-success-foreground hover:bg-success">replied</Badge>
  if (s === 'opened') return <Badge className="bg-warning text-warning-foreground hover:bg-warning">opened ×{opens}</Badge>
  return <Badge variant="secondary">sent</Badge>
}

export function DashboardTab({ refreshKey }: { refreshKey: number }) {
  const [stats, setStats] = useState<StatsDto | null>(null)
  const [scheduler, setScheduler] = useState<SchedulerStatusDto | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const [statsRes, schedRes] = await Promise.all([fetch('/api/stats'), fetch('/api/scheduler')])
      const data = (await statsRes.json()) as StatsDto
      setStats(data)
      if (schedRes.ok) setScheduler((await schedRes.json()) as SchedulerStatusDto)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  useEffect(() => {
    const t = setInterval(load, 20000) // open-tracking / webhook events arrive externally
    return () => clearInterval(t)
  }, [load])

  if (loading && !stats) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (!stats) return null

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard icon={Users} label="Leads synced" value={stats.leads} sub="EPS, from Zoho CRM" accent="primary" />
        <StatCard
          icon={Send}
          label="Messages sent"
          value={stats.messagesSent}
          sub={stats.messagesFailed ? `${stats.messagesFailed} failed` : 'email + WhatsApp'}
          accent={stats.messagesFailed ? 'warning' : 'info'}
        />
        <StatCard icon={MailOpen} label="Opened" value={stats.opened} sub={`open rate ${stats.openRate}%`} accent="info" />
        <StatCard icon={Reply} label="Replied" value={stats.replied} sub="replies detected" accent="success" />
        <StatCard icon={TrendingUp} label="Nudges" value={stats.nudges} sub="configured flows" accent="primary" />
      </div>

      {/* Per-nudge engagement for the two activation-fee families. */}
      <OnboardingMetrics refreshKey={refreshKey} />

      <Card>
        <CardContent className="p-4 sm:p-6 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" /> Scheduler
            </h3>
            {scheduler?.enabled ? (
              <Badge className="bg-success text-success-foreground hover:bg-success">
                {scheduler.running ? 'cycle running…' : `every ${scheduler.intervalMinutes} min`}
              </Badge>
            ) : (
              <Badge variant="secondary">disabled</Badge>
            )}
          </div>
          {scheduler?.enabled ? (
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <span>{scheduler.runsCompleted} cycle(s) completed</span>
              <span>
                last cycle: {scheduler.lastCycleAt ? new Date(scheduler.lastCycleAt).toLocaleString() : 'not yet'}
                {scheduler.lastCycleTrigger ? ` (${scheduler.lastCycleTrigger})` : ''}
              </span>
              <span>
                email replies via IMAP:{' '}
                {scheduler.imapConfigured ? (
                  scheduler.lastReplySync?.error ? (
                    <span className="text-destructive">error — {scheduler.lastReplySync.error}</span>
                  ) : (
                    `${scheduler.lastReplySync?.matched ?? 0} matched of ${scheduler.lastReplySync?.scanned ?? 0} scanned`
                  )
                ) : (
                  'not configured (IMAP_ENABLED=false)'
                )}
              </span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Automatic runs are off. Set <code className="font-mono">SCHEDULER_ENABLED=true</code> in .env, or call{' '}
              <code className="font-mono">POST /api/cron/run</code> from an external cron with the CRON_SECRET header.
            </p>
          )}
          {scheduler?.lastResults?.some((r) => r.error) ? (
            <div className="space-y-1">
              {scheduler.lastResults
                .filter((r) => r.error)
                .map((r) => (
                  <p key={r.nudgeKey} className="flex items-start gap-1.5 text-xs text-destructive">
                    <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    {r.nudgeKey}: {r.error}
                  </p>
                ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-muted-foreground" /> Recent message activity
            </h3>
            <span className="text-xs text-muted-foreground">auto-refreshes every 20s</span>
          </div>
          {stats.recentLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No messages sent yet. Go to <b>Nudges</b> and run one, or <b>Sync leads</b> first.
            </p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <div className="space-y-1">
                {stats.recentLogs.map((l) => (
                  <div key={l.id} className="flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted/60">
                    {l.channel === 'whatsapp' ? (
                      <MessageCircle className="h-4 w-4 shrink-0 text-success" />
                    ) : (
                      <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {l.lead} <span className="text-muted-foreground font-normal">· #{l.messageNumber} · {l.nudge}</span>
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{l.subject || (l.channel === 'whatsapp' ? 'WhatsApp template' : '')}</p>
                    </div>
                    <span className="hidden sm:block text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(l.sentAt || l.createdAt).toLocaleString()}
                    </span>
                    {statusBadge(l.engagementStatus, l.sentOk, l.opensCount)}
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

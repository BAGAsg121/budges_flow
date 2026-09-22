'use client'

import { useCallback, useEffect, useState } from 'react'
import { Users, Send, MailOpen, Reply, TrendingUp, RefreshCw } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import type { StatsDto } from '@/lib/app-types'

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType
  label: string
  value: string | number
  sub?: string
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-start gap-3">
        <div className="rounded-md bg-muted p-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-2xl font-semibold leading-tight">{value}</p>
          {sub ? <p className="text-xs text-muted-foreground truncate">{sub}</p> : null}
        </div>
      </CardContent>
    </Card>
  )
}

function statusBadge(s: string, sentOk: boolean, opens: number) {
  if (!sentOk) return <Badge variant="destructive">failed</Badge>
  if (s === 'replied') return <Badge className="bg-emerald-600 hover:bg-emerald-600">replied</Badge>
  if (s === 'opened') return <Badge className="bg-amber-500 hover:bg-amber-500">opened ×{opens}</Badge>
  return <Badge variant="secondary">sent</Badge>
}

export function DashboardTab({ refreshKey }: { refreshKey: number }) {
  const [stats, setStats] = useState<StatsDto | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/stats')
      const data = (await res.json()) as StatsDto
      setStats(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  useEffect(() => {
    const t = setInterval(load, 20000) // open-tracking events arrive externally
    return () => clearInterval(t)
  }, [load])

  if (loading && !stats) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    )
  }

  if (!stats) return null

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard icon={Users} label="Leads (synced)" value={stats.leads} sub="from Zoho CRM" />
        <StatCard icon={Send} label="Emails sent" value={stats.emailsSent} sub={stats.emailsFailed ? `${stats.emailsFailed} failed` : 'all delivered'} />
        <StatCard icon={MailOpen} label="Opened" value={stats.opened} sub={`open rate ${stats.openRate}%`} />
        <StatCard icon={Reply} label="Replied" value={stats.replied} sub="replies detected" />
        <StatCard icon={TrendingUp} label="Nudges" value={stats.nudges} sub="configured flows" />
      </div>

      <Card>
        <CardContent className="p-4 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-muted-foreground" /> Recent email activity
            </h3>
            <span className="text-xs text-muted-foreground">auto-refreshes every 20s</span>
          </div>
          {stats.recentLogs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No emails sent yet. Go to <b>Nudges</b> and run one, or <b>Sync leads</b> first.
            </p>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              <div className="space-y-1">
                {stats.recentLogs.map((l) => (
                  <div key={l.id} className="flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted/60">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {l.lead} <span className="text-muted-foreground font-normal">· email #{l.emailNumber} · {l.nudge}</span>
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{l.subject}</p>
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

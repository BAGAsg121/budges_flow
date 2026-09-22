'use client'

import { useCallback, useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { LogDto, NudgeDto } from '@/lib/app-types'

function StatusBadge({ log }: { log: LogDto }) {
  if (!log.sentOk) {
    return (
      <TooltipProvider delayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="destructive">failed</Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-72 text-xs">
            {log.sendError || 'Unknown error'}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  if (log.engagementStatus === 'replied') return <Badge className="bg-emerald-600 hover:bg-emerald-600">replied</Badge>
  if (log.engagementStatus === 'opened') return <Badge className="bg-amber-500 hover:bg-amber-500">opened ×{log.opensCount}</Badge>
  return <Badge variant="secondary">sent</Badge>
}

export function LogsTab({ refreshKey }: { refreshKey: number }) {
  const [logs, setLogs] = useState<LogDto[]>([])
  const [nudges, setNudges] = useState<NudgeDto[]>([])
  const [nudgeId, setNudgeId] = useState('all')
  const [status, setStatus] = useState('all')
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (nudgeId !== 'all') params.set('nudgeId', nudgeId)
      if (status !== 'all') params.set('status', status)
      if (q) params.set('q', q)
      const res = await fetch(`/api/logs?${params.toString()}`)
      const data = (await res.json()) as { logs: LogDto[] }
      setLogs(data.logs || [])
    } finally {
      setLoading(false)
    }
  }, [nudgeId, status, q])

  useEffect(() => {
    fetch('/api/nudges')
      .then((r) => r.json())
      .then((d: { nudges: NudgeDto[] }) => setNudges(d.nudges || []))
  }, [])

  useEffect(() => {
    const t = setTimeout(load, q ? 350 : 0)
    return () => clearTimeout(t)
  }, [load, refreshKey, q])

  useEffect(() => {
    const t = setInterval(load, 20000) // pick up open-tracking events
    return () => clearInterval(t)
  }, [load])

  return (
    <Card>
      <CardContent className="p-4 sm:p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">Email logs</h3>
            <p className="text-xs text-muted-foreground">Every send attempt + open tracking (replaces the Google Sheet log)</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <Select value={nudgeId} onValueChange={setNudgeId}>
              <SelectTrigger className="w-full sm:w-52">
                <SelectValue placeholder="Nudge" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All nudges</SelectItem>
                {nudges.map((n) => (
                  <SelectItem key={n.id} value={n.id}>{n.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="opened">Opened</SelectItem>
                <SelectItem value="replied">Replied</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative w-full sm:w-56">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search lead / subject" className="pl-8" />
            </div>
          </div>
        </div>

        <div className="max-h-[30rem] overflow-y-auto rounded-md border">
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead>Sent</TableHead>
                <TableHead>Lead</TableHead>
                <TableHead className="hidden md:table-cell">Nudge</TableHead>
                <TableHead>#</TableHead>
                <TableHead className="hidden lg:table-cell">Subject</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden xl:table-cell">Opens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && logs.length === 0 ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7} className="text-muted-foreground text-xs">loading…</TableCell>
                  </TableRow>
                ))
              ) : logs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-10">
                    No email logs yet.
                  </TableCell>
                </TableRow>
              ) : (
                logs.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {l.sentAt ? new Date(l.sentAt).toLocaleString() : '—'}
                    </TableCell>
                    <TableCell>
                      <p className="font-medium truncate max-w-36">{l.lead}</p>
                      <p className="text-xs text-muted-foreground truncate max-w-36">{l.toEmail}</p>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs">{l.nudge}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{l.emailNumber}</TableCell>
                    <TableCell className="hidden lg:table-cell max-w-56 truncate text-xs">{l.subject}</TableCell>
                    <TableCell><StatusBadge log={l} /></TableCell>
                    <TableCell className="hidden xl:table-cell text-xs text-muted-foreground">{l.opensCount}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Mail, MessageCircle, Sheet } from 'lucide-react'
import type { LogDto, NudgeDto } from '@/lib/app-types'

function ChannelBadge({ channel }: { channel: string }) {
  if (channel === 'whatsapp') {
    return (
      <TooltipProvider delayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge className="bg-emerald-600 hover:bg-emerald-600 p-1"><MessageCircle className="h-3 w-3" /></Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">WhatsApp</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="secondary" className="p-1"><Mail className="h-3 w-3" /></Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">Email</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

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
  const [channel, setChannel] = useState('all')
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (nudgeId !== 'all') params.set('nudgeId', nudgeId)
      if (status !== 'all') params.set('status', status)
      if (channel !== 'all') params.set('channel', channel)
      if (q) params.set('q', q)
      const res = await fetch(`/api/logs?${params.toString()}`)
      const data = (await res.json()) as { logs: LogDto[] }
      setLogs(data.logs || [])
    } finally {
      setLoading(false)
    }
  }, [nudgeId, status, channel, q])

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
    const t = setInterval(load, 20000) // pick up open-tracking / webhook events
    return () => clearInterval(t)
  }, [load])

  return (
    <Card>
      <CardContent className="p-4 sm:p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">Message logs</h3>
            <p className="text-xs text-muted-foreground">Every send attempt (email + WhatsApp) with open/reply tracking</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <Select value={channel} onValueChange={setChannel}>
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue placeholder="Channel" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All channels</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
              </SelectContent>
            </Select>
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
            <div className="relative w-full sm:w-52">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search lead / phone / subject" className="pl-8" />
            </div>
          </div>
        </div>

        <div className="max-h-[30rem] overflow-y-auto rounded-md border">
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead>Sent</TableHead>
                <TableHead>Lead</TableHead>
                <TableHead>Ch.</TableHead>
                <TableHead className="hidden md:table-cell">Nudge</TableHead>
                <TableHead>#</TableHead>
                <TableHead className="hidden lg:table-cell">Subject / template</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden xl:table-cell">Opens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && logs.length === 0 ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={8} className="text-muted-foreground text-xs">loading…</TableCell>
                  </TableRow>
                ))
              ) : logs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-10">
                    No message logs yet.
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
                      <p className="text-xs text-muted-foreground truncate max-w-36">{l.toPhone || l.toEmail}</p>
                      {l.sheetRowRef && (
                        <Badge variant="outline" className="mt-0.5 gap-1 text-[10px] h-4 px-1 text-emerald-700 border-emerald-300">
                          <Sheet className="h-2.5 w-2.5" /> Sheet
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell><ChannelBadge channel={l.channel} /></TableCell>
                    <TableCell className="hidden md:table-cell text-xs">{l.nudge}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{l.messageNumber}</TableCell>
                    <TableCell className="hidden lg:table-cell max-w-56 truncate text-xs">
                      {l.subject || l.templateName || '—'}
                    </TableCell>
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

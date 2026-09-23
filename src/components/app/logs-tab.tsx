'use client'

import { useCallback, useEffect, useState } from 'react'
import { Search, MessageSquareQuote, Info } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Mail, MessageCircle, Sheet } from 'lucide-react'
import { explainWhatsAppError } from '@/lib/whatsapp-errors'
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
    // Meta's delivery errors are cryptic; explain them alongside the raw text.
    const help = explainWhatsAppError(log.sendError)
    return (
      <TooltipProvider delayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="destructive">{help ? `failed · ${help.label}` : 'failed'}</Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-80 text-xs space-y-1">
            <p className="font-medium">{help ? help.label : 'Failed'}</p>
            {help && <p>{help.detail}</p>}
            <p className="opacity-70">Meta said: {log.sendError || 'Unknown error'}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }
  if (log.engagementStatus === 'replied') return <Badge className="bg-emerald-600 hover:bg-emerald-600">replied</Badge>
  if (log.engagementStatus === 'opened') return <Badge className="bg-amber-500 hover:bg-amber-500">opened ×{log.opensCount}</Badge>
  return <Badge variant="secondary">sent</Badge>
}

/** Parse the stored inbound history, tolerating a missing/invalid blob. */
function parseInbound(raw: string | null): { at: string; type?: string; text: string }[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function LogsTab({ refreshKey }: { refreshKey: number }) {
  const [logs, setLogs] = useState<LogDto[]>([])
  const [nudges, setNudges] = useState<NudgeDto[]>([])
  const [nudgeId, setNudgeId] = useState('all')
  const [status, setStatus] = useState('all')
  const [channel, setChannel] = useState('all')
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [replyLog, setReplyLog] = useState<LogDto | null>(null)

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
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <StatusBadge log={l} />
                        {l.replied && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-1"
                            title="View what the customer replied"
                            onClick={() => setReplyLog(l)}
                          >
                            <MessageSquareQuote className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-xs text-muted-foreground">{l.opensCount}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      {/* What the customer actually wrote back. */}
      <Dialog open={!!replyLog} onOpenChange={(o) => !o && setReplyLog(null)}>
        <DialogContent className="max-w-xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Customer reply</DialogTitle>
            <DialogDescription>
              {replyLog?.lead} · {replyLog?.toPhone} · {replyLog?.nudge}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {(() => {
              const history = parseInbound(replyLog?.inboundMessages ?? null)
              if (history.length === 0) {
                return (
                  <p className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                    <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>
                      This reply was recorded before reply text was stored, so only the fact that they replied is known.
                      New replies will show their message here.
                    </span>
                  </p>
                )
              }
              return history
                .slice()
                .reverse()
                .map((m, i) => (
                  <div key={i} className="rounded-md border bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">
                      {new Date(m.at).toLocaleString()}
                      {m.type ? ` · ${m.type}` : ''}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{m.text}</p>
                  </div>
                ))
            })()}
            {replyLog?.repliedAt && (
              <p className="text-xs text-muted-foreground">
                First reply recorded {new Date(replyLog.repliedAt).toLocaleString()}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

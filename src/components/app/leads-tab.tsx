'use client'

/**
 * Leads tab, with the V2 engagement score.
 *
 * The Score column is sortable and the row opens the journey drawer. Sorting is done by the API
 * (`?sort=score`) rather than in the browser, because the table is capped at 500 rows — sorting what
 * happens to be loaded would look like "most engaged" while actually being "most engaged among the
 * first 500 by date".
 */
import { useCallback, useEffect, useState } from 'react'
import { Search, ArrowDownWideNarrow } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ScoreBadge } from '@/components/app/score-badge'
import { LeadJourneyDrawer } from '@/components/app/lead-journey-drawer'
import type { LeadDto } from '@/lib/app-types'
import { cn } from '@/lib/utils'

type SortKey = '' | 'score' | 'score-asc'

export function LeadsTab({ refreshKey }: { refreshKey: number }) {
  const [leads, setLeads] = useState<LeadDto[]>([])
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('')
  const [loading, setLoading] = useState(true)
  const [openLeadId, setOpenLeadId] = useState<string | null>(null)

  const load = useCallback(async (query: string, sortKey: SortKey) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ q: query })
      if (sortKey) params.set('sort', sortKey)
      const res = await fetch(`/api/leads?${params.toString()}`)
      const data = (await res.json()) as { leads: LeadDto[] }
      setLeads(data.leads || [])
    } finally {
      setLoading(false)
    }
  }, [])

  // One debounced loader for search, sort and refresh — a single timer is easier to reason about
  // than two effects racing to set the same list.
  useEffect(() => {
    const t = setTimeout(() => load(q, sort), 350)
    return () => clearTimeout(t)
  }, [q, sort, refreshKey, load])

  return (
    <Card>
      <CardContent className="p-4 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">Leads</h3>
            <p className="text-xs text-muted-foreground">
              {leads.length} leads synced from Zoho CRM · click a row for its full journey
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={sort ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSort(sort === 'score' ? 'score-asc' : sort === 'score-asc' ? '' : 'score')}
              title="Sort by engagement score (click to flip, again to clear)"
            >
              <ArrowDownWideNarrow className={cn('h-4 w-4 mr-1 transition-transform', sort === 'score-asc' && 'rotate-180')} />
              {sort ? 'By score' : 'Sort by score'}
            </Button>
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, company, phone" className="pl-8" />
            </div>
          </div>
        </div>

        <div className="max-h-[28rem] overflow-y-auto rounded-md border">
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Score</TableHead>
                <TableHead className="hidden md:table-cell">Email</TableHead>
                <TableHead className="hidden md:table-cell">Company</TableHead>
                <TableHead className="hidden lg:table-cell">Status</TableHead>
                <TableHead>KYC docs</TableHead>
                <TableHead className="hidden lg:table-cell">Messages</TableHead>
                <TableHead className="hidden xl:table-cell">First nudge</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && leads.length === 0 ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={8}><Skeleton className="h-5 w-full" /></TableCell>
                  </TableRow>
                ))
              ) : leads.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-10">
                    No leads yet — click <b>Sync Zoho Leads</b> in the header.
                  </TableCell>
                </TableRow>
              ) : (
                leads.map((l) => (
                  <TableRow
                    key={l.id}
                    className="cursor-pointer"
                    onClick={() => setOpenLeadId(l.id)}
                    title="Open the journey for this lead"
                  >
                    <TableCell className="font-medium">{l.fullName || '—'}</TableCell>
                    <TableCell>
                      <ScoreBadge score={l.engagementScore ?? 0} band={l.scoreBand ?? 'cold'} />
                    </TableCell>
                    <TableCell className="hidden md:table-cell max-w-48 truncate">{l.email || '—'}</TableCell>
                    <TableCell className="hidden md:table-cell max-w-40 truncate">{l.company || '—'}</TableCell>
                    <TableCell className="hidden lg:table-cell max-w-32 truncate">{l.leadStatus || '—'}</TableCell>
                    <TableCell>{l.kycDocumentUploadCount ?? '—'}</TableCell>
                    <TableCell className="hidden lg:table-cell">{l.messagesSent}</TableCell>
                    <TableCell className="hidden xl:table-cell text-xs text-muted-foreground">
                      {l.firstNudgeSentAt
                        ? new Date(l.firstNudgeSentAt).toLocaleDateString()
                        : <Badge variant="outline" className="text-[10px] font-normal">not nudged</Badge>}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <p className="field-hint">
          The score is a reporting signal built from opens, replies, CTA taps and CRM stage changes. It does not
          affect who gets nudged.
        </p>
      </CardContent>

      <LeadJourneyDrawer leadId={openLeadId} onClose={() => setOpenLeadId(null)} />
    </Card>
  )
}

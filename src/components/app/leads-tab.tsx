'use client'

import { useCallback, useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { LeadDto } from '@/lib/app-types'

export function LeadsTab({ refreshKey }: { refreshKey: number }) {
  const [leads, setLeads] = useState<LeadDto[]>([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (query: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/leads?q=${encodeURIComponent(query)}`)
      const data = (await res.json()) as { leads: LeadDto[] }
      setLeads(data.leads || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load('')
  }, [load, refreshKey])

  useEffect(() => {
    const t = setTimeout(() => load(q), 350)
    return () => clearTimeout(t)
  }, [q, load])

  return (
    <Card>
      <CardContent className="p-4 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">Leads</h3>
            <p className="text-xs text-muted-foreground">{leads.length} leads synced from Zoho CRM (search filters locally)</p>
          </div>
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, company, phone" className="pl-8" />
          </div>
        </div>

        <div className="max-h-[28rem] overflow-y-auto rounded-md border">
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Email</TableHead>
                <TableHead className="hidden md:table-cell">Phone</TableHead>
                <TableHead className="hidden md:table-cell">Company</TableHead>
                <TableHead className="hidden lg:table-cell">Status</TableHead>
                <TableHead>KYC docs</TableHead>
                <TableHead className="hidden lg:table-cell">Messages</TableHead>
                <TableHead className="hidden xl:table-cell">Created</TableHead>
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
                  <TableRow key={l.id}>
                    <TableCell className="font-medium">{l.fullName || '—'}</TableCell>
                    <TableCell className="max-w-48 truncate">{l.email || '—'}</TableCell>
                    <TableCell className="hidden md:table-cell">{l.phone || '—'}</TableCell>
                    <TableCell className="hidden md:table-cell max-w-40 truncate">{l.company || '—'}</TableCell>
                    <TableCell className="hidden lg:table-cell max-w-32 truncate">{l.leadStatus || '—'}</TableCell>
                    <TableCell>{l.kycDocumentUploadCount ?? '—'}</TableCell>
                    <TableCell className="hidden lg:table-cell">{l.messagesSent}</TableCell>
                    <TableCell className="hidden xl:table-cell text-xs text-muted-foreground">
                      {l.createdTime ? new Date(l.createdTime).toLocaleDateString() : '—'}
                    </TableCell>
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

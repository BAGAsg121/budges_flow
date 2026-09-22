'use client'

import { useCallback, useEffect, useState } from 'react'
import { Mail, RefreshCw, Loader2, Database } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/hooks/use-toast'
import { DashboardTab } from '@/components/app/dashboard-tab'
import { LeadsTab } from '@/components/app/leads-tab'
import { NudgesTab } from '@/components/app/nudges-tab'
import { LogsTab } from '@/components/app/logs-tab'

export default function Home() {
  const { toast } = useToast()
  const [refreshKey, setRefreshKey] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [lastSync, setLastSync] = useState<string | null>(null)

  const syncZoho = useCallback(async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/zoho/sync', { method: 'POST' })
      const data = (await res.json()) as { ok: boolean; synced?: number; error?: string }
      if (!data.ok) {
        toast({ title: 'Zoho sync failed', description: data.error, variant: 'destructive' })
        return
      }
      setLastSync(new Date().toLocaleTimeString())
      toast({ title: 'Zoho sync complete', description: `${data.synced} leads synced from Zoho CRM` })
      setRefreshKey((k) => k + 1)
    } finally {
      setSyncing(false)
    }
  }, [toast])

  useEffect(() => {
    setLastSync(localStorage.getItem('lastZohoSync'))
  }, [])

  const handleSync = async () => {
    await syncZoho()
    localStorage.setItem('lastZohoSync', new Date().toLocaleTimeString())
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b bg-card">
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary p-2">
              <Mail className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Nudge Engine</h1>
              <p className="text-xs text-muted-foreground">Zoho CRM leads → email nudges → send logs &amp; open tracking</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {lastSync && (
              <span className="hidden md:inline text-xs text-muted-foreground">last sync {lastSync}</span>
            )}
            <Button onClick={handleSync} disabled={syncing} size="sm">
              {syncing ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1.5" />}
              {syncing ? 'Syncing…' : 'Sync Zoho Leads'}
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6">
        <Tabs defaultValue="dashboard" className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
            <TabsTrigger value="leads">Leads</TabsTrigger>
            <TabsTrigger value="nudges">Nudges</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
          </TabsList>
          <TabsContent value="dashboard"><DashboardTab refreshKey={refreshKey} /></TabsContent>
          <TabsContent value="leads"><LeadsTab refreshKey={refreshKey} /></TabsContent>
          <TabsContent value="nudges"><NudgesTab refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} /></TabsContent>
          <TabsContent value="logs"><LogsTab refreshKey={refreshKey} /></TabsContent>
        </Tabs>
      </main>

      <footer className="border-t mt-auto">
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><Database className="h-3.5 w-3.5" /> Logs stored in local database (Google Sheets replaced)</span>
          <span>Email pixel: /api/track/open/&lt;tracking_id&gt; · WhatsApp webhook: /api/track/whatsapp</span>
        </div>
      </footer>
    </div>
  )
}

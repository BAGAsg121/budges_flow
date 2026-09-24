'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, CalendarRange, Loader2, Menu, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { AppSidebar } from '@/components/app/app-sidebar'
import { ThemeToggle } from '@/components/app/theme-toggle'
import { TABS, tabById, type TabId } from '@/components/app/nav'
import { DashboardTab } from '@/components/app/dashboard-tab'
import { LeadsTab } from '@/components/app/leads-tab'
import { NudgesTab } from '@/components/app/nudges-tab'
import { TemplatesTab } from '@/components/app/templates-tab'
import { LogsTab } from '@/components/app/logs-tab'
import { FailuresTab } from '@/components/app/failures-tab'

/** Counts the sidebar badge needs; kept out of the tab components so they stay independent. */
interface NudgeSummary {
  total: number
  active: number
}

/** The shape /api/zoho/sync returns — `via` and `fellBack` exist so the data path is never a mystery. */
interface SyncResponse {
  ok: boolean
  synced?: number
  via?: 'mcp' | 'api'
  window?: string
  tool?: string | null
  fellBack?: string | null
  error?: string
}

export default function Home() {
  const { toast } = useToast()
  const [refreshKey, setRefreshKey] = useState(0)
  const [tab, setTab] = useState<TabId>('dashboard')
  const [navOpen, setNavOpen] = useState(false)
  // 'all' = every EPS lead since 1 Aug; 'today' = same filter, created since 01:00 IST today.
  const [syncing, setSyncing] = useState<null | 'all' | 'today'>(null)
  const [lastSync, setLastSync] = useState<{ at: string; window: string; count: number; via: string } | null>(null)
  const [nudgeSummary, setNudgeSummary] = useState<NudgeSummary | undefined>(undefined)
  // Set when the Templates tab asks to edit an email template: switch to Nudges and open it.
  const [nudgeToEdit, setNudgeToEdit] = useState<string | null>(null)

  const active = useMemo(() => tabById(tab), [tab])

  const openNudgeEditor = useCallback((nudgeId: string) => {
    setNudgeToEdit(nudgeId)
    setTab('nudges')
  }, [])

  const changeTab = useCallback((t: TabId) => {
    setTab(t)
    setNavOpen(false)
  }, [])

  const loadSummary = useCallback(async () => {
    try {
      const res = await fetch('/api/nudges')
      if (!res.ok) return
      const data = (await res.json()) as { nudges?: Array<{ enabled: boolean }> } | Array<{ enabled: boolean }>
      const list = Array.isArray(data) ? data : (data.nudges ?? [])
      setNudgeSummary({ total: list.length, active: list.filter((n) => n.enabled).length })
    } catch {
      // The badge is decoration; a failure here must not disturb the page.
    }
  }, [])

  useEffect(() => {
    loadSummary()
  }, [loadSummary, refreshKey])

  useEffect(() => {
    const stored = localStorage.getItem('nudgeLastSync')
    if (stored) {
      try {
        setLastSync(JSON.parse(stored) as typeof lastSync)
      } catch {
        // ignore malformed local state
      }
    }
  }, [])

  const runSync = useCallback(
    async (window: 'all' | 'today') => {
      setSyncing(window)
      try {
        const res = await fetch('/api/zoho/sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ window }),
        })
        const data = (await res.json()) as SyncResponse

        if (!data.ok) {
          toast({ title: 'Zoho sync failed', description: data.error, variant: 'destructive' })
          return
        }

        const via = data.via === 'mcp' ? `Zoho MCP${data.tool ? ` · ${data.tool}` : ''}` : 'Zoho REST API'
        toast({
          title: `${data.synced} lead${data.synced === 1 ? '' : 's'} synced`,
          description:
            `${window === 'today' ? 'Created since 01:00 today' : 'All EPS leads since 1 Aug'} · via ${via}` +
            // A silent fallback would hide a broken MCP setup, so say it out loud.
            (data.fellBack ? ` · MCP unavailable, fell back to the API: ${data.fellBack}` : ''),
        })

        const entry = {
          at: new Date().toLocaleTimeString(),
          window: window === 'today' ? 'today' : 'all',
          count: data.synced ?? 0,
          via: data.via ?? 'api',
        }
        setLastSync(entry)
        localStorage.setItem('nudgeLastSync', JSON.stringify(entry))
        setRefreshKey((k) => k + 1)
      } catch (err) {
        toast({
          title: 'Zoho sync failed',
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        })
      } finally {
        setSyncing(null)
      }
    },
    [toast]
  )

  const syncLabel = lastSync
    ? `last sync ${lastSync.at} · ${lastSync.count} ${lastSync.window === 'today' ? 'today' : 'leads'} · ${lastSync.via}`
    : 'not synced this session'

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar lg:block">
        <div className="sticky top-0 h-screen">
          <AppSidebar tab={tab} onTabChange={changeTab} nudgeCount={nudgeSummary} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
            {/* Mobile nav */}
            <Sheet open={navOpen} onOpenChange={setNavOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 p-0">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <AppSidebar tab={tab} onTabChange={changeTab} nudgeCount={nudgeSummary} />
              </SheetContent>
            </Sheet>

            <div className="min-w-0 flex-1">
              <h1 className="truncate text-base font-semibold leading-tight sm:text-lg">{active.label}</h1>
              <p className="hidden truncate text-xs text-muted-foreground sm:block">{active.description}</p>
            </div>

            <div className="flex items-center gap-2">
              <span className="mono hidden text-[11px] text-muted-foreground xl:inline">{syncLabel}</span>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => runSync('today')}
                    disabled={syncing !== null}
                    className="gap-1.5"
                  >
                    {syncing === 'today' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CalendarDays className="h-3.5 w-3.5" />
                    )}
                    <span className="hidden sm:inline">Sync today</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  Same EPS filter as the full sync, with the created time moved to <b>01:00 today</b> (IST) — so it
                  picks up only today&apos;s leads.
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    onClick={() => runSync('all')}
                    disabled={syncing !== null}
                    className="gap-1.5"
                  >
                    {syncing === 'all' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CalendarRange className="h-3.5 w-3.5" />
                    )}
                    <span className="hidden sm:inline">Sync all leads</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-xs">
                  Every EPS lead created since <b>1 Aug 2026</b>. Existing leads are updated, not duplicated.
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setRefreshKey((k) => k + 1)}
                    aria-label="Refresh this view"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Reload the current tab</TooltipContent>
              </Tooltip>

              <ThemeToggle />
            </div>
          </div>

          {/* Mobile tab strip — the sidebar is hidden below lg, so navigation needs a second home. */}
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => changeTab(t.id)}
                className={cn(
                  'shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                  tab === t.id
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:text-foreground'
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>
        </header>

        <main key={`${tab}-${refreshKey}`} className="animate-in-up flex-1 px-4 py-5 sm:px-6 sm:py-6">
          <div className="mx-auto w-full max-w-7xl">
            {tab === 'dashboard' ? <DashboardTab refreshKey={refreshKey} /> : null}
            {tab === 'leads' ? <LeadsTab refreshKey={refreshKey} /> : null}
            {tab === 'nudges' ? (
              <NudgesTab
                refreshKey={refreshKey}
                onChanged={() => setRefreshKey((k) => k + 1)}
                openNudgeId={nudgeToEdit}
                onOpenedNudge={() => setNudgeToEdit(null)}
              />
            ) : null}
            {tab === 'templates' ? <TemplatesTab refreshKey={refreshKey} onEditNudge={openNudgeEditor} /> : null}
            {tab === 'logs' ? <LogsTab refreshKey={refreshKey} /> : null}
            {tab === 'failures' ? (
              <FailuresTab refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />
            ) : null}
          </div>
        </main>

        <footer className="border-t border-border px-4 py-3 sm:px-6">
          <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>
              Open pixels: <code className="mono">/api/track/open/&lt;id&gt;</code> · WhatsApp webhook:{' '}
              <code className="mono">/api/track/whatsapp</code>
            </span>
            <span>Zoho CRM reads go through the MCP server when connected, otherwise the REST API.</span>
          </div>
        </footer>
      </div>
    </div>
  )
}

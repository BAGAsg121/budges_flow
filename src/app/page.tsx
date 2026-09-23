'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Mail, RefreshCw, Loader2, Database } from 'lucide-react'
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useSpring,
} from 'framer-motion'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { DashboardTab } from '@/components/app/dashboard-tab'
import { LeadsTab } from '@/components/app/leads-tab'
import { NudgesTab } from '@/components/app/nudges-tab'
import { TemplatesTab } from '@/components/app/templates-tab'
import { LogsTab } from '@/components/app/logs-tab'

const TABS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'leads', label: 'Leads' },
  { id: 'nudges', label: 'Nudges' },
  { id: 'templates', label: 'Templates' },
  { id: 'logs', label: 'Logs' },
] as const

type TabId = (typeof TABS)[number]['id']

// "3s ago" / "4m ago" and keeps ticking on its own — makes the header feel
// alive instead of a timestamp that goes stale the moment it's printed.
function useAgo(fromMs: number | null) {
  const [, force] = useState(0)
  useEffect(() => {
    if (fromMs == null) return
    const id = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [fromMs])
  if (fromMs == null) return null
  const diff = Math.max(0, Math.floor((Date.now() - fromMs) / 1000))
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

// A glow that follows the cursor across the header — real, user-driven
// motion, rather than an ambient loop that just runs forever regardless.
function CursorGlow() {
  const ref = useRef<HTMLDivElement>(null)
  const mx = useMotionValue(0)
  const my = useMotionValue(0)
  const sx = useSpring(mx, { stiffness: 120, damping: 20, mass: 0.4 })
  const sy = useSpring(my, { stiffness: 120, damping: 20, mass: 0.4 })

  useEffect(() => {
    const el = ref.current?.parentElement
    if (!el) return
    const onMove = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect()
      mx.set(e.clientX - rect.left)
      my.set(e.clientY - rect.top)
    }
    el.addEventListener('mousemove', onMove)
    return () => el.removeEventListener('mousemove', onMove)
  }, [mx, my])

  return (
    <motion.div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full"
      style={{
        left: sx,
        top: sy,
        background:
          'radial-gradient(circle, rgba(233,162,59,0.20) 0%, rgba(233,162,59,0) 70%)',
      }}
    />
  )
}

export default function Home() {
  const { toast } = useToast()
  const [refreshKey, setRefreshKey] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null)
  const [tab, setTab] = useState<TabId>('dashboard')
  const [nudgeToEdit, setNudgeToEdit] = useState<string | null>(null)
  const ago = useAgo(lastSyncAt)

  const openNudgeEditor = useCallback((nudgeId: string) => {
    setNudgeToEdit(nudgeId)
    setTab('nudges')
  }, [])

  const syncZoho = useCallback(async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/zoho/sync', { method: 'POST' })
      const data = (await res.json()) as { ok: boolean; synced?: number; error?: string }
      if (!data.ok) {
        toast({ title: 'Zoho sync failed', description: data.error, variant: 'destructive' })
        return
      }
      const now = Date.now()
      setLastSyncAt(now)
      localStorage.setItem('lastZohoSyncAt', String(now))
      toast({ title: 'Zoho sync complete', description: `${data.synced} leads synced from Zoho CRM` })
      setRefreshKey((k) => k + 1)
    } finally {
      setSyncing(false)
    }
  }, [toast])

  useEffect(() => {
    const raw = localStorage.getItem('lastZohoSyncAt')
    if (raw) setLastSyncAt(Number(raw))
  }, [])

  return (
    <div className="min-h-screen flex flex-col bg-[#0F1210] text-[#E8ECE9]">
      <header className="relative overflow-hidden border-b border-[#232823] bg-[#121613]">
        <CursorGlow />

        <div className="relative max-w-7xl mx-auto w-full px-4 sm:px-6 py-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <motion.div
            className="flex items-center gap-3"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          >
            <motion.div
              className="rounded-lg bg-[#E9A23B] p-2"
              whileHover={{ rotate: -8, scale: 1.05 }}
              transition={{ type: 'spring', stiffness: 300, damping: 15 }}
            >
              <Mail className="h-5 w-5 text-[#121613]" />
            </motion.div>
            <div>
              <h1 className="text-lg font-semibold leading-tight text-white">Nudge Engine</h1>
              <p className="text-xs text-[#8B948E]">
                Zoho CRM leads → email nudges → send logs &amp; open tracking
              </p>
            </div>
          </motion.div>

          <motion.div
            className="flex items-center gap-4"
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.4, ease: 'easeOut', delay: 0.05 }}
          >
            <AnimatePresence mode="wait">
              {ago && !syncing && (
                <motion.span
                  key={ago}
                  className="hidden md:flex items-center gap-1.5 text-xs text-[#8B948E]"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.2 }}
                >
                  <span className="relative flex h-1.5 w-1.5">
                    <motion.span
                      className="absolute inline-flex h-full w-full rounded-full bg-[#3FA796]"
                      animate={{ scale: [1, 2.2], opacity: [0.7, 0] }}
                      transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
                    />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#3FA796]" />
                  </span>
                  synced {ago}
                </motion.span>
              )}
            </AnimatePresence>

            <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.96 }}>
              <Button
                onClick={syncZoho}
                disabled={syncing}
                size="sm"
                className="bg-[#E9A23B] text-[#121613] hover:bg-[#f0af52] relative overflow-hidden"
              >
                <motion.span
                  animate={syncing ? { rotate: 360 } : { rotate: 0 }}
                  transition={syncing ? { duration: 0.8, repeat: Infinity, ease: 'linear' } : {}}
                  className="mr-1.5 inline-flex"
                >
                  {syncing ? <Loader2 className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
                </motion.span>
                {syncing ? 'Syncing…' : 'Sync Zoho Leads'}
              </Button>
            </motion.div>
          </motion.div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6">
        <nav className="relative mb-6 flex gap-1 border-b border-[#232823]">
          {TABS.map((t, i) => {
            const active = tab === t.id
            return (
              <motion.button
                key={t.id}
                onClick={() => setTab(t.id)}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: i * 0.04, ease: 'easeOut' }}
                whileHover={{ y: -1 }}
                className={`relative px-3.5 py-2.5 text-sm transition-colors ${active ? 'text-white' : 'text-[#8B948E] hover:text-[#C9CFC9]'
                  }`}
              >
                {t.label}
                {active && (
                  <motion.div
                    layoutId="tab-underline"
                    className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-[#E9A23B]"
                    transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                  />
                )}
              </motion.button>
            )
          })}
        </nav>

        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 8, scale: 0.997 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.997 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            {tab === 'dashboard' && <DashboardTab refreshKey={refreshKey} />}
            {tab === 'leads' && <LeadsTab refreshKey={refreshKey} />}
            {tab === 'nudges' && (
              <NudgesTab
                refreshKey={refreshKey}
                onChanged={() => setRefreshKey((k) => k + 1)}
                openNudgeId={nudgeToEdit}
                onOpenedNudge={() => setNudgeToEdit(null)}
              />
            )}
            {tab === 'templates' && (
              <TemplatesTab refreshKey={refreshKey} onEditNudge={openNudgeEditor} />
            )}
            {tab === 'logs' && <LogsTab refreshKey={refreshKey} />}
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="border-t border-[#232823] mt-auto bg-[#121613]">
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[#8B948E]">
          <span className="flex items-center gap-1.5">
            <Database className="h-3.5 w-3.5" /> Logs stored in local database (Google Sheets replaced)
          </span>
          <span>Email pixel: /api/track/open/&lt;tracking_id&gt; · WhatsApp webhook: /api/track/whatsapp</span>
        </div>
      </footer>
    </div>
  )
}
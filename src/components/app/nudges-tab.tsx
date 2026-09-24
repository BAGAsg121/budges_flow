'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Play, Pause, Eye, Pencil, Trash2, Plus, Send, RefreshCcw, Loader2, AlertCircle, Mail, MessageCircle, Info, Sheet, Database,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useToast } from '@/hooks/use-toast'
import type { NudgeChannel, NudgeDto, PreviewDto, RunSummaryDto } from '@/lib/app-types'

const TEMPLATE_VARS =
  '{{first_name}}, {{full_name}}, {{email}}, {{company}}, {{lead_status}}, {{kyc_document_upload_count}}, {{owner_name}}, {{city}}, {{message_number}}, {{today}}'

const emptyForm = {
  key: '',
  name: '',
  description: '',
  enabled: true,
  channel: 'email' as NudgeChannel,
  zohoCriteria: '',
  filters: '{\n  "requireEmail": true,\n  "excludeStatuses": ["Closed Won", "Closed Lost", "Unqualified"]\n}',
  subjectTemplate: '',
  bodyTemplate: '<p>Hi {{first_name}},</p>\n<p>...</p>\n<p>Thanks,<br/>Eko Team</p>',
  whatsappTemplateName: '',
  whatsappLanguage: 'en',
  whatsappParams: '["first_name", "company"]',
  maxEmailsPerLead: 1,
  followUpDays: 0,
}

type FormState = typeof emptyForm

function ChannelBadge({ channel }: { channel: NudgeChannel }) {
  if (channel === 'whatsapp') {
    return (
      <Badge className="bg-success text-success-foreground hover:bg-success gap-1">
        <MessageCircle className="h-3 w-3" /> WhatsApp
      </Badge>
    )
  }
  return (
    <Badge variant="secondary" className="gap-1">
      <Mail className="h-3 w-3" /> Email
    </Badge>
  )
}

/** A nudge is driven by one of three sources, encoded in its existing fields. */
function nudgeSourceOf(n: NudgeDto): 'zoho' | 'mysql' | 'sheet' {
  try {
    const f = JSON.parse(n.filters || '{}') as { source?: string }
    if (f.source === 'mysql') return 'mysql'
  } catch {
    // unparseable filters -> fall through
  }
  return n.zohoCriteria && n.zohoCriteria.trim() ? 'zoho' : 'sheet'
}

function reasonBadge(reason: string, detail?: string) {
  switch (reason) {
    case 'replied':
      return <Badge className="bg-success text-success-foreground hover:bg-success">replied</Badge>
    case 'max_reached':
      return <Badge variant="secondary">max reached{detail ? ` · ${detail}` : ''}</Badge>
    case 'waiting_followup':
      return <Badge className="bg-warning text-warning-foreground hover:bg-warning">waiting{detail ? ` · ${detail}` : ''}</Badge>
    case 'no_email':
      return <Badge variant="destructive">no email</Badge>
    case 'no_valid_phone':
      return <Badge variant="destructive">no valid phone</Badge>
    case 'batch_limit':
      return <Badge variant="outline">deferred{detail ? ` · ${detail}` : ''}</Badge>
    case 'duplicate_contact':
      return <Badge variant="outline">duplicate email{detail ? ` · ${detail}` : ''}</Badge>
    case 'delivery_cap_backoff':
      return <Badge className="bg-warning text-warning-foreground hover:bg-warning">capped by Meta{detail ? ` · ${detail}` : ''}</Badge>
    case 'email_fallback_missing':
      return <Badge variant="destructive">fallback nudge missing{detail ? ` · ${detail}` : ''}</Badge>
    case 'email_fallback':
      return <Badge variant="secondary">sent by email{detail ? ` · ${detail}` : ''}</Badge>
    default:
      return <Badge variant="outline">{reason}{detail ? ` · ${detail}` : ''}</Badge>
  }
}

export function NudgesTab({
  refreshKey,
  onChanged,
  openNudgeId,
  onOpenedNudge,
}: {
  refreshKey: number
  onChanged: () => void
  /** When set, open that nudge's editor (used by "Edit" on an email template). */
  openNudgeId?: string | null
  onOpenedNudge?: () => void
}) {
  const { toast } = useToast()
  const [nudges, setNudges] = useState<NudgeDto[]>([])
  const [loading, setLoading] = useState(true)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<NudgeDto | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [saving, setSaving] = useState(false)

  const [runTarget, setRunTarget] = useState<NudgeDto | null>(null)
  const [runWithSync, setRunWithSync] = useState(true)
  const [running, setRunning] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [runResult, setRunResult] = useState<RunSummaryDto | null>(null)
  const [preview, setPreview] = useState<PreviewDto | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // Sheet-run state
  const [sheetTarget, setSheetTarget] = useState<NudgeDto | null>(null)
  const [sheetUrl, setSheetUrl] = useState('')
  const [sheetRunning, setSheetRunning] = useState(false)
  const [sheetResult, setSheetResult] = useState<{
    sent: number; failed: number; skipped: number;
    failedEntries: { email: string; error: string }[];
    skippedEntries: { lead: string; email: string | null; reason: string; detail?: string }[];
  } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/nudges')
      const data = (await res.json()) as { nudges: NudgeDto[] }
      setNudges(data.nudges || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm)
    setFormOpen(true)
  }

  const openEdit = (n: NudgeDto) => {
    setEditing(n)
    setForm({
      key: n.key,
      name: n.name,
      description: n.description || '',
      enabled: n.enabled,
      channel: n.channel,
      zohoCriteria: n.zohoCriteria || '',
      filters: n.filters,
      subjectTemplate: n.subjectTemplate || '',
      bodyTemplate: n.bodyTemplate || '',
      whatsappTemplateName: n.whatsappTemplateName || '',
      whatsappLanguage: n.whatsappLanguage || 'en',
      whatsappParams: n.whatsappParams || '[]',
      maxEmailsPerLead: n.maxEmailsPerLead,
      followUpDays: n.followUpDays,
    })
    setFormOpen(true)
  }

  // A request from the Templates tab to edit this nudge (email templates live in the nudge).
  useEffect(() => {
    if (!openNudgeId || nudges.length === 0) return
    const target = nudges.find((n) => n.id === openNudgeId)
    if (target) openEdit(target)
    onOpenedNudge?.()
  }, [openNudgeId, nudges])

  const canSave =
    form.name.trim() &&
    form.key.trim() &&
    (form.channel === 'email' ? form.subjectTemplate.trim() && form.bodyTemplate.trim() : form.whatsappTemplateName.trim())

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch(editing ? `/api/nudges/${editing.id}` : '/api/nudges', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        toast({ title: 'Save failed', description: data.error, variant: 'destructive' })
        return
      }
      toast({ title: editing ? 'Nudge updated' : 'Nudge created', description: form.name })
      setFormOpen(false)
      load()
      onChanged()
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = async (n: NudgeDto, enabled: boolean) => {
    // Optimistic for responsiveness, then always reconciled with the server so the switch
    // can never end up showing a state the database does not have.
    setNudges((prev) => prev.map((x) => (x.id === n.id ? { ...x, enabled } : x)))
    try {
      const res = await fetch(`/api/nudges/${n.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) throw new Error(data.error || 'Update rejected')
      toast({
        title: enabled ? 'Nudge enabled' : 'Nudge paused',
        description: enabled ? `${n.name} will now send` : `${n.name} will not send until re-enabled`,
      })
    } catch (err) {
      setNudges((prev) => prev.map((x) => (x.id === n.id ? { ...x, enabled: !enabled } : x)))
      toast({
        title: 'Could not change this nudge',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      })
    } finally {
      load()
    }
  }

  /** Pause or resume every nudge at once — the fastest way to stop all sending. */
  const setAllEnabled = async (enabled: boolean) => {
    if (!enabled && !confirm('Pause every nudge? No nudge will send until you re-enable it.')) return
    setBulkBusy(true)
    try {
      const res = await fetch('/api/nudges/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const data = (await res.json()) as { ok: boolean; count?: number; error?: string }
      if (!data.ok) {
        toast({ title: 'Bulk update failed', description: data.error, variant: 'destructive' })
        return
      }
      toast({
        title: enabled ? 'All nudges resumed' : 'All nudges paused',
        description: `${data.count} nudge(s) ${enabled ? 'enabled' : 'disabled'} — the scheduler has nothing to run.`,
      })
      load()
      onChanged()
    } finally {
      setBulkBusy(false)
    }
  }

  const run = async (n: NudgeDto) => {
    setRunning(n.id)
    try {
      const res = await fetch(`/api/nudges/${n.id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sync: runWithSync }),
      })
      const data = (await res.json()) as { ok: boolean; summary?: RunSummaryDto; error?: string }
      if (!data.ok || !data.summary) {
        toast({ title: 'Run failed', description: data.error, variant: 'destructive' })
        return
      }
      setRunResult(data.summary)
      load()
      onChanged()
    } finally {
      setRunning(null)
      setRunTarget(null)
    }
  }

  const openPreview = async (n: NudgeDto) => {
    setPreviewLoading(true)
    setPreview(null)
    try {
      const res = await fetch(`/api/nudges/${n.id}/preview`)
      const data = (await res.json()) as PreviewDto & { ok: boolean; error?: string }
      if (!data.ok) {
        toast({ title: 'Preview failed', description: data.error, variant: 'destructive' })
        return
      }
      setPreview(data)
    } finally {
      setPreviewLoading(false)
    }
  }

  const remove = async (n: NudgeDto) => {
    if (!confirm(`Delete nudge "${n.name}" and all its message logs?`)) return
    await fetch(`/api/nudges/${n.id}`, { method: 'DELETE' })
    toast({ title: 'Nudge deleted', description: n.name })
    load()
    onChanged()
  }

  const openSheetRun = (n: NudgeDto) => {
    setSheetTarget(n)
    setSheetUrl('')
    setSheetResult(null)
  }

  const runSheetNudge = async () => {
    if (!sheetTarget || !sheetUrl.trim()) return
    setSheetRunning(true)
    setSheetResult(null)
    try {
      const res = await fetch(`/api/nudges/${sheetTarget.id}/sheet-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheetUrl: sheetUrl.trim() }),
      })
      const data = (await res.json()) as {
        ok: boolean
        error?: string
        summary?: {
          sent: number; failed: number; skipped: number;
          failedEntries: { email: string; error: string }[];
          skippedEntries: { lead: string; email: string | null; reason: string; detail?: string }[];
        }
      }
      if (!data.ok || !data.summary) {
        toast({ title: 'Sheet run failed', description: data.error, variant: 'destructive' })
        return
      }
      setSheetResult(data.summary)
      load()
      onChanged()
    } finally {
      setSheetRunning(false)
    }
  }

  const isWhatsApp = form.channel === 'whatsapp'
  const activeCount = nudges.filter((n) => n.enabled).length

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">
            Nudges
            {activeCount > 0 ? (
              <span className="ml-2 text-xs font-normal text-emerald-700">{activeCount} active</span>
            ) : (
              <span className="ml-2 text-xs font-normal text-warning">all paused — nothing will send</span>
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            One nudge = one reusable flow. Only enabled nudges are ever sent, by you or by the scheduler.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {activeCount > 0 ? (
            <Button variant="outline" size="sm" onClick={() => setAllEnabled(false)} disabled={bulkBusy}>
              {bulkBusy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Pause className="h-4 w-4 mr-1" />}
              Pause all
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setAllEnabled(true)} disabled={bulkBusy}>
              {bulkBusy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Play className="h-4 w-4 mr-1" />}
              Resume all
            </Button>
          )}
          <Button onClick={openCreate} size="sm">
            <Plus className="h-4 w-4 mr-1" /> New Nudge
          </Button>
        </div>
      </div>

      {loading ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">loading…</CardContent></Card>
      ) : nudges.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">No nudges yet — create one.</CardContent></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {nudges.map((n) => {
            const source = nudgeSourceOf(n)
            return (
            <Card key={n.id}>
              <CardContent className="p-4 sm:p-6 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="font-medium truncate">{n.name}</h4>
                      <ChannelBadge channel={n.channel} />
                      {source === 'mysql' && (
                        <Badge variant="outline" className="gap-1">
                          <Database className="h-3 w-3" /> MySQL / DB
                        </Badge>
                      )}
                      {source === 'sheet' && (
                        <Badge variant="outline" className="gap-1">
                          <Sheet className="h-3 w-3" /> Manual / Sheet
                        </Badge>
                      )}
                      <Badge variant="outline" className="font-mono text-xs">{n.key}</Badge>
                      {!n.enabled && <Badge variant="secondary">disabled</Badge>}
                    </div>
                    {n.description ? (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{n.description}</p>
                    ) : null}
                  </div>
                  <Switch checked={n.enabled} onCheckedChange={(v) => toggleEnabled(n, v)} aria-label="Enable nudge" />
                </div>

                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                  <span><Send className="inline h-3 w-3 mr-1" />{n.messagesSent} messages sent</span>
                  <span><RefreshCcw className="inline h-3 w-3 mr-1" />max {n.maxEmailsPerLead}/lead</span>
                  <span>follow-up every {n.followUpDays}d</span>
                  <span>last run: {n.lastRunAt ? new Date(n.lastRunAt).toLocaleString() : 'never'}</span>
                </div>

                {/* Which template this nudge sends. WhatsApp uses a Meta-approved template;
                    email's "template" is the subject + body stored on the nudge itself. */}
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                  {n.channel === 'whatsapp' ? (
                    n.whatsappTemplateName ? (
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <MessageCircle className="h-3.5 w-3.5 text-success shrink-0" />
                        <span className="text-muted-foreground">Template</span>
                        <code className="font-mono">{n.whatsappTemplateName}</code>
                        <Badge variant="outline" className="font-mono">{n.whatsappLanguage || 'en_US'}</Badge>
                      </p>
                    ) : (
                      <p className="flex items-center gap-2 text-warning">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                        No template attached — sends free-form text, which Meta only allows inside the 24h window.
                      </p>
                    )
                  ) : (
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">Subject</span>
                      <span className="font-medium truncate">{n.subjectTemplate || <span className="text-destructive">not set</span>}</span>
                    </p>
                  )}
                </div>

                <Separator />

                <div className="flex flex-wrap gap-2">
                  {/* Lead-driven (Zoho) and MySQL-driven nudges can be Run directly.
                      Sheet nudges cannot: running one would email every synced lead, so
                      only the sheet flow is exposed for them. */}
                  {(source === 'zoho' || source === 'mysql') && (
                    <>
                      <Button size="sm" onClick={() => { setRunWithSync(source === 'zoho'); setRunTarget(n) }} disabled={!n.enabled}>
                        {running === n.id ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Play className="h-4 w-4 mr-1" />}
                        Run
                      </Button>
                      {source === 'zoho' && (
                        <Button size="sm" variant="outline" onClick={() => openPreview(n)}>
                          <Eye className="h-4 w-4 mr-1" /> Preview
                        </Button>
                      )}
                    </>
                  )}
                  {(source === 'sheet' || (source === 'zoho' && n.channel === 'email')) && (
                    <Button
                      size="sm"
                      variant={source === 'sheet' ? 'default' : 'outline'}
                      onClick={() => openSheetRun(n)}
                      disabled={!n.enabled}
                    >
                      <Sheet className="h-4 w-4 mr-1" /> Send from Sheet
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => openEdit(n)}>
                    <Pencil className="h-4 w-4 mr-1" /> Edit
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => remove(n)}>
                    <Trash2 className="h-4 w-4 mr-1" /> Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
            )
          })}
        </div>
      )}

      {/* Create / Edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit nudge: ${editing.name}` : 'Create a new nudge'}</DialogTitle>
            <DialogDescription>
              A nudge is a reusable flow: channel → optional Zoho criteria → local lead filters → template → send sequence.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="n-name">Name</Label>
                <Input id="n-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Payment Reminder" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="n-key">Key (unique slug)</Label>
                <Input id="n-key" value={form.key} disabled={!!editing} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="payment_reminder" />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Channel</Label>
                <Select value={form.channel} onValueChange={(v: NudgeChannel) => setForm({ ...form, channel: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email">Email (SMTP)</SelectItem>
                    <SelectItem value="whatsapp">WhatsApp (Meta Cloud API)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="n-desc">Description</Label>
                <Input id="n-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What this nudge is for" />
              </div>
            </div>

            {isWhatsApp && (
              <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
                <Info className="h-4 w-4 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p><b>Meta setup required once:</b> register your WhatsApp number in Meta Business, approve the template, then set WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID in .env.</p>
                  <p>Webhook URL for Meta: <code className="font-mono bg-white px-1 rounded">{typeof window !== 'undefined' ? `${window.location.origin}/api/track/whatsapp` : '/api/track/whatsapp'}</code> (set WHATSAPP_VERIFY_TOKEN too). Read receipts → opened, customer replies → replied.</p>
                </div>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="n-max">Max messages / lead</Label>
                <Input id="n-max" type="number" min={1} value={form.maxEmailsPerLead} onChange={(e) => setForm({ ...form, maxEmailsPerLead: Number(e.target.value) })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="n-fup">Follow-up gap (days)</Label>
                <Input id="n-fup" type="number" min={0} value={form.followUpDays} onChange={(e) => setForm({ ...form, followUpDays: Number(e.target.value) })} />
              </div>
              <div className="flex items-end gap-2 pb-1">
                <Switch id="n-enabled" checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
                <Label htmlFor="n-enabled">Enabled</Label>
              </div>
            </div>

            {isWhatsApp ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="n-wa-tpl">Meta template name (approved)</Label>
                    <Input id="n-wa-tpl" className="font-mono text-xs" value={form.whatsappTemplateName} onChange={(e) => setForm({ ...form, whatsappTemplateName: e.target.value })} placeholder="documents_pending_reminder" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="n-wa-lang">Template language</Label>
                    <Input id="n-wa-lang" value={form.whatsappLanguage} onChange={(e) => setForm({ ...form, whatsappLanguage: e.target.value })} placeholder="en_US" />
                    <p className="text-xs text-muted-foreground">
                      Must match the approved template <b>exactly</b>. Meta distinguishes <code>en</code> from{' '}
                      <code>en_US</code>, and a mismatch fails with <code>132001 — template does not exist in the
                      translation</code>. Check with <code>npm run wa:check -- --list-templates</code>.
                    </p>
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="n-wa-params">Template parameters (JSON array)</Label>
                  <Textarea id="n-wa-params" rows={2} className="font-mono text-xs" value={form.whatsappParams} onChange={(e) => setForm({ ...form, whatsappParams: e.target.value })} />
                  <p className="text-xs text-muted-foreground">
                    Order maps to Meta template variables: [&quot;first_name&quot;, &quot;company&quot;] → {'{{1}}'}, {'{{2}}'}. Available: {TEMPLATE_VARS}
                  </p>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="n-wa-body">Template body (reference copy, optional)</Label>
                  <Textarea id="n-wa-body" rows={4} className="font-mono text-xs" value={form.bodyTemplate} onChange={(e) => setForm({ ...form, bodyTemplate: e.target.value })} placeholder="Hi {{1}}, your KYC documents are pending..." />
                  <p className="text-xs text-muted-foreground">Paste the exact Meta template text here for team reference — not sent by this app.</p>
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="n-subject">Subject template</Label>
                  <Input id="n-subject" value={form.subjectTemplate} onChange={(e) => setForm({ ...form, subjectTemplate: e.target.value })} placeholder="Action pending: complete your documents" />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="n-body">Email body (HTML)</Label>
                  <Textarea id="n-body" rows={8} className="font-mono text-xs" value={form.bodyTemplate} onChange={(e) => setForm({ ...form, bodyTemplate: e.target.value })} />
                  <p className="text-xs text-muted-foreground">Variables: {TEMPLATE_VARS}. A tracking pixel is appended automatically.</p>
                </div>
              </>
            )}

            <Separator />

            <div className="grid gap-1.5">
              <Label htmlFor="n-criteria">Zoho criteria (optional — synced on each run)</Label>
              <Textarea id="n-criteria" rows={3} className="font-mono text-xs" value={form.zohoCriteria} onChange={(e) => setForm({ ...form, zohoCriteria: e.target.value })} placeholder="((Business_vertical:equals:EPS)and(KYC_Document_Upload_Count:less_equal:11))" />
              <p className="text-xs text-muted-foreground">If set, running the nudge first syncs matching leads from Zoho CRM.</p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="n-filters">Local lead filters (JSON)</Label>
              <Textarea id="n-filters" rows={5} className="font-mono text-xs" value={form.filters} onChange={(e) => setForm({ ...form, filters: e.target.value })} />
              <p className="text-xs text-muted-foreground">
                Keys: requireEmail / requirePhone, excludeStatuses[], businessVertical, minKycCount, maxKycCount, createdAfter (ISO date)
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving || !canSave}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create nudge'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Run confirmation */}
      <AlertDialog open={!!runTarget} onOpenChange={(o) => !o && setRunTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Run nudge &ldquo;{runTarget?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              {runTarget?.channel === 'whatsapp'
                ? 'This will send WhatsApp template messages (Meta Cloud API) to every eligible lead that hasn\'t hit the sequence limit.'
                : 'This will send emails to every eligible lead that hasn\'t hit the sequence limit.'}{' '}
              Max {runTarget?.maxEmailsPerLead} message(s) per lead, {runTarget?.followUpDays} day(s) between follow-ups.
              A per-run cap (NUDGE_MAX_PER_RUN) protects the request from timing out — leftover leads resume on the next
              scheduled run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center gap-2 py-1">
            <Switch id="run-sync" checked={runWithSync} onCheckedChange={setRunWithSync} />
            <Label htmlFor="run-sync" className="text-sm font-normal">
              Sync from Zoho first
              <span className="block text-xs text-muted-foreground">uncheck to send to already-synced leads (e.g. when the Zoho token is expired)</span>
            </Label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => runTarget && run(runTarget)}>
              {running ? 'Running…' : runTarget?.channel === 'whatsapp' ? 'Send WhatsApp messages' : 'Send emails'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Run result */}
      <Dialog open={!!runResult} onOpenChange={(o) => !o && setRunResult(null)}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Run complete: {runResult?.nudgeKey}</DialogTitle>
            <DialogDescription>
              {runResult?.syncedFromZoho !== null && runResult?.syncedFromZoho !== undefined
                ? `${runResult.syncedFromZoho} leads synced from Zoho · `
                : ''}
              {runResult?.leadsConsidered} leads considered ·{' '}
              <b className="text-success">{runResult?.sent} sent</b> ·{' '}
              {runResult?.failed ? <span className="text-destructive">{runResult.failed} failed</span> : '0 failed'}
              {runResult?.deferred ? (
                <span className="block mt-1 text-warning">
                  {runResult.deferred} lead(s) deferred — the per-run cap is {runResult.batchLimit}. They are picked up on
                  the next scheduled run, or run again now.
                </span>
              ) : null}
              {runResult?.channel === 'email' && !runResult?.smtpConfigured && (
                <span className="flex items-start gap-1.5 mt-2 text-warning">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  SMTP not configured — attempts were logged as failed. Set SMTP_USER / SMTP_PASS / MAIL_FROM in .env.
                </span>
              )}
              {runResult?.channel === 'whatsapp' && !runResult?.whatsappConfigured && (
                <span className="flex items-start gap-1.5 mt-2 text-warning">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  WhatsApp not configured — attempts were logged as failed. Set WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID in .env (after Meta approves your number and template).
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          {runResult && runResult.skipped.length > 0 ? (
            <div className="rounded-md border max-h-72 overflow-y-auto p-2 space-y-1">
              {runResult.skipped.map((s, i) => (
                <div key={i} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/60">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{s.lead}</p>
                    <p className="truncate text-xs text-muted-foreground">{s.email || s.phone || 'no contact'}</p>
                  </div>
                  {reasonBadge(s.reason, s.detail)}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No skips — everyone eligible got a message.</p>
          )}
        </DialogContent>
      </Dialog>

      {/* Preview */}
      <Dialog open={!!preview || previewLoading} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Preview (dry run — nothing sent)</DialogTitle>
            <DialogDescription>
              {preview
                ? `${preview.leadsConsidered} leads match the filters · ${preview.wouldSend.length} would receive a ${preview.channel === 'whatsapp' ? 'WhatsApp message' : 'n email'} now`
                : 'calculating…'}
            </DialogDescription>
          </DialogHeader>

          {preview ? (
            <div className="space-y-4">
              <div>
                <p className="text-xs font-medium mb-1.5 text-emerald-700">Would send ({preview.wouldSend.length})</p>
                <div className="rounded-md border max-h-56 overflow-y-auto p-2 space-y-1">
                  {preview.wouldSend.length === 0 ? (
                    <p className="text-sm text-muted-foreground p-2">No one is due for a message right now.</p>
                  ) : (
                    preview.wouldSend.map((s, i) => (
                      <div key={i} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/60">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{s.lead}</p>
                          <p className="truncate text-xs text-muted-foreground">{s.phone || s.email}</p>
                        </div>
                        <Badge variant="outline">#{s.messageNumber}</Badge>
                      </div>
                    ))
                  )}
                </div>
              </div>
              {preview.wouldSkip.length > 0 && (
                <div>
                  <p className="text-xs font-medium mb-1.5 text-muted-foreground">Skipped ({preview.wouldSkip.length})</p>
                  <div className="rounded-md border max-h-56 overflow-y-auto p-2 space-y-1">
                    {preview.wouldSkip.map((s, i) => (
                      <div key={i} className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/60">
                        <div className="min-w-0">
                          <p className="truncate font-medium">{s.lead}</p>
                          <p className="truncate text-xs text-muted-foreground">{s.email || s.phone || 'no contact'}</p>
                        </div>
                        {reasonBadge(s.reason, s.detail)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-muted-foreground">loading preview…</div>
          )}
        </DialogContent>
      </Dialog>

      {/* Sheet-run dialog */}
      <Dialog open={!!sheetTarget} onOpenChange={(o) => { if (!o) { setSheetTarget(null); setSheetResult(null) } }}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              <Sheet className="inline h-4 w-4 mr-1.5 -mt-0.5" />
              Send from Google Sheet — {sheetTarget?.name}
            </DialogTitle>
            <DialogDescription>
              Paste a publicly-shared Google Sheet URL. Each row must have an <code>email</code> column.
              Any column header (e.g. <code>first_name</code>, <code>company</code>) becomes a{' '}
              <code>{'{{variable}}'}</code> in the email template. Already-sent rows are automatically skipped.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-1">
            <div className="grid gap-1.5">
              <Label htmlFor="sheet-url">Google Sheet URL</Label>
              <Input
                id="sheet-url"
                value={sheetUrl}
                onChange={(e) => setSheetUrl(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/…"
                disabled={sheetRunning}
              />
              <p className="text-xs text-muted-foreground">
                The sheet must be shared as <strong>&ldquo;Anyone with the link can view&rdquo;</strong> (no sign-in required).
              </p>
            </div>

            {sheetResult && (
              <div className="rounded-md border p-3 space-y-2">
                <div className="flex gap-4 text-sm font-medium">
                  <span className="text-success">✓ {sheetResult.sent} sent</span>
                  <span className="text-destructive">✗ {sheetResult.failed} failed</span>
                  <span className="text-muted-foreground">— {sheetResult.skipped} skipped</span>
                </div>
                {sheetResult.failedEntries.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-destructive">Failed:</p>
                    {sheetResult.failedEntries.map((f, i) => (
                      <div key={i} className="text-xs rounded bg-destructive/10 px-2 py-1">
                        <span className="font-mono">{f.email}</span> — {f.error}
                      </div>
                    ))}
                  </div>
                )}
                {sheetResult.skippedEntries.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Skipped:</p>
                    <div className="max-h-40 overflow-y-auto space-y-0.5">
                      {sheetResult.skippedEntries.map((s, i) => (
                        <div key={i} className="flex items-center justify-between text-xs rounded px-2 py-1 hover:bg-muted/60">
                          <span className="truncate font-mono">{s.email || s.lead}</span>
                          {reasonBadge(s.reason, s.detail)}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setSheetTarget(null); setSheetResult(null) }}>Close</Button>
            <Button onClick={runSheetNudge} disabled={sheetRunning || !sheetUrl.trim()}>
              {sheetRunning ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Sending…</> : <><Sheet className="h-4 w-4 mr-1.5" />Send emails</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

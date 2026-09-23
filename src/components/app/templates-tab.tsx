'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  RefreshCw, Plus, Loader2, AlertCircle, CheckCircle2, Clock, XCircle, Trash2, Send, Info, Copy, Check, Pencil, Mail,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useToast } from '@/hooks/use-toast'
import type { NudgeDto } from '@/lib/app-types'

interface WaTemplate {
  id: string
  name: string
  status: string
  language: string
  category: string
  rejected_reason?: string | null
  components?: {
    type?: string
    text?: string
    format?: string
    buttons?: { type?: string; text?: string; url?: string }[]
  }[]
}

const CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION']

const emptyForm = {
  name: '',
  language: 'en_US',
  category: 'UTILITY',
  headerText: '',
  bodyText: 'Hi {{1}}, your KYC document upload for {{2}} is still pending ({{3}} document(s) uploaded). Please complete it to keep your onboarding moving.',
  footerText: 'Eko Onboarding Team',
  buttonText: '',
  buttonUrl: '',
}

/** Pull the editable fields back out of a Meta template definition. */
function formFromTemplate(t: WaTemplate) {
  const header = t.components?.find((c) => c.type === 'HEADER')
  const body = t.components?.find((c) => c.type === 'BODY')
  const footer = t.components?.find((c) => c.type === 'FOOTER')
  const button = t.components?.find((c) => c.type === 'BUTTONS')?.buttons?.find((b) => b.type === 'URL')
  return {
    name: t.name,
    language: t.language,
    category: t.category || 'UTILITY',
    headerText: header?.text || '',
    bodyText: body?.text || '',
    footerText: footer?.text || '',
    buttonText: button?.text || '',
    buttonUrl: button?.url || '',
  }
}

function StatusBadge({ t }: { t: WaTemplate }) {
  const s = (t.status || '').toUpperCase()
  if (s === 'APPROVED')
    return (
      <Badge className="bg-emerald-600 hover:bg-emerald-600 gap-1">
        <CheckCircle2 className="h-3 w-3" /> Approved
      </Badge>
    )
  if (s === 'PENDING' || s === 'IN_APPEAL' || s === 'PENDING_DELETION')
    return (
      <TooltipProvider delayDuration={100}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge className="bg-amber-500 hover:bg-amber-500 gap-1">
              <Clock className="h-3 w-3" /> {s === 'PENDING' ? 'Pending review' : s.replace(/_/g, ' ').toLowerCase()}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs max-w-72">
            Meta is still reviewing this template. Refresh this list later — it becomes usable once approved.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="destructive" className="gap-1">
            <XCircle className="h-3 w-3" /> {s.replace(/_/g, ' ').toLowerCase() || 'unknown'}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs max-w-72">
          {t.rejected_reason || 'Meta rejected this template. Fix the content and submit a new one.'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function TemplatesTab({
  refreshKey,
  onEditNudge,
}: {
  refreshKey: number
  /** Jump to the Nudges tab with that nudge's editor open (email templates live there). */
  onEditNudge: (nudgeId: string) => void
}) {
  const { toast } = useToast()
  const [templates, setTemplates] = useState<WaTemplate[]>([])
  const [configured, setConfigured] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [configHint, setConfigHint] = useState<string | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<WaTemplate | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [formErrors, setFormErrors] = useState<string[]>([])
  const [needsReplace, setNeedsReplace] = useState(false)

  const [applyTarget, setApplyTarget] = useState<WaTemplate | null>(null)
  const [nudges, setNudges] = useState<NudgeDto[]>([])
  const [applyNudgeId, setApplyNudgeId] = useState('')
  const [applying, setApplying] = useState(false)

  const [copied, setCopied] = useState<string | null>(null)

  /** Email nudges carry their own subject/body — there is no Meta-side email registry. */
  const emailNudges = nudges.filter((n) => n.channel === 'email')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/whatsapp/templates')
      const data = (await res.json()) as {
        ok: boolean
        configured: boolean
        templates: WaTemplate[]
        error?: string
        configHint?: string | null
      }
      setTemplates(data.templates || [])
      setConfigured(data.configured)
      setError(data.ok ? null : data.error || 'Could not load templates')
      setConfigHint(data.configHint || null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  useEffect(() => {
    fetch('/api/nudges')
      .then((r) => r.json())
      .then((d: { nudges: NudgeDto[] }) => setNudges(d.nudges || []))
      .catch(() => undefined)
  }, [])

  const create = async () => {
    setSaving(true)
    setFormErrors([])
    setNeedsReplace(false)
    try {
      const isEdit = Boolean(editing)
      const res = await fetch('/api/whatsapp/templates', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isEdit ? { ...form, id: editing?.id } : form),
      })
      const data = (await res.json()) as {
        ok: boolean
        error?: string
        errors?: string[]
        warnings?: string[]
        message?: string
        needsReplace?: boolean
      }
      if (!data.ok) {
        setFormErrors(data.errors?.length ? data.errors : [data.error || 'Could not save the template'])
        setNeedsReplace(Boolean(data.needsReplace))
        toast({ title: isEdit ? 'Update rejected' : 'Template rejected by Meta', description: data.error, variant: 'destructive' })
        return
      }
      toast({ title: isEdit ? 'Template updated' : 'Template submitted', description: data.message || 'Waiting for Meta review.' })
      if (data.warnings?.length) toast({ title: 'Heads up', description: data.warnings.join(' ') })
      setCreateOpen(false)
      setEditing(null)
      setForm(emptyForm)
      load()
    } finally {
      setSaving(false)
    }
  }

  /** Explicit delete + re-create, for a template Meta has locked while in review. */
  const replace = async () => {
    if (!editing) return
    const ok = confirm(
      `Meta locks a template while it is in review, so "${editing.name}" cannot be edited directly.\n\n` +
        `Replace it? The current template will be DELETED and a new one created with the same name. ` +
        `Meta can take up to a couple of minutes to release the name, so this request may be slow.`
    )
    if (!ok) return

    setSaving(true)
    setFormErrors([])
    try {
      const res = await fetch('/api/whatsapp/templates', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, id: editing.id, mode: 'replace' }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string; message?: string }
      if (!data.ok) {
        setFormErrors([data.error || 'Replace failed'])
        toast({ title: 'Replace failed', description: data.error, variant: 'destructive' })
        return
      }
      toast({ title: 'Template replaced', description: data.message })
      setCreateOpen(false)
      setEditing(null)
      setForm(emptyForm)
      setNeedsReplace(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  const openEdit = (t: WaTemplate) => {
    setEditing(t)
    setForm(formFromTemplate(t))
    setFormErrors([])
    setNeedsReplace(false)
    setCreateOpen(true)
  }

  const remove = async (t: WaTemplate) => {
    if (!confirm(`Delete template "${t.name}" (${t.language}) from Meta? This cannot be undone.`)) return
    const res = await fetch(`/api/whatsapp/templates?name=${encodeURIComponent(t.name)}&language=${encodeURIComponent(t.language)}`, {
      method: 'DELETE',
    })
    const data = (await res.json()) as { ok: boolean; error?: string }
    if (!data.ok) {
      toast({ title: 'Delete failed', description: data.error, variant: 'destructive' })
      return
    }
    toast({ title: 'Template deleted', description: `${t.name} (${t.language})` })
    load()
  }

  const openApply = (t: WaTemplate) => {
    setApplyTarget(t)
    setApplyNudgeId('')
  }

  const applyToNudge = async () => {
    if (!applyTarget || !applyNudgeId) return
    setApplying(true)
    try {
      const nudge = nudges.find((n) => n.id === applyNudgeId)
      const res = await fetch(`/api/nudges/${applyNudgeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: 'whatsapp',
          whatsappTemplateName: applyTarget.name,
          whatsappLanguage: applyTarget.language,
        }),
      })
      const data = (await res.json()) as { ok: boolean; error?: string }
      if (!data.ok) {
        toast({ title: 'Could not attach template', description: data.error, variant: 'destructive' })
        return
      }
      toast({
        title: 'Template attached',
        description: `${nudge?.name || applyNudgeId} now sends "${applyTarget.name}" (${applyTarget.language})`,
      })
      setApplyTarget(null)
    } finally {
      setApplying(false)
    }
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast({ title: 'Copy failed', description: 'Copy it manually: ' + text, variant: 'destructive' })
    }
  }

  const approved = templates.filter((t) => (t.status || '').toUpperCase() === 'APPROVED')
  const pending = templates.filter((t) => (t.status || '').toUpperCase() === 'PENDING')

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">WhatsApp message templates</h3>
          <p className="text-xs text-muted-foreground">
            Add a template here and it is submitted to Meta for approval. Once it shows <b>Approved</b>, attach it to a
            nudge. Meta requires an approved template for every business-initiated message.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
            Refresh status
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditing(null)
              setForm(emptyForm)
              setFormErrors([])
              setNeedsReplace(false)
              setCreateOpen(true)
            }}
            disabled={!configured}
          >
            <Plus className="h-4 w-4 mr-1" /> New template
          </Button>
        </div>
      </div>

      {!configured && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">WhatsApp template management is not configured</p>
            <p>
              Set <code className="font-mono">WHATSAPP_TOKEN</code> and <code className="font-mono">WHATSAPP_WABA_ID</code>{' '}
              in the environment, then reload.
            </p>
          </div>
        </div>
      )}

      {error && configured && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium">{error}</p>
            {configHint && <p>{configHint}</p>}
          </div>
        </div>
      )}

      {configured && !error && (
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span>{templates.length} template(s) on the account</span>
          <span className="text-emerald-700">{approved.length} approved — ready to use</span>
          <span className="text-amber-600">{pending.length} awaiting review</span>
        </div>
      )}

      <Card>
        <CardContent className="p-4 sm:p-6">
          <div className="max-h-[32rem] overflow-y-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Language</TableHead>
                  <TableHead className="hidden md:table-cell">Category</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Body preview</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && templates.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-xs text-muted-foreground py-8 text-center">
                      <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> loading templates…
                    </TableCell>
                  </TableRow>
                ) : templates.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-10">
                      No templates yet — click <b>New template</b> to submit one for approval.
                    </TableCell>
                  </TableRow>
                ) : (
                  templates.map((t) => {
                    const bodyText = t.components?.find((c) => c.type === 'BODY')?.text || ''
                    const isApproved = (t.status || '').toUpperCase() === 'APPROVED'
                    return (
                      <TableRow key={t.id || `${t.name}-${t.language}`}>
                        <TableCell className="font-mono text-xs">{t.name}</TableCell>
                        <TableCell className="font-mono text-xs">{t.language}</TableCell>
                        <TableCell className="hidden md:table-cell text-xs text-muted-foreground">{t.category}</TableCell>
                        <TableCell><StatusBadge t={t} /></TableCell>
                        <TableCell className="hidden lg:table-cell max-w-72 truncate text-xs text-muted-foreground">
                          {bodyText || '—'}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              title="Copy name"
                              onClick={() => copy(t.name)}
                            >
                              {copied === t.name ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => openEdit(t)}>
                              <Pencil className="h-4 w-4 mr-1" /> Edit
                            </Button>
                            <Button size="sm" variant="outline" disabled={!isApproved} onClick={() => openApply(t)}>
                              <Send className="h-4 w-4 mr-1" /> Use in nudge
                            </Button>
                            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => remove(t)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Only <b>Approved</b> templates can be attached. Approval is asynchronous — Meta usually reviews within
            minutes to a few hours; use <b>Refresh status</b> to check.
          </p>
        </CardContent>
      </Card>

      {/* Email templates — these live in the nudge rows, not at Meta, so there is no
          approval step and no separate registry to keep in sync. */}
      <Card>
        <CardContent className="p-4 sm:p-6 space-y-3">
          <div>
            <h3 className="text-sm font-medium flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground" /> Email templates
            </h3>
            <p className="text-xs text-muted-foreground">
              Email has no external registry — a template <i>is</i> the nudge&apos;s subject and body, so these are
              edited through the nudge itself. {emailNudges.length} email nudge(s) configured.
            </p>
          </div>

          <div className="max-h-80 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>Nudge</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead className="hidden lg:table-cell">Body preview</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {emailNudges.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      No email nudges configured.
                    </TableCell>
                  </TableRow>
                ) : (
                  emailNudges.map((n) => (
                    <TableRow key={n.id}>
                      <TableCell>
                        <p className="font-medium text-sm">{n.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">{n.key}</p>
                      </TableCell>
                      <TableCell className="max-w-64 truncate text-xs">
                        {n.subjectTemplate ? (
                          n.subjectTemplate
                        ) : (
                          <span className="text-destructive">no subject set</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell max-w-72 truncate text-xs text-muted-foreground">
                        {n.bodyTemplate ? n.bodyTemplate.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 110) : '—'}
                      </TableCell>
                      <TableCell>
                        {n.subjectTemplate && n.bodyTemplate ? (
                          <Badge className="bg-emerald-600 hover:bg-emerald-600 gap-1">
                            <CheckCircle2 className="h-3 w-3" /> ready
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="gap-1">
                            <XCircle className="h-3 w-3" /> incomplete
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Copy subject"
                            disabled={!n.subjectTemplate}
                            onClick={() => copy(n.subjectTemplate || '')}
                          >
                            {copied === n.subjectTemplate ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => onEditNudge(n.id)}>
                            <Pencil className="h-4 w-4 mr-1" /> Edit
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            <b>Edit</b> opens this nudge&apos;s editor on the Nudges tab, where the subject and body live. Email needs no
            approval, so changes take effect on the next run.
          </p>
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit “${editing.name}”` : 'New WhatsApp template'}</DialogTitle>
            <DialogDescription>
              {editing ? (
                <>
                  Editing an existing template puts it back into review — it shows as <b>Pending</b> until Meta
                  re-approves it. The name and language identify the template and cannot be changed.
                </>
              ) : (
                <>
                  Submitted to Meta for approval. Variables use positional placeholders: <code>{'{{1}}'}</code>,{' '}
                  <code>{'{{2}}'}</code>… which map to the nudge&apos;s template parameters.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="t-name">Name</Label>
                <Input
                  id="t-name"
                  className="font-mono text-xs"
                  value={form.name}
                  disabled={Boolean(editing)}
                  onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
                  placeholder="documents_pending_reminder"
                />
                <p className="text-xs text-muted-foreground">
                  {editing ? 'immutable — Meta identifies the template by name' : 'lowercase, digits, underscores only'}
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="t-lang">Language</Label>
                <Input id="t-lang" className="font-mono text-xs" value={form.language} disabled={Boolean(editing)} onChange={(e) => setForm({ ...form, language: e.target.value })} placeholder="en_US" />
                <p className="text-xs text-muted-foreground">
                  {editing ? 'immutable' : <>must match exactly when sending — <code>en</code> ≠ <code>en_US</code></>}
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">UTILITY for transactional nudges</p>
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="t-header">Header (optional, max 60)</Label>
              <Input id="t-header" value={form.headerText} onChange={(e) => setForm({ ...form, headerText: e.target.value })} />
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="t-body">Body</Label>
              <Textarea id="t-body" rows={6} value={form.bodyText} onChange={(e) => setForm({ ...form, bodyText: e.target.value })} />
              <p className="text-xs text-muted-foreground">
                {form.bodyText.length}/1024 characters. Variables must run contiguously from <code>{'{{1}}'}</code>.
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="t-footer">Footer (optional, max 60)</Label>
              <Input id="t-footer" value={form.footerText} onChange={(e) => setForm({ ...form, footerText: e.target.value })} />
            </div>

            <Separator />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="t-btn-text">URL button text (optional, max 25)</Label>
                <Input id="t-btn-text" value={form.buttonText} onChange={(e) => setForm({ ...form, buttonText: e.target.value })} placeholder="REVIEW and PAY" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="t-btn-url">URL button link</Label>
                <Input
                  id="t-btn-url"
                  className="font-mono text-xs"
                  value={form.buttonUrl}
                  onChange={(e) => setForm({ ...form, buttonUrl: e.target.value })}
                  placeholder="https://eps.eko.in/console/pay-activation-fee?mobile={{1}}"
                />
                <p className="text-xs text-muted-foreground">
                  A variable must be a single <code>{'{{1}}'}</code> at the very end of the URL.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              <Info className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                Meta requires sample values for any variable, so examples are filled in automatically when submitting.
                Inside a nudge, the parameters are supplied positionally from the nudge&apos;s <i>Template parameters</i>{' '}
                list (e.g. <code>first_name</code>, <code>company</code>).
              </span>
            </div>

            {formErrors.length > 0 && (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900 space-y-1">
                {formErrors.map((e, i) => (
                  <p key={i} className="flex items-start gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {e}
                  </p>
                ))}
                {needsReplace && (
                  <p className="pt-1">
                    <button type="button" className="underline font-medium" onClick={replace} disabled={saving}>
                      Replace it now (delete + re-create with the same name)
                    </button>
                  </p>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setCreateOpen(false); setEditing(null) }}>Cancel</Button>
            <Button onClick={create} disabled={saving || !form.name.trim() || !form.bodyText.trim()}>
              {saving ? (
                <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />{editing ? 'Saving…' : 'Submitting…'}</>
              ) : editing ? (
                'Save changes'
              ) : (
                'Submit for approval'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply to nudge dialog */}
      <Dialog open={!!applyTarget} onOpenChange={(o) => !o && setApplyTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Use “{applyTarget?.name}” in a nudge</DialogTitle>
            <DialogDescription>
              Sets the nudge&apos;s channel to WhatsApp and stores the template name and language (
              <code>{applyTarget?.language}</code>) so its sends use this approved template.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5 py-2">
            <Label>Nudge</Label>
            <Select value={applyNudgeId} onValueChange={setApplyNudgeId}>
              <SelectTrigger><SelectValue placeholder="Choose a nudge…" /></SelectTrigger>
              <SelectContent>
                {nudges.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {n.name} ({n.channel})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Remember to set the nudge&apos;s <b>Template parameters</b> so {`{{1}}`}, {`{{2}}`}… map to lead fields.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApplyTarget(null)}>Cancel</Button>
            <Button onClick={applyToNudge} disabled={!applyNudgeId || applying}>
              {applying ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Applying…</> : 'Attach to nudge'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

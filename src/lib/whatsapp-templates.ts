/**
 * WhatsApp message template management (Meta Cloud API).
 *
 * Lets the app list, create and delete templates on the WABA so an operator never has to
 * leave the dashboard. Approvals are Meta-side and asynchronous: a new template comes back
 * as PENDING and only becomes usable once it flips to APPROVED — which the Templates tab
 * surfaces, so you can see at a glance what is ready to attach to a nudge.
 *
 * This module deliberately has NO `@/` imports so it can be unit-tested directly
 * (see scripts/verify-changes.mjs) — buildTemplatePayload() is pure.
 */

const GRAPH_BASE = () => `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v21.0'}`

export function isTemplateApiConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_WABA_ID)
}

export const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]

/** Meta keeps approved, in-review and rejected templates all in the same list. */
export const TEMPLATE_STATUSES = ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION'] as const

export interface WaTemplate {
  id: string
  name: string
  status: string
  language: string
  category: string
  rejected_reason?: string | null
  quality_score?: { score?: string } | null
  components?: { type?: string; text?: string; format?: string }[]
}

export interface CreateTemplateInput {
  name: string
  language: string
  category: TemplateCategory
  headerText?: string | null
  bodyText: string
  footerText?: string | null
  /** Optional URL button, e.g. "REVIEW and PAY" -> https://eps.eko.in/console/pay-activation-fee?mobile={{1}} */
  buttonText?: string | null
  buttonUrl?: string | null
}

export interface TemplateValidation {
  errors: string[]
  warnings: string[]
}

/** Highest {{n}} index used in a string, or 0 when it has no variables. */
export function countTemplateVars(text: string): number {
  let max = 0
  for (const m of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

export function validateTemplateInput(input: Partial<CreateTemplateInput>): TemplateValidation {
  const errors: string[] = []
  const warnings: string[] = []

  const name = (input.name || '').trim()
  if (!name) errors.push('Name is required')
  else if (!/^[a-z0-9_]+$/.test(name))
    errors.push('Name may only contain lowercase letters, digits and underscores')
  else if (name.length > 512) errors.push('Name is too long (max 512)')

  const language = (input.language || '').trim()
  if (!language) errors.push('Language is required (e.g. en_US)')
  else if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(language))
    errors.push(`Language "${language}" does not look like a Meta locale — use e.g. en_US or en`)
  else if (language === 'en')
    warnings.push('"en" and "en_US" are different locales at Meta. If the template was approved as en_US, sending with "en" fails with 132001.')

  if (!input.category || !TEMPLATE_CATEGORIES.includes(input.category as TemplateCategory))
    errors.push(`Category must be one of ${TEMPLATE_CATEGORIES.join(', ')}`)

  const body = (input.bodyText || '').trim()
  if (!body) errors.push('Body text is required')
  else if (body.length > 1024) errors.push(`Body is ${body.length} characters (max 1024)`)
  else if (!/\{\{\s*\d+\s*\}\}/.test(body))
    warnings.push('Body has no {{1}}-style variables — fine for a static message, but a personalised nudge usually wants at least one.')

  const header = (input.headerText || '').trim()
  if (header.length > 60) errors.push(`Header is ${header.length} characters (max 60)`)

  const footer = (input.footerText || '').trim()
  if (footer.length > 60) errors.push(`Footer is ${footer.length} characters (max 60)`)

  const buttonText = (input.buttonText || '').trim()
  const buttonUrl = (input.buttonUrl || '').trim()
  if (buttonText && !buttonUrl) errors.push('A button needs a URL')
  if (buttonUrl && !buttonText) errors.push('A URL button needs button text (max 25 characters)')
  if (buttonText.length > 25) errors.push(`Button text is ${buttonText.length} characters (max 25)`)
  if (buttonUrl && !/^https:\/\//i.test(buttonUrl)) errors.push('Button URL must start with https://')

  // Meta requires the body's variables to be numbered contiguously from 1
  const bodyVars = countTemplateVars(body)
  if (bodyVars > 0) {
    const found = new Set([...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))
    for (let i = 1; i <= bodyVars; i++) {
      if (!found.has(i)) errors.push(`Body uses {{${bodyVars}}} but is missing {{${i}}} — Meta needs contiguous variables from {{1}}`)
    }
  }

  // A URL button variable must be the LAST part of the URL
  if (buttonUrl.includes('{{')) {
    if (!/\{\{\s*1\s*\}\}\s*$/.test(buttonUrl))
      errors.push('In a URL button the variable must be a single {{1}} at the very end of the URL')
  }

  return { errors, warnings }
}

/**
 * Build the Meta `components` array. Pure — no network.
 * Meta requires an `example` whenever a body or URL contains variables, so examples are
 * generated automatically from the variable count.
 */
export function buildTemplatePayload(input: CreateTemplateInput): Record<string, unknown> {
  const components: Record<string, unknown>[] = []

  const header = (input.headerText || '').trim()
  if (header) components.push({ type: 'HEADER', format: 'TEXT', text: header })

  const body = (input.bodyText || '').trim()
  const bodyVars = countTemplateVars(body)
  const bodyComponent: Record<string, unknown> = { type: 'BODY', text: body }
  if (bodyVars > 0) {
    bodyComponent.example = {
      body_text: [Array.from({ length: bodyVars }, (_, i) => `example${i + 1}`)],
    }
  }
  components.push(bodyComponent)

  const footer = (input.footerText || '').trim()
  if (footer) components.push({ type: 'FOOTER', text: footer })

  const buttonText = (input.buttonText || '').trim()
  const buttonUrl = (input.buttonUrl || '').trim()
  if (buttonText && buttonUrl) {
    const button: Record<string, unknown> = { type: 'URL', text: buttonText, url: buttonUrl }
    if (buttonUrl.includes('{{')) button.example = ['https://example.com/123']
    components.push({ type: 'BUTTONS', buttons: [button] })
  }

  return {
    name: input.name.trim(),
    language: input.language.trim(),
    category: input.category,
    components,
  }
}

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string; error_user_title?: string }
}

function describeError(data: GraphError, status: number): string {
  const e = data?.error
  if (!e) return `HTTP ${status}`
  const bits = [e.error_user_title, e.error_user_msg || e.message].filter(Boolean)
  const code = e.code ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''})` : ''
  return `${bits.join(' — ')}${code}`
}

export interface TemplateListResult {
  ok: boolean
  configured: boolean
  templates: WaTemplate[]
  error?: string
}

export async function listTemplates(): Promise<TemplateListResult> {
  if (!isTemplateApiConfigured()) {
    return {
      ok: false,
      configured: false,
      templates: [],
      error: 'Set WHATSAPP_TOKEN and WHATSAPP_WABA_ID to manage templates.',
    }
  }

  try {
    const url =
      `${GRAPH_BASE()}/${process.env.WHATSAPP_WABA_ID}/message_templates` +
      `?fields=id,name,status,language,category,rejected_reason,quality_score,components&limit=200`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } })
    const data = (await res.json().catch(() => ({}))) as { data?: WaTemplate[] } & GraphError
    if (!res.ok) return { ok: false, configured: true, templates: [], error: describeError(data, res.status) }
    return { ok: true, configured: true, templates: data.data ?? [] }
  } catch (err) {
    return { ok: false, configured: true, templates: [], error: err instanceof Error ? err.message : String(err) }
  }
}

export interface TemplateMutationResult {
  ok: boolean
  id?: string
  status?: string
  error?: string
  /**
   * True when Meta refused an in-place edit because the template is locked (in review).
   * The caller may then offer an explicit delete + re-create. Deliberately NOT automatic:
   * Meta can take a long time to release a deleted name, and silently deleting a template
   * the operator did not ask to delete is worse than refusing.
   */
  needsReplace?: boolean
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function createTemplate(input: CreateTemplateInput): Promise<TemplateMutationResult> {
  const { errors } = validateTemplateInput(input)
  if (errors.length) return { ok: false, error: errors.join('; ') }
  if (!isTemplateApiConfigured()) return { ok: false, error: 'Set WHATSAPP_TOKEN and WHATSAPP_WABA_ID first.' }

  const payload = buildTemplatePayload(input)

  // After deleting a template, Meta refuses to re-create the same name + language until it
  // has finished processing the deletion (error 2388023). That usually clears within a
  // minute but can take longer for a previously-approved template, so wait it out rather
  // than leaving the caller with a deleted-but-not-recreated template.
  const MAX_ATTEMPTS = 9
  let lastError = ''

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${GRAPH_BASE()}/${process.env.WHATSAPP_WABA_ID}/message_templates`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      const data = (await res.json().catch(() => ({}))) as { id?: string; status?: string } & GraphError

      if (res.ok) return { ok: true, id: data.id, status: data.status }

      const e = data?.error
      const msg = [e?.error_user_title, e?.error_user_msg, e?.message].filter(Boolean).join(' ')
      lastError = describeError(data, res.status)

      const stillDeleting = /being deleted|try again/i.test(msg)
      if (!stillDeleting || attempt === MAX_ATTEMPTS) break

      const waitMs = 10_000
      console.log(`[whatsapp-templates] "${input.name}" still being deleted — retrying in ${waitMs / 1000}s (${attempt}/${MAX_ATTEMPTS})`)
      await sleep(waitMs)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      break
    }
  }

  return { ok: false, error: lastError || 'Could not create the template' }
}

/**
 * Edit an existing template.
 *
 * Meta's rules (error 2388003):
 *   • APPROVED template → editable; the edit creates a new revision that returns to PENDING.
 *   • PENDING (in review) → LOCKED. Cannot be edited at all until it is reviewed.
 *   • REJECTED → editable.
 *
 * When Meta refuses because the template is locked, this returns `needsReplace: true` and
 * changes NOTHING. Deleting is deliberately left to an explicit caller decision: Meta can
 * take a long time to release a deleted name, so silently deleting a template the operator
 * did not ask to delete is worse than refusing (see replaceTemplate).
 */
export async function editTemplate(
  id: string,
  input: CreateTemplateInput
): Promise<TemplateMutationResult> {
  const { errors } = validateTemplateInput(input)
  if (errors.length) return { ok: false, error: errors.join('; ') }
  if (!isTemplateApiConfigured()) return { ok: false, error: 'Set WHATSAPP_TOKEN and WHATSAPP_WABA_ID first.' }

  const payload = buildTemplatePayload(input)
  // The name and language identify the template; only the content is editable.
  delete (payload as Record<string, unknown>).name
  delete (payload as Record<string, unknown>).language

  try {
    const res = await fetch(`${GRAPH_BASE()}/${id}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; id?: string; status?: string } & GraphError

    if (res.ok) return { ok: true, id, status: data.status ?? 'PENDING' }

    // Meta puts the usable text in error_user_msg (error.message is often generic), and its
    // apostrophe in "can’t" is typographic, so match loosely across every field.
    const e = data?.error
    const msg = [e?.error_user_title, e?.error_user_msg, e?.message].filter(Boolean).join(' ')
    const locked = /can\W{0,2}t be edited|can only be edited|being reviewed|in review/i.test(msg)

    return {
      ok: false,
      error: locked
        ? 'Meta locks a template while it is in review, so it cannot be edited yet. Wait for it to be approved or rejected, then edit it — or use Delete and create it again with the same name.'
        : describeError(data, res.status),
      needsReplace: locked,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Replace a template: delete it, then create a fresh one with the same name and language.
 *
 * Explicit only. There is a real gap after the delete — Meta refuses to re-create a name
 * while the previous deletion is still processing (error 2388023) — which createTemplate()
 * waits out, retrying for up to ~90 seconds.
 */
export async function replaceTemplate(
  name: string,
  language: string,
  input: CreateTemplateInput
): Promise<TemplateMutationResult> {
  const removed = await deleteTemplate(name, language)
  if (!removed.ok) return { ok: false, error: `Delete failed, nothing was changed: ${removed.error}` }

  const created = await createTemplate(input)
  if (!created.ok) {
    return {
      ok: false,
      error: `The old template was deleted but re-creating it failed: ${created.error} — re-create "${name}" (${language}) from this tab once Meta releases the name.`,
    }
  }
  return { ok: true, id: created.id, status: created.status ?? 'PENDING' }
}

/**
 * Delete a template by name (all its languages) or by name + language.
 * Meta-side only; it does not touch our database.
 */
export async function deleteTemplate(name: string, language?: string | null): Promise<TemplateMutationResult> {
  if (!isTemplateApiConfigured()) return { ok: false, error: 'Set WHATSAPP_TOKEN and WHATSAPP_WABA_ID first.' }
  try {
    const url = new URL(`${GRAPH_BASE()}/${process.env.WHATSAPP_WABA_ID}/message_templates`)
    url.searchParams.set('name', name)
    if (language) url.searchParams.set('language', language)
    const res = await fetch(url.toString(), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    })
    const data = (await res.json().catch(() => ({}))) as { success?: boolean } & GraphError
    if (!res.ok) return { ok: false, error: describeError(data, res.status) }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

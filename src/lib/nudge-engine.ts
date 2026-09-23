/**
 * Nudge engine: selects eligible leads, decides sequence position, sends (email or
 * whatsapp), logs. Shared sequence logic across channels: per-lead message history
 * decides first send, follow-up (after followUpDays), or skip
 * (replied / max reached / waiting / batch limit).
 */
import { randomUUID } from 'crypto'
import { db } from '@/lib/db'
import { searchAllLeads, mapZohoLead } from '@/lib/zoho'
import { sendEmail, isMailerConfigured } from '@/lib/mailer'
import { sendWhatsAppTemplate, sendWhatsAppText, isWhatsAppConfigured, normalizePhone, getDefaultTemplateLanguage } from '@/lib/whatsapp'
import { renderTemplate, injectTrackingPixel, htmlToText } from '@/lib/template'

export type Channel = 'email' | 'whatsapp'

export interface NudgeFilters {
  requireEmail?: boolean
  requirePhone?: boolean
  /** Only leads whose status is in this list are considered (exact match). */
  includeStatuses?: string[]
  excludeStatuses?: string[]
  businessVertical?: string
  maxKycCount?: number
  minKycCount?: number
  /**
   * Treat a NULL KYC_Document_Upload_Count as 0 ("nothing uploaded yet") rather than
   * "unknown". Default TRUE, matching the original n8n flow, which did
   * `count = (raw == null || raw === '') ? 0 : Number(raw)`.
   * Without this, a lead with no KYC value is silently excluded from the
   * documents-pending nudge, because NULL does not satisfy `<= n`.
   */
  treatNullKycAsZero?: boolean
  /**
   * Only message one lead per email address per run. Default TRUE — the CRM holds many
   * leads that share an email (re-imports, re-enquiries), and without this the same person
   * receives several copies of the same nudge in one run.
   */
  dedupeByEmail?: boolean
  createdAfter?: string // ISO date
}

export interface RunSkipped {
  lead: string
  email: string | null
  phone: string | null
  reason: string
  detail?: string
}

export interface RunSummary {
  nudgeKey: string
  channel: Channel
  syncedFromZoho: number | null
  leadsConsidered: number
  sent: number
  failed: number
  /** Leads left over because the per-run batch cap was reached. */
  deferred: number
  /** Per-run cap actually applied (null = unlimited). */
  batchLimit: number | null
  skipped: RunSkipped[]
  smtpConfigured: boolean
  whatsappConfigured: boolean
}

export function parseFilters(raw: string): NudgeFilters {
  try {
    const parsed = JSON.parse(raw || '{}')
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function buildWhere(filters: NudgeFilters, channel: Channel) {
  const where: Record<string, unknown> = {}
  // Conditions that need their own OR are collected here and AND-ed together, so a
  // KYC-null OR can coexist with the phone OR.
  const and: Record<string, unknown>[] = []

  if (channel === 'email') {
    if (filters.requireEmail !== false) where.email = { not: null }
  } else if (filters.requirePhone !== false) {
    and.push({ OR: [{ mobile: { not: null } }, { phone: { not: null } }] })
  }

  if (filters.includeStatuses?.length) {
    where.leadStatus = { in: filters.includeStatuses }
  } else if (filters.excludeStatuses?.length) {
    where.leadStatus = { notIn: filters.excludeStatuses }
  }
  if (filters.businessVertical) {
    where.businessVertical = filters.businessVertical
  }

  const kycRange: Record<string, number> = {}
  if (filters.maxKycCount !== undefined) kycRange.lte = filters.maxKycCount
  if (filters.minKycCount !== undefined) kycRange.gte = filters.minKycCount
  if (Object.keys(kycRange).length) {
    // A missing KYC value means "nothing uploaded yet" (default), so it counts as 0.
    const treatNullAsZero = filters.treatNullKycAsZero !== false
    const withinRange = { kycDocumentUploadCount: kycRange }
    if (treatNullAsZero && filters.minKycCount === undefined) {
      and.push({ OR: [withinRange, { kycDocumentUploadCount: null }] })
    } else {
      and.push(withinRange)
    }
  }

  if (filters.createdAfter) {
    const d = new Date(filters.createdAfter)
    if (!Number.isNaN(d.getTime())) where.createdTime = { gte: d }
  }

  if (and.length) where.AND = and
  return where
}

/** Leads matching the nudge's local filters. */
export async function selectEligibleLeads(nudgeId: string) {
  const nudge = await db.nudge.findUnique({ where: { id: nudgeId } })
  if (!nudge) throw new Error('Nudge not found')
  const filters = parseFilters(nudge.filters)
  return db.lead.findMany({
    where: buildWhere(filters, nudge.channel === 'whatsapp' ? 'whatsapp' : 'email'),
    orderBy: { createdAt: 'desc' },
  })
}

/** Upsert leads fetched from Zoho into the local DB. */
export async function syncLeadsFromCriteria(criteria: string): Promise<number> {
  const { leads } = await searchAllLeads(criteria)
  for (const z of leads) {
    const data = mapZohoLead(z)
    await db.lead.upsert({
      where: { zohoId: data.zohoId },
      create: data,
      update: { ...data },
    })
  }
  return leads.length
}

interface SendDecision {
  action: 'send' | 'skip'
  reason?: string
  detail?: string
  messageNumber?: number
}

function decideSend(
  logs: { sentOk: boolean; replied: boolean; sentAt: Date | null }[],
  maxEmailsPerLead: number,
  followUpDays: number,
  now: Date
): SendDecision {
  if (logs.some((l) => l.replied)) return { action: 'skip', reason: 'replied' }

  const sentOkLogs = logs.filter((l) => l.sentOk && l.sentAt)
  if (sentOkLogs.length >= maxEmailsPerLead) {
    return { action: 'skip', reason: 'max_reached', detail: `${sentOkLogs.length}/${maxEmailsPerLead} already sent` }
  }

  if (sentOkLogs.length > 0 && followUpDays > 0) {
    const lastSentAt = sentOkLogs
      .map((l) => l.sentAt as Date)
      .sort((a, b) => b.getTime() - a.getTime())[0]
    const nextEligibleAt = new Date(lastSentAt.getTime() + followUpDays * 24 * 60 * 60 * 1000)
    if (now < nextEligibleAt) {
      return {
        action: 'skip',
        reason: 'waiting_followup',
        detail: `next eligible ${nextEligibleAt.toISOString().slice(0, 16).replace('T', ' ')}`,
      }
    }
  }

  return { action: 'send', messageNumber: sentOkLogs.length + 1 }
}

function buildLeadVars(lead: {
  fullName: string | null
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  mobile: string | null
  company: string | null
  leadStatus: string | null
  kycDocumentUploadCount: number | null
  businessVertical: string | null
  city: string | null
  ownerName: string | null
}, messageNumber: number, now: Date) {
  return {
    full_name: lead.fullName,
    first_name: lead.firstName || lead.fullName,
    last_name: lead.lastName,
    email: lead.email,
    phone: lead.phone || lead.mobile,
    company: lead.company,
    lead_status: lead.leadStatus,
    kyc_document_upload_count: lead.kycDocumentUploadCount,
    business_vertical: lead.businessVertical,
    city: lead.city,
    owner_name: lead.ownerName,
    message_number: messageNumber,
    today: now.toISOString().slice(0, 10),
  }
}

/** Resolve the per-run cap: explicit option wins, then NUDGE_MAX_PER_RUN, else unlimited. */
function resolveBatchLimit(limit?: number): number | null {
  const raw = limit !== undefined ? limit : Number(process.env.NUDGE_MAX_PER_RUN || 0)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null
}

/**
 * Build positional WhatsApp template parameters.
 * Order is preserved even when a value is missing — dropping an empty value would
 * silently shift every later {{n}} into the wrong slot.
 */
function buildWhatsAppParams(config: string | null, vars: Record<string, unknown>): string[] {
  let sources: string[] = []
  try {
    const parsed = JSON.parse(config || '[]')
    if (Array.isArray(parsed)) sources = parsed.map((p) => String(p))
  } catch {
    // bad config -> send with no params; Meta will reject if the template needs them
  }
  const fallback = process.env.WHATSAPP_EMPTY_PARAM_FALLBACK ?? '-'
  return sources.map((key) => {
    const value = vars[key]
    if (value === null || value === undefined || value === '') return fallback
    return String(value)
  })
}

/** Run a nudge end-to-end. Set opts.sync=false to skip the Zoho refresh and send to already-synced leads. */
export async function runNudge(
  nudgeId: string,
  baseUrl: string,
  opts: { sync: boolean; limit?: number }
): Promise<RunSummary> {
  const nudge = await db.nudge.findUnique({ where: { id: nudgeId } })
  if (!nudge) throw new Error('Nudge not found')
  if (!nudge.enabled) throw new Error('Nudge is disabled')

  const channel: Channel = nudge.channel === 'whatsapp' ? 'whatsapp' : 'email'
  const filters = parseFilters(nudge.filters)
  const batchLimit = resolveBatchLimit(opts.limit)

  const summary: RunSummary = {
    nudgeKey: nudge.key,
    channel,
    syncedFromZoho: null,
    leadsConsidered: 0,
    sent: 0,
    failed: 0,
    deferred: 0,
    batchLimit,
    skipped: [],
    smtpConfigured: isMailerConfigured(),
    whatsappConfigured: isWhatsAppConfigured(),
  }

  // 1. Optional Zoho sync for this nudge's criteria
  if (opts.sync && nudge.zohoCriteria && nudge.zohoCriteria.trim()) {
    summary.syncedFromZoho = await syncLeadsFromCriteria(nudge.zohoCriteria.trim())
  }

  // 2. Select locally
  const leads = await db.lead.findMany({
    where: buildWhere(filters, channel),
    orderBy: { createdAt: 'desc' },
  })
  summary.leadsConsidered = leads.length

  const now = new Date()
  let attempts = 0
  // The CRM holds many leads sharing one email address, so without this the same person
  // receives several copies of the same nudge in a single run.
  const dedupe = filters.dedupeByEmail !== false
  const messagedContacts = new Set<string>()
  const contactKey = (lead: { email: string | null; phone: string | null; mobile: string | null }) =>
    channel === 'email'
      ? (lead.email || '').trim().toLowerCase()
      : normalizePhone(lead.mobile || lead.phone) || ''

  for (const lead of leads) {
    const logs = await db.messageLog.findMany({ where: { nudgeId: nudge.id, leadId: lead.id } })
    const decision = decideSend(logs, nudge.maxEmailsPerLead, nudge.followUpDays, now)

    if (decision.action === 'skip') {
      summary.skipped.push({
        lead: lead.fullName || lead.email || lead.zohoId,
        email: lead.email,
        phone: lead.phone || lead.mobile,
        reason: decision.reason!,
        detail: decision.detail,
      })
      continue
    }

    // 3. Respect the per-run cap so a single request can never run past its timeout.
    //    Deferred leads are picked up by the next cycle.
    if (batchLimit !== null && attempts >= batchLimit) {
      summary.deferred++
      summary.skipped.push({
        lead: lead.fullName || lead.email || lead.zohoId,
        email: lead.email,
        phone: lead.phone || lead.mobile,
        reason: 'batch_limit',
        detail: `cap ${batchLimit}/run — continues next cycle`,
      })
      continue
    }

    const key = dedupe ? contactKey(lead) : ''
    if (key) {
      if (messagedContacts.has(key)) {
        summary.skipped.push({
          lead: lead.fullName || lead.email || lead.zohoId,
          email: lead.email,
          phone: lead.phone || lead.mobile,
          reason: 'duplicate_contact',
          detail: 'same email address already messaged in this run',
        })
        continue
      }
      messagedContacts.add(key)
    }

    const messageNumber = decision.messageNumber ?? 1
    const vars = buildLeadVars(lead, messageNumber, now)

    if (channel === 'whatsapp') {
      const rawPhone = lead.mobile || lead.phone
      const toPhone = normalizePhone(rawPhone)
      if (!toPhone) {
        summary.skipped.push({
          lead: lead.fullName || lead.zohoId,
          email: lead.email,
          phone: rawPhone,
          reason: 'no_valid_phone',
        })
        continue
      }

      attempts++
      // With a template name configured we send the approved template (required for
      // business-initiated messages). Without one we send free-form text, which Meta
      // allows inside the 24h customer service window or to a registered test number —
      // useful for verifying the integration before a template is approved.
      const templateName = (nudge.whatsappTemplateName || '').trim()
      const result = templateName
        ? await sendWhatsAppTemplate({
            to: toPhone,
            templateName,
            language: nudge.whatsappLanguage || getDefaultTemplateLanguage(),
            params: buildWhatsAppParams(nudge.whatsappParams, vars),
          })
        : await sendWhatsAppText({
            to: toPhone,
            text: renderTemplate(nudge.bodyTemplate || '', vars),
          })

      await db.messageLog.create({
        data: {
          leadId: lead.id,
          nudgeId: nudge.id,
          channel: 'whatsapp',
          messageNumber,
          toPhone,
          templateName: nudge.whatsappTemplateName,
          messageId: result.waMessageId ?? null,
          trackingId: randomUUID(),
          sentOk: result.ok,
          sendError: result.error ?? null,
          sentAt: result.ok ? new Date() : null,
          engagementStatus: 'sent',
        },
      })

      if (result.ok) summary.sent++
      else summary.failed++
    } else {
      if (!lead.email) {
        summary.skipped.push({ lead: lead.fullName || lead.zohoId, email: null, phone: lead.phone, reason: 'no_email' })
        continue
      }

      attempts++
      const trackingId = randomUUID()
      const subject = renderTemplate(nudge.subjectTemplate || '', vars)
      // escape substituted values: lead data must not inject markup into the email body
      const bodyHtml = injectTrackingPixel(
        renderTemplate(nudge.bodyTemplate || '', vars, { escapeValues: true }),
        baseUrl,
        trackingId
      )

      const result = await sendEmail({ to: lead.email, subject, html: bodyHtml, text: htmlToText(bodyHtml) })

      await db.messageLog.create({
        data: {
          leadId: lead.id,
          nudgeId: nudge.id,
          channel: 'email',
          messageNumber,
          toEmail: lead.email,
          subject,
          messageId: result.messageId ?? null,
          trackingId,
          sentOk: result.ok,
          sendError: result.error ?? null,
          sentAt: result.ok ? new Date() : null,
          engagementStatus: 'sent',
        },
      })

      if (result.ok) summary.sent++
      else summary.failed++
    }

    // small delay to stay API/SMTP-friendly
    await new Promise((r) => setTimeout(r, 250))
  }

  await db.nudge.update({ where: { id: nudge.id }, data: { lastRunAt: new Date() } })
  return summary
}

/** Preview who would be considered + what would happen, without sending. */
export async function previewNudge(nudgeId: string) {
  const nudge = await db.nudge.findUnique({ where: { id: nudgeId } })
  if (!nudge) throw new Error('Nudge not found')
  const channel: Channel = nudge.channel === 'whatsapp' ? 'whatsapp' : 'email'
  const filters = parseFilters(nudge.filters)
  const leads = await db.lead.findMany({
    where: buildWhere(filters, channel),
    orderBy: { createdAt: 'desc' },
  })
  const now = new Date()

  const wouldSend: { lead: string; email: string | null; phone: string | null; messageNumber: number }[] = []
  const wouldSkip: RunSkipped[] = []
  const dedupe = filters.dedupeByEmail !== false
  const seenContacts = new Set<string>()
  const contactKey = (lead: { email: string | null; phone: string | null; mobile: string | null }) =>
    channel === 'email'
      ? (lead.email || '').trim().toLowerCase()
      : normalizePhone(lead.mobile || lead.phone) || ''

  for (const lead of leads) {
    const logs = await db.messageLog.findMany({ where: { nudgeId: nudge.id, leadId: lead.id } })
    const decision = decideSend(logs, nudge.maxEmailsPerLead, nudge.followUpDays, now)

    if (decision.action === 'send') {
      // mirror the run-time phone validation so preview never promises an undeliverable send
      if (channel === 'whatsapp' && !normalizePhone(lead.mobile || lead.phone)) {
        wouldSkip.push({
          lead: lead.fullName || lead.zohoId,
          email: lead.email,
          phone: lead.phone || lead.mobile,
          reason: 'no_valid_phone',
        })
        continue
      }
      const key = dedupe ? contactKey(lead) : ''
      if (key && seenContacts.has(key)) {
        wouldSkip.push({
          lead: lead.fullName || lead.email || lead.zohoId,
          email: lead.email,
          phone: lead.phone || lead.mobile,
          reason: 'duplicate_contact',
          detail: 'same email address already targeted in this run',
        })
        continue
      }
      if (key) seenContacts.add(key)
      wouldSend.push({
        lead: lead.fullName || lead.email || lead.zohoId,
        email: lead.email,
        phone: lead.phone || lead.mobile,
        messageNumber: decision.messageNumber ?? 1,
      })
    } else {
      wouldSkip.push({
        lead: lead.fullName || lead.email || lead.zohoId,
        email: lead.email,
        phone: lead.phone || lead.mobile,
        reason: decision.reason!,
        detail: decision.detail,
      })
    }
  }

  return {
    nudgeKey: nudge.key,
    channel,
    leadsConsidered: leads.length,
    wouldSend,
    wouldSkip,
    smtpConfigured: isMailerConfigured(),
    whatsappConfigured: isWhatsAppConfigured(),
    batchLimit: resolveBatchLimit(),
  }
}

/**
 * Nudge engine: selects eligible leads, decides sequence position, sends, logs.
 * Mirrors the n8n/Sheets logic: per-lead email history decides whether to send the
 * first email, a follow-up (after followUpDays), or skip (replied / max reached / waiting).
 */
import { randomUUID } from 'crypto'
import { db } from '@/lib/db'
import { searchAllLeads, mapZohoLead } from '@/lib/zoho'
import { sendEmail, isMailerConfigured } from '@/lib/mailer'
import { renderTemplate, injectTrackingPixel, htmlToText } from '@/lib/template'

export interface NudgeFilters {
  requireEmail?: boolean
  excludeStatuses?: string[]
  businessVertical?: string
  maxKycCount?: number
  minKycCount?: number
  createdAfter?: string // ISO date
}

export interface RunSkipped {
  lead: string
  email: string | null
  reason: string
  detail?: string
}

export interface RunSummary {
  nudgeKey: string
  syncedFromZoho: number | null
  leadsConsidered: number
  sent: number
  failed: number
  skipped: RunSkipped[]
  smtpConfigured: boolean
}

export function parseFilters(raw: string): NudgeFilters {
  try {
    const parsed = JSON.parse(raw || '{}')
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function buildWhere(filters: NudgeFilters) {
  const where: Record<string, unknown> = {}
  if (filters.requireEmail !== false) {
    where.email = { not: null }
  }
  if (filters.excludeStatuses?.length) {
    where.leadStatus = { notIn: filters.excludeStatuses }
  }
  if (filters.businessVertical) {
    where.businessVertical = filters.businessVertical
  }
  if (filters.maxKycCount !== undefined) {
    where.kycDocumentUploadCount = { ...(where.kycDocumentUploadCount as object), lte: filters.maxKycCount }
  }
  if (filters.minKycCount !== undefined) {
    where.kycDocumentUploadCount = { ...(where.kycDocumentUploadCount as object), gte: filters.minKycCount }
  }
  if (filters.createdAfter) {
    const d = new Date(filters.createdAfter)
    if (!Number.isNaN(d.getTime())) {
      where.createdTime = { ...(where.createdTime as object), gte: d }
    }
  }
  return where
}

/** Leads matching the nudge's local filters. */
export async function selectEligibleLeads(nudgeId: string) {
  const nudge = await db.nudge.findUnique({ where: { id: nudgeId } })
  if (!nudge) throw new Error('Nudge not found')
  const filters = parseFilters(nudge.filters)
  return db.lead.findMany({ where: buildWhere(filters), orderBy: { createdAt: 'desc' } })
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
  emailNumber?: number
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

  return { action: 'send', emailNumber: sentOkLogs.length + 1 }
}

/** Run a nudge end-to-end. Set opts.sync=false to skip the Zoho refresh and send to already-synced leads. */
export async function runNudge(nudgeId: string, baseUrl: string, opts: { sync: boolean }): Promise<RunSummary> {
  const nudge = await db.nudge.findUnique({ where: { id: nudgeId } })
  if (!nudge) throw new Error('Nudge not found')
  if (!nudge.enabled) throw new Error('Nudge is disabled')

  const filters = parseFilters(nudge.filters)
  const smtpConfigured = isMailerConfigured()

  // 1. Optional Zoho sync for this nudge's criteria
  let syncedFromZoho: number | null = null
  if (opts.sync && nudge.zohoCriteria && nudge.zohoCriteria.trim()) {
    syncedFromZoho = await syncLeadsFromCriteria(nudge.zohoCriteria.trim())
  }

  // 2. Select locally
  const leads = await db.lead.findMany({ where: buildWhere(filters), orderBy: { createdAt: 'desc' } })

  const summary: RunSummary = {
    nudgeKey: nudge.key,
    syncedFromZoho,
    leadsConsidered: leads.length,
    sent: 0,
    failed: 0,
    skipped: [],
    smtpConfigured,
  }

  const now = new Date()

  for (const lead of leads) {
    const logs = await db.emailLog.findMany({ where: { nudgeId: nudge.id, leadId: lead.id } })
    const decision = decideSend(logs, nudge.maxEmailsPerLead, nudge.followUpDays, now)

    if (decision.action === 'skip') {
      summary.skipped.push({
        lead: lead.fullName || lead.email || lead.zohoId,
        email: lead.email,
        reason: decision.reason!,
        detail: decision.detail,
      })
      continue
    }

    if (!lead.email) {
      summary.skipped.push({ lead: lead.fullName || lead.zohoId, email: null, reason: 'no_email' })
      continue
    }

    const trackingId = randomUUID()
    const emailNumber = decision.emailNumber ?? 1
    const vars = {
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
      email_number: emailNumber,
      today: now.toISOString().slice(0, 10),
    }

    const subject = renderTemplate(nudge.subjectTemplate, vars)
    const bodyHtml = injectTrackingPixel(renderTemplate(nudge.bodyTemplate, vars), baseUrl, trackingId)

    const result = await sendEmail({ to: lead.email, subject, html: bodyHtml, text: htmlToText(bodyHtml) })

    await db.emailLog.create({
      data: {
        leadId: lead.id,
        nudgeId: nudge.id,
        emailNumber,
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

    // small delay to stay SMTP-friendly
    await new Promise((r) => setTimeout(r, 250))
  }

  await db.nudge.update({ where: { id: nudge.id }, data: { lastRunAt: new Date() } })
  return summary
}

/** Preview who would be considered + what would happen, without sending. */
export async function previewNudge(nudgeId: string) {
  const nudge = await db.nudge.findUnique({ where: { id: nudgeId } })
  if (!nudge) throw new Error('Nudge not found')
  const filters = parseFilters(nudge.filters)
  const leads = await db.lead.findMany({ where: buildWhere(filters), orderBy: { createdAt: 'desc' } })
  const now = new Date()

  const wouldSend: { lead: string; email: string | null; emailNumber: number }[] = []
  const wouldSkip: RunSkipped[] = []

  for (const lead of leads) {
    const logs = await db.emailLog.findMany({ where: { nudgeId: nudge.id, leadId: lead.id } })
    const decision = decideSend(logs, nudge.maxEmailsPerLead, nudge.followUpDays, now)
    if (decision.action === 'send') {
      wouldSend.push({
        lead: lead.fullName || lead.email || lead.zohoId,
        email: lead.email,
        emailNumber: decision.emailNumber ?? 1,
      })
    } else {
      wouldSkip.push({
        lead: lead.fullName || lead.email || lead.zohoId,
        email: lead.email,
        reason: decision.reason!,
        detail: decision.detail,
      })
    }
  }

  return {
    nudgeKey: nudge.key,
    leadsConsidered: leads.length,
    wouldSend,
    wouldSkip,
    smtpConfigured: isMailerConfigured(),
  }
}

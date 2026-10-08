/**
 * Nudge engine: selects eligible leads, decides sequence position, sends (email or
 * whatsapp), logs. Shared sequence logic across channels: per-lead message history
 * decides first send, follow-up (after followUpDays), or skip
 * (replied / max reached / waiting / batch limit).
 */
import { randomUUID } from 'crypto'
import { db } from '@/lib/db'
import { searchAllLeads, mapZohoLead, LEAD_FIELDS } from '@/lib/zoho'
import {
  callZohoMcpTool,
  buildLeadsToolArgs,
  extractRecords,
  extractPagingInfo,
  isZohoMcpConfigured,
  listZohoMcpTools,
  pickLeadsTool,
  withPage,
} from '@/lib/zoho-mcp'
import { sendEmail, isMailerConfigured } from '@/lib/mailer'
import { sendWhatsAppTemplate, sendWhatsAppText, isWhatsAppConfigured, normalizePhone, getDefaultTemplateLanguage } from '@/lib/whatsapp'
import { renderTemplate, injectTrackingPixel, htmlToText } from '@/lib/template'
import { collectMysqlRecipients, isMysqlFlowKey } from '@/lib/mysql-nudges'
import { buildWhatsAppParams } from '@/lib/whatsapp-params'
import { isDeliveryCapError, capBackoffHours } from '@/lib/whatsapp-errors'
import { decideSend, type SendDecision, type SequenceLog } from '@/lib/sequence'
import { ctaSendParams } from '@/lib/cta'
import { ctaDestinationFor, expandZohoCriteria, zohoIstIso } from '@/lib/nudge-defaults'
import { MCP_SEARCH_LIMIT, monthWindows, withCreatedWindow } from '@/lib/zoho-chunk'
import { runGuard } from '@/lib/nudge-kind'
import { upsertLeadWithJourney } from '@/lib/journey-sync'
import { recalculateScores } from '@/lib/score-leads'
import { splitByKycMatch, type KycCounts } from '@/lib/kyc-match'
import type { Lead, Nudge } from '@prisma/client'

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
  /**
   * Only leads whose KYC upload count EQUALS their expected count — "all documents submitted".
   *
   * Note this is NOT enforced by buildWhere(): it compares two columns of the same row, which
   * Prisma cannot express, so it is applied as a post-query predicate by every caller. See
   * src/lib/kyc-match.ts for why a null/zero expected count must never count as a match.
   */
  kycMatchesExpected?: boolean
  /** Compare two columns of the same row: applied post-query, not in buildWhere. */
  kycCountRule?: 'equals' | 'less_than'
  /** Legacy spelling for `kycCountRule: 'equals'`. */
  kycCountRuleLegacy?: boolean

  // --- fields the sandbox nudges filter on -----------------------------------
  /**
   * Whether the lead has an Eko Code. `false` means "must be missing".
   *
   * Needed locally because the Zoho criteria only decides what gets FETCHED; the nudge selects from
   * the local table, and without this an "old website lead" nudge would fall back to every synced
   * lead. `undefined` leaves the field alone.
   */
  ekoCodePresent?: boolean
  /** `true` = must have NO email. Distinct from requireEmail, which applies to the email channel. */
  emailMissing?: boolean
  /**
   * The exact value Zoho's Sign_Agreement must have. NULL never matches either value — a lead whose
   * field we were never told about is not "unsigned".
   */
  signAgreement?: boolean
  /** KYC_Documents_Upload must be one of these, e.g. ['Accepted'] or ['All Done']. */
  kycUploadStatus?: string[]
  /**
   * Only leads created within the last N days. Dynamic on purpose: a stored ISO date would age, so
   * "not older than two months" would quietly become "not older than two months from whenever this
   * was configured".
   */
  createdWithinDays?: number
  /** Groups nudges in the UI. No schema change — it rides in the existing filters JSON. */
  category?: string
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
  /** Which Zoho path did the sync: 'mcp' (preferred) or 'api' (fallback). Null when no sync ran. */
  syncedVia?: 'mcp' | 'api' | null
  /**
   * True when this run happened on a DISABLED nudge via an explicit one-click force. Surfaced so
   * "how did messages go out from a nudge that is off?" always has an answer.
   */
  forced?: boolean
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

  // kycMatchesExpected deliberately has no clause here: it compares the row's OWN two count
  // columns, which is not expressible in a Prisma where. It is applied in memory (see
  // applyRowPredicates) so that runNudge, previewNudge and the CRM webhook agree exactly.

  // --- sandbox-nudge fields ---------------------------------------------------
  if (filters.ekoCodePresent === true) and.push({ ekoCode: { not: null } })
  else if (filters.ekoCodePresent === false) {
    // An empty string is "no code" just as much as NULL — a blank cell in the CRM is not a code.
    and.push({ OR: [{ ekoCode: null }, { ekoCode: '' }] })
  }
  if (filters.emailMissing === true) and.push({ OR: [{ email: null }, { email: '' }] })
  // Exact boolean match. `signAgreement: false` does NOT match NULL, which is the point: a lead
  // whose field we were never told about must not be treated as unsigned.
  if (typeof filters.signAgreement === 'boolean') where.signAgreement = filters.signAgreement
  if (filters.kycUploadStatus?.length) {
    where.kycDocumentsUploadStatus = { in: filters.kycUploadStatus }
  }
  if (typeof filters.createdWithinDays === 'number' && filters.createdWithinDays > 0) {
    const since = new Date(Date.now() - filters.createdWithinDays * 24 * 60 * 60 * 1000)
    where.createdTime = { gte: since }
  }

  if (filters.createdAfter) {
    const d = new Date(filters.createdAfter)
    if (!Number.isNaN(d.getTime())) where.createdTime = { gte: d }
  }

  if (and.length) where.AND = and
  return where
}

/**
 * Filters that compare two columns of the same row, applied after the query.
 *
 * The only one today is kycMatchesExpected ("all documents submitted"). Prisma cannot express
 * `colA = colB`, so it has to run in memory — but it must not become a second, divergent source of
 * truth about who is eligible. The implementation lives in kyc-match.ts, beside the rule, and
 * runNudge, previewNudge and the CRM webhook all call THIS wrapper.
 */
function applyRowPredicates<T extends KycCounts>(
  leads: T[],
  filters: NudgeFilters
): { kept: T[]; rejected: { lead: T; reason: string }[] } {
  return splitByKycMatch(leads, filters)
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

/**
 * Upsert leads fetched from Zoho into the local DB.
 *
 * Goes through upsertLeadWithJourney() rather than a plain upsert so V2 can see the PREVIOUS status
 * and record a stage transition — an upsert discards it. Both sync paths share this so the journey
 * is identical whichever Zoho route did the reading.
 */
export async function syncLeadsFromCriteria(criteria: string): Promise<number> {
  const { leads } = await searchAllLeads(criteria)
  let changed = 0
  const touched: string[] = []
  for (const z of leads) {
    const outcome = await upsertLeadWithJourney(mapZohoLead(z))
    touched.push(outcome.leadId)
    if (outcome.changed) changed++
  }
  if (changed) console.log(`[journey] ${changed} stage change(s) detected in this sync`)
  // V2: scores are recalculated on every sync run, for exactly the leads this sync touched.
  if (touched.length) await recalculateScores({ leadIds: touched })
  return leads.length
}

export interface McpSyncResult {
  count: number
  tool: string
  args: Record<string, unknown>
  recordsRead: number
  pages: number
  /** True when the last page still had `more_records`, so the result is partial. */
  truncated: boolean
}

/**
 * The same upsert, but read through the Zoho CRM MCP server instead of the REST API.
 *
 * Paginates: Zoho caps a search page at 200 records and reports `info.more_records`, so a
 * single call would silently return only the first 200 of ~330 leads. The loop is bounded
 * and reports `truncated` when the guard is hit rather than pretending it finished.
 */
export async function syncLeadsViaMcp(criteria: string): Promise<McpSyncResult> {
  const tools = await listZohoMcpTools()
  const tool = pickLeadsTool(tools)
  if (!tool) {
    throw new Error(
      `No Leads-reading tool found on the Zoho MCP server (it exposes ${tools.length} tool(s): ` +
        `${tools.map((t) => t.name).join(', ') || 'none'}). ` +
        'Pin the right one with ZOHO_MCP_LEADS_TOOL.'
    )
  }

  // Shared upsert: journey-aware so a stage change is recorded whichever route read the lead, and
  // batched scoring at the end rather than per lead.
  const touched: string[] = []
  let stageChanges = 0
  const upsert = async (data: ReturnType<typeof mapZohoLead>) => {
    const outcome = await upsertLeadWithJourney(data)
    touched.push(outcome.leadId)
    if (outcome.changed) stageChanges++
    return outcome.changed
  }

  const chunked = await syncLeadsViaMcpChunked(criteria, upsert)

  if (stageChanges) console.log(`[journey] ${stageChanges} stage change(s) detected in this sync`)
  if (touched.length) await recalculateScores({ leadIds: touched })

  return {
    count: chunked.count,
    tool: tool.name,
    args: buildLeadsToolArgs(tool, criteria, LEAD_FIELDS),
    recordsRead: chunked.count,
    pages: chunked.windows,
    // A window that failed means the sync is genuinely partial, and says so.
    truncated: chunked.failedWindows.length > 0,
  }
}

/** How many records a criteria matches, via the MCP count tool (cheap: no records transferred). */
export async function mcpRecordCount(criteria: string): Promise<number | null> {
  try {
    const res = await callZohoMcpTool('ZohoCRM_getRecordCount', {
      // `moduleApiName`, NOT `module` — with the wrong name the tool returns ok=true and an error
      // string inside the payload, which reads like success.
      path_variables: { moduleApiName: 'Leads' },
      query_params: { criteria },
    })
    if (!res.ok) return null
    const raw = JSON.stringify(res.json ?? res.text)
    const n = raw.match(/"count"\s*:\s*(\d+)/)?.[1]
    return n ? Number(n) : null
  } catch {
    return null
  }
}

/**
 * Read a criteria that may exceed Zoho's per-search cap, by splitting it into month windows.
 *
 * A criteria at or under the cap takes the ordinary path, so nothing changes for the flows that
 * already work. Over it, the search is repeated per month with the window ANDed on, and the totals
 * are summed. One failing window is reported rather than aborting the rest — a partial sync is far
 * more useful than none, and `failedWindows` says exactly what is missing.
 */
async function syncLeadsViaMcpChunked(
  criteria: string,
  upsert: (data: ReturnType<typeof mapZohoLead>) => Promise<boolean>
): Promise<{ count: number; windows: number; failedWindows: string[] }> {
  const total = await mcpRecordCount(criteria)
  if (total === null || total <= MCP_SEARCH_LIMIT) {
    // Unknown count: try it in one go rather than refusing to sync.
    const res = await syncLeadsViaMcpInto(criteria, upsert)
    return { count: res.count, windows: 1, failedWindows: [] }
  }

  // The earliest matching lead decides where the windows start.
  const tools = await listZohoMcpTools()
  const tool = pickLeadsTool(tools)
  if (!tool) throw new Error('No Leads-reading tool found on the Zoho MCP server.')
  const baseArgs = buildLeadsToolArgs(tool, criteria, LEAD_FIELDS)
  const first = await callZohoMcpTool(tool.name, {
    ...baseArgs,
    query_params: { ...(baseArgs.query_params as Record<string, unknown>), sort_by: 'Created_Time', sort_order: 'asc' },
  })
  const firstRecord = first.ok ? extractRecords(first.json ?? first.text)[0] : undefined
  const earliest = firstRecord?.Created_Time ? new Date(String(firstRecord.Created_Time)) : null
  if (!earliest || Number.isNaN(earliest.getTime())) {
    throw new Error(
      `Criteria matches ${total} leads, over Zoho's ${MCP_SEARCH_LIMIT}-record search limit, and the ` +
        `earliest Created_Time could not be read to split it into windows.`
    )
  }

  const windows = monthWindows({ year: earliest.getUTCFullYear(), monthIndex: earliest.getUTCMonth() }, new Date())
  console.log(
    `[sync] criteria matches ${total} leads — over Zoho's ${MCP_SEARCH_LIMIT} search limit; ` +
      `reading it in ${windows.length} monthly window(s) from ${earliest.toISOString().slice(0, 10)}`
  )

  let count = 0
  const failedWindows: string[] = []
  for (const w of windows) {
    try {
      const res = await syncLeadsViaMcpInto(withCreatedWindow(criteria, w.from, w.to), upsert)
      count += res.count
    } catch (err) {
      const label = `${w.from.toISOString().slice(0, 10)}…${w.to.toISOString().slice(0, 10)}`
      failedWindows.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
      console.error(`[sync] window ${label} failed:`, err instanceof Error ? err.message : err)
    }
  }
  return { count, windows: windows.length, failedWindows }
}

/** Page guard for ONE search: 25 × 200 = 5000, above Zoho's 2000 ceiling so it is never the limit. */
const MAX_MCP_PAGES = 25

/** The inner single-search pagination, shared by the plain and chunked paths. */
async function syncLeadsViaMcpInto(
  criteria: string,
  upsert: (data: ReturnType<typeof mapZohoLead>) => Promise<boolean>
): Promise<{ count: number }> {
  const tools = await listZohoMcpTools()
  const tool = pickLeadsTool(tools)
  if (!tool) throw new Error('No Leads-reading tool found on the Zoho MCP server.')
  const baseArgs = buildLeadsToolArgs(tool, criteria, LEAD_FIELDS)

  let count = 0
  for (let page = 1; page <= MAX_MCP_PAGES; page++) {
    const result = await callZohoMcpTool(tool.name, page === 1 ? baseArgs : withPage(baseArgs, page))
    if (!result.ok) {
      throw new Error(`MCP tool "${tool.name}" failed: ${result.error || result.text || 'no detail'}`)
    }
    const records = extractRecords(result.json ?? result.text)
    for (const record of records) {
      const data = mapZohoLead(record as Parameters<typeof mapZohoLead>[0])
      if (!data.zohoId) continue
      await upsert(data)
      count++
    }
    const paging = extractPagingInfo(result.json ?? result.text)
    if (!paging.moreRecords || records.length === 0) break
  }
  return { count }
}

export interface SyncOutcome {
  synced: number
  /** Which data path actually did the work. */
  via: 'mcp' | 'api'
  /** Set when MCP was preferred but the REST API had to cover for it. */
  fellBack?: string
  tool?: string
  pages?: number
  truncated?: boolean
}

/**
 * Sync preferring MCP, falling back to the REST API.
 *
 * The MCP path is chosen when the app is connected, so CRM reads go through the MCP server
 * as intended. But a previously working sync must not break because the MCP tool list
 * changed shape, so any MCP failure falls through to the REST path and the reason is
 * reported rather than swallowed.
 */
export async function syncLeads(criteria: string, opts: { via?: 'mcp' | 'api' | 'auto' } = {}): Promise<SyncOutcome> {
  const via = opts.via ?? 'auto'

  if (via !== 'api' && isZohoMcpConfigured()) {
    try {
      const result = await syncLeadsViaMcp(criteria)
      return {
        synced: result.count,
        via: 'mcp',
        tool: result.tool,
        pages: result.pages,
        truncated: result.truncated,
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      if (via === 'mcp') throw err
      const synced = await syncLeadsFromCriteria(criteria)
      return { synced, via: 'api', fellBack: reason }
    }
  }

  const synced = await syncLeadsFromCriteria(criteria)
  return { synced, via: 'api' }
}

/**
 * The sequence rule now lives in src/lib/sequence.ts, which has no database imports so the verify
 * script can test the cadences directly. Re-exported under the public name the webhook uses.
 */
export const sequenceDecision = decideSend

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
  kycDocumentsExpectedCount: number | null
  ekoCode: string | null
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
    kyc_documents_expected_count: lead.kycDocumentsExpectedCount,
    // Needed by the sandbox sign-agreement template, which names the code in its body ("your Eko
    // Code {{2}} is ready"). Without it the parameter falls back to "-" and the message tells the
    // customer their code is a dash.
    eko_code: lead.ekoCode,
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

/** Outcome of delivering one already-decided message. */
export interface DeliveryResult {
  /** Set when nothing was sent and why — the caller turns this into a skip entry. */
  skipped?: 'no_valid_phone' | 'no_email'
  /** Present only when a send was attempted. */
  attempted?: boolean
  ok?: boolean
  error?: string | null
  trackingId?: string
  templateName?: string | null
  toPhone?: string | null
  toEmail?: string | null
}

/**
 * Deliver ONE already-decided message for one lead, and log it.
 *
 * Extracted so that every entry point uses the SAME implementation: runNudge (batch/run),
 * the CRM webhook (single lead), and anything added later. A second copy of this logic is how
 * a webhook-triggered send ends up rendering different parameters, storing a different
 * trackingId or skipping the CTA destination — the message still goes out, so nothing looks
 * broken, but the click can no longer be attributed to anyone.
 *
 * The caller is responsible for the sequence decision (decideSend) and the per-run caps; this
 * function only sends and records. It does NOT throw on a delivery failure — it returns ok:false
 * and the failure is logged, because a webhook must answer the CRM rather than 500.
 */
export async function deliverToLead(opts: {
  nudge: Nudge
  lead: Lead
  messageNumber: number
  baseUrl: string
  now?: Date
}): Promise<DeliveryResult> {
  const { nudge, lead, messageNumber, baseUrl } = opts
  const now = opts.now ?? new Date()
  const channel: Channel = nudge.channel === 'whatsapp' ? 'whatsapp' : 'email'
  const vars = buildLeadVars(lead, messageNumber, now)

  if (channel === 'whatsapp') {
    const rawPhone = lead.mobile || lead.phone
    const toPhone = normalizePhone(rawPhone)
    if (!toPhone) return { skipped: 'no_valid_phone' }

    // With a template name configured we send the approved template (required for
    // business-initiated messages). Without one we send free-form text, which Meta
    // allows inside the 24h customer service window or to a registered test number —
    // useful for verifying the integration before a template is approved.
    const templateName = (nudge.whatsappTemplateName || '').trim()
    const trackingId = randomUUID()
    const mobileDigits = buttonMobile(rawPhone)
    const waParams = buildWhatsAppParams(nudge.whatsappParams, vars)
    const { buttonParams, ctaUrl, fallback: templateFallback } = ctaSendParams({
      templateName,
      destination: ctaDestinationFor(templateName, mobileDigits),
      trackingId,
      mobileDigits,
      configured: waParams.button,
    })
    const result = templateName
      ? await sendWhatsAppTemplate({
          to: toPhone,
          templateName,
          language: nudge.whatsappLanguage || getDefaultTemplateLanguage(),
          params: waParams.body,
          buttonParams,
          fallback: templateFallback,
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
        // Record the template that ACTUALLY went out: a tracked template that Meta has not
        // approved falls back to its base, and the log must not then claim attribution it lost.
        templateName: result.usedFallbackTemplate ?? nudge.whatsappTemplateName,
        messageId: result.waMessageId ?? null,
        trackingId,
        ctaUrl,
        sentOk: result.ok,
        sendError: result.error ?? null,
        sentAt: result.ok ? new Date() : null,
        engagementStatus: 'sent',
      },
    })

    return {
      attempted: true,
      ok: result.ok,
      error: result.error ?? null,
      trackingId,
      templateName: result.usedFallbackTemplate ?? nudge.whatsappTemplateName,
      toPhone,
      toEmail: lead.email,
    }
  }

  if (!lead.email) return { skipped: 'no_email' }

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

  return {
    attempted: true,
    ok: result.ok,
    error: result.error ?? null,
    trackingId,
    toEmail: lead.email,
  }
}

/**
 * Build positional WhatsApp template parameters.
 * Order is preserved even when a value is missing — dropping an empty value would
 * silently shift every later {{n}} into the wrong slot.
 */
/** What drives a nudge's audience. Encoded in existing fields, so no schema change. */
export type NudgeSource = 'zoho' | 'mysql' | 'sheet'

export function nudgeSource(nudge: { zohoCriteria: string | null; filters: string }): NudgeSource {
  const f = parseFilters(nudge.filters) as { source?: string }
  if (f.source === 'mysql') return 'mysql'
  if (nudge.zohoCriteria && nudge.zohoCriteria.trim()) return 'zoho'
  return 'sheet'
}

/** Local 10-digit form used in the template's URL button, e.g. 919876543210 -> 9876543210. */
function buttonMobile(raw: string | null): string {
  const full = normalizePhone(raw)
  if (!full) return ''
  const cc = process.env.WHATSAPP_DEFAULT_CC || '91'
  return full.startsWith(cc) ? full.slice(cc.length) : full
}

/**
 * Run a MySQL-driven WhatsApp nudge.
 *
 * Recipients come from the business database via a read-only query. Sequence state is keyed
 * on the phone number (MessageLog.toPhone) rather than a Lead row, so the same
 * replied / max-reached / follow-up rules apply and a recipient is never messaged twice for
 * the same nudge.
 */
async function runMysqlNudge(nudge: Nudge, summary: RunSummary, batchLimit: number | null): Promise<RunSummary> {
  const filters = parseFilters(nudge.filters) as { flow?: string; lookbackHours?: number; lookbackDays?: number }
  if (!isMysqlFlowKey(filters.flow)) {
    throw new Error(
      `Nudge "${nudge.key}" is marked source=mysql but filters.flow is missing or invalid. Expected one of the known flow keys.`
    )
  }
  if (summary.channel !== 'whatsapp') {
    throw new Error(`MySQL-driven nudge "${nudge.key}" must use the whatsapp channel.`)
  }

  const recipients = await collectMysqlRecipients(filters.flow, {
    lookbackHours: filters.lookbackHours,
    lookbackDays: filters.lookbackDays,
  })
  summary.leadsConsidered = recipients.length

  const templateName = (nudge.whatsappTemplateName || '').trim()
  const now = new Date()
  let attempts = 0

  for (const recipient of recipients) {
    const toPhone = normalizePhone(recipient.phone)
    const label = recipient.key

    if (!toPhone) {
      summary.skipped.push({ lead: label, email: null, phone: recipient.phone, reason: 'no_valid_phone', detail: recipient.detail })
      continue
    }

    const logs = await db.messageLog.findMany({ where: { nudgeId: nudge.id, toPhone } })
    const decision = decideSend(logs, nudge.maxEmailsPerLead, nudge.followUpDays, now)
    if (decision.action === 'skip') {
      summary.skipped.push({ lead: label, email: null, phone: toPhone, reason: decision.reason!, detail: decision.detail })
      continue
    }

    if (batchLimit !== null && attempts >= batchLimit) {
      summary.deferred++
      summary.skipped.push({
        lead: label,
        email: null,
        phone: toPhone,
        reason: 'batch_limit',
        detail: `cap ${batchLimit}/run — continues next cycle`,
      })
      continue
    }

    attempts++
    const messageNumber = decision.messageNumber ?? 1
    const fallback = process.env.WHATSAPP_EMPTY_PARAM_FALLBACK ?? '-'
    const mobile = buttonMobile(recipient.phone)

    // Body params come from the flow's own values (e.g. the document list for E/F);
    // the button param comes from the nudge config, defaulting to this recipient's mobile.
    const cfg = buildWhatsAppParams(nudge.whatsappParams, {
      mobile,
      mobile_digits: mobile,
      key: recipient.key,
      detail: recipient.detail ?? '',
    })
    const bodyParams = recipient.params.length
      ? recipient.params.map((v) => (v === null || v === undefined || v === '' ? fallback : String(v)))
      : cfg.body
    const configuredButton = cfg.button.length ? cfg.button : mobile ? [mobile] : []

    const trackingId = randomUUID()
    const { buttonParams, ctaUrl, fallback: templateFallback } = ctaSendParams({
      templateName,
      destination: ctaDestinationFor(templateName, mobile),
      trackingId,
      mobileDigits: mobile,
      configured: configuredButton,
    })

    const result = templateName
      ? await sendWhatsAppTemplate({
          to: toPhone,
          templateName,
          language: nudge.whatsappLanguage || getDefaultTemplateLanguage(),
          params: bodyParams,
          buttonParams,
          fallback: templateFallback,
        })
      : await sendWhatsAppText({
          to: toPhone,
          text: renderTemplate(nudge.bodyTemplate || '', {
            key: recipient.key,
            detail: recipient.detail ?? '',
            mobile,
            mobile_digits: mobile,
          }),
        })

    await db.messageLog.create({
      data: {
        leadId: null,
        nudgeId: nudge.id,
        channel: 'whatsapp',
        messageNumber,
        toPhone,
        // The template that ACTUALLY went out. When a tracked template is not yet approved the
        // send falls back to the untracked one, and the log must say so — otherwise a message
        // with no click attribution looks like a broken tracker.
        templateName: result.usedFallbackTemplate ?? nudge.whatsappTemplateName,
        messageId: result.waMessageId ?? null,
        trackingId,
        ctaUrl,
        sentOk: result.ok,
        sendError: result.error ?? null,
        sentAt: result.ok ? new Date() : null,
        engagementStatus: 'sent',
        sheetRowRef: `mysql:${filters.flow}:${recipient.key}`.slice(0, 512),
      },
    })

    if (result.ok) summary.sent++
    else summary.failed++

    await new Promise((r) => setTimeout(r, 250))
  }

  await db.nudge.update({ where: { id: nudge.id }, data: { lastRunAt: new Date() } })
  return summary
}

/**
 * Run a nudge end-to-end. Set opts.sync=false to skip the Zoho refresh and send to already-synced
 * leads. Set opts.force=true to run a DISABLED nudge once (the UI's "Fetch & Send" button) — see
 * runGuard() in nudge-kind.ts for why that is allowed and what it does not do.
 */
export async function runNudge(
  nudgeId: string,
  baseUrl: string,
  opts: { sync: boolean; limit?: number; force?: boolean }
): Promise<RunSummary> {
  const nudge = await db.nudge.findUnique({ where: { id: nudgeId } })
  if (!nudge) throw new Error('Nudge not found')

  const guard = runGuard(nudge, opts.force)
  if (!guard.ok) throw new Error(guard.error)

  const channel: Channel = nudge.channel === 'whatsapp' ? 'whatsapp' : 'email'
  const filters = parseFilters(nudge.filters)
  const batchLimit = resolveBatchLimit(opts.limit)

  const summary: RunSummary = {
    nudgeKey: nudge.key,
    channel,
    syncedFromZoho: null,
    syncedVia: null,
    forced: guard.forced,
    leadsConsidered: 0,
    sent: 0,
    failed: 0,
    deferred: 0,
    batchLimit,
    skipped: [],
    smtpConfigured: isMailerConfigured(),
    whatsappConfigured: isWhatsAppConfigured(),
  }

  // 0. MySQL-driven flows read the business database directly (read-only) and skip the
  //    local Lead table entirely.
  if (nudgeSource(nudge) === 'mysql') {
    return runMysqlNudge(nudge, summary, batchLimit)
  }

  // 1. Optional Zoho sync for this nudge's criteria.
  //
  // This MUST go through syncLeads(), not syncLeadsFromCriteria(): syncLeads prefers the Zoho MCP
  // server and only falls back to the REST API, which is the whole point of having connected MCP.
  // It used the REST-only helper, so the Run button and the scheduler bypassed MCP entirely while
  // /api/zoho/sync used it — and when the REST client credentials stopped being accepted
  // (`invalid_client_secret`) every nudge run failed to sync at all, even though MCP was fine.
  // One sync path, MCP-first, everywhere.
  if (opts.sync && nudge.zohoCriteria && nudge.zohoCriteria.trim()) {
    // Expanded here: a stored criteria may carry {{monthsAgo:N}}, which Zoho would reject (or match
    // nothing against) if it were sent verbatim.
    const outcome = await syncLeads(expandZohoCriteria(nudge.zohoCriteria.trim()))
    summary.syncedFromZoho = outcome.synced
    summary.syncedVia = outcome.via
  }

  // 2. Select locally
  const selected = await db.lead.findMany({
    where: buildWhere(filters, channel),
    orderBy: { createdAt: 'desc' },
  })
  // Row-level predicates (today: "all documents submitted") are applied here rather than in the
  // query — see applyRowPredicates. Rejections are reported, not silently dropped, so a run that
  // sends nothing explains itself instead of looking broken.
  const { kept: leads, rejected } = applyRowPredicates(selected, filters)
  for (const r of rejected) {
    summary.skipped.push({
      lead: r.lead.fullName || r.lead.email || r.lead.zohoId,
      email: r.lead.email,
      phone: r.lead.phone || r.lead.mobile,
      reason: r.reason,
      detail: `upload ${r.lead.kycDocumentUploadCount ?? '—'} vs expected ${r.lead.kycDocumentsExpectedCount ?? '—'}`,
    })
  }
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

    // One delivery implementation for every entry point (see deliverToLead).
    const delivery = await deliverToLead({ nudge, lead, messageNumber, baseUrl, now })

    if (delivery.skipped) {
      summary.skipped.push({
        lead: lead.fullName || lead.zohoId,
        email: lead.email,
        phone: lead.phone || lead.mobile,
        reason: delivery.skipped,
      })
      continue
    }

    attempts++
    if (delivery.ok) summary.sent++
    else summary.failed++

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
  const selectedForPreview = await db.lead.findMany({
    where: buildWhere(filters, channel),
    orderBy: { createdAt: 'desc' },
  })
  // Same row predicates as the real run, so a preview can never promise a send the run would refuse.
  const { kept: leads, rejected } = applyRowPredicates(selectedForPreview, filters)
  const now = new Date()

  const wouldSend: { lead: string; email: string | null; phone: string | null; messageNumber: number }[] = []
  const wouldSkip: RunSkipped[] = rejected.map((r) => ({
    lead: r.lead.fullName || r.lead.email || r.lead.zohoId,
    email: r.lead.email,
    phone: r.lead.phone || r.lead.mobile,
    reason: r.reason,
    detail: `upload ${r.lead.kycDocumentUploadCount ?? '—'} vs expected ${r.lead.kycDocumentsExpectedCount ?? '—'}`,
  }))
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

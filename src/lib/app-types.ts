export type NudgeChannel = 'email' | 'whatsapp'

export interface NudgeDto {
  id: string
  key: string
  name: string
  description: string | null
  enabled: boolean
  channel: NudgeChannel
  zohoCriteria: string | null
  filters: string
  subjectTemplate: string | null
  bodyTemplate: string | null
  whatsappTemplateName: string | null
  whatsappLanguage: string | null
  whatsappParams: string | null
  maxEmailsPerLead: number
  followUpDays: number
  lastRunAt: string | null
  messagesSent: number
}

export interface LeadDto {
  id: string
  zohoId: string
  fullName: string | null
  email: string | null
  phone: string | null
  company: string | null
  businessVertical: string | null
  leadStatus: string | null
  kycDocumentUploadCount: number | null
  ownerName: string | null
  city: string | null
  createdTime: string | null
  lastSyncedAt: string
  messagesSent: number
  // --- V2 ---
  engagementScore?: number
  scoreBand?: 'cold' | 'warming' | 'engaged' | 'hot'
  scoreLastCalculatedAt?: string | null
  firstNudgeSentAt?: string | null
  lastStatusChangedAt?: string | null
  totalDaysToConvert?: number | null
}

export interface LogDto {
  id: string
  lead: string
  company: string | null
  channel: NudgeChannel
  toEmail: string | null
  toPhone: string | null
  nudge: string
  nudgeKey: string
  messageNumber: number
  subject: string | null
  templateName: string | null
  sentOk: boolean
  sendError: string | null
  sentAt: string | null
  opened: boolean
  openedAt: string | null
  opensCount: number
  replied: boolean
  repliedAt: string | null
  /** Most recent inbound WhatsApp message body, when the customer replied. */
  inboundText: string | null
  /** JSON array of recent inbound messages: [{ at, type, text }] */
  inboundMessages: string | null
  inboundAt: string | null
  /** Where this message's WhatsApp URL button points. */
  ctaUrl: string | null
  /** How many times that tracked button was tapped. */
  ctaClicks: number
  /** When the first tap arrived. */
  ctaClickedAt: string | null
  engagementStatus: 'sent' | 'opened' | 'replied' | 'failed'
  trackingId: string
  sheetRowRef: string | null
}

export interface StatsDto {
  leads: number
  nudges: number
  /**
   * WhatsApp-only figures. The dashboard shows nothing about email at the moment, so there is no
   * email equivalent here — email data lives in the Logs tab and the export.
   */
  whatsapp: {
    sent: number
    failed: number
    /** Meta read receipts. */
    read: number
    replied: number
    /** Messages with at least one CTA button tap. */
    clicked: number
    /** Total taps, including repeats. */
    clicks: number
    readRate: number
    clickRate: number
  }
  recentLogs: {
    id: string
    channel: NudgeChannel
    lead: string
    nudge: string
    messageNumber: number
    /** WhatsApp: the template used. */
    templateName: string | null
    sentOk: boolean
    sendError: string | null
    engagementStatus: string
    opensCount: number
    ctaClicks: number
    sentAt: string | null
    createdAt: string
  }[]
}

export interface RunSkippedDto {
  lead: string
  email: string | null
  phone: string | null
  reason: string
  detail?: string
}

export interface RunSummaryDto {
  nudgeKey: string
  channel: NudgeChannel
  syncedFromZoho: number | null
  /** Which Zoho path did the sync: 'mcp' (preferred) or 'api' (fallback). Null when no sync ran. */
  syncedVia?: 'mcp' | 'api' | null
  /** True when this run was a one-off on a DISABLED nudge (the "Fetch & Send" button). */
  forced?: boolean
  leadsConsidered: number
  sent: number
  failed: number
  /** Leads postponed because NUDGE_MAX_PER_RUN was hit; they resume next cycle. */
  deferred: number
  /** Per-run cap applied (null = unlimited). */
  batchLimit: number | null
  /**
   * True when the run walked the whole eligible pool. False means the run budget expired with work
   * left, and the caller should call /run again to continue — the UI does this automatically.
   */
  complete?: boolean
  /** How many cap-sized batches this run needed. 1 for anything under the cap. */
  batches?: number
  skipped: RunSkippedDto[]
  smtpConfigured: boolean
  whatsappConfigured: boolean
}

/** One lead a background run considered and deliberately did not message, and why. */
export interface RunJobSkipDto {
  lead: string
  email: string | null
  phone: string | null
  reason: string
  detail?: string
}

/**
 * A background run job (src/lib/run-queue.ts).
 *
 * Separate from RunSummaryDto because it is a different thing: a summary is what one finished run
 * did, a job is a long-running send the server is still working through after the request answered.
 *
 * Defined HERE rather than in run-queue.ts so the client can import the shape without importing a
 * server module that opens a database connection.
 */
export interface RunJobDto {
  id: string
  nudgeId: string
  nudgeKey: string
  nudgeName: string
  /** True when this is a one-off run of a DISABLED nudge. */
  force: boolean
  /** Whether the first batch fetches leads from Zoho before sending. */
  sync: boolean
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped'
  sent: number
  failed: number
  /** Leads the last batch reported as still to do. 0 means the audience was exhausted. */
  remaining: number
  batches: number
  batchLimit: number | null
  considered: number
  channel: string
  smtpConfigured: boolean
  whatsappConfigured: boolean
  syncedFromZoho: number | null
  syncedVia: 'mcp' | 'api' | null
  /** The LAST batch's skips, capped — what the operator sees instead of a raw deferred count. */
  skipped: RunJobSkipDto[]
  startedAt: string
  finishedAt?: string
  error?: string
  stopRequested: boolean
}

export interface PreviewDto {
  nudgeKey: string
  channel: NudgeChannel
  leadsConsidered: number
  wouldSend: { lead: string; email: string | null; phone: string | null; messageNumber: number }[]
  wouldSkip: RunSkippedDto[]
  smtpConfigured: boolean
  whatsappConfigured: boolean
  batchLimit: number | null
}

export interface NudgeRunResultDto {
  nudgeKey: string
  name: string
  channel: NudgeChannel
  summary?: RunSummaryDto
  error?: string
}

export interface ImapSyncDto {
  configured: boolean
  scanned: number
  matched: number
  error?: string
}

export interface SchedulerStatusDto {
  ok: boolean
  enabled: boolean
  running: boolean
  intervalMinutes: number
  runsCompleted: number
  lastCycleAt: string | null
  lastCycleTrigger: string | null
  lastResults: NudgeRunResultDto[]
  lastReplySync: ImapSyncDto | null
  imapConfigured: boolean
}

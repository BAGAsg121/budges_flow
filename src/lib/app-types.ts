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
  engagementStatus: 'sent' | 'opened' | 'replied' | 'failed'
  trackingId: string
  sheetRowRef: string | null
}

export interface StatsDto {
  leads: number
  nudges: number
  messagesSent: number
  messagesFailed: number
  opened: number
  replied: number
  openRate: number
  recentLogs: {
    id: string
    channel: NudgeChannel
    lead: string
    nudge: string
    messageNumber: number
    subject: string | null
    sentOk: boolean
    sendError: string | null
    engagementStatus: string
    opensCount: number
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
  leadsConsidered: number
  sent: number
  failed: number
  /** Leads postponed because NUDGE_MAX_PER_RUN was hit; they resume next cycle. */
  deferred: number
  /** Per-run cap applied (null = unlimited). */
  batchLimit: number | null
  skipped: RunSkippedDto[]
  smtpConfigured: boolean
  whatsappConfigured: boolean
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

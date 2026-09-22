export interface NudgeDto {
  id: string
  key: string
  name: string
  description: string | null
  enabled: boolean
  zohoCriteria: string | null
  filters: string
  subjectTemplate: string
  bodyTemplate: string
  maxEmailsPerLead: number
  followUpDays: number
  lastRunAt: string | null
  emailsSent: number
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
  emailsSent: number
}

export interface LogDto {
  id: string
  lead: string
  company: string | null
  toEmail: string
  nudge: string
  nudgeKey: string
  emailNumber: number
  subject: string
  sentOk: boolean
  sendError: string | null
  sentAt: string | null
  opened: boolean
  openedAt: string | null
  opensCount: number
  replied: boolean
  engagementStatus: 'sent' | 'opened' | 'replied' | 'failed'
  trackingId: string
}

export interface StatsDto {
  leads: number
  nudges: number
  emailsSent: number
  emailsFailed: number
  opened: number
  replied: number
  openRate: number
  recentLogs: {
    id: string
    lead: string
    nudge: string
    emailNumber: number
    subject: string
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
  reason: string
  detail?: string
}

export interface RunSummaryDto {
  nudgeKey: string
  syncedFromZoho: number | null
  leadsConsidered: number
  sent: number
  failed: number
  skipped: RunSkippedDto[]
  smtpConfigured: boolean
}

export interface PreviewDto {
  nudgeKey: string
  leadsConsidered: number
  wouldSend: { lead: string; email: string | null; emailNumber: number }[]
  wouldSkip: RunSkippedDto[]
  smtpConfigured: boolean
}

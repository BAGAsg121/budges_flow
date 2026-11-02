/**
 * "May this nudge be sent to THIS lead right now?" — one implementation, used everywhere.
 *
 * Extracted from the single-nudge webhook so the new dispatcher (which picks a nudge itself) cannot
 * answer the question differently. The two drifting apart is how a lead gets messaged by a path that
 * thinks it is eligible while the sequence rule says it already replied.
 *
 * THE ORDER MATTERS, not just the style. buildWhere() narrows on status/vertical/phone in the QUERY
 * during a scheduled run, and only then does the KYC row predicate see the survivors. Applying the
 * row predicate first reports "expected count unknown" for a lead that was really refused for its
 * status — a misleading reason that sends whoever reads the CRM log hunting the wrong field.
 */
import { db } from '@/lib/db'
import { splitByKycMatch } from '@/lib/kyc-match'
import { decideSend } from '@/lib/sequence'

/** The minimum a nudge must expose. Deliberately structural, so both a Prisma row and a DTO fit. */
export interface EligibleNudge {
  id: string
  key: string
  channel: string
  filters: string
  maxEmailsPerLead: number
  followUpDays: number
}

/** The minimum a lead must expose. */
export interface EligibleLead {
  id: string
  leadStatus: string | null
  businessVertical: string | null
  mobile: string | null
  phone: string | null
  kycDocumentUploadCount: number | null
  kycDocumentsExpectedCount: number | null
}

export type Eligibility =
  | { ok: true; messageNumber: number }
  | { ok: false; reason: string; detail?: string }

function parseFiltersSafe(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}')
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function evaluateNudgeForLead(
  nudge: EligibleNudge,
  lead: EligibleLead,
  now: Date = new Date()
): Promise<Eligibility> {
  const filters = parseFiltersSafe(nudge.filters) as {
    includeStatuses?: string[]
    excludeStatuses?: string[]
    businessVertical?: string
    requirePhone?: boolean
    kycCountRule?: 'equals' | 'less_than'
    kycMatchesExpected?: boolean
  }

  // 1. Status must be one of the included ones (when the filter names any).
  if (filters.includeStatuses?.length) {
    if (!lead.leadStatus || !filters.includeStatuses.includes(lead.leadStatus)) {
      return {
        ok: false,
        reason: 'status_not_included',
        detail: `lead status "${lead.leadStatus ?? '—'}" is not in ${JSON.stringify(filters.includeStatuses)}`,
      }
    }
  }
  // 2. …and not one of the excluded ones.
  if (filters.excludeStatuses?.length && lead.leadStatus && filters.excludeStatuses.includes(lead.leadStatus)) {
    return { ok: false, reason: 'status_excluded', detail: lead.leadStatus }
  }
  // 3. Business vertical.
  if (filters.businessVertical && lead.businessVertical !== filters.businessVertical) {
    return {
      ok: false,
      reason: 'wrong_business_vertical',
      detail: `"${lead.businessVertical ?? '—'}" != "${filters.businessVertical}"`,
    }
  }
  // 4. Deliverability.
  if (filters.requirePhone !== false && !lead.mobile && !lead.phone) {
    return { ok: false, reason: 'no_valid_phone' }
  }

  // 5. Row predicate ("all documents submitted" / "documents rejected") — AFTER the cheap checks.
  const { rejected } = splitByKycMatch([{ ...lead, ...{}}], {
    kycCountRule: filters.kycCountRule,
    kycMatchesExpected: filters.kycMatchesExpected,
  })
  if (rejected.length) {
    return {
      ok: false,
      reason: rejected[0].reason,
      detail: `upload ${lead.kycDocumentUploadCount ?? '—'} vs expected ${lead.kycDocumentsExpectedCount ?? '—'}`,
    }
  }

  // 6. The sequence rule: replied? maxed out? inside the follow-up gap?
  const logs = await db.messageLog.findMany({ where: { nudgeId: nudge.id, leadId: lead.id } })
  const decision = decideSend(logs, nudge.maxEmailsPerLead, nudge.followUpDays, now, { channel: nudge.channel })
  if (decision.action === 'skip') {
    return { ok: false, reason: decision.reason ?? 'skipped', detail: decision.detail }
  }

  return { ok: true, messageNumber: decision.messageNumber ?? 1 }
}

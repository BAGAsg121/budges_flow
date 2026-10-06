/**
 * V2 — recording the lead journey: detect CRM stage changes and attribute them.
 *
 * Split from journey.ts so the maths stays testable: that module is pure, this one talks to the
 * database. The rules themselves all live in journey.ts.
 */
import { db } from '@/lib/db'
import type { MappedLead } from '@/lib/zoho'
import {
  attributionWindowHours,
  daysBetween,
  isConvertedStatus,
  journeySyncOnFetch,
  pickAttribution,
  timeInPrevStageHours,
  type JourneyLog,
} from '@/lib/journey'

/** The columns the journey logic needs from a message log. */
const LOG_SELECT = {
  id: true,
  nudgeId: true,
  channel: true,
  messageNumber: true,
  sentOk: true,
  sentAt: true,
  opened: true,
  replied: true,
  ctaClicks: true,
  ctaClickedAt: true,
} as const

export interface StageChangeOutcome {
  /** The local lead id, so the caller can rescore exactly the leads a sync touched. */
  leadId: string
  changed: boolean
  fromStatus?: string | null
  toStatus?: string
  attributedTo?: string | null
  hoursSinceNudge?: number | null
}

/**
 * Upsert one lead AND detect whether its CRM status changed.
 *
 * This replaces the plain `db.lead.upsert` the sync used to do, because detecting a transition needs
 * the PREVIOUS status — which an upsert throws away. One extra read per lead buys the whole V2
 * journey, and the sync is already doing a write per lead.
 *
 * Deliberately conservative:
 *   • A NULL incoming status is not a transition. Zoho omits fields it has no value for, and
 *     treating "field absent" as "moved to nothing" would fabricate journey rows.
 *   • The very FIRST status a lead is seen with is NOT recorded as a change. There is no
 *     `fromStatus` to report, and "New → nothing" is not a move the lead made.
 */
export async function upsertLeadWithJourney(data: MappedLead): Promise<StageChangeOutcome> {
  const existing = await db.lead.findUnique({
    where: { zohoId: data.zohoId },
    select: { id: true, leadStatus: true, lastStatusChangedAt: true, firstNudgeSentAt: true },
  })

  if (!existing) {
    const created = await db.lead.create({ data, select: { id: true } })
    return { leadId: created.id, changed: false }
  }

  const incoming = (data.leadStatus || '').trim()
  const previous = (existing.leadStatus || '').trim()
  const detect = journeySyncOnFetch()

  // Only a real, non-empty, different status counts.
  if (!detect || !incoming || incoming === previous) {
    await db.lead.update({ where: { id: existing.id }, data: { ...data } })
    return { leadId: existing.id, changed: false, fromStatus: previous || null, toStatus: incoming || undefined }
  }

  const detectedAt = new Date()

  // The last successful send within the attribution window — the nudge this change is credited to,
  // or nobody at all. See journey.ts for why this is a guess and not a proof.
  const logs = await db.messageLog.findMany({
    where: { leadId: existing.id, sentOk: true },
    select: LOG_SELECT,
  })
  const attribution = pickAttribution(logs as JourneyLog[], detectedAt, attributionWindowHours())

  const hoursInPrev = timeInPrevStageHours(existing.lastStatusChangedAt, detectedAt)

  await db.leadStageHistory.create({
    data: {
      leadId: existing.id,
      fromStatus: previous || null,
      toStatus: incoming,
      detectedAt,
      triggeredByNudgeId: attribution?.nudgeId ?? null,
      triggeredByMessageLogId: attribution?.messageLogId ?? null,
      timeInPrevStageHours: hoursInPrev,
      hoursSinceNudge: attribution?.hoursSinceNudge ?? null,
      attributedMessageNumber: attribution?.messageNumber ?? null,
    },
  })

  // Time-to-conversion is stamped only on reaching the converted stage, and only when we know when
  // the first nudge went out — otherwise the number would be a guess dressed as a measurement.
  const convertDays = isConvertedStatus(incoming)
    ? daysBetween(existing.firstNudgeSentAt, detectedAt)
    : null

  await db.lead.update({
    where: { id: existing.id },
    data: {
      ...data,
      lastStatusChangedAt: detectedAt,
      ...(convertDays !== null ? { totalDaysToConvert: convertDays } : {}),
    },
  })

  return {
    leadId: existing.id,
    changed: true,
    fromStatus: previous || null,
    toStatus: incoming,
    attributedTo: attribution?.nudgeId ?? null,
    hoursSinceNudge: attribution?.hoursSinceNudge ?? null,
  }
}

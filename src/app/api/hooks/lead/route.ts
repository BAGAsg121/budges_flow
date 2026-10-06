/**
 * POST /api/hooks/lead — record a CRM stage change.
 *
 * Point a Zoho workflow at this whenever a lead's status changes. Send the lead's data (at minimum
 * the record id and the NEW status) and the app does the comparison itself: it looks up what it
 * already holds, works out whether the status actually moved, records the transition, attributes it
 * to the last nudge inside the window, and recalculates the lead's engagement score.
 *
 * The CRM does not need to know the old status — that is the point. Sending "the status is now X"
 * is enough, because we already have the previous value; and if the two match, nothing is recorded.
 * That also makes the webhook idempotent: a retried delivery for the same change creates nothing the
 * second time, rather than a duplicate journey row.
 *
 * AUTH: LEAD_WEBHOOK_SECRET via `?token=`, `x-webhook-secret`, or `Authorization: Bearer`. Fails
 * CLOSED — with no secret configured every call is refused, never silently accepted.
 *
 * `?dryRun=1` reports exactly what the call would do and writes NOTHING. Use it to confirm a Zoho
 * workflow is sending the right fields before letting it touch the journey data.
 *
 * ANSWERS WITH THE COMPARISON, so the CRM log is useful:
 *   { action: "stage_changed", fromStatus: "Documents Pending", toStatus: "Agreement Signed",
 *     attributedTo: "documents_pending_wa", hoursSinceNudge: 4.2, score: 22, scoreBand: "warming" }
 *
 * The same payload shapes as /api/hooks/nudge/{key} are accepted (flat, {Leads:{…}}, {data:[…]},
 * form-encoded, query string) because both read through @/lib/webhook-payload.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { mapZohoLead, type ZohoLead } from '@/lib/zoho'
import { upsertLeadWithJourney } from '@/lib/journey-sync'
import { recalculateScores } from '@/lib/score-leads'
import { isLeadWebhookAuthorized } from '@/lib/cron-auth'
import { leadRecordId, leadStatusFrom, payloadFields, readWebhookPayload } from '@/lib/webhook-payload'
import {
  attributionWindowHours,
  daysBetween,
  isConvertedStatus,
  pickAttribution,
  SCORE_BAND_LABEL,
  scoreBand,
  type JourneyLog,
} from '@/lib/journey'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

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

export async function POST(req: NextRequest) {
  if (!isLeadWebhookAuthorized(req)) {
    return NextResponse.json(
      {
        ok: false,
        error: process.env.LEAD_WEBHOOK_SECRET
          ? 'unauthorized: pass the secret as ?token=, x-webhook-secret, or Authorization: Bearer'
          : 'LEAD_WEBHOOK_SECRET is not configured on the server, so this webhook is closed',
      },
      { status: 401 }
    )
  }

  const payload = await readWebhookPayload(req)
  if (!payload) {
    return NextResponse.json({ ok: false, error: 'Could not read a lead record from the request body' }, { status: 400 })
  }

  const zohoId = leadRecordId(payload)
  if (!zohoId) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'The payload has no lead id. The record id is the only key the comparison can be made on — ' +
          'without it a repeat delivery cannot be recognised.',
        receivedFields: payloadFields(payload),
      },
      { status: 400 }
    )
  }

  const dryRun = ['1', 'true', 'yes'].includes((req.nextUrl.searchParams.get('dryRun') || '').toLowerCase())

  // The new status is the whole point of this webhook, so its absence is called out rather than
  // passing silently: the lead would be updated and NO transition recorded, which looks like the
  // webhook working while the journey data stays empty.
  const statusFromPayload = leadStatusFrom(payload)
  const mapped = mapZohoLead({ ...payload, id: zohoId } as unknown as ZohoLead)

  const existing = await db.lead.findUnique({
    where: { zohoId },
    select: { id: true, leadStatus: true, lastStatusChangedAt: true, firstNudgeSentAt: true, engagementScore: true },
  })

  const previous = (existing?.leadStatus || '').trim() || null
  const incoming = (mapped.leadStatus || '').trim() || null
  // Same rule the sync uses: a real, non-empty, DIFFERENT status is a transition. A first sighting
  // is not (there is no "from"), and an absent status is not (that would be inventing a move).
  const wouldChange = Boolean(existing && incoming && incoming !== previous)

  const base = {
    ok: true as const,
    zohoId,
    leadId: existing?.id ?? null,
    lead: mapped.fullName || mapped.email || zohoId,
    statusInPayload: statusFromPayload,
    statusStored: previous,
    statusIncoming: incoming,
    attributionWindowHours: attributionWindowHours(),
    attributionIsProbabilistic: true,
  }

  // ---- dry run: report the comparison, write nothing ------------------------
  if (dryRun) {
    let attribution: ReturnType<typeof pickAttribution> = null
    if (existing && wouldChange) {
      const logs = await db.messageLog.findMany({ where: { leadId: existing.id, sentOk: true }, select: LOG_SELECT })
      attribution = pickAttribution(logs as unknown as JourneyLog[], new Date(), attributionWindowHours())
    }
    return NextResponse.json({
      ...base,
      dryRun: true,
      action: !existing ? 'would_create_lead' : wouldChange ? 'would_record_stage_change' : 'would_update_only',
      wouldChangeStatus: wouldChange,
      wouldRecordHistory: wouldChange,
      wouldAttributeTo: attribution?.nudgeId ?? null,
      wouldAttributeMessageNumber: attribution?.messageNumber ?? null,
      wouldAttributeHoursSinceNudge: attribution?.hoursSinceNudge ?? null,
      wouldBeFirstNudge: existing?.firstNudgeSentAt ?? null,
      warning: !statusFromPayload
        ? 'No status field found. This webhook records stage changes, so include Lead_Status — otherwise the lead is updated and NO transition is recorded.'
        : null,
    })
  }

  // ---- the real thing -------------------------------------------------------
  const outcome = await upsertLeadWithJourney(mapped)

  // Only this lead needs rescoring; the stage change is one of the score's signals.
  await recalculateScores({ leadIds: [outcome.leadId] })

  const lead = await db.lead.findUnique({
    where: { id: outcome.leadId },
    select: {
      engagementScore: true,
      scoreBreakdown: true,
      firstNudgeSentAt: true,
      lastStatusChangedAt: true,
      totalDaysToConvert: true,
      leadStatus: true,
    },
  })

  // The history row just written, for the fields upsertLeadWithJourney does not return.
  const history = outcome.changed
    ? await db.leadStageHistory.findFirst({
        where: { leadId: outcome.leadId },
        orderBy: { detectedAt: 'desc' },
        select: { id: true, timeInPrevStageHours: true, hoursSinceNudge: true, attributedMessageNumber: true },
      })
    : null

  let breakdown: Record<string, number> | null = null
  try {
    breakdown = lead?.scoreBreakdown ? (JSON.parse(lead.scoreBreakdown) as Record<string, number>) : null
  } catch {
    breakdown = null
  }

  const action = !existing ? 'created_lead' : outcome.changed ? 'stage_changed' : 'no_change'
  const score = lead?.engagementScore ?? 0

  return NextResponse.json({
    ...base,
    dryRun: false,
    action,
    /** The comparison the caller asked for. */
    changed: outcome.changed,
    fromStatus: outcome.fromStatus ?? previous,
    toStatus: outcome.toStatus ?? incoming,
    historyId: history?.id ?? null,
    timeInPrevStageHours: history?.timeInPrevStageHours ?? null,
    attributedTo: outcome.attributedTo ?? null,
    hoursSinceNudge: history?.hoursSinceNudge ?? outcome.hoursSinceNudge ?? null,
    attributedMessageNumber: history?.attributedMessageNumber ?? null,
    firstNudgeSentAt: lead?.firstNudgeSentAt ?? null,
    lastStatusChangedAt: lead?.lastStatusChangedAt ?? null,
    converted: isConvertedStatus(lead?.leadStatus ?? null),
    totalDaysToConvert: lead?.totalDaysToConvert ?? null,
    // Only meaningful when the clock is known; daysBetween returns null otherwise rather than a guess.
    daysFromFirstNudge: daysBetween(lead?.firstNudgeSentAt ?? null, new Date()),
    score,
    scoreBand: scoreBand(score),
    scoreBandLabel: SCORE_BAND_LABEL[scoreBand(score)],
    scoreBreakdown: breakdown,
    summary: outcome.changed
      ? `${previous ?? '(first seen)'} → ${incoming}` +
        (outcome.attributedTo ? ` · attributed to ${outcome.attributedTo}` : ' · no nudge in the window, organic change')
      : existing
        ? `no status change (already ${previous ?? 'unset'})`
        : 'lead created — first sighting, so no transition is recorded',
  })
}

/** GET documents the contract, so the URL can be checked from a browser without a payload. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    purpose: 'Record a CRM stage change: send the lead and its NEW status, the app compares it with what it holds.',
    method: 'POST',
    auth: 'LEAD_WEBHOOK_SECRET as ?token=, x-webhook-secret, or Authorization: Bearer',
    accepts: [
      'POST application/json',
      'POST application/x-www-form-urlencoded',
      'POST ?token=…&id=…&Lead_Status=…',
    ],
    requiredFields: ['id (the Zoho record id)', 'Lead_Status (the new status)'],
    optionalFields: ['every other field you want kept current — full name, email, mobile, company, business vertical, KYC counts'],
    dryRun: 'add ?dryRun=1 to see what the call would do without writing anything',
    attributionWindowHours: attributionWindowHours(),
    note:
      'Send only the NEW status. The comparison is done here against the stored value, so the CRM does ' +
      'not need to know the old one. A repeat delivery for the same change records nothing.',
  })
}

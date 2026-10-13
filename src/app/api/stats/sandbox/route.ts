/**
 * GET /api/stats/sandbox?days=14
 *
 * Per-nudge engagement for every **sandbox WhatsApp** nudge — the same shape the activation-fee
 * families get from /api/stats/onboarding, so the two dashboard sections read alike.
 *
 * WHY A SEPARATE ENDPOINT rather than folding these into the onboarding one: those two are
 * *families* (an email nudge plus its WhatsApp twin, reported together), while each sandbox nudge is
 * its own campaign with its own template and audience. Reporting eight sandbox nudges as four
 * families would invent a pairing that does not exist, and reporting them as one aggregate would
 * hide exactly the per-template comparison the operator wants.
 *
 * The nudge list comes from SANDBOX_WHATSAPP_NUDGES rather than a query, so a nudge added to the
 * code but never seeded shows up as `missing` instead of silently vanishing from the dashboard.
 *
 * Every sandbox nudge is WhatsApp-only, so unlike the onboarding payload there is no email block.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { SANDBOX_WHATSAPP_NUDGES } from '@/lib/nudge-defaults'
import { buildDailySeries } from '@/lib/engagement-stats'
import { accumulateTotals, emptyTotals, type NudgeTotals } from '@/lib/nudge-totals'
import { capAppliesTo } from '@/lib/nudge-kind'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: Request) {
  const url = new URL(req.url)
  const days = Math.min(Math.max(Number(url.searchParams.get('days') || 14) || 14, 1), 90)

  const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000)
  since.setHours(0, 0, 0, 0)

  // The code is the source of truth for WHICH nudges belong here; the database only supplies their
  // ids and current configuration.
  const keys = Object.keys(SANDBOX_WHATSAPP_NUDGES)

  const nudges = await db.nudge.findMany({
    where: { key: { in: keys } },
    select: {
      id: true,
      key: true,
      name: true,
      enabled: true,
      maxEmailsPerLead: true,
      followUpDays: true,
      filters: true,
      whatsappTemplateName: true,
    },
  })
  const byKey = new Map(nudges.map((n) => [n.key, n]))
  const nudgeIds = nudges.map((n) => n.id)
  const idToKey = new Map(nudges.map((n) => [n.id, n.key]))

  // Lifetime totals and the windowed series answer different questions, so they are separate
  // queries rather than one query sliced two ways in JS.
  const [allLogs, windowLogs] = await Promise.all([
    nudgeIds.length
      ? db.messageLog.findMany({
          where: { nudgeId: { in: nudgeIds } },
          select: {
            nudgeId: true,
            channel: true,
            sentOk: true,
            opened: true,
            opensCount: true,
            replied: true,
            sendError: true,
            ctaClicks: true,
            sentAt: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
    nudgeIds.length
      ? db.messageLog.findMany({
          where: { nudgeId: { in: nudgeIds }, createdAt: { gte: since } },
          // ctaClicks is needed for the daily series, which plots clicks beside sent/read/failed.
          select: {
            nudgeId: true,
            channel: true,
            sentOk: true,
            opened: true,
            ctaClicks: true,
            createdAt: true,
            sentAt: true,
          },
        })
      : Promise.resolve([]),
  ])

  // Pre-seed every configured key so a nudge with no logs reports zeroes rather than disappearing.
  const totals = new Map<string, NudgeTotals>()
  for (const key of keys) totals.set(key, emptyTotals(key))
  for (const key of keys) {
    const t = totals.get(key)
    if (t) t.nudgeName = byKey.get(key)?.name ?? null
  }
  accumulateTotals(allLogs, idToKey, totals)

  const seriesFor = (key: string) => {
    const id = byKey.get(key)?.id
    return buildDailySeries({ logs: windowLogs, nudgeIds: id ? [id] : [], days, since })
  }

  return NextResponse.json(
    {
      ok: true,
      days,
      since: since.toISOString(),
      nudges: keys.map((key) => {
        const n = byKey.get(key)
        return {
          key,
          label: n?.name ?? SANDBOX_WHATSAPP_NUDGES[key].title,
          enabled: n?.enabled ?? false,
          templateName: n?.whatsappTemplateName ?? SANDBOX_WHATSAPP_NUDGES[key].templateName,
          /** False when the nudge is sheet-driven, whose cap nothing enforces. */
          capApplies: n ? capAppliesTo(n) : false,
          max: n?.maxEmailsPerLead ?? null,
          followUpDays: n?.followUpDays ?? null,
          /** The real audience this nudge matches, for the operator's benefit. */
          liveMatchEstimate: SANDBOX_WHATSAPP_NUDGES[key].liveMatchEstimate ?? null,
          totals: totals.get(key) as NudgeTotals,
          /** This nudge's OWN daily buckets — there is deliberately no combined series. */
          series: seriesFor(key),
        }
      }),
      /** Configured in code but not present in the database — the seed has not run. */
      missing: keys.filter((k) => !byKey.has(k)),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

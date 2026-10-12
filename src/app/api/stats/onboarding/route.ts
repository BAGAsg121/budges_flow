/**
 * GET /api/stats/onboarding?days=14
 *
 * Engagement for the two activation-fee nudge families — "onboarded but not transacting" and
 * "onboarded and transacting" — each of which exists twice, as an email nudge and as its
 * WhatsApp twin. Answers two questions in one payload:
 *
 *   families[].email / .whatsapp  — lifetime totals for that channel (sent, failed, opened, replied)
 *   series[]                      — the same numbers bucketed per day, for the charts
 *
 * "Opened" means different things per channel and the field names say which: an email open is
 * the tracking pixel, while a WhatsApp open is Meta's `read` receipt (both are stored on the
 * same `opened` column, which is why one endpoint can report both).
 *
 * The row counts here are in the hundreds, so grouping in JS is clearer — and far less
 * error-prone — than a hand-written SQL GROUP BY over a shared production database.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { WA_EMAIL_TWIN } from '@/lib/nudge-defaults'
import { buildDailySeries } from '@/lib/engagement-stats'
import { accumulateTotals, emptyTotals, type NudgeTotals } from '@/lib/nudge-totals'
import { capAppliesTo } from '@/lib/nudge-kind'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** The two families, described once so the API and the UI cannot disagree. */
const FAMILIES = [
  {
    id: 'not_transacting',
    label: 'Onboarded but not transacting',
    emailKey: 'onboarded_not_transacting',
    whatsappKey: 'whatsapp_onboarded_not_transacting',
  },
  {
    id: 'transacting',
    label: 'Onboarded and transacting',
    emailKey: 'onboarded_transacting',
    whatsappKey: 'whatsapp_onboarded_transacting',
  },
] as const

export async function GET(req: Request) {
  const url = new URL(req.url)
  const days = Math.min(Math.max(Number(url.searchParams.get('days') || 14) || 14, 1), 90)

  const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000)
  since.setHours(0, 0, 0, 0)

  // Every nudge key involved, so one query covers all four streams.
  const keys = FAMILIES.flatMap((f) => [f.emailKey, f.whatsappKey])
  // Any nudge that falls back to email is also part of the family's email story.
  const fallbackKeys = Object.values(WA_EMAIL_TWIN)

  const nudges = await db.nudge.findMany({
    where: { key: { in: [...new Set([...keys, ...fallbackKeys])] } },
    select: {
      id: true,
      key: true,
      name: true,
      maxEmailsPerLead: true,
      followUpDays: true,
      enabled: true,
      zohoCriteria: true,
      filters: true,
    },
  })
  const byKey = new Map(nudges.map((n) => [n.key, n]))

  const nudgeIds = nudges.map((n) => n.id)

  // Lifetime totals + the windowed daily series are different questions, so they get
  // different queries rather than one query sliced two ways in JS.
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
          select: { nudgeId: true, channel: true, sentOk: true, opened: true, createdAt: true, sentAt: true },
        })
      : Promise.resolve([]),
  ])

  const idToKey = new Map(nudges.map((n) => [n.id, n.key]))

  // --- lifetime totals -------------------------------------------------------
  // Counting lives in src/lib/nudge-totals.ts so this route and the sandbox dashboard cannot drift
  // apart on what a failure or a cap is. Keys are pre-seeded so a nudge with no logs reports zeroes
  // rather than disappearing from the dashboard.
  const totals = new Map<string, NudgeTotals>()
  for (const f of FAMILIES) {
    totals.set(f.emailKey, emptyTotals(f.emailKey))
    totals.set(f.whatsappKey, emptyTotals(f.whatsappKey))
  }

  for (const key of keys) {
    const t = totals.get(key)
    if (t) t.nudgeName = byKey.get(key)?.name ?? null
  }

  accumulateTotals(allLogs, idToKey, totals)

  // --- daily series, PER FAMILY ----------------------------------------------
  // Built once per family from that family's own two nudge ids. It used to be built once
  // across all four nudges and returned as a single `series`, which both charts then drew —
  // so the two families showed identical graphs. The response no longer carries a combined
  // series at all, so that mistake cannot be made again by picking the wrong field.
  const seriesFor = (nudgeIds: string[]) =>
    buildDailySeries({
      logs: windowLogs,
      nudgeIds: nudgeIds.map((k) => byKey.get(k)?.id).filter((id): id is string => Boolean(id)),
      days,
      since,
    })

  return NextResponse.json(
    {
      ok: true,
      days,
      since: since.toISOString(),
      families: FAMILIES.map((f) => ({
        id: f.id,
        label: f.label,
        email: totals.get(f.emailKey) as NudgeTotals,
        whatsapp: totals.get(f.whatsappKey) as NudgeTotals,
        config: {
          emailMax: byKey.get(f.emailKey)?.maxEmailsPerLead ?? null,
          emailFollowUpDays: byKey.get(f.emailKey)?.followUpDays ?? null,
          whatsappMax: byKey.get(f.whatsappKey)?.maxEmailsPerLead ?? null,
          whatsappFollowUpDays: byKey.get(f.whatsappKey)?.followUpDays ?? null,
          // The cap only governs lead-driven nudges; a sheet nudge is sent by the sheet-run
          // route, which applies "one message per recipient" instead. The UI must not show a
          // limit that nothing enforces.
          emailCapApplies: byKey.get(f.emailKey) ? capAppliesTo(byKey.get(f.emailKey)!) : false,
          whatsappCapApplies: byKey.get(f.whatsappKey) ? capAppliesTo(byKey.get(f.whatsappKey)!) : false,
        },
        /** This family's own two nudges only — never the other family's. */
        nudgeKeys: [f.emailKey, f.whatsappKey],
        series: seriesFor([f.emailKey, f.whatsappKey]),
      })),
      /** True when any of the four nudges is missing from the database. */
      missingNudges: keys.filter((k) => !byKey.has(k)),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

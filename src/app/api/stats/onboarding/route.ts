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

interface Totals {
  nudgeKey: string
  nudgeName: string | null
  /** Messages Meta/Zoho accepted. A later failure flips this, so it is always current state. */
  sent: number
  failed: number
  /** Email: pixel fired. WhatsApp: `read` receipt. */
  opened: number
  /** Sum of opensCount — one email can be opened several times. */
  opensTotal: number
  replied: number
  /** Delivery-cap drops (131049/131050), which are retryable rather than real failures. */
  capped: number
  lastSentAt: string | null
}

interface DayBucket {
  date: string
  emailSent: number
  emailOpened: number
  emailFailed: number
  waSent: number
  waOpened: number
  waFailed: number
}

function emptyTotals(nudgeKey: string): Totals {
  return { nudgeKey, nudgeName: null, sent: 0, failed: 0, opened: 0, opensTotal: 0, replied: 0, capped: 0, lastSentAt: null }
}

/** yyyy-mm-dd in the CRM's timezone, so a "day" matches the day the operator works in. */
function istDayKey(d: Date): string {
  const shifted = new Date(d.getTime() + (5 * 60 + 30) * 60 * 1000)
  return shifted.toISOString().slice(0, 10)
}

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
  const totals = new Map<string, Totals>()
  for (const f of FAMILIES) {
    totals.set(f.emailKey, emptyTotals(f.emailKey))
    totals.set(f.whatsappKey, emptyTotals(f.whatsappKey))
  }

  for (const key of keys) {
    const t = totals.get(key)
    if (t) t.nudgeName = byKey.get(key)?.name ?? null
  }

  for (const log of allLogs) {
    const key = idToKey.get(log.nudgeId)
    if (!key) continue

    // A fallback email is logged against the EMAIL nudge, so it already lands in the right
    // bucket. A WhatsApp-capped row is counted as failed *and* as capped.
    const t = totals.get(key)
    if (!t) continue

    if (log.channel === 'whatsapp') {
      const capped = /131049|131050|healthy ecosystem engagement|part of an experiment/i.test(log.sendError || '')
      if (capped) t.capped++
    }

    if (log.sentOk) {
      t.sent++
      if (log.sentAt && (!t.lastSentAt || log.sentAt.toISOString() > t.lastSentAt)) {
        t.lastSentAt = log.sentAt.toISOString()
      }
    } else {
      t.failed++
    }

    if (log.opened) {
      t.opened++
      t.opensTotal += log.opensCount || 0
    }
    if (log.replied) t.replied++
  }

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
        email: totals.get(f.emailKey) as Totals,
        whatsapp: totals.get(f.whatsappKey) as Totals,
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

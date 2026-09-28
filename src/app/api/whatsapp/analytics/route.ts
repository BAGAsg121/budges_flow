/**
 * GET /api/whatsapp/analytics?days=7
 *
 * What Meta itself recorded for our templates: sent, delivered, read, and — the interesting one —
 * how many times a template's URL button was tapped.
 *
 * This is the answer to "did anyone click?", and it needs no template change and no redirect,
 * because Meta counts button clicks itself. What it cannot answer is WHO clicked: the data is per
 * template per day. Per-person attribution needs the redirect tracker (src/lib/cta.ts).
 *
 * Behind the app password (src/middleware.ts).
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  analyticsConfig,
  fetchTemplateClickAnalytics,
  isTemplateAnalyticsConfigured,
  ANALYTICS_MAX_DAYS,
  ANALYTICS_MAX_DATA_POINTS,
} from '@/lib/meta-template-analytics'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  const requested = Number(req.nextUrl.searchParams.get('days') || 7) || 7
  // Capped because Meta truncates a template_analytics response at ~25 data points.
  const days = Math.min(Math.max(requested, 1), ANALYTICS_MAX_DAYS)

  if (!isTemplateAnalyticsConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'WHATSAPP_TOKEN / WHATSAPP_WABA_ID are not set, so Meta analytics cannot be read.' },
      { status: 400 }
    )
  }

  // Only ask about templates our own WhatsApp nudges actually reference — the WABA carries
  // retired ones too, and their numbers would only add noise.
  const nudges = await db.nudge.findMany({
    where: { channel: 'whatsapp', whatsappTemplateName: { not: null } },
    select: { key: true, name: true, whatsappTemplateName: true, whatsappLanguage: true },
  })

  // Meta's analytics key on the numeric template id, so resolve names -> ids once here.
  const { token, wabaId, version } = analyticsConfig()

  let ids: Array<{ id: string; name: string }> = []
  try {
    const res = await fetch(
      `https://graph.facebook.com/${version}/${wabaId}/message_templates?fields=name,id&limit=200`,
      { headers: { authorization: `Bearer ${token}` } }
    )
    const payload = (await res.json()) as { data?: Array<{ id: string; name: string }>; error?: { message?: string } }
    if (payload.error) {
      return NextResponse.json({ ok: false, error: payload.error.message }, { status: 502 })
    }
    const nameToId = new Map((payload.data ?? []).map((t) => [t.name, t.id]))
    ids = nudges
      .map((n) => ({ id: nameToId.get(n.whatsappTemplateName as string) || '', name: n.whatsappTemplateName as string }))
      .filter((x) => x.id)
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Could not list templates: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    )
  }

  const result = await fetchTemplateClickAnalytics({ templateIds: ids.map((i) => i.id), days })

  const idToName = new Map(ids.map((i) => [i.id, i.name]))
  const byTemplate = new Map<
    string,
    { template: string; clicks: number; uniqueClicks: number; sentByUs: number; buttonLabels: string[] }
  >()

  // Clicks come from Meta (it counts button taps; we cannot). "Sent" comes from our own log
  // table, which is accurate and free — asking Meta for it too would multiply the requests for
  // data we already have.
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const ownCounts = await db.messageLog.groupBy({
    by: ['templateName'],
    where: { channel: 'whatsapp', createdAt: { gte: since } },
    _count: { _all: true },
  })
  const sentByTemplate = new Map(ownCounts.map((r) => [r.templateName as string, r._count._all]))

  for (const row of result.rows) {
    const name = idToName.get(row.templateId) || row.templateId
    const t =
      byTemplate.get(row.templateId) ??
      { template: name, clicks: 0, uniqueClicks: 0, sentByUs: sentByTemplate.get(name) ?? 0, buttonLabels: [] as string[] }
    t.clicks += row.clicks
    t.uniqueClicks += row.uniqueClicks
    for (const l of row.buttonLabels) if (!t.buttonLabels.includes(l)) t.buttonLabels.push(l)
    byTemplate.set(row.templateId, t)
  }

  // Include templates that had sends but no clicks yet, so the list is complete rather than
  // silently omitting the quiet ones.
  for (const { id, name } of ids) {
    if (!byTemplate.has(id)) {
      byTemplate.set(id, {
        template: name,
        clicks: 0,
        uniqueClicks: 0,
        sentByUs: sentByTemplate.get(name) ?? 0,
        buttonLabels: [],
      })
    }
  }

  const totals = [...byTemplate.values()].sort((a, b) => b.clicks - a.clicks || b.sentByUs - a.sentByUs)

  return NextResponse.json(
    {
      ok: result.ok,
      days,
      /** Set when the window was shortened to stay inside Meta's response cap. */
      daysCapped: requested > ANALYTICS_MAX_DAYS ? `requested ${requested}, using ${ANALYTICS_MAX_DAYS}` : null,
      error: result.error ?? null,
      /** Per-template totals across the window. */
      templates: totals,
      totals: totals.reduce(
        (acc, t) => {
          acc.clicks += t.clicks
          acc.uniqueClicks += t.uniqueClicks
          acc.sentByUs += t.sentByUs
          return acc
        },
        { clicks: 0, uniqueClicks: 0, sentByUs: 0 }
      ),
      /** Per-day click rows, newest first, for a chart. */
      daily: result.rows.map((r) => ({ ...r, template: idToName.get(r.templateId) || r.templateId })),
      note:
        `Meta reports clicks per template per day, not per recipient, and truncates a response at ` +
        `~${ANALYTICS_MAX_DATA_POINTS} data points (which is why these are fetched one template at ` +
        `a time and the window is capped at ${ANALYTICS_MAX_DAYS} days). To attribute a click to a ` +
        `specific person, enable CTA_TRACK_BASE_URL.`,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

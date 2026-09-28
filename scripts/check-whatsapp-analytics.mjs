/**
 * Meta template analytics — how many people clicked our buttons.
 *
 *   node --env-file=.env scripts/check-whatsapp-analytics.mjs [days]
 *
 * Reads Meta's own template analytics for the templates our WhatsApp nudges use. Needs NO
 * template change and NO redirect: Meta counts URL-button taps itself.
 *
 * What it gives: sent / delivered / read / clicks / unique clicks per template per day.
 * What it cannot give: WHO clicked. The data is per template per day; per-person attribution
 * needs the redirect tracker (CTA_TRACK_BASE_URL).
 *
 * Uses the same module as GET /api/whatsapp/analytics. Read-only.
 */
import { db } from '../src/lib/db.ts'
import { analyticsConfig, fetchTemplateClickAnalytics, ANALYTICS_MAX_DAYS, ANALYTICS_MAX_DATA_POINTS } from '../src/lib/meta-template-analytics.ts'

const days = Math.min(Number(process.argv[2]) || 7, ANALYTICS_MAX_DAYS)
const { token, wabaId, version } = analyticsConfig()

if (!token || !wabaId) {
  console.log('❌ WHATSAPP_TOKEN / WHATSAPP_WABA_ID are not set.')
  process.exit(1)
}

// Which templates do our WhatsApp nudges actually reference?
const nudges = await db.nudge.findMany({
  where: { channel: 'whatsapp', whatsappTemplateName: { not: null } },
  select: { key: true, whatsappTemplateName: true },
})

const listRes = await fetch(
  `https://graph.facebook.com/${version}/${wabaId}/message_templates?fields=name,id,status,category&limit=200`,
  { headers: { authorization: `Bearer ${token}` } }
)
const list = await listRes.json()
if (list.error) {
  console.log(`❌ Could not list templates: ${list.error.message}`)
  process.exit(1)
}

const byName = new Map(list.data.map((t) => [t.name, t]))
const wanted = [...new Set(nudges.map((n) => n.whatsappTemplateName))]
const resolved = wanted.map((name) => ({ name, meta: byName.get(name) })).filter((x) => x.meta)

console.log(`WhatsApp button clicks — last ${days} day(s)`)
console.log(`WABA ${wabaId} · ${resolved.length} template(s)\n`)
console.log(`Meta caps a response at ~${ANALYTICS_MAX_DATA_POINTS} data points and silently drops the rest,`)
console.log(`so this asks for ONE template at a time (window capped at ${ANALYTICS_MAX_DAYS} days).\n`)

if (!resolved.length) {
  console.log('No templates referenced by WhatsApp nudges.')
  await db.$disconnect()
  process.exit(0)
}

const result = await fetchTemplateClickAnalytics({ templateIds: resolved.map((r) => r.meta.id), days })
if (!result.ok && result.error) console.log(`⚠️  ${result.error}\n`)

// Clicks come from Meta (it counts them; we cannot). Sent/read come from our own log table, which
// is more accurate and free.
const clickTotals = new Map()
for (const row of result.rows) {
  const t = clickTotals.get(row.templateId) ?? { clicks: 0, uniqueClicks: 0, labels: new Set() }
  t.clicks += row.clicks
  t.uniqueClicks += row.uniqueClicks
  for (const l of row.buttonLabels) t.labels.add(l)
  clickTotals.set(row.templateId, t)
}

const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
const ownCounts = await db.messageLog.groupBy({
  by: ['templateName'],
  where: { channel: 'whatsapp', createdAt: { gte: since } },
  _count: { _all: true },
})
const sentByTemplate = new Map(ownCounts.map((r) => [r.templateName, r._count._all]))

console.log('  template                                status    sent*  clicks  unique  button')
let totalClicks = 0
let totalUnique = 0
for (const r of resolved) {
  const c = clickTotals.get(r.meta.id) ?? { clicks: 0, uniqueClicks: 0, labels: new Set() }
  totalClicks += c.clicks
  totalUnique += c.uniqueClicks
  console.log(
    `  ${r.name.padEnd(38)} ${String(r.meta.status).padEnd(9)} ${String(sentByTemplate.get(r.name) ?? 0).padStart(5)} ${String(c.clicks).padStart(7)} ${String(c.uniqueClicks).padStart(7)}  ${[...c.labels].join(', ') || '—'}`
  )
}
console.log('  * sent = from our own log table; clicks = from Meta\n')

const daily = result.rows.filter((r) => r.clicks > 0)
if (daily.length) {
  console.log('Days with clicks:')
  const nameOf = new Map(resolved.map((r) => [r.meta.id, r.name]))
  for (const r of daily) {
    console.log(`  ${r.day}  ${String(nameOf.get(r.templateId) || r.templateId).padEnd(38)} clicks ${String(r.clicks).padStart(4)}  unique ${String(r.uniqueClicks).padStart(4)}`)
  }
  console.log()
}

console.log(`Total button clicks: ${totalClicks} (${totalUnique} unique people)`)
if (!totalClicks) {
  console.log('No clicks recorded. Either nobody tapped, the templates carry no URL button,')
  console.log('or the window is too short — Meta reports these with a delay of a few hours.')
}
console.log('\nNote: Meta reports clicks per TEMPLATE per day, not per recipient.')
console.log('To attribute a click to a specific person, enable CTA_TRACK_BASE_URL.')

await db.$disconnect()

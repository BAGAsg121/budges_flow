/**
 * Print the per-family engagement split straight from the database.
 *
 *   node --env-file=.env scripts/report-engagement-split.mjs [days]
 *
 * This is the ground truth behind the dashboard's two family cards and their charts. It
 * exists so the split can be checked independently of the UI — the charts were once fed a
 * single combined series and looked identical for both families, which no screen could reveal.
 *
 * Read-only.
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const days = Number(process.argv[2]) || 7

const FAMILIES = [
  { label: 'Not transacting', keys: ['onboarded_not_transacting', 'whatsapp_onboarded_not_transacting'] },
  { label: 'Transacting', keys: ['onboarded_transacting', 'whatsapp_onboarded_transacting'] },
]

console.log(`Per-family engagement, last ${days} day(s)\n` + '='.repeat(52))

for (const family of FAMILIES) {
  const keys = family.keys.map((k) => `'${k}'`).join(',')
  const rows = await db.$queryRawUnsafe(`
    SELECT n.key AS nudge_key,
           l.channel AS channel,
           DATE(DATE_ADD(l.createdAt, INTERVAL 330 MINUTE)) AS ist_day,
           SUM(l.sentOk = 1) AS sent,
           SUM(l.sentOk = 0) AS failed,
           SUM(l.opened = 1) AS opened,
           SUM(l.replied = 1) AS replied
    FROM nudge_message_log l
    JOIN nudge_config n ON n.id = l.nudgeId
    WHERE n.key IN (${keys})
      AND l.createdAt >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
    GROUP BY n.key, l.channel, ist_day
    ORDER BY ist_day, n.key
  `)

  console.log(`\n── ${family.label}`)
  if (!rows.length) {
    console.log('   no activity in this window')
    continue
  }

  let totals = { sent: 0, failed: 0, opened: 0, replied: 0 }
  for (const r of rows) {
    const sent = Number(r.sent)
    const failed = Number(r.failed)
    const opened = Number(r.opened)
    const replied = Number(r.replied)
    totals.sent += sent
    totals.failed += failed
    totals.opened += opened
    totals.replied += replied
    const day = r.ist_day instanceof Date ? r.ist_day.toISOString().slice(0, 10) : String(r.ist_day).slice(0, 10)
    const ch = String(r.channel).padEnd(8)
    console.log(
      `   ${day}  ${ch} ${String(r.nudge_key).padEnd(36)} sent ${String(sent).padStart(4)}  failed ${String(failed).padStart(4)}  opened ${String(opened).padStart(4)}  replied ${String(replied).padStart(3)}`
    )
  }
  console.log(
    `   TOTAL      sent ${String(totals.sent).padStart(4)}  failed ${String(totals.failed).padStart(4)}  opened ${String(totals.opened).padStart(4)}  replied ${String(totals.replied).padStart(3)}`
  )
}

console.log('\nIf the two families above show the same numbers, the split is broken.')

await db.$disconnect()

/**
 * Why are sends failing? Groups every MessageLog failure by channel and error text.
 *
 *   node --env-file=.env scripts/diagnose-sends.mjs [--recent N]
 *
 * Read-only.
 */
import { PrismaClient } from '@prisma/client'
import { explainWhatsAppError } from '../src/lib/whatsapp-errors.ts'

const db = new PrismaClient()
const args = process.argv.slice(2)
const recentIdx = args.indexOf('--recent')
const recentCount = recentIdx >= 0 ? Number(args[recentIdx + 1]) || 10 : 10

const clean = (rows) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])))

console.log('Send diagnostics\n================\n')

const total = await db.messageLog.count()
const byChannel = await db.$queryRawUnsafe(
  'SELECT channel, COUNT(*) AS n, SUM(sentOk) AS ok FROM nudge_message_log GROUP BY channel'
)
console.log('totals per channel:', JSON.stringify(clean(byChannel)), `(all logs: ${total})`)

const byStatus = await db.$queryRawUnsafe(
  'SELECT channel, engagementStatus, COUNT(*) AS n FROM nudge_message_log GROUP BY channel, engagementStatus ORDER BY channel, n DESC'
)
console.log('\nby engagement status:')
for (const r of clean(byStatus)) console.log(`  ${String(r.channel).padEnd(9)} ${String(r.engagementStatus).padEnd(8)} ${r.n}`)

for (const channel of ['email', 'whatsapp']) {
  const rows = await db.$queryRawUnsafe(
    'SELECT sendError, COUNT(*) AS n, MIN(createdAt) AS first, MAX(createdAt) AS last FROM nudge_message_log WHERE channel = ? AND sentOk = 0 GROUP BY sendError ORDER BY n DESC LIMIT 15',
    channel
  )
  console.log(`\n${channel.toUpperCase()} failures grouped by error (${clean(rows).length} distinct):`)
  if (!rows.length) console.log('  none 🎉')
  for (const r of clean(rows)) {
    console.log(`  ${String(r.n).padStart(5)}×  ${String(r.sendError || '(empty)').slice(0, 150)}`)
    const help = explainWhatsAppError(r.sendError)
    if (help && channel === 'whatsapp') console.log(`         ↳ ${help.label}: ${help.detail}`)
    console.log(`         first ${r.first}  last ${r.last}`)
  }
}

console.log(`\nmost recent ${recentCount} attempts:`)
const recent = await db.messageLog.findMany({
  orderBy: { createdAt: 'desc' },
  take: recentCount,
  select: { channel: true, sentOk: true, engagementStatus: true, toEmail: true, toPhone: true, subject: true, templateName: true, sendError: true, createdAt: true },
})
for (const l of recent) {
  const to = l.toEmail || l.toPhone || '?'
  console.log(
    `  ${l.createdAt.toISOString()} ${String(l.channel).padEnd(9)} ${l.sentOk ? 'OK  ' : 'FAIL'} ${String(l.engagementStatus).padEnd(8)} ${String(to).padEnd(34)} ${(l.sendError || l.subject || l.templateName || '').slice(0, 80)}`
  )
}

const env = {
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_SECURE: process.env.SMTP_SECURE,
  SMTP_USER: process.env.SMTP_USER ? 'set' : 'MISSING',
  SMTP_PASS: process.env.SMTP_PASS ? 'set' : 'MISSING',
  MAIL_FROM: process.env.MAIL_FROM,
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN ? 'set' : 'MISSING',
  WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || 'MISSING',
}
console.log('\nlocal env:', JSON.stringify(env, null, 2))

await db.$disconnect()

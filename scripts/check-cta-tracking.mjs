/**
 * Did we record a CTA click?
 *
 *   node --env-file=.env scripts/check-cta-tracking.mjs [phone-or-email] [--limit N]
 *
 * Prints, for the most recent sends to that recipient: where the button pointed, how many clicks
 * were recorded and when. This is the ground truth behind the Logs tab's CTA badge, and the
 * fastest way to tell "not tracked" apart from "tracked and not clicked".
 *
 * Also states whether tracking is even switched on in this environment, because that is the most
 * common reason a click leaves no trace.
 *
 * Read-only.
 */
import { db } from '../src/lib/db.ts'
import { isCtaTrackingEnabled, ctaTrackBaseUrl } from '../src/lib/cta.ts'

const args = process.argv.slice(2)
const target = args.find((a) => !a.startsWith('--')) || ''
const limitIdx = args.indexOf('--limit')
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 10 : 10

console.log('CTA click tracking\n==================')
console.log(`  CTA_TRACK_BASE_URL   ${ctaTrackBaseUrl() || '(empty)'}`)
console.log(`  tracking enabled     ${isCtaTrackingEnabled() ? 'YES' : 'NO — buttons point straight at the destination, so clicks cannot be seen'}`)

const digits = target.replace(/\D/g, '')

const where = target
  ? {
      OR: [
        ...(digits ? [{ toPhone: { contains: digits } }] : []),
        { toEmail: { contains: target } },
      ],
    }
  : {}

const rows = await db.messageLog.findMany({
  where,
  orderBy: { createdAt: 'desc' },
  take: limit,
  select: {
    createdAt: true,
    channel: true,
    toPhone: true,
    toEmail: true,
    sentOk: true,
    sendError: true,
    templateName: true,
    trackingId: true,
    ctaUrl: true,
    ctaClicks: true,
    ctaClickedAt: true,
    nudge: { select: { key: true, name: true } },
  },
})

console.log(`\nMost recent ${rows.length} row(s)${target ? ` for "${target}"` : ''}:\n`)

if (!rows.length) {
  console.log('  no rows found')
} else {
  for (const r of rows) {
    const ist = new Date(r.createdAt.getTime() + 330 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    console.log(`${ist} IST  ${r.channel.padEnd(9)} ${r.sentOk ? 'sent ' : 'FAIL '} ${r.nudge.key}`)
    console.log(`   to            ${r.toPhone || r.toEmail}`)
    console.log(`   template      ${r.templateName || '(free-form)'}`)
    console.log(`   button points ${r.ctaUrl || '(not recorded — this send predates CTA tracking, or the template has no button)'}`)
    console.log(
      `   CTA clicks    ${r.ctaClicks}` +
        (r.ctaClickedAt
          ? `   first ${new Date(r.ctaClickedAt.getTime() + 330 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)} IST`
          : '   (never)')
    )
    if (!r.sentOk) console.log(`   error         ${r.sendError}`)
    console.log(`   tracking id   ${r.trackingId}`)
    console.log(`   tracker URL   ${ctaTrackBaseUrl() ? `${ctaTrackBaseUrl()}/${r.trackingId}` : '(tracking off)'}`)
    console.log()
  }
}

const withClicks = await db.messageLog.count({ where: { ctaClicks: { gt: 0 } } })
const withDestination = await db.messageLog.count({ where: { NOT: { ctaUrl: null } } })
console.log('Across the whole log table:')
console.log(`  rows with a recorded button destination : ${withDestination}`)
console.log(`  rows with at least one recorded click   : ${withClicks}`)

await db.$disconnect()

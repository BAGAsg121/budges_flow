/**
 * Turn every nudge on or off in one go — the fastest way to stop or resume all outbound
 * sending without touching the host's environment variables.
 *
 *   node --env-file=.env scripts/toggle-nudges.mjs off     # pause everything
 *   node --env-file=.env scripts/toggle-nudges.mjs on      # resume
 *   node --env-file=.env scripts/toggle-nudges.mjs status  # just report
 *
 * The scheduler only runs nudges that are enabled, so `off` stops it immediately on its
 * next cycle. The deployed build may predate the fix that skips manual/sheet nudges, so
 * `off` disables ALL of them rather than only the lead-driven ones.
 *
 * The DB is the source of truth, so this takes effect without a redeploy.
 * Note: `on` re-enables everything, including the manual sheet nudges.
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const mode = (process.argv[2] || 'status').toLowerCase()

const before = await db.nudge.findMany({
  select: { key: true, name: true, channel: true, enabled: true, zohoCriteria: true },
  orderBy: { createdAt: 'asc' },
})

if (mode === 'off' || mode === 'on') {
  const enabled = mode === 'on'
  const { count } = await db.nudge.updateMany({ data: { enabled } })
  console.log(`${enabled ? 'ENABLED' : 'DISABLED'} ${count} nudge(s).\n`)
} else if (mode !== 'status') {
  console.error(`Unknown mode "${mode}" — use on | off | status`)
  await db.$disconnect()
  process.exit(1)
}

const after = await db.nudge.findMany({
  select: { key: true, channel: true, enabled: true, zohoCriteria: true },
  orderBy: { createdAt: 'asc' },
})

console.log('nudges:')
for (const n of after) {
  const kind = n.zohoCriteria ? 'lead-driven' : 'manual/sheet'
  console.log(`  ${n.enabled ? '🟢 ON ' : '⚪ OFF'}  ${n.key.padEnd(28)} ${n.channel.padEnd(9)} ${kind}`)
}

const activeLeadDriven = after.filter((n) => n.enabled && n.zohoCriteria).length
const activeManual = after.filter((n) => n.enabled && !n.zohoCriteria).length
console.log(
  `\nactive: ${activeLeadDriven} lead-driven, ${activeManual} manual/sheet` +
    (activeLeadDriven + activeManual === 0 ? '  → scheduler has nothing to send ✅' : '')
)
if (before.some((b, i) => b.enabled !== after[i]?.enabled)) {
  console.log('(changed — the running app picks this up on its next cycle, no redeploy needed)')
}

await db.$disconnect()

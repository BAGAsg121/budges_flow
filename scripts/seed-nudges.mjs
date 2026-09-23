/**
 * Create the built-in nudges (create-if-missing) and report who each one targets.
 *
 *   node --env-file=.env scripts/seed-nudges.mjs
 *   node --env-file=.env scripts/seed-nudges.mjs --force   # also refresh templates on existing rows
 *
 * Create-if-missing is the default so that edits made in the UI are never silently
 * reverted. --force is opt-in and overwrites the template/filter fields only.
 */
import { PrismaClient } from '@prisma/client'
import { DEFAULT_NUDGES, LEAD_STATUS, KYC_COMPLETE_AT, ZOHO_CRITERIA } from '../src/lib/nudge-defaults.ts'
import { collectMysqlRecipients, isMysqlFlowKey } from '../src/lib/mysql-nudges.ts'
import { closeSbPool } from '../src/lib/sb-db.ts'

const db = new PrismaClient()
const force = process.argv.includes('--force')

console.log('Zoho fetch criteria:')
console.log('  ' + ZOHO_CRITERIA)
console.log('  (EPS leads created after ' + ZOHO_CRITERIA.match(/greater_than:([^)]+)/)?.[1] + ' — no KYC or status filter at fetch time)\n')

for (const seed of DEFAULT_NUDGES) {
  const existing = await db.nudge.findUnique({ where: { key: seed.key }, select: { id: true, enabled: true } })

  if (!existing) {
    await db.nudge.create({ data: seed })
    console.log(`created   ${seed.key}  (${seed.channel}, enabled=${seed.enabled})`)
  } else if (force) {
    const { key, ...rest } = seed
    await db.nudge.update({ where: { key }, data: rest })
    console.log(`updated   ${seed.key}  (--force)`)
  } else {
    console.log(`exists    ${seed.key}  (left untouched — use --force to refresh)`)
  }
}

// ---- who would each nudge target? -----------------------------------------
const withEmail = { email: { not: null } }
const parse = (s) => {
  try {
    return JSON.parse(s || '{}')
  } catch {
    return {}
  }
}

console.log('\nTargeting preview (live lead data):')
const all = await db.nudge.findMany({ orderBy: { createdAt: 'asc' } })
for (const n of all) {
  const f = parse(n.filters)

  // MySQL-driven flows: run the real collector so the numbers are live.
  if (f.source === 'mysql') {
    if (!isMysqlFlowKey(f.flow)) {
      console.log(`  ${n.key.padEnd(30)} ⚠️  source=mysql but filters.flow is invalid`)
      continue
    }
    try {
      const recipients = await collectMysqlRecipients(f.flow, {
        lookbackHours: f.lookbackHours,
        lookbackDays: f.lookbackDays,
      })
      const withPhone = recipients.filter((r) => r.phone)
      const window = f.lookbackHours ? `last ${f.lookbackHours}h` : `last ${f.lookbackDays} days`
      const sample = withPhone.slice(0, 3).map((r) => r.phone).join(', ')
      console.log(
        `  ${n.key.padEnd(30)} ${String(withPhone.length).padStart(4)} recipient(s)  · MySQL ${f.flow} · ${window}` +
          (sample ? `  e.g. ${sample}` : '')
      )
    } catch (err) {
      console.log(`  ${n.key.padEnd(30)} ❌ query failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    continue
  }

  if (!n.zohoCriteria) {
    console.log(`  ${n.key.padEnd(30)} manual / sheet-driven — no lead targeting`)
    continue
  }
  // Channel-aware contact requirement, mirroring buildWhere(): email nudges need an
  // address, WhatsApp nudges need a phone (the test lead has no email on purpose).
  const and = []
  if (n.channel === 'email') and.push({ email: { not: null } })
  else and.push({ OR: [{ mobile: { not: null } }, { phone: { not: null } }] })

  const where = {}
  if (f.includeStatuses?.length) where.leadStatus = { in: f.includeStatuses }
  else if (f.excludeStatuses?.length) where.leadStatus = { notIn: f.excludeStatuses }
  if (f.maxKycCount !== undefined) {
    // A missing KYC value counts as 0 ("nothing uploaded yet"), so NULL is included
    // alongside `<= max`.
    and.push({ OR: [{ kycDocumentUploadCount: { lte: f.maxKycCount } }, { kycDocumentUploadCount: null }] })
  } else if (f.minKycCount !== undefined) {
    and.push({ kycDocumentUploadCount: { gte: f.minKycCount } })
  }
  if (and.length) where.AND = and

  const n_count = await db.lead.count({ where })
  const who = n.channel === 'email' ? 'with an email' : 'with a phone'
  console.log(`  ${n.key.padEnd(30)} ${String(n_count).padStart(4)} lead(s) ${who}  ${f.includeStatuses ? '· ' + f.includeStatuses.join(', ') : ''}${f.maxKycCount !== undefined ? ` · KYC <= ${f.maxKycCount} or unset` : ''}`)
}

// ---- lead data integrity ---------------------------------------------------
const total = await db.lead.count()
const dupZoho = await db.$queryRawUnsafe('SELECT zohoId, COUNT(*) AS n FROM nudge_lead GROUP BY zohoId HAVING n > 1')
const dupEmail = await db.$queryRawUnsafe(
  'SELECT email, COUNT(*) AS n FROM nudge_lead WHERE email IS NOT NULL GROUP BY email HAVING n > 1'
)
const missing = await db.$queryRawUnsafe(
  'SELECT SUM(leadStatus IS NULL) AS status_null, SUM(kycDocumentUploadCount IS NULL) AS kyc_null, SUM(createdTime IS NULL) AS created_null, SUM(email IS NULL) AS email_null FROM nudge_lead'
)
const clean = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])))

console.log(`\nLead integrity (${total} leads):`)
console.log('  rows missing status / kyc / createdTime / email:', JSON.stringify(clean(missing)[0]))
console.log('  duplicate zohoId groups:', dupZoho.length)
console.log('  duplicate email groups:', dupEmail.length)
const july = await db.$queryRawUnsafe(
  "SELECT COUNT(*) AS n FROM nudge_lead WHERE createdTime < '2026-08-01'"
)
const statuses = await db.$queryRawUnsafe(
  'SELECT leadStatus, COUNT(*) AS n FROM nudge_lead GROUP BY leadStatus ORDER BY n DESC'
)
console.log('  leads before 2026-08-01 (still in DB, not re-fetched):', clean(july)[0].n)
console.log('  statuses:', JSON.stringify(clean(statuses)))
console.log(`\nKYC complete threshold: ${KYC_COMPLETE_AT} · pending statuses: ${LEAD_STATUS.ONBOARDING_STARTED} / ${LEAD_STATUS.AGREEMENT_SIGNED}`)

// The MySQL pool keeps sockets open, which would hold the event loop alive.
await closeSbPool()
await db.$disconnect()

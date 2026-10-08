/**
 * Create the built-in nudges (create-if-missing) and report who each one targets.
 *
 *   node --env-file=.env scripts/seed-nudges.mjs
 *   node --env-file=.env scripts/seed-nudges.mjs --force                 # refresh every existing row
 *   node --env-file=.env scripts/seed-nudges.mjs --force --only dp_wa     # refresh ONE nudge
 *
 * Create-if-missing is the default so that edits made in the UI are never silently
 * reverted. --force is opt-in and overwrites the template/filter fields only; `enabled` is
 * operator state and is never touched.
 *
 * --only exists because --force rewrites EVERY nudge: changing one nudge's criteria should not
 * mean re-asserting the configuration of the other fifteen, some of which have been edited in the
 * UI. Pass one key or several comma-separated.
 */
import { PrismaClient } from '@prisma/client'
import { DEFAULT_NUDGES, LEAD_STATUS, KYC_COMPLETE_AT, ZOHO_CRITERIA } from '../src/lib/nudge-defaults.ts'
import { collectMysqlRecipients, isMysqlFlowKey } from '../src/lib/mysql-nudges.ts'
import { splitByKycMatch } from '../src/lib/kyc-match.ts'
import { previewNudge } from '../src/lib/nudge-engine.ts'
import { closeSbPool } from '../src/lib/sb-db.ts'

const db = new PrismaClient()
const force = process.argv.includes('--force')

const onlyArgIndex = process.argv.indexOf('--only')
const only = onlyArgIndex >= 0 ? new Set((process.argv[onlyArgIndex + 1] || '').split(',').map((s) => s.trim()).filter(Boolean)) : null
if (onlyArgIndex >= 0 && (!only || only.size === 0)) {
  console.error('--only needs at least one nudge key, e.g. --only documents_pending_wa')
  process.exit(2)
}

console.log('Zoho fetch criteria:')
console.log('  ' + ZOHO_CRITERIA)
console.log('  (EPS leads created after ' + ZOHO_CRITERIA.match(/greater_than:([^)]+)/)?.[1] + ' — no KYC or status filter at fetch time)\n')
if (only) console.log(`--only ${[...only].join(', ')} — every other nudge is left alone\n`)

for (const seed of DEFAULT_NUDGES) {
  if (only && !only.has(seed.key)) continue

  const existing = await db.nudge.findUnique({ where: { key: seed.key }, select: { id: true, enabled: true } })

  if (!existing) {
    await db.nudge.create({ data: seed })
    console.log(`created   ${seed.key}  (${seed.channel}, seeded ${seed.enabled ? 'ENABLED' : 'disabled'})`)
  } else if (force) {
    // `enabled` is OPERATOR STATE, not template configuration. Refreshing the copy must
    // never switch a nudge back on — that is exactly how a paused nudge kept re-enabling
    // itself every time this script ran with --force.
    const { key, enabled, ...rest } = seed
    await db.nudge.update({ where: { key }, data: rest })
    console.log(`updated   ${seed.key}  (--force; enabled left ${existing.enabled ? 'ON' : 'off'} as-is)`)
  } else {
    console.log(`exists    ${seed.key}  (left untouched — use --force to refresh the copy)`)
  }
}
if (only) {
  const missing = [...only].filter((k) => !DEFAULT_NUDGES.some((s) => s.key === k))
  if (missing.length) console.log(`\n⚠️  --only named keys that are not built-in nudges: ${missing.join(', ')}`)
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
  // The REAL selection path. This preview used to re-implement buildWhere(), and it silently stopped
  // agreeing with the send path the moment a filter field was added: the sandbox nudges filter on
  // ekoCode / signAgreement / kycUploadStatus / createdWithinDays, none of which the copy knew
  // about, so it reported ~1,819 leads where the nudge would message a handful. previewNudge() is
  // the same code a run uses, so the number cannot drift again.
  const preview = await previewNudge(n.id)
  const reasons = preview.wouldSkip.reduce((m, s) => m.set(s.reason, (m.get(s.reason) ?? 0) + 1), new Map())
  const reasonText = reasons.size
    ? `  · skipped ${[...reasons].map(([r, c]) => `${r}×${c}`).join(', ')}`
    : ''
  console.log(
    `  ${n.key.padEnd(30)} ${String(preview.wouldSend.length).padStart(4)} would send of ` +
      `${preview.leadsConsidered} considered${reasonText}`
  )
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

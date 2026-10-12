/**
 * Additive column on nudge_lead so the "documents need resubmission" rule can be evaluated.
 *
 *   node --env-file=.env scripts/add-kyc-reject-column.mjs          # report only
 *   node --env-file=.env scripts/add-kyc-reject-column.mjs --apply  # add the column
 *
 * WHY THIS COLUMN EXISTS: the new sandbox nudge fires when Zoho's KYC_Document_Reject_Count has a
 * real, non-zero value — i.e. one or more submitted documents were rejected and need resubmitting.
 * LEAD_FIELDS has always fetched that field (src/lib/zoho.ts), but nothing could evaluate it because
 * it was never STORED. Re-reading the CRM per lead at send time is exactly the per-lead CRM traffic
 * this app exists to avoid, so it is synced into a column like every other filterable field.
 *
 * Nothing is backfilled: existing rows keep NULL until their next sync fills the column. NULL means
 * "the CRM did not tell us" and 0 means "nothing rejected" — the nudge fires on `> 0` only, so both
 * are correctly silent and an unsynced lead can never be messaged by mistake.
 *
 * Safety contract (same as add-kyc-expected-column.mjs / add-cta-columns.mjs):
 *   * ONLY `ALTER TABLE nudge_lead ADD COLUMN` — additive, never a DROP, MODIFY, RENAME or DELETE,
 *     and it touches no other table.
 *   * Idempotent: a column that already exists is reported and skipped.
 *   * Dry-run by default; pass --apply to change anything.
 */
import mysql from 'mysql2/promise'

const apply = process.argv.includes('--apply')

const host = process.env.SB_WRITE_HOST || process.env.SB_READ_HOST
const config = {
  host,
  port: Number(process.env.SB_PORT || 3306),
  user: process.env.SB_USER,
  password: process.env.SB_PASSWORD,
  database: process.env.SB_NAME,
  connectTimeout: 15000,
}

if (!host || !config.user || !config.password || !config.database) {
  console.error('SB_* env vars are not set')
  process.exit(1)
}

const TABLE = 'nudge_lead'

const COLUMNS = [
  [
    'kycDocumentRejectCount',
    'INT NULL',
    'Zoho KYC_Document_Reject_Count — documents rejected and needing resubmission (nudge fires on > 0)',
  ],
]

const statements = COLUMNS.map(([name, type]) => ({
  name,
  sql: `ALTER TABLE \`${TABLE}\` ADD COLUMN \`${name}\` ${type}`,
}))

// hard stop unless every statement is a single additive ADD COLUMN
for (const s of statements) {
  if (!/^ALTER TABLE `nudge_lead` ADD COLUMN `/i.test(s.sql)) {
    console.error(`Refusing to run a non-additive statement: ${s.sql}`)
    process.exit(1)
  }
  if (/\b(DROP|MODIFY|CHANGE|RENAME|TRUNCATE|DELETE|UPDATE)\b/i.test(s.sql)) {
    console.error(`Refusing to run: statement contains a destructive keyword — ${s.sql}`)
    process.exit(1)
  }
}

const conn = await mysql.createConnection(config)
try {
  const [existingRows] = await conn.query(
    'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [config.database, TABLE]
  )
  const existing = new Set(existingRows.map((r) => r.name))

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — additive columns on ${config.database}.${TABLE}\n`)

  let added = 0
  for (const s of statements) {
    const meta = COLUMNS.find(([n]) => n === s.name)
    if (existing.has(s.name)) {
      console.log(`  exists    ${s.name}  (${meta[2]})`)
      continue
    }
    if (!apply) {
      console.log(`  would add ${s.name}  ${meta[1]}  — ${meta[2]}`)
      continue
    }
    await conn.query(s.sql)
    added++
    console.log(`  ✅ added   ${s.name}  ${meta[1]}  — ${meta[2]}`)
  }

  const [afterRows] = await conn.query(
    'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [config.database, TABLE]
  )
  console.log(`\n${TABLE} now has ${afterRows.length} columns.`)
  if (!apply && !added) console.log('\nRe-run with --apply to make the change.')
} finally {
  await conn.end()
}

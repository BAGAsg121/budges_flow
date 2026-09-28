/**
 * Additive columns on nudge_message_log so a WhatsApp URL-button click can be attributed.
 *
 *   node --env-file=.env scripts/add-cta-columns.mjs          # report only
 *   node --env-file=.env scripts/add-cta-columns.mjs --apply  # add the columns
 *
 * WHY THESE COLUMNS EXIST: Meta does NOT webhook a URL-button click. Only quick-reply and list
 * replies come back as inbound messages (those are already stored in inboundText). To know WHO
 * clicked, the button's URL has to point at this app, which records the click and redirects to
 * the real destination. That needs the destination stored per message at send time — hence
 * ctaUrl — plus a counter.
 *
 * Safety contract (same as add-inbound-columns.mjs / create-nudge-tables.mjs):
 *   * ONLY `ALTER TABLE nudge_message_log ADD COLUMN` — additive, never a DROP, MODIFY, RENAME
 *     or DELETE, and never touches any other table.
 *   * Idempotent: a column that already exists is reported and skipped.
 *   * Dry-run by default; you must pass --apply to change anything.
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

const TABLE = 'nudge_message_log'

const COLUMNS = [
  ['ctaUrl', 'TEXT NULL', 'the destination the WhatsApp URL button should reach, stored per send'],
  ['ctaClicks', 'INT NOT NULL DEFAULT 0', 'how many times the tracked button URL was opened'],
  ['ctaClickedAt', 'DATETIME(3) NULL', 'when the first click arrived'],
]

// hard stop unless every statement is a single additive ADD COLUMN
const statements = COLUMNS.map(([name, type]) => ({
  name,
  sql: `ALTER TABLE \`${TABLE}\` ADD COLUMN \`${name}\` ${type}`,
}))

for (const s of statements) {
  if (!/^ALTER TABLE `nudge_message_log` ADD COLUMN `/i.test(s.sql)) {
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
  if (!apply && !added) console.log('\nRe-run with --apply to make the changes.')
} finally {
  await conn.end()
}

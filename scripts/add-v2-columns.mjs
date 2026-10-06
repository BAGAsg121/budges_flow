/**
 * V2 — additive columns on nudge_lead for engagement scoring and journey tracking.
 *
 *   node --env-file=.env scripts/add-v2-columns.mjs          # report only
 *   node --env-file=.env scripts/add-v2-columns.mjs --apply  # add the columns
 *
 * WHY: V2 answers "did it work?" rather than "what did we send?". That needs, per lead, a score
 * (engagementScore + its breakdown), the clock for time-to-conversion (firstNudgeSentAt), and the
 * timestamp that makes time-in-stage computable (lastStatusChangedAt).
 *
 * NOTHING IS BACKFILLED, deliberately. `firstNudgeSentAt` is derivable from nudge_message_log and
 * `lastStatusChangedAt` from the stage history, so both could be filled in from existing data — but
 * a backfill would invent history that was never observed. A NULL means "not known yet", and the
 * reports treat it that way: `totalDaysToConvert` stays NULL until a change is actually detected.
 * The score IS computed from existing logs, because that is a pure function of data we already hold.
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
  ['engagementScore', 'INT NOT NULL DEFAULT 0', 'V2 0..SCORE_MAX engagement score, recomputed on sync'],
  ['scoreLastCalculatedAt', 'DATETIME(3) NULL', 'when the score was last recomputed'],
  ['scoreBreakdown', 'TEXT NULL', 'JSON per-signal point totals, for the UI breakdown panel'],
  ['firstNudgeSentAt', 'DATETIME(3) NULL', 'first successful send ever — the time-to-conversion clock'],
  ['lastStatusChangedAt', 'DATETIME(3) NULL', 'when leadStatus last changed, for time-in-stage'],
  ['totalDaysToConvert', 'DOUBLE NULL', 'days from firstNudgeSentAt to the converted stage'],
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

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — V2 columns on ${config.database}.${TABLE}\n`)

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

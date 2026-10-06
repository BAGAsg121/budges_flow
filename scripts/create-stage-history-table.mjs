/**
 * V2 — create the ONE new table: nudge_lead_stage_history.
 *
 *   node --env-file=.env scripts/create-stage-history-table.mjs          # report only
 *   node --env-file=.env scripts/create-stage-history-table.mjs --apply  # create it
 *
 * WHY A NEW TABLE: V2's whole point is the lead journey — where a lead was when we messaged it and
 * where it went after. That is a time series, not a column: one row per detected CRM stage
 * transition, attributed (probabilistically) to the last nudge sent before it.
 *
 * This is deliberately a SEPARATE script from create-nudge-tables.mjs. That one documents itself as
 * creating "EXACTLY three tables" and is the reference for the original app schema; adding a fourth
 * table to it would make both statements untrue. This script creates exactly one, and only if it is
 * missing.
 *
 * Safety contract:
 *   * Creates EXACTLY one table: nudge_lead_stage_history.
 *   * `CREATE TABLE IF NOT EXISTS` -> re-running is a no-op; an existing table is never touched.
 *   * Contains NO DROP, NO ALTER, NO TRUNCATE, NO DELETE. It cannot modify or remove any data.
 *   * `nudge_` prefix so it cannot collide with a business table.
 *   * Dry-run by default; pass --apply to create it.
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

const TABLE = 'nudge_lead_stage_history'
const CHARSET = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'

const SQL = `CREATE TABLE IF NOT EXISTS \`${TABLE}\` (
  \`id\` VARCHAR(191) NOT NULL,
  \`leadId\` VARCHAR(191) NOT NULL,
  \`fromStatus\` VARCHAR(191) NULL,
  \`toStatus\` VARCHAR(191) NOT NULL,
  \`detectedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`triggeredByNudgeId\` VARCHAR(191) NULL,
  \`triggeredByMessageLogId\` VARCHAR(191) NULL,
  \`timeInPrevStageHours\` DOUBLE NULL,
  \`hoursSinceNudge\` DOUBLE NULL,
  \`attributedMessageNumber\` INT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`nudge_lead_stage_history_leadId_detectedAt_idx\` (\`leadId\`, \`detectedAt\`),
  KEY \`nudge_lead_stage_history_toStatus_idx\` (\`toStatus\`),
  KEY \`nudge_lead_stage_history_triggeredByNudgeId_idx\` (\`triggeredByNudgeId\`),
  KEY \`nudge_lead_stage_history_detectedAt_idx\` (\`detectedAt\`),
  CONSTRAINT \`nudge_lead_stage_history_leadId_fkey\` FOREIGN KEY (\`leadId\`) REFERENCES \`nudge_lead\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT \`nudge_lead_stage_history_nudgeId_fkey\` FOREIGN KEY (\`triggeredByNudgeId\`) REFERENCES \`nudge_config\` (\`id\`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT \`nudge_lead_stage_history_logId_fkey\` FOREIGN KEY (\`triggeredByMessageLogId\`) REFERENCES \`nudge_message_log\` (\`id\`) ON DELETE SET NULL ON UPDATE CASCADE
) ${CHARSET}`

if (!/^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s/i.test(SQL)) {
  console.error('Refusing to run: not a CREATE TABLE IF NOT EXISTS statement.')
  process.exit(1)
}
if (/\b(DROP|TRUNCATE|RENAME)\b|\bALTER\s+TABLE\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/i.test(SQL)) {
  console.error('Refusing to run: statement contains a destructive operation.')
  process.exit(1)
}

const conn = await mysql.createConnection(config)
try {
  const [before] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [config.database, TABLE]
  )
  const existed = Number(before[0].n) > 0

  // The FK targets must exist, or the CREATE fails halfway through a migration.
  for (const dep of ['nudge_lead', 'nudge_config', 'nudge_message_log']) {
    const [r] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [config.database, dep]
    )
    if (Number(r[0].n) === 0) {
      console.error(`Refusing to run: required table ${dep} does not exist in ${config.database}. Run npm run db:create-tables first.`)
      process.exit(1)
    }
  }

  if (existed) {
    console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — ${config.database}.${TABLE}\n`)
    console.log('  already exists (untouched)')
  } else if (!apply) {
    console.log(`DRY RUN — ${config.database}.${TABLE}\n`)
    console.log(`  would create ${TABLE} with a leadId FK, an optional nudge FK and an optional message-log FK.`)
    console.log('\nRe-run with --apply to create it.')
  } else {
    console.log(`APPLYING — ${config.database}.${TABLE}\n`)
    await conn.query(SQL)
    console.log(`  ✅ created ${TABLE}`)
  }

  const [after] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [config.database, TABLE]
  )
  console.log(`\n${TABLE} has ${after[0].n} columns.`)
} finally {
  await conn.end()
}

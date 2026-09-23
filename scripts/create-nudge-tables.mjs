/**
 * ONE-TIME table creation for the app's own three tables, inside the Simplibank
 * MySQL database.
 *
 *   node --env-file=.env scripts/create-nudge-tables.mjs
 *
 * Safety contract:
 *   * Creates EXACTLY three tables: nudge_lead, nudge_config, nudge_message_log.
 *   * Every statement is CREATE TABLE IF NOT EXISTS -> running it again is a no-op.
 *   * It contains NO DROP, NO ALTER, NO TRUNCATE, NO DELETE. It can never remove
 *     or modify existing data or any other table.
 *   * Table names are prefixed `nudge_` so they cannot collide with existing
 *     business tables (the database already contains its own `messagelog`).
 */
import mysql from 'mysql2/promise'

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

const CHARSET = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'

const STATEMENTS = [
  ['nudge_lead', `CREATE TABLE IF NOT EXISTS \`nudge_lead\` (
  \`id\` VARCHAR(191) NOT NULL,
  \`zohoId\` VARCHAR(191) NOT NULL,
  \`fullName\` VARCHAR(191) NULL,
  \`firstName\` VARCHAR(191) NULL,
  \`lastName\` VARCHAR(191) NULL,
  \`email\` VARCHAR(191) NULL,
  \`phone\` VARCHAR(191) NULL,
  \`mobile\` VARCHAR(191) NULL,
  \`company\` VARCHAR(191) NULL,
  \`businessVertical\` VARCHAR(191) NULL,
  \`leadStatus\` VARCHAR(191) NULL,
  \`createdTime\` DATETIME(3) NULL,
  \`kycDocumentUploadCount\` INT NULL,
  \`ekoCode\` VARCHAR(191) NULL,
  \`ownerName\` VARCHAR(191) NULL,
  \`city\` VARCHAR(191) NULL,
  \`state\` VARCHAR(191) NULL,
  \`country\` VARCHAR(191) NULL,
  \`leadSource\` VARCHAR(191) NULL,
  \`lastActivityTime\` DATETIME(3) NULL,
  \`lastSyncedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`nudge_lead_zohoId_key\` (\`zohoId\`),
  KEY \`nudge_lead_leadStatus_idx\` (\`leadStatus\`),
  KEY \`nudge_lead_businessVertical_idx\` (\`businessVertical\`)
) ${CHARSET}`],

  ['nudge_config', `CREATE TABLE IF NOT EXISTS \`nudge_config\` (
  \`id\` VARCHAR(191) NOT NULL,
  \`key\` VARCHAR(191) NOT NULL,
  \`name\` VARCHAR(191) NOT NULL,
  \`description\` TEXT NULL,
  \`enabled\` TINYINT(1) NOT NULL DEFAULT 1,
  \`channel\` VARCHAR(191) NOT NULL DEFAULT 'email',
  \`zohoCriteria\` TEXT NULL,
  \`filters\` TEXT NOT NULL,
  \`subjectTemplate\` TEXT NULL,
  \`bodyTemplate\` LONGTEXT NULL,
  \`whatsappTemplateName\` VARCHAR(191) NULL,
  \`whatsappLanguage\` VARCHAR(191) NULL,
  \`whatsappParams\` TEXT NULL,
  \`maxEmailsPerLead\` INT NOT NULL DEFAULT 1,
  \`followUpDays\` INT NOT NULL DEFAULT 0,
  \`lastRunAt\` DATETIME(3) NULL,
  \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`updatedAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`nudge_config_key_key\` (\`key\`)
) ${CHARSET}`],

  ['nudge_message_log', `CREATE TABLE IF NOT EXISTS \`nudge_message_log\` (
  \`id\` VARCHAR(191) NOT NULL,
  \`leadId\` VARCHAR(191) NULL,
  \`nudgeId\` VARCHAR(191) NOT NULL,
  \`channel\` VARCHAR(191) NOT NULL DEFAULT 'email',
  \`messageNumber\` INT NOT NULL DEFAULT 1,
  \`sheetRowRef\` VARCHAR(512) NULL,
  \`toEmail\` VARCHAR(191) NULL,
  \`toPhone\` VARCHAR(191) NULL,
  \`subject\` TEXT NULL,
  \`templateName\` VARCHAR(191) NULL,
  \`messageId\` VARCHAR(255) NULL,
  \`trackingId\` VARCHAR(191) NOT NULL,
  \`sentOk\` TINYINT(1) NOT NULL DEFAULT 0,
  \`sendError\` TEXT NULL,
  \`sentAt\` DATETIME(3) NULL,
  \`opened\` TINYINT(1) NOT NULL DEFAULT 0,
  \`opensCount\` INT NOT NULL DEFAULT 0,
  \`openedAt\` DATETIME(3) NULL,
  \`replied\` TINYINT(1) NOT NULL DEFAULT 0,
  \`repliedAt\` DATETIME(3) NULL,
  \`engagementStatus\` VARCHAR(191) NOT NULL DEFAULT 'sent',
  \`createdAt\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`nudge_message_log_trackingId_key\` (\`trackingId\`),
  KEY \`nudge_message_log_leadId_nudgeId_idx\` (\`leadId\`, \`nudgeId\`),
  KEY \`nudge_message_log_nudgeId_createdAt_idx\` (\`nudgeId\`, \`createdAt\`),
  KEY \`nudge_message_log_messageId_idx\` (\`messageId\`(191)),
  CONSTRAINT \`nudge_message_log_leadId_fkey\` FOREIGN KEY (\`leadId\`) REFERENCES \`nudge_lead\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT \`nudge_message_log_nudgeId_fkey\` FOREIGN KEY (\`nudgeId\`) REFERENCES \`nudge_config\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ${CHARSET}`],
]

// hard stop unless every statement is a pure CREATE TABLE IF NOT EXISTS.
// (ON DELETE CASCADE on a foreign key is a referential action, not a statement.)
for (const [name, sql] of STATEMENTS) {
  if (!/^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s/i.test(sql)) {
    console.error(`Refusing to run ${name}: not a CREATE TABLE IF NOT EXISTS statement.`)
    process.exit(1)
  }
  if (/\b(DROP|TRUNCATE|RENAME)\b|\bALTER\s+TABLE\b|\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/i.test(sql)) {
    console.error(`Refusing to run ${name}: statement contains a destructive operation.`)
    process.exit(1)
  }
}

const conn = await mysql.createConnection(config)
try {
  for (const [name, sql] of STATEMENTS) {
    const [before] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [config.database, name]
    )
    const existed = Number(before[0].n) > 0
    await conn.query(sql)
    console.log(`${existed ? 'already existed (untouched)' : 'created'}: ${name}`)
  }

  const [after] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
    [config.database]
  )
  console.log(`\ntotal tables in ${config.database}: ${after[0].n}`)
  console.log('created exactly the 3 nudge_* tables; nothing else was touched.')
} finally {
  await conn.end()
}

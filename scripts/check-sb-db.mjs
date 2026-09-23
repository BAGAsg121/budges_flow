/**
 * Connectivity check for the read-only Simplibank MySQL connection.
 *
 *   node --env-file=.env scripts/check-sb-db.mjs
 *   (or: npm run db:check)
 *
 * Runs a ping, lists tables, and — if present — shows the columns of the tables the
 * original n8n CSP flows used. Read-only: only SELECT/SHOW/information_schema reads.
 */
import { pingSbDb, listSbTables, describeSbTable, queryRead, isSbDbConfigured, sbDbTarget } from '../src/lib/sb-db.ts'

const INTERESTING = ['csp_application', 'customer_agreement_history', 'csp_docs']

if (!isSbDbConfigured()) {
  console.error('SB_* env vars are not set. Add them to .env (see README).')
  process.exit(1)
}

console.log(`Target: ${sbDbTarget()}\n`)

const health = await pingSbDb()
console.log('Ping:', JSON.stringify(health, null, 2))

if (!health.ok) {
  console.error('\nCould not reach the database. Check the host/port, credentials, and that this machine is allowed to connect (firewall / IP allow-list).')
  process.exit(1)
}

const tables = await listSbTables()
console.log(`\nTables visible to the app user (${tables.length}):`)
console.log(tables.join(', ') || '  (none)')

for (const table of INTERESTING) {
  if (!tables.includes(table)) {
    console.log(`\n${table}: not present / not visible`)
    continue
  }
  const columns = await describeSbTable(table)
  console.log(`\n${table} (${columns.length} columns):`)
  for (const c of columns) {
    console.log(`  ${c.column.padEnd(34)} ${c.type.padEnd(22)} ${c.nullable === 'YES' ? 'null' : 'not null'}${c.key ? ` · ${c.key}` : ''}`)
  }
}

// confirm the read-only guard actually blocks writes
let blocked = false
try {
  await queryRead('DELETE FROM csp_application WHERE 1 = 0')
} catch {
  blocked = true
}
console.log(`\nWrite attempt rejected by the read-only guard: ${blocked ? 'yes' : 'NO — review sb-db.ts!'}`)
process.exit(blocked ? 0 : 1)

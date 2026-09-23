/**
 * Simplibank MySQL — EXTERNAL, READ-ONLY.
 *
 * This is the business database the original n8n CSP/WhatsApp flows read from
 * (csp_application, customer_agreement_history, csp_docs, ...). It is NOT the app's
 * own store — leads/nudges/message logs live in SQLite via Prisma (see @/lib/db).
 *
 * Read-only is enforced in three independent layers:
 *   1. `assertReadOnly()` rejects anything that is not SELECT / SHOW / DESCRIBE /
 *      EXPLAIN / WITH, and rejects stacked statements.
 *   2. Every pooled connection runs `SET SESSION TRANSACTION READ ONLY`.
 *   3. The app never exposes a write helper — only queryRead/queryReadOne.
 * Layer 3 is the contract; 1 and 2 are defence in depth. Grant the `appuser`
 * SELECT-only rights on the server as well.
 *
 * Config comes from .env: SB_READ_HOST, SB_USER, SB_PASSWORD, SB_NAME, SB_PORT.
 */
import mysql, { type Pool, type PoolOptions, type RowDataPacket } from 'mysql2/promise'

const READ_ONLY_PATTERN = /^\s*(select|show|describe|desc|explain|with)\b/i

export function isSbDbConfigured(): boolean {
  return Boolean(
    (process.env.SB_READ_HOST || process.env.SB_WRITE_HOST) &&
      process.env.SB_USER &&
      process.env.SB_PASSWORD &&
      process.env.SB_NAME
  )
}

export function sbDbTarget(): string {
  const host = process.env.SB_READ_HOST || process.env.SB_WRITE_HOST || ''
  return `${process.env.SB_USER}@${host}:${process.env.SB_PORT || '3306'}/${process.env.SB_NAME}`
}

function poolOptions(): PoolOptions {
  if (!isSbDbConfigured()) {
    throw new Error('Simplibank MySQL not configured — set SB_READ_HOST/SB_USER/SB_PASSWORD/SB_NAME in .env')
  }
  return {
    host: process.env.SB_READ_HOST || process.env.SB_WRITE_HOST,
    port: Number(process.env.SB_PORT || 3306),
    user: process.env.SB_USER,
    password: process.env.SB_PASSWORD,
    database: process.env.SB_NAME,
    connectionLimit: Math.max(1, Number(process.env.SB_CONNECTION_LIMIT || 5)),
    connectTimeout: Math.max(1000, Number(process.env.SB_CONNECT_TIMEOUT_MS || 10000)),
    waitForConnections: true,
    queueLimit: 0,
    // Big integer ids (csp ids) must not lose precision, and we never want a Date
    // object shifted by a timezone guess.
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    // Stacked statements stay off — one statement per query, always.
    multipleStatements: false,
  }
}

const globalForSb = globalThis as unknown as { __sbPool?: Pool }

function getPool(): Pool {
  if (globalForSb.__sbPool) return globalForSb.__sbPool

  const pool = mysql.createPool(poolOptions())

  // Defence in depth: make the session itself reject writes.
  // NOTE: the `connection` event hands over the *callback-style* connection even though
  // the promise wrapper types it as PoolConnection — so use the callback API, not await.
  pool.on('connection', (connection) => {
    const raw = connection as unknown as {
      query: (sql: string, cb: (err: Error | null) => void) => void
    }
    raw.query('SET SESSION TRANSACTION READ ONLY', (err) => {
      if (err) console.warn('[sb-db] could not set session read-only:', err.message)
    })
  })

  globalForSb.__sbPool = pool
  return pool
}

/** Reject anything that is not a single read statement. */
export function assertReadOnly(sql: string): void {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  if (!trimmed) throw new Error('Empty query')

  if (!READ_ONLY_PATTERN.test(trimmed)) {
    throw new Error(
      `Refusing non-read query on the read-only Simplibank connection. Only SELECT/SHOW/DESCRIBE/EXPLAIN/WITH are allowed. Got: ${trimmed.slice(0, 60)}…`
    )
  }
  if (trimmed.includes(';')) {
    throw new Error('Stacked statements are not allowed on the read-only Simplibank connection')
  }
}

export interface QueryReadOptions {
  /** Truncate the result set client-side (does not change the SQL). Default 5000. */
  maxRows?: number
  /** Log the SQL + duration. Defaults to SB_LOG_QUERY. */
  log?: boolean
}

/** Run a read query. Throws on anything that is not a single read statement. */
export async function queryRead<T = RowDataPacket>(
  sql: string,
  params: unknown[] = [],
  opts: QueryReadOptions = {}
): Promise<T[]> {
  assertReadOnly(sql)

  const maxRows = opts.maxRows ?? 5000
  const shouldLog = opts.log ?? process.env.SB_LOG_QUERY === 'true'
  const startedAt = Date.now()

  const [rows] = await getPool().query(sql, params)
  const list = (Array.isArray(rows) ? rows : []) as T[]

  if (shouldLog) {
    console.log(`[sb-db] ${Date.now() - startedAt}ms ${list.length} row(s) — ${sql.replace(/\s+/g, ' ').slice(0, 160)}`)
  }

  if (list.length > maxRows) {
    console.warn(`[sb-db] result truncated from ${list.length} to ${maxRows} rows — add a LIMIT to the query`)
    return list.slice(0, maxRows)
  }
  return list
}

/** Convenience: first row or null. */
export async function queryReadOne<T = RowDataPacket>(
  sql: string,
  params: unknown[] = [],
  opts: QueryReadOptions = {}
): Promise<T | null> {
  const rows = await queryRead<T>(sql, params, { maxRows: 1, ...opts })
  return rows[0] ?? null
}

export interface SbDbHealth {
  configured: boolean
  ok: boolean
  target: string
  serverVersion?: string
  currentUser?: string
  readOnlySession?: boolean
  latencyMs?: number
  error?: string
}

/** Connectivity + read-only-session check. Never throws. */
export async function pingSbDb(): Promise<SbDbHealth> {
  const target = sbDbTarget()
  if (!isSbDbConfigured()) {
    return { configured: false, ok: false, target, error: 'SB_* env vars are not set' }
  }

  const startedAt = Date.now()
  try {
    const row = await queryReadOne<RowDataPacket>(
      'SELECT VERSION() AS version, CURRENT_USER() AS `current_user`, @@session.transaction_read_only AS `read_only`',
      [],
      { log: false }
    )
    return {
      configured: true,
      ok: true,
      target,
      serverVersion: row?.version ? String(row.version) : undefined,
      currentUser: row?.current_user ? String(row.current_user) : undefined,
      readOnlySession: row?.read_only !== undefined ? Number(row.read_only) === 1 : undefined,
      latencyMs: Date.now() - startedAt,
    }
  } catch (err) {
    return {
      configured: true,
      ok: false,
      target,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Tables visible to the app user, for discovery. */
export async function listSbTables(): Promise<string[]> {
  const rows = await queryRead<RowDataPacket>(
    'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    [process.env.SB_NAME]
  )
  return rows.map((r) => String(r.name))
}

/** Columns of one table. */
export async function describeSbTable(table: string): Promise<{ column: string; type: string; nullable: string; key: string }[]> {
  const rows = await queryRead<RowDataPacket>(
    `SELECT COLUMN_NAME AS \`column\`, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS \`key\`
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    [process.env.SB_NAME, table]
  )
  return rows.map((r) => ({
    column: String(r.column),
    type: String(r.type),
    nullable: String(r.nullable),
    key: String(r.key),
  }))
}

export async function closeSbPool(): Promise<void> {
  if (globalForSb.__sbPool) {
    await globalForSb.__sbPool.end().catch(() => undefined)
    globalForSb.__sbPool = undefined
  }
}

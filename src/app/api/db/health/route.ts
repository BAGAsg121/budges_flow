/**
 * GET /api/db/health — connectivity check for the external read-only Simplibank MySQL.
 * Behind the app password (see src/middleware.ts).
 *
 * Query params:
 *   ?tables=1          include the table list
 *   ?describe=<table>  include column metadata for one table
 */
import { NextRequest, NextResponse } from 'next/server'
import { isSbDbConfigured, pingSbDb, listSbTables, describeSbTable } from '@/lib/sb-db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const wantTables = req.nextUrl.searchParams.get('tables') === '1'
  const describe = (req.nextUrl.searchParams.get('describe') || '').trim()

  const health = await pingSbDb()
  if (!health.ok) {
    return NextResponse.json({ ...health, ok: false }, { status: isSbDbConfigured() ? 502 : 500 })
  }

  const payload: Record<string, unknown> = { ...health }

  try {
    if (wantTables) payload.tables = await listSbTables()
    if (describe) payload.columns = await describeSbTable(describe)
  } catch (err) {
    payload.metadataError = err instanceof Error ? err.message : String(err)
  }

  return NextResponse.json({ ...payload, ok: true })
}

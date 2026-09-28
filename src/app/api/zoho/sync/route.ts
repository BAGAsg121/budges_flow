/**
 * POST /api/zoho/sync
 *
 * Body (optional):
 *   { "window": "incremental" } — from the LAST SYNC time up to now (default)
 *   { "window": "all" }         — every EPS lead created after the cut-off
 *   { "window": "today" }       — the same filter with the created time at 01:00 today
 *   { "criteria": "((…))" }     — explicit override; wins over `window`
 *   { "via": "auto" | "mcp" | "api" } — which Zoho data path to use (default auto)
 *
 * `incremental` is what the day-to-day button uses: it asks the CRM only for leads created since
 * the previous sync, so each run picks up exactly what is new rather than re-scanning the whole
 * window. The window is CLOSED at both ends (`greater_than from` and `less_than now`), which the
 * live CRM accepts for two conditions on the same field — but only with an explicit `+05:30`
 * offset; a `…Z` suffix is rejected as an invalid datetime.
 *
 * `auto` reads through the Zoho CRM MCP server when it is connected and falls back to the REST API
 * if the MCP call fails, reporting which path was used and why.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { syncLeads } from '@/lib/nudge-engine'
import {
  ZOHO_CRITERIA,
  ZOHO_LEADS_CREATED_AFTER,
  zohoCriteriaBetween,
  zohoIstIso,
  zohoTodayCriteria,
  zohoSyncOverlapMinutes,
} from '@/lib/nudge-defaults'
import { isZohoMcpConfigured, zohoMcpConfigStatus, zohoMcpMissingEnvVars } from '@/lib/zoho-mcp'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * When the last sync ran, read from the data itself — no extra table or column needed.
 *
 * `Lead.lastSyncedAt` is stamped on every upsert, so the newest one IS the last sync. If the lead
 * table is empty (a first run) there is nothing to go on and the configured cut-off is used.
 */
async function lastSyncAt(): Promise<Date | null> {
  const newest = await db.lead.aggregate({ _max: { lastSyncedAt: true } })
  return newest._max.lastSyncedAt ?? null
}

export async function POST(req: NextRequest) {
  let body: { criteria?: string; window?: string; via?: string } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    // no body -> the default window
  }

  const requested = (body.window || '').trim().toLowerCase()
  const requestedVia = (body.via || '').trim().toLowerCase()
  const via: 'auto' | 'mcp' | 'api' = requestedVia === 'mcp' || requestedVia === 'api' ? requestedVia : 'auto'

  const now = new Date()
  let window = 'incremental'
  let criteria: string
  let fromIso: string | null = null
  let toIso: string | null = null
  let lastSync: string | null = null

  if (body.criteria && body.criteria.trim()) {
    criteria = body.criteria.trim()
    window = 'custom'
  } else if (requested === 'all') {
    criteria = ZOHO_CRITERIA
    window = 'all'
  } else if (requested === 'today') {
    criteria = zohoTodayCriteria(now)
    window = 'today'
  } else {
    // Incremental: last sync (minus a safety overlap) up to now.
    const last = await lastSyncAt()
    lastSync = last ? last.toISOString() : null
    const overlapMs = zohoSyncOverlapMinutes() * 60 * 1000
    const from = last ? new Date(last.getTime() - overlapMs) : new Date(ZOHO_LEADS_CREATED_AFTER)
    fromIso = zohoIstIso(from)
    toIso = zohoIstIso(now)
    criteria = zohoCriteriaBetween(fromIso, toIso)
  }

  try {
    const outcome = await syncLeads(criteria, { via })
    return NextResponse.json({
      ok: true,
      synced: outcome.synced,
      via: outcome.via,
      window,
      criteria,
      /** For `incremental`: the exact window asked for, and what it was derived from. */
      from: fromIso,
      to: toIso,
      lastSyncAt: lastSync,
      overlapMinutes: window === 'incremental' ? zohoSyncOverlapMinutes() : null,
      tool: outcome.tool ?? null,
      // Surfaced rather than logged away: a silent fallback would hide a broken MCP setup.
      fellBack: outcome.fellBack ?? null,
      mcp: {
        requested: via,
        configured: isZohoMcpConfigured(),
        missing: zohoMcpMissingEnvVars(),
        status: zohoMcpConfigStatus(),
      },
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

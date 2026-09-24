/**
 * POST /api/zoho/sync
 *
 * Body (optional):
 *   { "window": "all"   }  — every EPS lead created after the cut-off (default)
 *   { "window": "today" }  — same filter, created time moved to 01:00 today
 *   { "criteria": "((…))" } — explicit override; wins over `window`
 *   { "via": "auto" | "mcp" | "api" } — which Zoho data path to use (default auto)
 *
 * `auto` reads through the Zoho CRM MCP server when it is connected and silently falls
 * back to the REST API if the MCP call fails, reporting which path was used and why.
 *
 * `window` exists so the UI never has to build a CRM date string itself — the
 * timezone-of-record lives in one place (src/lib/nudge-defaults.ts).
 */
import { NextRequest, NextResponse } from 'next/server'
import { syncLeads } from '@/lib/nudge-engine'
import { ZOHO_CRITERIA, zohoTodayCriteria } from '@/lib/nudge-defaults'
import { isZohoMcpConfigured, zohoMcpConfigStatus, zohoMcpMissingEnvVars } from '@/lib/zoho-mcp'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  let body: { criteria?: string; window?: string; via?: string } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    // no body -> the default full window
  }

  const requested = (body.window || '').trim().toLowerCase()
  const isToday = requested === 'today'

  const requestedVia = (body.via || '').trim().toLowerCase()
  const via: 'auto' | 'mcp' | 'api' = requestedVia === 'mcp' || requestedVia === 'api' ? requestedVia : 'auto'

  const criteria =
    body.criteria && body.criteria.trim()
      ? body.criteria.trim()
      : isToday
        ? zohoTodayCriteria()
        : ZOHO_CRITERIA

  try {
    const outcome = await syncLeads(criteria, { via })
    return NextResponse.json({
      ok: true,
      synced: outcome.synced,
      via: outcome.via,
      window: body.criteria?.trim() ? 'custom' : isToday ? 'today' : 'all',
      criteria,
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

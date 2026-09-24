/**
 * GET  /api/zoho/mcp
 *      Connection status, and — when connected — the server's full tool list with the
 *      tool that looks like the Leads reader called out.
 *
 * POST /api/zoho/mcp
 *      Body: { "tool": "<name>", "args": { … } }
 *      Calls any tool on the Zoho CRM MCP server and returns its result verbatim.
 *      This is the general-purpose escape hatch: everything the MCP server can do is
 *      reachable here without adding a route per operation.
 *
 * Behind the app password (src/middleware.ts).
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  callZohoMcpTool,
  connectZohoMcp,
  isZohoMcpConfigured,
  pickLeadsTool,
  zohoMcpConfigStatus,
  zohoMcpMissingEnvVars,
} from '@/lib/zoho-mcp'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  const status = zohoMcpConfigStatus()
  const wantTools = req.nextUrl.searchParams.get('tools') !== '0'

  if (!isZohoMcpConfigured()) {
    return NextResponse.json({
      ok: false,
      configured: false,
      status,
      missing: zohoMcpMissingEnvVars(),
      hint:
        'Connect once at /api/zoho/mcp/connect — it registers the app with Zoho, asks for consent, ' +
        'and prints the three values to add to the environment.',
    })
  }

  if (!wantTools) {
    return NextResponse.json({ ok: true, configured: true, status })
  }

  try {
    const conn = await connectZohoMcp({ refresh: req.nextUrl.searchParams.get('refresh') === '1' })
    const leadsTool = pickLeadsTool(conn.tools)
    return NextResponse.json({
      ok: true,
      configured: true,
      status,
      server: conn.session,
      toolCount: conn.toolCount,
      leadsTool: leadsTool?.name ?? null,
      leadsToolSource: (process.env.ZOHO_MCP_LEADS_TOOL || '').trim() ? 'env' : 'heuristic',
      tools: conn.tools.map((t) => ({
        name: t.name,
        title: t.title ?? null,
        description: t.description ?? null,
        required: t.inputSchema?.required ?? [],
        properties: Object.keys(t.inputSchema?.properties ?? {}),
      })),
    })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        configured: true,
        status,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 502 }
    )
  }
}

export async function POST(req: NextRequest) {
  if (!isZohoMcpConfigured()) {
    return NextResponse.json(
      { ok: false, error: `Zoho MCP is not connected. Missing: ${zohoMcpMissingEnvVars().join(', ') || 'unknown'}` },
      { status: 400 }
    )
  }

  let body: { tool?: string; args?: Record<string, unknown> } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    // handled below
  }

  const tool = (body.tool || '').trim()
  if (!tool) {
    return NextResponse.json({ ok: false, error: 'A "tool" name is required.' }, { status: 400 })
  }

  try {
    const result = await callZohoMcpTool(tool, body.args ?? {})
    return NextResponse.json(
      {
        ok: result.ok,
        tool,
        isError: result.isError,
        text: result.text.slice(0, 20_000),
        json: result.json,
        error: result.error ?? null,
      },
      { status: result.ok ? 200 : 502 }
    )
  } catch (err) {
    return NextResponse.json({ ok: false, tool, error: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}

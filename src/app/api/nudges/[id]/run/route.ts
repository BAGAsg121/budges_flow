/**
 * POST /api/nudges/{id}/run
 *
 * Executes the nudge: optional Zoho sync -> select eligible leads -> send per sequence -> log every
 * attempt. Returns a full sent/skipped/failed summary.
 *
 * Body (all optional):
 *   { "sync": true }   — refresh the CRM first (default true; ignored by MySQL flows, which are
 *                        database-only and never touch the CRM)
 *   { "force": true }  — run even though the nudge is DISABLED
 *
 * `force` exists so the operator can send once, by hand, from a nudge that is deliberately off —
 * typically because its template is still pending or it is still being set up. It is never implied:
 * the caller must ask for it, the UI only sends it after a confirm dialog that names the audience,
 * and it does NOT enable the nudge (the scheduler still ignores it). Every forced run is marked in
 * the returned summary so "how did messages go out from a nudge that is off?" is always answerable.
 */
import { NextRequest, NextResponse } from 'next/server'
import { runNudge } from '@/lib/nudge-engine'
import { getBaseUrl } from '@/lib/base-url'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const url = await getBaseUrl()
    let sync = true
    let force = false
    try {
      const body = (await req.json()) as { sync?: boolean; force?: boolean }
      if (body && typeof body.sync === 'boolean') sync = body.sync
      if (body && typeof body.force === 'boolean') force = body.force
    } catch {
      // no body -> sync=true, force=false
    }
    const summary = await runNudge(id, url, { sync, force })
    return NextResponse.json({ ok: true, summary })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

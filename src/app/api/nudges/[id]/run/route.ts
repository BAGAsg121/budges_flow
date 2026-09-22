/**
 * POST /api/nudges/{id}/run
 * Executes the nudge: optional Zoho sync -> select eligible leads -> send per sequence
 * -> log every attempt. Returns a full sent/skipped/failed summary.
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
    try {
      const body = (await req.json()) as { sync?: boolean }
      if (body && typeof body.sync === 'boolean') sync = body.sync
    } catch {
      // no body -> default sync=true
    }
    const summary = await runNudge(id, url, { sync })
    return NextResponse.json({ ok: true, summary })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

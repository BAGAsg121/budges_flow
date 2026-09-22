/**
 * GET /api/nudges/{id}/preview — dry-run: who would receive an email and who would be
 * skipped (replied / max_reached / waiting_followup / no_email). Sends nothing.
 */
import { NextRequest, NextResponse } from 'next/server'
import { previewNudge } from '@/lib/nudge-engine'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const result = await previewNudge(id)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

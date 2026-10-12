/**
 * POST /api/runs/{id}/stop — ask a background run to stop.
 *
 * The flag is checked BETWEEN batches, never mid-send, so the run always ends on a batch boundary and
 * the operator can trust the numbers: everything counted as sent really was sent, and anything after
 * it was not. A stop is not a rollback — messages already delivered stay delivered.
 */
import { NextResponse } from 'next/server'
import { stopJob } from '@/lib/run-queue'

export const dynamic = 'force-dynamic'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const job = stopJob(id)
  if (!job) return NextResponse.json({ ok: false, error: 'No such run.' }, { status: 404 })
  return NextResponse.json({ ok: true, job })
}

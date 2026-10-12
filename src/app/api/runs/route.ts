/**
 * GET /api/runs — progress for background run jobs.
 *
 * The UI polls this while a run is draining, so the operator watches the count climb instead of
 * holding a request open for half an hour. Jobs are in memory for the life of the process (see
 * src/lib/run-queue.ts), so this reports what THIS instance is doing; a restart clears it.
 */
import { NextResponse } from 'next/server'
import { listJobs, activeJobForNudge } from '@/lib/run-queue'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const nudgeId = url.searchParams.get('nudgeId')
  if (nudgeId) {
    return NextResponse.json({ ok: true, job: activeJobForNudge(nudgeId) })
  }
  return NextResponse.json({ ok: true, jobs: listJobs() })
}

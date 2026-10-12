/**
 * POST /api/nudges/{id}/run
 *
 * Executes the nudge: optional Zoho sync -> select eligible leads -> send per sequence -> log every
 * attempt. Returns a full sent/skipped/failed summary.
 *
 * Body (all optional):
 *   { "sync": true }        — refresh the CRM first (default true; ignored by MySQL flows, which are
 *                             database-only and never touch the CRM)
 *   { "force": true }       — run even though the nudge is DISABLED
 *   { "background": true }  — enqueue a job and answer immediately (see below)
 *
 * `force` exists so the operator can send once, by hand, from a nudge that is deliberately off —
 * typically because its template is still pending or it is still being set up. It is never implied:
 * the caller must ask for it, the UI only sends it after a confirm dialog that names the audience,
 * and it does NOT enable the nudge (the scheduler still ignores it). Every forced run is marked in
 * the returned summary so "how did messages go out from a nudge that is off?" is always answerable.
 *
 * TWO MODES, AND WHY BOTH EXIST.
 *
 * Synchronous (default) drains batches until `RUN_BUDGET_SECONDS` expires and returns everything it
 * did. It is bounded by the request timeout, which at ~3s per WhatsApp send is roughly ONE batch of
 * NUDGE_MAX_PER_RUN — so a 417-lead run returns "50 sent, 367 still to go" however the budget is
 * tuned. Draining 367 takes ~18 minutes and draining 3,500 takes hours; no HTTP request lives that
 * long, so no budget value fixes it.
 *
 * Background (`background: true`, what the UI uses) hands the work to the run queue, which continues
 * inside the server process after this response has been sent. The client polls /api/runs for
 * progress and can close the tab entirely — the sending carries on. The returned summary shape is
 * replaced by a job, which is why the UI branches on which mode it asked for.
 */
import { NextRequest, NextResponse } from 'next/server'
import { runNudgeDrained } from '@/lib/nudge-engine'
import { enqueueRun, activeJobForNudge } from '@/lib/run-queue'
import { getBaseUrl } from '@/lib/base-url'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    let sync = true
    let force = false
    let background = false
    try {
      const body = (await req.json()) as { sync?: boolean; force?: boolean; background?: boolean }
      if (body && typeof body.sync === 'boolean') sync = body.sync
      if (body && typeof body.force === 'boolean') force = body.force
      if (body && typeof body.background === 'boolean') background = body.background
    } catch {
      // no body -> sync=true, force=false, background=false
    }

    if (background) {
      // Answered as soon as the job exists. Deliberately no await on the work itself: awaiting it
      // would put us straight back on the request-timeout treadmill this mode exists to escape.
      const { job, error } = await enqueueRun(id, { force, sync })
      if (error || !job) {
        // 409, not 500: "already running" is a conflict with current state, not a server fault, and
        // the UI shows it as information rather than an error.
        return NextResponse.json({ ok: false, error: error ?? 'Could not start the run.' }, { status: 409 })
      }
      return NextResponse.json({ ok: true, job })
    }

    const url = await getBaseUrl()
    const summary = await runNudgeDrained(id, url, { sync, force })
    return NextResponse.json({ ok: true, summary })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

/**
 * Is a run already going for this nudge?
 *
 * The UI checks before showing the confirm dialog, so "Fetch & Send" on a nudge that is mid-drain
 * says so instead of silently refusing after the operator has already agreed to send.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return NextResponse.json({ ok: true, job: activeJobForNudge(id) })
}

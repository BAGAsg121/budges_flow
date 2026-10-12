/**
 * Background run queue — one click, the whole audience.
 *
 * WHY THIS EXISTS
 *
 * `runNudge()` sends at most NUDGE_MAX_PER_RUN messages per call, because a single HTTP request has
 * to answer before the platform cuts it off. At ~3s per WhatsApp send a batch of 50 already takes
 * ~2.5 minutes, so a request can afford roughly one batch — which is why a 417-lead run showed
 * "50 sent, 367 still to go" no matter how the budget was tuned. Raising the budget cannot fix that:
 * draining 367 leads takes ~18 minutes and draining 3,500 takes hours, and no HTTP request lives that
 * long.
 *
 * So the work moves OFF the request. The route enqueues a job and answers immediately with a job id;
 * the loop below keeps sending in cap-sized batches inside the server process until the audience is
 * exhausted, is stopped, or stops making progress. The operator closes the tab if they like — the
 * sending continues.
 *
 * WHAT THIS IS NOT
 *
 * It is not a queue with persistence. Jobs live in memory for the life of the process, exactly like
 * the scheduler, so a Render restart (a deploy, a scale event, an idle-host wake) ends a running job.
 * That is a deliberate trade: the alternative is a jobs table, and this app's whole design keeps the
 * send path free of new tables. What makes it safe is that a lost job is RESUMABLE, not corrupt — the
 * next Run picks up the un-messaged leads and nobody is messaged twice, because every send is decided
 * from the lead's own log history.
 *
 * CONCURRENCY IS ONE ON PURPOSE
 *
 * Two jobs sending at once would double the rate at Meta and interleave two sequences over the same
 * leads. One at a time also means the numbers the operator watches mean something.
 */
import { db } from '@/lib/db'
import { runNudge } from '@/lib/nudge-engine'
import { getStaticBaseUrl } from '@/lib/base-url'
import type { RunJobDto } from '@/lib/app-types'

export type RunJobStatus = RunJobDto['status']

/**
 * The job shape lives in app-types.ts so the client can import it without pulling in this module
 * (which opens a database connection). Aliased here for readability at the call sites, plus the
 * per-job `sync` flag — server-only state the client has no use for.
 */
export type RunJob = RunJobDto & { sync: boolean }

/** How many skip rows a job carries. Enough to explain a run, small enough to poll. */
const SKIPPED_CAP = 100

interface QueueState {
  jobs: Map<string, RunJob>
  /** The job currently holding the single send slot, if any. */
  activeId: string | null
  /** Pending jobs in FIFO order, waiting for the slot. */
  waiting: string[]
}

const globalForQueue = globalThis as unknown as { __nudgeRunQueue?: QueueState }

const state: QueueState =
  globalForQueue.__nudgeRunQueue ??
  (globalForQueue.__nudgeRunQueue = { jobs: new Map(), activeId: null, waiting: [] })

/** How long to wait between batches. Long enough to be a deliberate pause, short enough to matter. */
function batchPauseMs(): number {
  const raw = Number(process.env.RUN_BATCH_PAUSE_MS || 0)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 1_000
}

/** How many finished jobs to keep for the UI to show. */
const JOB_HISTORY = 20

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Newest first, with a bounded history so a long-lived process cannot grow this without limit. */
export function listJobs(): RunJob[] {
  const all = [...state.jobs.values()]
  if (all.length <= JOB_HISTORY) return all
  // Keep anything still active or waiting, plus the most recent finished ones.
  const keep = new Set<string>(state.waiting)
  if (state.activeId) keep.add(state.activeId)
  for (const j of all) {
    if (j.status === 'running' || j.status === 'queued') keep.add(j.id)
  }
  const finished = all.filter((j) => !keep.has(j.id)).slice(-(JOB_HISTORY - keep.size))
  for (const j of finished) keep.add(j.id)
  for (const id of [...state.jobs.keys()]) {
    if (!keep.has(id)) state.jobs.delete(id)
  }
  return all.filter((j) => state.jobs.has(j.id))
}

export function getJob(id: string): RunJob | null {
  return state.jobs.get(id) ?? null
}

/** The job for a nudge that is still going, if there is one — used to refuse a duplicate start. */
export function activeJobForNudge(nudgeId: string): RunJob | null {
  for (const job of state.jobs.values()) {
    if (job.nudgeId === nudgeId && (job.status === 'running' || job.status === 'queued')) return job
  }
  return null
}

export function stopJob(id: string): RunJob | null {
  const job = state.jobs.get(id)
  if (!job) return null
  if (job.status === 'running' || job.status === 'queued') job.stopRequested = true
  return job
}

/**
 * Create a job and start working through it. Returns immediately — the caller does not await this.
 *
 * Refuses a second job for a nudge that already has one running, rather than queueing it: two runs of
 * the same nudge back to back would send to any lead the first batch missed for a transient reason
 * (an API blip), which is a duplicate message dressed up as thoroughness.
 */
export async function enqueueRun(
  nudgeId: string,
  opts: { force?: boolean; sync?: boolean } = {}
): Promise<{ job?: RunJob; error?: string }> {
  const nudge = await db.nudge.findUnique({ where: { id: nudgeId } })
  if (!nudge) return { error: 'Nudge not found' }

  const existing = activeJobForNudge(nudgeId)
  if (existing) {
    return { error: `This nudge is already being sent (job ${existing.id}, ${existing.status}).` }
  }

  const job: RunJob = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    nudgeId,
    nudgeKey: nudge.key,
    nudgeName: nudge.name,
    force: opts.force === true,
    // Carried ON THE JOB, not passed to the worker: a job that waits behind another must sync
    // according to its own request, not the request that happened to start the worker.
    sync: opts.sync !== false,
    status: 'queued',
    sent: 0,
    failed: 0,
    remaining: 0,
    batches: 0,
    batchLimit: null,
    considered: 0,
    channel: nudge.channel,
    smtpConfigured: false,
    whatsappConfigured: false,
    syncedFromZoho: null,
    syncedVia: null,
    skipped: [],
    startedAt: new Date().toISOString(),
    stopRequested: false,
  }

  state.jobs.set(job.id, job)
  state.waiting.push(job.id)
  void drainQueue()

  return { job }
}

/**
 * The single worker. Takes the next waiting job, runs it to completion, then looks for another.
 *
 * Deliberately NOT re-entrant: if a worker is already running, a newly enqueued job just sits in
 * `waiting` and this returns. That is what keeps concurrency at one.
 */
let workerRunning = false
async function drainQueue(): Promise<void> {
  if (workerRunning) return
  workerRunning = true
  try {
    while (state.waiting.length > 0) {
      const id = state.waiting.shift()
      if (!id) break
      const job = state.jobs.get(id)
      if (!job) continue
      state.activeId = id
      await runJob(job)
      state.activeId = null
    }
  } finally {
    workerRunning = false
  }
}

async function runJob(job: RunJob): Promise<void> {
  job.status = 'running'
  const baseUrl = getStaticBaseUrl()

  try {
    for (;;) {
      // Checked BETWEEN batches, never mid-send: stopping halfway through a batch would leave the
      // operator unsure how much went out, and the batch is already a bounded unit of work.
      if (job.stopRequested) {
        job.status = 'stopped'
        break
      }

      // Only the first batch syncs. Re-syncing per batch would re-pull the same CRM window — by far
      // the most expensive part of a run — for data the next batch cannot need.
      const summary = await runNudge(job.nudgeId, baseUrl, {
        sync: job.batches === 0 ? job.sync : false,
        force: job.force,
      })

      job.batches++
      job.sent += summary.sent
      job.failed += summary.failed
      job.remaining = summary.deferred
      job.batchLimit = summary.batchLimit
      job.considered = Math.max(job.considered, summary.leadsConsidered)
      job.channel = summary.channel
      job.smtpConfigured = summary.smtpConfigured
      job.whatsappConfigured = summary.whatsappConfigured
      job.skipped = summary.skipped.slice(0, SKIPPED_CAP)
      // Only the first batch synced, so only its figures are real.
      if (job.batches === 1) {
        job.syncedFromZoho = summary.syncedFromZoho
        job.syncedVia = summary.syncedVia ?? null
      }

      // Nothing left deferred: the audience is exhausted.
      if (summary.deferred === 0) {
        job.status = 'done'
        break
      }
      // A batch that attempted nothing means everything left is genuinely unsendable (no valid
      // phone, sequence limit reached). Looping again would spin forever.
      if (summary.sent + summary.failed === 0) {
        job.status = 'done'
        break
      }

      await sleep(batchPauseMs())
    }
  } catch (err) {
    job.status = 'failed'
    job.error = err instanceof Error ? err.message : String(err)
  } finally {
    job.finishedAt = new Date().toISOString()
  }
}

/** Test seam: drop all in-memory job state. Never called by the app. */
export function __resetRunQueue(): void {
  state.jobs.clear()
  state.waiting.length = 0
  state.activeId = null
  workerRunning = false
}

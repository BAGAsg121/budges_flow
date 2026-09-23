/**
 * Next.js instrumentation hook — starts the in-process nudge scheduler once the
 * server boots (Node runtime only; never during a production build).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  try {
    const { startScheduler } = await import('@/lib/scheduler')
    startScheduler()
  } catch (err) {
    console.error('[scheduler] failed to start:', err instanceof Error ? err.message : err)
  }
}

/**
 * GET /api/health — public liveness probe.
 *
 * Deliberately public (see src/middleware.ts) so a host's health check and uptime
 * pingers can reach it. Returns no data — only liveness — so it is safe to expose.
 * On hosts that sleep when idle, pointing a keep-alive pinger here also reduces
 * cold starts for the open-tracking pixel.
 */
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      service: 'nudge-engine',
      time: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

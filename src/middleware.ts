/**
 * HTTP Basic auth for the whole app.
 *
 * Public (cannot authenticate, must stay open):
 *   /api/track/*  — email open pixel + Meta WhatsApp webhook
 *   /api/cron/*   — external schedulers; the routes validate CRON_SECRET themselves
 *
 * Everything else (UI + all data/mutating APIs) requires APP_USERNAME/APP_PASSWORD.
 * Fails closed: with AUTH_ENABLED=true and no APP_PASSWORD set, every request is denied.
 */
import { NextRequest, NextResponse } from 'next/server'

// Public: /api/health (liveness only), /api/track/* and /api/cron/* (validated in-route)
// plus non-sensitive static assets.
const PUBLIC_PREFIXES = ['/api/health', '/api/track/', '/api/cron/', '/logo.svg', '/robots.txt', '/favicon.ico']

function safeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a)
  const bb = new TextEncoder().encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i]
  return diff === 0
}

export function middleware(req: NextRequest) {
  if ((process.env.AUTH_ENABLED ?? 'true') === 'false') return NextResponse.next()

  const { pathname } = req.nextUrl
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next()

  const expectedUser = process.env.APP_USERNAME || 'admin'
  const expectedPass = process.env.APP_PASSWORD || ''

  const header = req.headers.get('authorization') || ''
  if (expectedPass && header.startsWith('Basic ')) {
    let decoded = ''
    try {
      decoded = atob(header.slice(6))
    } catch {
      decoded = ''
    }
    const sep = decoded.indexOf(':')
    if (sep >= 0) {
      const user = decoded.slice(0, sep)
      const pass = decoded.slice(sep + 1)
      if (safeEqual(user, expectedUser) && safeEqual(pass, expectedPass)) {
        return NextResponse.next()
      }
    }
  }

  return new NextResponse('Authentication required', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Nudge Engine", charset="UTF-8"',
      'Cache-Control': 'no-store',
    },
  })
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}

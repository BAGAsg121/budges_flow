/** Derive the app's public base URL (for open-tracking pixel links in emails). */

function clean(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Base URL usable outside a request scope (scheduler, cron, scripts). */
export function getStaticBaseUrl(): string {
  if (process.env.APP_BASE_URL) return clean(process.env.APP_BASE_URL)
  const host = process.env.APP_HOST || 'localhost'
  const port = process.env.PORT || '3000'
  return `http://${host}:${port}`
}

export async function getBaseUrl(): Promise<string> {
  if (process.env.APP_BASE_URL) return clean(process.env.APP_BASE_URL)
  try {
    const h = await import('next/headers').then((m) => m.headers())
    const host = h.get('x-forwarded-host') || h.get('host')
    if (host) {
      const proto =
        h.get('x-forwarded-proto') || (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https')
      return `${proto}://${host}`
    }
  } catch {
    // called outside a request scope (scheduler / cron) — fall through
  }
  return getStaticBaseUrl()
}

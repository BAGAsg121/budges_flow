/**
 * Meta's own template analytics — including URL-button click counts.
 *
 * THIS IS THE BETTER ANSWER for "did anyone click". Meta records button clicks itself and exposes
 * them through `GET /{WABA_ID}/template_analytics`, so click numbers need NO template change, NO
 * redirect through this app, and no cold-start risk. Measured against the live WABA:
 *
 *   { "template_id": "…", "clicked": [
 *       { "type": "url_button",        "button_content": "Pay Now", "count": 6 },
 *       { "type": "unique_url_button", "button_content": "Pay Now", "count": 4 } ] }
 *
 * WHAT IT CANNOT DO: the data is per TEMPLATE PER DAY, not per recipient. It can say "6 clicks,
 * 4 unique, on this template today"; it cannot say "9643520034 clicked". Per-person attribution
 * needs the redirect tracker (src/lib/cta.ts), which is why both exist.
 *
 * The endpoint requires `template_ids` and accepts one metric type at a time, so this module makes
 * one call per metric and merges. Counts are delayed by Meta, so "today" is usually incomplete.
 */

const METRICS = ['SENT', 'DELIVERED', 'READ', 'CLICKED'] as const
export type MetricType = (typeof METRICS)[number]

export const ANALYTICS_METRICS: readonly MetricType[] = METRICS

export interface TemplateDayMetrics {
  templateId: string
  /** yyyy-mm-dd, UTC as Meta reports it. */
  day: string
  sent: number
  delivered: number
  read: number
  /** Every url_button tap, including repeats. */
  clicks: number
  /** Distinct people who tapped. The honest "how many clicked". */
  uniqueClicks: number
  /** Button labels that were tapped, for context. */
  buttonLabels: string[]
}

interface RawDataPoint {
  template_id: string
  start: number
  end: number
  sent?: number
  delivered?: number
  read?: number
  clicked?: Array<{ type?: string; button_content?: string; count?: number }>
}

interface RawResponse {
  data?: Array<{ data_points?: RawDataPoint[] }>
  error?: { message?: string; code?: number }
}

/** Merge one metric's response into the day map. Pure — this is the part worth testing. */
export function mergeAnalyticsResponse(
  acc: Map<string, TemplateDayMetrics>,
  metric: MetricType,
  payload: RawResponse
): void {
  for (const block of payload.data ?? []) {
    for (const point of block.data_points ?? []) {
      if (!point.template_id) continue
      const day = new Date(point.start * 1000).toISOString().slice(0, 10)
      const key = `${point.template_id}|${day}`
      const entry =
        acc.get(key) ??
        ({
          templateId: point.template_id,
          day,
          sent: 0,
          delivered: 0,
          read: 0,
          clicks: 0,
          uniqueClicks: 0,
          buttonLabels: [],
        } satisfies TemplateDayMetrics)

      if (metric === 'SENT') entry.sent += point.sent ?? 0
      else if (metric === 'DELIVERED') entry.delivered += point.delivered ?? 0
      else if (metric === 'READ') entry.read += point.read ?? 0
      else if (metric === 'CLICKED') {
        for (const c of point.clicked ?? []) {
          const count = c.count ?? 0
          // Meta reports both a total and a unique count; they are separate rows, not additive.
          if (c.type === 'unique_url_button') entry.uniqueClicks += count
          else entry.clicks += count
          if (count > 0 && c.button_content && !entry.buttonLabels.includes(c.button_content)) {
            entry.buttonLabels.push(c.button_content)
          }
        }
      }

      acc.set(key, entry)
    }
  }
}

/** Flatten the merged map into a sorted array (newest day first). */
export function toSortedRows(acc: Map<string, TemplateDayMetrics>): TemplateDayMetrics[] {
  return [...acc.values()].sort((a, b) => (a.day === b.day ? a.templateId.localeCompare(b.templateId) : b.day.localeCompare(a.day)))
}

export function analyticsConfig() {
  return {
    token: (process.env.WHATSAPP_TOKEN || '').trim(),
    wabaId: (process.env.WHATSAPP_WABA_ID || '').trim(),
    version: (process.env.WHATSAPP_API_VERSION || 'v21.0').trim(),
  }
}

export function isTemplateAnalyticsConfigured(): boolean {
  const c = analyticsConfig()
  return Boolean(c.token && c.wabaId)
}

export interface AnalyticsResult {
  ok: boolean
  rows: TemplateDayMetrics[]
  error?: string
}

/**
 * Meta rejects the whole request when more than this many template ids are passed — with an
 * unhelpful `(#100) template_ids` that names the parameter but not the problem. Measured
 * directly: 11 ids → 400, 10 → 200.
 */
export const ANALYTICS_TEMPLATE_ID_LIMIT = 10

/**
 * THE TRAP, measured against the live WABA: a `template_analytics` response is capped at about
 * this many data points, and Meta **silently truncates** beyond it — HTTP 200, with the
 * templates that have real activity simply missing or reported as zeros.
 *
 * A sweep with two known-active control templates:
 *
 *   ids=2  → 16 points, both templates,  control sent = 211  ✅
 *   ids=3  → 24 points, all three,      control sent = 211  ✅
 *   ids=4  → 25 points (capped),        control sent = 111  ⚠️ one control already lost
 *   ids=5+ → 25 points, 4 templates,    control sent = 0    ❌ data dropped entirely
 *
 * There is no pagination cursor to follow, so the only safe approach is to ask for as few
 * templates as the cap allows — and since a window of `days` yields roughly `days + 1` points per
 * template, that is ONE template at a time for any useful window.
 */
export const ANALYTICS_MAX_DATA_POINTS = 25

/** Widest window that still fits one template inside the point cap. */
export const ANALYTICS_MAX_DAYS = ANALYTICS_MAX_DATA_POINTS - 2

/** Split ids into request-sized chunks. Pure, so the batching is testable. */
export function chunkTemplateIds(ids: string[], size = ANALYTICS_TEMPLATE_ID_LIMIT): string[][] {
  const n = Math.max(1, size)
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += n) out.push(ids.slice(i, i + n))
  return out
}

/**
 * Fetch BUTTON CLICK analytics, one template per request.
 *
 * Only CLICKED is requested. Sent / delivered / read are already known accurately from the
 * webhook (nudge_message_log), and asking Meta for them too would multiply the requests for data
 * we already have — while making the response-cap trap above more likely to bite.
 *
 * Because of the cap, this is deliberately one template per request: at 4+ templates Meta starts
 * returning zeros for the templates that actually have activity. A handful of extra HTTP calls is
 * a far better trade than silently reporting zero clicks.
 */
export async function fetchTemplateClickAnalytics(opts: {
  templateIds: string[]
  days?: number
  fetchImpl?: typeof fetch
}): Promise<AnalyticsResult> {
  const { token, wabaId, version } = analyticsConfig()
  if (!token || !wabaId) {
    return { ok: false, rows: [], error: 'WHATSAPP_TOKEN / WHATSAPP_WABA_ID are not set.' }
  }
  if (!opts.templateIds.length) return { ok: true, rows: [] }

  const doFetch = opts.fetchImpl ?? fetch
  const days = Math.min(Math.max(1, opts.days ?? 7), ANALYTICS_MAX_DAYS)
  const end = Math.floor(Date.now() / 1000)
  const start = end - days * 24 * 60 * 60

  const acc = new Map<string, TemplateDayMetrics>()

  for (const id of opts.templateIds) {
    const url =
      `https://graph.facebook.com/${version}/${wabaId}/template_analytics` +
      `?start=${start}&end=${end}&granularity=DAILY&metric_types=CLICKED` +
      `&template_ids=${encodeURIComponent(JSON.stringify([id]))}`
    try {
      const res = await doFetch(url, { headers: { authorization: `Bearer ${token}` } })
      const payload = (await res.json()) as RawResponse
      if (!res.ok || payload.error) {
        return {
          ok: false,
          rows: toSortedRows(acc),
          error: `CLICKED for ${id}: ${payload.error?.message || `HTTP ${res.status}`}`,
        }
      }
      mergeAnalyticsResponse(acc, 'CLICKED', payload)

      // Guard against the silent truncation: if the response is at the cap, the window was too
      // wide for even one template, and the numbers would be partial.
      const points = (payload.data ?? []).reduce((n, b) => n + (b.data_points?.length ?? 0), 0)
      if (points >= ANALYTICS_MAX_DATA_POINTS) {
        return {
          ok: false,
          rows: toSortedRows(acc),
          error: `Meta truncated the response for ${id} at its ${ANALYTICS_MAX_DATA_POINTS}-point cap; narrow the window.`,
        }
      }
    } catch (err) {
      return { ok: false, rows: toSortedRows(acc), error: `${id}: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  return { ok: true, rows: toSortedRows(acc) }
}

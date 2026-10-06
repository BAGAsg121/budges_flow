/**
 * Reading a lead record out of an inbound CRM webhook.
 *
 * Shared by both webhooks — `/api/hooks/nudge/{key}` (trigger a nudge) and `/api/hooks/lead`
 * (record a stage change) — because a second copy of this logic is how one endpoint silently starts
 * accepting a shape the other rejects, and the failure mode is identical in both cases: a 200 with
 * no action, so the CRM marks the delivery a success while nothing happened.
 *
 * Zoho's webhook UI offers several body shapes and its choice is not documented anywhere reliable,
 * so all of them are parsed:
 *   • a flat record                      { "id": "…", "Lead_Status": "…" }
 *   • a module envelope                  { "Leads": { … } }
 *   • a data array                       { "data": [ { … } ] }
 *   • form-encoded fields                id=…&Lead_Status=…
 *   • the fields as query parameters     ?id=…&Lead_Status=…
 */

/** The lead-id field names Zoho uses across modules. */
const ID_KEYS = ['id', 'Id', 'ID', 'record_id', 'recordId', 'lead_id', 'leadId'] as const

/**
 * Read a Zoho record out of whatever envelope the webhook used.
 *
 * Returns null when no record-like object can be found, which callers turn into a 400. A silent
 * 200 here would be the worst outcome: the CRM records the delivery as successful and the lead is
 * never processed, with nothing anywhere saying so.
 */
export function extractRecord(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object') return null

  if (Array.isArray(body)) {
    return body.length ? extractRecord(body[0]) : null
  }

  const obj = body as Record<string, unknown>

  // Wrapped shapes first: Zoho sends { "Leads": { … } } for a module webhook.
  for (const key of ['Leads', 'leads', 'data', 'record', 'lead']) {
    const inner = obj[key]
    if (inner && typeof inner === 'object') return extractRecord(inner)
  }

  // A flat form post arrives as { field: string | string[] }. Collapse single-element arrays so
  // "Mobile: ['9876543210']" behaves like "Mobile: '9876543210'".
  const flat: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    flat[k] = Array.isArray(v) && v.length === 1 ? v[0] : v
  }
  return Object.keys(flat).length ? flat : null
}

/** Accept JSON, form-encoded, or query parameters — whichever the CRM chose. */
export async function readWebhookPayload(req: {
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  formData(): Promise<{ entries(): Iterable<[string, unknown]> }>
  text(): Promise<string>
  nextUrl: { searchParams: URLSearchParams }
}): Promise<Record<string, unknown> | null> {
  const contentType = (req.headers.get('content-type') || '').toLowerCase()

  if (contentType.includes('application/json')) {
    try {
      return extractRecord(await req.json())
    } catch {
      return null
    }
  }

  if (contentType.includes('form-urlencoded') || contentType.includes('multipart/form-data')) {
    try {
      const form = await req.formData()
      const obj: Record<string, unknown> = {}
      for (const [k, v] of form.entries()) obj[k] = typeof v === 'string' ? v : undefined
      return extractRecord(obj)
    } catch {
      return null
    }
  }

  // No/unknown content type: try JSON, then form, then fall back to the query string. Being
  // permissive is right here because the alternative is a lead that is never processed.
  const raw = await req.text().catch(() => '')
  if (raw.trim()) {
    try {
      const parsed = extractRecord(JSON.parse(raw))
      if (parsed) return parsed
    } catch {
      const params = new URLSearchParams(raw)
      const obj: Record<string, unknown> = {}
      for (const [k, v] of params.entries()) obj[k] = v
      const extracted = extractRecord(obj)
      if (extracted) return extracted
    }
  }

  const fromQuery: Record<string, unknown> = {}
  req.nextUrl.searchParams.forEach((v, k) => {
    // Never treat a credential in the URL as lead data.
    if (k === 'token' || k === 'secret') return
    fromQuery[k] = v
  })
  return Object.keys(fromQuery).length ? fromQuery : null
}

/**
 * The CRM record id, or an empty string.
 *
 * Zoho's record id is the only reliable key. Without it a repeat delivery cannot be recognised, and
 * matching on email or phone instead is how one lead's history ends up attributed to another.
 */
export function leadRecordId(payload: Record<string, unknown>): string {
  for (const key of ID_KEYS) {
    const v = payload[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return ''
}

/** The fields the payload actually carried, for error messages that can be acted on. */
export function payloadFields(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).sort()
}

/**
 * The status field, tolerating the spellings a hand-built Zoho webhook tends to produce.
 *
 * `Lead_Status` is the real API name; the others appear when someone typed the parameter by hand
 * into the workflow editor, and silently receiving nothing is a far worse outcome than accepting
 * an obvious alias.
 */
export function leadStatusFrom(payload: Record<string, unknown>): string | null {
  const KEYS = ['Lead_Status', 'lead_status', 'LeadStatus', 'leadStatus', 'Status', 'status']
  for (const key of KEYS) {
    const v = payload[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

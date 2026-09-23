/**
 * WhatsApp template parameter mapping.
 *
 * Kept dependency-free (no path aliases, no db import) so it can be unit-tested directly
 * by scripts/verify-changes.mjs — this is the code that decides which lead/DB value lands
 * in which `{{n}}` slot, and a silent off-by-one here shifts every later parameter.
 *
 * Accepted config forms (stored in Nudge.whatsappParams):
 *   ["first_name", "company"]                          legacy: body sources only
 *   { "body": ["first_name"], "button": ["mobile"] }   extended: body + URL-button values
 *
 * Order is always preserved. A missing value becomes the fallback placeholder rather than
 * being dropped, because dropping it would shift every later parameter into the wrong slot.
 */
export interface WhatsAppParamValues {
  body: string[]
  button: string[]
}

export function buildWhatsAppParams(
  config: string | null,
  vars: Record<string, unknown> = {},
  fallbackValue?: string
): WhatsAppParamValues {
  const fallback = fallbackValue ?? process.env.WHATSAPP_EMPTY_PARAM_FALLBACK ?? '-'

  const map = (sources: string[]): string[] =>
    sources.map((key) => {
      const value = vars[key]
      if (value === null || value === undefined || value === '') return fallback
      return String(value)
    })

  try {
    const parsed = JSON.parse(config || '[]')
    if (Array.isArray(parsed)) return { body: map(parsed.map(String)), button: [] }
    if (parsed && typeof parsed === 'object') {
      const body = Array.isArray((parsed as { body?: unknown }).body)
        ? ((parsed as { body: unknown[] }).body.map(String))
        : []
      const button = Array.isArray((parsed as { button?: unknown }).button)
        ? ((parsed as { button: unknown[] }).button.map(String))
        : []
      return { body: map(body), button: map(button) }
    }
  } catch {
    // Bad config -> send no parameters; Meta rejects if the template requires them,
    // which is a louder and more fixable failure than sending the wrong values.
  }
  return { body: [], button: [] }
}

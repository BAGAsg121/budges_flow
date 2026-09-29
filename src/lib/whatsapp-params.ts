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

/**
 * The variable NAMES the config reads, without resolving any values.
 *
 * Needed by the sheet-run pre-flight: when a nudge is sent from an uploaded sheet, every body
 * source has to be a column IN that sheet. Without this check `buildWhatsAppParams` silently
 * substitutes its fallback ("-") for the missing value and Meta accepts the send — so a
 * documents-pending template would go out with a literal "-" where the list of pending documents
 * should be. Failing the request with the column names is the loud, fixable outcome.
 *
 * Tolerates the same three config shapes as buildWhatsAppParams: a bare array (legacy body-only),
 * an object with `body`/`button`, and unparseable text (no sources).
 */
export function whatsappParamSources(config: string | null): WhatsAppParamValues {
  try {
    const parsed = JSON.parse(config || '[]')
    if (Array.isArray(parsed)) return { body: parsed.map(String), button: [] }
    if (parsed && typeof parsed === 'object') {
      const body = Array.isArray((parsed as { body?: unknown }).body)
        ? (parsed as { body: unknown[] }).body.map(String)
        : []
      const button = Array.isArray((parsed as { button?: unknown }).button)
        ? (parsed as { button: unknown[] }).button.map(String)
        : []
      return { body, button }
    }
  } catch {
    // Same reasoning as buildWhatsAppParams: a bad config yields no sources, not a crash.
  }
  return { body: [], button: [] }
}

/**
 * Variables a sheet run always supplies, so a sheet does not need a column for them.
 * Mirrors the derived values in sheet-vars.ts buildSheetVars().
 */
export const SHEET_DERIVED_VARS = new Set([
  'email',
  'mobile',
  'mobile_digits',
  'phone',
  'first_name',
  'full_name',
  'today',
  'message_number',
])

/** Body sources the sheet must carry a column for. `[]` means the template is self-contained. */
export function missingSheetColumns(
  config: string | null,
  sheetColumns: Iterable<string>
): string[] {
  const have = new Set<string>()
  for (const c of sheetColumns) have.add(String(c))
  return whatsappParamSources(config)
    .body.filter((src) => !SHEET_DERIVED_VARS.has(src) && !have.has(src))
    // Preserve declaration order but never report the same column twice.
    .filter((src, i, all) => all.indexOf(src) === i)
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

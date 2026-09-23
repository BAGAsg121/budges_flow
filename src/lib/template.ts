/**
 * Tiny mustache-style template renderer + open-tracking pixel injection.
 * Placeholders: {{full_name}}, {{first_name}}, {{email}}, {{company}}, {{lead_status}},
 * {{kyc_document_upload_count}}, {{message_number}}, {{today}}, {{owner_name}} ... any lead field.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface RenderOptions {
  /**
   * HTML-escape the substituted values (not the template). Use for HTML bodies so
   * lead-controlled data (company names, etc.) cannot inject markup into the email.
   */
  escapeValues?: boolean
}

export function renderTemplate(
  tpl: string,
  vars: Record<string, string | number | null | undefined>,
  opts: RenderOptions = {}
): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const v = vars[key]
    if (v === null || v === undefined || v === '') return ''
    const s = String(v)
    return opts.escapeValues ? escapeHtml(s) : s
  })
}

/** Append the 1x1 open-tracking pixel right before </body>, or at the end. */
export function injectTrackingPixel(html: string, baseUrl: string, trackingId: string): string {
  const pixel = `<img src="${baseUrl}/api/track/open/${trackingId}" width="1" height="1" alt="" style="display:none;border:0;outline:none;" />`
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${pixel}</body>`)
  return `${html}${pixel}`
}

/** Strip HTML tags for a plain-text alternative. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

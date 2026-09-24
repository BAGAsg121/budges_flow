/**
 * Sheet-row → template-variable helpers.
 *
 * Extracted so the sheet-run route and the retry-failed path build variables the SAME way.
 * A retry that rendered a subtly different body from the original send would be worse than
 * not retrying: the customer would get a message with a broken or missing mobile link.
 *
 * Lives in lib/ rather than being exported from the route, because a route module exporting
 * a helper has broken this build before.
 */

/** A parsed CSV row. Every cell is a string. */
export type SheetRow = Record<string, string>

export type TemplateVars = Record<string, string | number | null | undefined>

/** Sheets name the email column inconsistently; accept the common spellings. */
export function pickSheetEmail(row: SheetRow): string {
  return row['email'] || row['email_address'] || row['email_id'] || row['Email'] || ''
}

/** Same for the mobile column — this is what the pay/console link is built from. */
export function pickSheetMobile(row: SheetRow): string {
  return (
    row['mobile'] ||
    row['mobile_number'] ||
    row['mobilenumber'] ||
    row['phone'] ||
    row['phone_number'] ||
    row['contact'] ||
    row['contact_number'] ||
    row['whatsapp'] ||
    ''
  )
}

/**
 * Normalise a mobile to bare 10-digit national form.
 *
 * Zoho and the sheets store numbers as `9876543210`, `+91 98765 43210` and `0919876543210`
 * interchangeably, and the link must be stable across all of them. The `(?=\d{10}$)`
 * lookahead is what stops it eating a legitimate leading `91` in a 10-digit number.
 */
export function normaliseMobileDigits(mobile: string): string {
  return String(mobile)
    .replace(/\D/g, '')
    .replace(/^0+/, '')
    .replace(/^91(?=\d{10}$)/, '')
}

/**
 * Template variables for one sheet row. Spreads the whole row first, so any column can be
 * referenced by name, then adds the derived values the built-in templates rely on.
 */
export function buildSheetVars(
  row: SheetRow,
  opts: { email: string; mobile: string; now?: Date; messageNumber?: number }
): TemplateVars {
  const now = opts.now ?? new Date()
  const email = opts.email
  const mobile = opts.mobile

  const vars: TemplateVars = {
    ...row,
    email,
    today: now.toISOString().slice(0, 10),
    message_number: opts.messageNumber ?? 1,
    // Convenience aliases, so a template can say {{first_name}} without the sheet having
    // to provide it.
    first_name: row['first_name'] || row['name'] || (email ? email.split('@')[0] : ''),
    full_name: row['full_name'] || row['name'] || (email ? email.split('@')[0] : ''),
  }

  vars.mobile = mobile
  vars.phone = row['phone'] || mobile
  vars.mobile_digits = normaliseMobileDigits(mobile)

  return vars
}

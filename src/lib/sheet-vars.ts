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

/* ───────────────────── deciding who a sheet run sends to ───────────────────── */

export interface SheetPlanOptions {
  isWhatsApp: boolean
  /** Injected so this module stays free of the WhatsApp/api dependencies. */
  normalisePhone: (raw: string) => string | null
}

export interface PlannedSend {
  /** Position in the sheet, 1-based, for reporting. */
  rowNumber: number
  row: SheetRow
  email: string
  mobile: string
  /** The address the send is keyed on: a normalised phone for WhatsApp, else the email. */
  address: string
}

export interface PlannedSkip {
  rowNumber: number
  lead: string
  email: string | null
  reason: 'no_valid_phone' | 'no_email_column' | 'duplicate_in_sheet'
  detail?: string
}

export interface SheetPlan {
  toSend: PlannedSend[]
  skipped: PlannedSkip[]
}

/**
 * Decide which sheet rows to send to — **the sheet is the source of truth**.
 *
 * History is deliberately NOT consulted. An earlier version skipped any address with a previous
 * successful send on the same nudge, so re-uploading a corrected sheet silently delivered nothing
 * and the operator saw "skipped · duplicate" for people who never received the message.
 *
 * The only de-duplication is within this run: an address repeated in the sheet is collapsed to a
 * single send. Running the same sheet twice therefore sends twice — intended, and why the
 * Send-from-Sheet button is not idempotent.
 *
 * Pure and synchronous, so the whole policy is unit-testable without a database or an API call.
 */
export function planSheetSends(rows: SheetRow[], opts: SheetPlanOptions): SheetPlan {
  const toSend: PlannedSend[] = []
  const skipped: PlannedSkip[] = []
  const seen = new Set<string>()

  rows.forEach((row, index) => {
    const rowNumber = index + 1
    const email = pickSheetEmail(row)
    const mobile = pickSheetMobile(row)
    const toPhone = opts.isWhatsApp ? opts.normalisePhone(mobile) : null

    if (opts.isWhatsApp && !toPhone) {
      skipped.push({
        rowNumber,
        lead: email || JSON.stringify(row).slice(0, 60),
        email: email || null,
        reason: 'no_valid_phone',
        detail: 'WhatsApp sheet-run needs a mobile column',
      })
      return
    }
    if (!opts.isWhatsApp && !email) {
      skipped.push({
        rowNumber,
        lead: JSON.stringify(row).slice(0, 60),
        email: null,
        reason: 'no_email_column',
      })
      return
    }

    const address = (opts.isWhatsApp ? (toPhone as string) : email).toLowerCase()
    if (seen.has(address)) {
      skipped.push({
        rowNumber,
        lead: email || mobile,
        email: email || null,
        reason: 'duplicate_in_sheet',
        detail: 'this address appears more than once in the sheet — sent once',
      })
      return
    }
    seen.add(address)

    toSend.push({ rowNumber, row, email, mobile, address })
  })

  return { toSend, skipped }
}

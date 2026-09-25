/**
 * How a nudge gets its recipients, and what that implies.
 *
 * There are three sources, distinguished WITHOUT extra database columns (see nudge-defaults):
 *
 *   zoho   — lead-driven: a Zoho criteria string selects synced leads, and the engine walks them
 *   mysql  — reads the business database read-only
 *   sheet  — manual: the operator pastes a Google Sheet URL and the route walks the rows
 *
 * This lives in its own module because the distinction decides whether the per-lead message cap
 * (`maxEmailsPerLead` / `followUpDays`) means anything at all — and the nudge editor, the
 * dashboard and the run paths all need to agree on that.
 */

export type NudgeSource = 'zoho' | 'mysql' | 'sheet'

export interface NudgeLike {
  zohoCriteria?: string | null
  filters?: string | null
}

/** Which of the three sources drives this nudge. */
export function nudgeSourceOf(n: NudgeLike): NudgeSource {
  try {
    const f = JSON.parse(n.filters || '{}') as { source?: string }
    if (f.source === 'mysql') return 'mysql'
  } catch {
    // unparseable filters -> fall through to the other signals
  }
  return n.zohoCriteria && n.zohoCriteria.trim() ? 'zoho' : 'sheet'
}

/** True when the operator supplies the recipient list (a Google Sheet) rather than a query. */
export function isManualSheetNudge(n: NudgeLike): boolean {
  return nudgeSourceOf(n) === 'sheet'
}

/**
 * Whether `maxEmailsPerLead` / `followUpDays` have any effect on this nudge.
 *
 * They do NOT for sheet nudges. Those are sent by the sheet-run route, which never calls
 * `decideSend`; it applies its own rule instead — one message per recipient, ever, skipping
 * anyone with an earlier successful send to the same address on the same nudge.
 *
 * This was assumed to apply for a while and it silently did not: the caps were "raised to 3,
 * spaced 2 days" on four sheet nudges and nothing changed, because nothing read them. Hence
 * this function, so the UI can stop offering a control that does nothing.
 */
export function capAppliesTo(n: NudgeLike): boolean {
  return nudgeSourceOf(n) !== 'sheet'
}

/** The rule that actually governs a sheet nudge, for display. */
export const SHEET_DEDUP_RULE =
  'Each recipient is messaged once — anyone with an earlier successful send on this nudge is skipped.'

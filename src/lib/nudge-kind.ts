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
 * `decideSend`: **the sheet decides who gets messaged.** Every row is sent, history is never
 * consulted, and the only de-duplication is within a single run (a repeated address is collapsed
 * to one send).
 *
 * This was assumed to apply for a while and it silently did not: the caps were "raised to 3,
 * spaced 2 days" on four sheet nudges and nothing changed, because nothing read them. Hence this
 * function, so the UI can stop offering a control that does nothing.
 */
export function capAppliesTo(n: NudgeLike): boolean {
  return nudgeSourceOf(n) !== 'sheet'
}

/** The rule that actually governs a sheet nudge, for display. */
export const SHEET_DEDUP_RULE =
  'Every row in the sheet is sent, even to someone this nudge has messaged before. ' +
  'The only de-duplication is within one run: a repeated number or email is collapsed to a single send.'

/** Does this nudge consult past sends before sending again? False for sheet nudges. */
export function skipsAlreadyMessaged(n: NudgeLike): boolean {
  return nudgeSourceOf(n) !== 'sheet'
}

/**
 * May this nudge be run right now?
 *
 * `enabled` means "the scheduler and the automatic paths may act on this". It is deliberately
 * separate from "may the operator send it once, by hand": a nudge often has to stay disabled while
 * its template is pending, or while it is being set up, and an operator who has just clicked a
 * button labelled with the audience it will reach has made the decision explicitly. So `force`
 * permits a single deliberate run and nothing else — it never turns the nudge on, and the scheduler
 * still ignores it.
 *
 * Kept here, dependency-free, so the rule is testable and so the UI and the API cannot disagree
 * about when the button is available.
 */
export function runGuard(
  nudge: { enabled: boolean },
  force?: boolean
): { ok: true; forced: boolean } | { ok: false; error: string } {
  if (nudge.enabled) return { ok: true, forced: false }
  if (force) return { ok: true, forced: true }
  return {
    ok: false,
    error:
      'Nudge is disabled. Enable it first, or run it once with an explicit force (the UI offers ' +
      '"Fetch & Send" for this) — enabling it is what lets the scheduler send it automatically.',
  }
}

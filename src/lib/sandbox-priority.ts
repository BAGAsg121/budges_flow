/**
 * Which sandbox nudge wins when more than one matches the same lead.
 *
 * Kept dependency-free (no Prisma, no engine) so the verification suite can assert that the list
 * covers every sandbox nudge. A newly added nudge that is missing from here would still send — the
 * dispatcher sorts unknown keys LAST — but it would silently lose every priority contest, which is
 * exactly the kind of quiet misbehaviour that takes weeks to notice.
 */

/**
 * Ordered by how much the message matters to the recipient RIGHT NOW: a Closed Won or a rejected
 * document needs action today, whereas a placeholder name has waited weeks and can wait one more
 * webhook. Reorder this list to change the policy — it is the only place priority is expressed.
 */
export const SANDBOX_PRIORITY: string[] = [
  // Account is live — the question they ask next is about credentials.
  'sandbox_closed_won_live_credentials',
  // Documents were rejected: the application cannot progress until they act.
  'sandbox_documents_resubmission',
  // Documents approved; e-sign is the next step.
  'sandbox_documents_accepted',
  // Eko Code issued, agreement unsigned.
  'sandbox_sign_agreement_pending',
  // Documents are in and under review — informational.
  'sandbox_documents_under_review',
  // Signup abandoned with an unfilled name field.
  'sandbox_placeholder_name_onboarding',
  // Signup abandoned before an Eko Code was issued.
  'sandbox_old_website_lead',
  // No email on record — the weakest hook, and the one most likely to overlap everything else.
  'sandbox_email_missing',
]

/**
 * Priority index for a nudge key.
 *
 * An unlisted key sorts LAST rather than first: a new nudge should not outrank the messages that
 * were deliberately ordered, and losing a contest is visible in the dispatch response.
 */
export function sandboxRankOf(key: string): number {
  const i = SANDBOX_PRIORITY.indexOf(key)
  return i === -1 ? SANDBOX_PRIORITY.length : i
}

/** Sorts a list of nudges by dispatch priority, without mutating the input. */
export function sortBySandboxPriority<T extends { key: string }>(nudges: T[]): T[] {
  return [...nudges].sort((a, b) => sandboxRankOf(a.key) - sandboxRankOf(b.key))
}

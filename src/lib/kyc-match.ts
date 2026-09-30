/**
 * The KYC count-comparison rules: how a lead's uploaded documents compare with the number expected.
 *
 * Two nudges use this, from the SAME pool of leads (EPS + Lead_Status "Documents Pending") and
 * differing only in the comparison:
 *
 *   equals     — upload === expected → "all your documents are in, we are reviewing them"
 *                (`documents_submitted_review`)
 *   less_than  — upload <  expected   → "your document upload is still pending"
 *                (`documents_pending_wa`)
 *
 * Kept in its own dependency-free module for two reasons:
 *   1. It compares two columns OF THE SAME ROW, which Prisma's `where` cannot express. So unlike
 *      the other filters it cannot live in buildWhere() — it is a post-query predicate, and every
 *      caller (runNudge, previewNudge, the CRM webhook) must apply the SAME one.
 *   2. scripts/verify-changes.mjs can therefore test it directly, with no database.
 *
 * WHY THE NULL AND ZERO GUARDS ARE THE WHOLE POINT — measured on the live CRM, EPS leads with
 * Lead_Status = "Documents Pending": of 39 leads, KYC_Documents_Expected_Count is NULL on 25 of
 * them (64%), and 0 on none. An unknown expectation means "we do not know what complete looks
 * like", so it can never satisfy either rule:
 *
 *   • For `equals`, `null === null` is true in JS — a naive equality test would nudge most of the
 *     cohort on the false claim that their documents are all in.
 *   • For `less_than`, `null < null` and `0 < 0` are false, so those happen to be safe by accident —
 *     but `upload < 0` is also false while `upload < null` coerces to `upload < 0` in JS, and a
 *     lead with a real upload count and an unknown expectation would then be silently dropped
 *     instead of reported. Both values must be REQUIRED and the reason reported, not coerced.
 *
 * So both counts must be present, the expectation must be positive, and every refusal carries a
 * machine-readable reason.
 */

/** Which comparison to apply. */
export type KycRule = 'equals' | 'less_than'

export interface KycCounts {
  kycDocumentUploadCount: number | null
  kycDocumentsExpectedCount: number | null
}

/** Filters that can carry a rule, in either the current or the legacy spelling. */
export interface KycFilterShape {
  kycCountRule?: KycRule
  /** Legacy spelling for `kycCountRule: 'equals'`, kept so existing nudges keep working. */
  kycMatchesExpected?: boolean
}

export type KycRefusalReason =
  | 'kyc_expected_unknown'
  | 'kyc_expected_zero'
  | 'kyc_upload_unknown'
  | 'kyc_counts_differ'
  | 'kyc_counts_not_less'
  | 'kyc_rule_conflict'

/** What the rule decided, for reporting. */
export interface KycMatchResult {
  matches: boolean
  /** Present when it does not match, in words that can go straight into a skip reason. */
  reason?: KycRefusalReason
}

/**
 * Which rule this filter asks for, or null when the nudge does not use one.
 *
 * `kycMatchesExpected: true` is accepted as a legacy alias for `equals` so a nudge configured
 * before the rule became an enum keeps behaving identically. Setting BOTH spellings to different
 * rules is a configuration mistake, not a preference — it is reported rather than silently
 * resolved, because guessing which one the operator meant could message the wrong people.
 */
export function kycRuleOf(filters: KycFilterShape): KycRule | 'conflict' | null {
  const declared = filters.kycCountRule
  const legacy = filters.kycMatchesExpected === true ? 'equals' : null

  if (declared && legacy && declared !== legacy) return 'conflict'
  return declared ?? legacy
}

/** Convenience: does this nudge use a count rule at all? */
export function hasKycRule(filters: KycFilterShape): boolean {
  return kycRuleOf(filters) !== null
}

/** Kept for the wording used elsewhere: "does this filter require a KYC comparison". */
export function requiresKycMatch(filters: KycFilterShape): boolean {
  return hasKycRule(filters)
}

/**
 * Apply one comparison.
 *
 * `equals` is deliberately not "at least": the nudge claims every document is in, so a lead that
 * uploaded MORE than expected is a data anomaly for a human rather than a "you're done".
 */
export function checkKycCounts(lead: KycCounts, rule: KycRule = 'equals'): KycMatchResult {
  const upload = lead.kycDocumentUploadCount
  const expected = lead.kycDocumentsExpectedCount

  if (expected === null || expected === undefined) return { matches: false, reason: 'kyc_expected_unknown' }
  if (expected <= 0) return { matches: false, reason: 'kyc_expected_zero' }
  if (upload === null || upload === undefined) return { matches: false, reason: 'kyc_upload_unknown' }

  if (rule === 'equals') {
    return upload === expected ? { matches: true } : { matches: false, reason: 'kyc_counts_differ' }
  }
  return upload < expected ? { matches: true } : { matches: false, reason: 'kyc_counts_not_less' }
}

/** Convenience for the callers that only need the boolean. */
export function kycCountsMatch(lead: KycCounts, rule: KycRule = 'equals'): boolean {
  return checkKycCounts(lead, rule).matches
}

/**
 * Split a batch of leads into the ones the rule keeps and the ones it refuses.
 *
 * This is the ONLY place a rule is applied. It lives here, beside the rules and away from the
 * database, so that runNudge, previewNudge and the CRM webhook cannot drift apart — and so it can
 * be tested directly. Rejections carry the machine-readable reason, because a run that sends
 * nothing has to be able to say why instead of looking broken.
 *
 * A conflicting configuration (`kycRuleConflict`) refuses the WHOLE batch rather than picking a
 * rule: sending on a guess is worse than sending nothing and saying so.
 */
export function splitByKycMatch<T extends KycCounts>(
  leads: T[],
  filters: KycFilterShape
): { kept: T[]; rejected: { lead: T; reason: string }[] } {
  const rule = kycRuleOf(filters)
  if (rule === null) return { kept: leads, rejected: [] }
  if (rule === 'conflict') {
    return { kept: [], rejected: leads.map((lead) => ({ lead, reason: 'kyc_rule_conflict' })) }
  }

  const kept: T[] = []
  const rejected: { lead: T; reason: string }[] = []
  for (const lead of leads) {
    const verdict = checkKycCounts(lead, rule)
    if (verdict.matches) kept.push(lead)
    else rejected.push({ lead, reason: verdict.reason ?? 'kyc_counts_differ' })
  }
  return { kept, rejected }
}

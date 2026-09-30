/**
 * "All documents submitted" rule: KYC_Document_Upload_Count matches KYC_Documents_Expected_Count.
 *
 * Kept in its own dependency-free module for two reasons:
 *   1. It compares two columns OF THE SAME ROW, which Prisma's `where` cannot express. So unlike
 *      the other filters it cannot live in buildWhere() — it is a post-query predicate, and the
 *      callers (runNudge, previewNudge, the CRM webhook) must all apply the SAME one.
 *   2. scripts/verify-changes.mjs can therefore test it directly, with no database.
 *
 * WHY THE NULL AND ZERO GUARDS ARE THE WHOLE POINT — measured on the live CRM, EPS leads with
 * Lead_Status = "Documents Pending": of 39 leads, KYC_Documents_Expected_Count is NULL on 25 of
 * them (64%), and 0 on none. So the naive "the counts match" test is dangerous in two ways:
 *
 *   • `null === null` is true in JS. A plain equality test would nudge every lead whose expected
 *     count has never been filled in — i.e. most of the cohort — on the false claim that their
 *     documents are all in.
 *   • `0 === 0` is also true, and would nudge anyone with both fields blank-but-zero for the same
 *     wrong reason.
 *
 * An unknown expected count means "we do not know what complete looks like", which must never be
 * treated as "complete". Hence both values must be present AND the expectation must be positive.
 */

export interface KycCounts {
  kycDocumentUploadCount: number | null
  kycDocumentsExpectedCount: number | null
}

/** What the rule decided, for reporting. */
export interface KycMatchResult {
  matches: boolean
  /** Present when it does not match, in words that can go straight into a skip reason. */
  reason?: 'kyc_expected_unknown' | 'kyc_expected_zero' | 'kyc_counts_differ' | 'kyc_upload_unknown'
}

/**
 * True only when the upload count equals a KNOWN, POSITIVE expected count.
 *
 * Equality, not "at least": the nudge says "all the documents are submitted", which is a claim
 * about the counts agreeing. A lead that has uploaded MORE than expected is a data anomaly and
 * should be looked at by a human rather than told it is complete.
 */
export function checkKycCounts(lead: KycCounts): KycMatchResult {
  const upload = lead.kycDocumentUploadCount
  const expected = lead.kycDocumentsExpectedCount

  if (expected === null || expected === undefined) return { matches: false, reason: 'kyc_expected_unknown' }
  if (expected <= 0) return { matches: false, reason: 'kyc_expected_zero' }
  if (upload === null || upload === undefined) return { matches: false, reason: 'kyc_upload_unknown' }
  if (upload !== expected) return { matches: false, reason: 'kyc_counts_differ' }

  return { matches: true }
}

/** Convenience for the callers that only need the boolean. */
export function kycCountsMatch(lead: KycCounts): boolean {
  return checkKycCounts(lead).matches
}

/** True when this filter is on. Nudges without it are unaffected. */
export function requiresKycMatch(filters: { kycMatchesExpected?: boolean }): boolean {
  return filters.kycMatchesExpected === true
}

/**
 * Split a batch of leads into the ones the rule keeps and the ones it refuses.
 *
 * This is the ONLY place the rule is applied. It lives here, beside the rule itself and away from
 * the database, so that runNudge, previewNudge and the CRM webhook cannot drift apart — and so it
 * can be tested directly. Rejections carry the machine-readable reason, because a run that sends
 * nothing has to be able to say why instead of looking broken.
 */
export function splitByKycMatch<T extends KycCounts>(
  leads: T[],
  filters: { kycMatchesExpected?: boolean }
): { kept: T[]; rejected: { lead: T; reason: string }[] } {
  if (!requiresKycMatch(filters)) return { kept: leads, rejected: [] }

  const kept: T[] = []
  const rejected: { lead: T; reason: string }[] = []
  for (const lead of leads) {
    const verdict = checkKycCounts(lead)
    if (verdict.matches) kept.push(lead)
    else rejected.push({ lead, reason: verdict.reason ?? 'kyc_counts_differ' })
  }
  return { kept, rejected }
}

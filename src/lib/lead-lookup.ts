/**
 * Resolve a CRM record id from an email address, for sends that have no lead row.
 *
 * WHY THIS EXISTS: the "email sent" note needs the CRM record id. Lead-driven nudges have it
 * (`lead.zohoId`), but a **Google-Sheet** send does not — the sheet supplies an email address and
 * nothing else, so `leadId` was left null and no note was ever written. That is why a mail could be
 * sent from the app and leave no trace on the lead in the CRM.
 *
 * THE RISK, AND WHY THIS REFUSES AMBIGUITY: email is NOT unique in this CRM — there are 126 groups
 * of leads sharing one address. Picking "the first" would attach a note to a stranger's record, and
 * a note that lands on the wrong customer is worse than a missing note, because it looks like proof.
 * So a match is only returned when EXACTLY ONE lead has that address. Two or more and the caller
 * gets `ambiguous`, which is reported rather than guessed at.
 */
import { db } from '@/lib/db'

export type LeadMatch =
  | { kind: 'matched'; zohoId: string; leadId: string; fullName: string | null }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }

/** Normalise the way the rest of the app stores it: trimmed, lowercased. */
export function normaliseEmail(email: string | null | undefined): string {
  return (email || '').trim().toLowerCase()
}

export async function resolveLeadByEmail(email: string | null | undefined): Promise<LeadMatch> {
  const wanted = normaliseEmail(email)
  if (!wanted) return { kind: 'none' }

  // Bounded: two is enough to know it is ambiguous, and a sheet of 400 rows should not turn a
  // duplicate address into a 400-row scan of the lead table.
  const matches = await db.lead.findMany({
    where: { email: wanted },
    select: { id: true, zohoId: true, fullName: true },
    take: 2,
  })

  if (matches.length === 0) return { kind: 'none' }
  if (matches.length > 1) {
    const total = await db.lead.count({ where: { email: wanted } })
    return { kind: 'ambiguous', count: total }
  }
  const only = matches[0]
  return { kind: 'matched', zohoId: only.zohoId, leadId: only.id, fullName: only.fullName }
}

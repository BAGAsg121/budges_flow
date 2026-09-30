/**
 * The send-sequence rule: given a lead's message history, may we send again?
 *
 * Extracted from nudge-engine.ts and kept dependency-free (it imports only whatsapp-errors, which
 * has no database or API imports) so scripts/verify-changes.mjs can test it directly. This is the
 * rule behind every cadence promise in the app — "once per recipient", "3 messages 2 days apart",
 * "at most once a day for a week" — which were previously only asserted by reading the code.
 *
 * THE FOUR DECISIONS, in order:
 *   1. Replied → stop. A customer who answered must not be nudged again.
 *   2. Meta capped the last attempt → wait out the cap. Only the MOST RECENT failure counts, so a
 *      later success clears it; retrying every cycle just repeats the same failure and floods the log.
 *   3. `maxEmailsPerLead` successful sends reached → stop, permanently.
 *   4. `followUpDays` has not yet elapsed since the last success → wait.
 *
 * Note 3 counts SUCCESSFUL sends only, and 4 measures from the last SUCCESS: a failed attempt must
 * not consume the allowance, or a transient provider error would silently end the sequence.
 *
 * The cap detection and backoff hours are IMPORTED rather than reimplemented — a local copy is how
 * two definitions of "Meta capped this" drift apart, and the one in the send path is the one that
 * decides whether a message actually goes out.
 */
import { isDeliveryCapError, capBackoffHours } from './whatsapp-errors.ts'

export { capBackoffHours }

export interface SendDecision {
  action: 'send' | 'skip'
  reason?: string
  detail?: string
  messageNumber?: number
}

/** The parts of a MessageLog row this rule needs. */
export interface SequenceLog {
  sentOk: boolean
  replied: boolean
  sentAt: Date | null
  createdAt: Date
  sendError: string | null
}

export function decideSend(
  logs: SequenceLog[],
  maxEmailsPerLead: number,
  followUpDays: number,
  now: Date
): SendDecision {
  if (logs.some((l) => l.replied)) return { action: 'skip', reason: 'replied' }

  const newest = [...logs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
  if (newest && !newest.sentOk && isDeliveryCapError(newest.sendError)) {
    const retryAt = new Date(newest.createdAt.getTime() + capBackoffHours() * 60 * 60 * 1000)
    if (now < retryAt) {
      return {
        action: 'skip',
        reason: 'delivery_cap_backoff',
        detail: `Meta capped this recipient — retry after ${retryAt.toISOString().slice(0, 16).replace('T', ' ')}`,
      }
    }
  }

  const sentOkLogs = logs.filter((l) => l.sentOk && l.sentAt)
  if (sentOkLogs.length >= maxEmailsPerLead) {
    return { action: 'skip', reason: 'max_reached', detail: `${sentOkLogs.length}/${maxEmailsPerLead} already sent` }
  }

  if (sentOkLogs.length > 0 && followUpDays > 0) {
    const lastSentAt = sentOkLogs
      .map((l) => l.sentAt as Date)
      .sort((a, b) => b.getTime() - a.getTime())[0]
    const nextEligibleAt = new Date(lastSentAt.getTime() + followUpDays * 24 * 60 * 60 * 1000)
    if (now < nextEligibleAt) {
      return {
        action: 'skip',
        reason: 'waiting_followup',
        detail: `next eligible ${nextEligibleAt.toISOString().slice(0, 16).replace('T', ' ')}`,
      }
    }
  }

  return { action: 'send', messageNumber: sentOkLogs.length + 1 }
}

/** Build a successfully-sent log row `hoursAgo` before `now`, for cadence checks. */
export function sentLog(now: Date, hoursAgo: number): SequenceLog {
  const at = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000)
  return { sentOk: true, replied: false, sentAt: at, createdAt: at, sendError: null }
}

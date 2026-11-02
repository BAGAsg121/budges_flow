/**
 * Pick the ONE sandbox WhatsApp nudge that applies to a lead, and send it.
 *
 * WHY THIS EXISTS: the CRM already calls `POST /api/hooks/lead` on every lead change, but that hook
 * only records the change — it never sends. The per-nudge hook (`/api/hooks/nudge/{key}`) can send,
 * but it needs the caller to name the nudge, so the CRM (or n8n) has to already know which message a
 * lead needs. This decides it here, so a status or KYC change on a lead produces the right nudge
 * without anyone maintaining that mapping in a workflow.
 *
 * TWO DELIBERATE RULES, both chosen by the operator:
 *
 *  1. **One nudge per change, highest priority wins.** Several rules can match the same lead at once
 *     — no email AND a rejected document, say. Sending both in the same minute reads as spam, so
 *     they are ranked and only the first match goes out. The losers are reported with the reason they
 *     lost, so "why didn't the other one send?" is answerable from the response.
 *
 *  2. **`enabled` is IGNORED here.** Normally `runGuard()` refuses a disabled nudge, because a
 *     scheduled sweep of 6,000 leads should never start messaging from a nudge somebody switched off.
 *     A CRM webhook is a different shape of traffic: a status change touches one lead, or a handful
 *     in a bulk edit. The blast radius is one lead per call by construction, so a disabled nudge
 *     still fires. The sequence rule (`maxEmailsPerLead`, `followUpDays`, "replied → stop") still
 *     applies and is what actually prevents repeats.
 */
import { db } from '@/lib/db'
import { deliverToLead } from '@/lib/nudge-engine'
import { evaluateNudgeForLead, type Eligibility } from '@/lib/lead-eligibility'
import { sortBySandboxPriority } from './sandbox-priority.ts'
import type { Lead, Nudge } from '@prisma/client'

// The ranking lives in a dependency-free module so the verification suite can assert that it covers
// every sandbox nudge. Re-exported here so callers only import this module.
export { SANDBOX_PRIORITY, sandboxRankOf, sortBySandboxPriority } from './sandbox-priority.ts'

export interface DispatchSkipped {
  nudgeKey: string
  reason: string
  detail?: string
}

export interface DispatchResult {
  /** 'sent' when a nudge went out, 'none' when nothing matched, 'failed' when the send errored. */
  action: 'sent' | 'none' | 'failed'
  nudgeKey?: string
  channel?: string
  templateName?: string | null
  messageNumber?: number
  toPhone?: string | null
  error?: string | null
  /** The nudge that failed the send, if any. */
  failedNudgeKey?: string
  /** Every nudge considered, with why it did not win. Never more than the priority list length. */
  evaluated: DispatchSkipped[]
}

function isSandbox(nudge: Nudge): boolean {
  try {
    return JSON.parse(nudge.filters || '{}')?.category === 'sandbox_whatsapp'
  } catch {
    return false
  }
}

/** The minimum a lead must expose. */

/**
 * Run the best-matching sandbox nudge for this lead. Never throws — the CRM must get an answer.
 */
export async function dispatchSandboxNudge(
  lead: Lead,
  baseUrl: string,
  now: Date = new Date()
): Promise<DispatchResult> {
  const all = await db.nudge.findMany({ where: { channel: 'whatsapp' } })
  const candidates = sortBySandboxPriority(all.filter(isSandbox))

  if (candidates.length === 0) {
    return { action: 'none', evaluated: [] }
  }

  const evaluated: DispatchSkipped[] = []

  for (const nudge of candidates) {
    const verdict: Eligibility = await evaluateNudgeForLead(nudge, lead, now)

    if (!verdict.ok) {
      evaluated.push({ nudgeKey: nudge.key, reason: verdict.reason, detail: verdict.detail })
      continue
    }

    // First match wins — stops here, so the remaining nudges are NOT attempted.
    const delivery = await deliverToLead({
      nudge,
      lead,
      messageNumber: verdict.messageNumber,
      baseUrl,
      now,
    })

    if (delivery.skipped) {
      evaluated.push({ nudgeKey: nudge.key, reason: delivery.skipped })
      continue
    }

    if (!delivery.ok) {
      return {
        action: 'failed',
        nudgeKey: nudge.key,
        failedNudgeKey: nudge.key,
        channel: nudge.channel,
        templateName: delivery.templateName ?? null,
        toPhone: delivery.toPhone ?? null,
        error: delivery.error ?? null,
        evaluated,
      }
    }

    return {
      action: 'sent',
      nudgeKey: nudge.key,
      channel: nudge.channel,
      templateName: delivery.templateName ?? null,
      messageNumber: verdict.messageNumber,
      toPhone: delivery.toPhone ?? null,
      evaluated,
    }
  }

  return { action: 'none', evaluated }
}

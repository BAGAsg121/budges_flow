/**
 * POST /api/hooks/nudge/{key} — one CRM record in, one nudge decision out.
 *
 * Built so a Zoho CRM workflow can push a lead the moment it qualifies, instead of waiting for
 * the next scheduled sweep. The body is whatever the CRM sends: a flat record, `{ "Leads": { … } }`,
 * a `{ "data": [ … ] }` envelope, or form-encoded fields — all are accepted, because Zoho's
 * webhook UI offers several shapes and getting this wrong shows up only as silence.
 *
 * AUTH: LEAD_WEBHOOK_SECRET via `x-webhook-secret`, `Authorization: Bearer`, or `?token=`.
 * The query parameter exists because a URL is the one field every CRM webhook editor exposes;
 * it is named `token` so nobody mistakes it for something shareable. Fails CLOSED: no secret
 * configured means every call is refused, never allowed.
 *
 * WHAT IT DOES NOT DO: it never trusts the payload to decide eligibility. The record is stored,
 * then the SAME filter chain the scheduled run uses decides — includeStatuses, businessVertical,
 * requirePhone, and the KYC row predicate — followed by the same `decideSend` sequence check. So a
 * webhook cannot message someone a manual run would refuse, and a repeated delivery cannot message
 * them twice (maxEmailsPerLead is honoured). The send itself goes through the one shared
 * `deliverToLead`, so the template, parameters, trackingId and CTA destination are identical to a
 * run-triggered send.
 *
 * The response is always a verdict the CRM can log: `sent`, or a specific `skipped` reason. A
 * delivery failure is reported as `failed` with the provider error rather than a 500, because the
 * CRM only needs to know whether to retry the record.
 *
 * READ-ONLY WITH RESPECT TO THE CRM: this consumes what it is given and calls the business DB for
 * nothing. There is no per-lead CRM lookup.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { mapZohoLead, type ZohoLead } from '@/lib/zoho'
import {
  deliverToLead,
  parseFilters,
  nudgeSource,
  sequenceDecision,
} from '@/lib/nudge-engine'
import { splitByKycMatch } from '@/lib/kyc-match'
import { getStaticBaseUrl } from '@/lib/base-url'
import { isLeadWebhookAuthorized } from '@/lib/cron-auth'
import { explainWhatsAppError } from '@/lib/whatsapp-errors'
import { leadRecordId, payloadFields, readWebhookPayload } from '@/lib/webhook-payload'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * The payload reading that used to live here moved to @/lib/webhook-payload, shared with
 * /api/hooks/lead. Two copies of "which Zoho body shapes do we accept" is how one endpoint starts
 * silently rejecting a shape the other accepts — and the failure is invisible in both cases.
 */

export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params

  if (!isLeadWebhookAuthorized(req)) {
    // 401 even when the secret is unset — never a 200 with no action, which would look like a
    // working integration while nothing ever sends.
    return NextResponse.json(
      {
        ok: false,
        error: process.env.LEAD_WEBHOOK_SECRET
          ? 'unauthorized: pass the secret as ?token=, x-webhook-secret, or Authorization: Bearer'
          : 'LEAD_WEBHOOK_SECRET is not configured on the server, so this webhook is closed',
      },
      { status: 401 }
    )
  }

  const nudge = await db.nudge.findUnique({ where: { key } })
  if (!nudge) {
    return NextResponse.json({ ok: false, error: `No nudge with key "${key}"` }, { status: 404 })
  }
  if (!nudge.enabled) {
    return NextResponse.json(
      { ok: false, error: `Nudge "${key}" is disabled — enable it before pointing the CRM at this URL` },
      { status: 409 }
    )
  }
  if (nudgeSource(nudge) === 'mysql') {
    return NextResponse.json(
      { ok: false, error: `Nudge "${key}" is a MySQL flow; its recipients come from the business DB, not a CRM webhook` },
      { status: 400 }
    )
  }

  const payload = await readWebhookPayload(req)
  if (!payload) {
    return NextResponse.json(
      { ok: false, error: 'Could not read a lead record from the request body' },
      { status: 400 }
    )
  }

  // Zoho's record id is the only reliable key. Without it we would have to match on email/phone,
  // which is how one lead's send history ends up attributed to another.
  const zohoId = leadRecordId(payload)
  if (!zohoId) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'The payload has no lead id. Configure the CRM webhook to send the record id — sends are ' +
          'keyed on it, and without it a repeat delivery cannot be recognised.',
        receivedFields: payloadFields(payload),
      },
      { status: 400 }
    )
  }

  const mapped = mapZohoLead({ ...payload, id: zohoId } as unknown as ZohoLead)

  // Only write the fields the CRM actually sent. mapZohoLead maps an ABSENT field to null, and
  // writing those through an update would blank out values the webhook did not mention — a sparse
  // Zoho webhook payload would wipe a lead's email, status and mobile. The full object is still
  // used on CREATE, where there is nothing to lose.
  const updates = Object.fromEntries(Object.entries(mapped).filter(([, v]) => v !== null && v !== undefined))

  const lead = await db.lead.upsert({
    where: { zohoId },
    create: mapped,
    update: updates,
  })

  const filters = parseFilters(nudge.filters)
  const now = new Date()

  const base = {
    ok: true as const,
    nudgeKey: nudge.key,
    channel: nudge.channel,
    zohoId,
    lead: lead.fullName || lead.email || zohoId,
  }

  // Every eligibility rule, in the SAME ORDER the scheduled run applies them.
  //
  // Order changes the ANSWER, not just the style: buildWhere() narrows on status, vertical and
  // phone in the QUERY, and only then does the KYC row predicate see the survivors. Running the
  // row predicate first here reported "expected count unknown" for a lead that was really refused
  // for its status — a misleading reason that sends whoever reads the CRM log hunting the wrong
  // field.
  const statusOk =
    !filters.includeStatuses?.length || (lead.leadStatus && filters.includeStatuses.includes(lead.leadStatus))
  if (!statusOk) {
    return NextResponse.json({
      ...base,
      action: 'skipped',
      reason: 'status_not_included',
      detail: `lead status "${lead.leadStatus ?? '—'}" is not in ${JSON.stringify(filters.includeStatuses)}`,
    })
  }
  if (filters.excludeStatuses?.length && lead.leadStatus && filters.excludeStatuses.includes(lead.leadStatus)) {
    return NextResponse.json({ ...base, action: 'skipped', reason: 'status_excluded', detail: lead.leadStatus })
  }
  if (filters.businessVertical && lead.businessVertical !== filters.businessVertical) {
    return NextResponse.json({
      ...base,
      action: 'skipped',
      reason: 'wrong_business_vertical',
      detail: `"${lead.businessVertical ?? '—'}" != "${filters.businessVertical}"`,
    })
  }
  if (filters.requirePhone !== false && !lead.mobile && !lead.phone) {
    return NextResponse.json({ ...base, action: 'skipped', reason: 'no_valid_phone' })
  }

  // Only now the row predicate: "all documents submitted".
  const { rejected } = splitByKycMatch([lead], filters)
  if (rejected.length) {
    const r = rejected[0]
    return NextResponse.json({
      ...base,
      action: 'skipped',
      reason: r.reason,
      detail: `upload ${lead.kycDocumentUploadCount ?? '—'} vs expected ${lead.kycDocumentsExpectedCount ?? '—'}`,
    })
  }

  const logs = await db.messageLog.findMany({ where: { nudgeId: nudge.id, leadId: lead.id } })
  const decision = sequenceDecision(logs, nudge.maxEmailsPerLead, nudge.followUpDays, now)
  if (decision.action === 'skip') {
    return NextResponse.json({ ...base, action: 'skipped', reason: decision.reason, detail: decision.detail ?? null })
  }

  const delivery = await deliverToLead({
    nudge,
    lead,
    messageNumber: decision.messageNumber ?? 1,
    baseUrl: getStaticBaseUrl(),
    now,
  })

  if (delivery.skipped) {
    return NextResponse.json({ ...base, action: 'skipped', reason: delivery.skipped })
  }

  await db.nudge.update({ where: { id: nudge.id }, data: { lastRunAt: new Date() } })

  if (!delivery.ok) {
    return NextResponse.json({
      ...base,
      action: 'failed',
      reason: 'delivery_failed',
      detail: delivery.error ?? 'unknown error',
      help: explainWhatsAppError(delivery.error) ?? null,
      trackingId: delivery.trackingId,
    })
  }

  return NextResponse.json({
    ...base,
    action: 'sent',
    to: delivery.toPhone ?? delivery.toEmail ?? null,
    templateName: delivery.templateName ?? null,
    trackingId: delivery.trackingId,
  })
}

/** GET documents the contract, so the URL can be checked from a browser without a payload. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  const nudge = await db.nudge.findUnique({ where: { key } })
  if (!nudge) return NextResponse.json({ ok: false, error: `No nudge with key "${key}"` }, { status: 404 })
  return NextResponse.json({
    ok: true,
    nudgeKey: nudge.key,
    name: nudge.name,
    channel: nudge.channel,
    enabled: nudge.enabled,
    template: nudge.whatsappTemplateName,
    filters: parseFilters(nudge.filters),
    // Reported so a misconfigured server is obvious from the URL alone.
    accepts: ['POST application/json', 'POST application/x-www-form-urlencoded', 'POST ?token=…'],
    auth: 'LEAD_WEBHOOK_SECRET as ?token=, x-webhook-secret header, or Authorization: Bearer',
  })
}

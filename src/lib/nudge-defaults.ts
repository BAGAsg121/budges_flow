/**
 * Single source of truth for the Zoho fetch criteria and the built-in nudges.
 *
 * IMPORTANT — the real CRM status values contain SPACES, not underscores:
 *   "Onboarding Started", "Agreement Signed", "Documents Pending",
 *   "Contacted", "Qualified", "New", "Unqualified (Junk)"
 * Verified against the live nudge_lead table (330 EPS leads).
 * A filter of "Onboarding_Started" would silently match nothing.
 *
 * The fetch criteria deliberately carries NO KYC filter and NO status filter:
 * every EPS lead created since the cut-off is pulled in, and the status/KYC
 * decisions are made locally by the nudge filters (see each nudge below).
 * The old `not_equal:Unqualified` exclusion never matched anything anyway,
 * because the real value is "Unqualified (Junk)".
 */

import { CTA_TEMPLATE_SUFFIX, baseTemplateName, ctaTrackBaseUrl, isTrackedTemplate } from './cta.ts'

/** CRM status values, exactly as Zoho stores them. */export const LEAD_STATUS = {
  ONBOARDING_STARTED: 'Onboarding Started',
  AGREEMENT_SIGNED: 'Agreement Signed',
  DOCUMENTS_PENDING: 'Documents Pending',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  NEW: 'New',
  UNQUALIFIED_JUNK: 'Unqualified (Junk)',
} as const

/** The business vertical every nudge in this app targets. */
export const EPS_BUSINESS_VERTICAL = 'EPS'

/**
 * Zoho lead cut-off. Everything created after this is fetched, so the window
 * runs from 1 Aug up to "now" automatically (no upper bound needed).
 * Change this one string to move the window.
 */
export const ZOHO_LEADS_CREATED_AFTER = '2026-08-01T00:00:00+05:30'

/** The CRM's timezone. Zoho compares the criteria's offset literally, so keep it explicit. */
export const ZOHO_TZ_OFFSET = '+05:30'

/**
 * The EPS fetch criteria for any cut-off. There is deliberately no upper bound:
 * `greater_than` the cut-off and nothing else means the window always runs up to "now".
 */
export function zohoCriteriaSince(createdAfter: string): string {
  return `((Business_vertical:equals:${EPS_BUSINESS_VERTICAL})and(Created_Time:greater_than:${createdAfter}))`
}

/**
 * A closed date window — `greater_than from` AND `less_than to`.
 *
 * Verified against the live CRM: two conditions on the SAME field are accepted, but the datetime
 * MUST carry an explicit offset (`2026-09-20T14:56:36+05:30`). An ISO `…Z` suffix is rejected with
 * `INVALID_QUERY / expected_data_type: datetime / invalid value for search`.
 */
export function zohoCriteriaBetween(fromIso: string, toIso: string): string {
  return (
    `((Business_vertical:equals:EPS)` +
    `and(Created_Time:greater_than:${fromIso})` +
    `and(Created_Time:less_than:${toIso}))`
  )
}

/** A Date as Zoho wants it: `2026-09-20T14:56:36+05:30`. */
export function zohoIstIso(d: Date): string {
  const shifted = new Date(d.getTime() + (5 * 60 + 30) * 60 * 1000)
  return `${shifted.toISOString().slice(0, 19)}${ZOHO_TZ_OFFSET}`
}

/**
 * How far back to reach before the last sync time, in minutes.
 *
 * A sync is not instantaneous: it queries the CRM, then stamps `lastSyncedAt` on each lead as it
 * upserts. A lead created *after* the query but *before* the final stamp would fall outside a
 * strict `greater_than lastSync` window and be missed forever. Overlapping by a few minutes closes
 * that gap, and re-fetching a lead is harmless because the upsert is idempotent.
 */
export function zohoSyncOverlapMinutes(): number {
  const raw = Number(process.env.ZOHO_SYNC_OVERLAP_MINUTES || 10)
  return Number.isFinite(raw) && raw >= 0 ? raw : 10
}

/**
 * "Today so far" — 01:00 in the CRM's timezone on the current day, up to whenever the
 * sync runs. Built at call time rather than as a constant so it does not go stale at
 * midnight, and computed from the timezone-of-record rather than the server's local
 * clock (Render runs in UTC, where "today" starts 5.5 hours late).
 *
 * Edge case, deliberate: between 00:00 and 01:00 IST, today's 01:00 is still in the
 * future, so this window matches nothing. That is the literal reading of "leads created
 * after 1am today" and it is self-correcting — the window is never wrong, just empty.
 */
export function zohoTodayIso(now: Date = new Date()): string {
  const offsetMinutes = 5 * 60 + 30 // +05:30
  const shifted = new Date(now.getTime() + offsetMinutes * 60 * 1000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}T01:00:00${ZOHO_TZ_OFFSET}`
}

/** Same filter as ZOHO_CRITERIA, but only leads created since 01:00 today. */
export function zohoTodayCriteria(now: Date = new Date()): string {
  return zohoCriteriaSince(zohoTodayIso(now))
}

/** KYC is considered complete at 11 uploads, so pending means < 11. */
export const KYC_COMPLETE_AT = 11

/**
 * Status used by the WhatsApp test lead (scripts/create-test-lead.mjs). The sample
 * nudge targets ONLY this status, so it can never message a real lead by accident.
 */
export const WHATSAPP_TEST_STATUS = 'WhatsApp Test'

export const ZOHO_CRITERIA = zohoCriteriaSince(ZOHO_LEADS_CREATED_AFTER)

/**
 * Criteria for the "documents submitted, under review" nudge.
 *
 * Deliberately NOT `zohoCriteriaSince`: that helper always adds a Created_Time cut-off, and this
 * flow is driven by lead STATUS rather than by age — a lead that reached "Documents Pending" six
 * months ago and only now completed its uploads still needs the message. Keeping the cut-off out
 * also means the CRM webhook and the manual sync agree on exactly the same population.
 *
 * Passed to the CRM verbatim (Zoho compares the strings literally), so the spacing inside
 * `Documents Pending` matters.
 */
export function zohoDocumentsPendingCriteria(): string {
  return `((Business_vertical:equals:${EPS_BUSINESS_VERTICAL})and(Lead_Status:equals:${LEAD_STATUS.DOCUMENTS_PENDING}))`
}

/** Payment link used by the two onboarding nudges. */
export const PAY_ACTIVATION_FEE_URL = 'https://eps.eko.in/console/pay-activation-fee'

/** Console link used by every MySQL-driven flow. The button variable is the mobile. */
export const CONSOLE_URL = 'https://eps.eko.in/console'

/**
 * Default Meta template language for this account. Meta treats "en" and "en_US" as
 * different locales, and a mismatch fails with 132001.
 */
export const WHATSAPP_TEMPLATE_LANGUAGE_DEFAULT =
  (process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US').trim() || 'en_US'

/**
 * Look-back window per MySQL flow, mirroring the n8n cadences where they existed.
 * A/B/C are event-driven, so a short window matches the original trigger interval.
 * D/E/F previously took their candidate list from a Google Sheet; with direct database
 * access the cohort is "recent CSP applications", so the window is expressed in days.
 * Widen any of these — a wider window plus per-phone de-duplication simply means better
 * coverage, not repeat messages.
 */
export const MYSQL_FLOW_LOOKBACK: Record<string, { lookbackHours?: number; lookbackDays?: number }> = {
  csp_details_pending: { lookbackHours: 3 },
  mobile_otp_pending: { lookbackHours: 2 },
  pan_verification_pending: { lookbackHours: 2 },
  agreement_signature_pending: { lookbackDays: 30 },
  documents_pending_upload: { lookbackDays: 30 },
  documents_reupload_required: { lookbackDays: 30 },
}

// ---------------------------------------------------------------------------
// Meta template bodies for the six MySQL-driven flows.
// These are the reference copies; the same text is submitted to Meta from the
// Templates tab (or with `npm run wa:templates -- --create-missing`).
// ---------------------------------------------------------------------------

export interface MysqlFlowTemplate {
  templateName: string
  title: string
  body: string
  buttonText: string
  /** Body variable sources for {{1}}… ; empty when the template has no variables. */
  bodyVars: string[]
}

export const MYSQL_FLOW_TEMPLATES: Record<string, MysqlFlowTemplate> = {
  csp_details_pending: {
    // NOTE: named `_reminder` rather than `csp_details_pending` because Meta holds a
    // deleted template's name for a long time (error 2388023), and the original name was
    // consumed while probing the edit endpoint. The flow key is unchanged.
    templateName: 'csp_details_pending_reminder',
    title: 'Application Details Pending',
    body:
      'Hi 👋 Your Eko partner application is almost complete. We just need a few more details from you:\n' +
      '• Current address and pincode\n' +
      '• Shop address\n' +
      '• An alternate mobile number\n\n' +
      'Please finish this step so your onboarding is not delayed. Tap the button below to continue.',
    buttonText: 'Complete Now',
    bodyVars: [],
  },
  mobile_otp_pending: {
    templateName: 'mobile_otp_pending',
    title: 'Mobile Verification Pending',
    body:
      'Hi 👋 Your mobile number verification for the Eko partner registration is still pending.\n\n' +
      'Please verify the OTP to continue your onboarding. It only takes a moment.',
    buttonText: 'Verify Now',
    bodyVars: [],
  },
  pan_verification_pending: {
    templateName: 'pan_verification_pending',
    title: 'PAN Verification Pending',
    body:
      'Hi 👋 Your Eko partner application is incomplete — we are still missing your PAN details.\n\n' +
      'Once you submit and verify your PAN, we can move your onboarding forward.',
    buttonText: 'Submit PAN',
    bodyVars: [],
  },
  agreement_signature_pending: {
    templateName: 'agreement_signature_pending',
    title: 'Agreement Signature Pending',
    body:
      'Hi 👋 Your Eko partner agreement is ready for e-signature but has not been signed yet.\n\n' +
      'Please sign it at the earliest so we can activate your account and you can start using our services.',
    buttonText: 'Sign Agreement',
    bodyVars: [],
  },
  documents_pending_upload: {
    templateName: 'documents_pending_upload',
    title: 'Documents Pending',
    body:
      'Hi 👋 A few mandatory documents for your Eko partner account are still pending:\n\n' +
      '{{1}}\n\n' +
      'Please upload them soon to avoid any delay in activation.',
    buttonText: 'Upload Now',
    bodyVars: ['pending_documents'],
  },
  documents_reupload_required: {
    templateName: 'documents_reupload_required',
    title: 'Documents Reupload Required',
    body:
      'Hi 👋 A few documents in your Eko partner application were not approved and need to be re-uploaded:\n\n' +
      '{{1}}\n\n' +
      'Please resubmit them so we can continue your onboarding.',
    buttonText: 'Reupload Now',
    bodyVars: ['reupload_documents'],
  },
}

/**
 * UTILITY-category copy for the two pay nudges.
 *
 * Meta decides a template's category from its CONTENT, and discount/promo wording makes it
 * MARKETING — which is what triggers the per-user frequency cap. In production that dropped
 * 36 + 9 sends with 131049 ("healthy ecosystem engagement") and 3 more with 130472
 * ("part of an experiment"). UTILITY templates are not capped.
 *
 * So the WhatsApp copy carries no promotion at all — only "your activation fee is pending"
 * and a Pay Now button — while the DISCOUNT LINE STAYS in the email twin (WA_EMAIL_TWIN),
 * where no such cap exists. That is the whole trade: uncapped WhatsApp delivery in exchange
 * for moving the offer to email.
 *
 * These are new template names rather than edits to the approved originals, because an
 * approved template's category cannot be changed by editing it — the edit only re-triggers
 * review and Meta re-derives the category from the same promo-free text anyway. New names
 * also leave the old approved templates intact for the send history that references them.
 * The retired names are recorded in WA_RETIRED_MARKETING_TEMPLATES.
 */
export const WA_UTILITY_SAFE_COPY: Record<string, { body: string; buttonText: string }> = {
  activation_fee_pending_transacting: {
    body:
      'Hi 👋 Your Eko account activation fee payment is still pending.\n\n' +
      'Please complete the one-time payment to keep your account fully active.',
    buttonText: 'Pay Now',
  },
  activation_fee_pending_not_transacting: {
    body:
      'Hi 👋 Your Eko account has been activated and your production credentials were shared on your ' +
      'registered email ID.\n\n' +
      'Please complete your integration, and clear the pending one-time activation fee to keep the ' +
      'account fully active.',
    buttonText: 'Pay Now',
  },
}

/** The original MARKETING-categorised templates. Kept for reference; no longer used. */
export const WA_RETIRED_MARKETING_TEMPLATES: Record<string, string> = {
  whatsapp_onboarded_transacting: 'onboarded_transacting_pay',
  whatsapp_onboarded_not_transacting: 'onboarded_not_transacting_pay',
}

/**
 * The name of the ANALYTICS-ONLY variant of a template: `x` -> `x_cta`.
 *
 * Every UTILITY template with a URL button gets one. It is identical to the original except that
 * the button points at `/api/track/cta/{{1}}` instead of straight at the destination, which is the
 * only way to learn WHICH recipient tapped it — Meta reports clicks per template per day, never
 * per person (see meta-template-analytics.ts).
 *
 * The `_cta` suffix is what makes a tracked template identifiable at a glance in the Templates tab,
 * in a nudge row, and in a log row.
 */
export function trackedTemplateName(baseName: string): string {
  return isTrackedTemplate(baseName) ? baseName : `${baseName}${CTA_TEMPLATE_SUFFIX}`
}

/** True when a template has a URL button, i.e. there is something to track. */
export function templateHasButton(templateName: string | null | undefined): boolean {
  return whatsappButtonUrlFor(templateName) !== null
}

/**
 * The URL a template's button points at, with its `{{1}}` placeholder intact.
 *
 * Single source of truth for "where does this nudge's button go", used both when building the
 * template and when working out the click destination for a tracked send (src/lib/cta.ts).
 * A tracked (`…_cta`) template resolves to its BASE template's destination — the tracker forwards
 * there after recording the click.
 *
 * Returns null for a template with no button, or one this code does not know.
 */
export function whatsappButtonUrlFor(templateName: string | null | undefined): string | null {
  const name = baseTemplateName((templateName || '').trim())
  if (!name) return null
  const mysqlFlow = Object.values(MYSQL_FLOW_TEMPLATES).find((t) => t.templateName === name)
  if (mysqlFlow) return `${CONSOLE_URL}?mobile={{1}}`
  const sheetFlow = Object.values(WA_SHEET_FLOW_TEMPLATES).find((t) => t.templateName === name)
  if (sheetFlow) return sheetFlow.buttonUrl ?? null
  const zohoFlow = Object.values(ZOHO_FLOW_TEMPLATES).find((t) => t.templateName === name)
  if (zohoFlow) return zohoFlow.buttonUrl ?? null
  return null
}

/**
 * The URL actually written into a NEW template's button.
 *
 * A tracked template cannot point at the destination directly — that is the whole problem — so it
 * points at our tracker with the message token appended. Meta requires the URL to end in a single
 * `{{1}}`, which this does.
 */
export function templateButtonUrlFor(templateName: string): string | null {
  const destination = whatsappButtonUrlFor(templateName)
  if (!destination) return null
  if (!isTrackedTemplate(templateName)) return destination
  const tracker = ctaTrackBaseUrl()
  // No tracker configured: fall back to the direct link rather than creating a template whose
  // button goes nowhere.
  return tracker ? `${tracker}/{{1}}` : destination
}

/**
 * The destination a tracked button should reach for one recipient.
 *
 * Takes the BASE template's button URL and substitutes the normalised mobile, so the stored
 * destination is exactly what the customer would have got from the untracked link.
 */
export function ctaDestinationFor(templateName: string | null | undefined, mobileDigits: string): string | null {
  const url = whatsappButtonUrlFor(templateName)
  if (!url) return null
  return url.replace('{{1}}', encodeURIComponent(mobileDigits))
}

/** One manual, sheet-driven WhatsApp nudge's approved copy. */
export interface WaSheetFlowTemplate {
  templateName: string
  title: string
  body: string
  /** Omit BOTH to create a template with no button — e.g. a notice whose CTA is "email us". */
  buttonText?: string
  buttonUrl?: string
}

/** The manual, sheet-driven WhatsApp nudges. */
export const WA_SHEET_FLOW_TEMPLATES: Record<string, WaSheetFlowTemplate> = {
  whatsapp_onboarded_transacting: {
    templateName: 'activation_fee_pending_transacting',
    title: 'Onboarded and started transacting (WhatsApp)',
    body: WA_UTILITY_SAFE_COPY.activation_fee_pending_transacting.body,
    buttonText: WA_UTILITY_SAFE_COPY.activation_fee_pending_transacting.buttonText,
    buttonUrl: `${PAY_ACTIVATION_FEE_URL}?mobile={{1}}`,
  },
  whatsapp_onboarded_not_transacting: {
    templateName: 'activation_fee_pending_not_transacting',
    title: 'Onboarded but not transacting (WhatsApp)',
    body: WA_UTILITY_SAFE_COPY.activation_fee_pending_not_transacting.body,
    buttonText: WA_UTILITY_SAFE_COPY.activation_fee_pending_not_transacting.buttonText,
    buttonUrl: `${PAY_ACTIVATION_FEE_URL}?mobile={{1}}`,
  },
  /**
   * Security notice: IP whitelisting is now mandatory for EPS API transactions.
   *
   * Deliberately has NO button. The call to action is "email your static IP", not a link, and
   * the sheet-flow default would otherwise attach the pay-activation-fee button — pointing
   * partners at a payment page when the message is asking them for an IP address.
   *
   * Submitted as UTILITY: it is a service/security notice about the recipient's own account,
   * with no promotion in it, which is what keeps it out of Meta's per-user marketing cap.
   */
  whatsapp_ip_whitelisting: {
    templateName: 'ip_whitelisting_mandatory',
    title: 'IP whitelisting mandatory (WhatsApp)',
    body:
      '🔔 Security Update: IP Whitelisting Mandatory for EPS API Transactions\n\n' +
      'Dear Partner,\n\n' +
      'As part of a recent security enhancement, IP whitelisting is now mandatory for initiating ' +
      'transactions through the Eko Platform Services (EPS) API platform.\n\n' +
      'Whitelisting your static IP ensures that transaction requests are accepted only from your ' +
      'authorized systems, helping protect your account against unauthorized access and misuse.\n\n' +
      '📌 Action Required:\n' +
      'Please email your static IP address to eps.support@eko.in along with your Eko Code so that ' +
      'we can whitelist the IP against the correct account.',
  },
}

/**
 * Email twin for each manual WhatsApp nudge.
 *
 * Meta's per-user MARKETING frequency cap means a WhatsApp send can simply be dropped
 * (error 131049) even though the template is approved and the number is valid. When that
 * happens the sheet-run flow sends the email twin to the same person instead, provided the
 * sheet has an email column. A configuration error is never masked by this fallback.
 */
export const WA_EMAIL_TWIN: Record<string, string> = {
  whatsapp_onboarded_transacting: 'onboarded_transacting',
  whatsapp_onboarded_not_transacting: 'onboarded_not_transacting',
}

/**
 * Templates for CRM-driven WhatsApp nudges that are neither a MySQL flow nor a sheet flow.
 *
 * These carry a URL button pointing at the console, exactly like the six MySQL flows, which is why
 * they are registered here as well as in the seed: `whatsappButtonUrlFor()` has to recognise the
 * name so the tracked `…_cta` twin resolves back to the console destination rather than falling
 * through to "unknown template" and losing the link.
 */
export const ZOHO_FLOW_TEMPLATES: Record<string, WaSheetFlowTemplate> = {
  /**
   * "All your documents are in, we are reviewing them."
   *
   * UTILITY, not MARKETING: it is a status notification about the recipient's own application with
   * nothing promotional in it. That matters — a MARKETING template is subject to Meta's per-user
   * frequency cap, which silently drops sends with 131049 (the same trap the activation-fee nudges
   * had to be moved out of).
   *
   * No body variables: the message is the same for everyone, and a template with no `{{n}}` cannot
   * be broken by a missing lead field. The only parameter is the button's, which is the mobile.
   */
  documents_submitted_review: {
    templateName: 'documents_submitted_review',
    title: 'Documents submitted — under review (WhatsApp)',
    body:
      'Hi 👋 We have received all the documents submitted from your end for your Eko partner account.\n\n' +
      'Our team is reviewing them accordingly. You can check your current status on the console at any time.',
    buttonText: 'Check Status',
    buttonUrl: `${CONSOLE_URL}?mobile={{1}}`,
  },
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

const AGREEMENT_PENDING_BODY = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
  <p>Hi {{first_name}},</p>
  <p>Thank you for getting started with Eko.</p>
  <p>Your next step is to <b>complete the agreement signing</b>, so we can move your onboarding forward and you can start enjoying the benefits of our product as soon as possible.</p>
  <p>Please sign the agreement from your onboarding console. It only takes a few minutes.</p>
  <p>If you need any help, just reply to this email and our team will assist you.</p>
  <p>Thanks,<br/>Eko Onboarding Team</p>
</div>`

const DOCUMENTS_PENDING_BODY = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
  <p>Hi {{first_name}},</p>
  <p>We noticed your KYC document upload is still pending for <b>{{company}}</b> — your account currently shows <b>{{kyc_document_upload_count}}</b> document(s) uploaded.</p>
  <p>To keep your onboarding moving, please log in and complete your document upload. It only takes a few minutes:</p>
  <p style="text-align:center;margin:28px 0;">
    <a href="https://app.eko.co/in/onboard" style="background:#0d9488;color:#ffffff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Upload Documents</a>
  </p>
  <p>If you have already completed this, please ignore this email.</p>
  <p>Thanks,<br/>Eko Onboarding Team</p>
</div>`

/** Shared CTA block for the two post-onboarding nudges.
 *  Uses {{mobile_digits}} — the sheet parser produces raw cell text, so a value like
 *  "+91 98765 43210" would break the href. mobile_digits is the normalised 10-digit form. */
const PAY_CTA = `<p style="text-align:center;margin:28px 0;">
    <a href="${PAY_ACTIVATION_FEE_URL}?mobile={{mobile_digits}}" style="background:#0d9488;color:#ffffff;padding:12px 30px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">REVIEW and PAY</a>
  </p>`

const DISCOUNT_LINE =
  '🎉 Special discounts expiring soon! Pay your one-time fee today to avail the discount before it expires.'

const ONBOARDED_TRANSACTING_BODY = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
  <p>Hi {{first_name}},</p>
  <p>${DISCOUNT_LINE}</p>
  ${PAY_CTA}
  <p>Thanks,<br/>Eko Team</p>
</div>`

const ONBOARDED_NOT_TRANSACTING_BODY = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
  <p>Hi {{first_name}},</p>
  <p>We are excited to announce that your account has been successfully activated with us.</p>
  <p>The production credentials have been shared on your registered email ID. Please complete your integration and start processing transactions.</p>
  <p>If you need any assistance during the integration process, please feel free to reach out to our support team.</p>
  <p>Thank you for partnering with Eko.</p>
  <p>${DISCOUNT_LINE}</p>
  ${PAY_CTA}
</div>`

// ---------------------------------------------------------------------------
// Built-in nudges
//
// `zohoCriteria: null` means "manual / sheet-driven": the nudge is NOT run against
// synced leads. It is driven by pasting a Google Sheet URL in the UI, and the UI
// hides its Run/Preview buttons for exactly that reason.
// ---------------------------------------------------------------------------

export interface NudgeSeed {
  key: string
  name: string
  description: string
  enabled: boolean
  channel: 'email' | 'whatsapp'
  zohoCriteria: string | null
  filters: string
  subjectTemplate?: string | null
  bodyTemplate?: string | null
  whatsappTemplateName?: string | null
  whatsappLanguage?: string | null
  whatsappParams?: string | null
  maxEmailsPerLead: number
  followUpDays: number
}

const json = (o: unknown) => JSON.stringify(o, null, 2)

export const DEFAULT_NUDGES: NudgeSeed[] = [
  {
    key: 'onboarding_started_agreement',
    name: 'Agreement Pending (Onboarding Started)',
    description:
      'Emails leads whose status is "Onboarding Started" asking them to complete the agreement signing so onboarding can move forward.',
    enabled: true,
    channel: 'email',
    zohoCriteria: ZOHO_CRITERIA,
    filters: json({ requireEmail: true, includeStatuses: [LEAD_STATUS.ONBOARDING_STARTED] }),
    subjectTemplate: 'Action needed: complete your agreement signing',
    bodyTemplate: AGREEMENT_PENDING_BODY,
    maxEmailsPerLead: 3,
    followUpDays: 2,
  },
  {
    key: 'documents_pending',
    name: 'Documents Pending (Agreement Signed)',
    description:
      'Once the agreement is signed, emails leads whose KYC_Document_Upload_Count is still below 11 to complete their document upload.',
    enabled: true,
    channel: 'email',
    zohoCriteria: ZOHO_CRITERIA,
    filters: json({
      requireEmail: true,
      includeStatuses: [LEAD_STATUS.AGREEMENT_SIGNED],
      maxKycCount: KYC_COMPLETE_AT - 1,
    }),
    subjectTemplate: 'Action pending: complete your KYC documents',
    bodyTemplate: DOCUMENTS_PENDING_BODY,
    maxEmailsPerLead: 3,
    followUpDays: 2,
  },
  {
    key: 'onboarded_transacting',
    name: 'Onboarded and started transacting',
    description:
      'MANUAL — paste a Google Sheet URL in the UI. Emails onboarded + transacting leads the expiring-discount activation-fee reminder. The sheet must have an `email` column; `mobile` is used to build the payment link.',
    enabled: true,
    channel: 'email',
    zohoCriteria: null,
    filters: json({ requireEmail: true }),
    subjectTemplate: '🎉 Special discounts expiring soon — pay your activation fee today',
    bodyTemplate: ONBOARDED_TRANSACTING_BODY,
    // NOT a cap. Sheet nudges are sent by the sheet-run route, which never reads these — it
    // applies "one message per recipient, ever" instead. They are set to the honest equivalent
    // of that rule and are not offered in the UI (see nudge-kind.ts: capAppliesTo).
    // NOTE: 0 would mean "never send" in decideSend, so it must not be used here.
    maxEmailsPerLead: 1,
    followUpDays: 0,
  },
  {
    key: 'onboarded_not_transacting',
    name: 'Onboarded but not transacting',
    description:
      'MANUAL — paste a Google Sheet URL in the UI. Emails onboarded-but-not-transacting leads: account activated + integration next steps, followed by the expiring-discount reminder. The sheet must have an `email` column; `mobile` is used to build the payment link.',
    enabled: true,
    channel: 'email',
    zohoCriteria: null,
    filters: json({ requireEmail: true }),
    subjectTemplate: 'Your Eko account is activated — complete your integration',
    bodyTemplate: ONBOARDED_NOT_TRANSACTING_BODY,
    // See the note on onboarded_transacting: inert for a sheet nudge.
    maxEmailsPerLead: 1,
    followUpDays: 0,
  },
  {
    key: 'whatsapp_sample',
    name: 'WhatsApp test message (sample)',
    description:
      'SAMPLE / integration check, wired to the approved "hello_world" template so it exercises the REAL Meta template path end to end (nudge → template → delivery receipt). DISABLED by default, and it only ever targets leads whose status is exactly "WhatsApp Test" — the test lead from scripts/create-test-lead.mjs — so it cannot reach a real lead. Enable it and click Run. Clear the template name to switch it to free-form text instead, which Meta only allows inside the 24h customer-service window. Attach a different approved template from the Templates tab.',
    enabled: false,
    channel: 'whatsapp',
    zohoCriteria: ZOHO_CRITERIA,
    // Only the test lead. Never widen this without checking who it would reach.
    filters: json({ requirePhone: true, includeStatuses: [WHATSAPP_TEST_STATUS] }),
    // Reference copy of the free-form body (used only if the template name is cleared).
    bodyTemplate:
      'Hi {{first_name}}, this is a test message from the Eko Nudge Engine. If you received this, the WhatsApp integration is working. Reply to this message to confirm.',
    // The one template currently APPROVED on this WABA. hello_world takes no variables.
    whatsappTemplateName: 'hello_world',
    whatsappLanguage: 'en_US',
    whatsappParams: json([]),
    maxEmailsPerLead: 1,
    followUpDays: 0,
  },
  {
    key: 'documents_pending_wa',
    name: 'Documents Pending (WhatsApp)',
    description:
      'WhatsApp reminder while a lead still has documents outstanding. Same candidate pool as ' +
      '"Documents submitted — under review" — business vertical EPS and lead status "Documents Pending" ' +
      '— but the opposite comparison: it fires when KYC_Document_Upload_Count is LESS THAN ' +
      'KYC_Documents_Expected_Count. A lead whose expected count is unknown is refused, never ' +
      'guessed at (see src/lib/kyc-match.ts). Sends the approved Meta template ' +
      '"documents_pending_reminder" in en_US, positionally as {{1}}={{first_name}}, ' +
      '{{2}}={{company}}, {{3}}={{kyc_document_upload_count}}. ' +
      'Cadence: at most once per day per lead, up to 7 messages. Sync/Run driven — no webhook.',
    enabled: false,
    channel: 'whatsapp',
    // The same criteria as the review nudge: the pool is identical, only the count comparison
    // differs. Deliberately not `zohoCriteriaSince` — this flow is status-driven, and a Created_Time
    // cut-off would stop covering older leads that are still uploading.
    zohoCriteria: zohoDocumentsPendingCriteria(),
    filters: json({
      requirePhone: true,
      includeStatuses: [LEAD_STATUS.DOCUMENTS_PENDING],
      businessVertical: EPS_BUSINESS_VERTICAL,
      // upload < expected. The rule lives in kyc-match.ts and is applied in memory, because it
      // compares two columns of the same row (see that file for why the null guards matter).
      kycCountRule: 'less_than',
    }),
    bodyTemplate:
      'Hi {{1}}, your KYC document upload for {{2}} is still pending ({{3}} document(s) uploaded). Please complete it to keep your onboarding moving. - Eko Onboarding Team',
    whatsappTemplateName: 'documents_pending_reminder',
    // Must match the approved template exactly — "en" and "en_US" are different locales.
    whatsappLanguage: 'en_US',
    whatsappParams: json(['first_name', 'company', 'kyc_document_upload_count']),
    // "Once in a day": followUpDays 1 makes the next send eligible 24h after the last one, so a
    // daily sync sends at most one a day. maxEmailsPerLead bounds it at a week of reminders rather
    // than repeating forever for a lead who never uploads.
    maxEmailsPerLead: 7,
    followUpDays: 1,
  },

  // -------------------------------------------------------------------------
  // MySQL-driven WhatsApp flows, ported from the n8n workflow.
  // `filters.source = "mysql"` is what routes them at the business database; there
  // is no extra database column, so the DB schema is untouched.
  // -------------------------------------------------------------------------
  ...Object.entries(MYSQL_FLOW_TEMPLATES).map(([flow, t]): NudgeSeed => {
    const window = MYSQL_FLOW_LOOKBACK[flow] ?? {}
    const windowText = window.lookbackHours
      ? `last ${window.lookbackHours}h`
      : `last ${window.lookbackDays} days`
    return {
      key: flow,
      name: `WhatsApp · ${t.title}`,
      description:
        `MySQL-driven WhatsApp nudge, delivered through the Meta Cloud API. ` +
        `Reads the Simplibank database READ-ONLY for flow "${flow}" (${windowText}) and sends the approved ` +
        `Meta template "${t.templateName}" in ${WHATSAPP_TEMPLATE_LANGUAGE_DEFAULT}. ` +
        `The button opens ${CONSOLE_URL}?mobile=<recipient mobile>. ` +
        `Ships disabled — create and approve the template in the Templates tab, then enable it. ` +
        `Recipients are de-duplicated by phone number, so nobody is messaged twice.`,
      enabled: false,
      channel: 'whatsapp',
      // null -> not lead-driven; filters.source routes it to MySQL instead
      zohoCriteria: null,
      filters: json({ source: 'mysql', flow, ...window }),
      // reference copy of the Meta template body
      bodyTemplate: t.body,
      // These six all have a console URL button, so they are pointed at the TRACKED template
      // (`…_cta`) — the only way to learn which recipient tapped the button.
      whatsappTemplateName: trackedTemplateName(t.templateName),
      whatsappLanguage: WHATSAPP_TEMPLATE_LANGUAGE_DEFAULT,
      // body list is documented here; the engine supplies the real values from the query.
      // The button variable resolves to the recipient's own mobile.
      whatsappParams: json({ body: t.bodyVars, button: ['mobile_digits'] }),
      maxEmailsPerLead: 1,
      followUpDays: 0,
    }
  }),

  // -------------------------------------------------------------------------
  // Manual, sheet-driven WhatsApp nudges (pay-activation-fee CTA).
  // -------------------------------------------------------------------------
  ...Object.entries(WA_SHEET_FLOW_TEMPLATES).map(([key, t]): NudgeSeed => ({
    key,
    // The titles already end in "(WhatsApp)", and this used to prefix "WhatsApp · " on top of
    // that — producing "WhatsApp · Onboarded but not transacting (WhatsApp)" in the UI and in
    // every export. Strip the redundant suffix.
    name: `WhatsApp · ${t.title.replace(/\s*\(WhatsApp\)\s*$/, '')}`,
    description:
      `MANUAL — paste a Google Sheet URL in the UI (Send from Sheet). WhatsApp nudge for this list. ` +
      `The sheet needs an email or mobile column; the mobile drives the button when the template has one ` +
      `(${PAY_ACTIVATION_FEE_URL}?mobile=<mobile>). ` +
      `Sends the approved Meta template "${templateHasButton(t.templateName) ? trackedTemplateName(t.templateName) : t.templateName}" in ${WHATSAPP_TEMPLATE_LANGUAGE_DEFAULT}. ` +
      `Ships disabled until that template is approved.`,
    enabled: false,
    channel: 'whatsapp',
    zohoCriteria: null,
    filters: json({ source: 'sheet', requirePhone: true, emailFallback: WA_EMAIL_TWIN[key] }),
    bodyTemplate: t.body,
    // A tracked variant exists only where there is a button to track — the IP notice has none, so
    // it keeps its plain template.
    whatsappTemplateName: templateHasButton(t.templateName) ? trackedTemplateName(t.templateName) : t.templateName,
    whatsappLanguage: WHATSAPP_TEMPLATE_LANGUAGE_DEFAULT,
    // A URL button's {{1}} is a separate parameter from the body's. Only send the button
    // parameter when the template actually declares a button, or Meta rejects the send with a
    // parameter-count mismatch.
    whatsappParams: json(t.buttonText && t.buttonUrl ? { body: [], button: ['mobile_digits'] } : { body: [] }),
    // Inert for sheet nudges — the send path applies one-message-per-recipient instead.
    maxEmailsPerLead: 1,
    followUpDays: 0,
  })),

  // -------------------------------------------------------------------------
  // CRM status nudge: every document is in, so tell the customer it is under review.
  //
  // Fires on the KYC COUNTS AGREEING (upload === expected), not on a status change: Zoho's
  // "Documents Pending" status stays put while documents trickle in, so status alone cannot tell
  // "still uploading" from "finished uploading". The counts can, and kyc-match.ts refuses to treat
  // an unknown expected count as a match — 25 of the 39 live Documents-Pending leads have no
  // expected count, and they must never receive "all your documents are in".
  // -------------------------------------------------------------------------
  ...Object.entries(ZOHO_FLOW_TEMPLATES).map(([key, t]): NudgeSeed => ({
    key,
    name: `WhatsApp · ${t.title.replace(/\s*\(WhatsApp\)\s*$/, '')}`,
    description:
      `WhatsApp status nudge for EPS leads whose KYC_Document_Upload_Count EQUALS ` +
      `KYC_Documents_Expected_Count — i.e. everything asked for has been uploaded and is now ` +
      `awaiting review. Sends the approved Meta template ` +
      `"${templateHasButton(t.templateName) ? trackedTemplateName(t.templateName) : t.templateName}" in ` +
      `${WHATSAPP_TEMPLATE_LANGUAGE_DEFAULT}; its button "${t.buttonText}" opens ` +
      `${CONSOLE_URL}?mobile=<recipient mobile>. ` +
      `Sync criteria: business vertical EPS and lead status "Documents Pending". ` +
      `Also callable per-lead from the CRM webhook (POST /api/hooks/nudge/${key}). ` +
      `One message per lead, ever. Ships disabled until the template is approved.`,
    enabled: false,
    channel: 'whatsapp',
    zohoCriteria: zohoDocumentsPendingCriteria(),
    filters: json({
      requirePhone: true,
      includeStatuses: [LEAD_STATUS.DOCUMENTS_PENDING],
      businessVertical: EPS_BUSINESS_VERTICAL,
      // The rule this nudge exists for. Applied in memory (two columns of the same row).
      kycCountRule: 'equals',
    }),
    bodyTemplate: t.body,
    whatsappTemplateName: templateHasButton(t.templateName) ? trackedTemplateName(t.templateName) : t.templateName,
    whatsappLanguage: WHATSAPP_TEMPLATE_LANGUAGE_DEFAULT,
    whatsappParams: json(t.buttonText && t.buttonUrl ? { body: [], button: ['mobile_digits'] } : { body: [] }),
    // Once per lead: it is a one-off status notification, not a reminder sequence. Re-sending it
    // would tell someone "we are reviewing your documents" again for no reason.
    maxEmailsPerLead: 1,
    followUpDays: 0,
  })),
]

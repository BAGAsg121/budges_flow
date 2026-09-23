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

/** CRM status values, exactly as Zoho stores them. */
export const LEAD_STATUS = {
  ONBOARDING_STARTED: 'Onboarding Started',
  AGREEMENT_SIGNED: 'Agreement Signed',
  DOCUMENTS_PENDING: 'Documents Pending',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  NEW: 'New',
  UNQUALIFIED_JUNK: 'Unqualified (Junk)',
} as const

/**
 * Zoho lead cut-off. Everything created after this is fetched, so the window
 * runs from 1 Aug up to "now" automatically (no upper bound needed).
 * Change this one string to move the window.
 */
export const ZOHO_LEADS_CREATED_AFTER = '2026-08-01T00:00:00+05:30'

/** KYC is considered complete at 11 uploads, so pending means < 11. */
export const KYC_COMPLETE_AT = 11

/**
 * Status used by the WhatsApp test lead (scripts/create-test-lead.mjs). The sample
 * nudge targets ONLY this status, so it can never message a real lead by accident.
 */
export const WHATSAPP_TEST_STATUS = 'WhatsApp Test'

export const ZOHO_CRITERIA =
  `((Business_vertical:equals:EPS)and(Created_Time:greater_than:${ZOHO_LEADS_CREATED_AFTER}))`

/** Payment link used by the two onboarding nudges. */
export const PAY_ACTIVATION_FEE_URL = 'https://eps.eko.in/console/pay-activation-fee'

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
      'WhatsApp twin of the documents-pending nudge, delivered via the Meta Cloud API. DISABLED until you create and approve the template. To go live: open the Templates tab, create a UTILITY template named "documents_pending_reminder" in language en_US with the body below, wait for approval, then enable this nudge. Its parameters are sent positionally as {{1}}={{first_name}}, {{2}}={{company}}, {{3}}={{kyc_document_upload_count}}. Template body: "Hi {{1}}, your KYC document upload for {{2}} is still pending ({{3}} document(s) uploaded). Please complete it to keep your onboarding moving. - Eko Onboarding Team"',
    enabled: false,
    channel: 'whatsapp',
    zohoCriteria: ZOHO_CRITERIA,
    filters: json({
      requirePhone: true,
      includeStatuses: [LEAD_STATUS.AGREEMENT_SIGNED],
      maxKycCount: KYC_COMPLETE_AT - 1,
    }),
    bodyTemplate:
      'Hi {{1}}, your KYC document upload for {{2}} is still pending ({{3}} document(s) uploaded). Please complete it to keep your onboarding moving. - Eko Onboarding Team',
    whatsappTemplateName: 'documents_pending_reminder',
    // Must match the approved template exactly — "en" and "en_US" are different locales.
    whatsappLanguage: 'en_US',
    whatsappParams: json(['first_name', 'company', 'kyc_document_upload_count']),
    maxEmailsPerLead: 3,
    followUpDays: 2,
  },
]

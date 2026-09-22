/**
 * One-time seed: add the WhatsApp twin of the documents-pending nudge.
 * Idempotent — upserts by key, never overwrites existing rows (update: {}).
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const CRITERIA =
  '((Business_vertical:equals:EPS)and(Lead_Status:not_equal:Closed Won)and(Lead_Status:not_equal:Closed Lost)and(Lead_Status:not_equal:Unqualified)and(Created_Time:greater_than:2026-07-01T01:00:00+05:30)and(KYC_Document_Upload_Count:less_equal:11))'

const WA_NUDGE = {
  key: 'documents_pending_wa',
  name: 'Documents Pending Reminder (WhatsApp)',
  channel: 'whatsapp',
  enabled: false,
  description:
    'WhatsApp twin of the documents-pending nudge, delivered via Meta Cloud API. Disabled until you finish Meta setup: register the number, approve the template, set WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID in .env, and point the Meta webhook to /api/track/whatsapp.',
  zohoCriteria: CRITERIA,
  filters: JSON.stringify(
    { requirePhone: true, excludeStatuses: ['Closed Won', 'Closed Lost', 'Unqualified'], maxKycCount: 11 },
    null,
    2
  ),
  bodyTemplate:
    'Hi {{1}}, your KYC document upload for {{2}} is still pending ({{3}} document(s) uploaded). Please complete it to keep your onboarding moving. - Eko Onboarding Team',
  whatsappTemplateName: 'documents_pending_reminder',
  whatsappLanguage: 'en',
  whatsappParams: JSON.stringify(['first_name', 'company', 'kyc_document_upload_count']),
  maxEmailsPerLead: 3,
  followUpDays: 2,
}

async function main() {
  const nudge = await db.nudge.upsert({
    where: { key: WA_NUDGE.key },
    update: {},
    create: WA_NUDGE,
  })
  console.log('whatsapp nudge ready:', nudge.key, '(enabled: ' + nudge.enabled + ')')
}

main().finally(() => db.$disconnect())

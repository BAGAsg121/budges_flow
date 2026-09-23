/**
 * Create (or refresh) the WhatsApp test lead.
 *
 *   node --env-file=.env scripts/create-test-lead.mjs [phone]
 *   # default phone: 9643520034
 *
 * Upserts by zohoId, so running it repeatedly is safe and never creates duplicates.
 * The lead gets the status WHATSAPP_TEST_STATUS ("WhatsApp Test"), which is the ONLY
 * thing the `whatsapp_sample` nudge targets — so the sample nudge can never reach a
 * real lead.
 *
 * It is marked as a test lead three ways: a `TEST-WHATSAPP-` zohoId, a "WhatsApp Test"
 * status, and obviously-fake name fields. Exclude it from real sends by keeping your
 * production nudges scoped to their real statuses (they already are).
 *
 * Delete it when done:  node --env-file=.env scripts/create-test-lead.mjs --delete
 */
import { PrismaClient } from '@prisma/client'
import { WHATSAPP_TEST_STATUS } from '../src/lib/nudge-defaults.ts'

const db = new PrismaClient()
const args = process.argv.slice(2)
const shouldDelete = args.includes('--delete')
const phone = (args.find((a) => !a.startsWith('--')) || '9643520034').replace(/\D/g, '')
const zohoId = `TEST-WHATSAPP-${phone}`

if (shouldDelete) {
  const existing = await db.lead.findUnique({ where: { zohoId }, select: { id: true } })
  if (!existing) {
    console.log(`no test lead found for ${phone}`)
  } else {
    await db.messageLog.deleteMany({ where: { leadId: existing.id } })
    await db.lead.delete({ where: { zohoId } })
    console.log(`deleted test lead ${zohoId} (and its message logs)`)
  }
  await db.$disconnect()
  process.exit(0)
}

const lead = await db.lead.upsert({
  where: { zohoId },
  create: {
    zohoId,
    fullName: 'WhatsApp Test Lead',
    firstName: 'WhatsApp',
    lastName: 'Test Lead',
    mobile: phone,
    phone,
    businessVertical: 'EPS',
    leadStatus: WHATSAPP_TEST_STATUS,
    kycDocumentUploadCount: 0,
    country: 'India',
    leadSource: 'Internal test',
  },
  update: {
    mobile: phone,
    phone,
    leadStatus: WHATSAPP_TEST_STATUS,
  },
})

console.log('test lead ready:')
console.log(`  id       ${lead.id}`)
console.log(`  zohoId   ${lead.zohoId}`)
console.log(`  name     ${lead.fullName}`)
console.log(`  mobile   ${lead.mobile}`)
console.log(`  status   ${lead.leadStatus}  (only the whatsapp_sample nudge targets this)`)
console.log(`\nnormalises to ${String(lead.mobile).replace(/\D/g, '').length === 10 ? '91' + String(lead.mobile).replace(/\D/g, '') : String(lead.mobile).replace(/\D/g, '')} for the Meta API`)

const sample = await db.nudge.findUnique({ where: { key: 'whatsapp_sample' }, select: { enabled: true, filters: true } })
if (sample) {
  const targeted = await db.lead.count({
    where: { leadStatus: WHATSAPP_TEST_STATUS, OR: [{ mobile: { not: null } }, { phone: { not: null } }] },
  })
  console.log(`\nwhatsapp_sample nudge: enabled=${sample.enabled} · targets ${targeted} lead(s)`)
}

await db.$disconnect()

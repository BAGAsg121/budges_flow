/**
 * Audit every WhatsApp nudge against the live Meta WABA.
 *
 *   node --env-file=.env scripts/check-whatsapp-flows.mjs
 *
 * For each WhatsApp nudge this checks:
 *   • whether its template name + language actually EXISTS on the WABA
 *   • whether that template is APPROVED (vs pending / rejected)
 *   • whether the template's language matches exactly (the en vs en_US trap)
 *   • whether the nudge's parameter count matches the template's variable count —
 *     a mismatch is rejected by Meta at send time
 *   • whether there is more than one template with that name, so the language is ambiguous
 *
 * Read-only: it never changes a nudge or a template.
 */
import { PrismaClient } from '@prisma/client'
import { listTemplates, countTemplateVars, isTemplateApiConfigured } from '../src/lib/whatsapp-templates.ts'

const db = new PrismaClient()

const ICON = { ok: '✅', warn: '⚠️ ', bad: '❌' }
let problems = 0

function line(icon, text) {
  console.log(`   ${icon} ${text}`)
  if (icon === ICON.bad) problems++
}

console.log('WhatsApp flow audit\n===================\n')

const waConfigured = Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
console.log('Credentials:')
console.log(`   token                 ${process.env.WHATSAPP_TOKEN ? 'set' : 'MISSING'}`)
console.log(`   phone number id       ${process.env.WHATSAPP_PHONE_NUMBER_ID || 'MISSING'}`)
console.log(`   waba id               ${process.env.WHATSAPP_WABA_ID || 'MISSING'}`)
console.log(`   app secret (webhooks) ${process.env.WHATSAPP_APP_SECRET ? 'set — signatures verified' : 'not set — unsigned webhooks accepted'}`)
console.log(`   default language      ${process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US (built-in default)'}`)
console.log(`   sendable              ${waConfigured ? 'yes' : 'NO — cannot send'}`)
if (!waConfigured) problems++

if (!isTemplateApiConfigured()) {
  console.log('\nCannot audit templates: set WHATSAPP_TOKEN and WHATSAPP_WABA_ID.')
  await db.$disconnect()
  process.exit(1)
}

const listing = await listTemplates()
if (!listing.ok) {
  console.log('\nCould not list templates:', listing.error)
  await db.$disconnect()
  process.exit(1)
}
const templates = listing.templates
console.log(`\nApproved templates on the WABA (${templates.filter((t) => t.status === 'APPROVED').length} of ${templates.length}):`)
for (const t of templates) {
  const bodyVar = countTemplateVars(t.components?.find((c) => c.type === 'BODY')?.text || '')
  console.log(`   ${t.status === 'APPROVED' ? '✅' : t.status === 'PENDING' ? '⏳' : '❌'} ${t.name} · ${t.language} · ${t.status} · ${bodyVar} variable(s)`)
}

const nudges = await db.nudge.findMany({ where: { channel: 'whatsapp' }, orderBy: { createdAt: 'asc' } })
console.log(`\nWhatsApp nudges (${nudges.length}):`)

for (const n of nudges) {
  const name = (n.whatsappTemplateName || '').trim()
  const language = (n.whatsappLanguage || '').trim()
  let params = []
  try {
    const parsed = JSON.parse(n.whatsappParams || '[]')
    if (Array.isArray(parsed)) params = parsed
  } catch {
    /* handled below */
  }

  console.log(`\n ▸ ${n.key}  (${n.enabled ? 'ENABLED' : 'disabled'})`)

  if (!name) {
    line(ICON.warn, 'No template name → sends FREE-FORM TEXT. Meta only allows that inside the 24h customer-service window.')
    continue
  }

  const sameName = templates.filter((t) => t.name === name)
  const exact = sameName.find((t) => t.language === language)

  if (!exact) {
    if (sameName.length === 0) {
      line(ICON.bad, `Template "${name}" does not exist on this WABA.`)
      line(ICON.warn, 'Create it in the Templates tab (or WhatsApp Manager) and wait for approval.')
    } else {
      const langs = sameName.map((t) => `${t.language} (${t.status})`).join(', ')
      line(ICON.bad, `Template "${name}" exists, but not in language "${language}". Available: ${langs}`)
      line(ICON.warn, `Meta matches language exactly — sending with "${language}" fails with 132001. Fix the nudge's template language.`)
    }
    continue
  }

  if (exact.status === 'APPROVED') line(ICON.ok, `Template "${name}" (${language}) is APPROVED.`)
  else if (exact.status === 'PENDING') line(ICON.warn, `Template "${name}" (${language}) is still PENDING review — sends will fail until Meta approves it.`)
  else line(ICON.bad, `Template "${name}" (${language}) is ${exact.status}${exact.rejected_reason ? `: ${exact.rejected_reason}` : ''}`)

  // Parameter count must match the template's variable count.
  const bodyText = exact.components?.find((c) => c.type === 'BODY')?.text || ''
  const vars = countTemplateVars(bodyText)
  if (params.length === vars) {
    line(ICON.ok, `Parameters match: ${params.length} supplied for ${vars} variable(s)${params.length ? ` → ${params.join(', ')}` : ''}`)
  } else {
    line(ICON.bad, `Parameter mismatch: nudge supplies ${params.length} but the template has ${vars} variable(s).`)
    line(ICON.warn, 'Meta rejects a template whose parameter count does not match.')
  }

  if (vars > 0 && params.some((p) => !p)) {
    line(ICON.warn, 'A parameter is blank — the positional mapping may shift. Check the nudge\'s Template parameters.')
  }
}

console.log(
  problems === 0
    ? '\n✅ All WhatsApp flows are correctly connected.\n'
    : `\n⚠️  ${problems} issue(s) above need attention before these will send.\n`
)

await db.$disconnect()
process.exit(problems === 0 ? 0 : 1)

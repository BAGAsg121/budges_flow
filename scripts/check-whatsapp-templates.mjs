/**
 * WhatsApp template management from the CLI — uses the SAME module the API route uses
 * (src/lib/whatsapp-templates.ts), so it exercises the real code path.
 *
 *   node --env-file=.env scripts/check-whatsapp-templates.mjs                     # list
 *   node --env-file=.env scripts/check-whatsapp-templates.mjs --create-test       # create + delete a self-test template
 *   node --env-file=.env scripts/check-whatsapp-templates.mjs --delete <name> [--lang <code>]
 *
 * List is read-only. --create-test submits a clearly-named template to Meta and then
 * deletes it again, proving the create/delete round trip works.
 */
import {
  listTemplates,
  createTemplate,
  deleteTemplate,
  isTemplateApiConfigured,
  validateTemplateInput,
} from '../src/lib/whatsapp-templates.ts'

const args = process.argv.slice(2)
function flagValue(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}

const doCreateTest = args.includes('--create-test')
const deleteName = flagValue('--delete')
const deleteLang = flagValue('--lang')

const SELFTEST_NAME = 'nudge_engine_selftest'

async function showList() {
  const result = await listTemplates()
  if (!result.ok) {
    console.log('❌ Could not list templates:', result.error)
    return false
  }
  console.log(`\nTemplates on the WABA (${result.templates.length}):`)
  if (!result.templates.length) {
    console.log('  none')
    return true
  }
  const pad = Math.max(...result.templates.map((t) => t.name.length), 12)
  for (const t of result.templates) {
    const flag = t.status === 'APPROVED' ? '✅' : t.status === 'PENDING' ? '⏳' : '❌'
    console.log(`  ${flag} ${t.name.padEnd(pad)}  ${String(t.language).padEnd(7)} ${String(t.status).padEnd(9)} ${t.category}`)
    if (t.rejected_reason) console.log(`      rejected: ${t.rejected_reason}`)
  }
  const approved = result.templates.filter((t) => t.status === 'APPROVED')
  console.log(`\n${approved.length} approved and ready to attach to a nudge.`)
  if (approved.length) {
    console.log(`Copy these EXACTLY into a nudge:  name + language`)
    for (const t of approved) console.log(`   ${t.name}  /  ${t.language}`)
  }
  return true
}

async function main() {
  console.log('WABA config:')
  console.log(`  WHATSAPP_WABA_ID   ${process.env.WHATSAPP_WABA_ID || '(empty)'}`)
  console.log(`  WHATSAPP_TOKEN     ${process.env.WHATSAPP_TOKEN ? 'set' : '(empty)'}`)
  console.log(`  template API       ${isTemplateApiConfigured() ? 'configured' : 'NOT configured'}`)

  if (!isTemplateApiConfigured()) {
    console.log('\nSet WHATSAPP_TOKEN and WHATSAPP_WABA_ID in .env first.')
    process.exitCode = 1
    return
  }

  if (deleteName) {
    const result = await deleteTemplate(deleteName, deleteLang)
    console.log(result.ok ? `\n✅ Deleted ${deleteName}${deleteLang ? ` (${deleteLang})` : ''}` : `\n❌ Delete failed: ${result.error}`)
    if (!result.ok) process.exitCode = 1
    await showList()
    return
  }

  await showList()

  if (!doCreateTest) return

  // ---- create + delete round trip ------------------------------------------
  console.log('\n--- create/delete self-test ---')
  const input = {
    name: SELFTEST_NAME,
    language: 'en_US',
    category: 'UTILITY',
    bodyText: 'Nudge Engine self-test {{1}}. This template exists only to verify the API round trip.',
    footerText: 'Safe to delete',
  }
  const { errors, warnings } = validateTemplateInput(input)
  if (errors.length) {
    console.log('❌ Local validation failed:', errors.join('; '))
    process.exitCode = 1
    return
  }
  if (warnings.length) console.log('warnings:', warnings.join(' '))

  // Clear any leftover from a previous run so create is deterministic
  await deleteTemplate(SELFTEST_NAME, 'en_US')

  const created = await createTemplate(input)
  if (!created.ok) {
    console.log('❌ Create failed:', created.error)
    process.exitCode = 1
    return
  }
  console.log(`✅ Created: id=${created.id} status=${created.status}`)

  const after = await listTemplates()
  const found = after.templates.find((t) => t.name === SELFTEST_NAME && t.language === 'en_US')
  console.log(found ? `✅ It now appears in the list as ${found.status}` : '❌ Not visible in the list (list may be cached)')

  const removed = await deleteTemplate(SELFTEST_NAME, 'en_US')
  console.log(removed.ok ? '✅ Deleted the self-test template again' : `⚠️  Could not delete it: ${removed.error}`)
  console.log('   (a template already in review can sometimes only be removed after Meta processes it)')

  await showList()
}

await main()

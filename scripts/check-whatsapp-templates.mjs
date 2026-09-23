/**
 * WhatsApp template management from the CLI — uses the SAME module the API route uses
 * (src/lib/whatsapp-templates.ts), so it exercises the real code path.
 *
 *   node --env-file=.env scripts/check-whatsapp-templates.mjs                     # list
 *   node --env-file=.env scripts/check-whatsapp-templates.mjs --create-test       # create + delete a self-test template
 *   node --env-file=.env scripts/check-whatsapp-templates.mjs --create-missing    # create templates the WhatsApp nudges reference but that do not exist
 *   node --env-file=.env scripts/check-whatsapp-templates.mjs --delete <name> [--lang <code>]
 *
 * List is read-only. --create-test submits a clearly-named template to Meta and then
 * deletes it again, proving the create/delete round trip works. --create-missing uses each
 * nudge's own `bodyTemplate` (the reference copy of the Meta template body) as the template
 * BODY, so the nudge and the template cannot drift apart.
 */
import { PrismaClient } from '@prisma/client'
import {
  listTemplates,
  createTemplate,
  editTemplate,
  deleteTemplate,
  isTemplateApiConfigured,
  validateTemplateInput,
  countTemplateVars,
} from '../src/lib/whatsapp-templates.ts'
import {
  MYSQL_FLOW_TEMPLATES,
  WA_SHEET_FLOW_TEMPLATES,
  CONSOLE_URL,
  PAY_ACTIVATION_FEE_URL,
} from '../src/lib/nudge-defaults.ts'

const db = new PrismaClient()

/**
 * Look up the approved-copy spec for a template name. This is what lets
 * `--create-missing` build a template with its URL BUTTON, which the nudge row alone
 * does not carry.
 */
function templateSpecFor(name) {
  const mysqlFlow = Object.values(MYSQL_FLOW_TEMPLATES).find((t) => t.templateName === name)
  if (mysqlFlow) {
    return { body: mysqlFlow.body, buttonText: mysqlFlow.buttonText, buttonUrl: `${CONSOLE_URL}?mobile={{1}}` }
  }
  const sheetFlow = Object.values(WA_SHEET_FLOW_TEMPLATES).find((t) => t.templateName === name)
  if (sheetFlow) {
    return { body: sheetFlow.body, buttonText: sheetFlow.buttonText, buttonUrl: `${PAY_ACTIVATION_FEE_URL}?mobile={{1}}` }
  }
  return null
}

const args = process.argv.slice(2)
function flagValue(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}

const doCreateTest = args.includes('--create-test')
const createMissing = args.includes('--create-missing')
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

    // Surface the parts that decide whether a send will actually work.
    const body = (t.components || []).find((c) => c.type === 'BODY')
    const vars = countTemplateVars(body?.text || '')
    const buttons = (t.components || []).find((c) => c.type === 'BUTTONS')?.buttons || []
    const header = (t.components || []).find((c) => c.type === 'HEADER')
    const buttonText = buttons.map((b) => `${b.type} "${b.text}" -> ${b.url || ''}`).join(', ')
    console.log(
      `      ${header ? 'header, ' : ''}body ${vars} var(s)${buttonText ? `  ·  button: ${buttonText}` : '  ·  no button'}`
    )
    if (t.rejected_reason && t.rejected_reason !== 'NONE') console.log(`      rejected: ${t.rejected_reason}`)
    if (args.includes('--verbose') && body?.text) {
      const preview = body.text.length > 160 ? `${body.text.slice(0, 160)}…` : body.text
      console.log(`      body: ${preview.replace(/\n/g, ' ⏎ ')}`)
    }
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
    await db.$disconnect()
    return
  }

  await showList()

  // ---- create templates the nudges reference but that do not exist ---------
  if (createMissing) {
    console.log('\n--- create templates referenced by WhatsApp nudges ---')
    const existing = new Set((await listTemplates()).templates.map((t) => `${t.name}|${t.language}`))
    const nudges = await db.nudge.findMany({ where: { channel: 'whatsapp' }, orderBy: { createdAt: 'asc' } })
    let created = 0

    for (const n of nudges) {
      const name = (n.whatsappTemplateName || '').trim()
      const language = (n.whatsappLanguage || process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US').trim()
      if (!name) {
        console.log(`  ${n.key}: free-form text mode, no template needed`)
        continue
      }
      if (existing.has(`${name}|${language}`)) {
        console.log(`  ${n.key}: template "${name}" (${language}) already exists — skipped`)
        continue
      }

      // Same names in other languages usually means a language mismatch, not a missing template
      const otherLang = (await listTemplates()).templates.filter((t) => t.name === name)
      if (otherLang.length) {
        console.log(`  ${n.key}: "${name}" exists in ${otherLang.map((t) => t.language).join(', ')} but not ${language} — NOT creating a duplicate.`)
        console.log(`      → fix the nudge's template language instead (Meta matches it exactly).`)
        continue
      }

      // Prefer the curated copy + button from nudge-defaults; fall back to the nudge's
      // own reference body for ad-hoc nudges created in the UI.
      const spec = templateSpecFor(name)
      const body = (spec?.body || n.bodyTemplate || '').trim()
      if (!body) {
        console.log(`  ${n.key}: no bodyTemplate to build a template from — skipped`)
        continue
      }
      const vars = countTemplateVars(body)
      const input = {
        name,
        language,
        category: 'UTILITY',
        bodyText: body,
        footerText: null,
        headerText: null,
        buttonText: spec?.buttonText || null,
        buttonUrl: spec?.buttonUrl || null,
      }
      const { errors, warnings } = validateTemplateInput(input)
      if (errors.length) {
        console.log(`  ${n.key}: local validation failed — ${errors.join('; ')}`)
        continue
      }
      if (warnings.length) console.log(`  ${n.key}: warnings — ${warnings.join(' ')}`)

      const result = await createTemplate(input)
      if (result.ok) {
        created++
        console.log(`  ✅ ${n.key}: created "${name}" (${language}) with ${vars} variable(s) → status ${result.status}`)
      } else {
        console.log(`  ❌ ${n.key}: create failed — ${result.error}`)
      }
    }
    console.log(
      created
        ? `\n${created} template(s) submitted. They show as PENDING until Meta approves them — check back with \`npm run wa:templates\`.`
        : '\nNothing to create.'
    )
    await showList()
    await db.$disconnect()
    return
  }

  // ---- resync existing templates back to the curated copy -------------------
  // Only edits where the content actually DIFFERS, so approved templates are untouched.
  if (args.includes('--resync')) {
    console.log('\n--- resync templates to the curated copy ---')
    const current = await listTemplates()
    let edited = 0
    for (const t of current.templates) {
      const spec = templateSpecFor(t.name)
      if (!spec) continue

      const body = (t.components || []).find((c) => c.type === 'BODY')?.text || ''
      const button = ((t.components || []).find((c) => c.type === 'BUTTONS')?.buttons || []).find((b) => b.type === 'URL')
      const bodyMatches = body.trim() === spec.body.trim()
      const buttonMatches =
        (button?.url || null) === (spec.buttonUrl || null) && (button?.text || null) === (spec.buttonText || null)

      if (bodyMatches && buttonMatches) {
        console.log(`  ${t.name}: already matches — skipped`)
        continue
      }

      const result = await editTemplate(t.id, {
        name: t.name,
        language: t.language,
        category: 'UTILITY',
        bodyText: spec.body,
        headerText: null,
        footerText: null,
        buttonText: spec.buttonText,
        buttonUrl: spec.buttonUrl,
      })
      if (result.ok) {
        edited++
        console.log(`  ✅ ${t.name}: resynced (${bodyMatches ? 'button only' : 'body'}) → ${result.status}`)
      } else {
        console.log(`  ❌ ${t.name}: ${result.error}`)
      }
    }
    console.log(edited ? `\n${edited} template(s) resynced and back in review.` : '\nNothing to resync.')
    await showList()
    await db.$disconnect()
    return
  }

  if (!doCreateTest) {
    await db.$disconnect()
    return
  }

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

/**
 * Repair the tracked (`_cta`) twins of the sandbox templates so their BODY matches the base.
 *
 *   node --env-file=.env scripts/fix-tracked-sandbox-templates.mjs          # report only
 *   node --env-file=.env scripts/fix-tracked-sandbox-templates.mjs --apply  # delete + re-create
 *
 * WHY THIS EXISTS
 *
 * Enabling click tracking needs a `_cta` twin whose only difference from the base is the button URL
 * (the tracker instead of the destination). `wa:templates --create-missing` builds the twin from
 * `SANDBOX_WHATSAPP_NUDGES[key].body` — but for the sandbox specs that field is the human-readable
 * REFERENCE copy, deliberately written without the `{{1}}`/`{{2}}` placeholders that the real,
 * approved template carries (the specs declare those separately as `bodyVars`).
 *
 * So the twins were submitted with ZERO body variables while their nudges send one. Meta accepts
 * that (a variable-less body is legal, only a warning locally), and then every send on the approved
 * twin fails with 132000 — a parameter-count mismatch. The 132001 fallback does NOT save it, because
 * the template is not missing, it is mismatched.
 *
 * THE FIX is to copy the body from the BASE TEMPLATE AS META HOLDS IT, so the pair is identical
 * except for the button. That is the definition of a tracked twin, and it cannot drift from what the
 * nudge sends, because the base is the template the nudge was originally sending on.
 *
 * Meta LOCKS a template while it is in review (2388003), so a PENDING twin cannot simply be edited —
 * it has to be deleted and re-created. This refuses to touch a twin that is APPROVED unless it is
 * actually wrong, and reports everything before changing anything.
 */
import { PrismaClient } from '@prisma/client'
import { listTemplates, createTemplate, deleteTemplate, isTemplateApiConfigured } from '../src/lib/whatsapp-templates.ts'
import { SANDBOX_WHATSAPP_NUDGES, templateButtonUrlFor, sandboxTrackedName } from '../src/lib/nudge-defaults.ts'

const apply = process.argv.includes('--apply')
const LANGUAGE = process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US'
const db = new PrismaClient()

if (!isTemplateApiConfigured()) {
  console.error('Set WHATSAPP_TOKEN and WHATSAPP_WABA_ID first.')
  process.exit(1)
}

/** Pull the BODY text and the URL button out of Meta's components payload. */
function parts(t) {
  const comps = (t?.components ?? [])
  const body = comps.find((c) => (c.type || '').toUpperCase() === 'BODY')
  const header = comps.find((c) => (c.type || '').toUpperCase() === 'HEADER')
  const footer = comps.find((c) => (c.type || '').toUpperCase() === 'FOOTER')
  const buttons = comps.find((c) => (c.type || '').toUpperCase() === 'BUTTONS')
  const urlButton = buttons?.buttons?.find((b) => (b.type || '').toUpperCase() === 'URL')
  return {
    bodyText: body?.text ?? null,
    headerText: header?.text ?? null,
    footerText: footer?.text ?? null,
    buttonText: urlButton?.text ?? null,
    buttonUrl: urlButton?.url ?? null,
  }
}

const vars = (s) => {
  let max = 0
  for (const m of String(s ?? '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]))
  return max
}

const list = await listTemplates()
if (!list.ok) {
  console.error(`Could not list templates: ${list.error}`)
  process.exit(1)
}
const byName = new Map()
for (const t of list.templates) {
  if ((t.language || '') === LANGUAGE) byName.set(t.name, t)
}

console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — sandbox tracked twins (${LANGUAGE})\n`)

// Only nudges that are actually tracked AND actually present in the database. A spec whose nudge was
// never seeded has nothing to repair.
const seeded = new Set((await db.nudge.findMany({ where: { channel: 'whatsapp' }, select: { key: true } })).map((n) => n.key))

let wrong = 0
const plan = []

for (const spec of Object.values(SANDBOX_WHATSAPP_NUDGES)) {
  if (spec.trackClicks === false) continue
  if (!seeded.has(spec.key)) continue

  const baseName = spec.templateName
  // `sandboxTrackedName` honours a `trackedName` alias. Computing `<base>_cta` by hand here would
  // look up the name Meta has locked and report a working twin as missing.
  const twinName = sandboxTrackedName(spec)
  const base = byName.get(baseName)
  const twin = byName.get(twinName)

  if (!base) {
    console.log(`  ⚠️  ${spec.key}: base "${baseName}" is missing on the WABA — create it first`)
    continue
  }
  if (!twin) {
    console.log(`  ⚠️  ${spec.key}: twin "${twinName}" is missing — run wa:templates --create-missing`)
    continue
  }

  const b = parts(base)
  const t = parts(twin)
  const baseVars = vars(b.bodyText)
  const twinVars = vars(t.bodyText)
  const same = (b.bodyText || '').trim() === (t.bodyText || '').trim()

  console.log(`  ${spec.key}`)
  console.log(`     base  ${baseName}  [${base.status}] ${baseVars} var(s)`)
  console.log(`     twin  ${twinName}  [${twin.status}] ${twinVars} var(s)`)

  if (same && twinVars === baseVars) {
    console.log(`     ✅ body matches the base — nothing to do\n`)
    continue
  }

  wrong++
  console.log(`     ❌ MISMATCH — the nudge sends ${spec.bodyVars.length} body param(s), the twin declares ${twinVars}`)
  console.log(`     → will delete and re-create the twin with the base's own body\n`)
  plan.push({ spec, baseName, twinName, base: b, buttonUrl: templateButtonUrlFor(twinName), buttonText: t.buttonText ?? b.buttonText })
}

console.log(`\n${wrong} twin(s) need repair.`)

if (!apply) {
  console.log('Re-run with --apply to delete and re-create them.')
  await db.$disconnect()
  process.exit(0)
}
if (!wrong) {
  await db.$disconnect()
  process.exit(0)
}

for (const item of plan) {
  console.log(`\n--- ${item.twinName} ---`)
  const del = await deleteTemplate(item.twinName, LANGUAGE)
  console.log(del.ok ? `  deleted` : `  ❌ delete failed: ${del.error}`)
  if (!del.ok) continue

  const created = await createTemplate({
    name: item.twinName,
    language: LANGUAGE,
    category: 'UTILITY',
    bodyText: item.base.bodyText,
    headerText: item.base.headerText,
    footerText: item.base.footerText,
    buttonText: item.buttonText,
    buttonUrl: item.buttonUrl,
  })
  console.log(created.ok ? `  ✅ re-created — status ${created.status}` : `  ❌ create failed: ${created.error}`)
}

await db.$disconnect()

/**
 * Point every WhatsApp nudge at the template name the code says it should use.
 *
 *   node --env-file=.env scripts/repoint-whatsapp-templates.mjs          # dry run
 *   node --env-file=.env scripts/repoint-whatsapp-templates.mjs --apply
 *
 * This is how the nudges move onto the TRACKED (`_cta`) templates, which is what makes per-person
 * click attribution possible — Meta reports clicks per template per day, never per recipient.
 *
 * Touches exactly two columns (whatsappTemplateName, whatsappLanguage) and never `enabled`, so a
 * nudge someone paused stays paused. Deliberately NOT `seed:nudges --force`, which rewrites every
 * field including templates edited in the UI.
 *
 * Note on ordering: the tracked templates must exist on Meta BEFORE the nudges point at them, or
 * sends fail with 132001 "template does not exist in the translation". Create them with
 * `npm run wa:templates -- --create-missing` after this, then wait for approval.
 */
import { db } from '../src/lib/db.ts'
import { DEFAULT_NUDGES, WA_RETIRED_MARKETING_TEMPLATES, templateButtonUrlFor } from '../src/lib/nudge-defaults.ts'
import { isTrackedTemplate } from '../src/lib/cta.ts'

const apply = process.argv.includes('--apply')

const wanted = DEFAULT_NUDGES.filter((n) => n.channel === 'whatsapp' && n.whatsappTemplateName)
const keys = wanted.map((n) => n.key)

console.log(apply ? 'MODE: apply\n' : 'MODE: dry run (pass --apply to write)\n')

const rows = await db.nudge.findMany({
  where: { key: { in: keys } },
  select: { id: true, key: true, enabled: true, whatsappTemplateName: true, whatsappLanguage: true },
})
const byKey = new Map(rows.map((r) => [r.key, r]))

let changed = 0
let tracked = 0

for (const spec of wanted) {
  const row = byKey.get(spec.key)
  const target = spec.whatsappTemplateName
  const targetLang = spec.whatsappLanguage || process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US'

  if (!row) {
    console.log(`  ?? ${spec.key.padEnd(34)} NOT IN DATABASE`)
    continue
  }

  const same = row.whatsappTemplateName === target && row.whatsappLanguage === targetLang
  const isTracked = isTrackedTemplate(target)
  if (isTracked) tracked++

  if (same) {
    console.log(`  == ${spec.key.padEnd(34)} already ${target}${isTracked ? '  [tracked]' : ''}`)
    continue
  }

  const retired = Object.values(WA_RETIRED_MARKETING_TEMPLATES).includes(row.whatsappTemplateName || '')
  console.log(
    `  -> ${spec.key.padEnd(34)} ${row.whatsappTemplateName} => ${target}${isTracked ? '  [tracked]' : ''}` +
      (retired ? '   (retiring a MARKETING template)' : '')
  )
  // Say where a tracked button will send people, so a wrong destination is obvious here rather
  // than after a customer taps it.
  const buttonUrl = isTracked ? templateButtonUrlFor(target) : null
  if (buttonUrl) console.log(`       button -> ${buttonUrl}`)
  console.log(`       enabled=${row.enabled} (left as-is)`)

  changed++
  if (apply) {
    await db.nudge.update({
      where: { id: row.id },
      data: { whatsappTemplateName: target, whatsappLanguage: targetLang },
    })
  }
}

const missing = wanted.filter((s) => !byKey.has(s.key)).map((s) => s.key)
if (missing.length) console.log(`\nNot in the database (run npm run seed:nudges first): ${missing.join(', ')}`)

console.log(`\n${tracked} nudge(s) will use a tracked (_cta) template.`)
console.log(
  apply ? `\nApplied. ${changed} row(s) updated.` : `\nDry run. ${changed} row(s) would change. Re-run with --apply.`
)

if (apply) {
  console.log('\nNext: npm run wa:templates -- --create-missing   (creates any missing tracked templates)')
}

await db.$disconnect()

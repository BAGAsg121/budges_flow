/**
 * Production-readiness check for every nudge — a DRY RUN of the real selection logic.
 *
 *   node --env-file=.env scripts/check-nudge-readiness.mjs [--only whatsapp|email]
 *
 * For each nudge it reports how it gets its recipients, whether its channel is configured, its
 * template's approval state, and — the part that matters — WHO IT WOULD MESSAGE RIGHT NOW and who
 * it would skip, with reasons. Nothing is sent: this uses the same preview/collect functions the
 * Run path uses, so it cannot promise a send the run would not make.
 *
 * Read-only apart from reading the lead cache.
 */
import { db } from '../src/lib/db.ts'
import { previewNudge } from '../src/lib/nudge-engine.ts'
import { collectMysqlRecipients, isMysqlFlowKey } from '../src/lib/mysql-nudges.ts'
import { nudgeSourceOf, capAppliesTo } from '../src/lib/nudge-kind.ts'
import { isWhatsAppConfigured } from '../src/lib/whatsapp.ts'
import { isMailerConfigured, describeMailConfig } from '../src/lib/mailer.ts'
import { listTemplates } from '../src/lib/whatsapp-templates.ts'
import { collateTemplateStatus } from './lib/template-status.mjs'

const args = process.argv.slice(2)
const onlyIdx = args.indexOf('--only')
const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? '').toLowerCase() : ''

const templates = await listTemplates()
const templateStatus = collateTemplateStatus(templates.ok ? templates.templates : [])

const nudges = await db.nudge.findMany({ orderBy: { key: 'asc' } })
const selected = nudges.filter((n) => !only || n.channel === only)

console.log('Nudge readiness (dry run — nothing is sent)')
console.log('='.repeat(78))
console.log(`WhatsApp sendable: ${isWhatsAppConfigured() ? 'yes' : 'NO'}`)
console.log(`Email configured:  ${isMailerConfigured() ? `yes (${describeMailConfig().transport})` : 'NO'}`)
console.log()

const blockers = []
const ready = []

for (const n of nudges) {
  if (!selected.includes(n)) continue

  const source = nudgeSourceOf(n)
  const filters = (() => {
    try {
      return JSON.parse(n.filters || '{}')
    } catch {
      return {}
    }
  })()

  console.log(`▸ ${n.key}  (${n.channel}, ${source}, ${n.enabled ? 'ENABLED' : 'disabled'})`)

  // Delivery-channel configuration.
  if (n.channel === 'whatsapp' && !isWhatsAppConfigured()) {
    console.log('   ❌ WhatsApp is not configured — every send would fail')
    blockers.push(n.key)
  }
  if (n.channel === 'email' && !isMailerConfigured()) {
    console.log('   ❌ No email transport configured — every send would fail')
    blockers.push(n.key)
  }

  // Template state for WhatsApp.
  if (n.channel === 'whatsapp') {
    const name = n.whatsappTemplateName
    const t = name ? templateStatus.get(`${name}|${n.whatsappLanguage}`) : null
    if (!name) {
      console.log('   ⚠️  free-form text mode (only allowed inside the 24h window)')
    } else if (!t) {
      console.log(`   ❌ template "${name}" (${n.whatsappLanguage}) is not on the WABA`)
      blockers.push(`${n.key}: template missing`)
    } else if (t.status !== 'APPROVED') {
      console.log(`   ⚠️  template "${name}" is ${t.status} — sends fall back to the untracked base until approved`)
    } else {
      const button = t.buttonText ? ` · button "${t.buttonText}"` : ' · no button'
      console.log(`   ✅ template "${name}" APPROVED${button}`)
    }
  }

  console.log(
    `   cap: ${capAppliesTo(n) ? `max ${n.maxEmailsPerLead}/lead, ${n.followUpDays}d apart` : 'not applied (sheet-driven)'}`
  )

  // Who it would actually reach, using the real selection path.
  if (source === 'zoho') {
    const preview = await previewNudge(n.id)
    console.log(`   leads considered: ${preview.leadsConsidered}`)
    console.log(`   WOULD SEND: ${preview.wouldSend.length}`)
    if (preview.wouldSend.length) {
      for (const w of preview.wouldSend.slice(0, 3)) {
        console.log(`      → ${w.lead}  ${n.channel === 'whatsapp' ? w.phone : w.email}  msg#${w.messageNumber}`)
      }
      if (preview.wouldSend.length > 3) console.log(`      … ${preview.wouldSend.length - 3} more`)
    }
    const reasons = preview.wouldSkip.reduce((acc, s) => acc.set(s.reason, (acc.get(s.reason) ?? 0) + 1), new Map())
    if (reasons.size) {
      console.log(`   would skip: ${[...reasons].map(([r, c]) => `${r}×${c}`).join(', ')}`)
    }
    if (preview.leadsConsidered === 0) {
      console.log('   ⚠️  no leads match this nudge\'s filters in the local cache — sync first')
    }
    if (preview.wouldSend.length === 0 && preview.leadsConsidered > 0) {
      console.log('   ℹ️  every matching lead is already at its cap or has replied')
    } else if (preview.wouldSend.length > 0) {
      ready.push(n.key)
    }
  } else if (source === 'mysql') {
    const flow = filters.flow
    if (!isMysqlFlowKey(flow)) {
      console.log(`   ❌ filters.flow "${flow}" is not a known collector`)
      blockers.push(`${n.key}: unknown mysql flow`)
    } else {
      const recipients = await collectMysqlRecipients(flow, {
        lookbackHours: filters.lookbackHours,
        lookbackDays: filters.lookbackDays,
      })
      console.log(`   recipients from the business DB: ${recipients.length}`)
      for (const r of recipients.slice(0, 3)) {
        console.log(`      → ${r.key}${r.detail ? `  ${String(r.detail).slice(0, 60)}` : ''}`)
      }
      if (recipients.length === 0) {
        console.log('   ⚠️  the query returns nobody right now — normal for a quiet window,')
        console.log('       but if it is always 0 the flow window or table mapping is wrong')
      } else {
        ready.push(n.key)
      }
    }
  } else {
    console.log('   manual: recipients come from a pasted Google Sheet (nothing to preview)')
    ready.push(n.key)
  }

  if (n.enabled && !blockers.includes(n.key)) {
    // Enabled + no blocker means a scheduler tick or a Run click will message people.
  }
  console.log()
}

console.log('='.repeat(78))
console.log(`Ready (would reach recipients right now): ${ready.length}${ready.length ? ` → ${ready.join(', ')}` : ''}`)
console.log(`Blocked (would fail every send): ${blockers.length}${blockers.length ? ` → ${blockers.join(', ')}` : ''}`)

const enabledRunBased = nudges.filter((n) => n.enabled && nudgeSourceOf(n) !== 'sheet')
console.log(`\nEnabled and run-based (a scheduler tick would act on these): ${enabledRunBased.map((n) => n.key).join(', ') || 'none'}`)
console.log(`Scheduler enabled: ${(process.env.SCHEDULER_ENABLED || '').toLowerCase() === 'true' ? 'YES' : 'no'}`)

await db.$disconnect()
// The Meta template list leaves keep-alive sockets open, so the event loop would otherwise sit
// idle after the report is printed.
process.exit(process.exitCode ?? 0)

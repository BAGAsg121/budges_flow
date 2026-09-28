/**
 * Meta Conversions API check.
 *
 *   node --env-file=.env scripts/check-meta-capi.mjs                 # config + payload preview
 *   node --env-file=.env scripts/check-meta-capi.mjs --send          # actually send one event
 *   node --env-file=.env scripts/check-meta-capi.mjs --send --phone 9876543210 --email a@b.c
 *
 * Prints the EXACT payload before sending, because the hashed identifiers are the part that
 * fails silently: a wrong country code or a non-lowercased email produces a perfectly valid
 * request that matches nobody.
 *
 * Uses the same module the app uses (src/lib/meta-capi.ts), so the payload shown here is the
 * payload the tracker would send.
 */
import {
  buildConversionEvent,
  capiApiVersion,
  capiCtaEventName,
  capiDatasetId,
  capiTestEventCode,
  isCtaConversionReportingEnabled,
  isMetaCapiConfigured,
  normalisePhoneForHashing,
  sendMetaConversions,
} from '../src/lib/meta-capi.ts'

const args = process.argv.slice(2)
function flag(name) {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? '') : ''
}

console.log('Meta Conversions API\n====================')
console.log(`  dataset id        ${capiDatasetId() || 'MISSING (set META_CAPI_DATASET_ID)'}`)
console.log(`  token             ${process.env.META_CAPI_TOKEN ? 'set' : 'MISSING (set META_CAPI_TOKEN)'}`)
console.log(`  api version       ${capiApiVersion()}`)
console.log(`  test event code   ${capiTestEventCode() || '(none — events will count as live)'}`)
console.log(`  configured        ${isMetaCapiConfigured() ? 'yes' : 'no'}`)
console.log(`  CTA reporting     ${isCtaConversionReportingEnabled() ? `on, as "${capiCtaEventName()}"` : 'off'}`)

const phone = flag('--phone') || '9876543210'
const email = flag('--email') || 'partner@example.com'

const digits = normalisePhoneForHashing(phone)
console.log(`\nIdentifier normalisation`)
console.log(`  phone in          ${phone}`)
console.log(`  phone hashed as   ${digits}  ${digits.length >= 11 ? '(country code present)' : '⚠️ may need a country code'}`)
console.log(`  email hashed as   ${email.trim().toLowerCase()}`)

const event = buildConversionEvent({
  eventName: capiCtaEventName(),
  phone,
  email,
  trackingId: '00000000-0000-4000-8000-000000000000',
  ctwaClid: flag('--ctwa-clid') || null,
  value: flag('--value') ? Number(flag('--value')) : null,
  eventTime: new Date(),
})

console.log('\nEvent that would be sent (identifiers are SHA-256 hashes):')
console.log(JSON.stringify({ data: [event] }, null, 2))

if (!args.includes('--send')) {
  console.log('\nDry run. Add --send to POST it to Meta.')
  process.exitCode = 0
} else if (!isMetaCapiConfigured()) {
  console.log('\n❌ Cannot send: META_CAPI_DATASET_ID and META_CAPI_TOKEN are required.')
  process.exitCode = 1
} else {
  const result = await sendMetaConversions([event])
  if (result.ok) {
    console.log(`\n✅ Meta accepted the event (events_received: ${result.received}).`)
    if (capiTestEventCode()) console.log('   It went to the Test events tab, not to live reporting.')
  } else {
    console.log(`\n❌ ${result.error}`)
    console.log('\nCommon causes:')
    console.log('  • the token has no access to that dataset')
    console.log('  • the dataset ID is a Pixel ID from a different Business Manager')
    console.log('  • business_messaging events require the WABA to be linked to that dataset')
    process.exitCode = 1
  }
}

// Node keeps the event loop alive for the keep-alive sockets; let it drain naturally rather than
// forcing exit, which trips a libuv assertion on Windows.

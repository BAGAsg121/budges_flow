/**
 * Email transport check — shows which transport is active and optionally sends a real test.
 *
 *   node --env-file=.env scripts/check-email.mjs                  # config only
 *   node --env-file=.env scripts/check-email.mjs you@example.com  # send a test email
 *   node --env-file=.env scripts/check-email.mjs you@example.com --smtp   # force SMTP
 *
 * Uses the SAME modules the app uses (src/lib/mailer.ts -> src/lib/zoho-mail.ts), so a
 * successful send here means the app's email path works.
 */
import { describeMailConfig, isMailerConfigured, selectMailTransport, sendEmail } from '../src/lib/mailer.ts'

const args = process.argv.slice(2)
const to = args.find((a) => !a.startsWith('--')) || null
if (args.includes('--smtp')) process.env.MAIL_TRANSPORT = 'smtp'
if (args.includes('--zoho')) process.env.MAIL_TRANSPORT = 'zoho'

const config = describeMailConfig()
console.log('Email configuration\n===================')
console.log(`  forced transport   ${config.forced}`)
console.log(`  selected transport ${config.transport || 'NONE — email cannot send'}`)
console.log('\n  Zoho Mail API:')
console.log(`    client id        ${config.zoho.clientIdPresent ? 'set' : 'MISSING'}`)
console.log(`    client secret    ${config.zoho.clientSecretPresent ? 'set' : 'MISSING'}`)
console.log(`    refresh token    ${config.zoho.refreshTokenPresent ? 'set' : 'MISSING'}`)
console.log(`    account id       ${config.zoho.accountId || 'MISSING'}`)
console.log(`    from address     ${config.zoho.fromAddress || 'MISSING'}`)
console.log(`    api base         ${config.zoho.apiBase}`)
console.log('\n  SMTP:')
console.log(`    host             ${config.smtp.host || 'MISSING'}`)
console.log(`    user / pass      ${config.smtp.userPresent ? 'set' : 'MISSING'} / ${config.smtp.passPresent ? 'set' : 'MISSING'}`)
console.log(`    from             ${config.smtp.from || 'MISSING'}`)

if (config.error) {
  console.log(`\n❌ ${config.error}`)
  process.exit(1)
}

if (!to) {
  console.log('\nNo recipient given, so nothing was sent.')
  console.log('Add an address to send a real test:  node --env-file=.env scripts/check-email.mjs you@example.com')
  process.exit(0)
}

console.log(`\nSending a test email to ${to} via ${selectMailTransport()}…`)
const startedAt = Date.now()
const result = await sendEmail({
  to,
  subject: 'Nudge Engine email test',
  html: '<p>This is a test message from the Nudge Engine.</p><p>If you received it, the email transport works.</p>',
  text: 'This is a test message from the Nudge Engine. If you received it, the email transport works.',
})

if (result.ok) {
  console.log(`✅ Sent via ${result.transport} in ${Date.now() - startedAt}ms — messageId ${result.messageId ?? '(none returned)'}`)
} else {
  console.log(`❌ Failed via ${result.transport ?? 'unknown'} after ${Date.now() - startedAt}ms`)
  console.log(`   ${result.error}`)
  console.log(`
Common causes:
  Zoho Mail API
    • refresh token revoked or from another DC — regenerate at api-console.zoho.in
    • ZOHO_MAIL_ACCOUNT_ID or ZOHO_MAIL_FROM_ADDRESS wrong for that account
    • from address not a verified sender on the account
    • "Invalid OAuth scope" — the token needs ZohoMail.messages.CREATE
  SMTP
    • SMTP_USER/SMTP_PASS empty (a Zoho mailbox needs an app-specific password)
    • port 465 with SMTP_SECURE=true, or port 587 with SMTP_SECURE=false`)
  process.exit(1)
}

if (!isMailerConfigured()) process.exit(1)

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
const burstIdx = args.indexOf('--burst')
const burst = burstIdx >= 0 ? Math.max(1, Math.min(Number(args[burstIdx + 1]) || 1, 100)) : 1

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
  console.log('Add --burst N to reproduce a sheet-run burst:  … you@example.com --burst 5')
  process.exitCode = 0
} else if (burst > 1) {
  // Reproduces the production failure: a sheet-run sends many mails back-to-back, and Zoho
  // throttles a burst with a bare 500 rather than a 429. With the sender's spacing + retry
  // in place this should now complete without failures.
  console.log(
    `\nSending a burst of ${burst} to ${to} via ${selectMailTransport()} ` +
      `(spacing ZOHO_MAIL_MIN_GAP_MS=${process.env.ZOHO_MAIL_MIN_GAP_MS || '1100 (default)'}, ` +
      `attempts ${process.env.ZOHO_MAIL_MAX_ATTEMPTS || '4 (default)'})…`
  )
  const started = Date.now()
  let ok = 0
  const errors = []
  for (let i = 1; i <= burst; i++) {
    const t0 = Date.now()
    const r = await sendEmail({
      to,
      subject: `Nudge Engine burst test ${i}/${burst}`,
      html: `<p>Burst test message ${i} of ${burst}.</p>`,
      text: `Burst test message ${i} of ${burst}.`,
    })
    if (r.ok) {
      ok++
      console.log(`  ${String(i).padStart(3)}/${burst}  ok    ${Date.now() - t0}ms  ${r.messageId ?? ''}`)
    } else {
      errors.push(r.error)
      console.log(`  ${String(i).padStart(3)}/${burst}  FAIL  ${Date.now() - t0}ms  ${r.error}`)
    }
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`\n${ok}/${burst} sent in ${secs}s.`)
  if (errors.length) {
    console.log(`\n${errors.length} failure(s), first: ${errors[0]}`)
    process.exitCode = 1
  }
} else {
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
    • "550 5.4.6 Unusual sending activity" — Zoho has BLOCKED this account from sending to
      external recipients. Internal (same-domain) mail still works, so a test to your own
      address looks fine while every customer send fails. Retrying makes it worse. See
      zoho.in/mail/help/usage-policy.html
  SMTP
    • SMTP_USER/SMTP_PASS empty (a Zoho mailbox needs an app-specific password)
    • port 465 with SMTP_SECURE=true, or port 587 with SMTP_SECURE=false`)
    process.exitCode = 1
  }
}

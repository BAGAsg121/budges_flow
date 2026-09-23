/**
 * In-process verification of the pure logic changed in this pass.
 * Run: node scripts/verify-changes.mjs
 * (No server, no child processes — safe under a locked-down environment.)
 */
import { renderTemplate, escapeHtml, injectTrackingPixel, htmlToText } from '../src/lib/template.ts'
import { isCronAuthorized, isWebhookAuthorized } from '../src/lib/cron-auth.ts'
import { DEFAULT_NUDGES, ZOHO_CRITERIA, LEAD_STATUS, PAY_ACTIVATION_FEE_URL } from '../src/lib/nudge-defaults.ts'

let failures = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`)
}
function checkTrue(name, cond) {
  check(name, Boolean(cond), true)
}

// --- template rendering -----------------------------------------------------
const vars = { first_name: 'Asha', company: '<script>alert(1)</script>', kyc_document_upload_count: 4 }

check('plain render substitutes values', renderTemplate('Hi {{first_name}}', vars), 'Hi Asha')
check('missing value renders empty', renderTemplate('Hi {{nope}}', vars), 'Hi ')
check('null value renders empty', renderTemplate('x{{missing}}y', { missing: null }), 'xy')
check('HTML escaping ON neutralises markup', renderTemplate('<p>{{company}}</p>', vars, { escapeValues: true }), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
check('HTML escaping OFF is raw (opt-in only)', renderTemplate('{{company}}', vars), '<script>alert(1)</script>')
check('numbers render', renderTemplate('{{kyc_document_upload_count}} docs', vars), '4 docs')
check('escapeHtml covers quotes', escapeHtml(`a"b'c&d<e>f`), 'a&quot;b&#39;c&amp;d&lt;e&gt;f')

// --- tracking pixel ---------------------------------------------------------
check(
  'pixel injected before </body>',
  injectTrackingPixel('<html><body>hi</body></html>', 'https://app.test', 'tid1'),
  '<html><body>hi<img src="https://app.test/api/track/open/tid1" width="1" height="1" alt="" style="display:none;border:0;outline:none;" /></body></html>'
)
checkTrue('pixel appended when no body tag', injectTrackingPixel('<p>hi</p>', 'https://app.test', 'tid2').startsWith('<p>hi</p><img'))
checkTrue('pixel carries the tracking id', injectTrackingPixel('x', 'https://app.test', 'ABC123').includes('/api/track/open/ABC123'))

// --- htmlToText -------------------------------------------------------------
check('htmlToText strips tags', htmlToText('<p>Hello</p><p>World</p>'), 'Hello\nWorld')

// --- cron / webhook shared-secret auth --------------------------------------
process.env.CRON_SECRET = 'cron-secret-value'
process.env.EMAIL_WEBHOOK_SECRET = 'webhook-secret-value'

const fakeReq = ({ headers = {}, query = {} } = {}) => ({
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  nextUrl: { searchParams: { get: (k) => query[k] ?? null } },
})

checkTrue('cron: x-cron-secret accepted', isCronAuthorized(fakeReq({ headers: { 'x-cron-secret': 'cron-secret-value' } })))
checkTrue('cron: Bearer accepted', isCronAuthorized(fakeReq({ headers: { authorization: 'Bearer cron-secret-value' } })))
checkTrue('cron: ?secret= accepted', isCronAuthorized(fakeReq({ query: { secret: 'cron-secret-value' } })))
check('cron: wrong secret rejected', isCronAuthorized(fakeReq({ headers: { 'x-cron-secret': 'nope' } })), false)
check('cron: missing secret rejected', isCronAuthorized(fakeReq()), false)
check('cron: prefix of the secret rejected', isCronAuthorized(fakeReq({ headers: { 'x-cron-secret': 'cron-secret-valu' } })), false)
check('webhook: correct secret accepted', isWebhookAuthorized(fakeReq({ headers: { 'x-webhook-secret': 'webhook-secret-value' } })), true)
check('webhook: cron secret does not unlock the webhook', isWebhookAuthorized(fakeReq({ headers: { 'x-webhook-secret': 'cron-secret-value' } })), false)
check('webhook: rejects when no candidates', isWebhookAuthorized(fakeReq()), false)

delete process.env.CRON_SECRET
check('cron: fails closed when CRON_SECRET is unset', isCronAuthorized(fakeReq({ headers: { 'x-cron-secret': 'anything' } })), false)

// --- nudge definitions ------------------------------------------------------
const byKey = Object.fromEntries(DEFAULT_NUDGES.map((n) => [n.key, n]))

checkTrue('fetch criteria targets EPS', ZOHO_CRITERIA.includes('Business_vertical:equals:EPS'))
checkTrue('fetch criteria starts at 2026-08-01', ZOHO_CRITERIA.includes('greater_than:2026-08-01T00:00:00+05:30'))
check('fetch criteria carries NO KYC filter', ZOHO_CRITERIA.includes('KYC_Document_Upload_Count'), false)
check('fetch criteria carries NO status filter', ZOHO_CRITERIA.includes('Lead_Status'), false)

checkTrue('onboarding_started_agreement exists (email)', byKey['onboarding_started_agreement']?.channel === 'email')
checkTrue('documents_pending exists (email)', byKey['documents_pending']?.channel === 'email')
checkTrue('onboarded_transacting exists (email)', byKey['onboarded_transacting']?.channel === 'email')
checkTrue('onboarded_not_transacting exists (email)', byKey['onboarded_not_transacting']?.channel === 'email')

const filtersOf = (k) => JSON.parse(byKey[k].filters)
check('documents_pending is scoped to Agreement Signed', filtersOf('documents_pending').includeStatuses[0], LEAD_STATUS.AGREEMENT_SIGNED)
check('documents_pending uses KYC <= 10 (i.e. < 11)', filtersOf('documents_pending').maxKycCount, 10)
check('onboarding nudge is scoped to Onboarding Started', filtersOf('onboarding_started_agreement').includeStatuses[0], LEAD_STATUS.ONBOARDING_STARTED)

// statuses must be the real CRM values (spaces, not underscores)
checkTrue('statuses use real CRM values with spaces', !JSON.stringify(DEFAULT_NUDGES).includes('Onboarding_Started'))
checkTrue('statuses use real CRM values with spaces (signed)', !JSON.stringify(DEFAULT_NUDGES).includes('Agreement_Signed'))

// the two sheet nudges must not be runnable against synced leads
check('onboarded_transacting has no zohoCriteria (manual/sheet)', byKey['onboarded_transacting'].zohoCriteria, null)
check('onboarded_not_transacting has no zohoCriteria (manual/sheet)', byKey['onboarded_not_transacting'].zohoCriteria, null)

// payment link rendering
const payBody = renderTemplate(byKey['onboarded_transacting'].bodyTemplate, { first_name: 'Asha', mobile_digits: '9876543210' }, { escapeValues: true })
checkTrue('payment CTA carries the mobile number', payBody.includes(`${PAY_ACTIVATION_FEE_URL}?mobile=9876543210`))
checkTrue('payment CTA is https', payBody.includes('href="https://eps.eko.in/console/pay-activation-fee?mobile='))
checkTrue('payment CTA link text is REVIEW and PAY', payBody.includes('REVIEW and PAY'))
checkTrue('discount copy present', payBody.includes('Special discounts expiring soon'))

const notTransacting = renderTemplate(byKey['onboarded_not_transacting'].bodyTemplate, { first_name: 'Asha', mobile_digits: '9876543210' }, { escapeValues: true })
checkTrue('not-transacting has the activation message', notTransacting.includes('successfully activated'))
checkTrue('not-transacting has production credentials line', notTransacting.includes('production credentials'))
checkTrue('not-transacting ALSO has the discount line', notTransacting.includes('Special discounts expiring soon'))
checkTrue('not-transacting has the pay CTA', notTransacting.includes('?mobile=9876543210'))

const agreement = renderTemplate(byKey['onboarding_started_agreement'].bodyTemplate, { first_name: 'Asha' }, { escapeValues: true })
checkTrue('agreement nudge asks for agreement signing', agreement.includes('agreement signing'))

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)

/**
 * In-process verification of the pure logic changed in this pass.
 * Run: node scripts/verify-changes.mjs
 * (No server, no child processes — safe under a locked-down environment.)
 */
import { renderTemplate, escapeHtml, injectTrackingPixel, htmlToText } from '../src/lib/template.ts'
import { isCronAuthorized, isWebhookAuthorized } from '../src/lib/cron-auth.ts'
import { DEFAULT_NUDGES, ZOHO_CRITERIA, LEAD_STATUS, PAY_ACTIVATION_FEE_URL, WHATSAPP_TEST_STATUS, MYSQL_FLOW_TEMPLATES, WA_SHEET_FLOW_TEMPLATES, MYSQL_FLOW_LOOKBACK, CONSOLE_URL, zohoTodayIso, zohoTodayCriteria, zohoCriteriaSince, ZOHO_LEADS_CREATED_AFTER, ZOHO_TZ_OFFSET } from '../src/lib/nudge-defaults.ts'
import { MYSQL_FLOW_KEYS, isMysqlFlowKey } from '../src/lib/mysql-nudges.ts'
import { buildWhatsAppParams as buildWhatsAppParamsRaw } from '../src/lib/whatsapp-params.ts'
import { extractInboundText, appendInbound, INBOUND_KEEP } from '../src/lib/whatsapp-inbound.ts'
import { explainWhatsAppError, isDeliveryCapError, isPermanentDeliveryFailure } from '../src/lib/whatsapp-errors.ts'
import { WA_EMAIL_TWIN, WA_UTILITY_SAFE_COPY } from '../src/lib/nudge-defaults.ts'
import { buildTemplatePayload, validateTemplateInput, countTemplateVars } from '../src/lib/whatsapp-templates.ts'

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

// --- "today so far" window (the second Sync button) --------------------------
// 2026-09-23 02:00 UTC is 07:30 IST on the 23rd, so the window must open at 01:00 IST that day.
check('today window is 01:00 on the IST day', zohoTodayIso(new Date('2026-09-23T02:00:00Z')), `2026-09-23T01:00:00${ZOHO_TZ_OFFSET}`)
// 2026-09-22 20:00 UTC is ALREADY 2026-09-23 01:30 IST — the server's UTC date is a day behind,
// which is exactly the bug a naive `toISOString().slice(0,10)` would introduce.
check('today window follows IST, not the server clock', zohoTodayIso(new Date('2026-09-22T20:00:00Z')), `2026-09-23T01:00:00${ZOHO_TZ_OFFSET}`)
// 2026-09-22 19:00 UTC is 2026-09-23 00:30 IST — the IST day has already rolled over, and
// "today 01:00" is still 30 minutes in the FUTURE, so the window is empty by design.
// (See the note on zohoTodayIso: before 01:00 IST the button finds nothing new, which is
// the literal reading of "created after 1am today" rather than a bug.)
check('today window opens at today 01:00 even just after midnight', zohoTodayIso(new Date('2026-09-22T19:00:00Z')), `2026-09-23T01:00:00${ZOHO_TZ_OFFSET}`)
checkTrue('today criteria keeps the EPS filter', zohoTodayCriteria(new Date('2026-09-23T02:00:00Z')).includes('Business_vertical:equals:EPS'))
checkTrue('today criteria has no upper bound', !zohoTodayCriteria(new Date('2026-09-23T02:00:00Z')).includes('less_than'))
check('today criteria differs from the full window', zohoTodayCriteria(new Date('2026-09-23T02:00:00Z')) === ZOHO_CRITERIA, false)
check('zohoCriteriaSince builds the same shape as the default', zohoCriteriaSince(ZOHO_LEADS_CREATED_AFTER), ZOHO_CRITERIA)

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

// --- WhatsApp sample nudge --------------------------------------------------
const wa = byKey['whatsapp_sample']
checkTrue('whatsapp_sample exists', Boolean(wa))
check('whatsapp_sample is a whatsapp nudge', wa.channel, 'whatsapp')
check('whatsapp_sample ships disabled', wa.enabled, false)
check('whatsapp_sample uses the approved hello_world template', wa.whatsappTemplateName, 'hello_world')
check('whatsapp_sample language matches the approved locale', wa.whatsappLanguage, 'en_US')
check('whatsapp_sample passes no params (hello_world has none)', JSON.parse(wa.whatsappParams || '[]').length, 0)
check('whatsapp_sample targets only the test-lead status', filtersOf('whatsapp_sample').includeStatuses[0], WHATSAPP_TEST_STATUS)
check('whatsapp_sample targets exactly one status', filtersOf('whatsapp_sample').includeStatuses.length, 1)
checkTrue('whatsapp_sample asks for a phone', filtersOf('whatsapp_sample').requirePhone === true)
check('whatsapp_sample is capped at 1 message/lead', wa.maxEmailsPerLead, 1)
checkTrue('whatsapp_sample body renders first_name', renderTemplate(wa.bodyTemplate, { first_name: 'Asha' }).includes('Hi Asha'))
check('whatsapp nudges: sample + legacy doc twin + 6 MySQL flows + 2 sheet', DEFAULT_NUDGES.filter((n) => n.channel === 'whatsapp').length, 10)
const waDocs = byKey['documents_pending_wa']
check('documents_pending_wa template language is en_US (not en)', waDocs.whatsappLanguage, 'en_US')
check('documents_pending_wa supplies 3 params for its 3 variables', JSON.parse(waDocs.whatsappParams).length, countTemplateVars(waDocs.bodyTemplate))
checkTrue('no nudge ships with the bare "en" locale', !JSON.stringify(DEFAULT_NUDGES).includes('"whatsappLanguage":"en"'))
// No live Infinito wiring: the word may appear in prose explaining its removal, but the
// API host, key and templateinfo plumbing must be gone.
checkTrue('no Infinito API host in the nudge definitions', !JSON.stringify(DEFAULT_NUDGES).includes('goinfinito'))
checkTrue('no templateinfo plumbing in the nudge definitions', !JSON.stringify(DEFAULT_NUDGES).includes('templateinfo'))

// --- WhatsApp template builder ----------------------------------------------
check('countTemplateVars counts the highest placeholder', countTemplateVars('Hi {{1}}, {{2}} and {{3}}'), 3)
check('countTemplateVars is 0 with no variables', countTemplateVars('no variables here'), 0)
check('countTemplateVars tolerates spaces', countTemplateVars('{{ 2 }}'), 2)

const goodTemplate = {
  name: 'documents_pending_reminder',
  language: 'en_US',
  category: 'UTILITY',
  headerText: 'KYC update',
  bodyText: 'Hi {{1}}, your KYC for {{2}} is pending ({{3}} uploaded).',
  footerText: 'Eko Team',
  buttonText: 'REVIEW and PAY',
  buttonUrl: 'https://eps.eko.in/console/pay-activation-fee?mobile={{1}}',
}

const goodValidation = validateTemplateInput(goodTemplate)
check('a well-formed template has no errors', goodValidation.errors.length, 0)

const payload = buildTemplatePayload(goodTemplate)
check('payload carries name/language/category', `${payload.name}|${payload.language}|${payload.category}`, 'documents_pending_reminder|en_US|UTILITY')
const types = payload.components.map((c) => c.type)
check('payload component order', types.join(','), 'HEADER,BODY,FOOTER,BUTTONS')
const bodyComp = payload.components.find((c) => c.type === 'BODY')
check('body gets an example sized to its variable count', bodyComp.example.body_text[0].length, 3)
const btnComp = payload.components.find((c) => c.type === 'BUTTONS')
check('url button carries an example when it has a variable', Array.isArray(btnComp.buttons[0].example), true)
check('url button html text preserved', btnComp.buttons[0].text, 'REVIEW and PAY')

const plain = buildTemplatePayload({ name: 'plain_note', language: 'en', category: 'UTILITY', bodyText: 'No variables at all' })
check('no example when the body has no variables', plain.components.find((c) => c.type === 'BODY').example, undefined)
check('no header/footer/buttons when not supplied', plain.components.length, 1)

check('name rejects uppercase', validateTemplateInput({ ...goodTemplate, name: 'Bad Name' }).errors.length > 0, true)
check('language warns about bare "en"', validateTemplateInput({ ...goodTemplate, language: 'en' }).warnings.length > 0, true)
check('bad category rejected', validateTemplateInput({ ...goodTemplate, category: 'PROMO' }).errors.length > 0, true)
check('non-contiguous variables rejected', validateTemplateInput({ ...goodTemplate, bodyText: 'Hi {{1}} and {{3}}' }).errors.length > 0, true)
check('button text without url rejected', validateTemplateInput({ ...goodTemplate, buttonUrl: '' }).errors.length > 0, true)
check('button url without text rejected', validateTemplateInput({ ...goodTemplate, buttonText: '' }).errors.length > 0, true)
check('http button url rejected', validateTemplateInput({ ...goodTemplate, buttonUrl: 'http://x.test/{{1}}' }).errors.length > 0, true)
check('url variable must be at the end', validateTemplateInput({ ...goodTemplate, buttonUrl: 'https://x.test/{{1}}/tail' }).errors.length > 0, true)
check('over-long body rejected', validateTemplateInput({ ...goodTemplate, bodyText: 'x'.repeat(1025) }).errors.length > 0, true)
check('over-long footer rejected', validateTemplateInput({ ...goodTemplate, footerText: 'x'.repeat(61) }).errors.length > 0, true)
check('empty body rejected', validateTemplateInput({ ...goodTemplate, bodyText: '' }).errors.length > 0, true)

// --- MySQL-driven WhatsApp flows (ported from n8n, Meta-only) ---------------
check('six MySQL flows are defined', Object.keys(MYSQL_FLOW_TEMPLATES).length, 6)
check('flow keys match the collectors', Object.keys(MYSQL_FLOW_TEMPLATES).sort().join(','), [...MYSQL_FLOW_KEYS].sort().join(','))
check('two manual WhatsApp sheet flows are defined', Object.keys(WA_SHEET_FLOW_TEMPLATES).length, 2)
checkTrue('isMysqlFlowKey accepts a real key', isMysqlFlowKey('csp_details_pending'))
check('isMysqlFlowKey rejects anything else', isMysqlFlowKey('nope'), false)

const byKeyAll = Object.fromEntries(DEFAULT_NUDGES.map((n) => [n.key, n]))
for (const flow of MYSQL_FLOW_KEYS) {
  const n = byKeyAll[flow]
  checkTrue(`nudge exists for flow ${flow}`, Boolean(n))
  check(`${flow} is a whatsapp nudge`, n?.channel, 'whatsapp')
  check(`${flow} ships disabled`, n?.enabled, false)
  check(`${flow} language is en_US`, n?.whatsappLanguage, 'en_US')
  check(`${flow} has no zohoCriteria (not lead-driven)`, n?.zohoCriteria, null)
  check(`${flow} filters mark source=mysql`, JSON.parse(n?.filters || '{}').source, 'mysql')
  check(`${flow} filters name the flow`, JSON.parse(n?.filters || '{}').flow, flow)
  checkTrue(`${flow} has a look-back window`, Boolean(MYSQL_FLOW_LOOKBACK[flow]))
  check(`${flow} template name matches the flow key`, n?.whatsappTemplateName, MYSQL_FLOW_TEMPLATES[flow].templateName)
  check(`${flow} params use the mobile for the button`, JSON.parse(n?.whatsappParams || '{}').button[0], 'mobile_digits')
}

// only E and F carry a body variable (the document list)
check('documents_pending_upload body has one variable', countTemplateVars(MYSQL_FLOW_TEMPLATES.documents_pending_upload.body), 1)
check('documents_reupload_required body has one variable', countTemplateVars(MYSQL_FLOW_TEMPLATES.documents_reupload_required.body), 1)
check('csp_details_pending body has no variables', countTemplateVars(MYSQL_FLOW_TEMPLATES.csp_details_pending.body), 0)

// button targets: console for the six flows, pay page for the two sheet nudges
check('console button URL', `${CONSOLE_URL}?mobile={{1}}`, 'https://eps.eko.in/console?mobile={{1}}')
check('pay button URL', `${PAY_ACTIVATION_FEE_URL}?mobile={{1}}`, 'https://eps.eko.in/console/pay-activation-fee?mobile={{1}}')
for (const flow of MYSQL_FLOW_KEYS) {
  checkTrue(`${flow} button text is set`, MYSQL_FLOW_TEMPLATES[flow].buttonText.length > 0)
}

const waTransacting = byKeyAll['whatsapp_onboarded_transacting']
const waNotTransacting = byKeyAll['whatsapp_onboarded_not_transacting']
check('whatsapp_onboarded_transacting is whatsapp + disabled', `${waTransacting.channel}|${waTransacting.enabled}`, 'whatsapp|false')
check('whatsapp_onboarded_not_transacting is whatsapp + disabled', `${waNotTransacting.channel}|${waNotTransacting.enabled}`, 'whatsapp|false')
check('transacting WhatsApp template name', waTransacting.whatsappTemplateName, 'onboarded_transacting_pay')
check('not-transacting WhatsApp template name', waNotTransacting.whatsappTemplateName, 'onboarded_not_transacting_pay')
checkTrue('not-transacting WhatsApp copy mentions activation', WA_SHEET_FLOW_TEMPLATES.whatsapp_onboarded_not_transacting.body.includes('successfully activated'))
checkTrue('not-transacting WhatsApp copy has the discount line', WA_SHEET_FLOW_TEMPLATES.whatsapp_onboarded_not_transacting.body.includes('Special discounts'))

// the extended param config form
check('array form yields body only', JSON.stringify(buildWhatsAppParamsRaw('["a","b"]', { a: '1', b: '2' })), JSON.stringify({ body: ['1', '2'], button: [] }))
check(
  'object form yields body + button',
  JSON.stringify(buildWhatsAppParamsRaw('{"body":["a"],"button":["mobile_digits"]}', { a: '1', mobile_digits: '9876543210' })),
  JSON.stringify({ body: ['1'], button: ['9876543210'] })
)
check('missing values fall back, preserving position', JSON.stringify(buildWhatsAppParamsRaw('["a","b"]', { b: '2' }).body), JSON.stringify(['-', '2']))

// --- inbound WhatsApp replies ----------------------------------------------
check('text reply is captured verbatim', extractInboundText({ type: 'text', text: { body: 'Yes please call me' } }), 'Yes please call me')
check('quick-reply button text', extractInboundText({ type: 'button', button: { text: 'Confirm' } }), 'Confirm')
check('interactive button reply', extractInboundText({ type: 'interactive', interactive: { button_reply: { title: 'Uploaded' } } }), '[button] Uploaded')
check('interactive list reply', extractInboundText({ type: 'interactive', interactive: { list_reply: { title: 'Need help' } } }), '[list] Need help')
check('image caption', extractInboundText({ type: 'image', image: { caption: 'Here is my PAN' } }), '[image] Here is my PAN')
check('document reply', extractInboundText({ type: 'document', document: { filename: 'pan.pdf' } }), '[document] pan.pdf')
check('audio reply still produces readable text', extractInboundText({ type: 'audio', audio: {} }), '[audio message]')
check('unknown type is labelled', extractInboundText({ type: 'weird' }), '[weird message]')
checkTrue('a reply is never empty', extractInboundText({}).length > 0)

const capped = Array.from({ length: INBOUND_KEEP + 5 }).reduce((acc, _v, i) => appendInbound(acc, { text: `m${i}` }).messages, null)
check(`inbound history is capped at ${INBOUND_KEEP}`, JSON.parse(capped).length, INBOUND_KEEP)
check('the newest message survives the cap', JSON.parse(capped).at(-1).text, `m${INBOUND_KEEP + 4}`)
check('a timestamp is recorded', Boolean(JSON.parse(appendInbound(null, { text: 'hi' }).messages)[0].at), true)
check('corrupt history is recovered', JSON.parse(appendInbound('not json', { text: 'hi' }).messages).length, 1)

// --- Meta delivery error explanations --------------------------------------
check('code 131049 is explained', explainWhatsAppError({ code: 131049 })?.label, 'engagement cap')
check('stored error string with a code is explained', explainWhatsAppError('Something happened (code 131026)')?.label, 'undeliverable')
check('text-only error is explained', explainWhatsAppError('This message was not delivered to maintain healthy ecosystem engagement.')?.label, 'engagement cap')
check('opted-out experiment is explained', explainWhatsAppError("User's number is part of an experiment")?.label, 'opted out of marketing')
check('unknown errors return null', explainWhatsAppError('something entirely new'), null)
check('null input is safe', explainWhatsAppError(null), null)

// --- delivery-cap classification and the email fallback ---------------------
check('131049 is classified as a delivery cap', isDeliveryCapError({ code: 131049 }), true)
check('a stored 131049 string is recognised', isDeliveryCapError('Meta said (code 131049)'), true)
check('cap wording without a code is recognised', isDeliveryCapError('This message was not delivered to maintain healthy ecosystem engagement.'), true)
check('marketing opt-out is treated as a cap', isDeliveryCapError("User's number is part of an experiment"), true)
check('a config error is NOT a cap', isDeliveryCapError('WhatsApp API: template does not exist (code 132001)'), false)
check('undefined is safe', isDeliveryCapError(undefined), false)

check('131026 is a permanent failure', isPermanentDeliveryFailure({ code: 131026 }), true)
check('undeliverable wording is a permanent failure', isPermanentDeliveryFailure('Message undeliverable'), true)
check('a cap is NOT a permanent failure', isPermanentDeliveryFailure({ code: 131049 }), false)
check('a config error is NOT a permanent failure', isPermanentDeliveryFailure('parameter mismatch'), false)

// every WhatsApp sheet nudge must name an email twin that actually exists
for (const [waKey, emailKey] of Object.entries(WA_EMAIL_TWIN)) {
  checkTrue(`fallback target "${emailKey}" exists as a nudge`, Boolean(byKeyAll[emailKey]))
  check(`fallback target "${emailKey}" is an email nudge`, byKeyAll[emailKey]?.channel, 'email')
  checkTrue(`fallback target "${emailKey}" has a subject`, Boolean(byKeyAll[emailKey]?.subjectTemplate))
  checkTrue(`fallback target "${emailKey}" has a body`, Boolean(byKeyAll[emailKey]?.bodyTemplate))
  check(`${waKey} declares its email fallback`, JSON.parse(byKeyAll[waKey]?.filters || '{}').emailFallback, emailKey)
}

// UTILITY-safe alternative copy exists for both capped templates
check('utility-safe copy for transacting', Boolean(WA_UTILITY_SAFE_COPY.onboarded_transacting_pay), true)
check('utility-safe copy for not-transacting', Boolean(WA_UTILITY_SAFE_COPY.onboarded_not_transacting_pay), true)
checkTrue('utility-safe copy drops the discount wording', !JSON.stringify(WA_UTILITY_SAFE_COPY).toLowerCase().includes('discount'))
checkTrue('utility-safe copy keeps a payment CTA', WA_UTILITY_SAFE_COPY.onboarded_transacting_pay.buttonText.length > 0)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)

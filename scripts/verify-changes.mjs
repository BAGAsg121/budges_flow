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
import { WA_EMAIL_TWIN, WA_UTILITY_SAFE_COPY, WA_RETIRED_MARKETING_TEMPLATES } from '../src/lib/nudge-defaults.ts'
import { buildTemplatePayload, validateTemplateInput, countTemplateVars } from '../src/lib/whatsapp-templates.ts'
import { pickLeadsTool, buildLeadsToolArgs, withPage, extractPagingInfo, extractRecords } from '../src/lib/zoho-mcp.ts'
import { explainMailError, isRetryableMailError } from '../src/lib/mail-errors.ts'
import { isRetryableWhatsAppError } from '../src/lib/whatsapp-errors.ts'
import { buildSheetVars, normaliseMobileDigits, pickSheetEmail, pickSheetMobile, planSheetSends } from '../src/lib/sheet-vars.ts'
import { buildDailySeries, seriesIsEmpty, istDayKey } from '../src/lib/engagement-stats.ts'
import { nudgeSourceOf, capAppliesTo, isManualSheetNudge } from '../src/lib/nudge-kind.ts'
import { buildXlsx, buildZip, crc32, columnLetter, sanitiseSheetName } from '../src/lib/xlsx.ts'
import { istDay, istDateTime, istRangeToUtc, istDaysAgo, toCsv, exportStatus, logToExportRow, buildBreakdown, EXPORT_COLUMNS } from '../src/lib/export-format.ts'
import { readZip, validateXlsx } from './lib/read-zip.mjs'

let failures = 0
/** --quiet prints only failures and the summary; useful when iterating in a tight loop. */
const QUIET = process.argv.includes('--quiet')
function check(name, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  if (!ok || !QUIET) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`}`)
  }
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
check('whatsapp nudges: sample + legacy doc twin + 6 MySQL flows + 3 sheet', DEFAULT_NUDGES.filter((n) => n.channel === 'whatsapp').length, 11)
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
check('three manual WhatsApp sheet flows are defined', Object.keys(WA_SHEET_FLOW_TEMPLATES).length, 3)
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
check('transacting WhatsApp template name', waTransacting.whatsappTemplateName, 'activation_fee_pending_transacting')
check('not-transacting WhatsApp template name', waNotTransacting.whatsappTemplateName, 'activation_fee_pending_not_transacting')
checkTrue(
  'not-transacting WhatsApp copy still explains the activation',
  WA_SHEET_FLOW_TEMPLATES.whatsapp_onboarded_not_transacting.body.includes('activated')
)
// Deliberately NO discount line here any more: promo wording is what made Meta categorise
// these as MARKETING and cap them. The offer moved to the email twin (asserted above).
checkTrue(
  'not-transacting WhatsApp copy no longer carries the discount line',
  !WA_SHEET_FLOW_TEMPLATES.whatsapp_onboarded_not_transacting.body.includes('Special discounts')
)

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
check('utility-safe copy for transacting', Boolean(WA_UTILITY_SAFE_COPY.activation_fee_pending_transacting), true)
check('utility-safe copy for not-transacting', Boolean(WA_UTILITY_SAFE_COPY.activation_fee_pending_not_transacting), true)
checkTrue('utility-safe copy drops the discount wording', !JSON.stringify(WA_UTILITY_SAFE_COPY).toLowerCase().includes('discount'))
checkTrue('utility-safe copy keeps a payment CTA', WA_UTILITY_SAFE_COPY.activation_fee_pending_transacting.buttonText.length > 0)
// The two WhatsApp sheet nudges must point at the UTILITY templates, not the retired MARKETING
// pair — that switch is the whole fix for Meta's per-user frequency cap.
check('transacting nudge uses the UTILITY template', WA_SHEET_FLOW_TEMPLATES.whatsapp_onboarded_transacting.templateName, 'activation_fee_pending_transacting')
check('not-transacting nudge uses the UTILITY template', WA_SHEET_FLOW_TEMPLATES.whatsapp_onboarded_not_transacting.templateName, 'activation_fee_pending_not_transacting')
checkTrue(
  'no nudge still references a retired MARKETING template',
  !Object.values(WA_SHEET_FLOW_TEMPLATES).some((t) => Object.values(WA_RETIRED_MARKETING_TEMPLATES).includes(t.templateName))
)
checkTrue(
  'the WhatsApp bodies carry no promo wording',
  !/discount|offer|expiring soon/i.test(
    Object.values(WA_SHEET_FLOW_TEMPLATES).map((t) => t.body).join(' ')
  )
)
// The offer is not lost — it moves to the email twin, which has no cap.
checkTrue(
  'the email twins still carry the discount line',
  DEFAULT_NUDGES.filter((n) => ['onboarded_transacting', 'onboarded_not_transacting'].includes(n.key)).every((n) =>
    /discount/i.test((n.bodyTemplate || '') + (n.subjectTemplate || ''))
  )
)

// --- the IP whitelisting notice ----------------------------------------------
// A sheet-driven WhatsApp nudge whose CTA is "email your static IP", NOT a link. It must not
// inherit the sheet-flow pay button, or it would point partners at a payment page while asking
// them for an IP address — and the button's {{1}} would then be a parameter the template does
// not declare, which Meta rejects with a parameter-count mismatch.
const ipNudge = DEFAULT_NUDGES.find((n) => n.key === 'whatsapp_ip_whitelisting')
const ipWa = WA_SHEET_FLOW_TEMPLATES.whatsapp_ip_whitelisting
checkTrue('the IP whitelisting nudge exists', Boolean(ipNudge))
check('IP nudge is a WhatsApp nudge', ipNudge?.channel, 'whatsapp')
check('IP nudge ships disabled', ipNudge?.enabled, false)
check('IP nudge is manual/sheet-driven', ipNudge?.zohoCriteria, null)
check('IP nudge marks its source as a sheet', JSON.parse(ipNudge?.filters || '{}').source, 'sheet')
check('IP nudge requires a phone', JSON.parse(ipNudge?.filters || '{}').requirePhone, true)
check('IP nudge has no email twin (none exists)', JSON.parse(ipNudge?.filters || '{}').emailFallback, undefined)
check('IP nudge uses the UTILITY template', ipNudge?.whatsappTemplateName, 'ip_whitelisting_mandatory')
check('IP nudge language is en_US', ipNudge?.whatsappLanguage, 'en_US')
check('IP template declares NO button', ipWa?.buttonText ?? null, null)
check('IP template declares no button URL', ipWa?.buttonUrl ?? null, null)
check('IP nudge sends no button parameter', JSON.stringify(JSON.parse(ipNudge?.whatsappParams || '{}')), JSON.stringify({ body: [] }))
check('IP nudge sends no body parameters either', JSON.parse(ipNudge?.whatsappParams || '{}').body.length, 0)
// The two pay nudges must KEEP their button — this is the regression guard for the change.
check(
  'the pay nudges keep their button parameter',
  DEFAULT_NUDGES.filter(
    (n) => n.channel === 'whatsapp' && /^whatsapp_onboarded_(not_)?transacting$/.test(n.key)
  ).every((n) => JSON.parse(n.whatsappParams || '{}').button?.[0] === 'mobile_digits'),
  true
)
checkTrue('IP body names the support address', ipWa?.body.includes('eps.support@eko.in'))
checkTrue('IP body asks for the Eko Code', /Eko Code/i.test(ipWa?.body || ''))
checkTrue('IP body carries no promotional wording', !/discount|offer|expiring/i.test(ipWa?.body || ''))
checkTrue('IP body is within Meta\'s 1024-character limit', (ipWa?.body || '').length <= 1024)
checkTrue('IP body has no unreplaced variables', !/\{\{\d+\}\}/.test(ipWa?.body || ''))
// The IP nudge is sheet-driven, so it carries no meaningful cap. (It previously asserted 3/2,
// from when a cap was set on it without checking that anything read it.)
check('IP nudge carries no applied cap', ipNudge?.maxEmailsPerLead, 1)
check('IP nudge carries no follow-up gap', ipNudge?.followUpDays, 0)
check('the IP nudge is sheet-driven, so its cap is inert', capAppliesTo(ipNudge), false)
// The four activation-fee nudges are all sheet-driven too, so none of them has an applied cap.
check(
  'no activation-fee nudge claims a multi-message cap',
  DEFAULT_NUDGES.filter((n) => /^(whatsapp_)?onboarded_(not_)?transacting$/.test(n.key))
    .filter((n) => n.maxEmailsPerLead !== 1 || n.followUpDays !== 0)
    .map((n) => n.key)
    .join(','),
  ''
)

// --- Zoho MCP tool selection and argument building ---------------------------
// The real tool list from the live server. The bug this guards against: every tool name
// contains "get"/"record", so a naive scorer picked ZohoCRM_getRecordCount — which returns
// a NUMBER, not records, so the sync reported "0 new leads" as a success.
const MCP_TOOLS = [
  { name: 'ZohoCRM_getModuleByApiName' },
  { name: 'ZohoCRM_getRecordCount', inputSchema: { properties: { path_variables: { properties: { module: {} } }, query_params: { properties: { criteria: {} } } } } },
  { name: 'ZohoCRM_getFields' },
  {
    name: 'ZohoCRM_getRecords',
    inputSchema: { properties: { path_variables: { properties: { module: {} } }, query_params: { properties: { criteria: {}, fields: {}, per_page: {}, page: {} } } } },
  },
  { name: 'ZohoCRM_getOrganization' },
  { name: 'ZohoCRM_getModules' },
  { name: 'ZohoCRM_getRecord' },
  {
    name: 'ZohoCRM_searchRecords',
    inputSchema: { properties: { path_variables: { properties: { module: {} } }, query_params: { properties: { criteria: {}, fields: {}, per_page: {}, page: {} } } } },
  },
  { name: 'ZohoCRM_getUsers' },
  { name: 'ZohoCRM_getRelatedRecords' },
  { name: 'ZohoCRM_createRecord', inputSchema: { properties: { path_variables: { properties: { module: {} } }, query_params: { properties: { criteria: {} } } } } },
  { name: 'ZohoCRM_deleteRecord', inputSchema: { properties: { path_variables: { properties: { module: {} } }, query_params: { properties: { criteria: {} } } } } },
]

check('picks the search tool, not the count tool', pickLeadsTool(MCP_TOOLS)?.name, 'ZohoCRM_searchRecords')

const searchTool = MCP_TOOLS.find((t) => t.name === 'ZohoCRM_searchRecords')
const builtArgs = buildLeadsToolArgs(searchTool, '((Business_vertical:equals:EPS))', 'id,Full_Name')
check('nested args: module goes in path_variables', builtArgs.path_variables.module, 'Leads')
check('nested args: criteria goes in query_params', builtArgs.query_params.criteria, '((Business_vertical:equals:EPS))')
check('nested args: fields are passed through', builtArgs.query_params.fields, 'id,Full_Name')
check("nested args: per_page is Zoho's maximum", builtArgs.query_params.per_page, 200)
check('nested args: starts on page 1', builtArgs.query_params.page, 1)

// A tool that cannot carry a filter must throw so the caller falls back to the REST API,
// rather than sending empty args and reporting "0 new leads" as a success.
let threw = ''
try {
  buildLeadsToolArgs({ name: 'ZohoCRM_listSomething', inputSchema: { properties: { limit: {} } } }, 'x')
} catch (err) {
  threw = err instanceof Error ? err.message : String(err)
}
checkTrue('a tool with no criteria parameter is refused', threw.includes('no criteria parameter'))

const nextPage = withPage(builtArgs, 3)
check('paging goes inside query_params for nested schemas', nextPage.query_params.page, 3)
check('paging leaves the criteria untouched', nextPage.query_params.criteria, builtArgs.query_params.criteria)
check('paging builds a flat page for flat schemas', withPage({ criteria: 'x' }, 2).page, 2)

check('paging info read from a nested envelope', extractPagingInfo({ data: [], info: { more_records: true, page: 2 } }).moreRecords, true)
check('paging info is false when absent', extractPagingInfo({ data: [] }).moreRecords, false)
check(
  "records are read from Zoho's data envelope",
  extractRecords({ data: [{ id: '1', Created_Time: '2026-09-24T01:00:00+05:30' }] }).length,
  1
)
check('records survive a JSON-string envelope', extractRecords(JSON.stringify({ data: [{ id: '2', Email: 'a@b.c' }] })).length, 1)
check('a count response yields no records', extractRecords({ count: 42 }).length, 0)

// --- retry classification ----------------------------------------------------
// The failures view offers a Retry button based on these, so getting them backwards either
// re-sends things that can never work, or hides a retry that would have succeeded.
//
// The important case is the account block: Zoho wraps "550 5.4.6 Unusual sending activity" in
// a 500 "Internal Error", so the message contains BOTH phrases and the specific rule must win.
// Marking this retryable (as an earlier version did) actively extends the block.
const ZOHO_BLOCK_MSG =
  'Zoho Mail API: Unable to send message;Reason:550 5.4.6 Unusual sending activity detected. Please try after sometime. Learn more. (code 500)'
check('an account sending block is detected, not the generic 500', explainMailError(ZOHO_BLOCK_MSG).label, 'sending blocked by Zoho')
check('an account sending block is NOT retryable', isRetryableMailError(ZOHO_BLOCK_MSG), false)
checkTrue(
  'the account-block detail explains the internal-vs-external asymmetry',
  /internal mail still works/i.test(explainMailError(ZOHO_BLOCK_MSG).detail)
)
checkTrue('the account-block detail warns against retrying', /do not keep retrying/i.test(explainMailError(ZOHO_BLOCK_MSG).detail))
check('a bare Internal Error is not retryable either', isRetryableMailError('Zoho Mail API: Internal Error (code 500)'), false)
check('missing mail config is not retryable', isRetryableMailError('SMTP not configured (set SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM in .env)'), false)
check('a rejected recipient is not retryable', isRetryableMailError('Zoho Mail API: recipient address rejected (code 550)'), false)
check('a revoked refresh token is not retryable', isRetryableMailError('Zoho Mail token refresh failed: invalid_code'), false)
checkTrue('a rate limit IS retryable', isRetryableMailError('Zoho Mail API: too many requests (code 429)'))
checkTrue('a network error is retryable', isRetryableMailError('fetch failed'))
check('an empty mail error yields no help', explainMailError('') === null, true)
check('an unrecognised mail error is still retryable', explainMailError('something new happened').retryable, true)

// --- per-family daily series -------------------------------------------------
// THE REGRESSION THIS EXISTS FOR: the stats route used to build ONE daily series across all
// four nudges and return it as `series`, and both family charts rendered that same field — so
// the two graphs were pixel-identical and the split looked plausible. buildDailySeries now
// takes an explicit nudge-id list, and these assertions prove a log lands in exactly one
// family's series.
const SERIES_SINCE = new Date('2026-09-20T00:00:00Z')
const mkLog = (nudgeId, over = {}) => ({
  nudgeId,
  channel: 'whatsapp',
  sentOk: true,
  opened: false,
  sentAt: new Date('2026-09-23T06:00:00Z'),
  createdAt: new Date('2026-09-23T06:00:00Z'),
  ...over,
})

const mixedLogs = [
  mkLog('famA-wa', { opened: true }),
  mkLog('famA-wa', { sentOk: false, opened: false, sentAt: null, createdAt: new Date('2026-09-23T06:05:00Z') }),
  mkLog('famB-wa'),
  mkLog('famB-wa'),
  mkLog('famB-wa'),
  mkLog('unrelated-wa'), // must appear in NEITHER family
]

const seriesA = buildDailySeries({ logs: mixedLogs, nudgeIds: ['famA-wa'], days: 4, since: SERIES_SINCE })
const seriesB = buildDailySeries({ logs: mixedLogs, nudgeIds: ['famB-wa'], days: 4, since: SERIES_SINCE })

const sum = (series, key) => series.reduce((n, d) => n + d[key], 0)
const dayOf = (series, date) => series.find((d) => d.date === date)

check('the two families do NOT produce the same series', JSON.stringify(seriesA) === JSON.stringify(seriesB), false)
check('family A counts only its own successes', sum(seriesA, 'waSent'), 1)
check('family A counts only its own failures', sum(seriesA, 'waFailed'), 1)
check('family B counts only its own successes', sum(seriesB, 'waSent'), 3)
check('family B has none of family A failures', sum(seriesB, 'waFailed'), 0)
check('an unrelated nudge is in neither series', sum(seriesA, 'waSent') + sum(seriesB, 'waSent'), 4)
check('a series has one bucket per requested day', seriesA.length, 4)
check('the logged day carries the counts', dayOf(seriesA, '2026-09-23').waSent, 1)
// A family whose two nudges have no logs at all must still return zero-filled buckets for
// every day, or its chart would silently render as empty rather than as zero.
const noLogs = buildDailySeries({ logs: mixedLogs, nudgeIds: ['nothing-here'], days: 4, since: SERIES_SINCE })
check('a family with no logs still gets one bucket per day', noLogs.length, 4)
check('those buckets are all zero', sum(noLogs, 'waSent') + sum(noLogs, 'waFailed'), 0)
check('empty days are zero, not missing', dayOf(seriesA, '2026-09-20').waSent, 0)

// A log at 20:00Z is 01:30 IST the NEXT day, so it must bucket on the IST date.
const istLog = [mkLog('famA-wa', { sentAt: new Date('2026-09-22T20:00:00Z'), createdAt: new Date('2026-09-22T20:00:00Z') })]
const istSeries = buildDailySeries({ logs: istLog, nudgeIds: ['famA-wa'], days: 5, since: SERIES_SINCE })
check('bucketing follows IST, not UTC', dayOf(istSeries, '2026-09-23').waSent, 1)
check('the UTC day it fell on is empty', dayOf(istSeries, '2026-09-22').waSent, 0)

// A failed log with no sentAt must still chart, via createdAt.
const neverSent = [mkLog('famA-wa', { sentOk: false, sentAt: null, createdAt: new Date('2026-09-21T04:00:00Z') })]
const neverSeries = buildDailySeries({ logs: neverSent, nudgeIds: ['famA-wa'], days: 5, since: SERIES_SINCE })
check('a never-sent failure still charts on its created day', dayOf(neverSeries, '2026-09-21').waFailed, 1)

check('email and whatsapp go to different fields', (() => {
  const s = buildDailySeries({
    logs: [mkLog('x', { channel: 'email' }), mkLog('x', { channel: 'whatsapp' })],
    nudgeIds: ['x'],
    days: 5,
    since: SERIES_SINCE,
  })
  return `${sum(s, 'emailSent')}/${sum(s, 'waSent')}`
})(), '1/1')

check('seriesIsEmpty is true for a blank series', seriesIsEmpty(buildDailySeries({ logs: [], nudgeIds: ['x'], days: 3, since: SERIES_SINCE })), true)
check('seriesIsEmpty is false once something is counted', seriesIsEmpty(seriesB), false)

// --- the hand-rolled .xlsx writer --------------------------------------------
// A corrupt workbook is the worst possible export bug: the user cannot tell "no data" from
// "broken file". So the archive is read back and every part is checked, rather than trusting
// that the bytes are right.
check('column letter: 1 -> A', columnLetter(1), 'A')
check('column letter: 26 -> Z', columnLetter(26), 'Z')
check('column letter: 27 -> AA', columnLetter(27), 'AA')
check('column letter: 52 -> AZ', columnLetter(52), 'AZ')
check('column letter: 53 -> BA', columnLetter(53), 'BA')
check('sheet names drop illegal characters', sanitiseSheetName('a:b/c\\d?e*f[g]h'), 'a b c d e f g h')
check('sheet names are capped at 31 characters', sanitiseSheetName('x'.repeat(60)).length, 31)
check('an empty sheet name falls back', sanitiseSheetName('   ', 'Fallback'), 'Fallback')

const sampleXlsx = buildXlsx(
  [
    { name: 'Logs', headers: ['Name', 'Count', 'Ok'], rows: [['Asha', 3, true], ['<b>Bold</b> & "quoted"', 0, false]], widths: [20, 8, 6] },
    { name: 'Weird:Name', headers: ['A'], rows: [['x']] },
  ],
  new Date('2026-09-24T10:00:00Z')
)
const zip = readZip(sampleXlsx)

for (const part of [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/styles.xml',
  'xl/worksheets/sheet1.xml',
  'xl/worksheets/sheet2.xml',
]) {
  checkTrue(`xlsx contains ${part}`, zip.has(part))
}
check('xlsx has exactly the expected parts', zip.size, 7)

// Every entry must inflate to its declared size — this is what catches an off-by-one in the
// deflate sizes or the CRC table.
const crcOk = [...zip.values()].every((f) => f.bytes.length === f.declaredSize)
checkTrue('every entry inflates to its declared size', crcOk)

// The full structural validator: required parts, resolvable relationships, balanced rows.
check('the sample workbook passes full validation', validateXlsx(sampleXlsx).join(' | '), '')
checkTrue('validation notices a truncated buffer', validateXlsx(sampleXlsx.subarray(0, 60)).length > 0)
checkTrue('validation notices arbitrary bytes', validateXlsx(Buffer.from('definitely not a zip')).length > 0)

const sheet1 = zip.get('xl/worksheets/sheet1.xml').content
checkTrue('header cells are bold (style index 1)', sheet1.includes('<c r="A1" s="1" t="inlineStr">'))
checkTrue('data cells carry no style', sheet1.includes('<c r="A2" t="inlineStr">'))
checkTrue('a text value is written as an inline string', sheet1.includes('<t xml:space="preserve">Asha</t>'))
checkTrue('numbers are written as numbers, not text', sheet1.includes('<c r="B2"><v>3</v></c>'))
checkTrue('booleans are written as booleans', sheet1.includes('t="b"><v>1</v></c>'))
checkTrue('markup in a value is escaped', sheet1.includes('&lt;b&gt;Bold&lt;/b&gt; &amp; &quot;quoted&quot;'))
checkTrue('a false boolean is 0', sheet1.includes('t="b"><v>0</v></c>'))
check('dimension covers the used range', /<dimension ref="A1:C3"\/>/.test(sheet1), true)
check('there is a frozen header row', sheet1.includes('state="frozen"'), true)
check('an autofilter is applied', sheet1.includes('<autoFilter ref="A1:C3"/>'), true)
check('column widths are emitted', sheet1.includes('<col min="1" max="1" width="20" customWidth="1"/>'), true)
check('row count: 1 header + 2 data rows', (sheet1.match(/<row /g) || []).length, 3)

const workbook = zip.get('xl/workbook.xml').content
checkTrue('the workbook declares both sheets', workbook.includes('name="Logs"') && workbook.includes('name="Weird Name"'))
checkTrue('sheet names are XML-escaped and legal', !workbook.includes('Weird:Name'))
check('the workbook rels reference both worksheets', (zip.get('xl/_rels/workbook.xml.rels').content.match(/relationships\/worksheet"/g) || []).length, 2)
checkTrue('styles are declared in the rels', zip.get('xl/_rels/workbook.xml.rels').content.includes('styles.xml'))
checkTrue('content types declare the workbook part', zip.get('[Content_Types].xml').content.includes('spreadsheetml.sheet.main+xml'))
checkTrue('content types declare both worksheets', (zip.get('[Content_Types].xml').content.match(/spreadsheetml\.worksheet\+xml/g) || []).length === 2)

// A single-sheet workbook is still valid (the Summary sheet is always added in practice, but
// a caller could pass one).
const single = readZip(buildXlsx([{ name: 'Only', headers: ['H'], rows: [['v']] }]))
check('a one-sheet workbook still declares a styles part', single.has('xl/styles.xml'), true)
check('an empty workbook does not crash', readZip(buildXlsx([])).size >= 6, true)

// A header-less sheet (the Summary tab) must declare a used range covering its DATA, not just
// column A — deriving the width from the header count declared A1:A11 over a 4-column table.
const headerless = readZip(
  buildXlsx([{ name: 'Summary', headers: [], rows: [['Range (IST)', '2026-09-23 to 2026-09-23'], ['Rows exported', 5]] }])
)
const headerlessSheet = headerless.get('xl/worksheets/sheet1.xml').content
check('a header-less sheet spans its widest data row', /<dimension ref="A1:B2"\/>/.test(headerlessSheet), true)
check('a header-less sheet has no bogus autofilter', headerlessSheet.includes('<autoFilter'), false)
check('a header-less sheet does not freeze a non-existent header', headerlessSheet.includes('state="frozen"'), false)
check('a header-less sheet starts its data at row 1', headerlessSheet.includes('<row r="1">'), true)
check('a header-less sheet has no empty header row artefact', (headerlessSheet.match(/<row /g) || []).length, 2)

// A sheet with headers keeps the freeze, the filter, and one leading header row.
const withHeader = readZip(buildXlsx([{ name: 'H', headers: ['a', 'b'], rows: [[1, 2]] }]))
const withHeaderSheet = withHeader.get('xl/worksheets/sheet1.xml').content
check('a header sheet still freezes the top row', withHeaderSheet.includes('state="frozen"'), true)
check('a header sheet still filters', withHeaderSheet.includes('<autoFilter ref="A1:B2"/>'), true)
check('a header sheet offsets data to row 2', withHeaderSheet.includes('<row r="2">'), true)

// The documented CRC32 of "123456789" is 0xCBF43926 — catches a bad polynomial/table.
check('crc32 matches the reference vector', crc32(Buffer.from('123456789')) >>> 0, 0xcbf43926)

// --- export filters -----------------------------------------------------------
check('IST day of a UTC-evening instant rolls over', istDay(new Date('2026-09-22T20:00:00Z')), '2026-09-23')
check('IST day of a UTC-morning instant', istDay(new Date('2026-09-23T06:00:00Z')), '2026-09-23')
check('IST datetime is formatted for humans', istDateTime(new Date('2026-09-23T06:05:00Z')), '2026-09-23 11:35:00')
check('a null date formats as empty', istDateTime(null), '')

// An inclusive IST day range must cover exactly that IST day: 00:00:00 to 23:59:59.999 IST.
const range = istRangeToUtc('2026-09-23', '2026-09-23')
check('range start is 00:00 IST == 18:30 UTC the day before', range.start.toISOString(), '2026-09-22T18:30:00.000Z')
check('range end is 23:59:59.999 IST', range.end.toISOString(), '2026-09-23T18:29:59.999Z')

// The boundaries are the whole point of IST handling, so test both sides of each edge.
const inRange = (iso) => {
  const d = new Date(iso)
  return d >= range.start && d <= range.end
}
check('00:00:00.000 IST on the day is INSIDE', inRange('2026-09-22T18:30:00.000Z'), true)
check('00:30 IST on the day is INSIDE', inRange('2026-09-22T19:00:00.000Z'), true)
check('01:00 IST on the day is INSIDE', inRange('2026-09-22T19:30:00.000Z'), true)
check('23:59:59.999 IST on the day is INSIDE', inRange('2026-09-23T18:29:59.999Z'), true)
check('one millisecond before the day starts is OUTSIDE', inRange('2026-09-22T18:29:59.999Z'), false)
check('23:59:59.999 IST the PREVIOUS day is OUTSIDE', inRange('2026-09-22T18:29:00.000Z'), false)
check('00:00 IST the NEXT day is OUTSIDE', inRange('2026-09-23T18:30:00.000Z'), false)
check('a US-timezone evening that is IST morning is INSIDE (the bug this guards)', inRange('2026-09-22T19:45:00.000Z'), true)

let rangeErr = ''
try {
  istRangeToUtc('2026-09-24', '2026-09-23')
} catch (err) {
  rangeErr = err instanceof Error ? err.message : String(err)
}
checkTrue('a backwards range is rejected', rangeErr.includes('before the start date'))

let badDateErr = ''
try {
  istRangeToUtc('not-a-date', '2026-09-23')
} catch (err) {
  badDateErr = err instanceof Error ? err.message : String(err)
}
checkTrue('a malformed date is rejected', badDateErr.includes('expected YYYY-MM-DD'))

let impossibleErr = ''
try {
  istRangeToUtc('2026-02-31', '2026-02-31')
} catch (err) {
  impossibleErr = err instanceof Error ? err.message : String(err)
}
checkTrue('an impossible calendar date is rejected, not silently rolled over', impossibleErr.includes('not a real calendar date'))

// --- row mapping ---------------------------------------------------------------
// Rows are built from plain objects here rather than a live database, which is the reason
// this logic was split out of the query module.
const baseLog = (over = {}) => ({
  channel: 'whatsapp',
  createdAt: new Date('2026-09-23T06:00:00Z'),
  sentAt: new Date('2026-09-23T06:00:01Z'),
  opened: false,
  openedAt: null,
  opensCount: 0,
  replied: false,
  repliedAt: null,
  sentOk: true,
  sendError: null,
  subject: null,
  templateName: 'ip_whitelisting_mandatory',
  messageNumber: 1,
  toEmail: null,
  toPhone: '919876543210',
  trackingId: 'tid-1',
  sheetRowRef: null,
  inboundText: null,
  nudge: { key: 'whatsapp_ip_whitelisting', name: 'WhatsApp · IP whitelisting' },
  lead: null,
  ...over,
})

check('status: a plain success is sent', exportStatus(baseLog()), 'sent')
check('status: opened beats sent', exportStatus(baseLog({ opened: true })), 'opened')
check('status: replied beats everything', exportStatus(baseLog({ replied: true, opened: true })), 'replied')
check('status: a failure is failed', exportStatus(baseLog({ sentOk: false })), 'failed')
check('status: a failure that was later opened still reads opened', exportStatus(baseLog({ sentOk: false, opened: true })), 'opened')

const waRow = logToExportRow(baseLog({ opened: true, opensCount: 2, openedAt: new Date('2026-09-23T07:00:00Z'), replied: true, repliedAt: new Date('2026-09-23T08:00:00Z'), inboundText: 'ok thanks' }))
check('a row has one cell per column', waRow.length, EXPORT_COLUMNS.length)
check('row[0] is the IST attempt time', waRow[0], '2026-09-23 11:30:00')
check('row[1] is the UTC attempt time', waRow[1], '2026-09-23T06:00:00.000Z')
check('row[3] is the channel', waRow[3], 'whatsapp')
check('row[5] is the nudge key', waRow[5], 'whatsapp_ip_whitelisting')
check('row[6] falls back to the phone for a sheet send with no lead', waRow[6], '919876543210')
check('row[9] carries the phone', waRow[9], '919876543210')
check('row[13] is the derived status', waRow[13], 'replied')
check('row[15] marks it opened', waRow[15], 'yes')
check('row[16] carries the open count as a number', waRow[16], 2)
check('row[19] carries the reply time in IST', waRow[19], '2026-09-23 13:30:00')
check('row[20] carries what the customer wrote', waRow[20], 'ok thanks')

const failedRow = logToExportRow(baseLog({ sentOk: false, sentAt: null, sendError: 'Zoho Mail API: Internal Error (code 500)' , channel: 'email', toEmail: 'a@b.c' }))
check('a failed row has no sent time', failedRow[2], '')
check('a failed row carries a plain-English reason', failedRow[21], 'provider error')
checkTrue('a failed row explains the cause', String(failedRow[22]).length > 20)
check('a failed row keeps the raw error', failedRow[23], 'Zoho Mail API: Internal Error (code 500)')

// The two channels have separate translators, and WhatsApp's returns null for text it does not
// recognise, so the row falls back to a generic label rather than showing a blank reason.
const unknownWaRow = logToExportRow(baseLog({ sentOk: false, sendError: 'something nobody has seen before' }))
check('an unrecognised WhatsApp error still gets a label', unknownWaRow[21], 'unrecognised')
const unknownMailRow = logToExportRow(
  baseLog({ sentOk: false, channel: 'email', toEmail: 'a@b.c', sendError: 'something nobody has seen before' })
)
check('an unrecognised email error gets the mail fallback label', unknownMailRow[21], 'send failed')

const noErrorRow = logToExportRow(baseLog())
check('a successful row has no failure reason', noErrorRow[21], '')
check('a successful row has no error detail', noErrorRow[23], '')

const breakdown = buildBreakdown([
  baseLog(),
  baseLog({ sentOk: false }),
  baseLog({ opened: true }),
  baseLog({ nudge: { key: 'other', name: 'Other' } }),
])
check('breakdown counts each nudge/channel/status once', breakdown.length, 4)
check('breakdown is sorted by count, descending', breakdown[0].count, 1)
check('breakdown names the nudge key', breakdown.map((b) => b.nudge).includes('whatsapp_ip_whitelisting'), true)
check('breakdown aggregates repeats', buildBreakdown([baseLog(), baseLog()])[0].count, 2)

// --- CSV ----------------------------------------------------------------------
const csv = toCsv(['a', 'b'], [['plain', 'has,comma'], ['has"quote', 'has\nnewline']])
checkTrue('csv starts with a UTF-8 BOM so Excel decodes it', csv.startsWith('\ufeff'))
checkTrue('csv quotes a field containing a comma', csv.includes('"has,comma"'))
checkTrue('csv doubles embedded quotes', csv.includes('"has""quote"'))
checkTrue('csv quotes a field containing a newline', csv.includes('"has\nnewline"'))
checkTrue('csv uses CRLF line endings', csv.includes('\r\n'))
check('csv writes a header row plus data rows', csv.trim().split('\r\n').length, 3)
checkTrue('the export has a column for the reply text', EXPORT_COLUMNS.includes('Reply text'))
checkTrue('the export has a column for the failure reason', EXPORT_COLUMNS.includes('Failure explained'))
checkTrue('a WhatsApp cap IS retryable', isRetryableWhatsAppError('not delivered to maintain healthy ecosystem engagement (code 131049)'))
checkTrue('a marketing opt-out IS retryable', isRetryableWhatsAppError("User's number is part of an experiment (code 130472)"))
check('an undeliverable number is not retryable', isRetryableWhatsAppError('Message undeliverable (code 131026)'), false)
check('a missing template is not retryable', isRetryableWhatsAppError('template does not exist in the translation (code 132001)'), false)
check('a parameter mismatch is not retryable', isRetryableWhatsAppError('number of parameters does not match (code 132000)'), false)
check('a bad token is not retryable', isRetryableWhatsAppError('Invalid OAuth access token (code 190)'), false)

// --- sheet variable building (shared by sheet-run and retry) -----------------
// A retry must render the SAME link as the original send, so the mobile normalisation is
// load-bearing: sheets store 9876543210, +91 98765 43210 and 0919876543210 interchangeably.
check('digits: plain 10-digit number', normaliseMobileDigits('9876543210'), '9876543210')
check('digits: strips +91 and spaces', normaliseMobileDigits('+91 98765 43210'), '9876543210')
check('digits: strips a leading trunk zero', normaliseMobileDigits('09876543210'), '9876543210')
check('digits: strips 91 only when 10 digits follow', normaliseMobileDigits('919876543210'), '9876543210')
check('digits: keeps a 91 prefix that is part of the number', normaliseMobileDigits('9123456789'), '9123456789')
check('digits: non-numeric input yields empty', normaliseMobileDigits('n/a'), '')

const sheetRow = { email: 'a@b.com', mobile: '+91 98765 43210', name: 'Asha', company: 'Acme' }
const sheetVars = buildSheetVars(sheetRow, { email: 'a@b.com', mobile: sheetRow.mobile, messageNumber: 2 })
check('sheet vars: mobile_digits is normalised', sheetVars.mobile_digits, '9876543210')
check('sheet vars: first_name falls back to the name column', sheetVars.first_name, 'Asha')
check('sheet vars: message_number is carried', sheetVars.message_number, 2)
check('sheet vars: the whole row is still addressable', sheetVars.company, 'Acme')
const noName = buildSheetVars({ email: 'zed@x.com' }, { email: 'zed@x.com', mobile: '' })
check('sheet vars: first_name falls back to the email local part', noName.first_name, 'zed')
check('column picker accepts email_address', pickSheetEmail({ email_address: 'x@y.z' }), 'x@y.z')
check('column picker accepts whatsapp for mobile', pickSheetMobile({ whatsapp: '999' }), '999')

// --- who a sheet run sends to -------------------------------------------------
// THE POLICY: the sheet is the source of truth. Every row is sent, history is never consulted,
// and the only de-duplication is WITHIN the run. planSheetSends() takes no history argument at
// all, which is what makes "it will not skip someone we messaged before" structural rather than
// a promise.
const fakeNormalise = (raw) => {
  const d = String(raw).replace(/\D/g, '').replace(/^0+/, '').replace(/^91(?=\d{10}$)/, '')
  return d.length === 10 ? d : null
}

const waRows = [
  { mobile: '9876543210', email: 'a@x.com' },
  { mobile: '9876543211', email: 'b@x.com' },
  { mobile: '9876543210', email: 'a@x.com' }, // repeated in the sheet
  { mobile: '', email: 'nonumber@x.com' }, // no usable mobile
]
const waPlan = planSheetSends(waRows, { isWhatsApp: true, normalisePhone: fakeNormalise })

check('every distinct phone in the sheet is sent', waPlan.toSend.length, 2)
check('the repeated phone is collapsed to one send', waPlan.toSend.filter((s) => s.address === '9876543210').length, 1)
check('the repeat is reported, not silently dropped', waPlan.skipped.filter((s) => s.reason === 'duplicate_in_sheet').length, 1)
check('a row with no usable phone is skipped', waPlan.skipped.filter((s) => s.reason === 'no_valid_phone').length, 1)
check('sends carry the sheet row number', waPlan.toSend[0].rowNumber, 1)
check('the FIRST occurrence is the one sent', waPlan.toSend[0].row.email, 'a@x.com')
check('the repeat reports its own row number', waPlan.skipped.find((s) => s.reason === 'duplicate_in_sheet').rowNumber, 3)
check('every row is accounted for', waPlan.toSend.length + waPlan.skipped.length, waRows.length)

// The same 3 addresses in two separate runs are both sent: nothing is remembered between runs.
const runAgain = planSheetSends(waRows, { isWhatsApp: true, normalisePhone: fakeNormalise })
check('re-running the identical sheet sends again', runAgain.toSend.length, 2)

// Phone normalisation is the dedup key, so the same number written differently is one send.
const messy = [
  { mobile: '+91 98765 43210' },
  { mobile: '09876543210' },
  { mobile: '919876543210' },
]
const messyPlan = planSheetSends(messy, { isWhatsApp: true, normalisePhone: fakeNormalise })
check('the same number written three ways is one send', messyPlan.toSend.length, 1)
check('and two collapses are reported', messyPlan.skipped.filter((s) => s.reason === 'duplicate_in_sheet').length, 2)

// Email side: dedup key is the address, case-insensitively.
const emailRows = [
  { email: 'A@X.com' },
  { email: 'a@x.com' }, // same address, different case
  { email: '' }, // no address at all
]
const emailPlan = planSheetSends(emailRows, { isWhatsApp: false, normalisePhone: fakeNormalise })
check('email: one send for the same address in two cases', emailPlan.toSend.length, 1)
check('email: a row with no email column is skipped', emailPlan.skipped.filter((s) => s.reason === 'no_email_column').length, 1)
check('email: the case-duplicate is reported', emailPlan.skipped.filter((s) => s.reason === 'duplicate_in_sheet').length, 1)

// A sheet where every row is distinct sends to every row — the case the user hit, where history
// used to make the run silently deliver nothing.
const manyRows = Array.from({ length: 48 }, (_, i) => ({ mobile: `987654${String(3200 + i)}` }))
check('48 distinct rows produce 48 sends', planSheetSends(manyRows, { isWhatsApp: true, normalisePhone: fakeNormalise }).toSend.length, 48)
check('an empty sheet plans nothing', planSheetSends([], { isWhatsApp: true, normalisePhone: fakeNormalise }).toSend.length, 0)


// --- the per-lead cap only governs lead-driven nudges -------------------------
// The cap is read ONLY by decideSend, which runs on the lead-driven paths. The sheet-run route
// never calls it — it applies "one message per recipient" instead. So a cap on a sheet nudge is
// a control that does nothing, and the UI must not offer it.
check('a Zoho-criteria nudge is lead-driven', nudgeSourceOf({ zohoCriteria: '((a:b:c))', filters: '{}' }), 'zoho')
check('a nudge with no criteria is a sheet nudge', nudgeSourceOf({ zohoCriteria: null, filters: '{}' }), 'sheet')
check('an empty criteria string is a sheet nudge', nudgeSourceOf({ zohoCriteria: '   ', filters: '{}' }), 'sheet')
check('filters.source=mysql wins over having no criteria', nudgeSourceOf({ zohoCriteria: null, filters: '{"source":"mysql"}' }), 'mysql')
check('unparseable filters do not throw', nudgeSourceOf({ zohoCriteria: '((x))', filters: 'not json' }), 'zoho')

check('the cap applies to a Zoho nudge', capAppliesTo({ zohoCriteria: '((a))' }), true)
check('the cap applies to a MySQL nudge', capAppliesTo({ zohoCriteria: null, filters: '{"source":"mysql"}' }), true)
check('the cap does NOT apply to a sheet nudge', capAppliesTo({ zohoCriteria: null, filters: '{"source":"sheet"}' }), false)

// Every sheet nudge in the defaults must carry the honest 1 / 0, never a cap that misleads.
const sheetNudges = DEFAULT_NUDGES.filter((n) => !capAppliesTo(n))
const sheetKeys = DEFAULT_NUDGES.filter((n) => !capAppliesTo(n)).map((n) => n.key)
checkTrue('the defaults contain sheet nudges to check', sheetNudges.length >= 5)
check(
  'no sheet nudge claims a multi-message cap',
  sheetNudges.filter((n) => n.maxEmailsPerLead !== 1).map((n) => n.key).join(','),
  ''
)
check(
  'no sheet nudge claims a follow-up gap',
  sheetNudges.filter((n) => n.followUpDays !== 0).map((n) => n.key).join(','),
  ''
)
checkTrue('the IP whitelisting nudge is treated as a sheet nudge', sheetKeys.includes('whatsapp_ip_whitelisting'))
checkTrue('the onboarding email twins are sheet nudges', sheetKeys.includes('onboarded_transacting') && sheetKeys.includes('onboarded_not_transacting'))
// And a lead-driven nudge must NOT have been flattened to 1/0 by the same change.
check(
  'lead-driven nudges keep a real cap',
  DEFAULT_NUDGES.filter((n) => capAppliesTo(n)).every((n) => n.maxEmailsPerLead >= 1),
  true
)
checkTrue(
  'documents_pending_wa (lead-driven) still allows 3',
  DEFAULT_NUDGES.find((n) => n.key === 'documents_pending_wa')?.maxEmailsPerLead === 3
)

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)

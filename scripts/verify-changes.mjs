/**
 * In-process verification of the pure logic changed in this pass.
 * Run: node scripts/verify-changes.mjs
 * (No server, no child processes — safe under a locked-down environment.)
 */
import { readFileSync } from 'node:fs'
import { renderTemplate, escapeHtml, injectTrackingPixel, htmlToText } from '../src/lib/template.ts'
import { isCronAuthorized, isWebhookAuthorized } from '../src/lib/cron-auth.ts'
import { checkKycCounts, kycCountsMatch, requiresKycMatch, kycRuleOf, hasKycRule, splitByKycMatch } from '../src/lib/kyc-match.ts'
import { decideSend, sentLog } from '../src/lib/sequence.ts'
import { DEFAULT_NUDGES, ZOHO_CRITERIA, LEAD_STATUS, PAY_ACTIVATION_FEE_URL, WHATSAPP_TEST_STATUS, MYSQL_FLOW_TEMPLATES, WA_SHEET_FLOW_TEMPLATES, ZOHO_FLOW_TEMPLATES, EPS_BUSINESS_VERTICAL, zohoDocumentsPendingCriteria, MYSQL_FLOW_LOOKBACK, CONSOLE_URL, zohoTodayIso, zohoTodayCriteria, zohoCriteriaSince, ZOHO_LEADS_CREATED_AFTER, ZOHO_TZ_OFFSET, zohoCriteriaBetween, zohoIstIso, zohoSyncOverlapMinutes } from '../src/lib/nudge-defaults.ts'
import { MYSQL_FLOW_KEYS, isMysqlFlowKey, partitionVerifyRows, windowOverlapMinutes, windowMinutesFor } from '../src/lib/mysql-nudges.ts'
import { cadenceHoursOf, cadenceDue } from '../src/lib/cadence.ts'
import {
  attributionWindowHours,
  computeScore,
  daysBetween,
  isConvertedStatus,
  pickAttribution,
  scoreBand,
  SCORE_BAND_LABEL,
  SCORE_WEIGHTS,
  timeInPrevStageHours,
} from '../src/lib/journey.ts'
import { buildWhatsAppParams as buildWhatsAppParamsRaw, missingSheetColumns as missingSheetColumnsRaw } from '../src/lib/whatsapp-params.ts'
import { extractInboundText, appendInbound, INBOUND_KEEP } from '../src/lib/whatsapp-inbound.ts'
import { explainWhatsAppError, isDeliveryCapError, isPermanentDeliveryFailure } from '../src/lib/whatsapp-errors.ts'
import { WA_EMAIL_TWIN, WA_UTILITY_SAFE_COPY, WA_RETIRED_MARKETING_TEMPLATES } from '../src/lib/nudge-defaults.ts'
import { buildTemplatePayload, validateTemplateInput, countTemplateVars } from '../src/lib/whatsapp-templates.ts'
import { pickLeadsTool, buildLeadsToolArgs, withPage, extractPagingInfo, extractRecords } from '../src/lib/zoho-mcp.ts'
import { explainMailError, isRetryableMailError } from '../src/lib/mail-errors.ts'
import { isRetryableWhatsAppError } from '../src/lib/whatsapp-errors.ts'
import { buildSheetVars, normaliseMobileDigits, pickSheetEmail, pickSheetMobile, planSheetSends } from '../src/lib/sheet-vars.ts'
import { buildDailySeries, seriesIsEmpty, istDayKey } from '../src/lib/engagement-stats.ts'
import { nudgeSourceOf, capAppliesTo, isManualSheetNudge, runGuard } from '../src/lib/nudge-kind.ts'
import { buildXlsx, buildZip, crc32, columnLetter, sanitiseSheetName } from '../src/lib/xlsx.ts'
import { istDay, istDateTime, istRangeToUtc, istDaysAgo, toCsv, exportStatus, logToExportRow, buildBreakdown, EXPORT_COLUMNS, EXPORT_WIDTHS } from '../src/lib/export-format.ts'
import { readZip, validateXlsx } from './lib/read-zip.mjs'
import {
  buildCtaUrl,
  ctaButtonParam,
  ctaSendParams,
  ctaTrackBaseUrl,
  isCtaTrackingEnabled,
  isPlausibleCtaToken,
  isTrackedTemplate,
  baseTemplateName,
  CTA_TEMPLATE_SUFFIX,
  resolveCtaDestination,
} from '../src/lib/cta.ts'
import {
  ctaDestinationFor,
  whatsappButtonUrlFor,
  templateButtonUrlFor,
  templateHasButton,
  trackedTemplateName,
} from '../src/lib/nudge-defaults.ts'
import { isTemplateUnavailable } from '../src/lib/whatsapp-errors.ts'
import {
  buildConversionEvent,
  normaliseEmailForHashing,
  normalisePhoneForHashing,
  sha256Hex,
} from '../src/lib/meta-capi.ts'
import {
  chunkTemplateIds,
  mergeAnalyticsResponse,
  toSortedRows,
  ANALYTICS_TEMPLATE_ID_LIMIT,
  ANALYTICS_MAX_DATA_POINTS,
  ANALYTICS_MAX_DAYS,
} from '../src/lib/meta-template-analytics.ts'

let failures = 0
/** Total assertions run. Printed in the summary so the count is never transcribed by hand. */
let total = 0
/** --quiet prints only failures and the summary; useful when iterating in a tight loop. */
const QUIET = process.argv.includes('--quiet')
function check(name, actual, expected) {
  total++
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

// --- the incremental sync window ------------------------------------------------
// "Sync new leads" asks for everything created since the last sync, closed at both ends. Verified
// against the live CRM: two conditions on Created_Time are accepted, but ONLY with an explicit
// +05:30 offset — an ISO "…Z" suffix is rejected as an invalid datetime.
check('the window bounds both ends', zohoCriteriaBetween('2026-09-24T14:48:58+05:30', '2026-09-28T14:58:13+05:30'), '((Business_vertical:equals:EPS)and(Created_Time:greater_than:2026-09-24T14:48:58+05:30)and(Created_Time:less_than:2026-09-28T14:58:13+05:30))')
checkTrue('the window keeps the EPS filter', zohoCriteriaBetween('a', 'b').includes('Business_vertical:equals:EPS'))
check('a Date is formatted with the CRM offset, never a Z', zohoIstIso(new Date('2026-09-28T09:28:13Z')), '2026-09-28T14:58:13+05:30')
checkTrue('the formatted datetime never ends in Z', !zohoIstIso(new Date('2026-09-28T09:28:13Z')).endsWith('Z'))
check('a midnight-UTC instant is the same IST day', zohoIstIso(new Date('2026-09-27T18:30:00Z')), '2026-09-28T00:00:00+05:30')
// The overlap guards a real race: the CRM is queried, then lastSyncedAt is stamped per upsert, so a
// lead created in between would fall outside a strict window and be lost.
checkTrue('there is a non-zero overlap by default', zohoSyncOverlapMinutes() > 0)
check('the default overlap is 10 minutes', zohoSyncOverlapMinutes(), 10)
process.env.ZOHO_SYNC_OVERLAP_MINUTES = '30'
check('the overlap is configurable', zohoSyncOverlapMinutes(), 30)
process.env.ZOHO_SYNC_OVERLAP_MINUTES = 'nonsense'
check('a nonsense overlap falls back to the default', zohoSyncOverlapMinutes(), 10)
process.env.ZOHO_SYNC_OVERLAP_MINUTES = '0'
check('an overlap of 0 is allowed (explicitly opting out)', zohoSyncOverlapMinutes(), 0)
delete process.env.ZOHO_SYNC_OVERLAP_MINUTES

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
check('whatsapp nudges: sample + legacy doc twin + 6 MySQL flows + 3 sheet + 1 CRM status', DEFAULT_NUDGES.filter((n) => n.channel === 'whatsapp').length, 12)
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
  // The nudge uses the TRACKED variant (`…_cta`) of its flow template, so that a tap can be
  // attributed to a person. Compare the base name, and assert the tracked variant is real.
  check(`${flow} template is the TRACKED variant of the flow key`, baseTemplateName(n?.whatsappTemplateName || ''), MYSQL_FLOW_TEMPLATES[flow].templateName)
  checkTrue(`${flow} points at a tracked template`, isTrackedTemplate(n?.whatsappTemplateName))
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
check('transacting WhatsApp template name', baseTemplateName(waTransacting.whatsappTemplateName || ''), 'activation_fee_pending_transacting')
check('not-transacting WhatsApp template name', baseTemplateName(waNotTransacting.whatsappTemplateName || ''), 'activation_fee_pending_not_transacting')
// Both pay nudges must be on the tracked variant — that is the whole point of this change.
checkTrue('transacting nudge uses a tracked template', isTrackedTemplate(waTransacting.whatsappTemplateName))
checkTrue('not-transacting nudge uses a tracked template', isTrackedTemplate(waNotTransacting.whatsappTemplateName))
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

// --- sheet-run pre-flight: a WhatsApp template's body columns must exist -----
// A WHOLE missing column used to be invisible: buildWhatsAppParams substitutes "-" and Meta
// accepts the send, so the customer got "documents still pending: -".
check(
  'a body source absent from the sheet is reported',
  JSON.stringify(missingSheetColumnsRaw('{"body":["pending_documents"]}', ['mobile', 'email'])),
  JSON.stringify(['pending_documents'])
)
check(
  'a body source present in the sheet passes',
  JSON.stringify(missingSheetColumnsRaw('{"body":["pending_documents"]}', ['mobile', 'pending_documents'])),
  JSON.stringify([])
)
check(
  'derived vars never require a column',
  JSON.stringify(missingSheetColumnsRaw('{"body":["first_name","mobile_digits","today"]}', ['mobile'])),
  JSON.stringify([])
)
check(
  'legacy array config is checked too',
  JSON.stringify(missingSheetColumnsRaw('["company"]', ['mobile'])),
  JSON.stringify(['company'])
)
check(
  'repeats are reported once',
  JSON.stringify(missingSheetColumnsRaw('{"body":["a","a"]}', ['mobile'])),
  JSON.stringify(['a'])
)
check('no params means nothing to check', JSON.stringify(missingSheetColumnsRaw('[]', [])), JSON.stringify([]))
check('corrupt params do not crash the pre-flight', JSON.stringify(missingSheetColumnsRaw('{oops', ['mobile'])), JSON.stringify([]))

// The tracked template the send path actually uses must be the one the template knows about,
// otherwise a sheet run would silently fall back to "-" for the body variable.
check(
  'the docs-pending MySQL flow declares its body variable',
  JSON.stringify(
    missingSheetColumnsRaw(
      DEFAULT_NUDGES.find((n) => n.key === 'documents_pending_upload')?.whatsappParams ?? null,
      ['mobile']
    )
  ),
  JSON.stringify(['pending_documents'])
)

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

// --- the "all documents submitted" rule (kyc_match) --------------------------
// Measured on the live CRM: of 39 EPS leads with Lead_Status = "Documents Pending", 25 (64%) have
// KYC_Documents_Expected_Count = NULL. So the null/zero guards below are the entire safety story —
// a naive "the counts are equal" test nudgees most of the cohort with a false claim.
const kycOk = { kycDocumentUploadCount: 11, kycDocumentsExpectedCount: 11 }
check('kyc: equal counts match', checkKycCounts(kycOk).matches, true)
check('kyc: lower upload does not match', checkKycCounts({ kycDocumentUploadCount: 6, kycDocumentsExpectedCount: 11 }).matches, false)
check('kyc: lower upload gives a differ reason', checkKycCounts({ kycDocumentUploadCount: 6, kycDocumentsExpectedCount: 11 }).reason, 'kyc_counts_differ')
check('kyc: an UNKNOWN expected count never matches', checkKycCounts({ kycDocumentUploadCount: 6, kycDocumentsExpectedCount: null }).matches, false)
check('kyc: unknown expected gives its own reason', checkKycCounts({ kycDocumentUploadCount: 6, kycDocumentsExpectedCount: null }).reason, 'kyc_expected_unknown')
check('kyc: null === null does NOT match (the 25/39 trap)', checkKycCounts({ kycDocumentUploadCount: null, kycDocumentsExpectedCount: null }).matches, false)
check('kyc: 0 === 0 does NOT match (the double-zero trap)', checkKycCounts({ kycDocumentUploadCount: 0, kycDocumentsExpectedCount: 0 }).matches, false)
check('kyc: expected 0 is refused even when the upload is 0', checkKycCounts({ kycDocumentUploadCount: 0, kycDocumentsExpectedCount: 0 }).reason, 'kyc_expected_zero')
check('kyc: a negative expected count is refused', checkKycCounts({ kycDocumentUploadCount: 5, kycDocumentsExpectedCount: -5 }).matches, false)
check('kyc: a MISSING upload is refused', checkKycCounts({ kycDocumentUploadCount: null, kycDocumentsExpectedCount: 11 }).matches, false)
check('kyc: missing upload gives its own reason', checkKycCounts({ kycDocumentUploadCount: null, kycDocumentsExpectedCount: 11 }).reason, 'kyc_upload_unknown')
check('kyc: uploading MORE than expected is not a match (needs a human)', checkKycCounts({ kycDocumentUploadCount: 12, kycDocumentsExpectedCount: 11 }).matches, false)
check('kyc: the boolean helper agrees', kycCountsMatch(kycOk), true)

// --- the less_than rule (the Documents Pending reminder) ----------------------
check('less_than: fewer uploaded than expected matches', checkKycCounts({ kycDocumentUploadCount: 6, kycDocumentsExpectedCount: 11 }, 'less_than').matches, true)
check('less_than: 0 uploaded matches', checkKycCounts({ kycDocumentUploadCount: 0, kycDocumentsExpectedCount: 11 }, 'less_than').matches, true)
check('less_than: equal counts do NOT match', checkKycCounts({ kycDocumentUploadCount: 11, kycDocumentsExpectedCount: 11 }, 'less_than').matches, false)
check('less_than: equal counts give the not_less reason', checkKycCounts({ kycDocumentUploadCount: 11, kycDocumentsExpectedCount: 11 }, 'less_than').reason, 'kyc_counts_not_less')
check('less_than: MORE than expected does not match', checkKycCounts({ kycDocumentUploadCount: 12, kycDocumentsExpectedCount: 11 }, 'less_than').matches, false)
// The guards must hold for BOTH rules, not just equals: `upload < null` coerces to `upload < 0`
// in JS, which would drop the lead silently instead of reporting why.
check('less_than: an UNKNOWN expected count is refused, not coerced', checkKycCounts({ kycDocumentUploadCount: 6, kycDocumentsExpectedCount: null }, 'less_than').matches, false)
check('less_than: unknown expected gives the unknown reason', checkKycCounts({ kycDocumentUploadCount: 6, kycDocumentsExpectedCount: null }, 'less_than').reason, 'kyc_expected_unknown')
check('less_than: expected 0 is refused', checkKycCounts({ kycDocumentUploadCount: 0, kycDocumentsExpectedCount: 0 }, 'less_than').reason, 'kyc_expected_zero')
check('less_than: a missing upload is refused', checkKycCounts({ kycDocumentUploadCount: null, kycDocumentsExpectedCount: 11 }, 'less_than').reason, 'kyc_upload_unknown')

// --- rule resolution (enum, with the legacy boolean spelling) -----------------
check('rule: no filter means no rule', kycRuleOf({}), null)
check('rule: the enum is read (less_than)', kycRuleOf({ kycCountRule: 'less_than' }), 'less_than')
check('rule: the enum is read (equals)', kycRuleOf({ kycCountRule: 'equals' }), 'equals')
check('rule: the legacy boolean still means equals', kycRuleOf({ kycMatchesExpected: true }), 'equals')
check('rule: the legacy boolean false means no rule', kycRuleOf({ kycMatchesExpected: false }), null)
check('rule: the two spellings agreeing is fine', kycRuleOf({ kycCountRule: 'equals', kycMatchesExpected: true }), 'equals')
// Contradictory configuration must NOT be silently resolved in either direction.
check('rule: the two spellings disagreeing is a conflict', kycRuleOf({ kycCountRule: 'less_than', kycMatchesExpected: true }), 'conflict')
check('rule: a conflict refuses the whole batch', splitByKycMatch([kycOk], { kycCountRule: 'less_than', kycMatchesExpected: true }).kept.length, 0)
check('rule: a conflict is reported, not silent', splitByKycMatch([kycOk], { kycCountRule: 'less_than', kycMatchesExpected: true }).rejected[0].reason, 'kyc_rule_conflict')
check('rule: hasKycRule is false when unset', hasKycRule({}), false)
check('rule: hasKycRule is true when set', hasKycRule({ kycCountRule: 'equals' }), true)
check('kyc: the filter is off unless asked for', requiresKycMatch({}), false)
check('kyc: the filter is on when true', requiresKycMatch({ kycMatchesExpected: true }), true)
check('kyc: a truthy non-true value does not switch it on', requiresKycMatch({ kycMatchesExpected: 1 }), false)

// splitByKycMatch is the single place a rule is applied, shared by runNudge, previewNudge and the
// CRM webhook — so its keep/reject split must be exact.
const kycRows = [
  { id: 'a', kycDocumentUploadCount: 11, kycDocumentsExpectedCount: 11 },
  { id: 'b', kycDocumentUploadCount: 6, kycDocumentsExpectedCount: 11 },
  { id: 'c', kycDocumentUploadCount: null, kycDocumentsExpectedCount: null },
]
check('row predicates: off means everything passes', splitByKycMatch(kycRows, {}).kept.length, 3)
check('row predicates: off rejects nothing', splitByKycMatch(kycRows, {}).rejected.length, 0)
check('row predicates: equals keeps exactly the match', splitByKycMatch(kycRows, { kycCountRule: 'equals' }).kept.map((r) => r.id).join(','), 'a')
check('row predicates: equals rejects the other two', splitByKycMatch(kycRows, { kycCountRule: 'equals' }).rejected.length, 2)
check(
  'row predicates: each rejection carries its reason',
  splitByKycMatch(kycRows, { kycCountRule: 'equals' }).rejected.map((r) => r.reason).join(','),
  'kyc_counts_differ,kyc_expected_unknown'
)
check('row predicates: less_than keeps exactly the shortfall', splitByKycMatch(kycRows, { kycCountRule: 'less_than' }).kept.map((r) => r.id).join(','), 'b')
check('row predicates: less_than rejects the equality', splitByKycMatch(kycRows, { kycCountRule: 'less_than' }).rejected.map((r) => r.reason).join(','), 'kyc_counts_not_less,kyc_expected_unknown')

// --- the documents-submitted-review nudge -----------------------------------
const reviewNudge = DEFAULT_NUDGES.find((n) => n.key === 'documents_submitted_review')
const reviewFilters = reviewNudge ? JSON.parse(reviewNudge.filters) : {}
check('review nudge exists', Boolean(reviewNudge), true)
check('review nudge is a WhatsApp nudge', reviewNudge?.channel, 'whatsapp')
check('review nudge ships disabled until its template is approved', reviewNudge?.enabled, false)
check('review nudge requires a phone', reviewFilters.requirePhone, true)
check('review nudge is scoped to the Documents Pending status', JSON.stringify(reviewFilters.includeStatuses), JSON.stringify([LEAD_STATUS.DOCUMENTS_PENDING]))
check('review nudge is scoped to the EPS vertical', reviewFilters.businessVertical, EPS_BUSINESS_VERTICAL)
check('review nudge uses the equals rule', reviewFilters.kycCountRule, 'equals')
check('review nudge uses no legacy rule spelling', reviewFilters.kycMatchesExpected, undefined)
check('review nudge does not also set a KYC range', reviewFilters.maxKycCount === undefined && reviewFilters.minKycCount === undefined, true)
check('review nudge syncs on EPS', reviewNudge?.zohoCriteria?.includes('Business_vertical:equals:EPS'), true)
check('review nudge syncs on the Documents Pending status', reviewNudge?.zohoCriteria?.includes('Lead_Status:equals:Documents Pending'), true)
// The criteria must NOT carry a Created_Time bound: the flow is status-driven, and a created-after
// cut-off would silently stop covering older leads that only just finished uploading.
check('review nudge criteria has no Created_Time bound', reviewNudge?.zohoCriteria?.includes('Created_Time') ?? true, false)
check('review criteria builder matches the seeded criteria', zohoDocumentsPendingCriteria(), reviewNudge?.zohoCriteria)
check('review nudge uses the tracked template', reviewNudge?.whatsappTemplateName, 'documents_submitted_review_cta')
check('review nudge language is en_US', reviewNudge?.whatsappLanguage, 'en_US')
check('review nudge sends only the button parameter', JSON.stringify(JSON.parse(reviewNudge?.whatsappParams ?? '{}')), JSON.stringify({ body: [], button: ['mobile_digits'] }))
check('review nudge is once per lead, ever', `${reviewNudge?.maxEmailsPerLead}/${reviewNudge?.followUpDays}`, '1/0')
check('review template declares no body variables', countTemplateVars(ZOHO_FLOW_TEMPLATES.documents_submitted_review.body), 0)
check('review template body is within Meta limits', ZOHO_FLOW_TEMPLATES.documents_submitted_review.body.length <= 1024, true)
check('review template body says the documents are received', /received all the documents submitted/i.test(ZOHO_FLOW_TEMPLATES.documents_submitted_review.body), true)
check('review template body says it is under review', /reviewing them/i.test(ZOHO_FLOW_TEMPLATES.documents_submitted_review.body), true)
check('review template body carries no promotional wording', /discount|offer|free|hurry/i.test(ZOHO_FLOW_TEMPLATES.documents_submitted_review.body), false)
check('review template button is the console link', ZOHO_FLOW_TEMPLATES.documents_submitted_review.buttonUrl, `${CONSOLE_URL}?mobile={{1}}`)
// The tracked twin's button must reach the tracker; the base template's must reach the console.
// With no tracker configured (the state this early in the script) the tracked twin must fall back
// to the real destination rather than producing a dead link. The tracker case is asserted further
// down, after CTA_TRACK_BASE_URL is set.
check('review tracked template falls back to the console when no tracker is set', templateButtonUrlFor('documents_submitted_review_cta'), `${CONSOLE_URL}?mobile={{1}}`)
check('review tracked template resolves to the console destination', whatsappButtonUrlFor('documents_submitted_review_cta'), `${CONSOLE_URL}?mobile={{1}}`)
check('review template has a button, so it is tracked', templateHasButton('documents_submitted_review'), true)
check('review base template button is the console link', whatsappButtonUrlFor('documents_submitted_review'), `${CONSOLE_URL}?mobile={{1}}`)
check('review destination fills in the mobile', ctaDestinationFor('documents_submitted_review_cta', '9876543210'), `${CONSOLE_URL}?mobile=9876543210`)
check('review nudge flows through the webhook-able Zoho source', nudgeSourceOf({ zohoCriteria: reviewNudge?.zohoCriteria ?? null, filters: reviewNudge?.filters ?? '{}' }), 'zoho')
// Every CRM-driven nudge must be reachable from the webhook; a MySQL flow must not be offered.
check('a mysql nudge is not offered to the CRM webhook', nudgeSourceOf({ zohoCriteria: null, filters: '{"source":"mysql","flow":"mobile_otp_pending"}' }), 'mysql')

// --- documents_pending_wa: same pool, inverted rule, daily cadence -----------
const dpWa = DEFAULT_NUDGES.find((n) => n.key === 'documents_pending_wa')
const dpWaFilters = dpWa ? JSON.parse(dpWa.filters) : {}
check('dp_wa exists', Boolean(dpWa), true)
check('dp_wa is a WhatsApp nudge', dpWa?.channel, 'whatsapp')
check('dp_wa uses the SAME sync criteria as the review nudge', dpWa?.zohoCriteria, zohoDocumentsPendingCriteria())
check('dp_wa targets the same Documents Pending status', JSON.stringify(dpWaFilters.includeStatuses), JSON.stringify([LEAD_STATUS.DOCUMENTS_PENDING]))
check('dp_wa targets the same EPS vertical', dpWaFilters.businessVertical, EPS_BUSINESS_VERTICAL)
check('dp_wa uses the less_than rule (the difference from the review nudge)', dpWaFilters.kycCountRule, 'less_than')
check('dp_wa no longer filters on the old Agreement Signed status', JSON.stringify(dpWaFilters.includeStatuses).includes(LEAD_STATUS.AGREEMENT_SIGNED), false)
check('dp_wa no longer uses the KYC range filter', dpWaFilters.maxKycCount === undefined && dpWaFilters.minKycCount === undefined, true)
check('dp_wa requires a phone', dpWaFilters.requirePhone, true)
check('dp_wa keeps its approved template', dpWa?.whatsappTemplateName, 'documents_pending_reminder')
check('dp_wa language is en_US', dpWa?.whatsappLanguage, 'en_US')
// "Once in a day": exactly one day between sends, bounded at a week of reminders.
check('dp_wa sends at most once a day', dpWa?.followUpDays, 1)
check('dp_wa is capped at 7 messages, not unlimited', dpWa?.maxEmailsPerLead, 7)
// The two nudges must be mutually exclusive: one fires below the target, the other exactly on it.
const belowTarget = { kycDocumentUploadCount: 6, kycDocumentsExpectedCount: 11 }
check('a shortfall lead matches ONLY dp_wa, not the review nudge', `${checkKycCounts(belowTarget, 'less_than').matches}/${checkKycCounts(belowTarget, 'equals').matches}`, 'true/false')
const onTarget = { kycDocumentUploadCount: 11, kycDocumentsExpectedCount: 11 }
check('a complete lead matches ONLY the review nudge, not dp_wa', `${checkKycCounts(onTarget, 'equals').matches}/${checkKycCounts(onTarget, 'less_than').matches}`, 'true/false')

// --- the send-sequence rule (the cadence promises) ---------------------------
// Extracted to src/lib/sequence.ts specifically so these can be tested: "once in a day" is
// otherwise only a number in a config row.
const seqNow = new Date('2026-09-30T12:00:00Z')
const dpCadence = DEFAULT_NUDGES.find((n) => n.key === 'documents_pending_wa')
const maxPer = dpCadence?.maxEmailsPerLead ?? 7
const gapDays = dpCadence?.followUpDays ?? 1

check('sequence: a first send goes out as message 1', decideSend([], maxPer, gapDays, seqNow).action, 'send')
check('sequence: the first send is message number 1', decideSend([], maxPer, gapDays, seqNow).messageNumber, 1)
// "Once in a day": 1h after a send it must wait; 23h59m still waiting; 24h+ it may send again.
check('sequence: 1h after a send it waits', decideSend([sentLog(seqNow, 1)], maxPer, gapDays, seqNow).action, 'skip')
check('sequence: the wait reason is waiting_followup', decideSend([sentLog(seqNow, 1)], maxPer, gapDays, seqNow).reason, 'waiting_followup')
check('sequence: 23h after a send it still waits', decideSend([sentLog(seqNow, 23)], maxPer, gapDays, seqNow).action, 'skip')
check('sequence: 24h after a send it may send again', decideSend([sentLog(seqNow, 24)], maxPer, gapDays, seqNow).action, 'send')
check('sequence: the follow-up is message 2', decideSend([sentLog(seqNow, 24)], maxPer, gapDays, seqNow).messageNumber, 2)
check('sequence: 25h after a send it may send again', decideSend([sentLog(seqNow, 25)], maxPer, gapDays, seqNow).action, 'send')
// The "once per day" reading in one assertion: two sends in one day are impossible.
check(
  'sequence: a send 1h after another is refused (no two in a day)',
  decideSend([sentLog(seqNow, 1), sentLog(seqNow, 25)], maxPer, gapDays, seqNow).action,
  'skip'
)
// The cap bounds the sequence at 7. Every send here is at least a day old, so the daily gap is
// satisfied and only the cap can stop it.
check('sequence: 7 sends in the past is max_reached', decideSend([24, 48, 72, 96, 120, 144, 168].map((h) => sentLog(seqNow, h)), maxPer, gapDays, seqNow).reason, 'max_reached')
check('sequence: 6 sends in the past may still send', decideSend([24, 48, 72, 96, 120, 144].map((h) => sentLog(seqNow, h)), maxPer, gapDays, seqNow).action, 'send')
check('sequence: 6 sends makes the next one message 7', decideSend([24, 48, 72, 96, 120, 144].map((h) => sentLog(seqNow, h)), maxPer, gapDays, seqNow).messageNumber, 7)
// A reply always wins, whatever else is true.
check('sequence: a reply stops the sequence', decideSend([{ ...sentLog(seqNow, 100), replied: true }], maxPer, gapDays, seqNow).reason, 'replied')
check('sequence: a reply beats an elapsed follow-up', decideSend([{ ...sentLog(seqNow, 200), replied: true }], maxPer, gapDays, seqNow).action, 'skip')
// A pending Meta cap is waited out rather than retried every cycle. The stored form is Meta's own
// wording — isDeliveryCapError reads the code out of "(code N)", not a bare number.
const capLog = {
  sentOk: false,
  replied: false,
  sentAt: null,
  createdAt: new Date(seqNow.getTime() - 60 * 60 * 1000),
  sendError: 'Message failed (code 131049): healthy ecosystem engagement',
}
check('sequence: a pending Meta cap is waited out', decideSend([capLog], maxPer, gapDays, seqNow).reason, 'delivery_cap_backoff')
check('sequence: a pending Meta cap blocks even past the daily gap', decideSend([{ ...capLog, createdAt: new Date(seqNow.getTime() - 20 * 60 * 60 * 1000) }], maxPer, gapDays, seqNow).action, 'skip')
const oldCapLog = { ...capLog, createdAt: new Date(seqNow.getTime() - 48 * 60 * 60 * 1000) }
check('sequence: an elapsed cap allows a retry', decideSend([oldCapLog], maxPer, gapDays, seqNow).action, 'send')
// Only SUCCESSFUL sends count, so a provider failure must not consume the allowance.
const failedLog = { sentOk: false, replied: false, sentAt: null, createdAt: new Date(seqNow.getTime() - 60 * 60 * 1000), sendError: 'some transient error' }
check('sequence: a failed attempt does not consume the allowance', decideSend([failedLog], maxPer, gapDays, seqNow).action, 'send')
check('sequence: a failed attempt is still message 1', decideSend([failedLog], maxPer, gapDays, seqNow).messageNumber, 1)
// A once-ever nudge (max 1, gap 0) sends exactly once.
const onceNudge = DEFAULT_NUDGES.find((n) => n.key === 'documents_submitted_review')
check('sequence: a once-ever nudge sends first time', decideSend([], onceNudge?.maxEmailsPerLead ?? 1, onceNudge?.followUpDays ?? 0, seqNow).action, 'send')
check('sequence: a once-ever nudge never sends twice', decideSend([sentLog(seqNow, 1000)], onceNudge?.maxEmailsPerLead ?? 1, onceNudge?.followUpDays ?? 0, seqNow).reason, 'max_reached')

// --- the Zoho sync path must be MCP-first everywhere -------------------------
// The bug this guards: runNudge and the scheduler called syncLeadsFromCriteria (REST-ONLY) while
// /api/zoho/sync used syncLeads (MCP-first). So the Run button and every scheduled cycle bypassed
// the connected MCP server — contradicting the whole reason MCP was connected — and the moment the
// REST client credentials were rejected (`invalid_client_secret`) every nudge run failed to sync
// even though MCP was working. A source-level assertion is crude, but "which helper does the send
// path call" is a wiring decision that no unit test can see, and this is the second time the two
// paths have diverged.
const engineSource = readFileSync(new URL('../src/lib/nudge-engine.ts', import.meta.url), 'utf8')
const schedulerSource = readFileSync(new URL('../src/lib/scheduler.ts', import.meta.url), 'utf8')
const restHelperCalls = (src) => (src.match(/(?:await|=)\s*syncLeadsFromCriteria\s*\(/g) ?? []).length

check('the scheduler never calls the REST-only sync helper', restHelperCalls(schedulerSource), 0)
check('the scheduler imports the MCP-first sync', /import\s*\{[^}]*\bsyncLeads\b/.test(schedulerSource), true)
// In the engine, EVERY call to syncLeadsFromCriteria must be inside syncLeads() itself — its MCP
// fallback and its explicit via:'api' branch. Any call elsewhere means some other path silently
// went back to REST-only. Scoped to the function body so the definition and comments do not count.
const syncLeadsBody = engineSource.slice(
  engineSource.indexOf('export async function syncLeads('),
  engineSource.indexOf('export async function', engineSource.indexOf('export async function syncLeads(') + 10)
)
check('syncLeads is where the REST fallback lives', restHelperCalls(syncLeadsBody), 2)
check('no REST-only sync call exists outside syncLeads', restHelperCalls(engineSource) - restHelperCalls(syncLeadsBody), 0)
check('the engine also calls the MCP-first sync where it syncs a run', /syncLeads\(nudge\.zohoCriteria\.trim\(\)\)/.test(engineSource), true)
check('runNudge no longer syncs via the REST-only helper', /syncLeadsFromCriteria\(nudge\.zohoCriteria/.test(engineSource), false)
check('the run summary reports which path synced', /syncedVia/.test(engineSource), true)

// --- verify_csp: one query, two branches (Mobile then PAN) --------------------
// The n8n ran this query once and branched. The arm conditions below are exactly its If-nodes.
const vrow = (over) => ({
  Id: 1,
  csp_number: '9064995873',
  customer_id: null,
  requestAt: '2026-10-01 11:28:02',
  verifyAt: null,
  panNumber: null,
  ...over,
})
const pv = (rows) => partitionVerifyRows(rows)

// Branch 1 — verifyAt empty (null OR blank), exactly the n8n test.
check('verify: verifyAt null goes to the MOBILE branch', pv([vrow({ verifyAt: null }) ]).mobilePending.length, 1)
check('verify: verifyAt blank string also goes to the MOBILE branch', pv([vrow({ verifyAt: '   ' })]).mobilePending.length, 1)
check('verify: the mobile branch does not also fill the PAN branch', pv([vrow({ verifyAt: null })]).panPending.length, 0)
// Branch 2 — reached only when verifyAt is present.
check('verify: verified + pan null goes to the PAN branch', pv([vrow({ verifyAt: '2026-10-01 11:28:14', panNumber: null })]).panPending.length, 1)
check('verify: verified + pan blank also goes to the PAN branch', pv([vrow({ verifyAt: '2026-10-01 11:28:14', panNumber: '' })]).panPending.length, 1)
check('verify: the PAN branch does not also fill the mobile branch', pv([vrow({ verifyAt: '2026-10-01 11:28:14', panNumber: null })]).mobilePending.length, 0)
// Branch 3 — both present: do nothing.
check('verify: both present goes to NEITHER branch', pv([vrow({ verifyAt: '2026-10-01 11:28:14', panNumber: 'AUQPM3118F' })]).mobilePending.length + pv([vrow({ verifyAt: '2026-10-01 11:28:14', panNumber: 'AUQPM3118F' })]).panPending.length, 0)
// The user's own sample row.
const SAMPLE_ROW = vrow({ Id: 2647917, csp_number: '9064995873', mobile_verification_status: 2, verifyAt: '2026-10-01 11:28:14', panNumber: null })
check('verify: the supplied sample row branches to PAN', pv([SAMPLE_ROW]).panPending.length, 1)
check('verify: the supplied sample row does not branch to mobile', pv([SAMPLE_ROW]).mobilePending.length, 0)

// A row must never be classified into both arms.
const mixed = [
  vrow({ Id: 1, csp_number: 'A', verifyAt: null }),
  vrow({ Id: 2, csp_number: 'B', verifyAt: '2026-10-01 11:28:14', panNumber: null }),
  vrow({ Id: 3, csp_number: 'C', verifyAt: '2026-10-01 11:28:14', panNumber: 'AUQPM3118F' }),
  vrow({ Id: 4, csp_number: 'D', verifyAt: '2026-10-01 11:28:14', panNumber: '' }),
]
const split = pv(mixed)
check('verify: the two arms are row-exclusive', split.mobilePending.length + split.panPending.length <= mixed.length, true)
check('verify: only row A is mobile-pending', split.mobilePending.map((r) => r.phone).join(','), 'A')
check('verify: rows B and D are PAN-pending', split.panPending.map((r) => r.phone).join(','), 'B,D')
check('verify: row C (complete) reaches nobody', split.mobilePending.some((r) => r.phone === 'C') || split.panPending.some((r) => r.phone === 'C'), false)
// Recipients carry the mobile for the button parameter.
check('verify: the button parameter is the recipient mobile', split.mobilePending[0].buttonParam, 'A')
check('verify: the mobile arm declares no body params', JSON.stringify(split.mobilePending[0].params), '[]')
check('verify: the arms explain themselves', split.mobilePending[0].detail, 'verifyAt empty')
check('verify: the PAN arm explains itself', split.panPending[0].detail, 'panNumber empty after verifyAt')
// Keying prefers customer_id (the product's own id) and falls back to the phone.
check('verify: the key uses customer_id when present', pv([vrow({ customer_id: 4242 })]).mobilePending[0].key, 'csp:4242')
check('verify: the key falls back to the phone', pv([vrow({ customer_id: null })]).mobilePending[0].key, 'csp:9064995873')
check('verify: no rows means no arms', JSON.stringify(pv([])), JSON.stringify({ mobilePending: [], panPending: [] }))

// The look-back window: cadence-matched plus an overlap, so a late run cannot lose rows.
delete process.env.MYSQL_WINDOW_OVERLAP_MINUTES
check('window: the default overlap is 30 minutes', windowOverlapMinutes(), 30)
check('window: a 2h flow looks back 150 minutes', windowMinutesFor(2), 150)
check('window: a 3h flow looks back 210 minutes', windowMinutesFor(3), 210)
check('window: the overlap is configurable', (() => { process.env.MYSQL_WINDOW_OVERLAP_MINUTES = '90'; const v = windowMinutesFor(2); delete process.env.MYSQL_WINDOW_OVERLAP_MINUTES; return v })(), 210)
check('window: 0 overlap gives the literal n8n window', (() => { process.env.MYSQL_WINDOW_OVERLAP_MINUTES = '0'; const v = `${windowOverlapMinutes()}/${windowMinutesFor(2)}`; delete process.env.MYSQL_WINDOW_OVERLAP_MINUTES; return v })(), '0/120')
check('window: a nonsense overlap falls back to 30', (() => { process.env.MYSQL_WINDOW_OVERLAP_MINUTES = 'abc'; const v = windowOverlapMinutes(); delete process.env.MYSQL_WINDOW_OVERLAP_MINUTES; return v })(), 30)
check('window: a negative overlap falls back to 30', (() => { process.env.MYSQL_WINDOW_OVERLAP_MINUTES = '-5'; const v = windowOverlapMinutes(); delete process.env.MYSQL_WINDOW_OVERLAP_MINUTES; return v })(), 30)
check('window: a fractional lookback is rounded to whole minutes', windowMinutesFor(1.5), 90 + 30)

// --- per-flow cadence ("run every 2 hours") ----------------------------------
const cadNow = new Date('2026-10-01T12:00:00Z')
const hoursAgo = (h) => new Date(cadNow.getTime() - h * 60 * 60 * 1000)
check('cadence: no everyHours means inherit the tick', cadenceHoursOf({ filters: '{}' }), null)
check('cadence: everyHours is read', cadenceHoursOf({ filters: '{"everyHours":2}' }), 2)
check('cadence: an unparseable filter falls back to the tick', cadenceHoursOf({ filters: '{oops' }), null)
check('cadence: a zero interval means inherit the tick', cadenceHoursOf({ filters: '{"everyHours":0}' }), null)
check('cadence: a negative interval means inherit the tick', cadenceHoursOf({ filters: '{"everyHours":-3}' }), null)
check('cadence: a nudge that never ran is always due', cadenceDue({ filters: '{"everyHours":2}', lastRunAt: null }, cadNow).due, true)
check('cadence: no interval means always due', cadenceDue({ filters: '{}', lastRunAt: hoursAgo(0) }, cadNow).due, true)
// The 2-hour case the verify flows use.
check('cadence: 1h after a 2h run is NOT due', cadenceDue({ filters: '{"everyHours":2}', lastRunAt: hoursAgo(1) }, cadNow).due, false)
check('cadence: not-due reports how long is left', cadenceDue({ filters: '{"everyHours":2}', lastRunAt: hoursAgo(1) }, cadNow).reason, 'runs every 2h — last ran 2026-10-01 11:00, next in 60m')
check('cadence: 119m after a 2h run is NOT due', cadenceDue({ filters: '{"everyHours":2}', lastRunAt: new Date(cadNow.getTime() - 119 * 60000) }, cadNow).due, false)
check('cadence: exactly 2h after a run IS due', cadenceDue({ filters: '{"everyHours":2}', lastRunAt: hoursAgo(2) }, cadNow).due, true)
check('cadence: 3h after a run IS due', cadenceDue({ filters: '{"everyHours":2}', lastRunAt: hoursAgo(3) }, cadNow).due, true)
check('cadence: a 12h flow is not due after 2h', cadenceDue({ filters: '{"everyHours":12}', lastRunAt: hoursAgo(2) }, cadNow).due, false)
check('cadence: a 12h flow is due after 12h', cadenceDue({ filters: '{"everyHours":12}', lastRunAt: hoursAgo(12) }, cadNow).due, true)

// The two verify flows must carry the 2h cadence, and must share it: PAN is the second arm of the
// SAME query, so a different cadence would let it miss the rows the mobile arm just classified.
for (const key of ['mobile_otp_pending', 'pan_verification_pending']) {
  const f = JSON.parse(DEFAULT_NUDGES.find((n) => n.key === key)?.filters ?? '{}')
  check(`cadence: ${key} runs every 2h`, f.everyHours, 2)
  check(`cadence: ${key} declares its flow`, f.flow, key)
  check(`cadence: ${key} is a MySQL flow`, f.source, 'mysql')
  check(`cadence: ${key} has no Zoho criteria (database only)`, DEFAULT_NUDGES.find((n) => n.key === key)?.zohoCriteria, null)
}
check('cadence: only the verify pair uses 2h so far', DEFAULT_NUDGES.filter((n) => JSON.parse(n.filters || '{}').everyHours === 2).map((n) => n.key).sort().join(','), 'mobile_otp_pending,pan_verification_pending')

// --- running a paused nudge once (the "Fetch & Send" button) ------------------
// `enabled` governs the automatic paths; an operator clicking a button that names the audience has
// made the decision explicitly. force must be asked for, must NOT enable the nudge, and must be
// reported back so a send from a nudge that is "off" is never invisible.
check('run: an enabled nudge runs without force', runGuard({ enabled: true }).ok, true)
check('run: an enabled nudge is not flagged as forced', runGuard({ enabled: true }).forced, false)
check('run: a disabled nudge is refused by default', runGuard({ enabled: false }).ok, false)
check('run: the refusal says how to proceed', /force/i.test(runGuard({ enabled: false }).error), true)
check('run: a disabled nudge runs when force is asked for', runGuard({ enabled: false }, true).ok, true)
check('run: the forced run is flagged', runGuard({ enabled: false }, true).forced, true)
check('run: force is not truthy-coerced from junk', runGuard({ enabled: false }, 0).ok, false)
// Both Documents-Pending nudges ship disabled, which is exactly the case this feature exists for.
for (const key of ['documents_pending_wa', 'documents_submitted_review']) {
  const n = DEFAULT_NUDGES.find((x) => x.key === key)
  check(`run: ${key} ships disabled (so the one-off button is the way to send it)`, n?.enabled, false)
  check(`run: ${key} is refusable without force`, runGuard({ enabled: n?.enabled ?? false }).ok, false)
  check(`run: ${key} is runnable with force`, runGuard({ enabled: n?.enabled ?? false }, true).ok, true)
  check(`run: ${key} is fetch-driven (has a Zoho criteria to fetch with)`, Boolean(n?.zohoCriteria), true)
}

// --- V2: engagement scoring ---------------------------------------------------
// The model is from the V2 document; each weight and each cap is pinned so a "tidy-up" of the
// numbers cannot silently change what every stored score means.
const jlog = (over = {}) => ({
  id: 'log-1',
  nudgeId: 'nudge-1',
  channel: 'whatsapp',
  messageNumber: 1,
  sentOk: true,
  sentAt: new Date('2026-10-01T10:00:00Z'),
  opened: false,
  replied: false,
  ctaClicks: 0,
  ctaClickedAt: null,
  ...over,
})

check('score: nothing sent scores 0', computeScore([], 0).score, 0)
check('score: nothing sent is Cold', computeScore([], 0).band, 'cold')
check('score: one WhatsApp send is +2', computeScore([jlog()], 0).score, 2)
check('score: one email send is +1', computeScore([jlog({ channel: 'email' })], 0).score, 1)
// The WhatsApp send cap: being sent to repeatedly is not engagement.
check('score: 5 WhatsApp sends hit the +10 cap', computeScore(Array.from({ length: 5 }, (_, i) => jlog({ id: `l${i}` })), 0).score, 10)
check('score: 20 WhatsApp sends still cap at +10', computeScore(Array.from({ length: 20 }, (_, i) => jlog({ id: `l${i}` })), 0).score, 10)
check('score: the cap is per-channel, email still adds', computeScore([...Array.from({ length: 20 }, (_, i) => jlog({ id: `w${i}` })), jlog({ id: 'e1', channel: 'email' })], 0).score, 11)
check('score: an open is +5', computeScore([jlog({ opened: true })], 0).score, 7)
check('score: two opens are +10', computeScore([jlog({ id: 'a', opened: true }), jlog({ id: 'b', opened: true })], 0).score, 14)
check('score: a reply is +15, once', computeScore([jlog({ replied: true })], 0).score, 17)
check('score: two replies still +15', computeScore([jlog({ id: 'a', replied: true }), jlog({ id: 'b', replied: true })], 0).score, 19)
check('score: a CTA click is +20', computeScore([jlog({ ctaClicks: 1, ctaClickedAt: new Date() })], 0).score, 22)
check('score: 2+ CTA taps add the +10 bonus', computeScore([jlog({ ctaClicks: 2, ctaClickedAt: new Date() })], 0).score, 32)
check('score: a stage change is +25', computeScore([], 1).score, 25)
check('score: no stage change is +0', computeScore([], 0).breakdown.statusChanged, 0)
// A failed send reached nobody, so it earns nothing.
check('score: a failed send earns nothing', computeScore([jlog({ sentOk: false })], 0).score, 0)
check('score: a failed send is not counted', computeScore([jlog({ sentOk: false })], 0).counts.whatsappSent, 0)
// Everything at once: 5 sends (hits the +10 send cap), all opened (+25), a reply (+15), a CTA
// click (+20) with the repeat bonus (+10) and a stage change (+25) = 105 raw, clamped to 100.
const maxed = [
  jlog({ id: 'a', opened: true, replied: true, ctaClicks: 3, ctaClickedAt: new Date() }),
  jlog({ id: 'b', opened: true }),
  jlog({ id: 'c', opened: true }),
  jlog({ id: 'd', opened: true }),
  jlog({ id: 'e', opened: true }),
]
const everything = computeScore(maxed, 1)
check('score: the raw total exceeds the cap', Object.values(everything.breakdown).reduce((a, b) => a + b, 0), 105)
check('score: the total is clamped to the max', everything.score, 100)
check('score: the clamp is reported', everything.capped, true)
check('score: the breakdown still shows the raw points', everything.breakdown.ctaRepeatBonus, 10)
check('score: a lowered max clamps lower', computeScore([], 1, { max: 20 }).score, 20)
check('score: a raised max is honoured', computeScore([jlog({ opened: true, replied: true })], 0, { max: 500 }).score, 22)
// The stored breakdown must round-trip: the drawer reads it as JSON.
check('score: the breakdown serialises', typeof JSON.stringify(computeScore([jlog()], 0).breakdown), 'string')
check('score: the breakdown has every signal', Object.keys(computeScore([], 0).breakdown).sort().join(','), 'ctaClicked,ctaRepeatBonus,emailSent,opened,replied,statusChanged,whatsappSent')

// Bands — the thresholds are absolute, and the API's band FILTER must agree with them or
// filtering by band would return a different set than the badges show.
check('band: 0 is Cold', scoreBand(0), 'cold')
check('band: 20 is Cold', scoreBand(20), 'cold')
check('band: 21 is Warming', scoreBand(21), 'warming')
check('band: 45 is Warming', scoreBand(45), 'warming')
check('band: 46 is Engaged', scoreBand(46), 'engaged')
check('band: 70 is Engaged', scoreBand(70), 'engaged')
check('band: 71 is Hot', scoreBand(71), 'hot')
check('band: 100 is Hot', scoreBand(100), 'hot')
check('band: every band has a label', Object.keys(SCORE_BAND_LABEL).sort().join(','), 'cold,engaged,hot,warming')
check('band: the weights match the document', JSON.stringify(SCORE_WEIGHTS), JSON.stringify({ whatsappSent: 2, whatsappSentCap: 10, emailSent: 1, opened: 5, replied: 15, ctaClicked: 20, ctaRepeatBonus: 10, ctaRepeatThreshold: 2, statusChanged: 25 }))

// --- V2: attribution ----------------------------------------------------------
const detected = new Date('2026-10-04T10:00:00Z')
const within = jlog({ id: 'recent', sentAt: new Date('2026-10-03T10:00:00Z') }) // 24h before
const outside = jlog({ id: 'old', sentAt: new Date('2026-09-20T10:00:00Z') }) // way outside
check('attribution: the only recent send is credited', pickAttribution([within], detected, 72)?.messageLogId, 'recent')
check('attribution: a send outside the window is not credited', pickAttribution([outside], detected, 72), null)
check('attribution: no sends means nobody is credited', pickAttribution([], detected, 72), null)
check('attribution: a failed send is never credited', pickAttribution([{ ...within, sentOk: false }], detected, 72), null)
check('attribution: a send with no sentAt cannot be credited', pickAttribution([{ ...within, sentAt: null }], detected, 72), null)
// The MOST RECENT qualifying send wins, not the first one found.
const twoSends = [jlog({ id: 'far', sentAt: new Date('2026-10-01T10:00:00Z') }), jlog({ id: 'near', sentAt: new Date('2026-10-04T06:00:00Z') })]
check('attribution: the most recent send wins', pickAttribution(twoSends, detected, 72)?.messageLogId, 'near')
check('attribution: hours since the send is measured', pickAttribution([within], detected, 72)?.hoursSinceNudge, 24)
check('attribution: the message number is carried for the report', pickAttribution([jlog({ id: 'm3', messageNumber: 3, sentAt: new Date('2026-10-04T09:00:00Z') })], detected, 72)?.messageNumber, 3)
// A send AFTER the change cannot have caused it.
check('attribution: a later send is not credited', pickAttribution([jlog({ id: 'later', sentAt: new Date('2026-10-05T10:00:00Z') })], detected, 72), null)
// The window is a parameter, so the env default is testable separately.
check('attribution: a wider window credits an older send', pickAttribution([outside], detected, 24 * 60)?.messageLogId, 'old')
check('attribution: the default window is 72h', attributionWindowHours(), 72)

// --- V2: time maths -----------------------------------------------------------
check('time: hours in the previous stage', timeInPrevStageHours(new Date('2026-10-01T10:00:00Z'), detected), 72)
check('time: no prior timestamp means null, not zero', timeInPrevStageHours(null, detected), null)
check('time: a backwards clock yields null rather than a negative', timeInPrevStageHours(new Date('2026-10-05T10:00:00Z'), detected), null)
check('time: days between two instants', daysBetween(new Date('2026-10-01T10:00:00Z'), new Date('2026-10-09T10:00:00Z')), 8)
check('time: days with no first nudge is null', daysBetween(null, detected), null)
check('days: a change before the first nudge is null, not negative', daysBetween(new Date('2026-10-05T10:00:00Z'), detected), null)
check('converted: the default converted status is Closed Won', isConvertedStatus('Closed Won'), true)
check('converted: a non-converted status is false', isConvertedStatus('Agreement Signed'), false)
check('converted: null is false', isConvertedStatus(null), false)

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
  ctaUrl: null,
  ctaClicks: 0,
  ctaClickedAt: null,
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
// Looked up BY NAME, not by index: inserting a column (the CTA ones) silently shifted every
// fixed index after it and broke these assertions once already.
const col = (name) => {
  const i = EXPORT_COLUMNS.indexOf(name)
  if (i < 0) throw new Error(`no export column named "${name}"`)
  return i
}
check('a failed row carries a plain-English reason', failedRow[col('Failure reason')], 'provider error')
checkTrue('a failed row explains the cause', String(failedRow[col('Failure explained')]).length > 20)
check('a failed row keeps the raw error', failedRow[col('Error detail')], 'Zoho Mail API: Internal Error (code 500)')
check('a CTA click is recorded as a column', failedRow[col('CTA clicked')], 'no')

// The two channels have separate translators, and WhatsApp's returns null for text it does not
// recognise, so the row falls back to a generic label rather than showing a blank reason.
const unknownWaRow = logToExportRow(baseLog({ sentOk: false, sendError: 'something nobody has seen before' }))
check('an unrecognised WhatsApp error still gets a label', unknownWaRow[col('Failure reason')], 'unrecognised')
const unknownMailRow = logToExportRow(
  baseLog({ sentOk: false, channel: 'email', toEmail: 'a@b.c', sendError: 'something nobody has seen before' })
)
check('an unrecognised email error gets the mail fallback label', unknownMailRow[col('Failure reason')], 'send failed')

const noErrorRow = logToExportRow(baseLog())
check('a successful row has no failure reason', noErrorRow[col('Failure reason')], '')
check('a successful row has no error detail', noErrorRow[col('Error detail')], '')

// A row that WAS clicked must say so, and carry the link the customer was given.
const clickedRow = logToExportRow(
  baseLog({ ctaUrl: 'https://eps.eko.in/console?mobile=9876543210', ctaClicks: 2, ctaClickedAt: new Date('2026-09-23T09:00:00Z') })
)
check('a clicked row says yes', clickedRow[col('CTA clicked')], 'yes')
check('a clicked row carries the count as a number', clickedRow[col('CTA clicks')], 2)
check('a clicked row carries the first-click time in IST', clickedRow[col('CTA clicked at (IST)')], '2026-09-23 14:30:00')
check('a clicked row carries the destination link', clickedRow[col('CTA link')], 'https://eps.eko.in/console?mobile=9876543210')

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
checkTrue('the export has a column for CTA clicks', EXPORT_COLUMNS.includes('CTA clicks'))
check('the export has one width per column', EXPORT_WIDTHS.length, EXPORT_COLUMNS.length)
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
  'documents_pending_wa (lead-driven) still allows repeats — it is a daily reminder, not a one-off',
  DEFAULT_NUDGES.find((n) => n.key === 'documents_pending_wa')?.maxEmailsPerLead === 7
)

// --- WhatsApp CTA click tracking ----------------------------------------------
// Meta does not webhook URL-button clicks, so the button has to route through this app. The
// mechanics below are what make that safe: a stable destination, a token instead of a URL, and
// a redirect that can never strand the customer.
delete process.env.CTA_TRACK_BASE_URL
check('tracking is off by default', isCtaTrackingEnabled(), false)
check('with tracking off the button param is the mobile', ctaButtonParam({ token: 'abc', mobileDigits: '9876543210' }), '9876543210')
check(
  'with tracking off the destination is the direct link',
  buildCtaUrl({ destination: 'https://eps.eko.in/console?mobile=9876543210', token: 'abc' }),
  'https://eps.eko.in/console?mobile=9876543210'
)

process.env.CTA_TRACK_BASE_URL = 'https://app.test/api/track/cta/'
check('a trailing slash is tolerated', ctaTrackBaseUrl(), 'https://app.test/api/track/cta')
check('tracking turns on', isCtaTrackingEnabled(), true)
// The CRM status nudge's tracked template must go through the tracker once one is configured —
// otherwise its button points straight at the console and the click is never attributable.
check('review tracked template button goes through the tracker', templateButtonUrlFor('documents_submitted_review_cta'), `${ctaTrackBaseUrl()}/{{1}}`)
check('with tracking on the button param is the token', ctaButtonParam({ token: 'abc-123', mobileDigits: '9876543210' }), 'abc-123')
check(
  'with tracking on the button points at the tracker',
  buildCtaUrl({ destination: 'https://eps.eko.in/console?mobile=9876543210', token: 'abc-123' }),
  'https://app.test/api/track/cta/abc-123'
)

// The destination is built from the template's own button URL, so a tracked link lands in
// exactly the same place the untracked one would have.
check(
  'the stored destination fills in the mobile',
  ctaDestinationFor('activation_fee_pending_transacting', '9876543210'),
  'https://eps.eko.in/console/pay-activation-fee?mobile=9876543210'
)
check(
  'a console-flow template points at the console',
  ctaDestinationFor('csp_details_pending_reminder', '9876543210'),
  'https://eps.eko.in/console?mobile=9876543210'
)
check('a template with no button has no destination', ctaDestinationFor('documents_pending_reminder', '9876543210'), null)
check('an unknown template has no destination', ctaDestinationFor('nope', '9876543210'), null)
check('the button URL lookup agrees with the destination', whatsappButtonUrlFor('mobile_otp_pending'), 'https://eps.eko.in/console?mobile={{1}}')

// ctaSendParams must be a strict no-op when tracking is off, or it would change what we send
// against templates Meta has already approved.
process.env.CTA_TRACK_BASE_URL = ''
const offParams = ctaSendParams({
  destination: 'https://eps.eko.in/console?mobile=1',
  trackingId: 'tok',
  mobileDigits: '1',
  configured: ['mobile_digits'],
})
check('tracking off: configured button params pass through untouched', offParams.buttonParams.join(','), 'mobile_digits')
check('tracking off: the destination is still recorded', offParams.ctaUrl, 'https://eps.eko.in/console?mobile=1')

process.env.CTA_TRACK_BASE_URL = 'https://app.test/api/track/cta'
const onParams = ctaSendParams({
  templateName: 'activation_fee_pending_transacting_cta',
  destination: 'https://eps.eko.in/console?mobile=1',
  trackingId: 'tok-1',
  mobileDigits: '1',
  configured: ['mobile_digits'],
})
check('a tracked template sends the TOKEN as the button param', onParams.buttonParams.join(','), 'tok-1')
check('a tracked template stores the destination', onParams.ctaUrl, 'https://eps.eko.in/console?mobile=1')
// The template decides this, not the env var — the button URL lives inside the approved template,
// so sending the mobile where a token belongs would send the customer to the fallback page.
process.env.CTA_TRACK_BASE_URL = ''
const onParamsNoEnv = ctaSendParams({
  templateName: 'activation_fee_pending_transacting_cta',
  destination: 'https://eps.eko.in/console?mobile=1',
  trackingId: 'tok-2',
  mobileDigits: '1',
  configured: ['mobile_digits'],
})
check('a tracked template sends the token even with the env var unset', onParamsNoEnv.buttonParams.join(','), 'tok-2')
// …and an UNtracked template keeps the configured params, even with the env var set.
process.env.CTA_TRACK_BASE_URL = 'https://app.test/api/track/cta'
const untrackedParams = ctaSendParams({
  templateName: 'activation_fee_pending_transacting',
  destination: 'https://eps.eko.in/console?mobile=1',
  trackingId: 'tok-3',
  mobileDigits: '9876543210',
  configured: ['mobile_digits'],
})
check('an untracked template keeps the configured button param', untrackedParams.buttonParams.join(','), 'mobile_digits')
check('an untracked template has no fallback', untrackedParams.fallback === undefined, true)
// A tracked template must offer the untracked original as a fallback, or pointing a live nudge at
// a template Meta has not approved yet would break its sends.
check('a tracked template offers its base template as a fallback', onParams.fallback?.templateName, 'activation_fee_pending_transacting')
check('the fallback carries the MOBILE, not the token', onParams.fallback?.buttonParams.join(','), 'mobile_digits')

const noButton = ctaSendParams({ destination: null, trackingId: 'tok', mobileDigits: '1', configured: [] })
check('a template with no button stores no destination', JSON.stringify(noButton), JSON.stringify({ buttonParams: [], ctaUrl: null }))

// The fallback must always resolve to something real — a customer tapping Pay Now must never
// land on an error page.
delete process.env.CTA_FALLBACK_URL
check('a missing destination falls back to the console', resolveCtaDestination(null), 'https://eps.eko.in/console')
check('an empty destination falls back too', resolveCtaDestination('   '), 'https://eps.eko.in/console')
check('a real destination is used as-is', resolveCtaDestination('https://eps.eko.in/console?mobile=9'), 'https://eps.eko.in/console?mobile=9')

check('A UUID is a plausible token', isPlausibleCtaToken('ced9dbf2-b6bb-48c5-86e6-d82c96aab559'), true)
check('junk is rejected before touching the database', isPlausibleCtaToken('../../etc/passwd'), false)
check('an empty token is rejected', isPlausibleCtaToken(''), false)

// --- tracked (_cta) template naming --------------------------------------------
// The suffix is how a tracked template is recognised in the Templates tab, in a nudge row and in
// a log row — and how the send path knows to put a TOKEN in the button rather than a mobile.
check('the suffix is _cta', CTA_TEMPLATE_SUFFIX, '_cta')
check('a tracked name is recognised', isTrackedTemplate('mobile_otp_pending_cta'), true)
check('an untracked name is not', isTrackedTemplate('mobile_otp_pending'), false)
check('a null name is not tracked', isTrackedTemplate(null), false)
check('the base name strips the suffix', baseTemplateName('mobile_otp_pending_cta'), 'mobile_otp_pending')
check('the base of a base name is itself', baseTemplateName('mobile_otp_pending'), 'mobile_otp_pending')
check('appending is idempotent', trackedTemplateName('x_cta'), 'x_cta')
check('appending once gives the tracked name', trackedTemplateName('x'), 'x_cta')

// A tracked template resolves to its BASE template's destination — the tracker forwards there.
check('a tracked name resolves to the console destination', ctaDestinationFor('mobile_otp_pending_cta', '9876543210'), 'https://eps.eko.in/console?mobile=9876543210')
check('a tracked name resolves to the pay destination', ctaDestinationFor('activation_fee_pending_transacting_cta', '9876543210'), 'https://eps.eko.in/console/pay-activation-fee?mobile=9876543210')
check('the button URL of a tracked template is the tracker', templateButtonUrlFor('mobile_otp_pending_cta'), 'https://app.test/api/track/cta/{{1}}')
check('the button URL of an untracked template is the destination', templateButtonUrlFor('mobile_otp_pending'), 'https://eps.eko.in/console?mobile={{1}}')
check('a template with no button has no tracked variant', templateHasButton('ip_whitelisting_mandatory'), false)
checkTrue('a console template has a button', templateHasButton('mobile_otp_pending'))

// Which nudges ended up on tracked templates: everything with a button, nothing without.
const waNudges = DEFAULT_NUDGES.filter((n) => n.channel === 'whatsapp' && n.whatsappTemplateName)
const shouldTrack = waNudges.filter((n) => templateHasButton(n.whatsappTemplateName))
check('every button template is tracked', shouldTrack.every((n) => isTrackedTemplate(n.whatsappTemplateName)), true)
check('templates without a button stay untracked', waNudges.filter((n) => !templateHasButton(n.whatsappTemplateName)).every((n) => !isTrackedTemplate(n.whatsappTemplateName)), true)
check('9 templates are tracked', shouldTrack.length, 9)
// The retired MARKETING templates must not be resurrected by this change.
check(
  'no nudge points at a retired MARKETING template',
  waNudges.filter((n) => Object.values(WA_RETIRED_MARKETING_TEMPLATES).includes(baseTemplateName(n.whatsappTemplateName))).length,
  0
)

// --- the send fallback ----------------------------------------------------------
// Without this, pointing a live nudge at a template Meta has not approved yet would break its
// sends with 132001. The fallback keeps the message going out (untracked) until approval lands.
checkTrue('132001 is recognised as an unavailable template', isTemplateUnavailable('WhatsApp API: template does not exist (code 132001)'))
checkTrue('the wording without a code is recognised', isTemplateUnavailable('Template name does not exist in the translation'))
checkTrue('template does not exist is recognised', isTemplateUnavailable('template does not exist'))
check('a parameter mismatch is NOT an unavailable template', isTemplateUnavailable('number of parameters does not match (code 132000)'), false)
check('an auth error is NOT an unavailable template', isTemplateUnavailable('Invalid OAuth access token (code 190)'), false)
check('null is safe', isTemplateUnavailable(null), false)

// --- Meta template analytics (button clicks) -----------------------------------
// Meta is the only place a URL-button tap is recorded, so this is how "did anyone click" is
// answered without touching a template. Two measured traps are encoded here.
check('ids are chunked to respect Meta\'s limit', JSON.stringify(chunkTemplateIds(Array.from({ length: 11 }, (_, i) => `t${i}`)).map((c) => c.length)), '[10,1]')
check('chunking an exact multiple makes no empty chunk', JSON.stringify(chunkTemplateIds(['a', 'b', 'c', 'd'], 2).map((c) => c.length)), '[2,2]')
check('chunking nothing yields nothing', chunkTemplateIds([]).length, 0)
check('the per-request id limit is 10', ANALYTICS_TEMPLATE_ID_LIMIT, 10)
// Meta truncates a response at ~25 points and SILENTLY drops the rest (ids=5+ returned zeros for
// templates that report data at ids=2). So one template per request, and a window that fits.
check('the response point cap is 25', ANALYTICS_MAX_DATA_POINTS, 25)
check('the window is capped below the point cap', ANALYTICS_MAX_DAYS, 23)
checkTrue('a 30-day window would be refused by the cap', 30 > ANALYTICS_MAX_DAYS)

const analyticsAcc = new Map()
mergeAnalyticsResponse(analyticsAcc, 'CLICKED', {
  data: [
    {
      data_points: [
        {
          template_id: 'T1',
          start: Date.parse('2026-09-28T00:00:00Z') / 1000,
          end: Date.parse('2026-09-29T00:00:00Z') / 1000,
          clicked: [
            { type: 'url_button', button_content: 'Pay Now', count: 6 },
            { type: 'unique_url_button', button_content: 'Pay Now', count: 5 },
          ],
        },
      ],
    },
  ],
})
mergeAnalyticsResponse(analyticsAcc, 'SENT', {
  data: [
    {
      data_points: [
        { template_id: 'T1', start: Date.parse('2026-09-28T00:00:00Z') / 1000, end: 0, sent: 55, delivered: 52, read: 40 },
      ],
    },
  ],
})
const analyticsRow = toSortedRows(analyticsAcc)[0]
check('clicks are read from url_button', analyticsRow.clicks, 6)
check('unique clicks are NOT added to total clicks', analyticsRow.uniqueClicks, 5)
check('the button label is captured', analyticsRow.buttonLabels.join(','), 'Pay Now')
check('sent is merged from a separate call', analyticsRow.sent, 55)
check('the day is bucketed from start', analyticsRow.day, '2026-09-28')
// The same template/day across metrics must merge into ONE row, not two.
check('two metrics for one template/day produce one row', toSortedRows(analyticsAcc).length, 1)

const emptyAcc = new Map()
mergeAnalyticsResponse(emptyAcc, 'CLICKED', { data: [] })
check('an empty response adds nothing', emptyAcc.size, 0)

// --- Meta Conversions API ------------------------------------------------------
// Identifiers must be hashed, and the normalisation is the part that fails silently: a wrong
// country code produces a valid request that matches nobody.
check('phone hashing adds the country code to a bare 10-digit number', normalisePhoneForHashing('9876543210'), '919876543210')
check('phone hashing strips a plus', normalisePhoneForHashing('+919876543210'), '919876543210')
check('phone hashing strips spaces and dashes', normalisePhoneForHashing('+91 98765-43210'), '919876543210')
check('phone hashing strips a trunk zero', normalisePhoneForHashing('09876543210'), '919876543210')
check('phone hashing keeps an existing country code', normalisePhoneForHashing('919876543210'), '919876543210')
check('phone hashing of junk is empty', normalisePhoneForHashing('n/a'), '')
check('email hashing lowercases', normaliseEmailForHashing('  A@B.COM '), 'a@b.com')
check('sha256 matches the known vector', sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')

const capiEvent = buildConversionEvent({
  eventName: 'CTA_Click',
  phone: '9876543210',
  email: 'A@B.com',
  ctwaClid: 'clid-123',
  eventId: 'tid-1',
  eventTime: new Date('2026-09-24T06:00:00Z'),
})
check('the event name is carried', capiEvent.event_name, 'CTA_Click')
check('event_time is unix SECONDS, not milliseconds', capiEvent.event_time, Math.floor(new Date('2026-09-24T06:00:00Z').getTime() / 1000))
check('action_source is business_messaging', capiEvent.action_source, 'business_messaging')
check('messaging_channel is whatsapp', capiEvent.messaging_channel, 'whatsapp')
check('the phone is hashed, never raw', capiEvent.user_data.ph[0], sha256Hex('919876543210'))
check('the email is hashed lowercase', capiEvent.user_data.em[0], sha256Hex('a@b.com'))
check('ctwa_clid passes through UNhashed (Meta issues it as an opaque id)', capiEvent.user_data.ctwa_clid, 'clid-123')
check('event_id is carried so a repeat click dedupes', capiEvent.event_id, 'tid-1')
check('no raw phone number leaks into the payload', JSON.stringify(capiEvent).includes('9876543210'), false)
check('the raw email does not leak either', JSON.stringify(capiEvent).includes('A@B.com'), false)

const bare = buildConversionEvent({ eventName: 'Lead', phone: null, email: null })
check('absent identifiers are omitted, not sent empty', JSON.stringify(bare.user_data), '{}')
check('no custom_data without a value', bare.custom_data === undefined, true)
const valued = buildConversionEvent({ eventName: 'Purchase', phone: '9876543210', value: 999, currency: 'INR' })
check('a value produces custom_data', `${valued.custom_data.value}/${valued.custom_data.currency}`, '999/INR')

console.log(
  `\n${total - failures}/${total} assertions passed` +
    (failures === 0 ? ' — all checks passed.' : ` — ${failures} check(s) FAILED.`)
)
process.exit(failures === 0 ? 0 : 1)

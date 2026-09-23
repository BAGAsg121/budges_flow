/**
 * Test the Meta WhatsApp webhook — exactly the requests Meta itself makes.
 *
 *   node --env-file=.env scripts/check-whatsapp-webhook.mjs [baseUrl]
 *   # default baseUrl: APP_BASE_URL, else https://nudge-engine.onrender.com
 *
 * Checks:
 *   1. GET  /api/health                      (is the service awake and on the new build?)
 *   2. GET  /api/track/whatsapp?hub.*        (Meta's verification handshake — must echo hub.challenge)
 *   3. GET  ... with a WRONG token           (must be rejected with 403)
 *
 * This is the same handshake Meta performs when you click "Verify and save".
 *
 * NOTE: on a host that sleeps, wake the service first — Meta gives up quickly and a cold
 * start will look like a verification failure.
 *
 * Extra args:
 *   --token <value>   override WHATSAPP_VERIFY_TOKEN (e.g. to test an old/production value)
 *   --post            also POST a synthetic signed status event (needs WHATSAPP_APP_SECRET)
 */
import { createHmac } from 'crypto'

const args = process.argv.slice(2)
const tokenIdx = args.indexOf('--token')
const overrideToken = tokenIdx >= 0 ? args[tokenIdx + 1] : null
const positional = args.filter((a, i) => !a.startsWith('--') && !(tokenIdx >= 0 && i === tokenIdx + 1))
const doPost = args.includes('--post')

const baseUrl = (positional[0] || process.env.APP_BASE_URL || 'https://nudge-engine.onrender.com').replace(/\/+$/, '')
const verifyToken = overrideToken || process.env.WHATSAPP_VERIFY_TOKEN || ''
const challenge = `challenge-${Date.now()}`

console.log(`Base URL      ${baseUrl}`)
console.log(`Verify token  ${verifyToken ? verifyToken.slice(0, 6) + '…' : '(EMPTY — set WHATSAPP_VERIFY_TOKEN)'}`)
console.log(`Callback URL  ${baseUrl}/api/track/whatsapp\n`)

async function get(path, timeoutMs = 90_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl}${path}`, { signal: controller.signal, redirect: 'manual' })
    return { status: res.status, body: await res.text() }
  } catch (err) {
    return { status: 0, body: '', error: err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message }
  } finally {
    clearTimeout(timer)
  }
}

let failures = 0

// 1. liveness / which build
const health = await get('/api/health')
if (health.status === 200) {
  console.log(`✅ /api/health        200  ${health.body.slice(0, 120)}`)
  console.log('   → the NEW build is deployed (this route only exists in it)')
} else if (health.status === 404) {
  console.log(`⚠️  /api/health        ${health.status}  (route missing → the OLD build is still deployed)`)
} else {
  console.log(`❌ /api/health        ${health.status || 'no response'}${health.error ? ` — ${health.error}` : ''}`)
  console.log('   → the service may be asleep or down. Load it in a browser, wait ~60s, retry.')
  failures++
}

// 2. the handshake Meta performs on "Verify and save"
if (!verifyToken) {
  console.log('❌ handshake skipped  — WHATSAPP_VERIFY_TOKEN is empty locally')
  failures++
} else {
  const qs = `?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${encodeURIComponent(challenge)}`
  const hs = await get(`/api/track/whatsapp${qs}`)
  if (hs.status === 200 && hs.body.trim() === challenge) {
    console.log(`✅ handshake          200  echoed the challenge correctly`)
  } else if (hs.status === 403) {
    console.log(`❌ handshake          403  — the token does not match the one the server has`)
    console.log('   → set WHATSAPP_VERIFY_TOKEN in the host env (Render → Environment) to the same value')
    failures++
  } else {
    console.log(`❌ handshake          ${hs.status || 'no response'}${hs.error ? ` — ${hs.error}` : ''}  body: ${hs.body.slice(0, 120)}`)
    failures++
  }

  // 3. wrong token must be refused
  const bad = await get(`/api/track/whatsapp?hub.mode=subscribe&hub.verify_token=definitely-wrong&hub.challenge=${encodeURIComponent(challenge)}`)
  if (bad.status === 403) {
    console.log('✅ wrong token        403  (correctly refused)')
  } else {
    console.log(`❌ wrong token        ${bad.status || 'no response'}  — expected 403; anyone could subscribe the webhook`)
    failures++
  }
}

// 4. optional signed event POST
if (doPost) {
  const secret = process.env.WHATSAPP_APP_SECRET
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'test', changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.TEST', status: 'read' }] } }] }],
  })
  const headers = { 'Content-Type': 'application/json' }
  if (secret) headers['X-Hub-Signature-256'] = 'sha256=' + createHmac('sha256', secret).update(payload, 'utf8').digest('hex')
  try {
    const res = await fetch(`${baseUrl}/api/track/whatsapp`, { method: 'POST', headers, body: payload })
    console.log(`${res.ok ? '✅' : '❌'} POST event          ${res.status}  ${(await res.text()).slice(0, 80)}`)
    if (!res.ok) failures++
  } catch (err) {
    console.log(`❌ POST event          failed — ${err.message}`)
    failures++
  }
}

console.log(
  failures === 0
    ? '\nAll checks passed — you can paste this callback URL and verify token into Meta.'
    : `\n${failures} check(s) failed.`
)
process.exit(failures === 0 ? 0 : 1)

/**
 * WhatsApp connectivity check + test send.
 *
 *   node --env-file=.env scripts/check-whatsapp.mjs [phone] [message]
 *   node --env-file=.env scripts/check-whatsapp.mjs --template <name> [phone]
 *   # default phone: 9643520034 (the test lead's number)
 *
 * Validates the shape of the credentials, then actually sends one message and prints
 * Meta's raw response. Works without the web server running.
 *
 * Without --template this sends FREE-FORM TEXT, which Meta only allows inside the 24h
 * customer service window (the recipient messaged you first) or to a registered test
 * number. Business-initiated nudges need an approved template.
 *
 * Note: results are reported via process.exitCode and the process is allowed to drain
 * naturally — calling process.exit() while fetch sockets are open trips a libuv
 * assertion on Windows ("!(handle->flags & UV_HANDLE_CLOSING)").
 */
const args = process.argv.slice(2)

/** Read the value of a `--flag value` pair. */
function flagValue(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}

const templateName = flagValue('--template')
const wantTemplateList = args.includes('--list-templates')
// Meta matches templates by name AND language code exactly. A template approved as
// `en_US` will NOT send when the request asks for `en` — it fails with error 132001,
// which reads like the template is missing. Always check with --list-templates.
const language = flagValue('--lang') || process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en'

// Positional args are everything that is not a flag and not a flag's value.
const valueFlags = ['--template', '--lang']
const valueIdxs = new Set()
for (const f of valueFlags) {
  const i = args.indexOf(f)
  if (i >= 0) valueIdxs.add(i + 1)
}
const positional = args.filter((a, i) => !a.startsWith('--') && !valueIdxs.has(i))

const rawTo = positional[0] || '9643520034'
const text =
  positional.slice(1).join(' ') ||
  'Nudge Engine test message — if you received this, the WhatsApp integration is working.'

function digits(raw) {
  let d = String(raw).replace(/\D/g, '').replace(/^0+/, '')
  if (d.length === 10) d = (process.env.WHATSAPP_DEFAULT_CC || '91') + d
  return d
}

async function postMessage({ token, phoneNumberId, version, to, templateName, text, language }) {
  const payload = templateName
    ? {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: { name: templateName, language: { code: language || 'en' } },
      }
    : {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: text },
      }

  const res = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: res.status, ok: res.ok, data: await res.json().catch(() => ({})) }
}

/** List the message templates on the WABA with their exact name + language code. */
async function listTemplates({ token, wabaId, version }) {
  if (!wabaId) {
    console.log('WHATSAPP_WABA_ID is not set — cannot list templates.')
    return false
  }
  const res = await fetch(
    `https://graph.facebook.com/${version}/${wabaId}/message_templates?fields=name,status,language,category&limit=100&access_token=${encodeURIComponent(token)}`
  )
  const data = await res.json().catch(() => ({}))
  if (data.error) {
    console.log('Could not list templates:', JSON.stringify(data.error))
    return false
  }
  const list = data.data || []
  console.log(`\nMessage templates on WABA ${wabaId} (${list.length}):`)
  if (!list.length) {
    console.log('  none — create one in WhatsApp Manager → Account tools → Message templates')
    return true
  }
  for (const t of list) {
    console.log(`  ${t.name}  ·  language "${t.language}"  ·  ${t.status}  ·  ${t.category}`)
  }
  console.log('\nUse the EXACT name and language, e.g.  npm run wa:check -- --template NAME --lang ' + list[0].language)
  console.log('Put the same values in the nudge\'s "Meta template name" and "Template language".')
  return true
}

/** Ask Meta what this token is and when it dies. Never throws. */
async function debugToken(token, version) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${version}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`
    )
    const data = await res.json()
    if (data?.data?.is_valid === false) return { invalid: true, error: data?.data?.error?.message }
    return data?.data ?? null
  } catch (err) {
    return { error: err.message }
  }
}

function describeExpiry(info) {
  if (!info) return null
  if (!info.expires_at) return { text: 'never expires', warn: false }
  const msLeft = info.expires_at * 1000 - Date.now()
  const hoursLeft = msLeft / 3_600_000
  const when = new Date(info.expires_at * 1000).toISOString()
  if (hoursLeft <= 0) return { text: `EXPIRED at ${when}`, warn: true }
  if (hoursLeft < 24) return { text: `expires in ${hoursLeft.toFixed(1)}h (at ${when})`, warn: true }
  return { text: `expires in ${(hoursLeft / 24).toFixed(1)} days (at ${when})`, warn: false }
}

async function main() {
  const token = process.env.WHATSAPP_TOKEN || ''
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || ''
  const wabaId = process.env.WHATSAPP_WABA_ID || ''
  const version = process.env.WHATSAPP_API_VERSION || 'v21.0'
  const to = digits(rawTo)

  console.log('Config:')
  console.log(`  WHATSAPP_TOKEN            ${token ? `${token.slice(0, 6)}… (${token.length} chars)` : '(empty)'}`)
  console.log(`  WHATSAPP_PHONE_NUMBER_ID  ${phoneNumberId || '(empty)'}`)
  console.log(`  WHATSAPP_WABA_ID          ${process.env.WHATSAPP_WABA_ID || '(empty)'}`)
  console.log(`  WHATSAPP_APP_SECRET       ${process.env.WHATSAPP_APP_SECRET ? 'set (webhook signature verification)' : '(empty)'}`)
  console.log(`  API version               ${version}`)
  console.log(`  sending to                ${to} (from ${rawTo})`)
  console.log(`  mode                      ${templateName ? `template "${templateName}" language "${language}"` : 'free-form text'}`)

  // Token type + expiry. A temporary token silently starts failing with error 190 when it
  // lapses, so surface the deadline before anything depends on it.
  if (token) {
    const info = await debugToken(token, version)
    if (info?.error || info?.invalid) {
      console.log(`\n⚠️  Could not read token details: ${info.error || 'token reported invalid'}`)
    } else {
      const exp = describeExpiry(info)
      console.log('\nToken:')
      console.log(`  type                      ${info.type || '?'} / app "${info.application || '?'}"`)
      console.log(`  scopes                    ${(info.scopes || []).join(', ') || '(none)'}`)
      console.log(`  ${exp?.warn ? '⏳' : '   '} ${exp?.text || 'expiry unknown'}`)
      if (exp?.warn) {
        console.log('  ⚠️  Temporary tokens lapse quickly and sends then fail with error 190.')
        console.log('     Generate a System User token (Business Settings → System Users) with no')
        console.log('     expiry for anything long-lived.')
      }
      const missing = ['whatsapp_business_messaging'].filter((s) => !(info.scopes || []).includes(s))
      if (missing.length) console.log(`  ⚠️  missing scope(s): ${missing.join(', ')}`)
    }
  }

  // --list-templates: show what can actually be sent, with exact name + language.
  if (wantTemplateList) {
    if (!token) {
      console.log('\n❌ WHATSAPP_TOKEN is empty — cannot list templates.')
      process.exitCode = 1
      return
    }
    const ok = await listTemplates({ token, wabaId, version })
    if (!ok) process.exitCode = 1
    return
  }

  const problems = []
  if (!token) problems.push('WHATSAPP_TOKEN is empty')
  else if (!token.startsWith('EAA'))
    problems.push(
      `WHATSAPP_TOKEN does not start with "EAA" — looks like an App Secret or a truncated value (got ${token.length} chars). The App Secret CANNOT send messages.`
    )
  if (!phoneNumberId) problems.push('WHATSAPP_PHONE_NUMBER_ID is empty')
  else if (!/^\d{10,20}$/.test(phoneNumberId))
    problems.push(
      `WHATSAPP_PHONE_NUMBER_ID must be numeric (got "${phoneNumberId}"). It is the Phone Number ID from WhatsApp Manager, not the phone number 9599722251 and not the WABA ID.`
    )

  if (problems.length) {
    console.log('\n❌ Cannot send:')
    for (const p of problems) console.log(`   • ${p}`)
    console.log(`
Where to get them:
  WHATSAPP_TOKEN
    Temporary (24h)  : Meta app dashboard → WhatsApp → API Setup → "Temporary access token"
    Permanent        : Business Settings → System Users → Generate token with
                       whatsapp_business_messaging + whatsapp_business_management
  WHATSAPP_PHONE_NUMBER_ID
    WhatsApp Manager → Phone numbers → the numeric "Phone number ID" column
    (a 15-ish digit number, NOT 9599722251 and NOT the WABA ID)

Add both to .env (and to Render's Environment tab), then re-run this script.`)
    process.exitCode = 1
    return
  }

  console.log('\nSending…')
  const startedAt = Date.now()
  let result
  try {
    result = await postMessage({ token, phoneNumberId, version, to, templateName, text, language })
  } catch (err) {
    console.error('\n❌ Request failed:', err.message)
    process.exitCode = 1
    return
  }

  console.log(`HTTP ${result.status} in ${Date.now() - startedAt}ms`)
  console.log(JSON.stringify(result.data, null, 2))

  if (result.ok && result.data.messages?.[0]?.id) {
    console.log(`\n✅ Accepted by Meta. wamid = ${result.data.messages[0].id}`)
    console.log('   Delivery/read receipts will arrive at APP_BASE_URL/api/track/whatsapp.')
    return
  }

  // Translate the common Meta error codes into the actual fix.
  const code = result.data?.error?.code
  console.log('\n❌ Meta rejected the message.')
  if (code === 132001) {
    console.log('   132001 — that template does not exist in this language on your WABA.')
    console.log('   Create it in WhatsApp Manager → Account tools → Message templates, wait for')
    console.log('   approval, then set the nudge\'s "Meta template name" to match exactly.')
  } else if (code === 131047) {
    console.log('   131047 — more than 24h since the customer last replied.')
    console.log('   Free-form text is not allowed here: send an approved template instead.')
  } else if (code === 190) {
    console.log('   190 — the access token is invalid or expired. Temporary tokens last 24 hours;')
    console.log('   generate a System User token for anything long-lived.')
  } else if (code === 100) {
    console.log('   100 — usually a wrong Phone Number ID, or the number belongs to another WABA.')
    console.log('   Check WHATSAPP_PHONE_NUMBER_ID against WhatsApp Manager → Phone numbers.')
  } else {
    console.log('   Common causes: recipient outside the 24h window (send a template), recipient')
    console.log('   has not opted in, token lacks whatsapp_business_messaging, or the Phone Number')
    console.log('   ID belongs to a different WABA.')
  }
  process.exitCode = 1
}

await main()

/**
 * GET /api/status — one place for "is each integration actually wired up?".
 *
 * The header used to make the operator guess: a Mailer/SMTP setting could be empty and the
 * only way to find out was a failed send. This reports booleans and the *names* of missing
 * variables, never their values, so it is safe behind the app password.
 *
 * Local checks only — it never spends a Zoho or Meta API call to answer.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { describeMailConfig, isMailerConfigured } from '@/lib/mailer'
import { isWhatsAppConfigured, whatsAppConfigStatus } from '@/lib/whatsapp'
import { isZohoMcpConfigured, zohoMcpConfigStatus, zohoMcpMissingEnvVars } from '@/lib/zoho-mcp'
import { ZOHO_CRITERIA, ZOHO_LEADS_CREATED_AFTER } from '@/lib/nudge-defaults'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type Check = {
  key: string
  label: string
  /** up | down | off — `off` means deliberately not configured, which is not an error. */
  state: 'up' | 'down' | 'off'
  detail: string
}

export async function GET() {
  const checks: Check[] = []

  // --- database ---
  let leadCount: number | null = null
  let dbOk = false
  let dbError: string | null = null
  try {
    leadCount = await db.lead.count()
    dbOk = true
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err)
  }
  checks.push({
    key: 'db',
    label: 'Database',
    state: dbOk ? 'up' : 'down',
    detail: dbOk ? `${leadCount} lead(s) stored` : dbError || 'unreachable',
  })

  // --- Zoho CRM (REST) ---
  const zohoRestConfigured = Boolean(
    (process.env.ZOHO_CLIENT_ID || '').trim() &&
      (process.env.ZOHO_CLIENT_SECRET || '').trim() &&
      ((process.env.ZOHO_REFRESH_TOKEN || '').trim() || (process.env.ZOHO_ACCESS_TOKEN || '').trim())
  )
  checks.push({
    key: 'zoho',
    label: 'Zoho CRM API',
    state: zohoRestConfigured ? 'up' : 'off',
    detail: zohoRestConfigured ? `EPS leads created after ${ZOHO_LEADS_CREATED_AFTER}` : 'no REST credentials',
  })

  // --- Zoho CRM MCP ---
  const mcp = zohoMcpConfigStatus()
  const mcpMissing = zohoMcpMissingEnvVars()
  checks.push({
    key: 'zohoMcp',
    label: 'Zoho CRM MCP',
    state: isZohoMcpConfigured() ? 'up' : mcp.urlPresent ? 'off' : 'off',
    detail: isZohoMcpConfigured()
      ? 'CRM reads go through the MCP server'
      : mcp.urlPresent
        ? `not connected — missing ${mcpMissing.join(', ')}`
        : 'ZOHO_MCP_URL not set',
  })

  // --- WhatsApp ---
  const wa = whatsAppConfigStatus()
  const waMissing: string[] = []
  if (!wa.tokenPresent) waMissing.push('WHATSAPP_TOKEN')
  if (!wa.phoneNumberIdPresent) waMissing.push('WHATSAPP_PHONE_NUMBER_ID')
  checks.push({
    key: 'whatsapp',
    label: 'WhatsApp (Meta)',
    state: isWhatsAppConfigured() ? 'up' : 'off',
    detail: isWhatsAppConfigured()
      ? `template language ${wa.templateLanguage || 'unset'}`
      : waMissing.length
        ? `missing ${waMissing.join(', ')}`
        : 'not configured',
  })

  // --- Email ---
  const mail = describeMailConfig()
  checks.push({
    key: 'email',
    label: 'Email',
    state: isMailerConfigured() ? 'up' : 'off',
    detail: isMailerConfigured()
      ? `sending via ${mail.transport}${mail.zoho.fromAddress ? ` as ${mail.zoho.fromAddress}` : ''}`
      : 'no transport configured (Zoho Mail or SMTP)',
  })

  const down = checks.filter((c) => c.state === 'down').length

  return NextResponse.json(
    {
      ok: down === 0,
      checkedAt: new Date().toISOString(),
      checks,
      zoho: {
        criteria: ZOHO_CRITERIA,
        createdAfter: ZOHO_LEADS_CREATED_AFTER,
        restConfigured: zohoRestConfigured,
        mcpConfigured: isZohoMcpConfigured(),
        mcpUrl: mcp.serverUrl,
        mcpMissing,
      },
      scheduler: { enabled: (process.env.SCHEDULER_ENABLED || '').toLowerCase() === 'true' },
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

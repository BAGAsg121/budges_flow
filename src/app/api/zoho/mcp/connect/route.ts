/**
 * GET /api/zoho/mcp/connect
 *
 * Starts the one-time Zoho MCP consent:
 *   1. register a client with the server (Dynamic Client Registration), unless
 *      ZOHO_MCP_CLIENT_ID/SECRET are already in the environment;
 *   2. stash a PKCE verifier and a CSRF state in short-lived httpOnly cookies;
 *   3. redirect to Zoho's consent page.
 *
 * On approval Zoho returns to /api/zoho/mcp/callback, which prints the three values to
 * paste into the host's environment. Nothing is written to the database.
 */
import { NextResponse } from 'next/server'
import {
  buildAuthorizeUrl,
  createPkcePair,
  createState,
  fetchZohoMcpMetadata,
  registerZohoMcpClient,
  zohoMcpConfigStatus,
  zohoMcpRedirectUri,
  zohoMcpRequestedScopes,
} from '@/lib/zoho-mcp'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 600, // 10 minutes is plenty for a consent screen
  secure: process.env.NODE_ENV === 'production',
}

export async function GET() {
  const status = zohoMcpConfigStatus()
  if (!status.urlPresent) {
    return NextResponse.json(
      { ok: false, error: 'Set ZOHO_MCP_URL first — it is the …/mcp/<id>/message URL from Zoho.' },
      { status: 400 }
    )
  }

  const redirectUri = zohoMcpRedirectUri()

  try {
    const metadata = await fetchZohoMcpMetadata()

    // Reuse an existing registration when one is configured; only register once.
    let clientId = (process.env.ZOHO_MCP_CLIENT_ID || '').trim()
    let registration: { clientId: string; clientSecret: string } | null = null
    if (!clientId) {
      registration = await registerZohoMcpClient(redirectUri)
      clientId = registration.clientId
      // Carry the fresh secret through the consent round-trip in a cookie, so it never
      // has to be written down until the user deliberately copies it into the environment.
      // (The cookie is httpOnly and short-lived, and the callback echoes it back once.)
    }

    const pkce = createPkcePair()
    const state = createState()

    const authorizeUrl = buildAuthorizeUrl({
      metadata,
      clientId,
      redirectUri,
      state,
      codeChallenge: pkce.challenge,
      scopes: zohoMcpRequestedScopes(metadata),
    })

    const res = NextResponse.redirect(authorizeUrl)
    res.cookies.set('zoho_mcp_state', state, COOKIE_OPTS)
    res.cookies.set('zoho_mcp_verifier', pkce.verifier, COOKIE_OPTS)
    if (registration) {
      res.cookies.set('zoho_mcp_client_id', registration.clientId, COOKIE_OPTS)
      res.cookies.set('zoho_mcp_client_secret', registration.clientSecret, COOKIE_OPTS)
    }
    return res
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        redirectUri,
        status,
      },
      { status: 502 }
    )
  }
}

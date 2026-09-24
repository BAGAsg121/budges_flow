/**
 * GET /api/zoho/mcp/callback?code=…&state=…
 *
 * Second half of the one-time Zoho MCP consent. Verifies the state cookie, exchanges the
 * code for tokens, then renders the environment block to paste into the host (nothing is
 * written to the database). The refresh token is shown because the app has nowhere of its
 * own to keep secrets — it reads them from the environment, like ZOHO_* and ZOHO_MAIL_*.
 *
 * The page is behind the app password (src/middleware.ts), so the token is never public.
 */
import { NextRequest, NextResponse } from 'next/server'
import { exchangeAuthorizationCode, zohoMcpRedirectUri } from '@/lib/zoho-mcp'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function page(opts: { ok: boolean; title: string; message: string; envBlock?: Array<[string, string]>; detail?: string }) {
  const envHtml = opts.envBlock?.length
    ? `<h2>Add these to the host's environment</h2>
       <p class="muted">Render → your service → Environment → add each one, then redeploy.
       They are shown once here; Zoho does not rotate the refresh token, so they stay valid.</p>
       <pre>${opts.envBlock.map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v)}`).join('\n')}</pre>`
    : ''

  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(opts.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         margin: 0; padding: 40px 20px; background: #f6f7f9; color: #14161a; }
  main { max-width: 760px; margin: 0 auto; background: #fff; border: 1px solid #e4e6ea;
         border-radius: 14px; padding: 28px 30px; box-shadow: 0 1px 3px rgba(16,24,40,.06); }
  h1 { font-size: 19px; margin: 0 0 6px; }
  h2 { font-size: 15px; margin: 26px 0 6px; }
  .ok { color: #067647; } .bad { color: #b42318; }
  .muted { color: #667085; font-size: 13px; }
  pre { background: #0f172a; color: #e2e8f0; padding: 14px 16px; border-radius: 10px;
        overflow-x: auto; font-size: 12.5px; line-height: 1.5; }
  a.btn { display: inline-block; margin-top: 22px; background: #14161a; color: #fff;
          text-decoration: none; padding: 9px 16px; border-radius: 9px; font-size: 14px; }
  code { background: #f1f3f6; padding: 1px 5px; border-radius: 5px; }
</style></head><body><main>
<h1 class="${opts.ok ? 'ok' : 'bad'}">${escapeHtml(opts.title)}</h1>
<p>${opts.message}</p>
${opts.detail ? `<p class="muted">${escapeHtml(opts.detail)}</p>` : ''}
${envHtml}
<a class="btn" href="/">Back to the app</a>
</main></body></html>`
}

function html(body: string, status = 200) {
  return new NextResponse(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams
  const error = params.get('error')
  const code = params.get('code')
  const state = params.get('state')

  if (error) {
    return html(
      page({
        ok: false,
        title: 'Zoho declined the connection',
        message: `Zoho returned <code>${escapeHtml(error)}</code>${params.get('error_description') ? `: ${escapeHtml(String(params.get('error_description')))}` : '.'}`,
        detail: 'Nothing was stored. You can start again from /api/zoho/mcp/connect.',
      }),
      400
    )
  }

  const expectedState = req.cookies.get('zoho_mcp_state')?.value
  if (!code) {
    return html(page({ ok: false, title: 'Missing authorization code', message: 'Zoho did not send a <code>code</code> parameter.' }), 400)
  }
  if (!expectedState || state !== expectedState) {
    return html(
      page({
        ok: false,
        title: 'State check failed',
        message: 'The consent response did not match the request that started it.',
        detail: 'This is the CSRF guard doing its job. Start again from /api/zoho/mcp/connect (and finish within 10 minutes).',
      }),
      400
    )
  }

  const clientId = (process.env.ZOHO_MCP_CLIENT_ID || '').trim() || req.cookies.get('zoho_mcp_client_id')?.value || ''
  const clientSecret = (process.env.ZOHO_MCP_CLIENT_SECRET || '').trim() || req.cookies.get('zoho_mcp_client_secret')?.value || ''
  const verifier = req.cookies.get('zoho_mcp_verifier')?.value

  if (!clientId) {
    return html(
      page({
        ok: false,
        title: 'Lost the client registration',
        message: 'No client id was available to exchange the code with.',
        detail: 'Re-run /api/zoho/mcp/connect and complete the consent without closing the browser.',
      }),
      400
    )
  }

  try {
    const tokens = await exchangeAuthorizationCode({
      code,
      clientId,
      clientSecret,
      redirectUri: zohoMcpRedirectUri(),
      codeVerifier: verifier,
    })

    const envBlock: Array<[string, string]> = [
      ['ZOHO_MCP_CLIENT_ID', clientId],
      ['ZOHO_MCP_CLIENT_SECRET', clientSecret],
      ['ZOHO_MCP_REFRESH_TOKEN', tokens.refreshToken || '(Zoho returned no refresh token — re-run with prompt=consent)'],
    ]

    const res = html(
      page({
        ok: true,
        title: 'Connected to Zoho CRM',
        message: `Zoho issued an access token${tokens.expiresIn ? ` valid for ${Math.round(tokens.expiresIn / 60)} minutes` : ''} and a refresh token.`,
        envBlock,
        detail: tokens.scope ? `Granted scopes: ${tokens.scope}` : undefined,
      })
    )
    // The cookies have done their job.
    for (const name of ['zoho_mcp_state', 'zoho_mcp_verifier', 'zoho_mcp_client_id', 'zoho_mcp_client_secret']) {
      res.cookies.set(name, '', { path: '/', maxAge: 0 })
    }
    return res
  } catch (err) {
    return html(
      page({
        ok: false,
        title: 'Could not exchange the authorization code',
        message: escapeHtml(err instanceof Error ? err.message : String(err)),
        detail: 'Codes are single-use and short-lived. Start again from /api/zoho/mcp/connect.',
      }),
      502
    )
  }
}

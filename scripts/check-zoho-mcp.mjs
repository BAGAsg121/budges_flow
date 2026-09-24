/**
 * Zoho CRM MCP check.
 *
 *   node --env-file=.env scripts/check-zoho-mcp.mjs              # config + discovery
 *   node --env-file=.env scripts/check-zoho-mcp.mjs --tools      # connect and list tools
 *   node --env-file=.env scripts/check-zoho-mcp.mjs --register   # also try client registration
 *   node --env-file=.env scripts/check-zoho-mcp.mjs --call <tool> [jsonArgs]
 *
 * Uses the SAME modules the app uses (src/lib/zoho-mcp.ts), so a result here is the app's
 * result. Reads only — it never writes to the database.
 */
import {
  fetchZohoMcpMetadata,
  registerZohoMcpClient,
  zohoMcpConfigStatus,
  zohoMcpMissingEnvVars,
  zohoMcpRedirectUri,
  zohoMcpRequestedScopes,
  isZohoMcpConfigured,
  connectZohoMcp,
  pickLeadsTool,
  buildLeadsToolArgs,
  callZohoMcpTool,
} from '../src/lib/zoho-mcp.ts'
import { ZOHO_CRITERIA, zohoTodayCriteria } from '../src/lib/nudge-defaults.ts'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)

const status = zohoMcpConfigStatus()
console.log('Zoho CRM MCP\n============')
console.log(`  server url        ${status.serverUrl || 'MISSING (set ZOHO_MCP_URL)'}`)
console.log(`  origin            ${status.origin || '-'}`)
console.log(`  redirect uri      ${status.redirectUri}`)
console.log(`  client id         ${status.clientIdPresent ? 'set' : 'MISSING'}`)
console.log(`  client secret     ${status.clientSecretPresent ? 'set' : 'MISSING'}`)
console.log(`  refresh token     ${status.refreshTokenPresent ? 'set' : 'MISSING'}`)
console.log(`  access token      ${status.accessTokenOverridePresent ? 'set (override)' : 'not set'}`)
console.log(`  can authenticate  ${status.canAuthenticate ? 'yes' : 'no'}`)

if (!status.urlPresent) {
  console.log('\n❌ Set ZOHO_MCP_URL first — it is the ".../mcp/<id>/message" URL from Zoho.')
  process.exit(1)
}

// --- discovery ---------------------------------------------------------------
let metadata
try {
  metadata = await fetchZohoMcpMetadata(true)
  console.log('\nOAuth discovery (from the server)')
  console.log(`  authorize         ${metadata.authorizationEndpoint}`)
  console.log(`  token             ${metadata.tokenEndpoint}`)
  console.log(`  register          ${metadata.registrationEndpoint || '(not offered)'}`)
  console.log(`  PKCE             ${metadata.codeChallengeMethodsSupported.join(', ') || '(none advertised)'}`)
  console.log(`  scopes            ${metadata.scopesSupported.length} advertised`)
  const wanted = zohoMcpRequestedScopes(metadata)
  console.log(`  we will ask for   ${wanted.length} scope(s)`)
  for (const s of wanted) console.log(`      • ${s}`)
} catch (err) {
  console.log(`\n❌ Discovery failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

// --- optional: prove dynamic client registration works -----------------------
if (flag('--register')) {
  console.log('\nRegistering a client with the server…')
  try {
    const client = await registerZohoMcpClient(zohoMcpRedirectUri())
    console.log(`✅ Registered. client_id ${client.clientId}`)
    console.log(`   client_secret ${client.clientSecret ? '(returned, ' + client.clientSecret.length + ' chars)' : '(none — public client)'}`)
    console.log('\n   This is exactly what /api/zoho/mcp/connect does. To finish, open that URL and')
    console.log('   approve the consent screen — the callback prints the three env values.')
  } catch (err) {
    console.log(`❌ Registration failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}

// --- connected? ---------------------------------------------------------------
if (!isZohoMcpConfigured()) {
  console.log(`\nNot connected yet. Missing: ${zohoMcpMissingEnvVars().join(', ')}`)
  console.log('Finish the one-time consent at /api/zoho/mcp/connect, then paste the printed values.')
  // Deliberately NOT process.exit(): this script has open keep-alive sockets from fetch(),
  // and forcing an exit with them alive trips a libuv assertion on Windows. Setting the
  // code and letting Node drain gives the same exit status without the crash.
  process.exitCode = 0
} else {
  try {
    const conn = await connectZohoMcp({ refresh: flag('--tools') })
    console.log(`\nConnected to "${conn.session.serverName}" (protocol ${conn.session.protocolVersion})`)
    console.log(`  ${conn.toolCount} tool(s) available`)

    const leadsTool = pickLeadsTool(conn.tools)
    console.log(`\nLeads tool: ${leadsTool ? leadsTool.name : '⚠️ none matched'}`)
    if (leadsTool) {
      const isToday = flag('--today')
      const criteria = isToday ? zohoTodayCriteria() : ZOHO_CRITERIA
      console.log(`  window     ${isToday ? 'today (01:00 IST → now)' : 'all EPS since 2026-08-01'}`)
      console.log(`  arguments  ${JSON.stringify(buildLeadsToolArgs(leadsTool, criteria))}`)
    }

    if (flag('--tools')) {
      console.log('\nEvery tool:')
      for (const t of conn.tools) {
        const req = t.inputSchema?.required ?? []
        console.log(`  • ${t.name}${req.length ? ` (required: ${req.join(', ')})` : ''}`)
        if (t.description) console.log(`      ${t.description.replace(/\s+/g, ' ').slice(0, 160)}`)
      }
    }

    const callIdx = args.indexOf('--call')
    if (callIdx !== -1) {
      const tool = args[callIdx + 1]
      if (!tool) {
        console.log('\n--call needs a tool name.')
        process.exitCode = 1
      } else {
        let callArgs = {}
        const rawArgs = args[callIdx + 2]
        const matched = conn.tools.find((t) => t.name === tool)
        if (rawArgs && rawArgs.startsWith('{')) {
          try {
            callArgs = JSON.parse(rawArgs)
          } catch {
            console.log('\nThe arguments after --call are not valid JSON.')
            process.exitCode = 1
          }
        } else if (rawArgs === '--today' && matched) {
          callArgs = buildLeadsToolArgs(matched, zohoTodayCriteria())
        } else if (rawArgs === '--all' && matched) {
          callArgs = buildLeadsToolArgs(matched, ZOHO_CRITERIA)
        }

        if (!process.exitCode) {
          console.log(`\nCalling ${tool} with ${JSON.stringify(callArgs)}`)
          const result = await callZohoMcpTool(tool, callArgs)
          console.log(`  ok=${result.ok} isError=${result.isError}`)
          console.log(`  ${result.error || result.text.slice(0, 1500)}`)
          if (!result.ok) process.exitCode = 1
        }
      }
    }
  } catch (err) {
    console.log(`\n❌ ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}

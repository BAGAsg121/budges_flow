/**
 * Zoho CRM MCP — connection, OAuth and tool access.
 *
 * The app talks to Zoho CRM through Zoho's own MCP server rather than the REST API, so
 * every read is a `tools/call` against the server's published tool set.
 *
 * ── Credentials ────────────────────────────────────────────────────────────────
 * Nothing here is written to the database. The client registration (from the server's
 * Dynamic Client Registration endpoint) and the refresh token go into environment
 * variables, exactly like the existing ZOHO_* and ZOHO_MAIL_* credentials, and the
 * short-lived access token is cached in memory only:
 *
 *   ZOHO_MCP_URL             the …/mcp/<id>/message endpoint (the "server URL")
 *   ZOHO_MCP_CLIENT_ID       from the one-time connect flow
 *   ZOHO_MCP_CLIENT_SECRET   from the one-time connect flow
 *   ZOHO_MCP_REFRESH_TOKEN   from the one-time connect flow
 *   ZOHO_MCP_TOKEN           optional: paste an access token to bypass refresh entirely
 *
 * `GET /api/zoho/mcp/connect` runs the one-time consent and prints those three values.
 * Refresh tokens from Zoho do not rotate on use, so the pasted value keeps working and
 * the app can mint a fresh access token whenever it needs one.
 */
import { createHash, randomBytes } from 'crypto'
import {
  mcpInitialize,
  mcpListTools,
  mcpCallTool,
  type McpCallResult,
  type McpSession,
  type McpTool,
} from './mcp-client.ts'

/* ────────────────────────────── configuration ────────────────────────────── */

export function zohoMcpServerUrl(): string {
  return (process.env.ZOHO_MCP_URL || '').trim()
}

/** The MCP server's origin, where its OAuth discovery documents live. */
export function zohoMcpOrigin(): string | null {
  const url = zohoMcpServerUrl()
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export function zohoMcpRedirectUri(): string {
  const explicit = (process.env.ZOHO_MCP_REDIRECT_URI || '').trim()
  if (explicit) return explicit
  const base = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '')
  return `${base}/api/zoho/mcp/callback`
}

export interface ZohoMcpConfigStatus {
  urlPresent: boolean
  serverUrl: string | null
  origin: string | null
  redirectUri: string
  clientIdPresent: boolean
  clientSecretPresent: boolean
  refreshTokenPresent: boolean
  accessTokenOverridePresent: boolean
  /** True when an access token can be obtained (override, or client+secret+refresh token). */
  canAuthenticate: boolean
  connected: boolean
}

export function zohoMcpConfigStatus(): ZohoMcpConfigStatus {
  const serverUrl = zohoMcpServerUrl()
  const clientIdPresent = Boolean((process.env.ZOHO_MCP_CLIENT_ID || '').trim())
  const clientSecretPresent = Boolean((process.env.ZOHO_MCP_CLIENT_SECRET || '').trim())
  const refreshTokenPresent = Boolean((process.env.ZOHO_MCP_REFRESH_TOKEN || '').trim())
  const accessTokenOverridePresent = Boolean((process.env.ZOHO_MCP_TOKEN || '').trim())

  return {
    urlPresent: Boolean(serverUrl),
    serverUrl: serverUrl || null,
    origin: zohoMcpOrigin(),
    redirectUri: zohoMcpRedirectUri(),
    clientIdPresent,
    clientSecretPresent,
    refreshTokenPresent,
    accessTokenOverridePresent,
    canAuthenticate: accessTokenOverridePresent || (clientIdPresent && clientSecretPresent && refreshTokenPresent),
    connected: Boolean(serverUrl) && (accessTokenOverridePresent || (clientIdPresent && clientSecretPresent && refreshTokenPresent)),
  }
}

export function isZohoMcpConfigured(): boolean {
  return zohoMcpConfigStatus().connected
}

/** Which env vars are still missing, in the order the connect flow produces them. */
export function zohoMcpMissingEnvVars(): string[] {
  const s = zohoMcpConfigStatus()
  const missing: string[] = []
  if (!s.urlPresent) missing.push('ZOHO_MCP_URL')
  if (!s.accessTokenOverridePresent) {
    if (!s.clientIdPresent) missing.push('ZOHO_MCP_CLIENT_ID')
    if (!s.clientSecretPresent) missing.push('ZOHO_MCP_CLIENT_SECRET')
    if (!s.refreshTokenPresent) missing.push('ZOHO_MCP_REFRESH_TOKEN')
  }
  return missing
}

/* ─────────────────────────── OAuth discovery + DCR ─────────────────────────── */

export interface ZohoMcpMetadata {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string | null
  revocationEndpoint: string | null
  scopesSupported: string[]
  codeChallengeMethodsSupported: string[]
}

let metadataCache: { at: number; value: ZohoMcpMetadata } | null = null
const METADATA_TTL_MS = 30 * 60 * 1000

export async function fetchZohoMcpMetadata(force = false): Promise<ZohoMcpMetadata> {
  const origin = zohoMcpOrigin()
  if (!origin) throw new Error('ZOHO_MCP_URL is not set, so the MCP server cannot be reached.')

  if (!force && metadataCache && Date.now() - metadataCache.at < METADATA_TTL_MS) return metadataCache.value

  const res = await fetch(`${origin}/.well-known/oauth-authorization-server`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Could not read the MCP server's OAuth metadata (HTTP ${res.status}).`)

  const raw = (await res.json()) as Record<string, unknown>
  const value: ZohoMcpMetadata = {
    authorizationEndpoint: String(raw.authorization_endpoint || ''),
    tokenEndpoint: String(raw.token_endpoint || ''),
    registrationEndpoint: raw.registration_endpoint ? String(raw.registration_endpoint) : null,
    revocationEndpoint: raw.revocation_endpoint ? String(raw.revocation_endpoint) : null,
    scopesSupported: Array.isArray(raw.scopes_supported) ? (raw.scopes_supported as string[]) : [],
    codeChallengeMethodsSupported: Array.isArray(raw.code_challenge_methods_supported)
      ? (raw.code_challenge_methods_supported as string[])
      : [],
  }
  if (!value.authorizationEndpoint || !value.tokenEndpoint) {
    throw new Error('The MCP server did not publish an authorization and token endpoint.')
  }

  metadataCache = { at: Date.now(), value }
  return value
}

/** Scopes we ask for. Read-only CRM access plus the permission to execute a tool at all. */
export function zohoMcpRequestedScopes(metadata: ZohoMcpMetadata): string[] {
  const wanted = [
    'ZohoCRM.modules.Leads.READ',
    'ZohoCRM.modules.READ',
    'ZohoCRM.settings.fields.READ',
    'ZohoCRM.settings.modules.READ',
    'ZohoCRM.org.READ',
    'ZohoCRM.users.READ',
    'ZohoMCP.tool.execute',
  ]
  // Never ask for a scope the server does not advertise — that fails the whole consent.
  return wanted.filter((s) => metadata.scopesSupported.length === 0 || metadata.scopesSupported.includes(s))
}

export interface RegisteredClient {
  clientId: string
  clientSecret: string
}

/** Dynamic Client Registration: ask the server to mint us a client. */
export async function registerZohoMcpClient(redirectUri: string): Promise<RegisteredClient> {
  const metadata = await fetchZohoMcpMetadata()
  if (!metadata.registrationEndpoint) {
    throw new Error('This MCP server does not support dynamic client registration, so a client must be created in Zoho manually.')
  }

  const res = await fetch(metadata.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Nudge Engine',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: zohoMcpRequestedScopes(metadata).join(' '),
    }),
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Client registration failed (HTTP ${res.status}): ${text.slice(0, 400)}`)
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`Client registration returned a non-JSON body: ${text.slice(0, 300)}`)
  }

  const clientId = String(parsed.client_id || '')
  const clientSecret = String(parsed.client_secret || '')
  if (!clientId) throw new Error(`Client registration succeeded but returned no client_id: ${text.slice(0, 300)}`)
  return { clientId, clientSecret }
}

/* ───────────────────────────────── PKCE ───────────────────────────────── */

export function createPkcePair(): { verifier: string; challenge: string; method: 'S256' } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge, method: 'S256' }
}

export function createState(): string {
  return randomBytes(16).toString('hex')
}

export function buildAuthorizeUrl(opts: {
  metadata: ZohoMcpMetadata
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  scopes: string[]
}): string {
  const url = new URL(opts.metadata.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', opts.clientId)
  url.searchParams.set('redirect_uri', opts.redirectUri)
  url.searchParams.set('state', opts.state)
  if (opts.scopes.length) url.searchParams.set('scope', opts.scopes.join(' '))
  if (opts.metadata.codeChallengeMethodsSupported.includes('S256')) {
    url.searchParams.set('code_challenge', opts.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
  }
  url.searchParams.set('access_type', 'offline') // ask for a refresh token
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

export interface ZohoMcpTokens {
  accessToken: string
  refreshToken: string | null
  expiresIn: number | null
  scope: string | null
}

async function postToken(endpoint: string, form: Record<string, string>): Promise<ZohoMcpTokens> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  })
  const text = await res.text()

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`Token endpoint returned a non-JSON body (HTTP ${res.status}): ${text.slice(0, 300)}`)
  }
  if (!res.ok || parsed.error) {
    const err = String(parsed.error || `HTTP ${res.status}`)
    const desc = String(parsed.error_description || parsed.message || '')
    throw new Error(`Token request failed: ${err}${desc ? ` — ${desc}` : ''}`)
  }

  const accessToken = String(parsed.access_token || '')
  if (!accessToken) throw new Error(`Token endpoint returned no access_token: ${text.slice(0, 300)}`)

  return {
    accessToken,
    refreshToken: parsed.refresh_token ? String(parsed.refresh_token) : null,
    expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : null,
    scope: parsed.scope ? String(parsed.scope) : null,
  }
}

export async function exchangeAuthorizationCode(opts: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
  codeVerifier?: string
}): Promise<ZohoMcpTokens> {
  const metadata = await fetchZohoMcpMetadata()
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
  }
  if (opts.clientSecret) form.client_secret = opts.clientSecret
  if (opts.codeVerifier) form.code_verifier = opts.codeVerifier
  return postToken(metadata.tokenEndpoint, form)
}

/* ────────────────────────── access-token cache ────────────────────────── */

let tokenCache: { token: string; expiresAt: number } | null = null

/** Test seam — lets the CLI and the verify script reset state between calls. */
export function clearZohoMcpTokenCache(): void {
  tokenCache = null
  metadataCache = null
  toolsCache = null
  sessionCache = null
}

/**
 * A usable access token, refreshing when the cached one is close to expiry.
 * Returns null when the app is not configured, so callers can fall back cleanly.
 */
export async function getZohoMcpAccessToken(force = false): Promise<string | null> {
  const override = (process.env.ZOHO_MCP_TOKEN || '').trim()
  if (override) return override

  const clientId = (process.env.ZOHO_MCP_CLIENT_ID || '').trim()
  const clientSecret = (process.env.ZOHO_MCP_CLIENT_SECRET || '').trim()
  const refreshToken = (process.env.ZOHO_MCP_REFRESH_TOKEN || '').trim()
  if (!clientId || !refreshToken) return null

  // Refresh a minute early so a request never leaves with a token that expires in flight.
  if (!force && tokenCache && tokenCache.expiresAt - 60_000 > Date.now()) return tokenCache.token

  const metadata = await fetchZohoMcpMetadata()
  const form: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  }
  if (clientSecret) form.client_secret = clientSecret

  const tokens = await postToken(metadata.tokenEndpoint, form)
  const ttlMs = (tokens.expiresIn ?? 3600) * 1000
  tokenCache = { token: tokens.accessToken, expiresAt: Date.now() + ttlMs }
  return tokens.accessToken
}

/* ──────────────────────────── tool access ──────────────────────────── */

let sessionCache: { at: number; value: McpSession } | null = null
let toolsCache: { at: number; value: McpTool[] } | null = null
const SESSION_TTL_MS = 10 * 60 * 1000

export interface ZohoMcpConnection {
  session: McpSession
  tools: McpTool[]
  toolCount: number
  scopes: string | null
}

/** initialize + tools/list, cached briefly because every call costs a round trip. */
export async function connectZohoMcp(opts: { refresh?: boolean } = {}): Promise<ZohoMcpConnection> {
  const token = await getZohoMcpAccessToken(opts.refresh)
  if (!token) {
    throw new Error(
      `Zoho MCP is not connected. Missing: ${zohoMcpMissingEnvVars().join(', ') || 'unknown'}. ` +
        'Run the one-time connect flow at /api/zoho/mcp/connect.'
    )
  }

  const fresh = !sessionCache || Date.now() - sessionCache.at > SESSION_TTL_MS
  if (opts.refresh || fresh) {
    const session = await mcpInitialize({ url: zohoMcpServerUrl(), token })
    sessionCache = { at: Date.now(), value: session }
  }
  const session = sessionCache!.value

  if (opts.refresh || !toolsCache) {
    const tools = await mcpListTools({ url: zohoMcpServerUrl(), token }, session)
    toolsCache = { at: Date.now(), value: tools }
  }

  return { session, tools: toolsCache!.value, toolCount: toolsCache!.value.length, scopes: null }
}

export async function listZohoMcpTools(opts: { refresh?: boolean } = {}): Promise<McpTool[]> {
  const conn = await connectZohoMcp(opts)
  return conn.tools
}

export async function callZohoMcpTool(name: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
  const token = await getZohoMcpAccessToken()
  if (!token) {
    return {
      ok: false,
      isError: true,
      text: '',
      json: null,
      raw: null,
      error: `Zoho MCP is not connected. Missing: ${zohoMcpMissingEnvVars().join(', ') || 'unknown'}.`,
    }
  }
  const session = sessionCache?.value
  try {
    return await mcpCallTool({ url: zohoMcpServerUrl(), token }, name, args, session)
  } catch (err) {
    // One retry with a brand-new session: MCP session ids expire, and a stale one looks
    // exactly like a broken tool otherwise.
    clearZohoMcpTokenCache()
    const freshToken = await getZohoMcpAccessToken(true)
    if (!freshToken) throw err
    const conn = await connectZohoMcp({ refresh: true })
    return mcpCallTool({ url: zohoMcpServerUrl(), token: freshToken }, name, args, conn.session)
  }
}

/* ────────────────────── finding the leads tool ────────────────────── */

/**
 * Which of the server's tools reads Leads.
 *
 * The tool list is only knowable after connecting, so this scores names against the shape
 * that actually works, and it learned two lessons the hard way against the live server:
 *
 *  - Zoho's MCP tools are generated per API operation, and a *count* endpoint sits right
 *    next to the search one (`ZohoCRM_getRecordCount` vs `ZohoCRM_searchRecords`). A count
 *    tool returns a number, not records, so picking it makes a sync report 0 new leads
 *    while looking perfectly successful. Count/aggregate names score catastrophically.
 *  - Arguments are nested under `path_variables` / `query_params`, so a tool is only
 *    usable if its schema can actually carry a filter. That is worth real points.
 *
 * Write-shaped names score down hard — a sync must never pick a tool that creates or
 * deletes CRM records. Pin the exact name with `ZOHO_MCP_LEADS_TOOL` once you have seen
 * the list.
 */
export function pickLeadsTool(tools: McpTool[]): McpTool | null {
  const explicit = (process.env.ZOHO_MCP_LEADS_TOOL || '').trim()
  if (explicit) return tools.find((t) => t.name === explicit) ?? null

  const scored = tools
    .map((t) => {
      const name = t.name.toLowerCase()
      const hay = `${t.name} ${t.title ?? ''} ${t.description ?? ''}`.toLowerCase()
      let score = 0

      if (/lead/.test(hay)) score += 4
      if (/(search|query)/.test(name)) score += 6
      if (/records?\b/.test(name) || /records?\b/.test(hay)) score += 4
      if (/(coql|criteria|filter)/.test(hay)) score += 1

      // Not a record reader.
      if (/(count|statistic|stats|aggregate|summary|report)/.test(name)) score -= 20
      // Never a reader, and never safe for a sync to touch.
      if (/(create|update|delete|insert|upsert|add_|_add|remove|clone|convert)/.test(name)) score -= 50

      // Can it carry the filter at all? Nested or flat.
      const props = t.inputSchema?.properties ?? {}
      const nestedQuery = (props.query_params as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
      const names = [...Object.keys(props), ...Object.keys(nestedQuery)]
      if (names.some((n) => ['criteria', 'search_criteria', 'coql', 'query', 'filter'].includes(n))) score += 5
      // A module selector means it is not hardwired to one module.
      const nestedPath = (props.path_variables as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
      if (names.includes('module') || Object.keys(nestedPath).includes('module')) score += 2

      return { tool: t, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored[0]?.tool ?? null
}

/** The parameter names a tool exposes, flat or nested under path_variables / query_params. */
function schemaParamNames(tool: McpTool): { path: string[]; query: string[]; flat: string[]; nested: boolean } {
  const props = tool.inputSchema?.properties ?? {}
  const path = Object.keys((props.path_variables as { properties?: Record<string, unknown> } | undefined)?.properties ?? {})
  const query = Object.keys((props.query_params as { properties?: Record<string, unknown> } | undefined)?.properties ?? {})
  const nested = path.length > 0 || query.length > 0
  const flat = nested ? [] : Object.keys(props)
  return { path, query, flat, nested }
}

/** The first name present from a preference list. */
function firstOf(available: string[], ...wanted: string[]): string | undefined {
  return wanted.find((w) => available.includes(w))
}

const CRITERIA_NAMES = ['criteria', 'search_criteria', 'coql', 'query', 'filter', 'search', 'q'] as const
const MODULE_NAMES = ['module', 'module_api_name', 'moduleName', 'module_name'] as const
const PAGE_SIZE_NAMES = ['per_page', 'pageSize', 'page_size', 'limit'] as const

/**
 * Arguments for a leads tool, built against its own published `inputSchema`.
 *
 * Throws when it cannot place the criteria anywhere. That is deliberate: returning empty
 * arguments would make the tool read unfiltered data (or nothing), and the sync would
 * report "0 new leads" as a success. Failing here lets the caller fall back to the REST
 * API and say why.
 *
 * Set `ZOHO_MCP_LEADS_ARGS` to a JSON object to override this entirely; the literal
 * `{{criteria}}` is substituted.
 */
export function buildLeadsToolArgs(
  tool: McpTool,
  criteria: string,
  fields?: string
): Record<string, unknown> {
  const override = (process.env.ZOHO_MCP_LEADS_ARGS || '').trim()
  if (override) {
    try {
      const parsed = JSON.parse(override) as Record<string, unknown>
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v === '{{criteria}}' ? criteria : v]))
    } catch {
      throw new Error('ZOHO_MCP_LEADS_ARGS is not valid JSON.')
    }
  }

  const { path, query, flat, nested } = schemaParamNames(tool)
  if (!path.length && !query.length && !flat.length) {
    // A tool with no declared parameters cannot be filtered. Only acceptable if it takes none.
    return {}
  }

  if (nested) {
    const args: Record<string, unknown> = {}

    if (path.length) {
      const moduleProp = firstOf(path, ...MODULE_NAMES)
      if (!moduleProp) {
        throw new Error(
          `MCP tool "${tool.name}" needs path_variables (${path.join(', ')}) but none of them is a module selector.`
        )
      }
      args.path_variables = { [moduleProp]: 'Leads' }
    }

    const criteriaProp = firstOf(query, ...CRITERIA_NAMES)
    if (!criteriaProp) {
      throw new Error(
        `MCP tool "${tool.name}" exposes no criteria parameter (query_params: ${query.join(', ') || 'none'}), ` +
          'so it cannot be filtered. Pin a searchable tool with ZOHO_MCP_LEADS_TOOL or ' +
          'ZOHO_MCP_LEADS_ARGS.'
      )
    }

    const q: Record<string, unknown> = { [criteriaProp]: criteria }
    const fieldsProp = firstOf(query, 'fields')
    if (fieldsProp && fields) q[fieldsProp] = fields
    const perPageProp = firstOf(query, ...PAGE_SIZE_NAMES)
    if (perPageProp) q[perPageProp] = 200
    if (query.includes('page')) q.page = 1

    args.query_params = q
    return args
  }

  // Flat shape.
  const criteriaProp = firstOf(flat, ...CRITERIA_NAMES)
  if (!criteriaProp) {
    throw new Error(
      `MCP tool "${tool.name}" exposes no criteria parameter (${flat.join(', ')}), so it cannot be filtered. ` +
        'Pin a searchable tool with ZOHO_MCP_LEADS_TOOL or ZOHO_MCP_LEADS_ARGS.'
    )
  }

  const args: Record<string, unknown> = {}
  const moduleProp = firstOf(flat, ...MODULE_NAMES)
  if (moduleProp) args[moduleProp] = 'Leads'
  args[criteriaProp] = criteria
  const fieldsProp = firstOf(flat, 'fields')
  if (fieldsProp && fields) args[fieldsProp] = fields
  const perPageProp = firstOf(flat, ...PAGE_SIZE_NAMES)
  if (perPageProp) args[perPageProp] = 200
  if (flat.includes('page')) args.page = 1
  return args
}

/** Move a paged call to the next page, in whichever shape the tool declared. */
export function withPage(args: Record<string, unknown>, page: number): Record<string, unknown> {
  if (args.query_params && typeof args.query_params === 'object') {
    return { ...args, query_params: { ...(args.query_params as Record<string, unknown>), page } }
  }
  return { ...args, page }
}

/**
 * Paging state from whatever envelope the tool returned.
 *
 * Zoho reports `info.more_records` / `info.next_page_token`, and the wrapper varies, so
 * this looks for the first `info`-ish object rather than assuming a path.
 */
export function extractPagingInfo(payload: unknown): { moreRecords: boolean; page: number | null } {
  const seen = new Set<unknown>()

  function walk(node: unknown, depth: number): { moreRecords: boolean; page: number | null } | null {
    if (depth > 6 || node == null || typeof node !== 'object') {
      if (typeof node === 'string' && (node.trim().startsWith('{') || node.trim().startsWith('['))) {
        try {
          return walk(JSON.parse(node), depth + 1)
        } catch {
          return null
        }
      }
      return null
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1)
        if (found) return found
      }
      return null
    }
    if (seen.has(node)) return null
    seen.add(node)

    const obj = node as Record<string, unknown>
    if ('more_records' in obj) {
      return {
        moreRecords: Boolean(obj.more_records),
        page: typeof obj.page === 'number' ? obj.page : null,
      }
    }
    for (const value of Object.values(obj)) {
      const found = walk(value, depth + 1)
      if (found) return found
    }
    return null
  }

  return walk(payload, 0) ?? { moreRecords: false, page: null }
}


/**
 * Pull record objects out of whatever envelope a tool returned. Zoho MCP tools generally
 * wrap a CRM API response, but the wrapper varies (`{data:[…]}`, `{records:[…]}`, a bare
 * array, or a JSON string), so accept all of them rather than assuming one.
 */
export function extractRecords(payload: unknown): Record<string, unknown>[] {  const seen = new Set<unknown>()

  function walk(node: unknown, depth: number): Record<string, unknown>[] {
    if (depth > 6 || node == null) return []
    if (typeof node === 'string') {
      const trimmed = node.trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return walk(JSON.parse(trimmed), depth + 1)
        } catch {
          return []
        }
      }
      return []
    }
    if (Array.isArray(node)) {
      // An array of records, or an array of response envelopes.
      const objects = node.filter((n): n is Record<string, unknown> => Boolean(n) && typeof n === 'object' && !Array.isArray(n))
      const looksLikeRecords = objects.some((o) => o.id !== undefined || o.Created_Time !== undefined || o.Email !== undefined)
      if (looksLikeRecords) return objects
      return objects.flatMap((o) => walk(o, depth + 1))
    }
    if (typeof node !== 'object') return []
    if (seen.has(node)) return []
    seen.add(node)

    const obj = node as Record<string, unknown>
    for (const key of ['data', 'records', 'response', 'result', 'results', 'leads', 'rows', 'items', 'content']) {
      if (key in obj) {
        const found = walk(obj[key], depth + 1)
        if (found.length) return found
      }
    }
    // A single record returned on its own.
    if (obj.id !== undefined && (obj.Created_Time !== undefined || obj.Email !== undefined || obj.Lead_Status !== undefined)) {
      return [obj]
    }
    return []
  }

  return walk(payload, 0)
}


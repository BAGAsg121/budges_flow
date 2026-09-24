/**
 * A minimal MCP (Model Context Protocol) client over the Streamable HTTP transport.
 *
 * Deliberately small and dependency-free: the app only needs `initialize`, `tools/list`
 * and `tools/call`, and a full SDK would be a lot of surface area for that.
 *
 * Transport notes that matter in practice:
 *  - A server may answer with `application/json` OR with an SSE stream (`text/event-stream`),
 *    so the response is parsed for both. SSE bodies are split on blank lines and only the
 *    `data:` payloads are read.
 *  - The `initialize` response carries an `Mcp-Session-Id` header that every later request
 *    must echo back.
 *  - The protocol version is negotiated: we ask for the newest we know and accept whatever
 *    the server answers with, rather than assuming.
 *  - JSON-RPC errors arrive as HTTP 200 with an `error` member, so the HTTP status alone is
 *    not enough to decide success.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18'

export interface McpJsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface McpTool {
  name: string
  title?: string
  description?: string
  inputSchema?: {
    type?: string
    properties?: Record<string, unknown>
    required?: string[]
    [k: string]: unknown
  }
}

export interface McpCallResult {
  /** The tool ran. `isError` marks a tool-level failure reported inside a successful call. */
  ok: boolean
  isError: boolean
  /** Flattened text content, which is what Zoho's tools return. */
  text: string
  /** Parsed JSON when the tool returned a JSON string; otherwise null. */
  json: unknown
  raw: unknown
  error?: string
}

export interface McpSession {
  protocolVersion: string
  sessionId: string | null
  serverName: string
  serverVersion: string
}

export interface McpTransport {
  url: string
  /** Bearer token. Sent only when non-empty. */
  token?: string | null
  /** Echoed back on every request after `initialize`. */
  sessionId?: string | null
  /** Abort a hung request rather than letting a route hang until the platform kills it. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** Pull the JSON-RPC payload(s) out of either a JSON body or an SSE stream. */
export function parseMcpBody(contentType: string, body: string): unknown[] {
  const isSse =
    contentType.includes('text/event-stream') ||
    // Some servers omit the header but still answer with SSE frames.
    (!contentType.includes('json') && /^\s*(event|data):/m.test(body))

  if (!isSse) {
    const trimmed = body.trim()
    if (!trimmed) return []
    try {
      return [JSON.parse(trimmed)]
    } catch {
      // A JSON content-type with an unparseable body is a server-side problem worth naming.
      throw new Error(`MCP returned a non-JSON body (${contentType || 'no content-type'}): ${trimmed.slice(0, 200)}`)
    }
  }

  const payloads: unknown[] = []
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('')
    if (!data || data === '[DONE]') continue
    try {
      payloads.push(JSON.parse(data))
    } catch {
      // Ignore keep-alive comments and partial frames; a real result will parse.
    }
  }
  return payloads
}

/** Find the reply matching our request id (SSE streams may also carry unrelated notifications). */
export function pickResponse(payloads: unknown[], id: number): { result?: unknown; error?: McpJsonRpcError } | null {
  for (const p of payloads) {
    if (!p || typeof p !== 'object') continue
    const msg = p as { id?: unknown; result?: unknown; error?: McpJsonRpcError }
    if (msg.id === id) return { result: msg.result, error: msg.error }
  }
  return null
}

/**
 * One JSON-RPC request. Returns the raw result plus the response headers, because
 * `initialize` needs the session id that comes back in a header rather than the body.
 */
export async function mcpRequest(
  transport: McpTransport,
  method: string,
  params: Record<string, unknown> = {},
  id = 1
): Promise<{ result: unknown; response: Response }> {
  const doFetch = transport.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), transport.timeoutMs ?? 30_000)

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (transport.token) headers.authorization = `Bearer ${transport.token}`
  if (transport.sessionId) headers['mcp-session-id'] = transport.sessionId

  try {
    const response = await doFetch(transport.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: controller.signal,
    })

    const body = await response.text()

    // Auth failures are worth surfacing verbatim — Zoho puts the real reason in the body.
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `MCP rejected the request with HTTP ${response.status}. ` +
          (body.trim().slice(0, 300) || 'No body.') +
          ' The access token is missing, expired or lacks the required scope.'
      )
    }
    if (!response.ok) {
      throw new Error(`MCP returned HTTP ${response.status}: ${body.trim().slice(0, 300) || '(no body)'}`)
    }

    const payloads = parseMcpBody(response.headers.get('content-type') || '', body)
    const reply = pickResponse(payloads, id)
    if (!reply) {
      throw new Error(`MCP returned no JSON-RPC reply for "${method}": ${body.trim().slice(0, 300) || '(empty body)'}`)
    }
    if (reply.error) {
      throw new Error(`MCP error ${reply.error.code}: ${reply.error.message}`)
    }
    return { result: reply.result, response }
  } finally {
    clearTimeout(timeout)
  }
}

/** A notification (no id, no reply expected) — used for `notifications/initialized`. */
export async function mcpNotify(
  transport: McpTransport,
  method: string,
  params: Record<string, unknown> = {}
): Promise<void> {
  const doFetch = transport.fetchImpl ?? fetch
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (transport.token) headers.authorization = `Bearer ${transport.token}`
  if (transport.sessionId) headers['mcp-session-id'] = transport.sessionId

  // Fire and forget: a server that answers 202 or 204 is behaving correctly, and a server
  // that rejects a notification is not a reason to fail the whole connection.
  try {
    await doFetch(transport.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    })
  } catch {
    // ignored on purpose
  }
}

/** initialize + notifications/initialized. Returns the negotiated session. */
export async function mcpInitialize(transport: McpTransport): Promise<McpSession> {
  const { result, response } = await mcpRequest(transport, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'nudge-engine', version: '1.0.0' },
  })

  const init = (result ?? {}) as {
    protocolVersion?: string
    serverInfo?: { name?: string; version?: string }
  }
  const sessionId = response.headers.get('mcp-session-id')

  const session: McpSession = {
    protocolVersion: init.protocolVersion || MCP_PROTOCOL_VERSION,
    sessionId,
    serverName: init.serverInfo?.name || 'unknown',
    serverVersion: init.serverInfo?.version || 'unknown',
  }

  await mcpNotify({ ...transport, sessionId }, 'notifications/initialized')
  return session
}

/** tools/list, tolerant of both `{tools:[…]}` and a bare array. */
export async function mcpListTools(transport: McpTransport, session?: McpSession): Promise<McpTool[]> {
  const { result } = await mcpRequest({ ...transport, sessionId: session?.sessionId ?? transport.sessionId }, 'tools/list', {}, 2)
  const r = (result ?? {}) as { tools?: McpTool[] } | McpTool[]
  if (Array.isArray(r)) return r
  return Array.isArray(r.tools) ? r.tools : []
}

/** Flatten MCP content blocks into text, and try to parse JSON out of it. */
export function flattenMcpContent(content: unknown): { text: string; json: unknown } {
  const blocks = Array.isArray(content) ? content : content == null ? [] : [content]
  const parts: string[] = []

  for (const b of blocks) {
    if (typeof b === 'string') {
      parts.push(b)
      continue
    }
    if (!b || typeof b !== 'object') continue
    const block = b as { type?: string; text?: string; data?: unknown; mimeType?: string; resource?: { text?: string } }
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'resource' && typeof block.resource?.text === 'string') parts.push(block.resource.text)
    else if (block.type === 'image' || block.type === 'audio') parts.push(`[${block.type}]`)
    else if (block.data !== undefined) parts.push(typeof block.data === 'string' ? block.data : JSON.stringify(block.data))
  }

  const text = parts.join('\n').trim()
  let json: unknown = null
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { text, json }
}

/**
 * tools/call. A tool that fails reports `isError: true` inside an HTTP 200 response — that is
 * a different thing from the call itself failing, and callers need to tell them apart.
 */
export async function mcpCallTool(
  transport: McpTransport,
  name: string,
  args: Record<string, unknown> = {},
  session?: McpSession
): Promise<McpCallResult> {
  const { result } = await mcpRequest(
    { ...transport, sessionId: session?.sessionId ?? transport.sessionId },
    'tools/call',
    { name, arguments: args },
    3
  )

  const r = (result ?? {}) as { content?: unknown; isError?: boolean; structuredContent?: unknown }
  const { text, json } = flattenMcpContent(r.content)

  return {
    ok: !r.isError,
    isError: Boolean(r.isError),
    text,
    json: json ?? r.structuredContent ?? null,
    raw: result,
    error: r.isError ? text || 'The tool reported an error.' : undefined,
  }
}

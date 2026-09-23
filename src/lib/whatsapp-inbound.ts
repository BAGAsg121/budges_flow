/**
 * Inbound WhatsApp message parsing.
 *
 * Dependency-free and path-alias free so it can be unit-tested directly, and because it is
 * the piece that decides what a customer's reply actually says.
 */

/** An inbound WhatsApp message, reduced to what we store. */
export interface InboundMessage {
  /** Free text the customer typed, or a readable stand-in for a button/list/media reply. */
  text: string
  /** Meta's message type: text, button, interactive, image, audio, document, … */
  type?: string
  /** Unix seconds from Meta, if provided. */
  timestamp?: number
}

/** How many inbound messages to keep per log row. */
export const INBOUND_KEEP = 20

export interface RawInboundMessage {
  type?: string
  text?: { body?: string }
  button?: { text?: string; payload?: string }
  interactive?: {
    type?: string
    button_reply?: { title?: string; id?: string }
    list_reply?: { title?: string; description?: string; id?: string }
  }
  image?: { caption?: string }
  video?: { caption?: string }
  document?: { filename?: string; caption?: string }
  audio?: unknown
  sticker?: unknown
  location?: { name?: string; address?: string; latitude?: number; longitude?: number }
  contacts?: unknown
  order?: unknown
  system?: { body?: string }
}

/**
 * Turn a Meta webhook message object into the text we store and show.
 * Falls back to a readable marker for media, so a reply is never silently blank.
 */
export function extractInboundText(msg: RawInboundMessage): string {
  if (msg.text?.body) return msg.text.body
  if (msg.button?.text) return msg.button.text
  if (msg.interactive?.button_reply?.title) return `[button] ${msg.interactive.button_reply.title}`
  if (msg.interactive?.list_reply?.title) return `[list] ${msg.interactive.list_reply.title}`
  if (msg.image?.caption) return `[image] ${msg.image.caption}`
  if (msg.video?.caption) return `[video] ${msg.video.caption}`
  if (msg.document) return `[document] ${msg.document.filename || ''} ${msg.document.caption || ''}`.trim()
  if (msg.location) {
    const l = msg.location
    return `[location] ${l.name || ''} ${l.address || ''} ${l.latitude ?? ''},${l.longitude ?? ''}`.trim()
  }
  if (msg.audio) return '[audio message]'
  if (msg.sticker) return '[sticker]'
  if (msg.contacts) return '[contact card]'
  if (msg.order) return '[order]'
  if (msg.system?.body) return `[system] ${msg.system.body}`
  return `[${msg.type || 'unknown'} message]`
}

/** Append a message to the capped history blob, returning the new encoded value. */
export function appendInbound(
  existing: string | null,
  message: InboundMessage
): { text: string; messages: string } {
  let history: { at: string; type?: string; text: string }[] = []
  try {
    const parsed = JSON.parse(existing || '[]')
    if (Array.isArray(parsed)) history = parsed
  } catch {
    history = []
  }
  const at = message.timestamp ? new Date(message.timestamp * 1000) : new Date()
  history.push({ at: at.toISOString(), type: message.type, text: message.text })
  if (history.length > INBOUND_KEEP) history = history.slice(-INBOUND_KEEP)
  return { text: message.text, messages: JSON.stringify(history) }
}

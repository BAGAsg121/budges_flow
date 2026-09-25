/**
 * A minimal ZIP reader, used to CHECK the .xlsx files this project writes.
 *
 * The workbook writer is hand-rolled (no dependency), so its output is verified rather than
 * trusted: read the archive back, inflate every entry, and compare against the declared sizes.
 * A corrupt workbook is the worst kind of export bug — the user cannot tell "no data" from
 * "broken file" — so this runs in the verify suite and as a self-check after every CLI export.
 *
 * Lives under scripts/ so production code carries no test-only helper.
 */
import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50

/**
 * @param {Buffer} buf
 * @returns {Map<string, {content: string, bytes: Buffer, crc: number, declaredSize: number, method: number}>}
 */
export function readZip(buf) {
  let eocd = -1
  // Scan backwards for the end-of-central-directory record.
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a ZIP: no end-of-central-directory record')

  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const files = new Map()

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIGNATURE) throw new Error(`corrupt central directory at byte ${p}`)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compressedSize = buf.readUInt32LE(p + 20)
    const declaredSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')

    // The local header repeats the name/extra lengths, which may differ from the central ones.
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buf.subarray(dataStart, dataStart + compressedSize)
    const bytes = method === 8 ? inflateRawSync(raw) : raw

    files.set(name, { content: bytes.toString('utf8'), bytes, crc, declaredSize, method })
    p += 46 + nameLen + extraLen + commentLen
  }

  return files
}

/**
 * Structural checks that a buffer really is a loadable workbook, not just a ZIP.
 * Returns a list of problems; empty means it looks good.
 */
export function validateXlsx(buf) {
  const problems = []
  let parts
  try {
    parts = readZip(buf)
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)]
  }

  for (const required of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']) {
    if (!parts.has(required)) problems.push(`missing part ${required}`)
  }
  if (!parts.has('xl/styles.xml')) problems.push('missing xl/styles.xml')

  const worksheets = [...parts.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
  if (!worksheets.length) problems.push('no worksheet parts')

  for (const [name, entry] of parts) {
    if (entry.bytes.length !== entry.declaredSize) {
      problems.push(`${name}: inflated to ${entry.bytes.length} bytes but declares ${entry.declaredSize}`)
    }
    if (entry.method === 0 && entry.bytes.length !== entry.declaredSize) {
      problems.push(`${name}: stored entry size mismatch`)
    }
  }

  // Every relation target must resolve, or Excel reports the workbook as repairable.
  const workbook = parts.get('xl/workbook.xml')?.content ?? ''
  const rels = parts.get('xl/_rels/workbook.xml.rels')?.content ?? ''
  const sheetNames = [...workbook.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => m[1])
  const relIds = [...workbook.matchAll(/r:id="([^"]*)"/g)].map((m) => m[1])
  for (const id of relIds) {
    if (!rels.includes(`Id="${id}"`)) problems.push(`workbook references ${id} but the rels do not define it`)
  }
  if (!sheetNames.length) problems.push('the workbook declares no sheets')

  // The XML must at least be balanced enough to parse: every <row …> closed, one root element.
  for (const name of worksheets) {
    const xml = parts.get(name).content
    const opens = (xml.match(/<row /g) || []).length
    const closes = (xml.match(/<\/row>/g) || []).length
    if (opens !== closes) problems.push(`${name}: ${opens} <row> open vs ${closes} closed`)
    if (!xml.startsWith('<?xml ')) problems.push(`${name}: missing XML declaration`)
    if ((xml.match(/<worksheet /g) || []).length !== 1) problems.push(`${name}: expected exactly one <worksheet> root`)
  }

  return problems
}

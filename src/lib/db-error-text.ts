/**
 * Turning database write failures into something an operator can act on.
 *
 * Kept separate from src/lib/message-log.ts — and free of any database import — for the same reason
 * src/lib/sequence.ts and src/lib/kyc-match.ts are: the verification suite runs without Prisma on
 * purpose, so the wording it asserts has to live somewhere importable.
 */

/**
 * Collapse a Prisma/MySQL error into one readable line.
 *
 * Prisma wraps driver errors in a multi-line string that buries the useful part (`INSERT command
 * denied`, `1142`) inside JSON. A run summary needs the gist, not the wrapper.
 */
export function describeLogError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const flat = String(raw).replace(/\s+/g, ' ').trim()
  // Prefer MySQL's own message when Prisma embedded one.
  const mysql = flat.match(/message:\s*"([^"]{5,200})"/)
  if (mysql) return mysql[1]
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat
}

/**
 * The warning shown when messages went out but their log rows could not be written.
 *
 * Deliberately blunt, and it must stay that way. The messages were delivered, we cannot prove to
 * whom, and the duplicate guard is blind to them — phrasing this as a mild notice would invite the
 * operator to simply run the nudge again, which is exactly the wrong response.
 */
export function logFailureWarning(count: number, sample?: string | null): string | null {
  if (!count || count <= 0) return null
  const samplePart = sample ? ` First error: ${sample}` : ''
  return (
    `${count} message(s) were SENT but their log rows could not be saved — the database rejected the write.` +
    ` Those sends are not in the history, so open/click/reply tracking and duplicate protection cannot see them.` +
    ` Fix the database write permission before running this nudge again.${samplePart}`
  )
}

/**
 * Copies the built Next.js static assets and public/ into .next/standalone so
 * `node .next/standalone/server.js` serves a complete app.
 * Cross-platform replacement for the old `cp -r` shell pipeline.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const standalone = join(root, '.next', 'standalone')

if (!existsSync(standalone)) {
  console.error('[postbuild] .next/standalone not found — is output:"standalone" still set in next.config.ts?')
  process.exit(1)
}

const copies = [
  [join(root, '.next', 'static'), join(standalone, '.next', 'static')],
  [join(root, 'public'), join(standalone, 'public')],
]

for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.log(`[postbuild] skip (missing): ${from}`)
    continue
  }
  mkdirSync(join(to, '..'), { recursive: true })
  cpSync(from, to, { recursive: true })
  console.log(`[postbuild] copied ${from} -> ${to}`)
}

console.log('[postbuild] done')

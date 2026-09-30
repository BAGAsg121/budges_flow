/**
 * A Node module-resolution hook that understands this project's `@/…` path alias.
 *
 * WHY: app modules import each other as `@/lib/db`, which Next resolves via tsconfig `paths` and
 * plain Node does not. That made every CLI script unable to import any module with an alias in its
 * dependency graph — which has repeatedly forced logic to be split or duplicated just to be
 * testable, and silently blocked diagnostics (whatsapp.ts, nudge-engine.ts, log-export.ts …).
 *
 * This teaches Node the same mapping, so a script can import the REAL code path instead of a
 * reimplementation of it.
 *
 * Registered by scripts/lib/register-alias.mjs:
 *   node --import ./scripts/lib/register-alias.mjs scripts/whatever.mjs
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

/** <repo>/scripts/lib -> <repo> */
const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** `@/lib/db` -> `<repo>/src/lib/db`, trying the extensions this project uses. */
function resolveAlias(specifier) {
  const withoutAlias = specifier.slice(2) // drop "@/"
  const base = resolvePath(repoRoot, 'src', withoutAlias)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return pathToFileURL(candidate).href
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const resolved = resolveAlias(specifier)
    if (resolved) return { url: resolved, shortCircuit: true }
    // Fall through so Node produces its normal, informative error.
  }
  // `next/server` and friends are extensionless entry points that Next's bundler resolves but
  // plain Node ESM does not (ERR_MODULE_NOT_FOUND: did you mean "next/server.js"?). Without this,
  // a script cannot import a route module to exercise the REAL handler — which is exactly what
  // scripts/.tmp-test-webhook.mjs does for the CRM webhook.
  if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes('://')) {
    try {
      return await nextResolve(specifier, context)
    } catch (err) {
      if (err && err.code === 'ERR_MODULE_NOT_FOUND' && !specifier.endsWith('.js')) {
        return nextResolve(`${specifier}.js`, context)
      }
      throw err
    }
  }
  return nextResolve(specifier, context)
}

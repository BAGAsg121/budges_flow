/**
 * Registers the `@/…` alias loader. Use with:
 *
 *   node --import ./scripts/lib/register-alias.mjs scripts/<script>.mjs
 *
 * Kept separate from the loader itself because a module-resolution hook must be registered before
 * the application modules are loaded, which `--import` guarantees.
 */
import { register } from 'node:module'

register('./alias-loader.mjs', import.meta.url)

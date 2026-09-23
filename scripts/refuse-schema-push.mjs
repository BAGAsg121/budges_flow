/**
 * Refuses to run a Prisma schema push/migrate.
 *
 * The app's three tables (nudge_lead, nudge_config, nudge_message_log) live inside the
 * Simplibank production database alongside ~1024 business tables.
 *
 * `prisma db push` and `prisma migrate` work by diffing your schema against the whole
 * database and making it match. On a shared production database that is not a safe
 * operation — it can propose dropping tables it does not know about, and one
 * --accept-data-loss flag away it will actually delete production data.
 *
 * Schema changes to the nudge_* tables must be a hand-reviewed, additive statement.
 * The three tables are created once by scripts/create-nudge-tables.mjs, which only ever
 * emits CREATE TABLE IF NOT EXISTS.
 */
console.error(`
Refusing to run \`prisma db push\` / \`prisma migrate\`.

  These tables share a database with live production data. Prisma's schema push
  diffs against the ENTIRE database and can propose destroying tables it does not
  know about. Never run it here.

  To create the three app tables (safe + idempotent):
      npm run db:create-tables

  To change them later, write an explicit additive statement by hand, review it,
  and run it once against nudge_lead / nudge_config / nudge_message_log only.

  Read-only checks of the external business data:  npm run db:check
  Generate the Prisma client after a schema edit:   npm run db:generate
`)
process.exit(1)

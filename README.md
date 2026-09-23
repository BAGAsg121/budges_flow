# Nudge Engine

Zoho CRM leads → email **and** WhatsApp nudges → send logs with open/reply tracking.

Replaces the original n8n + Google Sheets flow (see `upload/` for the source workflows).

- **Stack:** Next.js 16 (App Router) · TypeScript · Tailwind v4 · shadcn/ui · Prisma + SQLite
- **Channels:** Email over SMTP (nodemailer) · WhatsApp over the Meta Cloud API (approved templates)
- **Sequences:** per-lead history decides first send / follow-up after N days / stop on reply or max

---

## Requirements

- **Node.js 20.9+** (24.x recommended — `npm run seed:whatsapp` uses native TypeScript stripping)
- A writable path for the SQLite file (`db/custom.db`)

## Setup

```bash
npm install                 # runs `prisma generate` via postinstall
npm run db:push             # create/update db/custom.db from prisma/schema.prisma
npm run dev                 # http://localhost:3000
```

Then open http://localhost:3000 and sign in with `APP_USERNAME` / `APP_PASSWORD` from `.env`.

> `npm run dev` prints a browser Basic-auth prompt. That is the built-in login — there is no
> user database; credentials come from `.env`.

### Production

```bash
npm run build               # next build + copies static/public into .next/standalone
npm start                   # node .next/standalone/server.js  (PORT env, default 3000)
```

`npm start` serves the standalone build. Use `npm run start:next` only if you build without
`output: "standalone"`.

### Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server on :3000 |
| `npm run build` / `npm start` | Production build / standalone server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify` | In-process checks for templating, escaping and shared-secret auth |
| `npm run db:check` | Ping the external Simplibank MySQL, list tables, verify read-only |
| `npm run lint` | ESLint |
| `npm run db:push` | Apply schema changes (safe) |
| `npm run db:push:force` | Apply with `--accept-data-loss` (drops data) |
| `npm run db:studio` | Prisma Studio |
| `npm run seed:whatsapp` | Idempotently add the WhatsApp twin nudge |

---

## Environment (`.env`)

`.env` is git-ignored and holds every credential. Groups:

| Group | Keys | Notes |
| --- | --- | --- |
| App store | `DATABASE_URL`, `PRISMA_LOG_QUERY` | MySQL DSN into `ekodb_icici`; the app's own three tables live there (see below) |
| Simplibank MySQL | `SB_READ_HOST`, `SB_WRITE_HOST`, `SB_USER`, `SB_PASSWORD`, `SB_NAME`, `SB_PORT`, `SB_CONNECTION_LIMIT`, `SB_CONNECT_TIMEOUT_MS`, `SB_LOG_QUERY` | Connection details for the external business data — read **read-only** through `src/lib/sb-db.ts` |
| Access control | `AUTH_ENABLED`, `APP_USERNAME`, `APP_PASSWORD` | Basic auth over the whole app |
| Scheduler | `SCHEDULER_ENABLED`, `SCHEDULE_INTERVAL_MINUTES`, `SCHEDULE_SYNC_FROM_ZOHO`, `NUDGE_MAX_PER_RUN`, `CRON_SECRET` | |
| Zoho CRM | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_API_BASE`, `ZOHO_ACCOUNTS_BASE`, `ZOHO_ACCESS_TOKEN` | Refresh-token flow; the static token is a fallback only |
| Zoho Mail | `ZOHO_MAIL_*` | Kept from the n8n flow for reference / IMAP |
| SMTP | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | `SMTP_USER`/`SMTP_PASS` must be filled in to send |
| Reply tracking | `IMAP_ENABLED`, `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE`, `IMAP_USER`, `IMAP_PASS`, `IMAP_MAILBOX`, `IMAP_REPLY_LOOKBACK_DAYS`, `EMAIL_WEBHOOK_SECRET` | |
| Tracking URL | `APP_BASE_URL`, `APP_HOST` | Empty → derived from the request |
| WhatsApp (Meta) | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_API_VERSION`, `WHATSAPP_DEFAULT_CC`, `WHATSAPP_DISPLAY_NUMBER`, `WHATSAPP_EMPTY_PARAM_FALLBACK` | |
| Legacy n8n / Infinito | `NUDGE_LEGACY_*`, `INFINITO_*` | Preserved values, not used by this app |

**Never commit `.env`.** All credentials live here, not in source or in `upload/`.

---

## Two stores inside one MySQL server

Both live on the same MySQL 5.7.29 server, but they are strictly separate:

| | App store (Prisma) | Business data (`src/lib/sb-db.ts`) |
| --- | --- | --- |
| Tables | `nudge_lead`, `nudge_config`, `nudge_message_log` | `csp_application`, `csp_docs`, … (~1024 tables) |
| Access | read + write, via Prisma models | **read-only** |
| Purpose | what the app *records* (send ledger, nudge config, lead cache) | what the app *reads* to decide who to nudge |

The three app tables are prefixed `nudge_` precisely because that database already contains its
own `messagelog` — an un-prefixed `MessageLog` would have collided.

### Creating the app tables

```bash
npm run db:create-tables     # CREATE TABLE IF NOT EXISTS ×3, idempotent, nothing else touched
```

`scripts/create-nudge-tables.mjs` is the only thing that may create these tables. It emits exactly
three `CREATE TABLE IF NOT EXISTS` statements and refuses to run if the file ever contains a
`DROP`/`ALTER`/`TRUNCATE`/`DELETE`. Re-running it is a no-op.

> ⚠️ **Never run `prisma db push` or `prisma migrate` against this database.** Prisma diffs your
> schema against the *entire* database and can propose destroying tables it does not recognise —
> one `--accept-data-loss` away from deleting production data. The `db:push*` scripts are wired to
> `scripts/refuse-schema-push.mjs` and will exit with an explanation. Change these three tables with
> a hand-reviewed additive statement instead.

### Reading the business data

```ts
import { queryRead, queryReadOne } from '@/lib/sb-db'

const apps = await queryRead(
  'SELECT Id, csp_number, customer_id, submittedAt FROM csp_application WHERE submittedAt >= ? ORDER BY submittedAt DESC LIMIT 50',
  [since]
)
```

Read-only is enforced in three layers:

1. `assertReadOnly()` — only `SELECT`/`SHOW`/`DESCRIBE`/`EXPLAIN`/`WITH`, one statement, no stacking.
2. `SET SESSION TRANSACTION READ ONLY` on every pooled connection.
3. No write helper is exported at all.

Layer 3 is the contract; 1 and 2 are defence in depth.

Verify connectivity any time:

```bash
npm run db:check        # ping, table list, column dump, and a write-rejection check
```

or `GET /api/db/health?tables=1` (behind the app password); add `&describe=csp_application` for
column metadata.

> Verified against `ekodb_icici` (MySQL 5.7.29): business reads work, session is read-only and a
> `DELETE` is rejected; the three `nudge_*` tables were created in one pass (1024 → 1027 tables)
> and Prisma reads and writes them.

---

## Built-in nudges

All defined in `src/lib/nudge-defaults.ts` (single source of truth for the Zoho criteria and
every template). `GET /api/nudges` creates any that are missing; it never updates an existing
row, so UI edits are safe. Refresh definitions deliberately with:

```bash
npm run seed:nudges           # create-if-missing + targeting report
npm run seed:nudges -- --force   # also refresh templates/filters on existing rows
```

| Key | Trigger | Who it targets |
| --- | --- | --- |
| `onboarding_started_agreement` | Zoho sync | status = `Onboarding Started` → asks them to complete agreement signing |
| `documents_pending` | Zoho sync | status = `Agreement Signed` **and** `KYC_Document_Upload_Count <= 10` → complete the document upload |
| `onboarded_transacting` | **Manual — Google Sheet** | expiring-discount activation-fee reminder with a pay CTA |
| `onboarded_not_transacting` | **Manual — Google Sheet** | account-activated + integration next steps, then the discount reminder with a pay CTA |
| `documents_pending_wa` | Zoho sync | WhatsApp twin of `documents_pending` (disabled until Meta approves the template) |

### Two things that will bite you

**Status values contain spaces, not underscores.** The real CRM values are `Onboarding Started`,
`Agreement Signed`, `Unqualified (Junk)` — *not* `Onboarding_Started`. A filter written with
underscores silently matches nothing.

**KYC is complete at 11.** So "pending" means `< 11`, which is `maxKycCount: 10` in the filters.
The original `<= 11` form included three leads that are already complete.

### Fetch criteria vs. nudge filters

The Zoho fetch is deliberately broad:

```
((Business_vertical:equals:EPS)and(Created_Time:greater_than:2026-08-01T00:00:00+05:30))
```

No KYC filter and no status filter — every EPS lead since 1 Aug is pulled in, and the
status/KYC decisions happen locally in each nudge's `filters`. (The old criteria filtered KYC at
fetch time *and* excluded `not_equal:Unqualified`, which never matched anything, because the real
value is `Unqualified (Junk)`.)

Move the window by editing `ZOHO_LEADS_CREATED_AFTER` in `nudge-defaults.ts`. It has no upper
bound, so it always runs "up to now". Leads synced earlier stay in the local table and keep being
nudged until their status changes — add `createdAfter` to a nudge's filters if you want to exclude
them.

### Manual / sheet nudges

A nudge with `zohoCriteria: null` is manual: it is never run against synced leads. The UI hides its
**Run**/**Preview** buttons (running it would otherwise email every synced lead with an address) and
shows a *Manual / Sheet* badge plus a **Send from Sheet** button.

Paste a sheet URL shared as *"Anyone with the link can view"*. The CSV parser lower-cases headers
and turns spaces into underscores, so `Mobile Number` becomes `{{mobile_number}}`. Any column
becomes a `{{variable}}`.

The pay CTA uses `{{mobile_digits}}`, which accepts `mobile`, `mobile_number`, `phone`,
`phone_number`, `contact`, `contact_number` or `whatsapp` and normalises `+91 98765 43210` /
`09876543210` / `919876543210` all down to `9876543210`, so the link stays valid.

---

## HTTP surface

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET/POST /api/nudges` | Basic | List / create nudges |
| `GET/PATCH/DELETE /api/nudges/{id}` | Basic | Read / update / delete one nudge |
| `POST /api/nudges/{id}/run` | Basic | Run now (`{ "sync": true }`) |
| `GET /api/nudges/{id}/preview` | Basic | Dry run — who would send / skip |
| `POST /api/zoho/sync` | Basic | Pull leads for a criteria string |
| `GET /api/leads`, `GET /api/logs`, `GET /api/stats` | Basic | Data for the UI |
| `GET /api/scheduler` | Basic | Scheduler status |
| `GET /api/db/health` | Basic | External MySQL connectivity (`?tables=1`, `?describe=<table>`) |
| `GET /api/track/open/{trackingId}` · `GET /api/track/open?tid=` | **public** | Email open pixel (always returns a 1×1 GIF) |
| `GET/POST /api/track/whatsapp` | **public** | Meta webhook (verify handshake + statuses + inbound) |
| `GET/POST /api/track/email` | shared secret | Inbound reply webhook |
| `POST /api/cron/run` | shared secret | Run one full cycle now |
| `GET/POST /api/cron/replies` | shared secret | Poll the mailbox for replies only |

Shared-secret callers pass `x-cron-secret` / `x-webhook-secret`, `Authorization: Bearer <secret>`,
or `?secret=`.

---

## Scheduling

Two options; both call the same code path:

1. **In-process** (default) — `SCHEDULER_ENABLED=true`. Started by `src/instrumentation.ts`; runs
   every `SCHEDULE_INTERVAL_MINUTES`, plus one cycle ~15 s after boot.
2. **External cron** — `POST /api/cron/run` with `CRON_SECRET`. Example (Windows Task Scheduler
   or any HTTP cron):

   ```bash
   curl -X POST http://localhost:3000/api/cron/run -H "x-cron-secret: $CRON_SECRET"
   ```

Each nudge sends at most `NUDGE_MAX_PER_RUN` messages per cycle, so a cycle can never run past a
request timeout; leftover leads are deferred to the next cycle (shown as `deferred` in the UI).

## Tracking setup

- **Email opens** — added automatically as a 1×1 pixel. Set `APP_BASE_URL` to a publicly reachable
  URL, or opens from recipients' inboxes will not resolve.
- **Email replies** — either set `IMAP_ENABLED=true` with mailbox credentials (the scheduler polls
  and matches `In-Reply-To`/`References` against sent message-ids), or point a provider webhook at
  `POST /api/track/email` with `EMAIL_WEBHOOK_SECRET`.
- **WhatsApp** — register the sending number in Meta, approve a template, fill `WHATSAPP_TOKEN` +
  `WHATSAPP_PHONE_NUMBER_ID`, and set the Meta webhook to `{APP_BASE_URL}/api/track/whatsapp` with
  `WHATSAPP_VERIFY_TOKEN`. Deliveries/reads and inbound replies update the logs automatically.

## Deploying to Render

Current service: `nudge-engine` → https://nudge-engine.onrender.com (repo `BAGAsg121/budges_flow`).

### Storage on the free plan

The app's data now lives in MySQL, **not** on the instance's filesystem, so Render's
"free instances do not support persistent disks" limitation no longer causes data loss. Send
history, sequence state and tracking IDs all survive deploys, restarts and spin-downs.

Two free-tier behaviours still matter, and both are about *timing*, not data:

| Free-tier behaviour | Effect | Mitigation |
| --- | --- | --- |
| Spins down when idle | The in-process scheduler never fires, so automatic nudges silently stop | Keep `SCHEDULER_ENABLED=false` and drive `POST /api/cron/run` from an external cron |
| Cold start (~30–60 s) | Mail clients time out fetching tracking pixels, so opens on a sleeping instance are lost | Point a keep-alive pinger at `/api/health`, or move to a paid always-on instance |

`deploy/render.yaml` is a reference blueprint (deliberately not at the repo root so Render does
not offer to create a second service).

### Dashboard settings

| Field | Value |
| --- | --- |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |
| Env vars | everything in `.env.example` — fill values in the dashboard, **not** in a committed `.env` |

No database step is needed at build time: the three app tables already exist in MySQL and are
created once with `npm run db:create-tables`, not on every deploy.

Set `APP_BASE_URL=https://nudge-engine.onrender.com`, otherwise tracking pixels will be
written with a `localhost` URL and never register. Also make sure the MySQL server accepts
connections from Render — Render's outbound IPs are not static on the free/Starter tier, so an
IP allow-list on that box would block the deploy even though your laptop can reach it.

### Scheduling on a host that sleeps

With `SCHEDULER_ENABLED=false`, drive runs externally — the request itself wakes the
instance:

```bash
curl -X POST https://nudge-engine.onrender.com/api/cron/run \
  -H "x-cron-secret: $CRON_SECRET"
```

A free cron service (e.g. cron-job.org) every 15 minutes works. Expect the first request
after a sleep to take ~30–60 s.

---

## Security notes

> **This repository is public.** `.env` and `db/custom.db` were committed before they were
> git-ignored, and .gitignore does not untrack files that are already tracked. They have been
> removed from the index, but they remain in git *history* — so **every credential they ever
> contained must be rotated.**

- Every mutating route sits behind Basic auth. The only public endpoints are `/api/health`
  (liveness only), the tracking routes (inboxes and Meta cannot authenticate) and `/api/cron/*`
  (shared-secret checked in-route).
- Credentials belong in `.env` locally and in the host's environment dashboard when deployed —
  never in a committed file. `.env.example` is the committed template with no values.
- Basic auth is enforced by edge middleware, so in a **production** build `APP_PASSWORD` /
  `APP_USERNAME` are baked in at `npm run build` time — change them and rebuild. `npm run dev`
  re-reads `.env` on restart.
- Next 16 logs a deprecation warning for the `middleware.ts` file convention (the successor is
  `proxy.ts`). It still works and is left as-is because auth depends on it; migrate deliberately
  with `npx @next/codemod@canary middleware-to-proxy .` and re-test both the app and `/api/track/*`
  if you want the warning gone.

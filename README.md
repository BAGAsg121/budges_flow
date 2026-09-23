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
| Database | `DATABASE_URL`, `PRISMA_LOG_QUERY` | The app's own SQLite store (`file:../db/custom.db`, relative to `prisma/`) |
| Simplibank MySQL | `SB_READ_HOST`, `SB_WRITE_HOST`, `SB_USER`, `SB_PASSWORD`, `SB_NAME`, `SB_PORT`, `SB_CONNECTION_LIMIT`, `SB_CONNECT_TIMEOUT_MS`, `SB_LOG_QUERY` | External business DB — **read-only**, see below |
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

## External database: Simplibank MySQL (read-only)

`src/lib/sb-db.ts` holds a pooled, **read-only** connection to the business database the original
n8n CSP/WhatsApp flows read from (`csp_application`, `customer_agreement_history`, `csp_docs`, …).
It is completely separate from the app's own SQLite store.

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

Layer 3 is the contract; 1 and 2 are defence in depth. Also grant `appuser` SELECT-only rights
server-side.

Verify connectivity any time:

```bash
npm run db:check        # ping, table list, column dump, and a write-rejection check
```

or `GET /api/db/health?tables=1` (behind the app password); add `&describe=csp_application` for
column metadata.

> Verified working against `ekodb_icici` (MySQL 5.7.29): connection ok, session read-only, 1024
> tables visible, and a `DELETE` attempt is rejected by the guard.

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

## Security notes

- Every mutating route sits behind Basic auth. The only public endpoints are the tracking ones,
  which cannot authenticate (inboxes, Meta).
- The credentials originally pasted into the n8n workflows were moved into `.env` and redacted from
  `upload/*.txt`. **Rotate them anyway** — they were committed in plain text at some point.
- `db/custom.db` holds real lead and message data and is git-ignored.
- Basic auth is enforced by edge middleware, so in a **production** build `APP_PASSWORD` /
  `APP_USERNAME` are baked in at `npm run build` time — change them and rebuild. `npm run dev`
  re-reads `.env` on restart.
- Next 16 logs a deprecation warning for the `middleware.ts` file convention (the successor is
  `proxy.ts`). It still works and is left as-is because auth depends on it; migrate deliberately
  with `npx @next/codemod@canary middleware-to-proxy .` and re-test both the app and `/api/track/*`
  if you want the warning gone.

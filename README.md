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
| `npm run mcp:check` | Zoho MCP config + OAuth discovery |
| `npm run mcp:register` | Prove dynamic client registration against Zoho |
| `npm run mcp:tools` | Connect and list every MCP tool (read-only) |
| `npm run email:check` | Email transport config, or send a real test |
| `npm run mail:diagnose` | Raw Zoho Mail API responses, varying one field at a time |
| `npm run engage:report` | Per-family engagement split, straight from the database (sanity-checks the charts) |
| `npm run nudges:set-cap` | Set the per-lead message cap on the four activation-fee nudges (dry run; `--apply` to write) |
| `npm run db:push` | Apply schema changes (safe) |
| `npm run db:push:force` | Apply with `--accept-data-loss` (drops data) |
| `npm run db:studio` | Prisma Studio |
| `npm run seed:whatsapp` | Idempotently add the WhatsApp twin nudge |

---

## The interface

A sidebar shell (a mobile drawer below `lg`, plus a swipeable tab strip) over five tabs:

| Tab | What it is for |
| --- | --- |
| **Dashboard** | Delivery, opens, replies and scheduler state, plus per-nudge engagement for the two activation-fee families |
| **Leads** | EPS leads synced from Zoho CRM with status and KYC progress |
| **Nudges** | Every flow, which template it uses, and whether it is running |
| **Templates** | WhatsApp templates and their Meta approval state, plus the email copy |
| **Logs** | Every message, why any failed, and what customers actually replied |
| **Failures** | Every failed send on both channels, with per-row and bulk retry through the original nudge |

The **Connections** panel at the bottom of the sidebar answers "is this actually wired up?" without
spending an API call: database, Zoho CRM REST, Zoho CRM MCP, WhatsApp and email, each with the names
of any missing variables. `off` means deliberately unconfigured and is not treated as an error —
only the database reads as a problem. `GET /api/status` is the same data as JSON.

Colour is meaningful rather than decorative: the palette is a violet-indigo brand over cool slate,
with real `success` / `warning` / `info` / `destructive` tokens that work in **light and dark**.
Dark mode follows the OS by default and can be pinned from the toggle in the header. Previously the
theme was pure greyscale and status colours were hardcoded `emerald-600` / `amber-500` classes,
which read as flat in light mode and harsh in dark.

Both header sync buttons hit the same endpoint with a different window — see
[Zoho CRM: MCP first, REST fallback](#zoho-crm-mcp-first-rest-fallback).

### Sheet-driven WhatsApp nudges

Three exist. All are **manual** — paste a Google Sheet URL in the UI — and all ship **disabled** until
their template is approved.

| Nudge key | Template | Button |
| --- | --- | --- |
| `whatsapp_onboarded_transacting` | `activation_fee_pending_transacting` | Pay Now → pay-activation-fee |
| `whatsapp_onboarded_not_transacting` | `activation_fee_pending_not_transacting` | Pay Now → pay-activation-fee |
| `whatsapp_ip_whitelisting` | `ip_whitelisting_mandatory` | **none** |

The button belongs to the **template spec**, not to the family. `whatsapp_ip_whitelisting` is a
security notice whose call to action is "email your static IP to eps.support@eko.in" — nothing to
click — so it deliberately declares no button. A shared "sheet flows always get the pay button"
default would have pointed partners at a payment page while asking them for an IP address, and the
button's `{{1}}` would have been a parameter the template does not declare, which Meta rejects with a
parameter-count mismatch. `whatsappParams` is therefore `{ "body": [] }` for it and
`{ "body": [], "button": ["mobile_digits"] }` for the two pay nudges.

The whitelisting notice also has **no email twin**, so it has no fallback — the send is WhatsApp or
nothing, and a failure appears in the Failures tab for a manual retry.

To add another: add an entry to `WA_SHEET_FLOW_TEMPLATES` in `src/lib/nudge-defaults.ts`, then

```bash
npm run seed:nudges                        # creates the nudge row, disabled
npm run wa:templates -- --create-missing    # submits the template to Meta as UTILITY
```

### Retrying failures

The **Failures** tab lists every failed send on both channels and can re-send them. Each failure is
translated into plain English (the same translators the Logs tab uses), tagged **retryable** or not,
and grouped by cause with counts. There is a per-row **Retry** and a header **Retry all failed**.

A retry re-sends through **the nudge the message originally belonged to**, rebuilding the exact
variables the first attempt used:

- **Lead-driven** sends rebuild from the lead, exactly as `runNudge` does.
- **Sheet-driven** sends re-fetch the source sheet from the URL recorded on the log and find the
  matching row again — their variables live nowhere else. If the sheet is unreachable the retry fails
  loudly rather than sending a body with an empty mobile link. The column pickers and mobile
  normalisation are shared with `sheet-run` (`src/lib/sheet-vars.ts`), so a retry cannot render a
  subtly different message from the original.

Guard rails, all deliberate:

| Rule | Why |
| --- | --- |
| Only `sentOk = false` rows are eligible | A retry never re-sends a success |
| Already-recovered failures are skipped | Pressing the button twice does not message everyone twice |
| Non-retryable errors are skipped | An undeliverable number or a missing template fails identically forever |
| Anyone who replied is skipped | They answered; retrying should not mean ignoring that |
| Sequential, capped batch | The original failure was often *caused* by sending too fast |

The original failure row is **never mutated** — it is the audit trail of a real attempt. The retry
writes a new row, and "recovered" is derived at read time by looking for a later success against the
same nudge and address. That needed no new column on a production table.

### Activation-fee engagement

The Dashboard carries a section for the two onboarding nudge families — **onboarded but not
transacting** and **onboarded and transacting** — each of which exists twice, as an email nudge and
as its WhatsApp twin. For every channel it shows **sent, failed, opened and replied**, the accepted
percentage, the last-sent time, and (for WhatsApp) how many were dropped by Meta's cap.

**"Opened" means a different thing per channel**, and the UI labels it that way: for email it is the
tracking pixel, for WhatsApp it is Meta's `read` receipt. Both are stored on the same `opened`
column, which is why one endpoint can report both.

Below that, one history chart per family with a **Email / WhatsApp** toggle, plotting sent, opened
and failed per day over a 7/14/30-day window. They are a toggle rather than six series on one axis
because at 14 days the bars overlap into noise. Each chart names the nudge key it is counting.

> **A bug worth knowing about, because the screen could not show it.** The two charts were once fed a
> single daily series built across all four nudges, so both families plotted *identical* graphs — and
> the numbers were plausible enough that nothing looked wrong. The response no longer carries a
> combined series at all: each family has its own `series`, built by `buildDailySeries()` from an
> explicit list of nudge ids, so the same mistake cannot be made by picking the wrong field.
>
> Check the split independently of the UI:
>
> ```bash
> npm run engage:report          # last 7 days, per family, straight from the database
> npm run engage:report 30
> ```
>
> If the two families print the same numbers there, the split is genuinely broken. In production they
> differ — on 23 Sep the not-transacting WhatsApp nudge sent 30 / failed 28, the transacting one sent
> 33 / failed 16.

The four nudges allow **3 messages per lead, spaced 2 days apart**. The spacing is not decoration:
with `maxEmailsPerLead: 3` and `followUpDays: 0` the scheduler would fire all three on consecutive
cycles — three messages in a few hours, which is both spam and an instant way to hit Meta's
per-user marketing cap. Change it with:

```bash
npm run nudges:set-cap                      # dry run, shows a before/after per nudge
npm run nudges:set-cap -- --apply --max 3 --follow-up-days 2
```

That script exists instead of `seed:nudges --force` because `--force` rewrites *every* field,
including templates edited in the UI. It touches two columns on four rows, prints a diff, and never
touches `enabled` — pausing and resuming stays the operator's call.

---

## Environment (`.env`)

`.env` is git-ignored and holds every credential. Groups:

| Group | Keys | Notes |
| --- | --- | --- |
| App store | `DATABASE_URL`, `PRISMA_LOG_QUERY` | MySQL DSN into `ekodb_icici`; the app's own three tables live there (see below) |
| Simplibank MySQL | `SB_READ_HOST`, `SB_WRITE_HOST`, `SB_USER`, `SB_PASSWORD`, `SB_NAME`, `SB_PORT`, `SB_CONNECTION_LIMIT`, `SB_CONNECT_TIMEOUT_MS`, `SB_LOG_QUERY` | Connection details for the external business data — read **read-only** through `src/lib/sb-db.ts` |
| Access control | `AUTH_ENABLED`, `APP_USERNAME`, `APP_PASSWORD` | Basic auth over the whole app |
| Scheduler | `SCHEDULER_ENABLED`, `SCHEDULE_INTERVAL_MINUTES`, `SCHEDULE_SYNC_FROM_ZOHO`, `NUDGE_MAX_PER_RUN`, `CRON_SECRET` | ⚠️ `SCHEDULER_ENABLED=true` sends to real leads automatically once SMTP works |
| Zoho CRM | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_API_BASE`, `ZOHO_ACCOUNTS_BASE`, `ZOHO_ACCESS_TOKEN` | Refresh-token flow; this is the **fallback** path — MCP is preferred |
| Zoho CRM MCP | `ZOHO_MCP_URL`, `ZOHO_MCP_CLIENT_ID`, `ZOHO_MCP_CLIENT_SECRET`, `ZOHO_MCP_REFRESH_TOKEN`, `ZOHO_MCP_TOKEN`, `ZOHO_MCP_REDIRECT_URI`, `ZOHO_MCP_LEADS_TOOL`, `ZOHO_MCP_LEADS_ARGS` | CRM reads via Zoho's MCP server; the last three are optional pins. Nothing here is stored in the database |
| Zoho Mail | `ZOHO_MAIL_*` | Kept from the n8n flow for reference / IMAP |
| SMTP | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | `SMTP_USER`/`SMTP_PASS` must be filled in to send |
| Reply tracking | `IMAP_ENABLED`, `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE`, `IMAP_USER`, `IMAP_PASS`, `IMAP_MAILBOX`, `IMAP_REPLY_LOOKBACK_DAYS`, `EMAIL_WEBHOOK_SECRET` | |
| Tracking URL | `APP_BASE_URL`, `APP_HOST` | Empty → derived from the request |
| WhatsApp (Meta) | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_API_VERSION`, `WHATSAPP_TEMPLATE_LANGUAGE`, `WHATSAPP_DEFAULT_CC`, `WHATSAPP_DISPLAY_NUMBER`, `WHATSAPP_EMPTY_PARAM_FALLBACK`, `DELIVERY_CAP_BACKOFF_HOURS` | Sending, webhooks and template management all go directly to the Meta Cloud API |

There is **no third-party WhatsApp provider in this app** — no Infinito, no n8n. Every send,
every delivery/read receipt and every template operation talks to `graph.facebook.com`. The old
Infinito credentials from the n8n workflow have been removed from `.env`.

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

## Zoho CRM: MCP first, REST fallback

CRM data is read through **Zoho's own MCP server** rather than the REST API. The REST client
(`src/lib/zoho.ts`) is still there and still works — it is the fallback, not the primary path.

### Connecting (once)

```bash
npm run mcp:check        # config + OAuth discovery, no writes
npm run mcp:register     # prove dynamic client registration works
```

Then open **`<APP_BASE_URL>/api/zoho/mcp/connect`** in a browser and approve the consent screen.
Zoho redirects to `/api/zoho/mcp/callback`, which prints exactly three values:

```
ZOHO_MCP_CLIENT_ID=…
ZOHO_MCP_CLIENT_SECRET=…
ZOHO_MCP_REFRESH_TOKEN=…
```

Add them to the host's environment (Render → Environment) and redeploy. The callback is behind the
app password, so the refresh token is never public, and **nothing is written to the database** —
credentials live in the environment exactly like `ZOHO_*` and `ZOHO_MAIL_*`.

Set `ZOHO_MCP_URL` first; it is the `…/mcp/<server-id>/message` URL from Zoho.

### How it works

| Piece | File | Notes |
| --- | --- | --- |
| MCP transport | `src/lib/mcp-client.ts` | JSON-RPC over Streamable HTTP; handles both `application/json` and SSE replies, the `Mcp-Session-Id` handshake, and `tools/call` results that report failure *inside* an HTTP 200 |
| Zoho specifics | `src/lib/zoho-mcp.ts` | OAuth discovery, dynamic client registration, PKCE, refresh, tool selection |
| Connect flow | `src/app/api/zoho/mcp/connect` + `/callback` | One-time consent; prints the env block |
| General access | `GET/POST /api/zoho/mcp` | Status + full tool list; call **any** tool by name |

The access token is cached **in memory only** and refreshed a minute before expiry. Refresh tokens
from Zoho do not rotate on use, so the pasted value keeps working.

### Which tool reads Leads

The tool list is only knowable after connecting, so `pickLeadsTool()` scores names and descriptions.
Two things it learned the hard way against the live server:

- Zoho generates one MCP tool per API operation, and the **count** endpoint sits right beside the
  search one (`ZohoCRM_getRecordCount` vs `ZohoCRM_searchRecords`). A count tool returns a number,
  not records, so picking it makes a sync report "0 new leads" while looking perfectly successful.
  Count/aggregate names now score catastrophically; search/records names score up.
- Arguments are **nested** under `path_variables` / `query_params`, so a tool is only usable if its
  schema can actually carry a filter — which is worth real points. `buildLeadsToolArgs()` builds
  against the tool's own published `inputSchema` and **throws** when it cannot place the criteria,
  rather than sending empty arguments and reporting a successful sync of nothing.

Write-shaped names score down hard — a sync must never pick a tool that creates or deletes CRM
records. Pin the exact name with `ZOHO_MCP_LEADS_TOOL` once you have seen the list:

```bash
npm run mcp:tools                    # every tool, and which one it would use
npm run mcp:check -- --schema ZohoCRM_searchRecords   # the exact JSON Schema
```

Paging is handled: Zoho caps a search page at 200 records and reports `info.more_records`, so the
sync loops (bounded at 25 pages) and reports `truncated` if it ever hits the guard.

```
ZOHO_MCP_LEADS_TOOL=…    # exact tool name
ZOHO_MCP_LEADS_ARGS={"criteria":"{{criteria}}"}   # full override; {{criteria}} is substituted
```

### Sync windows

`POST /api/zoho/sync` takes a `window`:

| Body | Window |
| --- | --- |
| `{"window":"all"}` | every EPS lead created since **1 Aug 2026** |
| `{"window":"today"}` | same filter, created time moved to **01:00 today** (IST) |
| `{"criteria":"((…))"}` | explicit override; wins over `window` |

Both buttons in the header call this — **Sync today** and **Sync all leads**. The date is built in
the CRM's timezone (`+05:30`), not the server's: Render runs in UTC, where "today" would otherwise
start 5.5 hours late.

`via` controls the data path (`auto` by default). `auto` prefers MCP and falls back to the REST API
if the MCP call fails, reporting `via` and `fellBack` in the response — a silent fallback would hide
a broken MCP setup, so the UI says which path ran.

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

### Nudge sources

A nudge is driven by one of three sources. It is encoded in the existing `zohoCriteria` /
`filters` fields, so **no database column was added** — the shared production database is
untouched.

| Source | How it is marked | Audience |
| --- | --- | --- |
| Zoho (lead-driven) | `zohoCriteria` set | synced CRM leads |
| **MySQL (DB-driven)** | `filters.source = "mysql"` + `filters.flow` | live rows from the business database, read read-only |
| Manual / sheet | neither of the above | rows of a Google Sheet you paste in the UI |

The UI badges each card and only offers the buttons that make sense: **Run** for Zoho and MySQL
nudges, **Send from Sheet** for sheet nudges. Preview works on lead-driven nudges; for MySQL flows
`npm run wa:flows` shows the live recipient count instead.

### MySQL-driven WhatsApp flows

Ported from the n8n workflow, now talking to the Meta Cloud API instead of Infinito. All six ship
**disabled** until their template is approved.

| Flow key | Table | Fires when | Window |
| --- | --- | --- | --- |
| `csp_details_pending` | `csp_application` | pincode / alternate mobile / shop address missing | last 3h |
| `mobile_otp_pending` | `verify_csp` | `verifyAt` empty | last 2h |
| `pan_verification_pending` | `verify_csp` | mobile verified but `panNumber` empty | last 2h |
| `agreement_signature_pending` | `customer_agreement_history` | latest agreement `status <> 1` (not signed) | last 30 days |
| `documents_pending_upload` | `csp_docs` | any mandatory document never uploaded | last 30 days |
| `documents_reupload_required` | `csp_docs` | any mandatory document rejected (status 3) | last 30 days |

Notes:

- Reads go through `src/lib/sb-db.ts` — `SELECT` only, session read-only. **The app never writes to
  the business database.**
- A/B/C keep the n8n trigger intervals, because they are event-driven. D/E/F previously took their
  candidate list from a Google Sheet; with direct DB access the cohort is *recent CSP applications*,
  so the window is in days. Widen any window freely — de-duplication is per phone number, so a wider
  window means better coverage, not repeat messages.
- `csp_docs` has no `CREATED_AT` column, so the original n8n docs query could not have worked; the
  port queries the columns that actually exist and resolves the phone via `csp_application`
  (falling back to `verify_csp`).
- Document classification is ported from the n8n code node: the same required-document list, master
  doc ids and aliases, and the same priority when duplicates exist (approved > submitted > rejected).
- Recipients are de-duplicated by **phone**, and the shared sequence rules still apply (stop on reply,
  max sends per contact).
- Every button links to `https://eps.eko.in/console?mobile=<recipient mobile>`.

### Manual WhatsApp sheet nudges

`whatsapp_onboarded_transacting` and `whatsapp_onboarded_not_transacting` are the WhatsApp twins of
the two pay-activation-fee email nudges. Paste a Google Sheet URL in the UI; the sheet needs a mobile
column (any of `mobile`, `mobile_number`, `phone`, `phone_number`, `contact`, `contact_number`,
`whatsapp`). Their button links to `https://eps.eko.in/console/pay-activation-fee?mobile=<mobile>`.

> Only these two use the pay-activation-fee link. The six DB flows use the console link.

### Verifying the flows

```bash
npm run wa:flows        # live audit: template status, button, params, and recipient counts
npm run seed:nudges     # create-if-missing + a live per-flow recipient preview
```

### Editing templates

**Edit** on any WhatsApp template reopens the same form, prefilled. Two Meta rules matter:

- An **approved** (or rejected) template can be edited. The edit creates a new revision, so the
  template returns to **Pending** until Meta re-approves it.
- A template **in review is locked** — Meta refuses to edit it (error `2388003`). The dialog then
  offers an explicit **Replace** action, which deletes it and creates a fresh one with the same name.
  Meta can take a long time to release a deleted name (error `2388023`), so `createTemplate()` waits
  it out with retries, and a replace request can therefore take a minute or two.
- The **name and language are immutable** — Meta identifies a template by the pair.

Removing a template is deliberately never automatic: silently deleting a template the operator did
not ask to delete is worse than refusing.

`npm run wa:templates -- --resync` reapplies the curated copy from `nudge-defaults.ts` to any
template whose content has drifted, and **skips templates that already match** so approved ones are
never disturbed. `--verbose` prints each template's body.

### Email templates

Email has no external registry — a template *is* the nudge's subject and body, so there is nothing to
submit or approve. The Templates tab lists every email nudge with its subject and a body preview
(flagging any that are **incomplete**), and **Edit** jumps to that nudge's editor on the Nudges tab.

Current email nudges: `onboarding_started_agreement`, `documents_pending`, `onboarded_transacting`,
`onboarded_not_transacting`.

Every nudge card also states which template it sends — the Meta template name plus language for
WhatsApp, or the subject line for email.

### Pausing and enabling nudges

The scheduler only ever runs nudges that are **enabled**, so disabling them is the immediate,
deploy-free way to stop all sending.

- Each card has its own on/off switch.
- **Pause all** / **Resume all** in the header flips every nudge at once (`POST /api/nudges/bulk`).
- From the CLI: `npm run nudges off` / `on` / `status`.

> **`enabled` is operator state and is never touched by the seeding scripts.** Seed with
> `--force` refreshes a nudge's copy, criteria, filters and templates, and deliberately leaves
> `enabled` exactly as it was — otherwise a paused nudge would switch itself back on every time
> the copy was refreshed. Use `npm run nudges on` if you actually want to resume.

---

## Email transport

Two interchangeable transports. **`MAIL_TRANSPORT=auto`** (the default) prefers Zoho Mail when it is
configured, then falls back to SMTP.

| Transport | Credentials | Notes |
| --- | --- | --- |
| **Zoho Mail REST API** | `ZOHO_MAIL_CLIENT_ID`, `ZOHO_MAIL_CLIENT_SECRET`, `ZOHO_MAIL_REFRESH_TOKEN`, `ZOHO_MAIL_ACCOUNT_ID`, `ZOHO_MAIL_FROM_ADDRESS` | How the original n8n flow sent mail. Refresh-token based, so no mailbox password. |
| SMTP (nodemailer) | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Needs a mailbox **app password** — Zoho rejects the normal account password. |

> ⚠️ **This was the cause of every email failure.** The app originally spoke only SMTP, so the Zoho
> Mail credentials already sitting in `.env` were never used and all 839 email attempts failed with
> *"SMTP not configured"* while `SMTP_USER`/`SMTP_PASS` were empty. Zoho Mail is now the primary
> transport, which is the credential set that actually works.

```bash
npm run email:check                  # which transport is active, and why
npm run email:check you@example.com  # send a real test email
npm run email:check you@example.com --burst 5   # reproduce a sheet-run burst
```

### The real email failure: Zoho's account sending block

Zoho answers a rejected message with `status.description = "Internal Error"` and puts the **only
useful sentence** in `data.moreInfo`. The sender used to record just the former, so every rejection
became an indistinguishable `Internal Error (code 500)` — and that is how a hard account block
masqueraded as transient throttling.

The actual reason, once `moreInfo` is read:

```
550 5.4.6 Unusual sending activity detected. Please try after sometime.
```

That is **Zoho's anti-abuse block on the account, and it applies to external recipients only**.
Internal (same-domain) mail keeps working — which is exactly why a test to `do.not.reply@eko.co.in`
succeeds while every customer send fails. It is not a rate limit, not a content problem, and not a
credential problem; all three were ruled out by experiment (`npm run mail:diagnose` varies one field
at a time and prints Zoho's raw response).

**Retrying makes it worse** — Zoho lengthens the block for repeated attempts. So:

| Behaviour | |
| --- | --- |
| `moreInfo` is parsed and recorded | The error now names the real cause instead of "Internal Error" |
| A sending block is **not** retried | Returns after one attempt; the 4-attempt backoff is skipped entirely (measured: 497 ms instead of ~9 s) |
| Classified `sending blocked by Zoho`, not retryable | The Failures tab will not offer a retry that would extend the block |
| A bare `Internal Error` is also not retryable | On this account every one of those was the block; the transport already retried internally |

```bash
npm run mail:diagnose                    # raw Zoho responses, one variable at a time
npm run mail:diagnose someone@example.com
```

**What to do about the block.** It is Zoho's decision and it is not something code can lift: pause
email sending, then either wait it out or take it up with Zoho, and send from a warmed-up domain at a
sane volume afterwards. Note that simply switching to **SMTP on the same account will hit the same
policy** — a real fix for volume sending is a transactional provider (Zoho ZeptoMail, SES, Postmark,
SendGrid), which needs no code change: point `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`/`MAIL_FROM` at it and
set `MAIL_TRANSPORT=smtp`.

The spacing and jittered retry described below are still correct for genuine transient 5xx faults —
they were just not the cause of this one.

### Burst spacing and retry

Once Zoho Mail became the transport, a new failure appeared: **39 sends in a 34-second window, all
failing with `Zoho Mail API: Internal Error (code 500)`**, while a single send immediately afterwards
succeeded. Zoho reports burst throttling as a bare `500`, not a `429` — and the sender only ever
retried `401`, so every one of those was final.

Two fixes in `src/lib/zoho-mail.ts`:

| Fix | Detail |
| --- | --- |
| **Spacing** | A minimum gap between sends (`ZOHO_MAIL_MIN_GAP_MS`, default 1100 ms), enforced across concurrent callers so parallel sends queue instead of racing |
| **Retry** | `5xx`/`429`/"Internal Error" are retried with exponential backoff **plus jitter** (`ZOHO_MAIL_MAX_ATTEMPTS`, default 4). Jitter matters because a burst fails together and would otherwise retry together |

Verified by reproducing the failure mode: `--burst 5` now completes 5/5.

`src/lib/mail-errors.ts` translates these into plain English for the Failures tab, and marks each one
retryable or not — an "Internal Error" is offered for retry, a rejected recipient is not.

## Diagnosing failures

```bash
npm run diag:sends
```

Groups every failed send by channel and error, explains Meta's codes in plain English, and prints the
active configuration. The Logs tab does the same inline: a failed WhatsApp row's badge names the
cause (e.g. *failed · engagement cap*) and the tooltip carries Meta's raw text.

To prove a **deployment's** credentials work without running a nudge against real leads, hit
`GET /api/email/test` (reports the selected transport and which variables are missing, never their
values) and `POST /api/email/test` with an optional `{"to":"…"}`. The WhatsApp equivalent is
`/api/whatsapp/test`. Both run the same send path a nudge uses, so a success there is a real send,
and both are behind the app password.

### Why WhatsApp messages fail

Meta-side delivery failures are normal and are **not** app errors:

| Cause | Meaning |
| --- | --- |
| `engagement cap` (131049) | Meta's per-user **marketing frequency cap** — the recipient has had too much marketing recently. Needs their opt-in, or a UTILITY template. |
| `opted out of marketing` (131050) | The user is in a Meta experiment and has opted out of marketing. |
| `undeliverable` (131026) | The number is not on WhatsApp / is invalid / blocked the business. |
| `outside 24h window` (131047) | Free-form text needs the recipient to have messaged you within 24h. |
| `parameter mismatch` (132000) | The nudge sends a different number of parameters than the template declares. |

**Category matters.** Meta auto-categorises templates by their content. The two activation-fee
templates (`onboarded_transacting_pay`, `onboarded_not_transacting_pay`) were classified
**MARKETING** because of the discount wording, and marketing templates are subject to the frequency
cap above. In the first live batch of 58 sends, 30 were delivered and 28 were dropped by Meta for
exactly these reasons. They have since been replaced by UTILITY templates — see
[What was actually done about it](#what-was-actually-done-about-it).

### Fallbacks for the marketing cap

Three layers, in order of how much they help.

**1. Retry later, not every cycle.** A cap drop is not a permanent failure — the cap is a rolling
per-user window, so the same message is usually accepted a day later. The engine records the cap
failure and skips that recipient until `DELIVERY_CAP_BACKOFF_HOURS` (default **24**) has passed,
instead of re-attempting on every scheduler cycle and logging an identical failure each time. A
skipped recipient shows as **capped by Meta** in the run results, and is counted as `skipped`, not
`failed`.

**2. Fall back to email automatically.** The two manual WhatsApp nudges declare an `emailFallback` in
their filters (`whatsapp_onboarded_not_transacting` → `onboarded_not_transacting`, and the same for
the transacting twin). When a WhatsApp send is dropped for a cap **or** is undeliverable, the
sheet-run flow sends the email twin to that same person — the sheet supplies both the mobile and the
email — and logs it against the email nudge too, so email keeps its own de-duplication. A
configuration error (wrong template, bad parameters) is never masked by this fallback: only
"can't deliver" reasons trigger it. Counted in the run summary as `fallbackEmails`, and the WhatsApp
row is labelled **fell back to email**.

**3. Make the template UTILITY instead of MARKETING.** The root cause is the category, and the
category follows the wording. UTILITY templates are not subject to the marketing cap. Ready-made
transactional copy for both templates lives in `WA_UTILITY_SAFE_COPY` in `src/lib/nudge-defaults.ts` —
no discount or promo language, just "your activation fee payment is pending" with a **Pay Now**
button. To switch: open the template in the Templates tab, replace the body with that copy, save (it
returns to Meta review), and Meta should re-categorise it as UTILITY. Keep the promotional discount
line in the **email** nudge, where no such cap applies.

What no code can fix: if a user has genuinely opted out of marketing (131050) or is not on WhatsApp
at all (131026), only their opt-in or a different channel reaches them — which is what the email
fallback is for.

### What was actually done about it

The two activation-fee templates were rebuilt as **UTILITY** and the nudges repointed at them:

| Retired (MARKETING) | Now used (UTILITY) |
| --- | --- |
| `onboarded_transacting_pay` | `activation_fee_pending_transacting` |
| `onboarded_not_transacting_pay` | `activation_fee_pending_not_transacting` |

New names rather than edits, because an approved template's category cannot be changed by editing it —
the edit only re-triggers review and Meta re-derives the category from the same text. The old
approved templates are left on the WABA untouched: the send history references them, and deleting an
approved template is not reversible.

The promotional discount line now lives **only in the email twin**, where no cap exists. That is the
trade: uncapped WhatsApp delivery in exchange for moving the offer to email.

```bash
npm run wa:repoint            # dry run — shows the template switch per nudge
npm run wa:repoint -- --apply
npm run wa:templates -- --create-missing   # submits the UTILITY templates for review
```

## Reading customer replies

The WhatsApp webhook stores **what the customer actually wrote**, not just that they replied:

- `inboundText` — the most recent message body
- `inboundMessages` — a capped JSON history (`[{ at, type, text }]`, last 20)
- `inboundAt` — when the most recent one arrived

In the **Logs** tab, a replied row shows a speech-bubble button that opens the customer's message(s),
newest first. Text, quick-reply buttons, list selections and media (with captions) are all recorded;
media without a caption is stored as `[image]`, `[audio message]` and so on, so a reply is never
silently blank.

Those three columns were added to `nudge_message_log` with **additive `ALTER TABLE ... ADD COLUMN`
statements only** (`npm run db:add-inbound-columns`, dry-run by default) — no other table and no other
kind of change.

---

## HTTP surface

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET/POST /api/nudges` | Basic | List / create nudges |
| `GET/PATCH/DELETE /api/nudges/{id}` | Basic | Read / update / delete one nudge |
| `POST /api/nudges/{id}/run` | Basic | Run now (`{ "sync": true }`) |
| `GET /api/nudges/{id}/preview` | Basic | Dry run — who would send / skip |
| `POST /api/zoho/sync` | Basic | Pull leads for a criteria string, or `{ "window": "today" \| "all" }` |
| `GET/POST /api/zoho/mcp` | Basic | Zoho MCP status + tool list / call any MCP tool |
| `GET /api/zoho/mcp/connect` | Basic | Start the one-time Zoho MCP consent (redirects to Zoho) |
| `GET /api/zoho/mcp/callback` | Basic | Consumes the consent code, prints the env block |
| `GET /api/status` | Basic | Which integrations are wired up (booleans only) |
| `GET /api/stats/onboarding` | Basic | Per-family engagement totals + daily series (`?days=14`) |
| `GET /api/logs/failures` | Basic | Failed sends, explained, with `resolved` + `retryable` per row |
| `POST /api/logs/retry` | Basic | Re-send failures: `{ ids: […] }`, or `{ all: true, channel? }` |
| `GET/POST /api/whatsapp/test` | Basic | WhatsApp config check / one real test send |
| `GET/POST /api/email/test` | Basic | Email config check / one real test send (`{ "to": "…" }`, defaults to the from-address) |
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

## WhatsApp setup and testing

Three different Meta values are easy to confuse, and only two of them can send:

| Value | Looks like | What it does |
| --- | --- | --- |
| `WHATSAPP_TOKEN` | long, starts with `EAA` | **Sends messages.** A System User or temporary access token |
| `WHATSAPP_PHONE_NUMBER_ID` | ~15 digits, e.g. `123456789012345` | **Sends messages.** The Phone Number ID from WhatsApp Manager |
| `WHATSAPP_APP_SECRET` | 32 hex chars | **Cannot send.** Verifies `X-Hub-Signature-256` on incoming webhooks |

A 32-character hex string in `WHATSAPP_TOKEN` fails with
`Invalid OAuth access token - Cannot parse access token` (code 190). `WHATSAPP_DISPLAY_NUMBER`
(`9599722251`) is the sending number — it is *not* the Phone Number ID, and the WABA ID is a
third, different value again.

### Managing templates from the app

The **Templates** tab lists every template on the WABA with its live approval status, and lets you
submit new ones without leaving the dashboard.

| | |
| --- | --- |
| `GET /api/whatsapp/templates` | every template: name, language, category, status, rejection reason |
| `POST /api/whatsapp/templates` | submit a new one (returns `PENDING`) |
| `DELETE /api/whatsapp/templates?name=&language=` | remove one (Meta-side only) |

In the UI: **New template** opens a form (name, language, category, header, body, footer, optional URL
button). Validation runs locally first — name charset, category, 1024/60/25-character limits,
contiguous `{{1}}`… variables, `https://` on button URLs, and the rule that a URL variable must be a
single `{{1}}` at the very end. Example values for Meta are generated automatically.

New templates come back as **Pending review** and only become attachable once Meta approves them —
hit **Refresh status** to check. **Use in nudge** on an approved template sets that nudge's channel to
WhatsApp and stores the template name and language for you.

> ⚠️ **The language must match exactly.** Meta treats `en` and `en_US` as different locales, and a
> mismatch fails with `132001 — template name does not exist in the translation`, which reads like the
> template is missing. Always copy the language from the list rather than typing it.

Same operations from the CLI, using the identical module the API route calls:

```bash
npm run wa:templates                      # list with status flags
npm run wa:templates -- --create-test     # create + delete a self-test template
npm run wa:templates -- --create-missing  # create any template a WhatsApp nudge references but that does not exist
npm run wa:templates -- --delete NAME --lang en_US
```

`--create-missing` builds each template from the nudge's own **reference body**, so the nudge and the
Meta template cannot drift apart. It skips anything that already exists and refuses to create a
duplicate when the name exists in a different language (that is a language-mismatch bug, not a
missing template).

### Auditing the WhatsApp flows

```bash
npm run wa:flows
```

Read-only audit of every WhatsApp nudge against the live WABA. It reports whether each nudge's
template exists, is approved, has a matching language, and whether the nudge's parameter count
matches the template's variable count — the four ways a WhatsApp nudge silently fails to send.
Exits non-zero when something needs attention.

### Verify it works

```bash
npm run wa:check                 # validates the credential shapes, then sends a test message
npm run wa:check 9643520034      # explicit number
npm run wa:check -- --template hello_world --lang en_US   # send an approved template
npm run wa:check -- --list-templates                      # names + exact language codes
npm run wa:webhook               # reproduce Meta's webhook handshake
```

### Test lead and sample nudge

```bash
npm run test-lead                # creates the test lead (default number 9643520034)
npm run test-lead 9876543210     # a different number
npm run test-lead -- --delete    # remove it again, with its logs
```

The test lead is marked three ways: a `TEST-WHATSAPP-<number>` zohoId, a `WhatsApp Test` status,
and fake name fields. The `whatsapp_sample` nudge targets **only** that status, so it can never
reach a real lead — it resolves to exactly one lead. Enable the nudge and click **Run** to send it.

### The 24-hour rule

Business-initiated messages normally require an **approved template**. Free-form text (what
`whatsapp_sample` sends, since it has no template name) is only allowed when the recipient messaged
you in the last 24 hours, or is registered as a test recipient in the Meta dashboard. Outside that
window Meta returns an error and you must use a template — set the nudge's *Meta template name* and
it switches to template mode automatically.

### Webhooks

Point Meta at `{APP_BASE_URL}/api/track/whatsapp` with `WHATSAPP_VERIFY_TOKEN`. With
`WHATSAPP_APP_SECRET` set, incoming payloads are verified against `X-Hub-Signature-256` and
unsigned or forged requests are rejected with 403. Delivery/read receipts then mark messages
opened, and inbound replies mark them replied (which stops that lead's sequence).

Test the exact handshake Meta performs, before touching the Meta dashboard:

```bash
npm run wa:webhook                                  # uses APP_BASE_URL
npm run wa:webhook https://example.com              # explicit host
npm run wa:webhook -- --token <token>               # test a specific token value
```

It checks `/api/health` (is the service awake, and on the current build?), the subscribe
handshake (must echo `hub.challenge`), that a wrong token is refused with 403, and with `--post`
it can send a synthetic signature-verified status event.

In Meta: **WhatsApp → Configuration → Webhook → Edit**, paste the callback URL and verify token,
click **Verify and save**, then **Manage** the `messages` field subscription.

> On a host that sleeps, wake the app first (open the URL, wait for `/api/health` to return 200).
> Meta's verification request times out quickly, and a cold start looks like a failure.

---

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

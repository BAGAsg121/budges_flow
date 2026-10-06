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
| `npm run readiness` | **Dry run every nudge** — who it would message now, and any blockers |
| `npm run logs:export` | Export logs to .xlsx/.csv by date range, nudge, channel and status |
| `npm run logs:export:demo` | Write a workbook of invented rows, to confirm Excel opens the format |
| `npm run db:add-cta-columns` | Add the WhatsApp CTA click columns (dry run; `--apply` to write) |
| `npm run db:add-kyc-expected-column` | Add `kycDocumentsExpectedCount` to `nudge_lead` (dry run; `--apply` to write) |
| `npm run wa:repoint` | Repoint the sheet WhatsApp nudges at their UTILITY templates (dry run) |
| `npm run wa:analytics` | **Button clicks from Meta** — per template, per day (no template change needed) |
| `npm run capi:check` | Meta Conversions API config + the exact payload it would send |
| `npm run nudges:set-cap` | Set the per-lead message cap on the four activation-fee nudges (dry run; `--apply` to write) |
| `npm run db:push` | Apply schema changes (safe) |
| `npm run db:push:force` | Apply with `--accept-data-loss` (drops data) |
| `npm run db:studio` | Prisma Studio |
| `npm run seed:whatsapp` | Idempotently add the WhatsApp twin nudge |
| `node scripts/inspect-n8n-flow.mjs <export.json>` | Read an n8n export structurally — node summary, **connection graph**, exact SQL/code text |

---

## V2 — the lead journey and the engagement score

V1 answered *what did we send*. V2 answers *did it work*, by recording where a lead was when we
messaged it and where it went afterwards. Four moving parts:

| Piece | What it does | Where |
| --- | --- | --- |
| Stage history | One row per detected CRM status transition, attributed to the last nudge before it | `nudge_lead_stage_history` |
| Engagement score | 0–100 from opens, replies, CTA taps and stage changes | `journey.ts` (maths) + `score-leads.ts` (job) |
| Journey drawer | Score breakdown, stage timeline, send history for one lead | Leads tab → click a row |
| Journey tab | Stage funnel, time per stage, ranked nudge impact, score distribution | **Journey** tab |

**The one thing to read before quoting any of it.** Attribution is the *last successful send before a
change, within `ATTRIBUTION_WINDOW_HOURS` (default 72)*. It records what preceded a change, **not what
caused it** — a lead may move stage because someone phoned them. Every API response carries
`attributionIsProbabilistic: true` and every panel says so in words, because this data is the kind
that gets screenshotted into a decision.

Equally: **the score never decides who gets nudged.** Eligibility is still each nudge's own filters.
Nothing in the send path reads `engagementScore`, deliberately.

### Scoring model

| Signal | Points | Notes |
| --- | --- | --- |
| Message sent (WhatsApp) | +2 each | **capped at +10** — being sent to repeatedly is not engagement |
| Message sent (email) | +1 each | |
| Opened / read | +5 each | one award per message opened, not per pixel hit |
| Replied | +15 | once, however many replies |
| CTA clicked | +20 | first tap |
| CTA clicked 2+ times | +10 | bonus |
| CRM status changed | +25 | a detected transition |

Clamped to `SCORE_MAX` (100). Bands: **0–20 Cold · 21–45 Warming · 46–70 Engaged · 71–100 Hot**.
Failed sends earn nothing — an attempt that reached nobody is not engagement. Scores are recalculated
for the leads a sync touched, plus on the scheduler tick every `SCORE_RECALC_INTERVAL_MINUTES`.

### The stage history ages from now

A transition is recorded only when a sync sees a CRM status **different from the stored one**, so the
table starts empty and fills as leads actually move. It cannot be backfilled — the previous statuses
were never observed, and inventing them would fabricate a journey. The same restraint applies to
`firstNudgeSentAt` (derived from real sends) and `totalDaysToConvert` (stamped only on reaching
`CONVERTED_STATUSES`, and only when the first-nudge clock is known).

```bash
npm run db:add-v2-columns              # dry run — the 6 new Lead columns
npm run db:add-v2-columns -- --apply
npm run db:stage-history-table         # dry run — creates the ONE new table
npm run db:stage-history-table -- --apply
```

Both are additive and idempotent: `ALTER TABLE ... ADD COLUMN` and `CREATE TABLE IF NOT EXISTS`, no
DROP/MODIFY/RENAME, and neither touches any other table.

### V2 API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/leads/{id}/journey` | Score + breakdown, stage timeline with attribution, full send history |
| `GET /api/leads/{id}/score` | Score and breakdown, recalculated on the spot so it cannot be stale |
| `GET /api/reports/nudge-impact` | Per-nudge attributed conversions, split by message number |
| `GET /api/reports/stage-flow` | Stage funnel, stage-pair transitions, average time per stage |
| `POST /api/cron/score-leads` | Recalculate scores (`CRON_SECRET`); `{ "limit": 500 }` or `{ "all": true }` |

`GET /api/leads` gained `?sort=score` / `?sort=score-asc` and `?band=hot` (whitelisted sort keys —
an arbitrary `orderBy` from a query string is both a crash and a leak), and every lead now carries
`engagementScore` + `scoreBand`.

The impact report **excludes nudges below `minSendsForRanking` (20) from the ranking**: one send and
one conversion is "100%" and means nothing. Stage changes with no qualifying nudge are reported as
`organicChanges` rather than dropped.

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

#### Sheet nudges: the sheet decides who gets messaged

**Every row is sent.** History is never consulted, so re-uploading a sheet really does re-send —
including to people this nudge has already contacted. `maxEmailsPerLead` and `followUpDays` do not
apply: they are read only by `decideSend`, which runs on the lead-driven paths (`runNudge`,
`runMysqlNudge`, `previewNudge`). The sheet-run route never calls it.

The **only** de-duplication is within a single run: an address repeated in the sheet is collapsed to
one send and reported as `duplicate_in_sheet`. The address is normalised first, so
`+91 98765 43210`, `09876543210` and `919876543210` are recognised as the same number.

Two consequences worth knowing:

- **Send-from-Sheet is not idempotent.** Running the same sheet twice sends twice. There is no
  undo.
- The email fallback (used when Meta drops a WhatsApp send) keeps its own "already emailed this
  person" guard, so a repeated failure does not accumulate duplicate emails. It is the one place a
  past send is still consulted.

This was previously "one message per recipient, ever", which meant re-uploading a corrected sheet
silently delivered nothing and reported `skipped · duplicate` for people who had never received the
message. `planSheetSends()` in `src/lib/sheet-vars.ts` now expresses the policy as a pure function
that takes **no history argument at all**, which makes "it will not skip someone we messaged before"
structural rather than a promise — and unit-testable without a database or an API call.

#### Sheet nudges have no per-lead message cap

`maxEmailsPerLead` and `followUpDays` are read **only** by `decideSend`, which runs on the
lead-driven paths (`runNudge`, `runMysqlNudge`, `previewNudge`). The sheet-run route never calls it:
it applies its own rule instead — the sheet decides who gets messaged (see above).

So a cap on a sheet nudge is a control that does nothing. That was true even while those nudges were
set to "3 messages, spaced 2 days": nothing read it, and the sends were not spaced. Guarded now by
`capAppliesTo()` in `src/lib/nudge-kind.ts`:

| Where | Behaviour |
| --- | --- |
| Nudge editor | The two fields are **not shown** for a sheet nudge; the sending rule is explained instead |
| Nudge card | Shows "once per recipient (sheet)" rather than "max N/lead · follow-up every Nd" |
| Dashboard engagement blocks | Show "once per recipient", driven by a `capApplies` flag from the API |
| `npm run nudges:set-cap` | Refuses to write a cap to a sheet nudge, and names the ones it skipped |

`npm run nudges:set-cap -- --normalise-sheet --apply` resets the sheet nudges to `1 / 0` — the honest
equivalent of "once per recipient". Note that **0 is not "unlimited"**: `decideSend` treats
`logs.length >= max` as done, so 0 would mean "never send".

To add another: add an entry to `WA_SHEET_FLOW_TEMPLATES` in `src/lib/nudge-defaults.ts`, then

```bash
npm run seed:nudges                        # creates the nudge row, disabled
npm run wa:templates -- --create-missing    # submits the template to Meta as UTILITY
```

#### Any nudge can be sent from a sheet

**Send from Sheet** is offered on **every** nudge card, including the six database-driven WhatsApp
flows and the Zoho-driven ones. The sheet then replaces that nudge's usual recipient selection: the
route never asks Zoho or the business database who to message, it messages the rows you pasted. The
rule above applies unchanged — every row is sent, and only a repeat *within* the run is collapsed.

This was previously offered only for sheet nudges and Zoho **email** nudges, which is why the MySQL
WhatsApp flows could not be driven from an uploaded sheet at all. The route itself never cared which
kind of nudge it was given; only the button was hidden.

The one thing that can make a WhatsApp sheet run fail up front is a **missing column**. A template
whose body reads a variable — `documents_pending_upload` reads `{{1}}` = `pending_documents`,
`documents_reupload_required` reads `reupload_documents` — needs a column of that name, because the
sheet is the only source of it on this path. Without the check, `buildWhatsAppParams()` would
substitute its fallback and Meta would happily deliver a message reading *"documents still pending:
**-**"*. The route therefore refuses with a 400 naming the missing columns and the columns the sheet
does have, and the dialog lists the required columns before you press send. `first_name`, `email`,
`mobile`, `mobile_digits`, `today` and `message_number` are derived from the sheet itself and never
need a column of their own.

### Exporting logs

The **Logs** tab has an **Export** button that downloads the logs as a spreadsheet. The dialog takes
a **date range** (Today / Yesterday / Last 7 days / Last 30 days / Custom), a **nudge**, a
**channel** and a **status**, and shows how many rows match *before* you download — so a mistyped
range shows up as an obviously wrong number rather than a surprise.

Dates are **IST calendar days, inclusive at both ends**, matching how the charts bucket days. A
UTC-based range would shift the boundary by 5.5 hours and quietly include or exclude the wrong
messages, so both edges are tested explicitly (00:00:00.000 IST through 23:59:59.999 IST).

The workbook has two sheets:

| Sheet | Contents |
| --- | --- |
| **Logs** | One row per send attempt: IST and UTC timestamps, channel, nudge name and key, recipient, subject/template, message #, status, delivered, opened (+ count and time), replied (+ time), **the customer's reply text**, failure reason in plain English, raw error, tracking id, sheet row |
| **Summary** | The filters used, the row count, and a breakdown by nudge × channel × status |

`status` is derived, not stored: replied beats opened beats sent, and a failed row is `failed`.

```bash
npm run logs:export -- --from 2026-09-23 --to 2026-09-23 \
    --nudge whatsapp_onboarded_not_transacting --channel whatsapp
npm run logs:export:demo    # a workbook of INVENTED rows, to check Excel opens the format
```

The CLI uses the **same modules as the route**, so the file it writes is the shape the button
downloads. It also reads its own output back and validates it.

#### Why there is no spreadsheet library

An `.xlsx` is a ZIP of small XML parts. `exceljs` and friends are large, and this is a
banking-adjacent service where every dependency is supply-chain surface — so the writer in
`src/lib/xlsx.ts` is ~300 lines against Node's built-in `zlib`, and its output is **verified rather
than trusted**:

- `scripts/lib/read-zip.mjs` reads the archive back: central directory, every entry inflated
  against its declared size, worksheet relationships resolved, `<row>` tags balanced.
- `validateXlsx()` runs in the verify suite **and** as a self-check after every CLI export — a
  workbook Excel refuses to open is indistinguishable from an empty export, so it fails loudly.
- Inline strings instead of a shared-strings table (one fewer part to get wrong), dates as ISO
  strings rather than serial numbers (no epoch or number-format decision), and numeric-looking text
  stays text so tracking ids and phone numbers keep their leading zeros.

Generated exports are **git-ignored**: they contain real customer phone numbers and email addresses.

### WhatsApp button clicks (who tapped the CTA)

**Meta records button clicks itself — start here, not with the redirect tracker.** `GET
/{WABA_ID}/template_analytics` returns per-template, per-day metrics including:

```json
"clicked": [
  { "type": "url_button",        "button_content": "Pay Now", "count": 6 },
  { "type": "unique_url_button", "button_content": "Pay Now", "count": 5 } ]
```

That needs **no template change, no redirect and no review**, and works on this WABA today:

```bash
npm run wa:analytics          # last 7 days
npm run wa:analytics 21
```

```
template                                status    sent*  clicks  unique  button
activation_fee_pending_transacting     APPROVED    100      16      15  Pay Now
activation_fee_pending_not_transacting APPROVED    116      12      11  Pay Now
* sent = from our own log table; clicks = from Meta
```

#### Two traps in that endpoint, both measured

| Trap | Detail |
| --- | --- |
| `template_ids` is capped at **10** | 11 ids → `400 (#100) template_ids`, which names the parameter but not the problem |
| **A response is capped at ~25 data points and Meta silently truncates the rest** | A sweep with two known-active control templates: `ids=2` → both reported ✅ · `ids=4` → one already lost ⚠️ · `ids=5+` → **zeros for templates that report data at `ids=2`** ❌. There is no pagination cursor |

The second is why this asks for **one template per request** and caps the window at
**`ANALYTICS_MAX_DAYS` (23)**. `fetchTemplateClickAnalytics()` also refuses a response that arrives
at the cap rather than reporting a partial number as if it were complete.

Because of the cap, only **CLICKED** is fetched from Meta — sent/delivered/read are already recorded
accurately by the webhook, and asking Meta for them too would multiply the requests for data we
already have.

**What it cannot do: say WHO clicked.** The data is per template per day. Per-person attribution
needs the redirect tracker below.

#### Per-person attribution — the `_cta` templates

Meta's analytics can say **how many** clicked; it can never say **who**. For that the button has to
route through this app, and because a button's URL lives *inside* the approved template, that means
a separate tracked template per button.

**Every UTILITY template with a URL button has a tracked twin whose name ends in `_cta`:**

| Base (untracked) | Tracked |
| --- | --- |
| `activation_fee_pending_transacting` | `activation_fee_pending_transacting_cta` |
| `activation_fee_pending_not_transacting` | `activation_fee_pending_not_transacting_cta` |
| `csp_details_pending_reminder` | `csp_details_pending_reminder_cta` |
| `mobile_otp_pending` | `mobile_otp_pending_cta` |
| `pan_verification_pending` | `pan_verification_pending_cta` |
| `agreement_signature_pending` | `agreement_signature_pending_cta` |
| `documents_pending_upload` | `documents_pending_upload_cta` |
| `documents_reupload_required` | `documents_reupload_required_cta` |

Templates with **no button** (`ip_whitelisting_mandatory`, `documents_pending_reminder`) have no
tracked twin — there is nothing to track. The retired **MARKETING** templates are left alone.

The suffix is the whole mechanism:

```
template button URL : https://<host>/api/track/cta/{{1}}
{{1}}               : the message's trackingId  (NOT the mobile)
GET /api/track/cta/<trackingId>  →  records the click  →  302 to the stored destination
```

**What decides the button parameter is the TEMPLATE, not an env var.** A `_cta` template expects a
token in `{{1}}`; an ordinary one expects the mobile. Sending the wrong one is not cosmetic: the
tracker would look up a phone number as a token, find nothing, and drop the customer on the fallback
page instead of the payment page. `ctaSendParams()` reads the suffix to decide.

The destination is stored **per message** at send time (`MessageLog.ctaUrl`), built from the *base*
template's button URL with the mobile substituted, so a tracked link lands exactly where the
untracked one would have. It is read from the row, never from the request, which is what stops this
becoming an open redirect.

```bash
npm run wa:repoint                          # dry run: which nudges move to which template
npm run wa:repoint -- --apply               # point them at the tracked templates
npm run wa:templates -- --create-missing    # create any tracked template that does not exist yet
```

Order matters: a tracked template must **exist on Meta** before a nudge points at it. These commands
are safe in any order because of the fallback below, but that is the intended sequence.

##### Sends cannot break while Meta reviews a tracked template

A `_cta` template starts **PENDING**. Pointing a live nudge at a pending template would make its
sends fail with `132001`. So `sendWhatsAppTemplate()` accepts an optional fallback and retries the
**base** template when Meta reports the tracked one as unavailable — with the *mobile* as the button
parameter, since that is what the untracked template expects.

The customer still gets their message; it simply has no click attribution until the tracked template
is approved. The log records the template that **actually** went out
(`usedFallbackTemplate`), so a message with no clicks is never mistaken for a broken tracker.

| Column | Meaning |
| --- | --- |
| `ctaUrl` | where this message's button should reach (recorded even when untracked) |
| `ctaClicks` | how many taps arrived |
| `ctaClickedAt` | when the first tap arrived |

Clicks show in the **Logs** tab as a CTA badge (`×2`), and the export has
**CTA clicked / CTA clicks / CTA clicked at / CTA link** columns. A dash means *not tracked*;
"no click" means *tracked but not tapped* — deliberately different labels.

Three rules the tracker follows, all deliberate:

1. **It never shows an error page.** An unknown token, a malformed one, or an unreachable database
   still redirects to `CTA_FALLBACK_URL`. A broken tracker must not cost a sale.
2. **It never redirects to a URL from the request**, so it cannot become an open redirect.
3. Counting and any Meta conversion are **fire-and-forget** — neither may stand between the customer
   and the payment page. The redirect is `302`, not `301`: a permanent redirect would be cached and
   later clicks would skip the tracker.

One caveat: the click now passes through your host, so it is subject to its cold starts. The handler
is deliberately cheap (one indexed lookup), but a sleeping free-tier instance adds latency to a
customer's tap. **The aggregate analytics above has no such downside** — which is why the two sit
side by side rather than one replacing the other.

### Is everything ready to send?

```bash
npm run readiness              # every nudge
npm run readiness -- --only whatsapp
```

A **dry run of the real selection logic** — nothing is sent. For each nudge it reports how it gets
recipients, whether the channel is configured, the template's approval state, and **who it would
message right now** and who it would skip, with reasons. Because it calls the same preview/collect
functions the Run path uses, it cannot promise a send the run would not make.

The last run: **11 WhatsApp nudges, 0 blocked**, every template approved. Four MySQL flows returned
0 recipients, which was checked rather than assumed — e.g. `documents_reupload_required` looks for
rejected documents (`doc_status = 3`) on applications from the last 30 days, and the most recent
rejection in the whole table is **2026-07-28**, so 0 is correct, not a broken query.

> **Resolved:** CLI scripts used to be unable to import any module with a `@/…` import in its
> dependency graph, which forced logic to be split or duplicated to be testable. `scripts/lib/alias-loader.mjs`
> teaches Node the same path mapping Next uses, so `npm run readiness` exercises the real code path
> instead of a copy of it.

### Sending conversions back to Meta

Independent of the messaging metrics, Meta wants the *business* events so its ad system can learn
what a good WhatsApp conversation produces. That is the **Conversions API**, and for a WABA the
events go to a **dataset (Pixel) id** — not to the WABA — with:

```json
{
  "data": [{
    "event_name": "CTA_Click",
    "event_time": 1790578618,
    "action_source": "business_messaging",
    "messaging_channel": "whatsapp",
    "user_data": { "ph": ["<sha256 of 919876543210>"], "em": ["<sha256 of email>"] },
    "event_id": "<the MessageLog trackingId>"
  }]
}
```

`src/lib/meta-capi.ts` builds and sends these. The points that decide whether it works at all:

| | |
| --- | --- |
| **Identifiers must be hashed** | SHA-256 hex. A raw phone number or email is rejected — and a test asserts nothing raw leaks into the payload |
| **Phone format must match** | digits only, country code included, no `+`, no trunk zero. `9876543210` is hashed as `919876543210`. Get this wrong and the request succeeds and matches nobody |
| **Email must be lowercased** | before hashing |
| **`action_source`** | `business_messaging` with `messaging_channel: "whatsapp"` — this is what marks it as a WhatsApp-originated event |
| **`event_id`** | set to the tracking id, so a repeat click dedupes inside Meta's window instead of double-counting |
| **`ctwa_clid`** | for Click-to-WhatsApp *ads* the conversion needs the click id Meta issues, which arrives in the inbound message's `referral` object. The payload builder accepts it; capturing it from the webhook is **not implemented yet** |

```bash
npm run capi:check                          # config + the exact payload, hashes included
npm run capi:check -- --send                # actually POST one event
npm run capi:check -- --send --ctwa-clid X  # include a click id
```

Configure `META_CAPI_DATASET_ID` + `META_CAPI_TOKEN`, then set `META_CAPI_CTA_EVENT_ENABLED=true`
to report every tracked button click as a conversion. Use `META_CAPI_TEST_EVENT_CODE` to route
events to Events Manager → **Test events** rather than counting them — do that first.

Prefer a **standard** event name (`Lead`, `InitiateCheckout`, `Purchase`) over a custom one like
`CTA_Click`: standard events are what ad optimisation actually uses.

> **Not verified against a live dataset.** The payload shape follows Meta's documented contract and
> is unit-tested, but sending needs this account's own dataset id and token, which I do not have.
> Confirm the required fields for your WABA in Events Manager before trusting a live stream.

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
transacting** and **onboarded and transacting**. It is **WhatsApp only**: the email twins' numbers are
still collected and exported (the Logs tab and the export are unchanged), but the dashboard shows
nothing about email at the moment, so the channel toggle and the email chart series are gone rather
than hidden behind a control nobody asked to use.

Per family it shows **sent, failed, read and replied** plus the accepted percentage, the last-sent
time, and (for WhatsApp) how many were dropped by Meta's cap. **Clicked** is the count of messages
with at least one tap on the template's tracked button — the per-person click, which is different from
the per-template-per-day number in Meta's analytics (see
[WhatsApp button clicks](#whatsapp-button-clicks-who-tapped-the-cta)).

**"Read"** is Meta's `read` receipt; it is stored on the same `opened` column as the email pixel, which
is why one endpoint can report both.

Below that, one history chart per family plotting sent, read and failed per day over a 7/14/30-day
window. Each chart names the nudge key it is counting.

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
npm run nudges:set-cap                      # dry run, lead-driven nudges only
npm run nudges:set-cap -- --apply --max 3 --follow-up-days 2
```

That script exists instead of `seed:nudges --force` because `--force` rewrites *every* field,
including templates edited in the UI. It touches two columns on the named rows, prints a diff, and
never touches `enabled` — pausing and resuming stays the operator's call.

> **Corrected:** these four are all **sheet nudges**, and a sheet nudge has no per-lead cap at all —
> see [Sheet nudges have no per-lead message cap](#sheet-nudges-have-no-per-lead-message-cap). The
> "3 messages, spaced 2 days" setting was applied here at one point and was inert the whole time.

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
| CTA click tracking | `CTA_TRACK_BASE_URL`, `CTA_FALLBACK_URL` | Empty base URL = untracked buttons (the default) |
| Meta Conversions API | `META_CAPI_DATASET_ID`, `META_CAPI_TOKEN`, `META_CAPI_API_VERSION`, `META_CAPI_TEST_EVENT_CODE`, `META_CAPI_CTA_EVENT_ENABLED`, `META_CAPI_CTA_EVENT_NAME` | Reporting business events back to Meta; off by default |

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
| `{"window":"incremental"}` | **the default, and what the button uses** — from the last sync up to now |
| `{"window":"all"}` | every EPS lead created since **1 Aug 2026** |
| `{"window":"today"}` | the same filter, created time at **01:00 today** (IST) |
| `{"criteria":"((…))"}` | explicit override; wins over `window` |

**`incremental` is a closed window:** `Created_Time > from AND Created_Time < now`. The live CRM
accepts two conditions on the same field, but **only with an explicit `+05:30` offset** — an ISO
`…Z` suffix is rejected with `INVALID_QUERY / expected_data_type: datetime`. That is asserted, so it
cannot regress.

"From" is the **last sync time**, read from the data itself: `MAX(nudge_lead.lastSyncedAt)`, which is
stamped on every upsert. No extra table, column or config value.

#### Why it reaches back a few minutes

A sync is not instantaneous: it queries the CRM, *then* stamps `lastSyncedAt` per upsert. A lead
created after the query but before the final stamp would sit outside a strict window and be missed
forever. So the from-bound is pulled back by `ZOHO_SYNC_OVERLAP_MINUTES` (default **10**). Re-fetching
a lead is harmless — the upsert is idempotent — whereas missing one is not.

Verified against the live CRM: with the last sync at `2026-09-24T09:28Z`, the incremental window
returned **58 leads, all of them new** — exactly what was created since, with nothing re-scanned.

Both buttons in the header call this — **Sync new leads** (incremental) and **Sync all leads**. The
toast reports the window it actually used, including the from/to and the overlap.

`via` controls the data path (`auto` by default). `auto` prefers MCP and falls back to the REST API
if the MCP call fails, reporting `via` and `fellBack` in the response — a silent fallback would hide
a broken MCP setup, so the UI says which path ran.

---

### One sync path, MCP-first, everywhere

`syncLeads()` is the only way the app pulls the CRM: it reads through the **Zoho MCP server** when
that is connected and falls back to the REST API only if MCP fails (reporting the reason). That is
the whole point of having connected MCP.

> **A divergence worth knowing about.** `/api/zoho/sync` used `syncLeads()`, but `runNudge` and the
> scheduler called `syncLeadsFromCriteria()` — the **REST-ONLY** helper. So the Run button and every
> scheduled cycle bypassed the MCP server entirely. It stayed invisible until the REST client
> credentials were rejected (`invalid_client_secret`): `/api/zoho/sync` kept working through MCP
> while every nudge run failed to sync at all. Both now use `syncLeads()`, and the run summary
> reports which path was used (`syncedVia`). Six assertions guard the wiring, since "which helper
> does the send path call" is not something a unit test can see.

If MCP is connected, a broken REST client ID/secret no longer matters. Check either path with:

```bash
npm run mcp:check     # MCP config + OAuth discovery
npm run mcp:tools     # connect and list every MCP tool (read-only)
npm run email:check   # unrelated, but the same "is this wired up" idea
```

## Built-in nudges

All defined in `src/lib/nudge-defaults.ts` (single source of truth for the Zoho criteria and
every template). `GET /api/nudges` creates any that are missing; it never updates an existing
row, so UI edits are safe. Refresh definitions deliberately with:

```bash
npm run seed:nudges           # create-if-missing + targeting report
npm run seed:nudges -- --force                            # refresh templates/filters on existing rows
npm run seed:nudges -- --force --only documents_pending_wa  # refresh ONE nudge
```

`--only` takes one key or several comma-separated. It exists because `--force` rewrites **every**
nudge, so changing one nudge's criteria should not mean re-asserting the configuration of the other
fifteen — some of which have been edited in the UI. `enabled` is operator state and is never touched
by either flag.

| Key | Trigger | Who it targets |
| --- | --- | --- |
| `onboarding_started_agreement` | Zoho sync | status = `Onboarding Started` → asks them to complete agreement signing |
| `documents_pending` | Zoho sync | status = `Agreement Signed` **and** `KYC_Document_Upload_Count <= 10` → complete the document upload |
| `onboarded_transacting` | **Manual — Google Sheet** | expiring-discount activation-fee reminder with a pay CTA |
| `onboarded_not_transacting` | **Manual — Google Sheet** | account-activated + integration next steps, then the discount reminder with a pay CTA |
| `documents_pending_wa` | Zoho sync | **same pool** as `documents_submitted_review` (EPS + `Documents Pending`) but the opposite comparison: `KYC_Document_Upload_Count` **<** `KYC_Documents_Expected_Count` → document upload still pending. At most one a day, max 7 |
| `documents_submitted_review` | Zoho sync **or** CRM webhook | EPS leads whose `KYC_Document_Upload_Count` **equals** `KYC_Documents_Expected_Count` → "we've received everything, it's under review", with a console CTA |

### The two KYC count rules — one pool, opposite comparisons

`documents_pending_wa` and `documents_submitted_review` share the same candidate pool (business
vertical EPS, lead status `Documents Pending`) and differ only in the comparison, so they partition
the cohort rather than overlapping:

| Rule | Nudge | Meaning | Measured today |
| --- | --- | --- | --- |
| `less_than` | `documents_pending_wa` | upload **<** expected → still outstanding | 13 leads |
| `equals` | `documents_submitted_review` | upload **==** expected → under review | 1 lead |

13 + 1 = the 14 leads that have both counts. Both rules live in `src/lib/kyc-match.ts` and are
applied through one function (`splitByKycMatch`) that `runNudge`, `previewNudge` and the CRM webhook
all call — a filter that compares two columns of the same row cannot be expressed in a Prisma
`where`, and duplicating it in three callers is how the definitions drift apart.

The guards are the whole point. Measured on the live CRM — 39 EPS leads with status
`Documents Pending`:

| Situation | Count | Decision (both rules) |
| --- | --- | --- |
| `expected` is **NULL** | 25 of 39 (64%) | **refused** — `kyc_expected_unknown` |
| `expected` is 0 | 0 | refused — `kyc_expected_zero` |
| upload missing | 0 | refused — `kyc_upload_unknown` |
| counts present but unequal | 13 | `less_than` sends; `equals` refuses |
| counts present and equal | 1 | `equals` sends; `less_than` refuses |

An unknown expectation means *we do not know what complete looks like*, and must never satisfy either
rule. For `equals` the danger is `null === null` being `true` — a naive test would have nudged 25 of
those 39 leads with the false claim that everything was in. For `less_than` the danger is quieter:
`upload < null` coerces to `upload < 0` in JS, so the leads would have vanished silently instead of
being reported. The rule is declared as `kycCountRule: 'less_than' | 'equals'`; setting both that and
the older `kycMatchesExpected: true` to *different* rules is treated as a conflict that refuses the
whole batch and says so, rather than being resolved by guessing.

`KYC_Documents_Expected_Count` is synced into `nudge_lead.kycDocumentsExpectedCount`:

```bash
npm run db:add-kyc-expected-column            # dry run
npm run db:add-kyc-expected-column -- --apply  # additive ALTER TABLE only
```

Nothing is backfilled — existing rows stay NULL until their next sync, and NULL never matches.

### Cadence ("once a day", "once per recipient")

The sequence rule moved to `src/lib/sequence.ts`, which imports no database, so the promises the
config rows make are actually tested instead of assumed:

| Order | Check | Result |
| --- | --- | --- |
| 1 | the lead has replied | stop, permanently |
| 2 | the LAST attempt hit Meta's cap | wait out `DELIVERY_CAP_BACKOFF_HOURS` (a later success clears it) |
| 3 | `maxEmailsPerLead` successful sends reached | stop, permanently |
| 4 | `followUpDays` not yet elapsed since the last success | wait |

Only **successful** sends count towards the cap, and the gap is measured from the last success — a
failed attempt must not consume the allowance, or one transient provider error would end the
sequence. So `followUpDays: 1` really does mean "at most one a day" (1h or 23h after a send → wait;
24h → eligible), and `maxEmailsPerLead: 7` bounds it at a week of daily reminders.

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
  candidate list from a Google Sheet — the n8n appended "sign agreement done" rows to a sheet, then
  **deleted the row** once the agreement was signed, so the sheet *was* the signed-agreement cohort.
  With direct DB access `docCohort: 'signed'` (the default) reproduces exactly that cohort from
  `customer_agreement_history.status = 1`; `'recent'` widens it to any application in the window and
  is kept as an option. Widen any window freely — de-duplication is per phone number, so a wider
  window means better coverage, not repeat messages. Measured on the real data, the signed cohort is
  the *narrower* one (30d: 5 signed customers vs 13 recent applications) and therefore the more
  precise; do not "fix" a small recipient count by switching it back without checking.
- `verify_csp` uses exactly the n8n predicate — `requestAt` in the window **and**
  `(verifyAt IS NULL OR panNumber IS NULL)` — on the exact n8n column set.
  > An earlier version also tested `TRIM(verifyAt) = ''` / `TRIM(panNumber) = ''`, reasoning that the
  > n8n If-nodes treated a blank string as missing. That was measured and reverted: on the live table
  > both blank-string predicates match **zero** rows (both columns hold real datetimes and PAN
  > strings), so they could never select anyone `IS NULL` missed — and wrapping a column in `TRIM()`
  > forfeits any chance of an index being used on it.
- **`mobile_otp_pending` and `pan_verification_pending` are TWO ARMS OF ONE DECISION, not two flows.**
  The n8n ran the query once and branched:

  ```
  verifyAt empty            → WhatsApp · Mobile Verification Pending
  else panNumber empty      → WhatsApp · PAN Verification Pending
  else                      → nothing
  ```

  `collectVerifyBranches()` implements exactly that: one query, then `partitionVerifyRows()` decides
  the arm. Running the query per nudge is not merely wasteful — `verifyAt` is written **seconds**
  after `requestAt` in production, so a write landing between the two queries would let the same
  person receive BOTH messages in one cycle. Within a scheduler cycle the two nudges therefore share
  one snapshot (`beginMysqlSnapshot()` / `endMysqlSnapshot()`), which is also why they must carry the
  same cadence. Outside a cycle there is no cache, so a manual Run always reads fresh data.

  The arms are exclusive per **row** by construction. They are not exclusive per **phone**: two rows
  can share a `csp_number` (the same person verifying twice), and then one row can be mobile-pending
  while the other is PAN-pending. That is the n8n's behaviour and the two messages are different
  templates, so it is correct — de-duplication then applies per nudge per phone.
- **The look-back window is the cadence PLUS an overlap** (`MYSQL_WINDOW_OVERLAP_MINUTES`, default
  30). The n8n made the window equal to its trigger interval, which leaves no margin: a run one
  minute late loses the rows that arrived in the gap, permanently, and a missed customer looks
  exactly like a quiet hour. The overlap is free here — `requestAt` is not indexed, so `EXPLAIN`
  reports the same full scan either way, and de-duplication is once-per-phone so a wider window can
  never produce a repeat. Set the overlap to `0` for the literal n8n window.
- **`requestAt` is not indexed** on `verify_csp` (the table's only index is `PRIMARY(Id)`). `EXPLAIN`
  reports `type=ALL`, `key=NULL`, `rows≈4692`, `Using filesort` for *every* variant of this query,
  including the 2-hour one. So the window limits how many rows are **returned**, not how many
  are **read** — it is not a performance lever. On a much larger table the fix would be an index on
  `requestAt`, which is a DDL write and therefore out of bounds for this app (the business database is
  read-only). Do not try to buy performance back by shrinking the window; measure with `EXPLAIN`.
- `pan_verification_pending` requires the mobile to be **already verified**, which is the n8n branch
  order (`Check Mobile Verification` false-branch → `Check PAN`). A lead missing both is nudged for
  the mobile now and for PAN on a later pass — never twice at once.
- `csp_docs` has no `CREATED_AT` column, so the original n8n docs query could not have worked; the
  port queries the columns that actually exist and resolves the phone via `csp_application`
  (falling back to `verify_csp`).
- Document classification is ported from the n8n code node: the same required-document list, master
  doc ids and aliases, and the same priority when duplicates exist (approved > submitted > rejected).
- Recipients are de-duplicated by **phone**, and the shared sequence rules still apply (stop on reply,
  max sends per contact).
- Every button links to `https://eps.eko.in/console?mobile=<recipient mobile>`.
- Any of the six can also be sent from an uploaded sheet instead of the query — see
  [Any nudge can be sent from a sheet](#any-nudge-can-be-sent-from-a-sheet). `documents_pending_upload`
  and `documents_reupload_required` then need a `pending_documents` / `reupload_documents` column.

### Manual WhatsApp sheet nudges

`whatsapp_onboarded_transacting` and `whatsapp_onboarded_not_transacting` are the WhatsApp twins of
the two pay-activation-fee email nudges. Paste a Google Sheet URL in the UI; the sheet needs a mobile
column (any of `mobile`, `mobile_number`, `phone`, `phone_number`, `contact`, `contact_number`,
`whatsapp`). Their button links to `https://eps.eko.in/console/pay-activation-fee?mobile=<mobile>`.

> Only these two use the pay-activation-fee link. The six DB flows use the console link.
>
> The **Send from Sheet** dialog says which columns the selected template reads, and the run is
> refused with a 400 rather than sending if one is missing. It does **not** skip rows that this nudge
> has already messaged — that claim used to be in the dialog text and was untrue.

### Verifying the flows

```bash
npm run wa:flows        # live audit: template status, button, params, and recipient counts
npm run seed:nudges     # create-if-missing + a live per-flow recipient preview
npm run readiness       # dry run everything: who each nudge would message right now, and blockers
```

### Auditing a port against its n8n original

`scripts/inspect-n8n-flow.mjs` reads an n8n workflow export structurally instead of by eye:

```bash
node scripts/inspect-n8n-flow.mjs flow.json                 # every node, then the connection graph
node scripts/inspect-n8n-flow.mjs flow.json --connections   # the graph alone
node scripts/inspect-n8n-flow.mjs flow.json --node "MySQL2" query
node scripts/inspect-n8n-flow.mjs flow.json --grep "SELECT"
```

The **connection graph** is the part that matters and the part a summary hides. `--connections`
prints the branch index on multi-output nodes (`main:0` / `main:1`), which is how you see that the
n8n mobile-verification check feeds the PAN check on its *false* branch — i.e. PAN is only reached
once the mobile is verified — rather than both firing in parallel as the layout suggests.

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

## CRM webhooks

Two hooks, both under `/api/hooks/` (exempt from Basic auth in `src/middleware.ts` because a CRM
cannot answer an HTTP Basic prompt — each authenticates itself with `LEAD_WEBHOOK_SECRET` and **fails
closed** when that is unset).

| URL | Use it for |
| --- | --- |
| `POST /api/hooks/lead?token=…` | **Record a stage change.** Zoho fires this whenever a lead moves status. |
| `POST /api/hooks/nudge/{key}?token=…` | **Trigger one nudge** for a lead that just qualified. |

Both accept the same body shapes — a flat record, `{ "Leads": { … } }`, `{ "data": [ … ] }`,
form-encoded fields, or the fields as query parameters — through one shared reader
(`src/lib/webhook-payload.ts`), because the failure mode of getting this wrong is identical in both
cases and invisible: a 200 with no action, so the CRM records a successful delivery while nothing
happened.

### `POST /api/hooks/lead` — stage changes

**Send only the NEW status.** The comparison is done here, against what is already stored, so the CRM
does not need to know the old value. Minimum useful payload:

```json
{ "id": "<zoho record id>", "Lead_Status": "Agreement Signed" }
```

Add any other fields you want kept current (name, email, mobile, company, business vertical, KYC
counts) — they are written through the same mapping the sync uses. The record id is required: it is
the only key the comparison can be made on.

What it does, in order: looks up the stored status → if the incoming status is different, records a
`LeadStageHistory` row and attributes it to the last successful nudge within
`ATTRIBUTION_WINDOW_HOURS` → stamps `lastStatusChangedAt` → recalculates that lead's score.

It **answers with the comparison**, so the Zoho log is worth reading:

```json
{
  "ok": true,
  "action": "stage_changed",
  "fromStatus": "Documents Pending",
  "toStatus": "Agreement Signed",
  "attributedTo": "documents_pending_wa",
  "hoursSinceNudge": 4.2,
  "timeInPrevStageHours": 26.5,
  "score": 25,
  "scoreBandLabel": "Warming",
  "summary": "Documents Pending → Agreement Signed · attributed to documents_pending_wa"
}
```

`action` is one of `created_lead` (first sighting — no transition is recorded, because there is no
"from"), `stage_changed`, or `no_change`.

> **A repeat delivery records nothing.** Sending the same status twice creates one history row, not
> two — so a Zoho retry cannot inflate the journey data. Verified live.

> **`?dryRun=1` reports what the call would do and writes nothing.** Use it to confirm a workflow is
> sending the right fields before letting it touch the journey: it returns `would_record_stage_change`
> / `would_update_only` / `would_create_lead` plus the attribution it would apply.

> **With no status field the lead is updated and NO transition is recorded** — which looks like the
> webhook working while the journey stays empty. The response carries a `warning` when that happens,
> rather than passing silently.

**Setting it up in Zoho CRM.** Workflow → *Instant Action* → *Webhook* on Leads, triggered on
"Lead Status changes", method POST, URL `https://<host>/api/hooks/lead?token=<LEAD_WEBHOOK_SECRET>`,
and pass the record id plus the status (`Lead_Status`) and whatever else you want synced. Because the
comparison happens here, you can trigger it on **every** status change and let the app decide what is
worth recording.

```bash
# check the contract without sending anything
curl "https://<host>/api/hooks/lead?token=$LEAD_WEBHOOK_SECRET"
```

### Telling "never arrived" from "arrived and refused"

Both hooks answer `401` for a bad secret and `400` for a malformed payload **without writing
anything** — a refused delivery must not touch lead data. That makes "nothing in the database"
ambiguous, and the two causes need completely different fixes. So every inbound attempt is recorded
in an in-memory log (no new table), readable from the same URL:

```bash
curl "https://<host>/api/hooks/lead?token=$LEAD_WEBHOOK_SECRET&deliveries=5"
```

```json
{
  "secretConfigured": true,
  "deliverySummary": { "total": 3, "byOutcome": { "accepted": 2, "bad_payload": 1 }, "lastAt": "…" },
  "recentDeliveries": [
    { "at": "…", "status": 400, "outcome": "bad_payload", "reason": "payload has no record id", "fields": ["Full_Name"] }
  ]
}
```

Read it like this:

| What you see | What it means |
| --- | --- |
| `deliverySummary.total: 0` | The CRM has **never called this instance**. Look at the Zoho workflow: is it *Active*, are **Instant Actions enabled**, is the trigger condition matching, and does Zoho's own webhook log show a call? |
| `outcome: "unauthorized"` | It called, with the wrong or no token — check the `?token=` in the URL. |
| `outcome: "bad_payload"` | It called without a usable record id. `fields` lists what it did send, which is exactly what the workflow's parameter list needs fixing against. |
| `outcome: "accepted"` | It arrived and was processed; `detail` says what happened. |

The log is **in-memory on purpose** — it is diagnostic, expected to be lost on a restart, and adding
a table for it would be worse than the problem. An empty log after a redeploy is a fact about the
process, not about the CRM. Every entry is also written to stdout as `[webhook] …`, so it appears in
the host's logs.

`dryRun` probes are deliberately **not** logged: that log answers "has the CRM called us", and our own
probes would make a never-contacted instance look busy.

`/api/hooks/` is in the middleware allowlist and the route authenticates itself, so this works
unauthenticated from Zoho while staying closed to everyone else. Treat the URL as a credential.



### `POST /api/hooks/nudge/{key}` — trigger a nudge

The scheduled sweep and the **Run** button pull from the CRM on a timer. A CRM workflow webhook does
the opposite: Zoho tells this app about a lead the instant it meets the criteria.

```
POST https://<your-app-host>/api/hooks/nudge/documents_submitted_review?token=<LEAD_WEBHOOK_SECRET>
```

**Auth.** `LEAD_WEBHOOK_SECRET`, accepted three ways — `?token=` (query string), the
`x-webhook-secret` header, or `Authorization: Bearer`. The query string is the recommended one
because a URL is the only field every CRM webhook editor exposes; it is named `token` so nobody
mistakes it for something shareable. The route **fails closed**: with the secret unset, every call is
refused with 401 rather than silently doing nothing.

`/api/hooks/` is in the middleware allowlist (`src/middleware.ts`) because a CRM cannot answer an
HTTP Basic prompt — without that exemption the request never reaches the handler and Zoho records a
401 that looks like a wrong URL.

**What it accepts.** A flat record, `{ "Leads": { … } }`, a `{ "data": [ … ] }` envelope, or plain
form-encoded fields. Zoho's webhook UI offers several shapes and a mismatch shows up only as silence,
so all of them are parsed.

**What it does with the record.** It upserts the lead, then applies **the same filter chain a run
uses** — status, business vertical, phone, the KYC row predicate — followed by the same
`decideSend` sequence check, and sends through the same `deliverToLead`. So a webhook cannot message
someone a manual run would refuse, a repeat delivery cannot message them twice, and the template,
parameters, `trackingId` and CTA destination are identical to a run-triggered send.

**It answers with a verdict**, so the CRM log says what happened:

| `action` | Meaning |
| --- | --- |
| `sent` | delivered to the provider; includes `templateName` and `trackingId` |
| `failed` | the provider rejected it; includes the error and a plain-English `help` |
| `skipped` | with a `reason`: `status_not_included`, `wrong_business_vertical`, `no_valid_phone`, `kyc_expected_unknown`, `kyc_expected_differ`, `max_reached`, `replied`, `delivery_cap_backoff` |

A delivery failure is reported as `failed` rather than a 500, because the CRM only needs to know
whether to retry the record.

> **Send the record id.** It is the key sends are de-duplicated on. Without it the request is refused
> with `400` and the list of fields actually received — a silent accept would mark the webhook
> "delivered" in Zoho while the lead was never nudged.
>
> **A sparse payload never blanks a lead.** `mapZohoLead` maps an absent field to `null`, and writing
> those through an update would wipe values the webhook did not mention. Only non-null fields are
> written on update; the full record is used only when creating. The consequence to know: a field
> *cleared* in the CRM will not be cleared here by the webhook — the next sync handles that.
>
> If the payload omits `KYC_Documents_Expected_Count`, the last synced value is used. If there is none,
> the lead is refused with `kyc_expected_unknown` — never guessed at.

**Setting it up in Zoho CRM.** Workflow → *Instant Action* → *Webhook* on the Leads module, condition
`Lead Status is Documents Pending` **and** `Business Vertical is EPS`, method `POST`, URL as above,
and include the **record id** plus whichever KYC fields you want kept current. Enable *Instant
Actions* for the workflow, and re-save it if you rotate the secret.

**Checking it without a payload.** `GET` the same URL and it returns the contract — nudge, channel,
template, filters and whether the secret is configured:

```bash
curl "https://<host>/api/hooks/nudge/documents_submitted_review?token=$LEAD_WEBHOOK_SECRET"
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
| `GET /api/logs/export` | Basic | Spreadsheet of logs (`?from&to&nudgeKey&channel&status&format=xlsx\|csv`, `&countOnly=1` to preview) |
| `GET/POST /api/whatsapp/test` | Basic | WhatsApp config check / one real test send |
| `GET/POST /api/email/test` | Basic | Email config check / one real test send (`{ "to": "…" }`, defaults to the from-address) |
| `GET /api/leads`, `GET /api/logs`, `GET /api/stats` | Basic | Data for the UI |
| `GET /api/scheduler` | Basic | Scheduler status |
| `GET /api/db/health` | Basic | External MySQL connectivity (`?tables=1`, `?describe=<table>`) |
| `GET /api/track/open/{trackingId}` · `GET /api/track/open?tid=` | **public** | Email open pixel (always returns a 1×1 GIF) |
| `GET/POST /api/track/whatsapp` | **public** | Meta webhook (verify handshake + statuses + inbound) |
| `GET /api/whatsapp/analytics` | Basic | **Button clicks + sent from Meta**, per template (`?days=7`) |
| `GET /api/track/cta/{trackingId}` | **public** | WhatsApp button click tracker → records the tap, 302s to the destination |
| `GET/POST /api/track/email` | shared secret | Inbound reply webhook |
| `POST /api/cron/run` | shared secret | Run one full cycle now |
| `GET/POST /api/cron/replies` | shared secret | Poll the mailbox for replies only |
| `GET/POST /api/hooks/nudge/{key}` | shared secret | Trigger a nudge — `GET` returns the contract, `POST` upserts one lead, applies the nudge's filters and sends |
| `GET/POST /api/hooks/lead` | shared secret | **Record a stage change** — `POST` the lead + its new status; the app compares with what it holds and records the transition |

Shared-secret callers pass `x-cron-secret` / `x-webhook-secret`, `Authorization: Bearer <secret>`,
or `?secret=`. The CRM webhook uses `LEAD_WEBHOOK_SECRET` and accepts `?token=` instead of `?secret=`.

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

### Running a nudge that is switched OFF (one-off "Fetch & Send")

`enabled` governs the **automatic** paths: only an enabled nudge is run by the scheduler or an
external cron. It is deliberately separate from "may the operator send this once, by hand" — a nudge
often has to stay off while its template is pending or while it is still being configured, and the
operator still needs to send it once.

So the Run button stays usable on a disabled nudge. It changes label and appearance (plain **Run**
when the nudge is on, **Fetch & Send** / **Run once** when it is off, in outline), and opens a
confirm dialog that states the nudge is OFF and that this does **not** switch it on.

Under the hood that is `{ "force": true }`:

```bash
# refused — the nudge is disabled
curl -X POST https://<host>/api/nudges/<id>/run -u "$APP_USERNAME:$APP_PASSWORD" \
  -H 'content-type: application/json' -d '{"sync":true}'

# runs once: fetch, apply filters, send
curl -X POST https://<host>/api/nudges/<id>/run -u "$APP_USERNAME:$APP_PASSWORD" \
  -H 'content-type: application/json' -d '{"sync":true,"force":true}'
```

`force` is never implied — the API only honours an explicit `true`, and the UI sends it only for a
nudge that is off. It does **not** enable the nudge, and every forced run is marked in the returned
summary (`"forced": true`) and in the UI's result dialog, so "how did messages go out from a nudge
that is off?" always has an answer. The rule lives in `runGuard()` in `src/lib/nudge-kind.ts`, shared
by the API and the UI so they cannot disagree about when the button is available.

> Sending is still subject to the same sequence rules — `maxEmailsPerLead` and `followUpDays` are
> checked exactly as in a normal run, so a one-off cannot bypass the cap. Use **Preview** first: it
> reports who would be messaged *right now*, which is the number that matters.

### Two clocks: the tick, and each flow's own cadence

`SCHEDULE_INTERVAL_MINUTES` decides how often the scheduler **looks**. A nudge's
`filters.everyHours` decides how often that flow actually **runs** — the n8n gave each flow its own
trigger, and without this every flow inherits the tick and re-scans the same window several times
over. Harmless for correctness (de-duplication is per recipient) but pointless load, and it makes the
config impossible to reason about.

| Flow | Cadence | Window |
| --- | --- | --- |
| `mobile_otp_pending` | **2h** | 2h + 30m overlap |
| `pan_verification_pending` | **2h** | 2h + 30m overlap |
| `csp_details_pending` | 3h | 3h + 30m overlap |
| `agreement_signature_pending` | 12h | 30 days |
| `documents_pending_upload` | 12h | 30 days |
| `documents_reupload_required` | 12h | 30 days |

A nudge that has never run is always due, so a freshly enabled flow does not sit idle. A cycle reports
`notDue` with the reason ("runs every 2h — last ran …, next in 47m") instead of silently skipping, so
"why did nothing send" is answerable from the result. `npm run readiness` prints each flow's last and
next run.

`mobile_otp_pending` and `pan_verification_pending` share the 2h cadence deliberately: they are the
two arms of one query, so a different cadence would let the PAN arm miss the rows the mobile arm just
classified.

**Which nudges a cycle runs.** Lead-driven (Zoho) and MySQL-driven nudges, and only those. Sheet
nudges are excluded — they are triggered by pasting a sheet URL, and running one on a timer would
message a list nobody supplied. The selection goes through `nudgeSourceOf()` in `src/lib/nudge-kind.ts`
rather than testing `zohoCriteria`, because a null criteria used to mean "sheet nudge" and the MySQL
flows share that null: filtering on it silently swallowed all six of them.

**The Zoho refresh happens once per cycle, not once per nudge.** `runNudge` syncs its own criteria, so
running N Zoho nudges used to pull the same CRM window N times every cycle — the network and the lead
upserts multiplied for no new data. `runAllEnabledNudges()` now syncs each *distinct* criteria once and
runs every nudge with `sync: false`, reporting the shared count back on each run summary. A failed sync
is not silently downgraded to "ran on stale data": the nudges that would have used that criteria are
reported as errored and skipped, exactly as they were before.

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
  (liveness only), the tracking routes (inboxes and Meta cannot authenticate), `/api/cron/*` and
  `/api/hooks/*` (both shared-secret checked in-route).
- `/api/hooks/*` is exempt from Basic auth because a CRM cannot answer an HTTP Basic prompt. It is
  not unauthenticated: `POST /api/hooks/nudge/{key}` requires `LEAD_WEBHOOK_SECRET` and **fails
  closed** when that is unset. Rotate it by changing the env var and re-saving the Zoho workflow —
  the old URL stops working immediately. `GET` on the same route reveals the nudge's filters and
  template to anyone holding the token, so treat the URL as a credential.
- Credentials belong in `.env` locally and in the host's environment dashboard when deployed —
  never in a committed file. `.env.example` is the committed template with no values.
- Basic auth is enforced by edge middleware, so in a **production** build `APP_PASSWORD` /
  `APP_USERNAME` are baked in at `npm run build` time — change them and rebuild. `npm run dev`
  re-reads `.env` on restart.
- Next 16 logs a deprecation warning for the `middleware.ts` file convention (the successor is
  `proxy.ts`). It still works and is left as-is because auth depends on it; migrate deliberately
  with `npx @next/codemod@canary middleware-to-proxy .` and re-test both the app and `/api/track/*`
  if you want the warning gone.

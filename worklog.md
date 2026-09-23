# Worklog

---
Task ID: 1
Agent: Main agent (Super Z)
Task: Build "Nudge Engine" app — Zoho CRM lead sync + email nudges with send logs + open tracking (replacing n8n + Google Sheets), extensible for future nudge types.

Work Log:
- Loaded fullstack-dev skill, initialized Next.js 16 project at /home/z/my-project
- Analyzed user's n8n open-tracking flow JSON (webhook email-open → match row → update opens → return 1x1 GIF) and Zoho curl (EPS leads, status exclusions, created after 2026-07-01, KYC <= 11)
- Designed Prisma schema: Lead (synced from Zoho, zohoId unique), Nudge (key, zohoCriteria, filters JSON, subject/body templates, maxEmailsPerLead, followUpDays), EmailLog (per-send record: trackingId unique, sentOk, opensCount, openedAt, engagementStatus; cascade delete with Lead/Nudge)
- Pushed schema to SQLite (db/custom.db), installed nodemailer
- Built libs:
  - src/lib/zoho.ts — OAuth refresh-token flow with in-memory cache + static-token fallback + one 401 retry; Leads/search with criteria, pagination (page + next_page_token), field mapping (Full_Name, KYC_Document_Upload_Count, Owner.name, Business_vertical, etc.)
  - src/lib/mailer.ts — nodemailer SMTP from env (Zoho Mail defaults), isMailerConfigured check
  - src/lib/template.ts — {{var}} renderer, HTML escape, tracking-pixel injection before </body>, htmlToText
  - src/lib/nudge-engine.ts — filters parser (requireEmail/excludeStatuses/businessVertical/min-maxKycCount/createdAfter), sequence decision (replied → skip; sentOk count >= max → max_reached; followUpDays gap → waiting_followup with next-eligible date; else send email#N), runNudge (optional Zoho sync → select → send with 250ms spacing → log), previewNudge (dry run)
  - src/lib/base-url.ts — public base URL from x-forwarded-host for pixel URLs
- API routes:
  - POST /api/zoho/sync (default criteria = user's curl; optional body override)
  - GET /api/leads (search), GET /api/stats (dashboard aggregates)
  - GET/POST /api/nudges (auto-seeds "documents_pending" nudge with the exact curl criteria + template on first call)
  - GET/PATCH/DELETE /api/nudges/[id]
  - POST /api/nudges/[id]/run (body {sync:bool} default true), GET /api/nudges/[id]/preview
  - GET /api/logs (filters: nudgeId/status/q)
  - GET /api/track/open/[trackingId] AND GET /api/track/open?tid= (n8n parity) — ALWAYS return 200 image/gif, opens_count increments each hit, opened_at keeps first open, engagement never downgrades
- UI at / (only visible route): header with Sync Zoho Leads button, tabs Dashboard / Leads / Nudges / Email Logs; nudge cards with Run (confirm dialog + sync toggle), Preview (dry-run dialog), Edit (full config dialog), Delete; stat cards; log tables with status badges; 20s auto-poll on dashboard/logs; responsive + sticky footer
- .env: ZOHO_* (user's token as fallback, placeholders for client_id/secret/refresh_token), SMTP_* (smtp.zoho.in defaults), MAIL_FROM, APP_BASE_URL
- Fixed during dev: exported helper from route file (moved to lib), missing NextResponse import in query-param pixel route
- Verified end-to-end with curl + temp test lead: preview → run(sync=false) → failed-send logged with clear SMTP error → pixel unknown-tid 200 GIF → 2 real opens → opensCount=2 first-openedAt preserved → retry of failed send → waiting_followup skip → max_reached skip (4/3). Test data cleaned up.
- Browser-verified via agent-browser: dashboard renders, nudges tab interactions (preview dialog, run confirm with sync toggle, new nudge form), logs/leads tabs, mobile 390px layout, no console errors
- bun run lint: clean

Stage Summary:
- Deliverable: runnable Next.js 16 app "Nudge Engine" — Google Sheets fully replaced by SQLite via Prisma; n8n open-tracking flow replicated as /api/track/open endpoints (including ?tid= parity and always-GIF guarantee)
- Extensibility: a new nudge = one config row (key + optional Zoho criteria + local filters JSON + subject/body template + sequence limits); no new flows to build
- User must add: ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN (token from curl already expired), SMTP_USER/PASS/MAIL_FROM to actually send
- Known behavior: Zoho sync fails loudly with 401 until refresh-token env vars are set; runs can be done with sync=false on already-synced leads

---
Task ID: 2
Agent: Main agent (Super Z)
Task: Add WhatsApp nudge support (Meta WhatsApp Business Cloud API) alongside email, using the user's number 9599722251 (to be registered as +91 95997 22251 in Meta).

Work Log:
- Schema migration: EmailLog -> MessageLog (channel-aware: email|whatsapp; toPhone, templateName added; subject/toEmail nullable; messageId indexed for webhook lookups; messageNumber renamed from emailNumber). Nudge gains channel, whatsappTemplateName, whatsappLanguage, whatsappParams; subjectTemplate/bodyTemplate now nullable (WhatsApp uses bodyTemplate as reference copy only). Pushed via db:push --accept-data-loss (no real data yet).
- New src/lib/whatsapp.ts: Meta Cloud API sender (graph.facebook.com/{version}/{phone_number_id}/messages, template + positional body params), isWhatsAppConfigured, normalizePhone (strips non-digits, 10-digit -> default CC 91, e.g. 8899112233 -> 918899112233), applyWhatsAppStatus (read->opened with first-read timestamp kept, failed->sendError), applyWhatsAppInbound (latest log for that phone -> replied).
- New webhook /api/track/whatsapp: GET = Meta subscription verification handshake (hub.mode/hub.verify_token/hub.challenge, WHATSAPP_VERIFY_TOKEN); POST = statuses (sent/delivered/read/failed) + inbound messages, always 200 to Meta.
- nudge-engine: buildWhere(filters, channel) — email requires email not null (requireEmail), whatsapp requires phone-or-mobile (requirePhone); run/preview branch per channel; WhatsApp params JSON array of variable sources rendered through the same lead vars and sent positionally as {{1}}, {{2}}...; RunSummary/Preview now carry channel + whatsappConfigured.
- API routes: nudges CRUD validates per-channel (email needs subject+body; whatsapp needs approved template name + params array); nudges GET seeds both default nudges on empty table; logs route adds channel filter + toPhone; stats renamed to messagesSent/Failed; pixel routes use messageLog; leads route relation fix.
- UI: channel select in nudge form with per-channel fields (Meta template name/language/params vs subject/body), green setup-hint box showing the Meta webhook URL (origin + /api/track/whatsapp) and required env vars; channel badges on cards and log rows; Logs tab gets channel filter; Dashboard recent activity shows channel icons; footer lists both tracking endpoints.
- .env: WHATSAPP_DISPLAY_NUMBER=919599722251, WHATSAPP_DEFAULT_CC=91, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN=mytesttoken (placeholder to change), WHATSAPP_API_VERSION=v21.0.
- scripts/seed-whatsapp-nudge.ts: idempotent seed of disabled 'documents_pending_wa' nudge (same Zoho criteria + filters as email twin, template name placeholder 'documents_pending_reminder', params [first_name, company, kyc_document_upload_count]).
- Fixed during dev: dev server held stale Prisma client after EmailLog->MessageLog rename; restarted dev process tree to reload generated client.
- Verified end-to-end: WA run with sync=false -> lead considered, phone normalized, failed log with clear not-configured error; simulated sent -> webhook POST status 'read' -> opened=true opensCount=1; webhook POST inbound from 918899112233 -> replied=true engagement 'replied'; preview then skips with reason 'replied'; verification handshake returns challenge for correct token, 403 for wrong token; email nudge regression passed; lint clean; browser-verified both nudge cards with channel badges, WA form + setup hint, no console errors.

Stage Summary:
- App is now dual-channel: email (SMTP) and WhatsApp (Meta Cloud API) nudges share one engine, one log table, one UI, same sequence logic (replied/max_reached/waiting/retry).
- User actions to go live on WhatsApp: register 9599722251 in Meta WhatsApp Manager, approve a template (e.g. documents_pending_reminder with 3 body params), fill WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID + change WHATSAPP_VERIFY_TOKEN in .env, set webhook URL in Meta app dashboard, enable documents_pending_wa nudge, fill in its template name.
- Reply tracking is FREE on WhatsApp (inbound webhook) vs email (not yet implemented for email).

---

Task ID: 3
Agent: Main agent (DeepSeek Harness)
Task: Hardening pass — make the app runnable on the current machine, close the security/credential gaps, add scheduling and email reply tracking, fix correctness bugs.

Work Log:
- Environment: rewrote .env into grouped, documented sections. DATABASE_URL was an absolute Linux path (/home/z/my-project/db/custom.db) -> now file:../db/custom.db (relative to prisma/schema.prisma, verified via `prisma db push` resolving to the project's db/custom.db). Added PRISMA_LOG_QUERY, auth, scheduler, IMAP, EMAIL_WEBHOOK_SECRET, WHATSAPP_EMPTY_PARAM_FALLBACK, APP_HOST, legacy n8n + Infinito values.
- Credentials: moved the real Zoho CRM (client id/secret/refresh token), Zoho Mail (account id, from address, client id/secret/refresh) and Infinito API key out of the pasted n8n JSON into .env, and redacted them in upload/*.txt. Generated fresh APP_PASSWORD, CRON_SECRET, WHATSAPP_VERIFY_TOKEN, EMAIL_WEBHOOK_SECRET.
- Toolchain: package.json scripts were POSIX-only (tee/cp/NODE_ENV=) and the project had no node_modules. New cross-platform scripts (dev/build/start/typecheck/lint/db:*), name -> nudge-engine, added imapflow + @types/node, added postinstall `prisma generate`, added scripts/postbuild.mjs (cross-platform copy of .next/static + public into .next/standalone), .npmrc with an in-workspace npm cache. Removed unused scaffold deps next-auth/next-intl/@mdxeditor/editor/z-ai-web-dev-sdk (next-auth also caused an ERESOLVE conflict with nodemailer 10).
- Auth: new src/middleware.ts — HTTP Basic over the whole app using APP_USERNAME/APP_PASSWORD, timing-safe compare, fails closed when AUTH_ENABLED=true and no password is set. Public by necessity: /api/track/* (inboxes and Meta cannot authenticate) and /api/cron/* (validated by shared secret in-route).
- Scheduler: new src/lib/scheduler.ts (in-process interval, overlap guard, per-nudge error capture, status snapshot) started from src/instrumentation.ts; endpoints POST /api/cron/run, GET+POST /api/cron/replies (CRON_SECRET via x-cron-secret / Bearer / ?secret=), GET /api/scheduler for the UI.
- Email reply tracking: new src/lib/reply-tracker.ts — IMAP polling (imapflow, gated on IMAP_ENABLED) matching In-Reply-To/References against sent message-ids with a from-address fallback, plus a public reply webhook /api/track/email (EMAIL_WEBHOOK_SECRET). Replies mark the log replied, which stops the follow-up sequence.
- Correctness: WhatsApp template params no longer drop empty values (that shifted every later {{n}} into the wrong slot) — order is preserved with WHATSAPP_EMPTY_PARAM_FALLBACK; email body variables are now HTML-escaped (lead data could inject markup); preview now mirrors run-time phone validation so it never promises an undeliverable WhatsApp send; per-run batch cap (NUDGE_MAX_PER_RUN) defers leftover leads instead of running past the request timeout, surfaced as `deferred`/`batch_limit` in the UI.
- Fixed flagged loose ends: leads-tab read `l.emailsSent` but the API returns `messagesSent` (column was always blank, header said "Emails" -> "Messages"); db.ts logged every SQL query (now opt-in); next.config no longer sets typescript.ignoreBuildErrors; layout metadata/branding updated off the Z.ai scaffold; deleted the leftover src/app/api/route.ts hello-world; .gitignore now ignores /db/*.db and /.npm-cache; tsconfig excludes examples/ (scaffold code that failed typecheck); eslint disables react-hooks/set-state-in-effect with a rationale comment.
- Dashboard: added a Scheduler card (enabled state, cadence, cycles completed, last cycle, IMAP reply-sync result, per-nudge errors) and run-result/confirm dialogs now explain the batch cap.
- Docs: new README.md (setup, command table, full env reference, HTTP surface with auth per route, scheduling, tracking setup, security notes).
- Verified: npm install clean (680 packages, --ignore-scripts needed only because the sandbox blocks npm's postinstall spawn); prisma generate OK; Prisma runtime read confirmed against db/custom.db (0 leads / 2 nudges / 0 logs); `tsc --noEmit` clean; `eslint .` clean.

Stage Summary:
- The app now runs on this machine (Windows, npm) instead of only in the original Linux sandbox.
- Every credential lives in .env; the pasted workflow files are redacted. Rotate the Zoho/Mail/Infinito secrets anyway — they were in plain text.
- Remaining user actions to go live: set SMTP_USER/SMTP_PASS (mailbox password for do.not.reply@eko.co.in) to send email; fill WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID after Meta approves the number/template; set APP_BASE_URL for working pixels; optionally enable IMAP_ENABLED for email reply tracking.

---

Task ID: 4
Agent: Main agent (DeepSeek Harness)
Task: Wire up the external Simplibank MySQL (the source the original n8n CSP/WhatsApp flows read from) as a read-only connection.

Work Log:
- .env: added a documented "Simplibank MySQL (EXTERNAL source, READ-ONLY)" section — SB_READ_HOST/SB_WRITE_HOST/SB_USER/SB_PASSWORD/SB_NAME/SB_PORT plus new knobs SB_CONNECTION_LIMIT, SB_CONNECT_TIMEOUT_MS, SB_LOG_QUERY. Clearly separated from the app's own SQLite store.
- New src/lib/sb-db.ts: mysql2/promise pool (lazy singleton on globalThis), big-number-safe and date-string config, multipleStatements off. Exposes queryRead / queryReadOne / pingSbDb / listSbTables / describeSbTable / closeSbPool. No write helper exists, by design.
- Read-only enforced in three layers: (1) assertReadOnly() allows only SELECT/SHOW/DESCRIBE/EXPLAIN/WITH and rejects stacked statements; (2) SET SESSION TRANSACTION READ ONLY on every pooled connection; (3) no write API exported.
- New GET /api/db/health (behind the app password) — connectivity, server version, current user, read-only-session flag, latency; ?tables=1 lists tables, ?describe=<table> dumps columns.
- New scripts/check-sb-db.mjs + `npm run db:check` — ping, table list, column dump for the three tables the n8n flow used, and a write-rejection assertion.
- Installed mysql2.
- Bug found and fixed while verifying: the first type-safe version used `connection.query(...).catch()` in the pool 'connection' handler, but mysql2 hands over the *callback-style* connection there, so that call returned a non-promise and the SET silently never ran (runtime warning: "called .then()/.catch() on a result that is not a promise"). Reverted to the callback API behind an explicit cast so it is both type-safe and actually executes.
- Verified against the live DB: connected as appuser@% to 104.211.95.160:3306/ekodb_icici (MySQL 5.7.29), ~180ms latency, readOnlySession=true, 1024 tables visible, csp_application (18 cols), customer_agreement_history (14) and csp_docs (7) all present with exactly the columns the n8n queries referenced, and `DELETE FROM csp_application` is rejected by the guard. `tsc --noEmit` clean, `eslint .` clean.

Stage Summary:
- The external business DB is available to any flow that needs it via `queryRead`/`queryReadOne` from @/lib/sb-db, and cannot write.
- Read scaling note: pool defaults to 5 connections; production MySQL 5.7 with 1024 tables — keep ad-hoc queries limited and indexed.
- Decision (recorded 2026-09-22): the connection layer is all that's wanted for now — no MySQL-backed flow is being built yet. When one is added, the contact number for a CSP is **`'91' + csp_number`** (same as the original n8n flow), not `alternate_mobile` from `cspdata_json`. Confirm at that point that `csp_number` is a 10-digit mobile rather than an agent code.
- Ready for the next step: `queryRead`/`queryReadOne` from @/lib/sb-db, `GET /api/db/health?tables=1&describe=<table>` for schema discovery, `npm run db:check` for a connectivity smoke test.

---

Task ID: 5
Agent: Main agent (DeepSeek Harness)
Task: Diagnose the Render deployment warning and remediate the credential exposure found while doing so.

Work Log:
- Render: user's service nudge-engine (https://nudge-engine.onrender.com) runs on the Free instance type. Render's free tier spins down when idle and does not support persistent disks. For this app that is not cosmetic: the SQLite file is on an ephemeral filesystem, so every deploy/restart wipes MessageLog -> the per-lead sequence state resets (leads get re-emailed up to maxEmailsPerLead), every trackingId disappears (pixels still return a GIF but match no row, so opens/replies stop being recorded), the in-process scheduler never fires while asleep, and ~30-60s cold starts exceed mail-client image timeouts.
- SECURITY INCIDENT (the more serious finding): the repo BAGAsg121/budges_flow is PUBLIC ("visibility":"public" via the GitHub API) and `.env` was tracked. Confirmed present in HEAD:.env: ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_MAIL_REFRESH_TOKEN, INFINITO_API_KEY, APP_PASSWORD, CRON_SECRET, WHATSAPP_VERIFY_TOKEN. db/custom.db was tracked as well. The Simplibank MySQL password was NOT yet exposed (still uncommitted at the time of writing), but it sat in the same tracked file.
- Remediation applied: `git rm --cached .env db/custom.db` (files kept on disk, staged for removal) so neither can be re-committed. .env already matched `.env*` in .gitignore; added an explicit `!.env.example` exception and created a value-free .env.example template. NOTE: this removes them going forward only — both remain in git history, so rotation is still mandatory.
- Deployment hardening: new public GET /api/health (liveness only, no data) added to middleware's PUBLIC_PREFIXES so it can serve as a Render health check and a keep-alive target; new `db:deploy` script (`prisma db push --skip-generate`) because the DB file is no longer committed, so a fresh clone has no tables; new deploy/render.yaml reference blueprint (kept out of the repo root so Render does not offer to create a duplicate service) documenting the disk mount, DATABASE_URL=file:/var/data/custom.db, HOSTNAME=0.0.0.0 (containers set HOSTNAME, which Next's standalone server binds to) and APP_BASE_URL; README gained a "Deploying to Render" section with the free-vs-paid trade-off table and the exact dashboard settings.
- Verified: tsc --noEmit clean, eslint clean, git status shows the two staged deletions with both files still present on disk.

Stage Summary:
- USER ACTION REQUIRED, in this order: (1) rotate every credential listed above — they are public and must be considered compromised; (2) make the repo private and/or purge history (filter-repo/BFG) — removing the files does not remove them from past commits; (3) before the next deploy, set all env vars in Render's Environment tab, because .env will no longer ship with the repo (otherwise the next deploy starts with no configuration); (4) decide on storage: Starter instance + persistent disk, or migrate the app store to Postgres. Staying on free means duplicate emails to real customers.

---

Task ID: 6
Agent: Main agent (DeepSeek Harness)
Task: Move the app's own store off ephemeral SQLite and into the existing Simplibank MySQL server — create the required tables once and point the app at them. Nothing else.

Work Log:
- Constraint from the user, treated as absolute: create the tables once, then only insert/update rows in them; never create additional tables; never delete or alter anything; all data lives in that database.
- Added scripts/create-nudge-tables.mjs — the ONLY thing permitted to create these tables. It emits exactly three `CREATE TABLE IF NOT EXISTS` statements (nudge_lead, nudge_config, nudge_message_log), is idempotent, and has a self-guard that refuses to run if any statement is not a CREATE TABLE IF NOT EXISTS or contains DROP/ALTER/TRUNCATE/RENAME/DELETE FROM.
- Table names are prefixed `nudge_` deliberately: the database already contains its own `messagelog`, so an un-prefixed `MessageLog` would have collided on a case-insensitive server and been a landmine on a case-sensitive one.
- Ran it once. Verified 1024 -> 1027 tables, i.e. exactly three added, nothing else touched. Column types chosen to need no later ALTER: TEXT for description/zohoCriteria/filters/subjectTemplate/whatsappParams/sendError/subject, LONGTEXT for bodyTemplate (full HTML emails), VARCHAR(512) for sheetRowRef, VARCHAR(255) for messageId with a 191-byte prefix index (SMTP ids can exceed Prisma's 191 default, and a plain VARCHAR(191) would have errored on insert in strict mode).
- prisma/schema.prisma: provider sqlite -> mysql, added @@map to the three prefixed tables, @db.Text/@db.LongText/@db.VarChar annotations, and @@index([messageId(length: 191)]). Regenerated the client.
- .env: DATABASE_URL is now mysql://appuser:***@104.211.95.160:3306/ekodb_icici (the password's "@" percent-encoded as %40). Old SQLite value left commented for reference; db/custom.db is now unused.
- Safety: `prisma db push` / `prisma migrate` must never run against this database — Prisma diffs the schema against the ENTIRE database and can propose destroying the ~1024 business tables it does not recognise. Added scripts/refuse-schema-push.mjs and wired db:push / db:push:force / db:deploy to it so the destructive command cannot be run by accident. Removed db:deploy from the Render build command.
- Docs: README gained a "Two stores inside one MySQL server" section (app store vs read-only business data, with the why-prefixed rationale and the db-push warning); the Render section was rewritten because the free-tier durability problem is now solved (remaining issues are only scheduler-while-asleep and cold-start pixel timeouts); render.yaml drops the disk/Starter requirement; .env.example updated.
- Verified end-to-end against the live server: Prisma connected to ekodb_icici (MySQL 5.7.29), saw all three nudge_* tables, read counts (0/0/0 on the fresh tables), and an INSERT inside a deliberately rolled-back transaction succeeded and left nothing behind. tsc --noEmit clean, eslint clean.
- src/lib/sb-db.ts is unchanged and still read-only — the app's own writes go through Prisma models, which only ever address the three nudge_* tables. Business tables remain unreachable for writes.

Stage Summary:
- The app now stores leads, nudge config and the message log in MySQL, so deploy/restart/spin-down no longer wipes the send ledger and cannot cause duplicate re-sends.
- Exactly three tables were created, in one pass, with no drop/alter anywhere; the create script is idempotent and self-guarded, and schema-push is actively blocked.
- Still outstanding from Task 5: credential rotation, repo visibility, and setting env vars in Render (DATABASE_URL now included) before the next deploy.

---

Task ID: 7
Agent: Main agent (DeepSeek Harness)
Task: Correct the Zoho fetch window/filters, remove KYC from the fetch, add four new nudges, and verify lead integrity.

Work Log:
- Answered the open question with live data rather than assumption: the fetch was NOT "August and September" — the stored criteria was `Created_Time:greater_than:2026-07-01` (July onwards) plus `KYC_Document_Upload_Count:less_equal:11`. Real lead data: 331 EPS leads, createdTime 2026-07-07 .. today.
- Two data-quality findings that would have silently broken the new nudges:
  1. The real CRM status values contain SPACES ("Onboarding Started", "Agreement Signed"), not the underscores the request used. A filter of "Onboarding_Started" matches nothing.
  2. The old fetch excluded `not_equal:Unqualified`, but the real value is "Unqualified (Junk)" — so 37 junk leads were never excluded. Also "Unqualified (Junk)" contains parentheses, which is unsafe inside a Zoho criteria string.
  Resolution: fetch EPS + created-after only, and do ALL status filtering locally via exact match.
- New src/lib/nudge-defaults.ts as the single source of truth (criteria, status constants, KYC threshold, and all five nudge definitions). Removed the duplicated DEFAULT_CRITERIA that lived in both /api/nudges and /api/zoho/sync.
- Fetch window is now `Created_Time:greater_than:2026-08-01T00:00:00+05:30` with no upper bound, so it is Aug 1 -> "now" and stays correct as time passes. No KYC filter, no status filter.
- nudge-engine: added `includeStatuses` to NudgeFilters/buildWhere (exact-match allow-list; takes precedence over excludeStatuses).
- Nudges: `onboarding_started_agreement` (Onboarding Started -> agreement signing); `documents_pending` re-scoped to Agreement Signed + `maxKycCount: 10` (i.e. KYC < 11, the real "pending" boundary); `onboarded_transacting` and `onboarded_not_transacting` (manual Google Sheet, pay CTA to eps.eko.in/console/pay-activation-fee). `documents_pending_wa` realigned to the same status/KYC scoping.
- Impact check on documents_pending before/after: with the old unscoped filters it would have emailed 282 leads across every status; it now targets 47 (Agreement Signed). onboarding_started_agreement targets 173.
- Manual vs synced nudges are distinguished by `zohoCriteria: null` (no schema change — a new column would have required ALTER, which is off-limits on this shared database). The UI now hides Run/Preview and shows a "Manual / Sheet" badge for those, because Run would otherwise email all 331 synced leads.
- sheet-run: added `mobile` aliases (mobile/mobile_number/phone/phone_number/contact/contact_number/whatsapp) plus a normalised `mobile_digits` (strips +91/leading zero) so the pay link cannot break on formatting. Templates use `{{mobile_digits}}`, not raw `{{mobile}}`.
- /api/nudges seeding changed from "only when the table is empty" to create-if-missing per key, so new built-in nudges reach an existing database without ever reverting UI edits. `--force` opts into refreshing existing rows.
- Lead integrity verified against the live table (331 leads): 0 duplicate zohoId, 0 duplicate email, 0 rows missing status/KYC/createdTime/zohoId. 49 rows have no email (expected — they are skipped by `requireEmail`). So there was nothing to "clear": the imported leads are complete. The de-dup guarantee is the `zohoId @unique` constraint plus upsert-on-zohoId in syncLeadsFromCriteria, both already in place. 4 leads predate 2026-08-01 and remain in the table (reported, left alone).
- New scripts/seed-nudges.mjs + `npm run seed:nudges` (create-if-missing, `--force` to refresh, prints a per-nudge targeting preview and a lead-integrity report). Ran it against the live database; all five nudges now exist with correct scoping.
- scripts/verify-changes.mjs extended from 21 to 45 assertions covering the criteria contents, status spacing, per-nudge scoping, manual-nudge convention and the pay-CTA rendering. All pass. tsc --noEmit clean, eslint clean.

Stage Summary:
- Fetch is now EPS, 1 Aug -> now, unfiltered at source; all status/KYC decisions are local and exact.
- Four nudges delivered as requested, two of them manual Google Sheet flows with the activation-fee CTA.
- Nothing was deleted. Lead data was already clean, and de-dup is enforced by a unique constraint rather than by cleanup.

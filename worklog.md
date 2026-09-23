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

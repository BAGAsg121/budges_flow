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

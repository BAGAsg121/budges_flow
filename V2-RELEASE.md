# Nudge Engine — Version 2 Release

**Prepared:** 12 October 2026
**Scope:** journey tracking, lead scoring, CRM stage attribution, time-to-conversion, nudge-impact reporting
**Deployed:** https://nudge-engine.onrender.com

---

## 1. Release verdict

**Version 2 is built, verified and running in production.** Every V2 surface is live: the
`nudge_lead_stage_history` table is recording transitions, all 6,144 leads carry a score, the Journey
board renders attributed transitions with confidence, and the impact-report endpoints answer.

The full health check on the deployed instance returns **up** for all five dependencies:

| Check | State | Detail |
| --- | --- | --- |
| Database | up | 6,144 leads stored |
| Zoho CRM API | up | EPS leads created after 2026-08-01 |
| Zoho CRM MCP | up | CRM reads go through the MCP server |
| WhatsApp (Meta) | up | template language `en_US` |
| Email | up | sending via Zoho as do.not.reply@eko.co.in |

**Three things to know before calling it finished** — none of them blocks the V2 analytics features
themselves, and all three are operational rather than code:

1. **The business MySQL the app reads is the DEV instance, not production.** `SB_READ_HOST` resolves
   to `dev.simplibank.eko.in`, and the newest row in `verify_csp` is dated **23 Sep 2026** — roughly
   three weeks stale. The two enabled MySQL-driven nudges (`mobile_otp_pending`,
   `documents_pending_upload`) therefore run on schedule and find nobody. They are harmless today
   precisely because the data is stale; pointed at production they become live. **Production MySQL
   sits behind an SSH tunnel to a private address and is not reachable from Render.** See §8.
2. **The production scheduler is ON.** Render has `SCHEDULER_ENABLED=true` (the local `.env` has it
   `false`) with a 15-minute interval, and **7 nudges are enabled**. This is safer than it first
   looks: only **two** of those seven are scheduler-eligible — the two MySQL-driven WhatsApp flows —
   and they currently find nobody because the business DB is stale (item 1). The other five are
   manual: three sheet-driven WhatsApp nudges and two sheet-driven email nudges, none of which has
   `zohoCriteria` and none of which can fire on its own. So nothing is being sent unexpectedly. See
   §6 for the full picture.
3. **Lead scoring works, but the model is provisional by design.** The weights are a judgement call,
   not a fitted result, and there is not yet enough labelled history to say they are the best
   weights available. This is called out in full in §4.

---

## 2. What V2 added

| # | Feature | Where it lives | State |
| --- | --- | --- | --- |
| 1 | **Journey tracking** — every CRM stage transition for every lead | `nudge_lead_stage_history`, `src/lib/journey-sync.ts` | Live, 95 transitions recorded |
| 2 | **Lead score** — engagement score 0–100 with a stored breakdown | `Lead.engagementScore`, `src/lib/journey.ts`, `src/lib/score-leads.ts` | Live, all 6,144 leads scored |
| 3 | **Attribution** — which nudge was last sent before a stage change, and how much credit it can take | `LeadStageHistory.triggeredByNudgeId`, `pickAttribution()` | Live, with confidence bands |
| 4 | **Time-to-conversion** — days from first nudge to `Closed Won`, and hours spent in each stage | `Lead.totalDaysToConvert`, `timeInPrevStageHours()` | Live |
| 5 | **Impact reporting** — stage flow and per-nudge impact endpoints | `/api/reports/stage-flow`, `/api/reports/nudge-impact` | Live |
| 6 | **Journey board** — clickable transition list with the lead's whole lifecycle behind it | Journey tab, `/api/leads/[id]/journey` | Live |

Alongside V2 proper, this cycle also delivered: CTA click tracking for WhatsApp (§5), the log export
to Excel by date range and nudge type, the failed-logs tab with retry, the Documents Submitted and
Documents Pending WhatsApp nudges, the eight sandbox nudges, and the sync-today windowing that
carries the last sync time forward.

---

## 3. How it works

### 3.1 Journey tracking

Two independent paths write to `nudge_lead_stage_history`, and they are complementary:

- **On sync.** Every Zoho fetch compares the incoming status with the status we already hold. A
  difference is a transition. This catches everything, but only as often as we sync.
- **On webhook.** Zoho pushes a stage change to `POST /api/hooks/lead`, which compares against the
  stored status and records the transition immediately. This catches changes between syncs.

Two deliberate silences:

- A lead's **first sighting is not a transition.** We do not know where it came from, so we record
  the status and nothing else. Without this rule, the first sync of a 6,000-lead backlog would
  invent thousands of transitions from nowhere.
- A **null previous status is not a transition** either, for the same reason.

`timeInPrevStageHours` is consequently `—` for a lead's first observed change and filled in for every
change after it. That dash is information, not a bug.

### 3.2 Attribution — and why it never claims causation

When a transition is recorded, `pickAttribution()` looks back over the lead's successful sends and
credits **the most recent one that landed inside the attribution window** (default
`ATTRIBUTION_WINDOW_HOURS=72`). If nothing qualifies, the transition is stored as
**organic — no attribution** rather than being quietly pinned on an older nudge.

This is a probabilistic statement and the system says so everywhere: *"this nudge was the last thing
we sent before the status changed"*, never *"this nudge caused it"*. A lead can move stage for a
hundred reasons we cannot see — a phone call, an internal approval, a competitor. The window bounds
the guess; it does not justify it. Every API response that carries attribution also carries
`attributionIsProbabilistic: true`.

**Confidence.** "Which nudge was last sent" is weak on its own, so it is described rather than
asserted. Three bounded factors, each reported with its reasoning so it can be argued with:

| Factor | Max | How it scores |
| --- | --- | --- |
| **Proximity** | 45 | ≤1h → 45 · ≤6h → 35 · ≤24h → 25 · ≤48h → 15 · else 8 |
| **Engagement** | 35 | replied → 35 · tapped the CTA → 25 · opened → 15 · sent only → 0 |
| **Uniqueness** | 20 | only nudge in the window → 20 · two → 12 · three or more → 6 |

Bands: **≥60 Strong · 30–59 Moderate · <30 Weak.** A *Weak* result is a real answer — it says
"something else probably did this".

### 3.3 The score

Full detail in §4. In one line: an additive points model over successful sends and their outcomes,
clamped to `SCORE_MAX` (100), recalculated hourly by `/api/cron/score-leads` and immediately after
any webhook-delivered stage change.

Two rules inside it are load-bearing and are not decoration:

- **Failed sends earn nothing.** A message that reached nobody is not engagement.
- **WhatsApp sends stop counting after 10 points.** Being messaged repeatedly is not engagement.
  Without the cap, a long sequence would inflate the score of someone who never opened anything.

**The score never affects eligibility.** Nothing in the send path reads `engagementScore`. Run
eligibility remains entirely the filters' business — status, KYC counts, business vertical. That
separation is deliberate and is asserted in the verification suite.

### 3.4 Time-to-conversion

`totalDaysToConvert` is stamped on the first transition into a "converted" status. Which status that
is is configurable via `CONVERTED_STATUSES` (default `Closed Won`) rather than hard-coded, because
CRM vocabulary is not ours to freeze — a lead that is *Closed Won* in one pipeline is *Activated* in
another. It is measured from the lead's **first nudge**, so a lead we never messaged has no
conversion time rather than a misleading one.

### 3.5 Reading the Journey board

**Recorded transitions** lists every detected stage change, newest first. Clicking one opens the
lead's whole lifecycle focused on that transition:

1. **Which lead, from where to where, and how long it took** — including the time spent in the
   previous stage.
2. **Every nudge sent in the window before the change**, newest first, each showing how long before
   the change it went out and what came back (`opened` / `replied` / `CTA ×n`). The credited nudge is
   marked, and the line underneath shows the span from the oldest of them to the moment of change.
3. **How much credit that nudge can take** — the confidence score, with its working shown.

---

## 4. Lead scoring — implemented, but the model is under review

> **This is the part of V2 that should not be treated as settled.** The scoring code is finished and
> running. The *choice of model and weights* is provisional, and this section exists so that decision
> can be made on evidence rather than by default.

### 4.1 What is implemented today

An additive points model. Each signal contributes, the parts are stored individually in
`scoreBreakdown` so the arithmetic can always be shown, and the total is clamped.

| Signal | Points | Notes |
| --- | --- | --- |
| WhatsApp sent | +2 each, **capped at +10** | successful sends only |
| Email sent | +1 each | successful sends only |
| Opened | +5 each | per message actually opened, not per pixel hit |
| Replied | +15 | once, however many replies |
| CTA clicked | +20 | once, however many taps |
| CTA tapped 2+ times | +10 | repeat-interest bonus |
| Status changed | +25 | once |
| **Total** | clamped to `SCORE_MAX` = 100 | `capped: true` when the clamp bites |

| Band | Range |
| --- | --- |
| Cold | 0–20 |
| Warming | 21–45 |
| Engaged | 46–70 |
| Hot | 71–100 |

Recomputed hourly (`SCORE_RECALC_INTERVAL_MINUTES=60`) and on every webhook stage change.

### 4.2 Why it is under review

- **The weights are a judgement call, not a fitted result.** "A reply is worth 15 and a click 20" is
  a reasonable opinion. It is not derived from which leads actually converted.
- **There is no ground truth yet.** The model can only be judged against outcomes — did leads we
  called *Hot* actually convert more often than leads we called *Cold*? We now have 95 recorded
  transitions and are accumulating conversions, which is the beginning of an answer, not yet an
  answer.
- **The model is memoryless.** A click five minutes ago and a click three weeks ago currently score
  the same. Recency almost certainly matters.
- **The bands are absolute.** Fixed thresholds only stay meaningful while the underlying population
  is stable. If a campaign shifts the whole distribution, every lead drifts a band without any real
  change in behaviour.
- **Status change is counted once (+25), not weighted by how far the lead moved.** *Documents
  Pending → Under Review* and *Agreement Signed → Closed Won* score identically, which they probably
  should not.

### 4.3 The candidate approaches to compare

| Approach | What it is | Strength | Weakness |
| --- | --- | --- | --- |
| **A. Current additive model** | Fixed points per signal, clamped | Transparent; anyone can be shown why a lead scored 62; no training data needed | Weights are opinion; no recency; no diminishing returns |
| **B. Recency-decayed additive** | Same points, multiplied by a decay factor so recent engagement counts more | Keeps explainability; fixes the most obvious flaw; small change | Adds a half-life parameter that is itself another judgement call |
| **C. Velocity / trend** | Score the *rate* of engagement, not the total | Surfaces rising leads early, which is when a nudge can still change the outcome | Noisier; thin history per lead makes rate estimates unstable |
| **D. Channel- and stage-aware weights** | Different weights by channel and by where the lead sits in the journey | A reply during *Documents Pending* is not the same signal as one during *Closed Won* | More parameters to justify; more places to overfit |
| **E. Logistic regression on conversions** | Fit weights so the score predicts conversion probability | Evidence-based; gives calibrated probabilities, not arbitrary points | Needs a few hundred labelled conversions; less legible to a business user |
| **F. Rules only, no number** | Drop the 0–100 score; keep explicit tiers | Cannot be over-interpreted; nothing to mis-tune | Loses ranking and prioritisation, which is most of the value |

### 4.4 How to actually decide

The honest test is **calibration**, and it needs no new code:

1. Let transitions and conversions accumulate for **6–8 weeks** on the current model.
2. Build a table of **conversion rate by score band**. If *Hot* leads do not convert more often than
   *Cold* ones, the model is not measuring what we want, whatever the weights say.
3. Plot **conversion rate against raw score** in deciles. If the curve is flat, points are being
   spent on signals that do not predict anything.
4. Use that to **drop or reweight** signals, then re-measure. Repeat.
5. Only consider **(E)** once there are enough labelled conversions for a fit to mean something —
   fitting on a few dozen outcomes would produce confident nonsense.

Candidate next step regardless of which model wins: **(B) recency decay**, because it fixes a known
flaw while keeping the model explainable to the people who have to act on it.

**The same caveat applies to the attribution confidence thresholds** (45/35/20 and the 60/30 bands).
They are reasoned, not fitted, and should be revisited with the same calibration exercise once there
is enough data.

---

## 5. CTA click tracking (WhatsApp)

Until this cycle we could see whether a WhatsApp template was *delivered* but not whether anyone
tapped its button. Now we can see **who** clicked, and feed that straight into the score.

**How it works.** Templates are duplicated under a tracked name — `x` becomes `x_cta` — whose button
URL points at our own endpoint rather than directly at the console. The nudge is attached to the
tracked twin. When a recipient taps:

1. `GET /api/track/cta/<trackingId>` receives the tap. The token is the message's unguessable UUID.
2. The click is counted against that message row (`ctaClicks++`, first tap stamped in
   `ctaClickedAt`), matched to the lead and the nudge — so a click is attributable to a *person*, not
   just a template total.
3. The visitor is **302-redirected to the real destination**, read from the stored row.

Two rules in that endpoint matter more than the tracking:

- **It never shows an error page.** Unknown token, malformed token, database down — the customer
  still lands on the destination. A broken tracker must not cost a sale.
- **It never redirects to a URL from the request.** The destination comes from the stored row, so
  this cannot be abused as an open redirect.

The 302 (not 301) is deliberate: a permanent redirect would be cached and every later tap would skip
the tracker entirely.

This matters for V2 specifically because a click is the single strongest engagement signal the score
recognises short of a reply — **+20, with another +10 for a second tap** — and it is what feeds the
*Engagement* factor in attribution confidence.

---

## 6. The nudge estate

Nudges fall into four families. The authoritative live roster is the Nudges tab (or
`npm run readiness`, which dry-runs every one and reports who it would message and any blocker).

| Family | Source | Examples |
| --- | --- | --- |
| **Template / CRM WhatsApp flows** | MySQL `verify_csp` (formerly n8n) | `mobile_otp_pending`, `pan_verification_pending`, `documents_pending_upload`, `documents_reupload_required`, `csp_details_pending`, `agreement_signature_pending` |
| **CRM-driven WhatsApp nudges** | Zoho CRM via MCP | `documents_pending_wa` (uploads < expected, once a day), `documents_submitted_review` (uploads = expected) |
| **Manual sheet WhatsApp nudges** | Google Sheet | `whatsapp_onboarded_transacting`, `whatsapp_onboarded_not_transacting`, `whatsapp_ip_whitelisting` |
| **Email nudges** | Zoho CRM | `onboarding_started_agreement`, `documents_pending`, `onboarded_transacting`, `onboarded_not_transacting` |
| **Sandbox (V2)** | Zoho CRM | 7 labelled `category: sandbox_whatsapp` — old website lead, sign agreement pending, email missing, documents accepted, documents under review, placeholder name, closed-won credentials |

**Enabled at the time of writing: 7 — and only 2 of them can fire on their own.**

| Enabled nudge | Channel | Trigger | Will it run unattended? |
| --- | --- | --- | --- |
| `mobile_otp_pending` | WhatsApp | MySQL | **Yes** — every scheduler tick, but finds nothing while the business DB is stale |
| `documents_pending_upload` | WhatsApp | MySQL | **Yes** — same |
| `whatsapp_onboarded_transacting` | WhatsApp | Google Sheet | No — only when the sheet is run manually |
| `whatsapp_onboarded_not_transacting` | WhatsApp | Google Sheet | No |
| `whatsapp_ip_whitelisting` | WhatsApp | Google Sheet | No |
| `onboarded_transacting` | Email | Google Sheet | No |
| `onboarded_not_transacting` | Email | Google Sheet | No |

"Enabled" and "scheduled" are therefore not the same thing here: a nudge with no `zohoCriteria` is
never picked up by the scheduler, whatever its enabled flag says.

The eight sandbox nudges ship **disabled** on purpose: several have audiences in the thousands
(`sandbox_email_missing` ≈ 3,900, `sandbox_sign_agreement_pending` ≈ 2,800) and enabling one starts
sending at 50 leads per run.

Every nudge's message states which template it is using, for both WhatsApp and email, so a
recipient's log can always be traced back to the approved template that produced it.

---

## 7. Live numbers (12 October 2026)

| Metric | Value |
| --- | --- |
| Leads stored | 6,144 |
| Leads scored | 6,144 |
| Stage transitions recorded | 95 |
| Leads with a recorded status change | 95 |
| Messages logged | 3,981 |
| Successful sends | 2,538 |
| Enabled nudges | 7 |
| Scheduler | enabled, 15-minute interval |
| Attribution window | 72 hours |

Two send-quality observations worth following up:

- The placeholder-name onboarding nudge ran to completion: **243 delivered, 96 failed** (~28%). The
  earlier sandbox batch failed ~3% of the time. The failures are almost certainly unreachable
  numbers (Meta `131026`), but a 28% rate deserves a look at the failure codes before that nudge is
  enabled for production.
- **Attribution coverage is still thin.** When the first transitions were recorded the sample was
  too small to credit anything, and at 95 transitions the population is still young. The count of
  attributed vs organic transitions has not been re-measured since, so the honest statement is that
  the mechanism is verified against known inputs but the *rate* at which real transitions get
  attributed is not yet established. That is expected while messaging volume is small; it is not
  evidence that nudges do not work, only that there is not yet enough overlap to measure.

---

## 8. Known gaps and risks

| # | Item | Impact | Status |
| --- | --- | --- | --- |
| 1 | **Business MySQL is the dev instance** (`dev.simplibank.eko.in`), newest activity 23 Sep 2026 | The two enabled MySQL WhatsApp flows find nothing. They are inert, not broken. | Open — production MySQL is behind a private SSH tunnel and is unreachable from Render |
| 2 | **Zoho CRM stage-change webhook has delivered nothing yet** | Transitions are currently sync-detected only, so `timeInPrevStageHours` and speeds are coarser than they could be | Open — endpoint verified by dry run; needs Zoho-side configuration confirmed |
| 3 | **Local `next build` cannot be exercised in this environment** | The local sandbox blocks Turbopack's worker processes, so a build is never verified before pushing | Mitigated — Render's own build and deploy succeed, and the deployed instance is healthy |
| 4 | **Zoho REST client secret rejected** (`invalid_client_secret`) | Nothing — every CRM read goes through MCP | Open; re-issue for completeness |
| 5 | **`ctwa_clid` capture from inbound referrals not implemented** | Meta ad-attribution data is lost | Deferred |
| 6 | **Exposed credentials need rotation** (Zoho CRM/Mail, `APP_PASSWORD`, `CRON_SECRET`, WhatsApp verify token) | Security | Open |
| 7 | **Scoring model and attribution thresholds unvalidated** | Prioritisation may not reflect real conversion likelihood | By design — see §4 |

---

## 9. Operations

### Environment variables added for V2

| Variable | Default | Purpose |
| --- | --- | --- |
| `ATTRIBUTION_WINDOW_HOURS` | 72 | How far back to credit a nudge for a stage change |
| `SCORE_RECALC_INTERVAL_MINUTES` | 60 | Background score recalculation |
| `JOURNEY_SYNC_ON_FETCH` | true | Detect stage changes on every Zoho sync |
| `SCORE_MAX` | 100 | Score ceiling; lowering it re-scales the bands |
| `CONVERTED_STATUSES` | Closed Won | Which status counts as conversion |
| `CTA_TRACK_BASE_URL` | — | Public base for the click tracker |
| `CTA_FALLBACK_URL` | `https://eps.eko.in/console` | Where a click lands if the token cannot be resolved |

### Commands worth knowing

| Command | Purpose |
| --- | --- |
| `npm run readiness` | **Dry-run every nudge** — who it would message now, and any blocker |
| `npm run verify` | In-process checks (1,045 assertions) covering templating, escaping, scoring maths, attribution, KYC rules and webhook payloads |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / ESLint |
| `npm run logs:export` | Export logs to Excel by date range, nudge, channel and status |
| `npm run wa:templates` | Check (or create) the Meta templates |

### Data rules held throughout V2

- **No schema push.** Every column and table was added by hand-reviewed, additive DDL only. Nothing
  was ever dropped or altered destructively, and `prisma db push` is hard-refused by
  `scripts/refuse-schema-push.mjs`.
- **Exactly one new table** was created for V2 — `nudge_lead_stage_history`, which the V2 spec
  required. Everything else was additive columns on existing tables.
- **Nothing was deleted.** Every log row written during testing is still present.

---

## 10. Summary

V2 turns the engine from a sender into a system that can be asked *"what happened, and did we have
anything to do with it?"* — journey tracking answers the first half, attribution with honest
confidence answers the second, and the score turns the whole history into a ranking someone can act
on.

The engine is running and healthy. The two open operational items (§8, rows 1 and 2) are about
pointing it at the right data and confirming the CRM-side webhook — not about the V2 code. And the
scoring model, as stated throughout, is implemented and running but should be treated as a first
proposal to be validated against real conversions rather than a settled answer.

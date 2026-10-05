/**
 * MySQL-driven WhatsApp nudges.
 *
 * These mirror the original n8n flows but read the Simplibank database directly through
 * the READ-ONLY connection in @/lib/sb-db (SELECT only, session read-only) instead of
 * Google Sheets + the Infinito API. Delivery goes through the Meta Cloud API.
 *
 * Each flow is a collector that returns recipients; the nudge engine then applies the
 * shared sequence logic (dedupe per phone, max sends, reply stop) and sends the nudge's
 * approved Meta template.
 *
 * Nothing here writes to the database, ever.
 *
 * Flows (mirroring the n8n table):
 *   A csp_details_pending            csp_application   pincode / alt mobile / shop address missing
 *   B mobile_otp_pending             verify_csp        verifyAt empty
 *   C pan_verification_pending       verify_csp        panNumber empty (mobile already verified)
 *   D agreement_signature_pending    customer_agreement_history  latest status <> 1 (not signed)
 *   E documents_pending_upload       csp_docs          any mandatory doc missing
 *   F documents_reupload_required    csp_docs          any mandatory doc rejected
 */
// Relative with an explicit .ts extension (not "@/") on purpose: it keeps this module
// free of path aliases so the CLI scripts can import and exercise the real collectors.
import { queryRead } from './sb-db.ts'

export type MysqlFlowKey =
  | 'csp_details_pending'
  | 'mobile_otp_pending'
  | 'pan_verification_pending'
  | 'agreement_signature_pending'
  | 'documents_pending_upload'
  | 'documents_reupload_required'

export const MYSQL_FLOW_KEYS: MysqlFlowKey[] = [
  'csp_details_pending',
  'mobile_otp_pending',
  'pan_verification_pending',
  'agreement_signature_pending',
  'documents_pending_upload',
  'documents_reupload_required',
]

export function isMysqlFlowKey(value: unknown): value is MysqlFlowKey {
  return typeof value === 'string' && (MYSQL_FLOW_KEYS as string[]).includes(value)
}

export interface MysqlRecipient {
  /** Stable identity for logs/audit (customer_id or csp_number). */
  key: string
  /** Raw phone from the DB; the engine runs it through normalizePhone. */
  phone: string | null
  /** Body parameters, positionally mapped to {{1}}, {{2}}… */
  params: (string | number | null)[]
  /** Value for the template's URL button variable. */
  buttonParam: string | null
  /** Extra context for the skip/result report. */
  detail?: string
}

export interface MysqlFlowOptions {
  /** A: window on csp_application.submittedAt. Default 3 (matches the n8n cadence). */
  lookbackHours?: number
  /** D/E/F: window on the candidate cohort, in days. Default 30. */
  lookbackDays?: number
  /** Hard cap on rows considered, so a query can never run away. */
  limit?: number
  /**
   * E/F only: which customers to check documents for.
   *
   *   'signed' — latest agreement is SIGNED (the n8n cohort: its "Sign agreement done" sheet).
   *   'recent' — any application from the window.
   *
   * The n8n fed the document check from its "Sign agreement done" sheet, so 'signed' is the
   * faithful port. It is also the more sensible rule: uploading documents comes AFTER signing, so
   * nudging a pre-signature applicant about missing paperwork is premature.
   */
  docCohort?: DocCohort
}

export type DocCohort = 'signed' | 'recent'

/** Matches the n8n, whose document check consumed the "Sign agreement done" sheet. */
export const DEFAULT_DOC_COHORT: DocCohort = 'signed'

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim())

/** Meta body params have a total length budget; long doc lists must be trimmed. */
function clampParam(value: string, max = 300): string {
  const v = value.trim()
  return v.length <= max ? v : `${v.slice(0, max - 1)}…`
}

// ---------------------------------------------------------------------------
// A — incomplete signup details
// ---------------------------------------------------------------------------

export async function collectCspDetailsPending(opts: MysqlFlowOptions = {}): Promise<MysqlRecipient[]> {
  const hours = Math.max(1, opts.lookbackHours ?? 3)
  const limit = Math.min(opts.limit ?? 200, 500)

  const rows = await queryRead<{ csp_number: string; customer_id: string; cspdata_json: string | null }>(
    `SELECT csp_number, customer_id, cspdata_json
       FROM csp_application
      WHERE submittedAt >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        AND submittedAt < NOW()
      ORDER BY submittedAt DESC
      LIMIT ?`,
    [hours, limit]
  )

  const out: MysqlRecipient[] = []
  for (const row of rows) {
    let data: Record<string, unknown> = {}
    if (typeof row.cspdata_json === 'string') {
      try {
        const parsed = JSON.parse(row.cspdata_json)
        if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>
      } catch {
        data = {}
      }
    }

    // Same rule as the n8n "Check Application Details" node: any one missing triggers it.
    const missing: string[] = []
    if (!str(data.current_address_pincode)) missing.push('current address pincode')
    if (!str(data.alternate_mobile)) missing.push('alternate mobile')
    if (!str(data.shop_address_line1)) missing.push('shop address line 1')
    if (!str(data.shop_address_line2)) missing.push('shop address line 2')
    if (!str(data.shop_address_state)) missing.push('shop address state')
    if (!missing.length) continue

    const phone = str(row.csp_number)
    out.push({
      key: `csp:${str(row.customer_id) || phone}`,
      phone,
      params: [], // no variables in this template's body
      buttonParam: phone,
      detail: `missing ${missing.join(', ')}`,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// B / C — mobile OTP and PAN, from ONE query
//
// These two flows are not independent: the n8n ran the verify_csp query once and then branched —
//
//     if (verifyAt is empty)            → WhatsApp · Mobile Verification Pending
//     else if (panNumber is empty)      → WhatsApp · PAN Verification Pending
//     else                              → nothing
//
// so B and C are two arms of one decision, not two flows that happen to share a WHERE clause.
// Running the query twice (once per nudge) is not merely wasteful, it is a RACE: verifyAt is
// written by the product within seconds of requestAt (measured: min/max gap 3–8s across the
// table). If verifyAt lands between the two queries, the mobile nudge sends because its snapshot
// showed it empty, and the PAN nudge sends too because its LATER snapshot showed it set with
// panNumber still empty — the same person gets both messages in the same cycle. One query, one
// snapshot, both branches derived from it, so a row can only ever land in one arm.
// ---------------------------------------------------------------------------

interface VerifyRow {
  Id: number
  csp_number: string
  customer_id: number
  requestAt: string | null
  verifyAt: string | null
  panNumber: string | null
}

/** Exported so the pure partition can be tested with hand-built rows. */
export type { VerifyRow }

/** Both arms of the verify_csp decision, plus what the single query actually looked at. */
export interface VerifyBranchSplit {  /** verifyAt empty → mobile verification still pending. */
  mobilePending: MysqlRecipient[]
  /** verifyAt present but panNumber empty → PAN pending. */
  panPending: MysqlRecipient[]
  /** Rows the query returned before branching (so the two arms must sum to this). */
  scanned: number
  /** The effective look-back window, including the overlap (see windowMinutesFor). */
  windowMinutes: number
}

/**
 * The overlap added to a flow's look-back window, in minutes.
 *
 * WHY THIS EXISTS: the n8n's window matched its trigger interval EXACTLY (a 2-hour window on a
 * 2-hour trigger), which has no margin at all. If a run is even a minute late, rows that arrived
 * between the two runs fall outside the next window and are never seen — silently, because a
 * missed customer looks identical to a quiet hour. An overlap costs nothing here: `requestAt` is
 * NOT indexed (only PRIMARY(Id)), so `EXPLAIN` reports `type=ALL rows≈4692` for a 2-hour and a
 * 30-day window alike — the window limits rows RETURNED, not rows read. And because de-duplication
 * is once-per-phone-ever, a wider window can never produce a repeat message.
 *
 * Set MYSQL_WINDOW_OVERLAP_MINUTES=0 for the literal n8n window.
 */
export function windowOverlapMinutes(): number {
  const raw = Number(process.env.MYSQL_WINDOW_OVERLAP_MINUTES ?? 30)
  return Number.isFinite(raw) && raw >= 0 ? raw : 30
}

/** Look-back window for a flow, in minutes, including the overlap. Exported for testing. */
export function windowMinutesFor(lookbackHours: number): number {
  return Math.max(1, Math.round(lookbackHours * 60)) + windowOverlapMinutes()
}

/**
 * One snapshot shared by both arms within a single scheduler cycle.
 *
 * Armed by the scheduler around its nudge loop. Outside a cycle there is NO cache, so a manual Run
 * always reads fresh data — a cached result serving a "who should we message" decision to a run the
 * operator just triggered by hand would be the wrong trade.
 */
let snapshotArmed = false
let verifySnapshot: Promise<VerifyRow[]> | null = null

/** Arm the snapshot for one cycle. Idempotent, so nesting or a missing end() cannot corrupt state. */
export function beginMysqlSnapshot(): void {
  snapshotArmed = true
  verifySnapshot = null
}

/** Disarm the snapshot, so the next cycle re-reads. */
export function endMysqlSnapshot(): void {
  snapshotArmed = false
  verifySnapshot = null
}

async function fetchVerifyRows(opts: MysqlFlowOptions): Promise<{ rows: VerifyRow[]; windowMinutes: number }> {
  const hours = Math.max(1, opts.lookbackHours ?? 2)
  const limit = Math.min(opts.limit ?? 500, 1000)
  const windowMinutes = windowMinutesFor(hours)

  // The n8n query carried `AND (verifyAt IS NULL OR panNumber IS NULL)` and that is kept: rows that
  // can never qualify for either arm are fetched and thrown away otherwise.
  //
  // This deliberately does NOT also test the columns for blank strings, which an earlier version
  // added on the reasoning that the n8n If-nodes tested `String(x).trim() === ''`. Two reasons it
  // was wrong:
  //   1. It buys nothing. Measured on the live table: `verifyAt = ''` and `panNumber = ''` match
  //      ZERO rows (both columns hold real datetimes / PAN strings), so the extra predicates can
  //      never select a row that `IS NULL` would have missed.
  //   2. It costs a little and scales badly. Wrapping a column in TRIM() forfeits any chance of an
  //      index being used on it, and it already measures slower (108ms vs 74ms on ~4.7k rows).
  //
  // `INTERVAL ? MINUTE` rather than HOUR so the overlap is exact integer arithmetic rather than a
  // fractional-hours expression.
  const run = () =>
    queryRead<VerifyRow>(
      `SELECT Id, csp_number, customer_id, requestAt, verifyAt, panNumber
         FROM verify_csp
        WHERE requestAt >= DATE_SUB(NOW(), INTERVAL ? MINUTE)
          AND requestAt < NOW()
          AND (verifyAt IS NULL OR panNumber IS NULL)
        ORDER BY requestAt DESC
        LIMIT ?`,
      [windowMinutes, limit]
    )

  if (!snapshotArmed) return { rows: await run(), windowMinutes }

  // Inside a cycle: exactly one query per window, shared by both arms.
  if (!verifySnapshot) verifySnapshot = run()
  return { rows: await verifySnapshot, windowMinutes }
}

/**
 * The branch decision on already-fetched rows — pure, so it can be tested without a database.
 *
 * Mirrors the n8n's node order exactly:
 *   verifyAt empty  → branch 1 (mobile pending)
 *   else panNumber empty → branch 2 (PAN pending)
 *   else → neither; do nothing
 *
 * Mutual exclusivity is per ROW by construction (branch 1 `continue`s). It is deliberately NOT
 * per phone number: two different rows can share a csp_number — the same person requesting a
 * verification twice — and then one row can be mobile-pending while the other is PAN-pending. That
 * is the n8n's behaviour too, and the two messages are different templates, so it is correct.
 */
export function partitionVerifyRows(rows: VerifyRow[]): { mobilePending: MysqlRecipient[]; panPending: MysqlRecipient[] } {
  const mobilePending: MysqlRecipient[] = []
  const panPending: MysqlRecipient[] = []

  for (const r of rows) {
    const phone = str(r.csp_number)
    const key = `csp:${r.customer_id || phone}`

    // Branch 1 — verifyAt empty → mobile verification pending.
    if (!str(r.verifyAt)) {
      mobilePending.push({ key, phone, params: [], buttonParam: phone, detail: 'verifyAt empty' })
      continue
    }
    // Branch 2 — mobile verified, panNumber empty → PAN pending.
    if (!str(r.panNumber)) {
      panPending.push({ key, phone, params: [], buttonParam: phone, detail: 'panNumber empty after verifyAt' })
      continue
    }
    // Branch 3 — both present: do nothing. Unreachable given the WHERE clause, but stated rather
    // than implied, because "no branch matched" must never silently mean "send everything".
  }

  return { mobilePending, panPending }
}

/**
 * The verify_csp decision: one query, then the n8n's branch.
 */
export async function collectVerifyBranches(opts: MysqlFlowOptions = {}): Promise<VerifyBranchSplit> {
  const { rows, windowMinutes } = await fetchVerifyRows(opts)
  const { mobilePending, panPending } = partitionVerifyRows(rows)
  return { mobilePending, panPending, scanned: rows.length, windowMinutes }
}

/** B — mobile verification still pending: verifyAt is empty. */
export async function collectMobileOtpPending(opts: MysqlFlowOptions = {}): Promise<MysqlRecipient[]> {
  return (await collectVerifyBranches(opts)).mobilePending
}

/**
 * C — PAN pending. Mirrors the n8n branch order: only reached once the mobile IS verified, so a
 * lead missing both is nudged for the mobile now and for PAN on a later pass.
 */
export async function collectPanVerificationPending(opts: MysqlFlowOptions = {}): Promise<MysqlRecipient[]> {
  return (await collectVerifyBranches(opts)).panPending
}

// ---------------------------------------------------------------------------
// D — agreement not signed
// ---------------------------------------------------------------------------

export async function collectAgreementSignaturePending(opts: MysqlFlowOptions = {}): Promise<MysqlRecipient[]> {
  const days = Math.max(1, opts.lookbackDays ?? 30)
  const limit = Math.min(opts.limit ?? 300, 1000)

  // Latest agreement row per customer within the window; status 1 means signed (same
  // convention the n8n "Agreement Signed?" node used), so anything else is pending.
  const rows = await queryRead<{ csp_number: string; customer_id: number; status: number; created_at: string | null }>(
    `SELECT h.customer_identifier AS csp_number, h.customer_id, h.status, h.created_at
       FROM customer_agreement_history h
       JOIN (
         SELECT customer_identifier, MAX(id) AS max_id
           FROM customer_agreement_history
          WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          GROUP BY customer_identifier
       ) m ON m.max_id = h.id
      WHERE h.status <> 1
      ORDER BY h.created_at DESC
      LIMIT ?`,
    [days, limit]
  )

  return rows.map((r) => {
    const phone = str(r.csp_number)
    return {
      key: `csp:${r.customer_id || phone}`,
      phone,
      params: [],
      buttonParam: phone,
      detail: `agreement status ${r.status}`,
    }
  })
}

// ---------------------------------------------------------------------------
// E / F — mandatory document checks (ported from the n8n code node)
// ---------------------------------------------------------------------------

interface RequiredDoc {
  key: string
  name: string
  id: number | null
  aliases: string[]
}

/** Ported verbatim from the n8n "Check All Mandatory Documents" node. */
const REQUIRED_DOCS: RequiredDoc[] = [
  { key: 'aadhaar', name: 'Aadhaar Card', id: 1, aliases: ['aadhaar card', 'aadhar card'] },
  { key: 'address_proof', name: 'Address Proof', id: 9, aliases: ['address proof'] },
  { key: 'bank_statement', name: 'Bank statement', id: 7, aliases: ['bank statement'] },
  { key: 'board_resolution', name: 'Board Resolution (BR)', id: null, aliases: ['board resolution', 'board resolution (br)', 'br'] },
  {
    key: 'coi',
    name: 'Certificate of Incorporation (COI)',
    id: 6,
    aliases: ['certificate of incorporation', 'certificate of incorporation (coi)', 'coi'],
  },
  { key: 'aoa', name: 'Company Articles of Association (AOA)', id: 5, aliases: ['aoa', 'company articles of association', 'aoa - company articles of association'] },
  { key: 'company_pan', name: 'Company PAN', id: 8, aliases: ['company pan'] },
  { key: 'director_pan', name: 'Director PAN Card', id: 15, aliases: ['director pan card', 'directors pan card', 'director pan'] },
  {
    key: 'director_live_photo',
    name: "Directors' Live Photograph",
    id: 24,
    aliases: ['directors live photograph', "directors' live photograph", 'director live photograph', 'director live photo'],
  },
  { key: 'gst', name: 'GST Registration (or, Udyam) Certificate', id: 25, aliases: ['gst registration certificate', 'gst registration', 'udyam registration certificate', 'udyam certificate'] },
  { key: 'moa', name: 'Memorandum of Association (MOA)', id: 4, aliases: ['moa', 'memorandum of association', 'moa - memorandum of association'] },
]

function normalizeDocValue(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\u2019']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function matchRequiredDoc(docType: unknown, masterDocTypeId: unknown): RequiredDoc | null {
  const masterId = Number(masterDocTypeId)
  const normalizedType = normalizeDocValue(docType)
  for (const required of REQUIRED_DOCS) {
    if (required.id !== null && masterId === required.id) return required
    if (required.aliases.some((a) => normalizeDocValue(a) === normalizedType)) return required
  }
  return null
}

interface DocRow {
  csp_id: number
  doc_type: string | null
  doc_name: string | null
  doc_status: number | null
  master_doc_type_id: number | null
  submittedAt: string | null
}

interface DocState {
  customerId: string
  pending: string[]
  reupload: string[]
}

/**
 * Group documents per customer and classify each mandatory document.
 * Status: 1 = submitted (awaiting verification), 2 = approved, 3 = rejected.
 * A duplicate keeps the best record: approved > submitted > rejected.
 */
function classifyDocuments(rows: DocRow[]): Map<string, DocState> {
  const perCustomer = new Map<string, Map<string, number>>() // customerId -> docKey -> status

  for (const row of rows) {
    const customerId = str(row.csp_id)
    if (!customerId) continue
    const required = matchRequiredDoc(row.doc_type, row.master_doc_type_id)
    if (!required) continue

    const status = Number(row.doc_status)
    if (!perCustomer.has(customerId)) perCustomer.set(customerId, new Map())
    const docs = perCustomer.get(customerId)!

    const existing = docs.get(required.key)
    if (existing === undefined) {
      docs.set(required.key, status)
      continue
    }
    // 2 (approved) always wins; 1 (submitted) beats 3 (rejected).
    if (status === 2 || (status === 1 && existing === 3)) docs.set(required.key, status)
  }

  const out = new Map<string, DocState>()
  for (const [customerId, docs] of perCustomer) {
    const pending: string[] = []
    const reupload: string[] = []
    for (const required of REQUIRED_DOCS) {
      const status = docs.get(required.key)
      if (status === undefined) {
        // No document row at all -> never uploaded.
        pending.push(required.name)
      } else if (status === 3) {
        reupload.push(required.name)
      } else if (status !== 1 && status !== 2) {
        // Any unexpected status is treated as needing attention.
        reupload.push(required.name)
      }
      // 1 (submitted) and 2 (approved) are both "not actionable" for these nudges.
    }
    out.set(customerId, { customerId, pending, reupload })
  }
  return out
}

/**
 * Candidate cohort + their documents.
 *
 * The n8n took the document-check candidate list from its "Sign agreement done" Google Sheet —
 * i.e. customers whose agreement is signed — and that is what `docCohort: 'signed'` reproduces
 * directly from the database. `'recent'` widens it to any application in the window, which is what
 * this used to do before the cohort was checked against the n8n.
 */
async function collectDocStates(opts: MysqlFlowOptions): Promise<{ states: Map<string, DocState>; phoneByCustomer: Map<string, string> }> {
  const days = Math.max(1, opts.lookbackDays ?? 30)
  const limit = Math.min(opts.limit ?? 400, 2000)
  const cohort = opts.docCohort ?? DEFAULT_DOC_COHORT

  const candidates =
    cohort === 'signed'
      ? await queryRead<{ customer_id: string; csp_number: string }>(
          // Latest agreement per customer (MAX(id), the same "newest row" convention the n8n
          // query used via ORDER BY created_at DESC, id DESC) and only where it is SIGNED (1).
          `SELECT a.customer_id, MAX(a.csp_number) AS csp_number
             FROM csp_application a
             JOIN customer_agreement_history h ON h.customer_identifier = a.csp_number
             JOIN (
               SELECT customer_identifier, MAX(id) AS max_id
                 FROM customer_agreement_history
                WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
                GROUP BY customer_identifier
             ) m ON m.max_id = h.id
            WHERE h.status = 1
              AND a.customer_id IS NOT NULL
            GROUP BY a.customer_id
            LIMIT ?`,
          [days, limit]
        )
      : await queryRead<{ customer_id: string; csp_number: string }>(
          `SELECT customer_id, csp_number
             FROM csp_application
            WHERE submittedAt >= DATE_SUB(NOW(), INTERVAL ? DAY)
              AND customer_id IS NOT NULL
            ORDER BY submittedAt DESC
            LIMIT ?`,
          [days, limit]
        )

  const phoneByCustomer = new Map<string, string>()
  const ids: string[] = []
  for (const c of candidates) {
    const id = str(c.customer_id)
    if (!id) continue
    phoneByCustomer.set(id, str(c.csp_number))
    ids.push(id)
  }
  if (!ids.length) return { states: new Map(), phoneByCustomer }

  // Bound the IN list; csp_id is an int so the values must be numeric.
  const numericIds = [...new Set(ids.filter((i) => /^\d+$/.test(i)))]
  if (!numericIds.length) return { states: new Map(), phoneByCustomer }
  const placeholders = numericIds.map(() => '?').join(',')

  const docs = await queryRead<DocRow>(
    `SELECT csp_id, doc_type, doc_name, doc_status, master_doc_type_id, submittedAt
       FROM csp_docs
      WHERE csp_id IN (${placeholders})`,
    numericIds
  )

  // Some customers may only appear in verify_csp, which also carries the phone.
  const missingPhone = numericIds.filter((id) => !phoneByCustomer.get(id))
  if (missingPhone.length) {
    const verifyArgs: unknown[] = [...missingPhone]
    const verifyRows = await queryRead<{ customer_id: number; csp_number: string }>(
      `SELECT customer_id, MAX(csp_number) AS csp_number
         FROM verify_csp
        WHERE customer_id IN (${missingPhone.map(() => '?').join(',')})
        GROUP BY customer_id`,
      verifyArgs
    )
    for (const v of verifyRows) {
      const id = str(v.customer_id)
      if (!phoneByCustomer.get(id)) phoneByCustomer.set(id, str(v.csp_number))
    }
  }

  return { states: classifyDocuments(docs), phoneByCustomer }
}

function stateToRecipients(states: Map<string, DocState>, phoneByCustomer: Map<string, string>, kind: 'pending' | 'reupload'): MysqlRecipient[] {
  const out: MysqlRecipient[] = []
  for (const [customerId, state] of states) {
    const list = kind === 'pending' ? state.pending : state.reupload
    if (!list.length) continue
    const phone = phoneByCustomer.get(customerId) || ''
    out.push({
      key: `csp:${customerId}`,
      phone,
      // {{1}} is the comma-separated document list.
      params: [clampParam(list.join(', '))],
      buttonParam: phone,
      detail: list.join(', '),
    })
  }
  return out
}

/** E — any mandatory document not uploaded. */
export async function collectDocumentsPendingUpload(opts: MysqlFlowOptions = {}): Promise<MysqlRecipient[]> {
  const { states, phoneByCustomer } = await collectDocStates(opts)
  return stateToRecipients(states, phoneByCustomer, 'pending')
}

/** F — any mandatory document rejected and needing re-upload. */
export async function collectDocumentsReuploadRequired(opts: MysqlFlowOptions = {}): Promise<MysqlRecipient[]> {
  const { states, phoneByCustomer } = await collectDocStates(opts)
  return stateToRecipients(states, phoneByCustomer, 'reupload')
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const COLLECTORS: Record<MysqlFlowKey, (opts: MysqlFlowOptions) => Promise<MysqlRecipient[]>> = {
  csp_details_pending: collectCspDetailsPending,
  mobile_otp_pending: collectMobileOtpPending,
  pan_verification_pending: collectPanVerificationPending,
  agreement_signature_pending: collectAgreementSignaturePending,
  documents_pending_upload: collectDocumentsPendingUpload,
  documents_reupload_required: collectDocumentsReuploadRequired,
}

export async function collectMysqlRecipients(flow: MysqlFlowKey, opts: MysqlFlowOptions = {}): Promise<MysqlRecipient[]> {
  const collector = COLLECTORS[flow]
  if (!collector) throw new Error(`Unknown MySQL nudge flow "${flow}"`)
  return collector(opts)
}

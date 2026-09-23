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
}

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
// B / C — mobile OTP and PAN
// ---------------------------------------------------------------------------

interface VerifyRow {
  Id: number
  csp_number: string
  customer_id: number
  requestAt: string | null
  verifyAt: string | null
  panNumber: string | null
}

async function fetchVerifyRows(opts: MysqlFlowOptions): Promise<VerifyRow[]> {
  const hours = Math.max(1, opts.lookbackHours ?? 2)
  const limit = Math.min(opts.limit ?? 500, 1000)
  return queryRead<VerifyRow>(
    `SELECT Id, csp_number, customer_id, requestAt, verifyAt, panNumber
       FROM verify_csp
      WHERE requestAt >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        AND requestAt < NOW()
      ORDER BY requestAt DESC
      LIMIT ?`,
    [hours, limit]
  )
}

/** B — mobile verification still pending: verifyAt is empty. */
export async function collectMobileOtpPending(opts: MysqlFlowOptions = {}): Promise<MysqlRecipient[]> {
  const rows = await fetchVerifyRows(opts)
  return rows
    .filter((r) => !str(r.verifyAt))
    .map((r) => {
      const phone = str(r.csp_number)
      return {
        key: `csp:${r.customer_id || phone}`,
        phone,
        params: [],
        buttonParam: phone,
        detail: 'verifyAt empty',
      }
    })
}

/**
 * C — PAN pending. Mirrors the n8n branch order: only reached once the mobile IS verified,
 * so a lead missing both is nudged for the mobile first and for PAN on a later pass.
 */
export async function collectPanVerificationPending(opts: MysqlFlowOptions = {}): Promise<MysqlRecipient[]> {
  const rows = await fetchVerifyRows(opts)
  return rows
    .filter((r) => str(r.verifyAt) && !str(r.panNumber))
    .map((r) => {
      const phone = str(r.csp_number)
      return {
        key: `csp:${r.customer_id || phone}`,
        phone,
        params: [],
        buttonParam: phone,
        detail: 'panNumber empty',
      }
    })
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
 * Candidate cohort + their documents. The n8n flows took the candidate list from a Google
 * Sheet; with direct DB access we derive it from recent CSP applications instead, so the
 * check covers the whole onboarding cohort rather than a hand-maintained sheet.
 */
async function collectDocStates(opts: MysqlFlowOptions): Promise<{ states: Map<string, DocState>; phoneByCustomer: Map<string, string> }> {
  const days = Math.max(1, opts.lookbackDays ?? 30)
  const limit = Math.min(opts.limit ?? 400, 2000)

  const candidates = await queryRead<{ customer_id: string; csp_number: string }>(
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

/**
 * Zoho CRM v8 client (DC: .in)
 * - Auth: refresh-token flow (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN)
 *   with a static ZOHO_ACCESS_TOKEN fallback.
 * - Search: /crm/v8/Leads/search with criteria, fields, pagination.
 */

const ZOHO_ACCOUNTS_BASE = process.env.ZOHO_ACCOUNTS_BASE || 'https://accounts.zoho.in'
const ZOHO_API_BASE = process.env.ZOHO_API_BASE || 'https://www.zohoapis.in/crm/v8'

interface TokenCache {
  token: string
  expiresAt: number
}
let tokenCache: TokenCache | null = null

async function fetchAccessToken(): Promise<string> {
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN
  const clientId = process.env.ZOHO_CLIENT_ID
  const clientSecret = process.env.ZOHO_CLIENT_SECRET
  const staticToken = process.env.ZOHO_ACCESS_TOKEN

  if (refreshToken && clientId && clientSecret) {
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    })
    const res = await fetch(`${ZOHO_ACCOUNTS_BASE}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) {
      throw new Error(`Zoho token refresh failed: HTTP ${res.status}`)
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: number; error?: string }
    if (!data.access_token) {
      throw new Error(`Zoho token refresh failed: ${data.error || 'no access_token in response'}`)
    }
    tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000, // 1 min safety margin
    }
    return tokenCache.token
  }

  if (staticToken) return staticToken

  throw new Error(
    'Zoho credentials not configured. Set ZOHO_REFRESH_TOKEN + ZOHO_CLIENT_ID + ZOHO_CLIENT_SECRET (recommended) or ZOHO_ACCESS_TOKEN in .env'
  )
}

export async function getAccessToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token
  return fetchAccessToken()
}

export function clearTokenCache() {
  tokenCache = null
}

export interface ZohoLead {
  id: string
  Full_Name?: string
  First_Name?: string
  Last_Name?: string
  Email?: string
  Phone?: string
  Mobile?: string
  Company?: string
  Org_Name?: string
  Business_vertical?: string
  Lead_Status?: string
  Created_Time?: string
  Eko_Code?: string
  KYC_Document_Upload_Count?: number | string
  Owner?: { name?: string; id?: string; email?: string } | string
  City?: string
  States?: string
  Country?: string
  Lead_Source?: string
  Last_Activity_Time?: string
  Preferred_Channel?: string
  User_Onboarding_Status?: string
  Qualification_Status?: string
  Qualification_Score?: number | string
  Total_Calls?: number | string
  [key: string]: unknown
}

export const LEAD_FIELDS = [
  'id',
  'Full_Name',
  'First_Name',
  'Last_Name',
  'Phone',
  'Mobile',
  'Email',
  'Company',
  'Org_Name',
  'Business_vertical',
  'Lead_Status',
  'Created_Time',
  'Eko_Code',
  'KYC_Document_Upload_Count',
  'Owner',
  'City',
  'States',
  'Country',
  'Lead_Source',
  'Last_Activity_Time',
  'Preferred_Channel',
  'User_Onboarding_Status',
  'Qualification_Status',
  'Qualification_Score',
  'Total_Calls',
].join(',')

export interface SearchResult {
  leads: ZohoLead[]
  totalFetched: number
}

async function fetchPage(query: URLSearchParams): Promise<Response> {
  const doFetch = async () => {
    const token = await getAccessToken()
    return fetch(`${ZOHO_API_BASE}/Leads/search?${query.toString()}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    })
  }
  let res = await doFetch()
  // Access token may have just expired -> refresh once and retry
  if (res.status === 401 && process.env.ZOHO_REFRESH_TOKEN) {
    clearTokenCache()
    res = await doFetch()
  }
  return res
}

/**
 * Search leads with a criteria string, paginating through all pages.
 * Criteria example (documents pending):
 * ((Business_vertical:equals:EPS)and(Lead_Status:not_equal:Closed Won)and(...)...)
 */
export async function searchAllLeads(criteria: string): Promise<SearchResult> {
  const allLeads: ZohoLead[] = []
  let page = 1
  const perPage = 200

  for (let guard = 0; guard < 100; guard++) {
    const params = new URLSearchParams({
      criteria,
      fields: LEAD_FIELDS,
      per_page: String(perPage),
      page: String(page),
    })

    const res = await fetchPage(params)

    // 204 = no records
    if (res.status === 204) break

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Zoho search failed: HTTP ${res.status} ${text.slice(0, 300)}`)
    }

    const data = (await res.json()) as {
      data?: ZohoLead[]
      info?: { more_records?: boolean; next_page_token?: string }
    }

    const leads = data.data ?? []
    allLeads.push(...leads)

    if (!data.info?.more_records) break
    // v8 may use page numbers or page tokens; try token first, fall back to page increment
    if (data.info.next_page_token) {
      const tokenParams = new URLSearchParams({
        criteria,
        fields: LEAD_FIELDS,
        per_page: String(perPage),
        page_token: data.info.next_page_token,
      })
      const res2 = await fetchPage(tokenParams)
      if (res2.status === 204) break
      if (!res2.ok) {
        const text = await res2.text().catch(() => '')
        throw new Error(`Zoho search (token page) failed: HTTP ${res2.status} ${text.slice(0, 300)}`)
      }
      const data2 = (await res2.json()) as {
        data?: ZohoLead[]
        info?: { more_records?: boolean; next_page_token?: string }
      }
      allLeads.push(...(data2.data ?? []))
      if (!data2.info?.more_records) break
    } else {
      page++
    }
  }

  return { leads: allLeads, totalFetched: allLeads.length }
}

function parseDate(value: unknown): Date | null {
  if (!value || typeof value !== 'string') return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function parseCount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/** Map a raw Zoho lead into our Lead table columns (upsert shape). */
export function mapZohoLead(z: ZohoLead) {
  const ownerName =
    typeof z.Owner === 'object' && z.Owner !== null ? (z.Owner.name ?? null) : typeof z.Owner === 'string' ? z.Owner : null

  return {
    zohoId: z.id,
    fullName: z.Full_Name?.trim() || [z.First_Name, z.Last_Name].filter(Boolean).join(' ').trim() || null,
    firstName: z.First_Name?.trim() || null,
    lastName: z.Last_Name?.trim() || null,
    email: z.Email?.trim().toLowerCase() || null,
    phone: z.Phone?.trim() || null,
    mobile: z.Mobile?.trim() || null,
    company: (z.Company || z.Org_Name)?.trim() || null,
    businessVertical: z.Business_vertical?.trim() || null,
    leadStatus: z.Lead_Status?.trim() || null,
    createdTime: parseDate(z.Created_Time),
    kycDocumentUploadCount: parseCount(z.KYC_Document_Upload_Count),
    ekoCode: z.Eko_Code?.trim() || null,
    ownerName,
    city: z.City?.trim() || null,
    state: z.States?.trim() || null,
    country: z.Country?.trim() || null,
    leadSource: z.Lead_Source?.trim() || null,
    lastActivityTime: parseDate(z.Last_Activity_Time),
    lastSyncedAt: new Date(),
  }
}

export type MappedLead = ReturnType<typeof mapZohoLead>

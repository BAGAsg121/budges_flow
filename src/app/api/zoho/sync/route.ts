/**
 * POST /api/zoho/sync
 * Body (optional): { "criteria": "((...))" } — defaults to the documents-pending criteria.
 * Fetches all matching leads from Zoho CRM (paginated) and upserts them locally.
 */
import { NextRequest, NextResponse } from 'next/server'
import { syncLeadsFromCriteria } from '@/lib/nudge-engine'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const DEFAULT_CRITERIA =
  '((Business_vertical:equals:EPS)and(Lead_Status:not_equal:Closed Won)and(Lead_Status:not_equal:Closed Lost)and(Lead_Status:not_equal:Unqualified)and(Created_Time:greater_than:2026-07-01T01:00:00+05:30)and(KYC_Document_Upload_Count:less_equal:11))'

export async function POST(req: NextRequest) {
  let criteria = DEFAULT_CRITERIA
  try {
    const body = (await req.json()) as { criteria?: string }
    if (body?.criteria && body.criteria.trim()) criteria = body.criteria.trim()
  } catch {
    // no body -> use default criteria
  }

  try {
    const count = await syncLeadsFromCriteria(criteria)
    return NextResponse.json({ ok: true, synced: count, criteria })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

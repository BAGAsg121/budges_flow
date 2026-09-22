/**
 * GET  /api/nudges — list all nudges (seeds default nudges on first call)
 * POST /api/nudges — create a new nudge. This is how new flows are added:
 *                   one config row = one nudge flow (channel + criteria + filters + template).
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

const DEFAULT_CRITERIA =
  '((Business_vertical:equals:EPS)and(Lead_Status:not_equal:Closed Won)and(Lead_Status:not_equal:Closed Lost)and(Lead_Status:not_equal:Unqualified)and(Created_Time:greater_than:2026-07-01T01:00:00+05:30)and(KYC_Document_Upload_Count:less_equal:11))'

const DEFAULT_FILTERS = JSON.stringify(
  {
    requireEmail: true,
    excludeStatuses: ['Closed Won', 'Closed Lost', 'Unqualified'],
    maxKycCount: 11,
  },
  null,
  2
)

const DEFAULT_DOCS_PENDING = {
  key: 'documents_pending',
  name: 'Documents Pending Reminder',
  channel: 'email',
  description:
    'Nudge for EPS leads with pending KYC documents (upload count <= 11). Excludes Closed Won / Closed Lost / Unqualified leads. Syncs eligible leads from Zoho on every run.',
  zohoCriteria: DEFAULT_CRITERIA,
  filters: DEFAULT_FILTERS,
  subjectTemplate: 'Action pending: complete your KYC documents',
  bodyTemplate: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
  <p>Hi {{first_name}},</p>
  <p>We noticed your KYC document upload is still pending for <b>{{company}}</b> — your account currently shows <b>{{kyc_document_upload_count}}</b> document(s) uploaded.</p>
  <p>To keep your onboarding moving, please log in and complete your document upload. It only takes a few minutes:</p>
  <p style="text-align:center;margin:28px 0;">
    <a href="https://app.eko.co/in/onboard" style="background:#0d9488;color:#ffffff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">Upload Documents</a>
  </p>
  <p>If you have already completed this, please ignore this email.</p>
  <p>Thanks,<br/>Eko Onboarding Team</p>
</div>`,
  maxEmailsPerLead: 3,
  followUpDays: 2,
}

const DEFAULT_DOCS_PENDING_WA = {
  key: 'documents_pending_wa',
  name: 'Documents Pending Reminder (WhatsApp)',
  channel: 'whatsapp',
  description:
    'WhatsApp twin of the documents-pending nudge, delivered via Meta Cloud API. Disabled until you finish Meta setup: register the number, approve the template, set WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID in .env, and point the Meta webhook to /api/track/whatsapp.',
  zohoCriteria: DEFAULT_CRITERIA,
  filters: JSON.stringify(
    {
      requirePhone: true,
      excludeStatuses: ['Closed Won', 'Closed Lost', 'Unqualified'],
      maxKycCount: 11,
    },
    null,
    2
  ),
  // reference copy of the Meta template body (Meta templates use {{1}}, {{2}} positional params)
  bodyTemplate: 'Hi {{1}}, your KYC document upload for {{2}} is still pending ({{3}} document(s) uploaded). Please complete it to keep your onboarding moving. - Eko Onboarding Team',
  whatsappTemplateName: 'documents_pending_reminder',
  whatsappLanguage: 'en',
  whatsappParams: JSON.stringify(['first_name', 'company', 'kyc_document_upload_count']),
  maxEmailsPerLead: 3,
  followUpDays: 2,
}

async function ensureDefaultNudges() {
  const count = await db.nudge.count()
  if (count === 0) {
    await db.nudge.createMany({ data: [DEFAULT_DOCS_PENDING, DEFAULT_DOCS_PENDING_WA] })
  }
}

export async function GET() {
  await ensureDefaultNudges()
  const nudges = await db.nudge.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      _count: { select: { messageLogs: { where: { sentOk: true } } } },
    },
  })
  return NextResponse.json({
    ok: true,
    nudges: nudges.map((n) => ({
      id: n.id,
      key: n.key,
      name: n.name,
      description: n.description,
      enabled: n.enabled,
      channel: n.channel,
      zohoCriteria: n.zohoCriteria,
      filters: n.filters,
      subjectTemplate: n.subjectTemplate,
      bodyTemplate: n.bodyTemplate,
      whatsappTemplateName: n.whatsappTemplateName,
      whatsappLanguage: n.whatsappLanguage,
      whatsappParams: n.whatsappParams,
      maxEmailsPerLead: n.maxEmailsPerLead,
      followUpDays: n.followUpDays,
      lastRunAt: n.lastRunAt,
      messagesSent: n._count.messageLogs,
    })),
  })
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      key?: string
      name?: string
      description?: string
      enabled?: boolean
      channel?: string
      zohoCriteria?: string
      filters?: string
      subjectTemplate?: string
      bodyTemplate?: string
      whatsappTemplateName?: string
      whatsappLanguage?: string
      whatsappParams?: string
      maxEmailsPerLead?: number
      followUpDays?: number
    }

    if (!body.key?.trim()) return NextResponse.json({ ok: false, error: 'key is required (slug, e.g. payment_reminder)' }, { status: 400 })
    if (!body.name?.trim()) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 })

    const channel = body.channel === 'whatsapp' ? 'whatsapp' : 'email'

    if (channel === 'email') {
      if (!body.subjectTemplate?.trim()) return NextResponse.json({ ok: false, error: 'subjectTemplate is required for email nudges' }, { status: 400 })
      if (!body.bodyTemplate?.trim()) return NextResponse.json({ ok: false, error: 'bodyTemplate is required for email nudges' }, { status: 400 })
    } else {
      if (!body.whatsappTemplateName?.trim()) return NextResponse.json({ ok: false, error: 'whatsappTemplateName is required (Meta-approved template name)' }, { status: 400 })
      if (body.whatsappParams?.trim()) {
        try {
          const parsed = JSON.parse(body.whatsappParams)
          if (!Array.isArray(parsed)) return NextResponse.json({ ok: false, error: 'whatsappParams must be a JSON array, e.g. ["first_name","company"]' }, { status: 400 })
        } catch {
          return NextResponse.json({ ok: false, error: 'whatsappParams must be valid JSON' }, { status: 400 })
        }
      }
    }

    if (body.filters?.trim()) {
      try {
        JSON.parse(body.filters)
      } catch {
        return NextResponse.json({ ok: false, error: 'filters must be valid JSON' }, { status: 400 })
      }
    }

    const key = body.key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    const exists = await db.nudge.findUnique({ where: { key } })
    if (exists) return NextResponse.json({ ok: false, error: `nudge key "${key}" already exists` }, { status: 409 })

    const nudge = await db.nudge.create({
      data: {
        key,
        name: body.name.trim(),
        description: body.description?.trim() || null,
        enabled: body.enabled ?? true,
        channel,
        zohoCriteria: body.zohoCriteria?.trim() || null,
        filters: body.filters?.trim() || '{}',
        subjectTemplate: channel === 'email' ? body.subjectTemplate : null,
        bodyTemplate: body.bodyTemplate?.trim() || null,
        whatsappTemplateName: channel === 'whatsapp' ? body.whatsappTemplateName?.trim() : null,
        whatsappLanguage: channel === 'whatsapp' ? body.whatsappLanguage?.trim() || 'en' : null,
        whatsappParams: channel === 'whatsapp' ? body.whatsappParams?.trim() || '[]' : null,
        maxEmailsPerLead: Number(body.maxEmailsPerLead) > 0 ? Number(body.maxEmailsPerLead) : 1,
        followUpDays: Number(body.followUpDays) > 0 ? Number(body.followUpDays) : 0,
      },
    })
    return NextResponse.json({ ok: true, nudge })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

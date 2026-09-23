/**
 * GET  /api/nudges — list all nudges. Any built-in nudge from nudge-defaults.ts that
 *                    does not exist yet is created first (create-if-missing only).
 * POST /api/nudges — create a new nudge. One config row = one nudge flow.
 *
 * A nudge with `zohoCriteria: null` is a MANUAL / sheet-driven nudge: it is never run
 * against synced leads, it is triggered by pasting a Google Sheet URL in the UI.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { DEFAULT_NUDGES } from '@/lib/nudge-defaults'

export const dynamic = 'force-dynamic'

/**
 * Create missing built-in nudges.
 * Deliberately create-if-missing, never upsert: an admin editing a template in the UI
 * must not have it silently reverted on the next page load.
 */
async function ensureDefaultNudges(): Promise<number> {
  let created = 0
  for (const seed of DEFAULT_NUDGES) {
    const exists = await db.nudge.findUnique({ where: { key: seed.key }, select: { id: true } })
    if (exists) continue
    await db.nudge.create({ data: seed })
    created++
  }
  return created
}

export async function GET() {
  const seeded = await ensureDefaultNudges()
  const nudges = await db.nudge.findMany({
    orderBy: { createdAt: 'asc' },
    include: {
      _count: { select: { messageLogs: { where: { sentOk: true } } } },
    },
  })
  return NextResponse.json({
    ok: true,
    seeded,
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

/**
 * GET    /api/nudges/{id} — single nudge
 * PATCH  /api/nudges/{id} — update config
 * DELETE /api/nudges/{id} — remove nudge (and its message logs)
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const nudge = await db.nudge.findUnique({ where: { id } })
  if (!nudge) return NextResponse.json({ ok: false, error: 'Nudge not found' }, { status: 404 })
  return NextResponse.json({ ok: true, nudge })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const body = (await req.json()) as Partial<{
      name: string
      description: string
      enabled: boolean
      channel: string
      zohoCriteria: string
      filters: string
      subjectTemplate: string
      bodyTemplate: string
      whatsappTemplateName: string
      whatsappLanguage: string
      whatsappParams: string
      maxEmailsPerLead: number
      followUpDays: number
    }>

    if (body.filters !== undefined && body.filters.trim()) {
      try {
        JSON.parse(body.filters)
      } catch {
        return NextResponse.json({ ok: false, error: 'filters must be valid JSON' }, { status: 400 })
      }
    }
    if (body.whatsappParams !== undefined && body.whatsappParams.trim()) {
      try {
        const parsed = JSON.parse(body.whatsappParams)
        if (!Array.isArray(parsed)) {
          return NextResponse.json({ ok: false, error: 'whatsappParams must be a JSON array' }, { status: 400 })
        }
      } catch {
        return NextResponse.json({ ok: false, error: 'whatsappParams must be valid JSON' }, { status: 400 })
      }
    }

    const data: Record<string, unknown> = {}
    if (body.name !== undefined) data.name = body.name.trim()
    if (body.description !== undefined) data.description = body.description?.trim() || null
    if (body.enabled !== undefined) data.enabled = body.enabled
    if (body.channel !== undefined) data.channel = body.channel === 'whatsapp' ? 'whatsapp' : 'email'
    if (body.zohoCriteria !== undefined) data.zohoCriteria = body.zohoCriteria?.trim() || null
    if (body.filters !== undefined) data.filters = body.filters?.trim() || '{}'
    if (body.subjectTemplate !== undefined) data.subjectTemplate = body.subjectTemplate?.trim() || null
    if (body.bodyTemplate !== undefined) data.bodyTemplate = body.bodyTemplate?.trim() || null
    if (body.whatsappTemplateName !== undefined) data.whatsappTemplateName = body.whatsappTemplateName?.trim() || null
    if (body.whatsappLanguage !== undefined) data.whatsappLanguage = body.whatsappLanguage?.trim() || 'en'
    if (body.whatsappParams !== undefined) data.whatsappParams = body.whatsappParams?.trim() || '[]'
    if (body.maxEmailsPerLead !== undefined) data.maxEmailsPerLead = Math.max(1, Number(body.maxEmailsPerLead) || 1)
    if (body.followUpDays !== undefined) data.followUpDays = Math.max(0, Number(body.followUpDays) || 0)

    const nudge = await db.nudge.update({ where: { id }, data })
    return NextResponse.json({ ok: true, nudge })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    await db.nudge.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

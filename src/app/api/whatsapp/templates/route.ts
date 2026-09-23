/**
 * WhatsApp message templates.
 *
 *   GET    /api/whatsapp/templates            list every template on the WABA with its status
 *   POST   /api/whatsapp/templates            create one (comes back PENDING, then Meta reviews it)
 *   PATCH  /api/whatsapp/templates            edit one. Body adds `id`, and `mode: "replace"`
 *                                             to delete + re-create when Meta has locked it.
 *   DELETE /api/whatsapp/templates?name=&language=   remove one (Meta-side)
 *
 * Behind the app password (src/middleware.ts).
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  listTemplates,
  createTemplate,
  editTemplate,
  replaceTemplate,
  deleteTemplate,
  isTemplateApiConfigured,
  validateTemplateInput,
  type CreateTemplateInput,
  type TemplateCategory,
} from '@/lib/whatsapp-templates'
import { whatsAppConfigStatus, describeTokenProblem } from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'
// Editing a locked template falls back to delete + re-create, and Meta can take ~90s to
// release the name, so allow a long request for that one explicit action.
export const maxDuration = 300

export async function GET() {
  const result = await listTemplates()
  const status = whatsAppConfigStatus()
  return NextResponse.json(
    {
      ok: result.ok,
      configured: result.configured,
      count: result.templates.length,
      templates: result.templates,
      error: result.error ?? null,
      // Lets the UI explain a bad token instead of showing Meta's raw message.
      configStatus: status,
      configHint: describeTokenProblem(status),
    },
    { status: result.ok ? 200 : result.configured ? 502 : 400 }
  )
}

export async function POST(req: NextRequest) {
  if (!isTemplateApiConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'Set WHATSAPP_TOKEN and WHATSAPP_WABA_ID to create templates.' },
      { status: 400 }
    )
  }

  let body: Partial<CreateTemplateInput> = {}
  try {
    body = (await req.json()) as Partial<CreateTemplateInput>
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const input: CreateTemplateInput = {
    name: (body.name || '').trim(),
    language: (body.language || '').trim(),
    category: (body.category || 'UTILITY') as TemplateCategory,
    headerText: body.headerText?.trim() || null,
    bodyText: (body.bodyText || '').trim(),
    footerText: body.footerText?.trim() || null,
    buttonText: body.buttonText?.trim() || null,
    buttonUrl: body.buttonUrl?.trim() || null,
  }

  // Validate here as well so the caller gets the field-level errors without a round trip.
  const { errors, warnings } = validateTemplateInput(input)
  if (errors.length) {
    return NextResponse.json({ ok: false, error: errors.join('; '), errors, warnings }, { status: 400 })
  }

  const result = await createTemplate(input)
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error, warnings }, { status: 502 })
  }

  return NextResponse.json({
    ok: true,
    id: result.id,
    status: result.status ?? 'PENDING',
    warnings,
    message:
      'Submitted to Meta. It will show as PENDING here until it is approved — refresh this list, then attach it to a nudge.',
  })
}

export async function PATCH(req: NextRequest) {
  if (!isTemplateApiConfigured()) {
    return NextResponse.json({ ok: false, error: 'Set WHATSAPP_TOKEN and WHATSAPP_WABA_ID.' }, { status: 400 })
  }

  let body: Partial<CreateTemplateInput> & { id?: string; mode?: 'edit' | 'replace' } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.id?.trim() && body.mode !== 'replace') {
    return NextResponse.json({ ok: false, error: 'id is required to edit a template' }, { status: 400 })
  }

  const input: CreateTemplateInput = {
    name: (body.name || '').trim(),
    language: (body.language || '').trim(),
    category: (body.category || 'UTILITY') as TemplateCategory,
    headerText: body.headerText?.trim() || null,
    bodyText: (body.bodyText || '').trim(),
    footerText: body.footerText?.trim() || null,
    buttonText: body.buttonText?.trim() || null,
    buttonUrl: body.buttonUrl?.trim() || null,
  }

  const { errors, warnings } = validateTemplateInput(input)
  if (errors.length) {
    return NextResponse.json({ ok: false, error: errors.join('; '), errors, warnings }, { status: 400 })
  }

  // Replace is the explicit "delete and re-create" path for a locked template.
  const result =
    body.mode === 'replace'
      ? await replaceTemplate(input.name, input.language, input)
      : await editTemplate(body.id as string, input)

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, needsReplace: result.needsReplace ?? false, warnings },
      { status: result.needsReplace ? 409 : 502 }
    )
  }

  return NextResponse.json({
    ok: true,
    id: result.id,
    status: result.status ?? 'PENDING',
    warnings,
    message:
      body.mode === 'replace'
        ? 'Template replaced. It is back in review as PENDING.'
        : 'Template updated. Meta re-reviews it, so it shows as PENDING again until approved.',
  })
}

export async function DELETE(req: NextRequest) {
  const name = (req.nextUrl.searchParams.get('name') || '').trim()
  const language = (req.nextUrl.searchParams.get('language') || '').trim() || null
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 })

  const result = await deleteTemplate(name, language)
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 502 })
  return NextResponse.json({ ok: true, deleted: name, language })
}

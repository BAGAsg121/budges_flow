/**
 * Turn a WABA template list into a `${name}|${language}` -> template map, so a nudge can be
 * checked against the exact translation it will send.
 *
 * Meta matches template name AND language exactly ("en" and "en_US" are different), so keying on
 * the name alone would report a template as available when the nudge's language does not exist.
 */
export function collateTemplateStatus(templates) {
  const map = new Map()
  for (const t of templates || []) {
    map.set(`${t.name}|${t.language}`, {
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
      buttonText: (t.components || []).find((c) => c.type === 'BUTTONS')?.buttons?.[0]?.text ?? null,
      rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null,
    })
  }
  return map
}

/** Names that exist in at least one language, for a "wrong language" hint. */
export function languagesFor(templates, name) {
  return (templates || []).filter((t) => t.name === name).map((t) => t.language)
}

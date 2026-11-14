import type { ToolTraceEntry } from '../../shared/agentContracts.ts'

type ClaimLink = {
  sourceType?: string
  sourceUrl?: string | null
  entityType?: string | null
  entityId?: string | null
}

type OptionRecord = Record<string, unknown>

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * The single travelOption a claim is about, or undefined when the link is
 * missing or ambiguous. Array position is never a link: an explicit entityId
 * wins; otherwise a web claim's sourceUrl must match exactly one option.
 */
export function claimTargetOption(
  claim: ClaimLink,
  options: unknown[],
): OptionRecord | undefined {
  const recs = options.filter(
    (o): o is OptionRecord => !!o && typeof o === 'object',
  )
  const entityId = str(claim.entityId)
  if (entityId) {
    if (claim.entityType && claim.entityType !== 'travelOption') return undefined
    const hits = recs.filter((o) => {
      const ext = str(o.externalId)
      const id = str(o.id)
      return (
        (ext && (entityId === ext || entityId.endsWith(`-${ext}`))) ||
        (id && entityId === id)
      )
    })
    return hits.length === 1 ? hits[0] : undefined
  }
  const url = str(claim.sourceUrl)
  if (!url || claim.sourceType === 'context') return undefined
  const hits = recs.filter((o) => str(o.sourceUrl) === url)
  return hits.length === 1 ? hits[0] : undefined
}

function digitsOf(s: string): string {
  return s.replace(/\D/g, '')
}

/**
 * Same number modulo formatting and a leading country/trunk prefix
 * (+52 437 964 0079 ≈ 4379640079 ≈ 52 1 437 964 0079).
 */
export function phonesEquivalent(a: string, b: string): boolean {
  const x = digitsOf(a).replace(/^00/, '')
  const y = digitsOf(b).replace(/^00/, '')
  if (x.length < 7 || y.length < 7) return false
  if (x === y) return true
  const [long, short] = x.length >= y.length ? [x, y] : [y, x]
  return short.length >= 8 && long.length - short.length <= 3 && long.endsWith(short)
}

const PHONE_RUN_RE = /\+?\d[\d\s().-]{5,}\d/g

export function phoneNumbersIn(text: string): string[] {
  return (text.match(PHONE_RUN_RE) ?? []).filter((m) => digitsOf(m).length >= 7)
}

export function evidenceTextsForUrl(toolTrace: ToolTraceEntry[], url: string): string[] {
  const out: string[] = []
  for (const entry of toolTrace) {
    for (const src of entry.sources ?? []) {
      if (src.url?.trim() !== url) continue
      out.push(`${src.title ?? ''}\n${src.snippet ?? ''}`)
    }
  }
  return out
}

/**
 * A travelOption phone survives only when the evidence fetched for that
 * option's own sourceUrl contains the same number. Mutates the package.
 */
export function dropUnsupportedPhones(
  pkg: unknown,
  toolTrace: ToolTraceEntry[],
): string[] {
  if (!pkg || typeof pkg !== 'object') return []
  const options = (pkg as { travelOptions?: unknown }).travelOptions
  if (!Array.isArray(options)) return []
  const warnings: string[] = []
  for (const o of options) {
    if (!o || typeof o !== 'object') continue
    const rec = o as OptionRecord
    if (rec.phone == null) continue
    const phone = str(rec.phone)
    const url = str(rec.sourceUrl)
    const supported =
      !!phone &&
      !!url &&
      evidenceTextsForUrl(toolTrace, url).some((text) =>
        phoneNumbersIn(text).some((found) => phonesEquivalent(found, phone)),
      )
    if (supported) continue
    delete rec.phone
    if (phone) {
      warnings.push(
        `server: teléfono sin evidencia en la fuente de ${str(rec.title) || str(rec.externalId) || 'la opción'} — omitido (${str(rec.externalId) || 'sin id'}).`,
      )
    }
  }
  return warnings
}

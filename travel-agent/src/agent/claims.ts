import { z } from 'zod'
import type { ToolTraceEntry } from '../../shared/agentContracts.ts'

/**
 * What the LLM may emit for claims[] (no quotedFact — server-owned).
 * - web: sourceUrl + evidenceIndex → evidence from toolTrace
 * - context: entityType + entityId + field → evidence from TripContextSnapshot
 */
export const agentClaimLlmSchema = z
  .object({
    kind: z.enum([
      'price',
      'currency',
      'schedule',
      'availability',
      'service_status',
      'transport_mode',
      'other_factual',
    ]),
    statement: z.string().min(1),
    sourceType: z.enum(['web', 'context']).default('web'),
    sourceUrl: z.string().url().nullable().optional(),
    evidenceIndex: z.number().int().nonnegative().nullable().optional(),
    entityType: z
      .enum([
        'trip',
        'travelOption',
        'booking',
        'itineraryItem',
        'checklistItem',
        'note',
      ])
      .nullable()
      .optional(),
    entityId: z.string().min(1).nullable().optional(),
    field: z.string().min(1).nullable().optional(),
    verificationStatus: z.enum(['verified', 'estimated', 'unverified']),
    confidence: z.enum(['high', 'medium', 'low']),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.sourceType === 'context') {
      if (!c.entityType || !c.field) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'context claims require entityType and field',
        })
      }
    } else if (!c.sourceUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'web claims require sourceUrl',
      })
    }
  })

export type AgentClaimLlm = z.infer<typeof agentClaimLlmSchema>

/** Grounded claim after server attaches literal evidence. */
export type AgentClaimDraft = AgentClaimLlm & {
  sourceTitle: string
  quotedFact: string
  evidenceIndex: number
}

export type ClaimViolation = {
  index: number
  claim?: AgentClaimDraft | AgentClaimLlm
  code: string
  message: string
}

export type ClaimValidationResult = {
  valid: AgentClaimDraft[]
  invalid: ClaimViolation[]
}

type TraceSource = {
  url: string
  title?: string
  snippet?: string
}

const TRANSPORT_MODES = [
  'taxi',
  'uber',
  'lyft',
  'autobus',
  'autobús',
  'bus',
  'vuelo',
  'vuelos',
  'flight',
  'flights',
  'transfer',
  'traslado',
  'tren',
  'train',
  'ferry',
  'metro',
  'shuttle',
  'vivabus',
] as const

/** Modes that always count as operational assertions in narrative/diff/package. */
const STRICT_BODY_MODES = ['taxi', 'uber', 'lyft', 'vivabus', 'shuttle'] as const

/** Modes only flagged in body text when a price/currency is also present nearby. */
const CONTEXT_BODY_MODES = [
  'autobus',
  'autobús',
  'bus',
  'vuelo',
  'vuelos',
  'flight',
  'flights',
  'transfer',
  'traslado',
  'tren',
  'train',
  'ferry',
  'metro',
] as const

const STATUS_WORDS = [
  'suspendido',
  'suspendida',
  'suspendidos',
  'suspendidas',
  'suspensión',
  'suspension',
  'cancelado',
  'cancelada',
  'cancelados',
  'canceladas',
  'confirmado',
  'confirmada',
  'confirmados',
  'confirmadas',
] as const

const CURRENCY_CODES = [
  'MXN',
  'USD',
  'EUR',
  'GBP',
  'INR',
  'JPY',
  'CAD',
  'AUD',
  'BRL',
  'ARS',
  'CLP',
  'COP',
] as const

const MAX_QUOTED_FACT = 800

/** Normalize for substring checks (case/space/unicode). */
export function normalizeEvidenceText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Flatten toolTrace sources that match url (order preserved). */
export function listSourcesForUrl(
  toolTrace: ToolTraceEntry[],
  url: string,
): TraceSource[] {
  const want = url.trim()
  const out: TraceSource[] = []
  for (const entry of toolTrace) {
    for (const src of entry.sources ?? []) {
      const u = src.url?.trim()
      if (!u || u !== want) continue
      out.push({
        url: u,
        title: src.title,
        snippet: src.snippet,
      })
    }
  }
  return out
}

/**
 * Derive server-owned quotedFact + sourceTitle from a toolTrace source.
 * Never trusts LLM-supplied quote text.
 */
export function deriveEvidenceFromSource(src: TraceSource): {
  sourceTitle: string
  quotedFact: string
} {
  const title = (src.title ?? '').trim()
  const snippet = (src.snippet ?? '').trim()
  let quotedFact: string
  if (snippet && title) {
    const nSnip = normalizeEvidenceText(snippet)
    const nTitle = normalizeEvidenceText(title)
    quotedFact =
      nTitle && !nSnip.includes(nTitle.slice(0, Math.min(40, nTitle.length)))
        ? `${title}\n${snippet}`
        : snippet
  } else {
    quotedFact = snippet || title
  }
  if (quotedFact.length > MAX_QUOTED_FACT) {
    quotedFact = quotedFact.slice(0, MAX_QUOTED_FACT)
  }
  return { sourceTitle: title, quotedFact }
}

/**
 * Resolve literal evidence for a claim reference.
 */
export function resolveClaimEvidence(
  sourceUrl: string,
  evidenceIndex: number | null | undefined,
  toolTrace: ToolTraceEntry[],
):
  | { ok: true; evidenceIndex: number; sourceTitle: string; quotedFact: string }
  | { ok: false; code: string; message: string } {
  const hits = listSourcesForUrl(toolTrace, sourceUrl)
  if (hits.length === 0) {
    return {
      ok: false,
      code: 'source_url_missing',
      message: `sourceUrl not found in toolTrace: ${sourceUrl}`,
    }
  }
  const idx =
    evidenceIndex === null || evidenceIndex === undefined ? 0 : evidenceIndex
  if (!Number.isInteger(idx) || idx < 0 || idx >= hits.length) {
    return {
      ok: false,
      code: 'evidence_index_invalid',
      message: `evidenceIndex=${idx} out of range for ${hits.length} source(s) at URL`,
    }
  }
  const derived = deriveEvidenceFromSource(hits[idx]!)
  if (!derived.quotedFact.trim()) {
    return {
      ok: false,
      code: 'evidence_empty',
      message: 'toolTrace source has empty title/snippet',
    }
  }
  return {
    ok: true,
    evidenceIndex: idx,
    sourceTitle: derived.sourceTitle,
    quotedFact: derived.quotedFact,
  }
}

/** Digits only from a number-like token (1,800 / 1.800 / 1800). Not mid-word (rome2rio). */
export function extractNumbers(text: string): string[] {
  const out: string[] = []
  const re =
    /(?<![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|(?<![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])\d+(?:[.,]\d+)?(?![A-Za-zÁÉÍÓÚÜÑáéíóúüñ])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const raw = m[0]
    let digits = raw.replace(/[^\d]/g, '')
    const dec = raw.match(/[.,](\d{1,2})$/)
    if (dec && !/^\d{1,3}([.,]\d{3})+$/.test(raw.replace(dec[0], ''))) {
      digits = raw.replace(/[^\d]/g, '')
    }
    if (digits) out.push(digits.replace(/^0+(?=\d)/, '') || '0')
  }
  return out
}

export type CurrencyToken = { raw: string; kind: 'symbol' | 'code' }

export function extractCurrencies(text: string): CurrencyToken[] {
  const found: CurrencyToken[] = []
  const seen = new Set<string>()
  const push = (raw: string, kind: CurrencyToken['kind']) => {
    const key = `${kind}:${raw}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({ raw, kind })
  }
  for (const ch of text) {
    if (ch === '₹') push('₹', 'symbol')
    else if (ch === '$') push('$', 'symbol')
    else if (ch === '€') push('€', 'symbol')
    else if (ch === '£') push('£', 'symbol')
    else if (ch === '¥') push('¥', 'symbol')
  }
  const upper = text.toUpperCase()
  for (const code of CURRENCY_CODES) {
    const re = new RegExp(`(^|[^A-Z])${code}([^A-Z]|$)`)
    if (re.test(upper)) push(code, 'code')
  }
  return found
}

/** Literal currency compatibility: codes↔codes, symbols↔symbols. No FX. */
export function currenciesCompatible(
  statement: CurrencyToken[],
  quoted: CurrencyToken[],
): boolean {
  if (statement.length === 0) return true
  const qSym = new Set(quoted.filter((c) => c.kind === 'symbol').map((c) => c.raw))
  const qCode = new Set(quoted.filter((c) => c.kind === 'code').map((c) => c.raw))
  for (const s of statement) {
    if (s.kind === 'symbol') {
      if (!qSym.has(s.raw)) return false
    } else if (!qCode.has(s.raw)) {
      return false
    }
  }
  return true
}

export function extractTransportModes(text: string): string[] {
  const n = normalizeEvidenceText(text)
  const hit: string[] = []
  for (const mode of TRANSPORT_MODES) {
    const re = new RegExp(
      `(^|[^a-záéíóúñ])${mode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-záéíóúñ]|$)`,
      'i',
    )
    if (re.test(n)) hit.push(mode)
  }
  return hit
}

export function extractStatusWords(text: string): string[] {
  const n = normalizeEvidenceText(text)
  const hit: string[] = []
  for (const w of STATUS_WORDS) {
    const re = new RegExp(
      `(^|[^a-záéíóúñ])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-záéíóúñ]|$)`,
      'i',
    )
    if (re.test(n)) hit.push(w)
  }
  return hit
}

function numbersCovered(statementNums: string[], quotedNums: string[]): boolean {
  if (statementNums.length === 0) return true
  const q = new Set(quotedNums)
  return statementNums.every((n) => q.has(n))
}

function modesCovered(statementModes: string[], quotedModes: string[]): boolean {
  if (statementModes.length === 0) return true
  const q = new Set(quotedModes.map((m) => normalizeEvidenceText(m)))
  return statementModes.every((m) => q.has(normalizeEvidenceText(m)))
}

function statusCovered(statementStatus: string[], quotedStatus: string[]): boolean {
  if (statementStatus.length === 0) return true
  const q = new Set(quotedStatus.map((m) => normalizeEvidenceText(m)))
  return statementStatus.every((m) => q.has(normalizeEvidenceText(m)))
}

/** Strip LLM-supplied quotedFact/sourceTitle (server owns them). */
export function sanitizeLlmClaimInput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const o = { ...(raw as Record<string, unknown>) }
  delete o.quotedFact
  delete o.sourceTitle
  if (o.sourceType === 'context') {
    // Context claims must not carry invented web URLs
    o.sourceUrl = null
    o.evidenceIndex = null
  } else if (o.sourceType == null && o.entityType && o.field && !o.sourceUrl) {
    o.sourceType = 'context'
  } else if (o.sourceType == null) {
    o.sourceType = 'web'
  }
  return o
}

function resolveContextField(
  context: import('../../shared/agentContracts.ts').TripContextSnapshot,
  entityType: string,
  entityId: string | null | undefined,
  field: string,
): { ok: true; value: string; title: string } | { ok: false; code: string; message: string } {
  if (entityType === 'trip') {
    const trip = context.trip as Record<string, unknown>
    if (field === 'travelOptions') {
      const opts = context.travelOptions ?? []
      const titles = opts
        .map((o) => (o as Record<string, unknown>).title)
        .filter((t): t is string => typeof t === 'string')
      const value =
        titles.length > 0
          ? titles.join('; ')
          : 'No hay travelOptions guardadas en el contexto local.'
      return { ok: true, value, title: 'context:trip.travelOptions' }
    }
    const v = trip?.[field]
    if (v === undefined || v === null) {
      return {
        ok: false,
        code: 'context_field_missing',
        message: `trip.${field} missing in TripContextSnapshot`,
      }
    }
    return {
      ok: true,
      value: Array.isArray(v) ? JSON.stringify(v) : String(v),
      title: `context:trip.${field}`,
    }
  }

  const collections: Record<string, unknown[] | undefined> = {
    travelOption: context.travelOptions,
    booking: context.bookings,
    itineraryItem: context.itineraryItems,
    checklistItem: context.checklistItems,
    note: context.notes,
  }
  const list = collections[entityType]
  if (!list) {
    return {
      ok: false,
      code: 'context_entity_type_invalid',
      message: `unknown entityType ${entityType}`,
    }
  }
  // Match primary entity id OR package externalId — LLMs often cite either.
  // Preferring only externalId broke grounding after cloud SoT (ids look like
  // opt-{packageId}-{externalId} while externalId stays short).
  const hit = list.find((item) => {
    if (entityId == null) return false
    const r = item as Record<string, unknown>
    const primary = r.id != null ? String(r.id) : ''
    const external = r.externalId != null ? String(r.externalId) : ''
    return entityId === primary || entityId === external
  }) as Record<string, unknown> | undefined
  if (!hit) {
    return {
      ok: false,
      code: 'context_entity_missing',
      message: `${entityType} id=${entityId} not in context`,
    }
  }
  const v = hit[field]
  if (v === undefined || v === null) {
    return {
      ok: false,
      code: 'context_field_missing',
      message: `${entityType}.${field} missing`,
    }
  }
  return {
    ok: true,
    value: String(v),
    title: `context:${entityType}.${field}`,
  }
}

/** User asked for flights on a concrete calendar day (not "in September" generally). */
export function isDaySpecificFlightAsk(prompt: string): boolean {
  const p = prompt
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
  if (!/\bvuelo|\bvuelos|\bflight|\bflights\b/.test(p)) return false
  // day + month, or ISO date, or "este 15 de septiembre"
  return (
    /\b\d{1,2}\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/.test(
      p,
    ) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(p) ||
    /\bel\s+\d{1,2}\b/.test(p) ||
    /\beste\s+\d{1,2}\b/.test(p)
  )
}

/** Aggregate route frequency — does not answer a day-specific flight ask. */
export function isAggregateFlightFrequencyText(text: string): boolean {
  const t = text
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
  if (!/\bvuelo|\bvuelos|\bflight|\bflights\b/.test(t)) return false
  return (
    /por\s+semana|a\s+la\s+semana|semanales|weekly/.test(t) ||
    /por\s+mes|al\s+mes|mensuales|monthly/.test(t) ||
    /por\s+ano|al\s+ano|anuales|yearly|per\s+year/.test(t) ||
    /\d+\s+vuelos\s+(por|a\s+la)\s+(semana|mes|ano)/.test(t)
  )
}

/**
 * Drop claims that answer a day-specific flight ask with weekly/monthly aggregates.
 * Soft-omit (do not fail the whole proposal) — wrong stats must not surface as evidence.
 */
export function filterAggregateFlightClaims(
  claims: AgentClaimDraft[],
  userPrompt: string | undefined,
): { kept: AgentClaimDraft[]; warnings: string[] } {
  if (!userPrompt || !isDaySpecificFlightAsk(userPrompt)) {
    return { kept: claims, warnings: [] }
  }
  const kept: AgentClaimDraft[] = []
  const warnings: string[] = []
  for (const c of claims) {
    const blob = `${c.statement} ${c.quotedFact}`
    if (isAggregateFlightFrequencyText(blob)) {
      warnings.push(
        `server: omitido agregado temporal (no responde a la fecha pedida): ${c.statement}`,
      )
      continue
    }
    kept.push(c)
  }
  if (warnings.length > 0 && kept.length === 0) {
    warnings.push(
      'server: no hay evidencia de vuelos/horarios para la fecha pedida en las fuentes consultadas.',
    )
  }
  return { kept, warnings }
}

/**
 * Attach server-owned evidence, then validate statement against that literal text.
 */
export function validateClaimsAgainstToolTrace(
  llmClaims: AgentClaimLlm[],
  toolTrace: ToolTraceEntry[],
  context?: import('../../shared/agentContracts.ts').TripContextSnapshot,
): ClaimValidationResult {
  const valid: AgentClaimDraft[] = []
  const invalid: ClaimViolation[] = []

  llmClaims.forEach((llmClaim, index) => {
    const sourceType = llmClaim.sourceType ?? 'web'

    if (sourceType === 'context') {
      if (!context) {
        invalid.push({
          index,
          claim: llmClaim,
          code: 'context_unavailable',
          message: 'context claim but TripContextSnapshot not provided',
        })
        return
      }
      const resolved = resolveContextField(
        context,
        llmClaim.entityType!,
        llmClaim.entityId,
        llmClaim.field!,
      )
      if (!resolved.ok) {
        invalid.push({
          index,
          claim: llmClaim,
          code: resolved.code,
          message: resolved.message,
        })
        return
      }
      const claim: AgentClaimDraft = {
        ...llmClaim,
        sourceType: 'context',
        sourceUrl: null,
        evidenceIndex: 0,
        sourceTitle: resolved.title,
        quotedFact: resolved.value.slice(0, 800),
      }
      // Context facts: statement should mention the field value (normalized containment)
      const normStmt = normalizeEvidenceText(claim.statement)
      const normVal = normalizeEvidenceText(claim.quotedFact)
      if (normVal && !normStmt.includes(normVal) && !normStmt.includes(normVal.slice(0, 10))) {
        // allow pretty-printed dates: if quotedFact is YYYY-MM-DD, also accept if statement has it
        invalid.push({
          index,
          claim,
          code: 'context_statement_mismatch',
          message: 'statement does not include context field value',
        })
        return
      }
      valid.push(claim)
      return
    }

    // --- web provenance ---
    if (!llmClaim.sourceUrl) {
      invalid.push({
        index,
        claim: llmClaim,
        code: 'source_url_missing',
        message: 'web claim missing sourceUrl',
      })
      return
    }

    const resolved = resolveClaimEvidence(
      llmClaim.sourceUrl,
      llmClaim.evidenceIndex,
      toolTrace,
    )
    if (!resolved.ok) {
      invalid.push({
        index,
        claim: llmClaim,
        code: resolved.code,
        message: resolved.message,
      })
      return
    }

    const claim: AgentClaimDraft = {
      ...llmClaim,
      sourceType: 'web',
      evidenceIndex: resolved.evidenceIndex,
      sourceTitle: resolved.sourceTitle,
      quotedFact: resolved.quotedFact,
    }

    const stmtNums = extractNumbers(claim.statement)
    const quoteNums = extractNumbers(claim.quotedFact)
    if (!numbersCovered(stmtNums, quoteNums)) {
      invalid.push({
        index,
        claim,
        code: 'number_mismatch',
        message: `statement numbers [${stmtNums.join(',')}] not all present in server evidence`,
      })
      return
    }

    const stmtCur = extractCurrencies(claim.statement)
    const quoteCur = extractCurrencies(claim.quotedFact)
    if (!currenciesCompatible(stmtCur, quoteCur)) {
      invalid.push({
        index,
        claim,
        code: 'currency_mismatch',
        message: `statement currency must match evidence literally (no FX); statement=${JSON.stringify(stmtCur)} evidence=${JSON.stringify(quoteCur)}`,
      })
      return
    }

    const stmtModes = extractTransportModes(claim.statement)
    const quoteModes = extractTransportModes(claim.quotedFact)
    if (!modesCovered(stmtModes, quoteModes)) {
      invalid.push({
        index,
        claim,
        code: 'transport_mode_ungrounded',
        message: `transport mode in statement not explicit in evidence: [${stmtModes.join(',')}]`,
      })
      return
    }

    const stmtStatus = extractStatusWords(claim.statement)
    const quoteStatus = extractStatusWords(claim.quotedFact)
    if (!statusCovered(stmtStatus, quoteStatus)) {
      invalid.push({
        index,
        claim,
        code: 'status_ungrounded',
        message: `status word in statement not explicit in evidence: [${stmtStatus.join(',')}]; "0 salidas" does not imply suspensión`,
      })
      return
    }

    if (claim.kind === 'transport_mode' && stmtModes.length === 0) {
      invalid.push({
        index,
        claim,
        code: 'transport_mode_missing',
        message: 'kind=transport_mode but statement has no explicit mode',
      })
      return
    }
    if (claim.kind === 'service_status' && stmtStatus.length === 0) {
      invalid.push({
        index,
        claim,
        code: 'status_missing',
        message: 'kind=service_status but statement has no explicit status word',
      })
      return
    }

    valid.push(claim)
  })

  return { valid, invalid }
}

export type OperationalSignal = {
  kind: 'price' | 'transport_mode' | 'service_status' | 'currency'
  text: string
  numbers: string[]
  currencies: CurrencyToken[]
  modes: string[]
  statusWords: string[]
  where: string
}

function pushUnique(signals: OperationalSignal[], s: OperationalSignal) {
  const key = `${s.kind}|${normalizeEvidenceText(s.text)}|${s.where}`
  if (signals.some((x) => `${x.kind}|${normalizeEvidenceText(x.text)}|${x.where}` === key)) {
    return
  }
  signals.push(s)
}

/** Extract operational assertions from free text (narrative / notes / etc.). */
export function extractOperationalSignals(
  text: string,
  where: string,
): OperationalSignal[] {
  if (!text?.trim()) return []
  const signals: OperationalSignal[] = []
  const allModes = extractTransportModes(text)
  const status = extractStatusWords(text)
  const currencies = extractCurrencies(text)
  const numbers = extractNumbers(text)
  const hasPriceContext = currencies.length > 0 || numbers.length > 0

  const bodyModes = allModes.filter((m) => {
    const n = normalizeEvidenceText(m)
    if ((STRICT_BODY_MODES as readonly string[]).includes(n)) return true
    if ((CONTEXT_BODY_MODES as readonly string[]).includes(n)) {
      return hasPriceContext
    }
    return false
  })

  for (const mode of bodyModes) {
    pushUnique(signals, {
      kind: 'transport_mode',
      text: mode,
      numbers: [],
      currencies: [],
      modes: [mode],
      statusWords: [],
      where,
    })
  }
  for (const st of status) {
    pushUnique(signals, {
      kind: 'service_status',
      text: st,
      numbers: [],
      currencies: [],
      modes: [],
      statusWords: [st],
      where,
    })
  }

  // Price-like: number near currency symbol/code
  if (currencies.length && numbers.length) {
    pushUnique(signals, {
      kind: 'price',
      text: text.slice(0, 240),
      numbers,
      currencies,
      modes: [],
      statusWords: [],
      where,
    })
  } else if (currencies.length) {
    pushUnique(signals, {
      kind: 'currency',
      text: text.slice(0, 240),
      numbers: [],
      currencies,
      modes: [],
      statusWords: [],
      where,
    })
  }

  return signals
}

function claimCoversSignal(
  claim: AgentClaimDraft,
  signal: OperationalSignal,
): boolean {
  const stmt = `${claim.statement} ${claim.quotedFact}`
  if (signal.kind === 'transport_mode') {
    const modes = extractTransportModes(stmt)
    return signal.modes.every((m) =>
      modes.some((cm) => normalizeEvidenceText(cm) === normalizeEvidenceText(m)),
    )
  }
  if (signal.kind === 'service_status') {
    const st = extractStatusWords(stmt)
    return signal.statusWords.every((m) =>
      st.some((cm) => normalizeEvidenceText(cm) === normalizeEvidenceText(m)),
    )
  }
  if (signal.kind === 'price' || signal.kind === 'currency') {
    const cNums = extractNumbers(stmt)
    const cCur = extractCurrencies(stmt)
    if (signal.numbers.length && !signal.numbers.every((n) => cNums.includes(n))) {
      return false
    }
    if (signal.currencies.length) {
      // Residual package fields may use ISO codes derived from symbols (₹→INR).
      const claimIsos = new Set(
        cCur
          .map((c) => (c.kind === 'code' ? c.raw : symbolToIso(c.raw)))
          .filter((x): x is string => Boolean(x)),
      )
      const claimSyms = new Set(
        cCur.filter((c) => c.kind === 'symbol').map((c) => c.raw),
      )
      for (const s of signal.currencies) {
        if (s.kind === 'symbol' && claimSyms.has(s.raw)) continue
        const iso = s.kind === 'code' ? s.raw : symbolToIso(s.raw)
        if (iso && claimIsos.has(iso)) continue
        if (!currenciesCompatible([s], cCur)) return false
      }
    }
    return signal.currencies.length > 0 || signal.numbers.length > 0
  }
  return false
}


function collectPackageTexts(pkg: unknown): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = []
  const p = pkg && typeof pkg === 'object' ? (pkg as Record<string, unknown>) : {}
  const addObj = (prefix: string, o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && v.trim()) out.push({ where: `${prefix}.${k}`, text: v })
      if (typeof v === 'number' && Number.isFinite(v)) {
        out.push({ where: `${prefix}.${k}`, text: String(v) })
      }
    }
  }
  if (p.trip && typeof p.trip === 'object') {
    addObj('package.trip', p.trip as Record<string, unknown>)
  }
  for (const key of ['travelOptions', 'itineraryItems', 'checklistItems', 'notes'] as const) {
    const arr = p[key]
    if (!Array.isArray(arr)) continue
    arr.forEach((item, i) => {
      if (item && typeof item === 'object') {
        addObj(`package.${key}[${i}]`, item as Record<string, unknown>)
        const rec = item as Record<string, unknown>
        if (typeof rec.priceObserved === 'number' && typeof rec.currency === 'string') {
          out.push({
            where: `package.${key}[${i}].price`,
            text: `${rec.priceObserved} ${rec.currency}`,
          })
        }
      }
    })
  }
  return out
}

function collectDiffTexts(diffSummary: unknown): { where: string; text: string }[] {
  if (!Array.isArray(diffSummary)) return []
  const out: { where: string; text: string }[] = []
  diffSummary.forEach((line, i) => {
    if (!line || typeof line !== 'object') return
    const r = line as Record<string, unknown>
    for (const k of ['before', 'after', 'note', 'entityRef'] as const) {
      if (typeof r[k] === 'string' && (r[k] as string).trim()) {
        out.push({ where: `diffSummary[${i}].${k}`, text: r[k] as string })
      }
    }
  })
  return out
}

const SCHEDULE_RE = /\b\d{1,2}:\d{2}\b/

function textHasScheduleToken(text: string): boolean {
  return SCHEDULE_RE.test(text)
}

/**
 * Drop sentences/paragraphs that contain any operational signal or schedule token.
 * Claims are the only allowed source of operational facts (re-injected elsewhere).
 */
export function scrubOperationalFreeText(text: string): string {
  if (!text?.trim()) return ''
  const parts = text.split(/(?:\n+|(?<=[.!?…])\s+)/)
  const kept: string[] = []
  for (const part of parts) {
    const p = part.trim()
    if (!p) continue
    if (textHasScheduleToken(p)) continue
    if (extractOperationalSignals(p, 'scrub').length > 0) continue
    kept.push(p)
  }
  return kept.join(' ').replace(/\s+/g, ' ').trim()
}

function symbolToIso(sym: string): string | undefined {
  if (sym === '₹') return 'INR'
  if (sym === '$') return 'USD'
  if (sym === '€') return 'EUR'
  if (sym === '£') return 'GBP'
  if (sym === '¥') return 'JPY'
  return undefined
}

/** Literal price label from claim evidence (preserves ₹ / $ etc.). */
export function literalPriceFromClaim(claim: AgentClaimDraft): string | null {
  const evidence = `${claim.quotedFact} ${claim.statement}`
  const curs = extractCurrencies(evidence)
  const nums = extractNumbers(evidence)
  if (!nums.length || !curs.length) return null
  const amount = nums[nums.length - 1]!
  const cur = curs[0]!
  if (cur.kind === 'symbol') return `${cur.raw}${amount}`
  return `${amount} ${cur.raw}`
}

export function priceFieldsFromClaim(claim: AgentClaimDraft): {
  priceObserved: number
  currency: string
  literal: string
} | null {
  const evidence = `${claim.quotedFact} ${claim.statement}`
  const curs = extractCurrencies(evidence)
  const nums = extractNumbers(evidence)
  if (!nums.length || !curs.length) return null
  const amount = Number(nums[nums.length - 1])
  if (!Number.isFinite(amount)) return null
  const cur = curs[0]!
  const iso =
    cur.kind === 'code' ? cur.raw : symbolToIso(cur.raw)
  if (!iso) return null
  const literal =
    cur.kind === 'symbol' ? `${cur.raw}${nums[nums.length - 1]}` : `${nums[nums.length - 1]} ${cur.raw}`
  return { priceObserved: amount, currency: iso, literal }
}

function appendNote(existing: unknown, line: string): string {
  const prev = typeof existing === 'string' ? existing.trim() : ''
  if (!prev) return line
  if (prev.includes(line)) return prev
  return `${prev}\n${line}`
}

/**
 * Rewrite draft so validated claims are the only source of operational facts.
 * Mutates and returns the draft.
 */
export function applyClaimsSourceOfTruth(
  draft: Record<string, unknown>,
  validClaims: AgentClaimDraft[],
): { draft: Record<string, unknown>; serverWarnings: string[] } {
  const serverWarnings: string[] = []

  if (typeof draft.narrative === 'string') {
    draft.narrative =
      scrubOperationalFreeText(draft.narrative) ||
      'Resumen de alto nivel; hechos operativos solo en evidencia validada.'
  }

  const scrubbedWarnings: string[] = []
  if (Array.isArray(draft.warnings)) {
    for (const w of draft.warnings) {
      if (typeof w !== 'string') continue
      const s = scrubOperationalFreeText(w)
      if (s) scrubbedWarnings.push(s)
    }
  }
  for (const claim of validClaims) {
    serverWarnings.push(`server: evidencia (${claim.kind}): ${claim.statement}`)
  }
  draft.warnings = [...scrubbedWarnings, ...serverWarnings]

  if (Array.isArray(draft.diffSummary)) {
    draft.diffSummary = draft.diffSummary.map((line) => {
      if (!line || typeof line !== 'object') return line
      const r = { ...(line as Record<string, unknown>) }
      for (const k of ['before', 'after', 'note', 'entityRef'] as const) {
        if (typeof r[k] === 'string') {
          r[k] = scrubOperationalFreeText(r[k] as string) || undefined
        }
      }
      return r
    })
  }

  const pkg =
    draft.package && typeof draft.package === 'object'
      ? ({ ...(draft.package as Record<string, unknown>) } as Record<string, unknown>)
      : {}
  const options = Array.isArray(pkg.travelOptions)
    ? pkg.travelOptions.map((o) =>
        o && typeof o === 'object' ? { ...(o as Record<string, unknown>) } : o,
      )
    : []

  for (const opt of options) {
    if (!opt || typeof opt !== 'object') continue
    const rec = opt as Record<string, unknown>
    for (const k of ['title', 'description', 'notes', 'provider'] as const) {
      if (typeof rec[k] === 'string') {
        rec[k] = scrubOperationalFreeText(rec[k] as string) || undefined
      }
    }
    if (typeof rec.title !== 'string' || !rec.title.trim()) {
      rec.title = 'Opción investigada'
    }
    delete rec.priceObserved
    delete rec.currency
  }

  const priceClaims = validClaims.filter((c) => c.kind === 'price')
  priceClaims.forEach((claim, i) => {
    const fields = priceFieldsFromClaim(claim)
    if (!fields) return
    const target =
      (options[i] as Record<string, unknown> | undefined) ||
      (options[0] as Record<string, unknown> | undefined)
    if (!target) return
    target.priceObserved = fields.priceObserved
    target.currency = fields.currency
    target.notes = appendNote(
      target.notes,
      `Precio observado (claim): ${fields.literal}`,
    )
    if (claim.sourceUrl) {
      target.sourceUrl = claim.sourceUrl
    }
  })

  // Re-attach non-price claim statements as notes on first option when present
  const otherClaims = validClaims.filter((c) => c.kind !== 'price')
  if (otherClaims.length && options[0] && typeof options[0] === 'object') {
    const t0 = options[0] as Record<string, unknown>
    for (const c of otherClaims) {
      t0.notes = appendNote(t0.notes, `Hecho (${c.kind}): ${c.statement}`)
    }
  }

  pkg.travelOptions = options

  // Scrub other package string arrays similarly
  for (const key of ['itineraryItems', 'checklistItems', 'notes'] as const) {
    const arr = pkg[key]
    if (!Array.isArray(arr)) continue
    pkg[key] = arr.map((item) => {
      if (!item || typeof item !== 'object') return item
      const rec = { ...(item as Record<string, unknown>) }
      for (const [k, v] of Object.entries(rec)) {
        if (typeof v === 'string') {
          rec[k] = scrubOperationalFreeText(v) || undefined
        }
      }
      return rec
    })
  }

  draft.package = pkg
  return { draft, serverWarnings }
}

function collectAllOperationalSignals(
  draft: Record<string, unknown>,
): OperationalSignal[] {
  const corpora: { where: string; text: string }[] = []
  if (typeof draft.narrative === 'string') {
    corpora.push({ where: 'narrative', text: draft.narrative })
  }
  if (Array.isArray(draft.warnings)) {
    draft.warnings.forEach((w, i) => {
      if (typeof w === 'string') corpora.push({ where: `warnings[${i}]`, text: w })
    })
  }
  corpora.push(...collectDiffTexts(draft.diffSummary))
  corpora.push(...collectPackageTexts(draft.package))
  const signals: OperationalSignal[] = []
  for (const c of corpora) {
    signals.push(...extractOperationalSignals(c.text, c.where))
  }
  return signals
}

export type GroundingFailure = {
  code: 'ungrounded_claims'
  message: string
  warnings: string[]
  violations: ClaimViolation[]
  uncoveredSignals: OperationalSignal[]
}

export type GroundingSuccess = {
  ok: true
  validClaims: AgentClaimDraft[]
  serverWarnings: string[]
  /** Draft after server rewrite (claims still present for strip in hydrate). */
  draft: Record<string, unknown>
}

export type GroundingResult = GroundingSuccess | ({ ok: false } & GroundingFailure)

/**
 * Validate claims, rewrite draft from claims as single source of truth, scrub free text.
 */
export function assertDraftGrounded(
  draftIn: Record<string, unknown>,
  toolTrace: ToolTraceEntry[],
  context?: import('../../shared/agentContracts.ts').TripContextSnapshot,
  opts?: { allowSkeletonPackage?: boolean; userPrompt?: string },
): GroundingResult {
  const draft = structuredClone(draftIn) as Record<string, unknown>
  const rawClaims = draft.claims
  const parseViolations: ClaimViolation[] = []
  const llmClaims: AgentClaimLlm[] = []

  if (rawClaims !== undefined) {
    if (!Array.isArray(rawClaims)) {
      return {
        ok: false,
        code: 'ungrounded_claims',
        message: 'claims must be an array',
        warnings: ['server: claims must be an array'],
        violations: [
          {
            index: -1,
            code: 'claims_not_array',
            message: 'claims must be an array',
          },
        ],
        uncoveredSignals: [],
      }
    }
    rawClaims.forEach((c, index) => {
      const parsed = agentClaimLlmSchema.safeParse(sanitizeLlmClaimInput(c))
      if (!parsed.success) {
        parseViolations.push({
          index,
          code: 'claim_schema_invalid',
          message: parsed.error.message.slice(0, 500),
        })
      } else {
        llmClaims.push(parsed.data)
      }
    })
  }

  if (parseViolations.length) {
    const warnings = parseViolations.map(
      (v) => `server: claim[${v.index}] inválido — ${v.message}`,
    )
    return {
      ok: false,
      code: 'ungrounded_claims',
      message: `ungrounded_claims: ${parseViolations.length} claim(s) failed schema`,
      warnings,
      violations: parseViolations,
      uncoveredSignals: [],
    }
  }

  const { valid: validated, invalid } = validateClaimsAgainstToolTrace(
    llmClaims,
    toolTrace,
    context,
  )
  if (invalid.length) {
    const warnings = invalid.map(
      (v) =>
        `server: claim[${v.index}] no grounded (${v.code}) — ${v.message}`,
    )
    return {
      ok: false,
      code: 'ungrounded_claims',
      message: `ungrounded_claims: ${invalid.map((v) => v.code).join(', ')}`,
      warnings,
      violations: invalid,
      uncoveredSignals: [],
    }
  }

  const filtered = filterAggregateFlightClaims(validated, opts?.userPrompt)
  const valid = filtered.kept
  const aggregateWarnings = filtered.warnings

  // Context-only read answers: Dexie/history is INPUT, not agent-authored output.
  // Do not rewrite package from claims, inject evidencia warnings, or residual-scan
  // echoed trip notes / options that were never part of this answer.
  if (isContextReadOnlyDraft(draft, valid)) {
    draft.warnings = []
    draft.diffSummary = Array.isArray(draft.diffSummary)
      ? draft.diffSummary
      : []
    if (!Array.isArray(draft.ops)) draft.ops = []
    return {
      ok: true,
      validClaims: valid,
      serverWarnings: aggregateWarnings,
      draft,
    }
  }

  // new_travel skeleton: web claims still fail-closed above; estimated
  // flight/hotel package fields skip residual SoT scan.
  if (opts?.allowSkeletonPackage) {
    if (!Array.isArray(draft.warnings)) draft.warnings = []
    if (!Array.isArray(draft.ops)) draft.ops = []
    return {
      ok: true,
      validClaims: valid,
      serverWarnings: aggregateWarnings,
      draft,
    }
  }

  const { draft: rewritten, serverWarnings } = applyClaimsSourceOfTruth(
    draft,
    valid,
  )
  const allServerWarnings = [...aggregateWarnings, ...serverWarnings]

  const signals = collectAllOperationalSignals(rewritten)
  const uncovered = signals.filter((sig) => {
    return !valid.some((claim) => claimCoversSignal(claim, sig))
  })

  if (uncovered.length) {
    const warnings = uncovered.map(
      (s) =>
        `server: afirmación operativa residual en ${s.where} (${s.kind}: ${s.text})`,
    )
    return {
      ok: false,
      code: 'ungrounded_claims',
      message: `ungrounded_claims: ${uncovered.length} residual operational assertion(s) after scrub`,
      warnings,
      violations: [],
      uncoveredSignals: uncovered,
    }
  }

  // Surface honest "no day-specific evidence" warnings in the proposal UI.
  if (allServerWarnings.length) {
    const prev = Array.isArray(rewritten.warnings)
      ? (rewritten.warnings as unknown[]).filter(
          (w): w is string => typeof w === 'string',
        )
      : []
    rewritten.warnings = [...prev, ...allServerWarnings]
  }

  return {
    ok: true,
    validClaims: valid,
    serverWarnings: allServerWarnings,
    draft: rewritten,
  }
}

/** Read-only Q&A grounded solely on TripContextSnapshot claims. */
export function isContextReadOnlyDraft(
  draft: Record<string, unknown>,
  validClaims: Array<{ sourceType?: string }>,
): boolean {
  if (!validClaims.length) return false
  if (!validClaims.every((c) => c.sourceType === 'context')) return false
  const ops = draft.ops
  if (Array.isArray(ops) && ops.length > 0) return false
  return true
}

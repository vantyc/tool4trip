import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import type { TripContextSnapshot } from '../../shared/agentContracts.ts'

/**
 * External calendar events (serenata, fiestas, festivals, …) must not be
 * persisted as dated facts when the only basis is user intent or weekend
 * remapping. Intent may remain as an unverified / pending placeholder.
 */

export const PENDING_EVENT_NOTE =
  'Objetivo del viajero — pendiente de verificar con fuente actual. Fecha concreta del evento no confirmada en este turno (no trasladar fechas del viaje anterior sin evidencia).'

const EXTERNAL_EVENT_RE =
  /\b(serenata|fiestas?\s+patronales|fiesta\s+patronal|feria|festival|concierto|grito|procesi[oó]n|romer[ií]a|evento\s+(municipal|cultural|religioso))\b/i

const MONTH_ES: Record<string, string> = {
  enero: '01',
  febrero: '02',
  marzo: '03',
  abril: '04',
  mayo: '05',
  junio: '06',
  julio: '07',
  agosto: '08',
  septiembre: '09',
  setiembre: '09',
  sep: '09',
  octubre: '10',
  noviembre: '11',
  diciembre: '12',
}

type Rec = Record<string, unknown>

function asRec(v: unknown): Rec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function norm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
}

export function isExternalEventText(text: string): boolean {
  return EXTERNAL_EVENT_RE.test(text)
}

/** Collect YYYY-MM-DD dates asserted in free text / ISO datetimes. */
export function extractAssertedEventDates(
  text: string,
  yearHint = '2026',
): string[] {
  const out = new Set<string>()
  const iso = text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)
  for (const m of iso) out.add(`${m[1]}-${m[2]}-${m[3]}`)

  const es = text.matchAll(
    /\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+)?(20\d{2})?\b/gi,
  )
  for (const m of es) {
    const day = String(Number(m[1])).padStart(2, '0')
    const month = MONTH_ES[m[2]!.toLowerCase()] ?? '09'
    const year = m[3] || yearHint
    out.add(`${year}-${month}-${day}`)
  }

  // "domingo 27" / "el 27" near month already handled; bare "el 27 de septiembre"
  return [...out]
}

function dateFormsForMatch(isoDate: string): string[] {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return [isoDate]
  const [, y, mo, d] = m
  const dayNum = String(Number(d))
  const months = Object.entries(MONTH_ES)
    .filter(([, v]) => v === mo)
    .map(([name]) => name)
  const forms = [isoDate, `${d}/${mo}/${y}`, `${dayNum}/${mo}/${y}`]
  for (const name of months) {
    forms.push(`${dayNum} de ${name}`)
    forms.push(`${dayNum} de ${name} de ${y}`)
    forms.push(`${d} de ${name}`)
  }
  return forms
}

function eventKindKey(text: string): string {
  const n = norm(text)
  if (/serenata/.test(n)) return 'serenata'
  if (/fiestas?\s+patronales|fiesta\s+patronal/.test(n)) return 'fiestas_patronales'
  if (/feria/.test(n)) return 'feria'
  if (/festival/.test(n)) return 'festival'
  if (/concierto/.test(n)) return 'concierto'
  if (/grito/.test(n)) return 'grito'
  return 'event'
}

function webEvidenceSupportsEventDate(
  toolTrace: ToolTraceEntry[],
  eventText: string,
  isoDate: string,
): boolean {
  const kind = eventKindKey(eventText)
  const forms = dateFormsForMatch(isoDate).map(norm)
  for (const t of toolTrace) {
    if (t.tool !== 'webSearch' && t.tool !== 'fetchUrl') continue
    if (!t.ok) continue
    for (const s of t.sources ?? []) {
      const blob = norm(`${s.title ?? ''} ${s.snippet ?? ''} ${s.url ?? ''}`)
      if (kind === 'serenata' && !/serenata/.test(blob)) continue
      if (kind === 'fiestas_patronales' && !/patronal|fiestas/.test(blob)) {
        continue
      }
      if (
        kind !== 'serenata' &&
        kind !== 'fiestas_patronales' &&
        !EXTERNAL_EVENT_RE.test(blob)
      ) {
        continue
      }
      if (forms.some((f) => blob.includes(f))) return true
    }
  }
  return false
}

function contextSupportsEventDate(
  context: TripContextSnapshot | undefined,
  eventText: string,
  isoDate: string,
): boolean {
  if (!context) return false
  const kind = eventKindKey(eventText)
  const corpora: string[] = []
  for (const g of context.trip?.goals ?? []) {
    const label =
      typeof g === 'string'
        ? g
        : typeof (g as { label?: string }).label === 'string'
          ? (g as { label: string }).label
          : ''
    if (label) corpora.push(label)
  }
  for (const item of context.itineraryItems ?? []) {
    const r = asRec(item)
    corpora.push(`${str(r.title)} ${str(r.notes)} ${str(r.startAt)} ${str(r.place)}`)
  }
  for (const o of context.travelOptions ?? []) {
    const r = asRec(o)
    if (!['event', 'activity', 'other'].includes(str(r.type))) continue
    corpora.push(
      `${str(r.title)} ${str(r.notes)} ${str(r.startAt)} ${str(r.description)}`,
    )
  }
  for (const blob of corpora) {
    if (kind === 'serenata' && !/serenata/i.test(blob)) continue
    if (kind === 'fiestas_patronales' && !/patronal/i.test(blob)) continue
    if (
      kind !== 'serenata' &&
      kind !== 'fiestas_patronales' &&
      !isExternalEventText(blob)
    ) {
      continue
    }
    const dates = extractAssertedEventDates(blob)
    if (dates.includes(isoDate)) return true
    if (blob.includes(isoDate)) return true
  }
  return false
}

function stripDatedPhrasesFromTitle(title: string): string {
  let t = title
  t = t.replace(
    /\b(?:el\s+)?(?:lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\s+\d{1,2}(?:\s+de\s+\w+)?(?:\s+de\s+20\d{2})?\b/gi,
    '',
  )
  t = t.replace(
    /\b(?:el\s+)?\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+20\d{2})?\b/gi,
    '',
  )
  t = t.replace(/\b20\d{2}-\d{2}-\d{2}\b/g, '')
  t = t.replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim()
  t = t.replace(/[—–-]\s*$/g, '').trim()
  return t || title
}

function demoteOne(
  rec: Rec,
  where: string,
  toolTrace: ToolTraceEntry[],
  context: TripContextSnapshot | undefined,
  yearHint: string,
): { rec: Rec; warnings: string[] } {
  const title = str(rec.title)
  const notes = str(rec.notes)
  const blob = `${title} ${notes} ${str(rec.description)} ${str(rec.startAt)}`
  if (!isExternalEventText(blob)) return { rec, warnings: [] }

  const id = str(rec.externalId)
  if (id.startsWith('airport-arrival-')) return { rec, warnings: [] }

  const asserted = new Set<string>([
    ...extractAssertedEventDates(blob, yearHint),
  ])
  const start = str(rec.startAt)
  if (/^\d{4}-\d{2}-\d{2}/.test(start)) asserted.add(start.slice(0, 10))

  if (asserted.size === 0) {
    // Intent-only: still ensure pending note
    const next = { ...rec }
    if (!/pendiente de verificar|fecha tentativa/i.test(str(next.notes))) {
      next.notes = [str(next.notes), PENDING_EVENT_NOTE].filter(Boolean).join(' ')
    }
    return { rec: next, warnings: [] }
  }

  const ungrounded: string[] = []
  for (const d of asserted) {
    const ok =
      webEvidenceSupportsEventDate(toolTrace, blob, d) ||
      contextSupportsEventDate(context, blob, d)
    if (!ok) ungrounded.push(d)
  }
  if (ungrounded.length === 0) return { rec, warnings: [] }

  const next = { ...rec }
  const prevTitle = title
  next.title = stripDatedPhrasesFromTitle(title)
  if (next.title === prevTitle && /serenata|fiestas|feria|festival/i.test(title)) {
    // Ensure title doesn't still read as a dated fact via startAt alone
    next.title = `${stripDatedPhrasesFromTitle(title)} (fecha tentativa)`
  }
  delete next.startAt
  delete next.endAt
  // Drop false "Fecha objetivo: YYYY-MM-DD" pins
  let newNotes = notes.replace(
    /Fecha objetivo:\s*20\d{2}-\d{2}-\d{2}\.?/gi,
    '',
  )
  newNotes = newNotes.replace(
    /Fecha asociada \(sin hora verificada\):\s*20\d{2}-\d{2}-\d{2}\.?/gi,
    '',
  )
  if (!/pendiente de verificar|fecha tentativa/i.test(newNotes)) {
    newNotes = [newNotes.trim(), PENDING_EVENT_NOTE].filter(Boolean).join(' ')
  } else if (!/fecha concreta del evento no confirmada/i.test(newNotes)) {
    newNotes = `${newNotes.trim()} Fecha concreta del evento no confirmada en este turno.`
  }
  next.notes = newNotes.replace(/\s{2,}/g, ' ').trim()
  if (str(next.type) === 'event' || str(next.type) === 'activity') {
    next.verificationStatus = 'unverified'
  }

  return {
    rec: next,
    warnings: [
      `server: fecha de evento externo sin evidencia en «${prevTitle || where}» degradada a pendiente/fecha tentativa (sin confirmar: ${ungrounded.join(', ')}).`,
    ],
  }
}

function scrubNarrativeDatedEventClaims(
  narrative: string,
  toolTrace: ToolTraceEntry[],
  context: TripContextSnapshot | undefined,
  yearHint: string,
  protectedDates: Set<string> = new Set(),
): { narrative: string; warnings: string[] } {
  if (!narrative.trim()) return { narrative, warnings: [] }
  const warnings: string[] = []
  // Sentence-level: if a sentence asserts external event + concrete date without evidence, soften.
  const parts = narrative.split(/(?<=[.!?…])\s+/)
  const out: string[] = []
  for (const part of parts) {
    if (!isExternalEventText(part)) {
      out.push(part)
      continue
    }
    const dates = extractAssertedEventDates(part, yearHint)
    if (!dates.length) {
      out.push(part)
      continue
    }
    const bad = dates.filter(
      (d) =>
        !protectedDates.has(d) &&
        !webEvidenceSupportsEventDate(toolTrace, part, d) &&
        !contextSupportsEventDate(context, part, d),
    )
    if (!bad.length) {
      out.push(part)
      continue
    }
    let softened = part
    // Only scrub dates that are ungrounded AND not trip-window / flight dates.
    // Consume leading "al "/"el " so we never produce "aldurante…".
    for (const d of bad) {
      // Skip dates in explicit flight / salida / regreso clauses — those are trip logistics.
      const flightDateContext = new RegExp(
        `(?:salida|regreso|vuelo|ida|vuelve|volver|partir|llega(?:r|da)?)[^.\\n]{0,40}${escapeRegExp(
          dateFormsForMatch(d)[0] ?? d,
        )}`,
        'i',
      )
      // Broader: if the phrase is "salida al <date>" or "regreso al <date>", keep it.
      const logisticPhrase = new RegExp(
        `(?:salida|regreso|ida|vuelta)\\s+al?\\s+(?:el\\s+)?(?:lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)?\\s*\\d{1,2}\\s+de\\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\\s+de\\s+20\\d{2})?`,
        'gi',
      )
      // Protect logistic phrases by temporarily masking them
      const masks: string[] = []
      softened = softened.replace(logisticPhrase, (m) => {
        const token = `__KEEP_DATE_${masks.length}__`
        masks.push(m)
        return token
      })
      void flightDateContext
      for (const form of dateFormsForMatch(d)) {
        const re = new RegExp(
          `(?:\\b(?:al|el)\\s+)?(?:(?:lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\\s+)?${escapeRegExp(form)}`,
          'gi',
        )
        softened = softened.replace(
          re,
          'en fecha tentativa del evento (pendiente de verificar)',
        )
      }
      masks.forEach((m, i) => {
        softened = softened.replace(`__KEEP_DATE_${i}__`, m)
      })
    }
    if (!/pendiente de verificar|fecha tentativa/i.test(softened)) {
      softened = softened.replace(/\.\s*$/, '')
      softened = `${softened} — pendiente de verificar con fuente actual.`
    }
    // Collapse accidental glue like "aldurante" if anything slipped through
    softened = softened.replace(/\baldurante\b/gi, 'durante')
    softened = softened.replace(/\s{2,}/g, ' ').trim()
    out.push(softened)
    warnings.push(
      `server: narrativa suavizada — no afirmar evento externo en fecha(s) ${bad.join(', ')} sin evidencia.`,
    )
  }
  return { narrative: out.join(' '), warnings }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Demote itinerary/event rows (and narrative sentences) that pin external
 * events to concrete calendar days without context or web evidence.
 */
export function demoteUnverifiedExternalEventDates(
  draft: Record<string, unknown>,
  toolTrace: ToolTraceEntry[],
  context?: TripContextSnapshot,
): string[] {
  const warnings: string[] = []
  const pkg =
    draft.package && typeof draft.package === 'object'
      ? (draft.package as Rec)
      : null
  const trip = pkg ? asRec(pkg.trip) : {}
  const yearHint =
    str(trip.startDate).slice(0, 4) ||
    str(trip.endDate).slice(0, 4) ||
    '2026'

  const protectedDates = new Set<string>()
  if (/^\d{4}-\d{2}-\d{2}$/.test(str(trip.startDate))) {
    protectedDates.add(str(trip.startDate).slice(0, 10))
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(str(trip.endDate))) {
    protectedDates.add(str(trip.endDate).slice(0, 10))
  }
  // Also protect flight schedule dates in the package
  if (Array.isArray(pkg?.travelOptions)) {
    for (const raw of pkg.travelOptions) {
      if (!raw || typeof raw !== 'object') continue
      const o = raw as Rec
      if (str(o.type) !== 'flight' && str(o.sourceType) !== 'flight_schedule') {
        continue
      }
      const s = str(o.startAt)
      const e = str(o.endAt)
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) protectedDates.add(s.slice(0, 10))
      if (/^\d{4}-\d{2}-\d{2}/.test(e)) protectedDates.add(e.slice(0, 10))
    }
  }

  if (typeof draft.narrative === 'string') {
    const n = scrubNarrativeDatedEventClaims(
      draft.narrative,
      toolTrace,
      context,
      yearHint,
      protectedDates,
    )
    draft.narrative = n.narrative
    warnings.push(...n.warnings)
  }

  if (!pkg) return warnings

  if (Array.isArray(pkg.itineraryItems)) {
    pkg.itineraryItems = pkg.itineraryItems.map((raw, i) => {
      if (!raw || typeof raw !== 'object') return raw
      const { rec, warnings: w } = demoteOne(
        { ...(raw as Rec) },
        `itineraryItems[${i}]`,
        toolTrace,
        context,
        yearHint,
      )
      warnings.push(...w)
      return rec
    })
  }

  if (Array.isArray(pkg.travelOptions)) {
    pkg.travelOptions = pkg.travelOptions.map((raw, i) => {
      if (!raw || typeof raw !== 'object') return raw
      const o = raw as Rec
      const ty = str(o.type)
      if (ty !== 'event' && ty !== 'activity' && !isExternalEventText(str(o.title))) {
        return raw
      }
      // Never touch flights / lodging / transfer
      if (['flight', 'lodging', 'bus', 'train', 'transfer', 'car_rental'].includes(ty)) {
        return raw
      }
      const { rec, warnings: w } = demoteOne(
        { ...o },
        `travelOptions[${i}]`,
        toolTrace,
        context,
        yearHint,
      )
      warnings.push(...w)
      return rec
    })
  }

  draft.package = pkg
  return warnings
}

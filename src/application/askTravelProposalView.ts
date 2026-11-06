/**
 * Ask Travel proposal view helpers — derive UI from canonical preview,
 * never from LLM narrative alone.
 */
import { isLodgingCandidateNote } from '../../shared/lodgingCandidate'

export type CanonicalDiffField = {
  field: string
  before: unknown
  after: unknown
}

export type CanonicalDiffLine = {
  kind: 'remove' | 'add' | 'update' | 'keep'
  entityKind: 'travelOption' | 'trip' | string
  externalId: string
  fields?: CanonicalDiffField[]
  note?: string
}

export type CanonicalDiffCounts = {
  adds: number
  updates: number
  removes: number
  unchanged: number
  totalOps: number
}

export type TravelOptionLike = {
  externalId?: string
  type?: string
  title?: string
  startAt?: string
  endAt?: string
  origin?: string
  destination?: string
  sourceType?: string
  sourceUrl?: string
  provider?: string
  checkedAt?: string
  notes?: string
  phone?: string
  address?: string
  status?: string
  verificationStatus?: string
}

export type TripWindow = {
  startDate: string
  endDate: string
  title?: string
}

export type DependencyWarning = {
  code:
    | 'missing_return_transfer'
    | 'checkout_after_departure'
    | 'early_return_needs_gdl_night'
  severity: 'warning'
  message: string
}

const MONTH_ES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const

export function formatDateLongEs(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ymd
  const day = Number(m[3])
  const month = MONTH_ES[Number(m[2]) - 1] ?? m[2]
  return `${day} de ${month} de ${m[1]}`
}

export function countCanonicalDiff(
  diff: CanonicalDiffLine[],
  normalizedOptionCount: number,
): CanonicalDiffCounts {
  const adds = diff.filter((d) => d.kind === 'add').length
  const updates = diff.filter((d) => d.kind === 'update').length
  const removes = diff.filter((d) => d.kind === 'remove').length
  const totalOps = adds + updates + removes
  const addOrUpdate = new Set(
    diff
      .filter(
        (d) =>
          d.entityKind === 'travelOption' &&
          (d.kind === 'add' || d.kind === 'update'),
      )
      .map((d) => d.externalId),
  )
  const unchangedExact = Math.max(0, normalizedOptionCount - addOrUpdate.size)
  return {
    adds,
    updates,
    removes,
    unchanged: unchangedExact,
    totalOps,
  }
}

export function buildCanonicalNarrative(args: {
  tripTitle: string
  currentWindow: TripWindow
  proposedWindow: TripWindow
  diff: CanonicalDiffLine[]
  normalizedOptions: TravelOptionLike[]
}): string {
  const { tripTitle, currentWindow, proposedWindow, diff, normalizedOptions } =
    args
  const parts: string[] = []

  const windowChanged =
    currentWindow.startDate !== proposedWindow.startDate ||
    currentWindow.endDate !== proposedWindow.endDate
  if (windowChanged) {
    parts.push(
      `Se actualiza «${tripTitle}»: salida el ${formatDateLongEs(proposedWindow.startDate)} y regreso el ${formatDateLongEs(proposedWindow.endDate)}` +
        ` (antes ${formatDateLongEs(currentWindow.startDate)} → ${formatDateLongEs(currentWindow.endDate)}).`,
    )
  } else {
    parts.push(`Propuesta sobre «${tripTitle}» sin cambio de ventana.`)
  }

  const removes = diff.filter(
    (d) => d.kind === 'remove' && d.entityKind === 'travelOption',
  )
  const adds = diff.filter(
    (d) => d.kind === 'add' && d.entityKind === 'travelOption',
  )
  const updates = diff.filter(
    (d) => d.kind === 'update' && d.entityKind === 'travelOption',
  )

  for (const r of removes) {
    parts.push(`Se elimina ${r.externalId}${r.note ? ` (${r.note})` : ''}.`)
  }
  for (const a of adds) {
    const opt = normalizedOptions.find((o) => o.externalId === a.externalId)
    const label = opt?.title || a.note || a.externalId
    parts.push(`Se agrega ${a.externalId}: ${label}.`)
  }
  for (const u of updates) {
    const fields = (u.fields ?? [])
      .map((f) => `${f.field}: ${String(f.before ?? '—')} → ${String(f.after ?? '—')}`)
      .join('; ')
    parts.push(
      `Se actualiza ${u.externalId}${fields ? ` (${fields})` : u.note ? ` (${u.note})` : ''}.`,
    )
  }

  const byId = new Set(normalizedOptions.map((o) => o.externalId).filter(Boolean))
  // Never claim entities that are not in desired state
  if (
    /guadalajara|alternativa/i.test(parts.join(' ')) &&
    ![...byId].some((id) => /gdl|guadalajara|fallback|lodge/i.test(String(id)))
  ) {
    // strip is handled by only listing what is in diff/desired — no GDL alt claim
  }

  const keeps = normalizedOptions.filter(
    (o) =>
      o.externalId &&
      !removes.some((r) => r.externalId === o.externalId) &&
      !adds.some((a) => a.externalId === o.externalId) &&
      !updates.some((u) => u.externalId === o.externalId),
  )
  if (keeps.length) {
    parts.push(
      `Se conservan sin cambio de campos: ${keeps.map((k) => k.externalId).join(', ')}.`,
    )
  }

  return parts.join(' ').replace(/\s{2,}/g, ' ').trim()
}

function datePrefix(iso?: string): string | undefined {
  if (!iso) return undefined
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})/)
  return m?.[1]
}

function clock(iso?: string): string | undefined {
  if (!iso) return undefined
  const m = iso.match(/T(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : undefined
}

function mentionsCity(text: string, city: 'sma' | 'gdl'): boolean {
  const n = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
  if (city === 'sma') return /san miguel|sma/.test(n)
  return /\bgdl\b|guadalajara/.test(n)
}

export function detectDependencyWarnings(
  options: TravelOptionLike[],
): DependencyWarning[] {
  const warnings: DependencyWarning[] = []
  const flights = options.filter((o) => o.type === 'flight')
  const lodges = options.filter((o) => o.type === 'lodging')
  const transfers = options.filter(
    (o) => o.type === 'transfer' || o.type === 'bus' || o.type === 'car_rental',
  )

  const returns = flights.filter((f) => {
    const ori = (f.origin ?? '').toUpperCase()
    const dest = (f.destination ?? '').toUpperCase()
    return (ori === 'GDL' || ori === 'BJX') && dest === 'MEX'
  })

  const hasOutboundTransfer = transfers.some((t) => {
    const blob = `${t.title ?? ''} ${t.origin ?? ''} ${t.destination ?? ''}`
    return mentionsCity(blob, 'gdl') && mentionsCity(blob, 'sma')
  })
  const hasReturnTransfer = transfers.some((t) => {
    const blob = `${t.title ?? ''} ${t.origin ?? ''} ${t.destination ?? ''}`.toLowerCase()
    // SMA → GDL direction
    const fromSma =
      /san miguel|sma/.test(blob) &&
      (/→\s*gdl|a\s+guadalajara|→\s*guadalajara|destino.*gdl/.test(blob) ||
        (t.destination ?? '').toUpperCase() === 'GDL')
    const oriSma =
      mentionsCity(`${t.origin ?? ''} ${t.title ?? ''}`, 'sma') &&
      mentionsCity(`${t.destination ?? ''}`, 'gdl')
    return fromSma || oriSma
  })

  // Only GDL→SMA present, missing SMA→GDL
  const onlyGdlToSma =
    transfers.some((t) => {
      const title = (t.title ?? '').toLowerCase()
      return (
        /guadalajara\s*→\s*san miguel|gdl\s*→\s*sma/.test(title) ||
        (mentionsCity(t.origin ?? '', 'gdl') &&
          mentionsCity(t.destination ?? t.title ?? '', 'sma'))
      )
    }) && !hasReturnTransfer

  if (returns.length > 0 && (onlyGdlToSma || (hasOutboundTransfer && !hasReturnTransfer))) {
    warnings.push({
      code: 'missing_return_transfer',
      severity: 'warning',
      message:
        'Falta traslado San Miguel el Alto → GDL para el vuelo de regreso (sólo aparece traslado hacia San Miguel).',
    })
  }

  for (const ret of returns) {
    const lodge = lodges[0]
    if (!lodge?.endAt || !ret.startAt) continue
    const lodgeEndDay = datePrefix(lodge.endAt)
    const flightDay = datePrefix(ret.startAt)
    if (lodgeEndDay && flightDay && lodgeEndDay === flightDay) {
      const lodgeEndClock = clock(lodge.endAt)
      const flightClock = clock(ret.startAt)
      if (lodgeEndClock && flightClock && lodgeEndClock > flightClock) {
        warnings.push({
          code: 'checkout_after_departure',
          severity: 'warning',
          message: `El check-out de hospedaje (${lodgeEndClock}) ocurre después de la salida del vuelo de regreso (${flightClock} desde ${ret.origin ?? 'GDL'}).`,
        })
      }
    }
    const hh = Number(clock(ret.startAt)?.slice(0, 2) ?? 99)
    if (hh < 8) {
      warnings.push({
        code: 'early_return_needs_gdl_night',
        severity: 'warning',
        message: `El vuelo de regreso tan temprano (${clock(ret.startAt)}) posiblemente exige salir la noche anterior o dormir en Guadalajara.`,
      })
    }
  }

  return warnings
}

export function flightScheduleConfidenceLabels(o: TravelOptionLike): string[] {
  if (o.sourceType !== 'flight_schedule') return []
  return [
    'horario verificado',
    'precio UNKNOWN',
    'disponibilidad UNKNOWN',
    'equipaje UNKNOWN',
  ]
}

const STATUS_ES: Record<string, string> = {
  researched: 'investigado',
  shortlisted: 'preseleccionado',
  selected: 'seleccionado',
  booked: 'reservado',
  rejected: 'descartado',
}

const VERIFICATION_ES: Record<string, string> = {
  verified: 'verificado',
  estimated: 'estimado',
  unverified: 'sin verificar',
}

/** Contact and provenance lines shown directly under an option in the preview. */
export function optionDetailLines(o: TravelOptionLike): string[] {
  const lines: string[] = []
  if (isLodgingCandidateNote(o.notes)) {
    lines.push('Candidato de hospedaje — no reemplaza tu hospedaje actual')
  }
  const phone = o.phone?.trim()
  if (phone) lines.push(`Tel: ${phone}`)
  const address = o.address?.trim()
  if (address) lines.push(`Dirección: ${address}`)
  const url = o.sourceUrl?.trim()
  if (url) lines.push(`Fuente: ${url}`)
  const state = [
    o.status ? (STATUS_ES[o.status] ?? o.status) : '',
    o.verificationStatus
      ? (VERIFICATION_ES[o.verificationStatus] ?? o.verificationStatus)
      : '',
  ].filter(Boolean)
  if (state.length) lines.push(`Estado: ${state.join(' · ')}`)
  return lines
}

export type EvidenceRow = {
  kind: string
  title: string
  detail?: string
  url?: string
}

/** Drop empty / dash-only / markdown-noise rows. */
export function isEmptyEvidenceValue(v: unknown): boolean {
  if (v === undefined || v === null) return true
  const s = String(v).trim()
  if (!s) return true
  if (/^[-–—_*·•|#\s]+$/.test(s)) return true
  if (/^(\|\s*)+$/.test(s)) return true
  return false
}

export function collectStructuredEvidence(args: {
  warnings: string[]
  diffSummary: Array<{
    entityKind?: string
    entityRef?: string
    op?: string
    before?: string | null
    after?: string | null
    note?: string
  }>
  toolTrace: Array<{
    tool: string
    ok: boolean
    error?: string
    sources?: Array<{ title?: string; url?: string; snippet?: string }>
  }>
}): EvidenceRow[] {
  const rows: EvidenceRow[] = []
  for (const w of args.warnings) {
    if (isEmptyEvidenceValue(w)) continue
    rows.push({ kind: 'warning', title: w })
  }
  for (const d of args.diffSummary) {
    const label = [d.op, d.entityRef ?? d.entityKind, d.note]
      .filter((x) => !isEmptyEvidenceValue(x))
      .join(' · ')
    const before = isEmptyEvidenceValue(d.before) ? '' : String(d.before)
    const after = isEmptyEvidenceValue(d.after) ? '' : String(d.after)
    const detail = [before && `Antes: ${before}`, after && `Después: ${after}`]
      .filter(Boolean)
      .join(' · ')
    if (isEmptyEvidenceValue(label) && isEmptyEvidenceValue(detail)) continue
    rows.push({
      kind: 'diff',
      title: label || 'cambio RAW',
      detail: detail || undefined,
    })
  }
  for (const t of args.toolTrace) {
    if (isEmptyEvidenceValue(t.tool)) continue
    rows.push({
      kind: 'tool',
      title: `${t.tool}: ${t.ok ? 'ok' : t.error ?? 'fail'}`,
    })
    for (const s of t.sources ?? []) {
      if (
        isEmptyEvidenceValue(s.title) &&
        isEmptyEvidenceValue(s.url) &&
        isEmptyEvidenceValue(s.snippet)
      ) {
        continue
      }
      rows.push({
        kind: 'source',
        title: s.title || 'fuente',
        detail: s.snippet,
        url: s.url,
      })
    }
  }
  return rows
}

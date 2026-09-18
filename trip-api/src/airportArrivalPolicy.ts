/**
 * Airport arrival buffers — Tool4Trip plus so travelers don't miss flights
 * by ignoring airline/airport check-in lead times.
 *
 * Times are policy defaults (not live airline rules). National = both ends in MX.
 */

export type FlightScope = 'domestic' | 'international'

/** Minutes before departure to be at the airport. */
export type AirportArrivalOffsets = {
  /** Counter / bag-drop documentation. */
  deskMinutes: number
  /** Online check-in / boarding pass only. */
  onlineMinutes: number
}

export const AIRPORT_ARRIVAL_OFFSETS: Record<FlightScope, AirportArrivalOffsets> =
  {
    domestic: { deskMinutes: 150, onlineMinutes: 90 },
    international: { deskMinutes: 210, onlineMinutes: 150 },
  }

/** Well-known Mexican passenger airports (IATA). */
export const MX_IATA = new Set([
  'MEX',
  'NLU',
  'TLC',
  'GDL',
  'BJX',
  'AGU',
  'MLM',
  'CUN',
  'MID',
  'MTY',
  'TIJ',
  'SJD',
  'PVR',
  'HUX',
  'ZIH',
  'ACA',
  'VER',
  'TAM',
  'QRO',
  'SLP',
  'CUL',
  'HMO',
  'CUU',
  'OAX',
  'TGZ',
  'VSA',
  'CME',
  'PBC',
  'UPN',
  'ZCL',
  'DGO',
  'LMM',
  'MZT',
  'LAP',
  'PXM',
  'CZM',
  'TPQ',
])

/** Extract first IATA-looking code from free text (e.g. "MEX — CDMX"). */
export function extractIataCode(text: string | null | undefined): string | null {
  if (!text?.trim()) return null
  const m = text
    .toUpperCase()
    .match(/\b([A-Z]{3})\b/)
  return m?.[1] ?? null
}

export function classifyFlightScope(
  originText: string | null | undefined,
  destinationText: string | null | undefined,
): FlightScope {
  const o = extractIataCode(originText)
  const d = extractIataCode(destinationText)
  if (o && d && MX_IATA.has(o) && MX_IATA.has(d)) return 'domestic'
  return 'international'
}

export function arrivalOffsetsFor(
  originText: string | null | undefined,
  destinationText: string | null | undefined,
): AirportArrivalOffsets & { scope: FlightScope } {
  const scope = classifyFlightScope(originText, destinationText)
  return { scope, ...AIRPORT_ARRIVAL_OFFSETS[scope] }
}

/** Subtract minutes from an ISO datetime with offset; returns ISO with same offset style. */
export function subtractMinutesIso(
  isoWithOffset: string,
  minutes: number,
): string | null {
  const t = Date.parse(isoWithOffset)
  if (!Number.isFinite(t)) return null
  const d = new Date(t - minutes * 60_000)
  // Preserve Z or ±HH:MM from input when possible
  const m = isoWithOffset.match(/([Zz]|[+-]\d{2}:\d{2})$/)
  const suffix = m?.[1] ?? 'Z'
  if (suffix === 'Z' || suffix === 'z') {
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
  }
  // Format in UTC then re-apply offset label by adjusting — use ISO with offset via Intl-less math
  const sign = suffix[0] === '-' ? -1 : 1
  const oh = Number(suffix.slice(1, 3))
  const om = Number(suffix.slice(4, 6))
  const offsetMin = sign * (oh * 60 + om)
  const local = new Date(d.getTime() + offsetMin * 60_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    suffix
  )
}

export function formatClockEs(isoWithOffset: string): string {
  const m = isoWithOffset.match(/T(\d{2}):(\d{2})/)
  if (m) return `${Number(m[1])}:${m[2]}`
  const t = Date.parse(isoWithOffset)
  if (!Number.isFinite(t)) return isoWithOffset
  return new Intl.DateTimeFormat('es-MX', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(t))
}

export type FlightLike = {
  externalId: string
  title: string
  origin?: string
  destination?: string
  startAt?: string
}

export type AirportArrivalItineraryDraft = {
  externalId: string
  title: string
  startAt: string
  place: string
  importance: 'crucial'
  notes: string
  /** Used by import to create AbsoluteReminder at startAt. */
  reminderLabel: string
}

/**
 * Build airport-arrival itinerary drafts from flight options with startAt.
 * One reminder per flight (desk / bag-drop). Online timing is documented in notes
 * to avoid duplicate generic airport activities in the itinerary.
 * Idempotent externalId: airport-arrival-desk-{flightExtId}
 */
export function buildAirportArrivalItinerary(
  flights: FlightLike[],
): AirportArrivalItineraryDraft[] {
  const out: AirportArrivalItineraryDraft[] = []
  for (const f of flights) {
    if (!f.startAt) continue
    const { scope, deskMinutes, onlineMinutes } = arrivalOffsetsFor(
      f.origin,
      f.destination,
    )
    const airport =
      extractIataCode(f.origin) ||
      f.origin?.trim() ||
      'aeropuerto de salida'
    const deskAt = subtractMinutesIso(f.startAt, deskMinutes)
    const onlineAt = subtractMinutesIso(f.startAt, onlineMinutes)
    if (!deskAt || !onlineAt) continue
    const scopeLabel = scope === 'domestic' ? 'nacional' : 'internacional'
    const safeId = f.externalId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80)

    out.push({
      externalId: `airport-arrival-desk-${safeId}`,
      title: `Arribo al aeropuerto ${airport}`,
      startAt: deskAt,
      place: airport,
      importance: 'crucial',
      notes: [
        `Vuelo: ${f.title}`,
        `Alcance: ${scopeLabel}`,
        `Salida: ${f.startAt}`,
        `Mostrador/documentar: estar a más tardar a las ${formatClockEs(deskAt)} (+${deskMinutes} min antes).`,
        `Si ya documentaste en línea: ${formatClockEs(onlineAt)} (+${onlineMinutes} min antes) — no es un segundo evento del itinerario.`,
      ].join('\n'),
      reminderLabel: `Estar en ${airport} para el vuelo ${f.title}`,
    })
  }
  return out
}

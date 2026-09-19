/** Shared flight-schedule types (no fares / booking). */

export type FlightScheduleQuery = {
  origin: string
  destination: string
  date: string
}

export type FlightSchedule = {
  origin: string
  destination: string
  departureAt: string
  arrivalAt: string | null
  carrierCode: string | null
  carrierName: string | null
  flightNumber: string | null
  stops: number
  operatingCarrierCode: string | null
  operatingCarrierName: string | null
  status: string | null
  sourceType: 'flight_schedule'
  sourceUrl: string
  checkedAt: string
  provider: 'aerodatabox'
}

export type FlightScheduleResult = {
  ok: boolean
  provider: 'aerodatabox'
  checkedAt: string
  query: FlightScheduleQuery
  flights: FlightSchedule[]
  error?: string
  httpStatuses?: number[]
  elapsedMs?: number
}

export interface FlightScheduleProvider {
  readonly name: string
  searchSchedules(
    query: FlightScheduleQuery,
    opts?: { signal?: AbortSignal },
  ): Promise<FlightScheduleResult>
}

/** Convert AeroDataBox local time "YYYY-MM-DD HH:mm±HH:mm" → ISO with T. */
export function toIsoOffsetLocal(raw: string): string | null {
  const s = raw.trim()
  // already ISO-ish
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s
  const m = s.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?([+-]\d{2}:\d{2}|Z)$/i,
  )
  if (!m) return null
  const sec = m[4] ?? '00'
  return `${m[1]}T${m[2]}:${m[3]}:${sec}${m[5]}`
}

export const PUBLISHED_SCHEDULE_NOTE =
  'HORARIO PUBLICADO — verifica disponibilidad y reserva directamente con la aerolínea. No implica asientos ni tarifa.'

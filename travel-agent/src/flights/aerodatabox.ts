import type {
  FlightSchedule,
  FlightScheduleProvider,
  FlightScheduleQuery,
  FlightScheduleResult,
} from './types.ts'
import { toIsoOffsetLocal } from './types.ts'

const RAPIDAPI_HOST = 'aerodatabox.p.rapidapi.com'
const RAPIDAPI_BASE = `https://${RAPIDAPI_HOST}`

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function scheduledAt(movement: unknown): string | null {
  const m = asRec(movement)
  if (!m) return null
  const flat =
    str(m.scheduledTimeLocal) ??
    str(m.revisedTimeLocal) ??
    str(m.predictedTimeLocal) ??
    str(m.scheduledTimeUtc)
  if (flat) return toIsoOffsetLocal(flat) ?? flat
  for (const key of ['scheduledTime', 'revisedTime', 'predictedTime', 'actualTime']) {
    const nested = asRec(m[key])
    if (nested) {
      const v = str(nested.local) ?? str(nested.utc)
      if (v) return toIsoOffsetLocal(v) ?? v
    }
  }
  return null
}

function iataOf(movement: unknown): string | null {
  const m = asRec(movement)
  const ap = asRec(m?.airport)
  return str(ap?.iata) ?? str(ap?.iataCode)
}

function dayWindows(date: string): Array<{ from: string; to: string }> {
  return [
    { from: `${date}T00:00`, to: `${date}T12:00` },
    { from: `${date}T12:00`, to: `${date}T23:59` },
  ]
}

function normalizeFlightNumber(
  number: string | null,
  carrierCode: string | null,
): string | null {
  if (!number) return null
  const compact = number.replace(/\s+/g, '').toUpperCase()
  if (carrierCode && !compact.startsWith(carrierCode.toUpperCase())) {
    return `${carrierCode.toUpperCase()}${compact}`
  }
  return compact
}

function provenanceUrl(q: FlightScheduleQuery, flightNumber: string | null): string {
  const fn = encodeURIComponent(flightNumber ?? 'unknown')
  return `https://aerodatabox.com/?origin=${encodeURIComponent(q.origin)}&destination=${encodeURIComponent(q.destination)}&date=${encodeURIComponent(q.date)}&flight=${fn}`
}

export type AeroDataBoxEnv = {
  rapidApiKey?: string
  apiKey?: string
  baseUrl?: string
}

export class AeroDataBoxScheduleProvider implements FlightScheduleProvider {
  readonly name = 'aerodatabox'

  constructor(private readonly env: AeroDataBoxEnv = {}) {}

  async searchSchedules(
    query: FlightScheduleQuery,
    opts?: { signal?: AbortSignal },
  ): Promise<FlightScheduleResult> {
    const checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')
    const origin = query.origin.trim().toUpperCase()
    const destination = query.destination.trim().toUpperCase()
    const date = query.date.trim()
    const q: FlightScheduleQuery = { origin, destination, date }

    if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) {
      return {
        ok: false,
        provider: 'aerodatabox',
        checkedAt,
        query: q,
        flights: [],
        error: 'origin and destination must be IATA codes',
      }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return {
        ok: false,
        provider: 'aerodatabox',
        checkedAt,
        query: q,
        flights: [],
        error: 'date must be YYYY-MM-DD',
      }
    }

    const rapid = (this.env.rapidApiKey ?? process.env.AERODATABOX_RAPIDAPI_KEY ?? '').trim()
    const direct = (this.env.apiKey ?? process.env.AERODATABOX_API_KEY ?? '').trim()
    if (!rapid && !direct) {
      return {
        ok: false,
        provider: 'aerodatabox',
        checkedAt,
        query: q,
        flights: [],
        error: 'AERODATABOX_RAPIDAPI_KEY missing',
      }
    }

    const httpStatuses: number[] = []
    let elapsedMs = 0
    const rows: unknown[] = []
    const errors: string[] = []

    for (const w of dayWindows(date)) {
      const path = `/flights/airports/iata/${encodeURIComponent(origin)}/${encodeURIComponent(w.from)}/${encodeURIComponent(w.to)}`
      const qs = new URLSearchParams({
        withLeg: 'true',
        direction: 'Departure',
        withCancelled: 'true',
        withCodeshared: 'true',
        withCargo: 'false',
        withPrivate: 'false',
      })
      const url = rapid
        ? `${RAPIDAPI_BASE}${path}?${qs}`
        : `${(this.env.baseUrl ?? process.env.AERODATABOX_BASE_URL ?? 'https://api.aerodatabox.com').replace(/\/$/, '')}${path}?${qs}`
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (rapid) {
        headers['x-rapidapi-key'] = rapid
        headers['x-rapidapi-host'] = RAPIDAPI_HOST
      } else {
        headers['X-API-KEY'] = direct
      }

      const t0 = performance.now()
      try {
        const res = await fetch(url, { method: 'GET', headers, signal: opts?.signal })
        elapsedMs += Math.round(performance.now() - t0)
        httpStatuses.push(res.status)
        const text = await res.text()
        let json: unknown = null
        try {
          json = text ? JSON.parse(text) : null
        } catch {
          errors.push(`malformed JSON (${w.from})`)
          continue
        }
        if (res.status >= 400) {
          const msg =
            str(asRec(json)?.message) ??
            text.slice(0, 200) ??
            `HTTP ${res.status}`
          errors.push(msg)
          continue
        }
        const root = asRec(json)
        const deps = Array.isArray(root?.departures) ? root!.departures : []
        rows.push(...deps)
      } catch (e) {
        elapsedMs += Math.round(performance.now() - t0)
        const msg = e instanceof Error ? e.message : String(e)
        errors.push(msg)
        httpStatuses.push(0)
      }
    }

    const flights: FlightSchedule[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      const r = asRec(row) ?? {}
      const departure = r.departure
      const arrival = r.arrival
      const dest = iataOf(arrival)
      if (dest !== destination) continue
      const airline = asRec(r.airline)
      const carrierCode = str(airline?.iata)?.toUpperCase() ?? null
      const carrierName = str(airline?.name)
      const number = str(r.number)
      const flightNumber = normalizeFlightNumber(number, carrierCode)
      const departureAt = scheduledAt(departure)
      if (!departureAt) continue
      const arrivalAt = scheduledAt(arrival)
      const dedupe = `${flightNumber}|${departureAt}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      const op = asRec(r.operatingAirline)
      flights.push({
        origin,
        destination,
        departureAt,
        arrivalAt,
        carrierCode,
        carrierName,
        flightNumber,
        stops: 0,
        operatingCarrierCode: str(op?.iata)?.toUpperCase() ?? null,
        operatingCarrierName: str(op?.name),
        status: str(r.status),
        sourceType: 'flight_schedule',
        sourceUrl: provenanceUrl(q, flightNumber),
        checkedAt,
        provider: 'aerodatabox',
      })
    }

    flights.sort((a, b) => a.departureAt.localeCompare(b.departureAt))

    const ok = httpStatuses.some((s) => s === 200) || flights.length > 0
    return {
      ok: ok && errors.length === 0 ? true : flights.length > 0,
      provider: 'aerodatabox',
      checkedAt,
      query: q,
      flights,
      error: flights.length === 0 && errors.length ? errors.join('; ') : undefined,
      httpStatuses,
      elapsedMs,
    }
  }
}

export function createDefaultScheduleProvider(): FlightScheduleProvider {
  return new AeroDataBoxScheduleProvider()
}

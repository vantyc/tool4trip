import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import { wrapUntrustedToolPayload } from './registry.ts'
import {
  AeroDataBoxScheduleProvider,
  createDefaultScheduleProvider,
} from '../flights/aerodatabox.ts'
import type { FlightScheduleProvider } from '../flights/types.ts'
import { PUBLISHED_SCHEDULE_NOTE } from '../flights/types.ts'

export type SearchFlightSchedulesOpts = {
  provider?: FlightScheduleProvider
  signal?: AbortSignal
}

/**
 * searchFlightSchedules — published schedules only (NOT fares/availability/booking).
 */
export async function searchFlightSchedules(
  args: Record<string, unknown>,
  opts: SearchFlightSchedulesOpts = {},
): Promise<{ contentForModel: string; trace: ToolTraceEntry }> {
  const checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')
  const origin = typeof args.origin === 'string' ? args.origin.trim().toUpperCase() : ''
  const destination =
    typeof args.destination === 'string'
      ? args.destination.trim().toUpperCase()
      : ''
  const date = typeof args.date === 'string' ? args.date.trim() : ''

  if (!origin || !destination || !date) {
    const trace: ToolTraceEntry = {
      tool: 'searchFlightSchedules',
      args: { origin, destination, date },
      ok: false,
      sources: [],
      error: 'origin, destination, and date are required',
      checkedAt,
    }
    return {
      trace,
      contentForModel: wrapUntrustedToolPayload('searchFlightSchedules', {
        error: trace.error,
        notice: PUBLISHED_SCHEDULE_NOTE,
        flights: [],
      }),
    }
  }

  const provider = opts.provider ?? createDefaultScheduleProvider()
  const result = await provider.searchSchedules(
    { origin, destination, date },
    { signal: opts.signal },
  )

  const sources = result.flights.map((f) => ({
    url: f.sourceUrl,
    title: `${f.carrierCode ?? ''} ${f.flightNumber ?? ''} ${f.origin}→${f.destination}`.trim(),
    snippet: `dep ${f.departureAt}${f.arrivalAt ? ` arr ${f.arrivalAt}` : ''} · published schedule only`,
  }))

  const trace: ToolTraceEntry = {
    tool: 'searchFlightSchedules',
    args: {
      origin,
      destination,
      date,
      provider: result.provider,
      flights: result.flights.map((f) => ({
        origin: f.origin,
        destination: f.destination,
        departureAt: f.departureAt,
        arrivalAt: f.arrivalAt,
        carrierCode: f.carrierCode,
        carrierName: f.carrierName,
        flightNumber: f.flightNumber,
        sourceUrl: f.sourceUrl,
        checkedAt: f.checkedAt,
      })),
    },
    ok: result.ok || result.flights.length > 0,
    sources,
    error: result.error,
    checkedAt: result.checkedAt,
  }

  return {
    trace,
    contentForModel: wrapUntrustedToolPayload('searchFlightSchedules', {
      notice: PUBLISHED_SCHEDULE_NOTE,
      semantics:
        'These are published flight schedules only. Do NOT treat as seat availability, fare, or booking confirmation. Prefer verificationStatus=estimated and sourceType=flight_schedule. Include notes with the HORARIO PUBLICADO warning. Map departureAt→startAt, arrivalAt→endAt, carrierName/carrierCode→provider.',
      provider: result.provider,
      checkedAt: result.checkedAt,
      query: result.query,
      flights: result.flights,
      httpStatuses: result.httpStatuses,
      elapsedMs: result.elapsedMs,
      error: result.error,
    }),
  }
}

export { AeroDataBoxScheduleProvider }

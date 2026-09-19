import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import { PUBLISHED_SCHEDULE_NOTE } from './types.ts'

type Rec = Record<string, unknown>

function asRec(v: unknown): Rec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

type TraceSchedule = {
  origin: string
  destination: string
  departureAt: string
  arrivalAt: string | null
  carrierCode: string | null
  carrierName: string | null
  flightNumber: string | null
  sourceUrl: string
  checkedAt: string
}

function parseSchedulesFromTrace(toolTrace: ToolTraceEntry[]): TraceSchedule[] {
  const out: TraceSchedule[] = []
  for (const t of toolTrace) {
    if (t.tool !== 'searchFlightSchedules' || !t.ok) continue
    const rawFlights = t.args?.flights
    if (Array.isArray(rawFlights) && rawFlights.length) {
      for (const row of rawFlights) {
        const f = asRec(row)
        const departureAt = str(f.departureAt)
        const origin = str(f.origin).toUpperCase()
        const destination = str(f.destination).toUpperCase()
        if (!origin || !destination || !/T\d{2}:\d{2}/.test(departureAt)) continue
        out.push({
          origin,
          destination,
          departureAt,
          arrivalAt:
            str(f.arrivalAt) && /T\d{2}:\d{2}/.test(str(f.arrivalAt))
              ? str(f.arrivalAt)
              : null,
          carrierCode: str(f.carrierCode) || null,
          carrierName: str(f.carrierName) || null,
          flightNumber: str(f.flightNumber) || null,
          sourceUrl:
            str(f.sourceUrl) ||
            `https://aerodatabox.com/?origin=${origin}&destination=${destination}`,
          checkedAt: str(f.checkedAt) || str(t.checkedAt) || new Date().toISOString(),
        })
      }
      continue
    }
    for (const s of t.sources ?? []) {
      const url = str(s.url)
      const title = str(s.title)
      const snippet = str(s.snippet)
      const depM = snippet.match(/dep\s+(\S+)/i)
      const arrM = snippet.match(/arr\s+(\S+)/i)
      const departureAt = depM?.[1] ?? ''
      if (!departureAt || !/T\d{2}:\d{2}/.test(departureAt)) continue
      const origin =
        str(t.args?.origin) ||
        url.match(/origin=([A-Z]{3})/i)?.[1]?.toUpperCase() ||
        ''
      const destination =
        str(t.args?.destination) ||
        url.match(/destination=([A-Z]{3})/i)?.[1]?.toUpperCase() ||
        ''
      if (!origin || !destination) continue
      const fnFromTitle = title.match(/\b([A-Z0-9]{2}\s?\d{1,4})\b/i)?.[1]
      const carrierCode =
        title.match(/\b([A-Z]{2})\b/)?.[1]?.toUpperCase() ??
        fnFromTitle?.replace(/\d.*/, '').toUpperCase() ??
        null
      out.push({
        origin,
        destination,
        departureAt,
        arrivalAt: arrM?.[1] && /T\d{2}:\d{2}/.test(arrM[1]) ? arrM[1] : null,
        carrierCode,
        carrierName: null,
        flightNumber: fnFromTitle?.replace(/\s+/g, '') ?? null,
        sourceUrl:
          url ||
          `https://aerodatabox.com/?origin=${origin}&destination=${destination}`,
        checkedAt: str(t.checkedAt) || new Date().toISOString(),
      })
    }
  }
  return out
}

function routeMatches(opt: Rec, origin: string, destination: string): boolean {
  const o = str(opt.origin).toUpperCase()
  const d = str(opt.destination).toUpperCase()
  return o.includes(origin) && d.includes(destination)
}

/**
 * Merge published schedules from searchFlightSchedules into flight options.
 * Does NOT invent clocks — only copies toolTrace evidence.
 * Caps at 3 outbound options per route to avoid package bloat.
 */
export function mergePublishedSchedulesFromTrace(
  pkgIn: unknown,
  toolTrace: ToolTraceEntry[],
): { package: Rec; warnings: string[] } {
  const warnings: string[] = []
  const pkg = { ...asRec(pkgIn) }
  const schedules = parseSchedulesFromTrace(toolTrace)
  if (!schedules.length) return { package: pkg, warnings }

  const options = Array.isArray(pkg.travelOptions)
    ? [...(pkg.travelOptions as unknown[])]
    : []

  const byRoute = new Map<string, TraceSchedule[]>()
  for (const s of schedules) {
    const key = `${s.origin}|${s.destination}`
    const list = byRoute.get(key) ?? []
    list.push(s)
    byRoute.set(key, list)
  }

  for (const [key, list] of byRoute) {
    const [origin, destination] = key.split('|') as [string, string]
    const picked = list.slice(0, 3)
    let matched = 0
    for (let i = 0; i < options.length && matched < picked.length; i++) {
      const o = asRec(options[i])
      if (str(o.type) !== 'flight') continue
      if (!routeMatches(o, origin, destination)) continue
      const hasClock = /T\d{2}:\d{2}/.test(str(o.startAt))
      if (hasClock && str(o.sourceType) === 'flight_schedule') {
        matched++
        continue
      }
      if (hasClock && str(o.verificationStatus) === 'verified') {
        matched++
        continue
      }
      const s = picked[matched]!
      const provider =
        s.carrierName || s.carrierCode || str(o.provider) || 'aerolínea'
      const flightLabel = s.flightNumber
        ? `${s.flightNumber}`
        : `${origin}→${destination}`
      options[i] = {
        ...o,
        title: str(o.title) || `${origin} → ${destination} ${flightLabel}`,
        provider,
        origin: str(o.origin) || `${origin}`,
        destination: str(o.destination) || `${destination}`,
        startAt: s.departureAt,
        ...(s.arrivalAt ? { endAt: s.arrivalAt } : {}),
        sourceUrl: s.sourceUrl,
        checkedAt: s.checkedAt,
        verificationStatus: 'estimated',
        sourceType: 'flight_schedule',
        notes: [str(o.notes), PUBLISHED_SCHEDULE_NOTE].filter(Boolean).join(' '),
        status: str(o.status) === 'researched' ? 'researched' : 'shortlisted',
      }
      matched++
    }

    while (matched < Math.min(picked.length, 3)) {
      const s = picked[matched]!
      const provider = s.carrierName || s.carrierCode || 'aerolínea'
      const flightLabel = s.flightNumber ?? `${origin}${destination}`
      options.push({
        externalId:
          `flt-sched-${origin}-${destination}-${matched + 1}`.toLowerCase(),
        type: 'flight',
        status: matched === 0 ? 'shortlisted' : 'researched',
        title: `${origin} → ${destination} ${flightLabel}`,
        provider,
        origin,
        destination,
        startAt: s.departureAt,
        ...(s.arrivalAt ? { endAt: s.arrivalAt } : {}),
        sourceUrl: s.sourceUrl,
        checkedAt: s.checkedAt,
        verificationStatus: 'estimated',
        sourceType: 'flight_schedule',
        notes: PUBLISHED_SCHEDULE_NOTE,
      })
      matched++
    }
  }

  pkg.travelOptions = options
  warnings.push(
    `server: ${schedules.length} horario(s) publicado(s) desde searchFlightSchedules integrados (no implican disponibilidad ni tarifa).`,
  )
  return { package: pkg, warnings }
}

export function hasSearchFlightSchedulesAttempt(
  toolTrace: ToolTraceEntry[],
): boolean {
  return toolTrace.some((t) => t.tool === 'searchFlightSchedules')
}

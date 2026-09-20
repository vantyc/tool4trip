import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import type { TripContextSnapshot } from '../../shared/agentContracts.ts'
import { PUBLISHED_SCHEDULE_NOTE } from './types.ts'

type Rec = Record<string, unknown>

function asRec(v: unknown): Rec {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export type TraceSchedule = {
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

export function parseSchedulesFromTrace(
  toolTrace: ToolTraceEntry[],
): TraceSchedule[] {
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
          checkedAt:
            str(f.checkedAt) || str(t.checkedAt) || new Date().toISOString(),
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

/** Normalize ISO clock to minute precision for matching. */
export function scheduleClockKey(iso: string): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/)
  return m ? `${m[1]}T${m[2]}:${m[3]}` : iso.trim()
}

/**
 * True when a package flight option is backed by a published schedule in toolTrace
 * (route + departure clock). Fabricated clocks/routes that are absent from
 * searchFlightSchedules do not match.
 */
export function optionMatchesPublishedSchedule(
  opt: Rec,
  schedules: TraceSchedule[],
): TraceSchedule | null {
  if (str(opt.type) !== 'flight') return null
  const startAt = str(opt.startAt)
  if (!/T\d{2}:\d{2}/.test(startAt)) return null
  const startKey = scheduleClockKey(startAt)
  const originBlob = str(opt.origin).toUpperCase()
  const destBlob = str(opt.destination).toUpperCase()

  for (const s of schedules) {
    if (scheduleClockKey(s.departureAt) !== startKey) continue
    if (!originBlob.includes(s.origin) || !destBlob.includes(s.destination)) {
      continue
    }
    return s
  }
  return null
}

/**
 * Stamp package flight options that match searchFlightSchedules with
 * flight_schedule provenance (does not invent options or clocks).
 */
export function stampProvenScheduleOptions(
  pkgIn: unknown,
  toolTrace: ToolTraceEntry[],
): { package: Rec; stampedExternalIds: string[] } {
  const pkg = { ...asRec(pkgIn) }
  const schedules = parseSchedulesFromTrace(toolTrace)
  const stampedExternalIds: string[] = []
  if (!schedules.length || !Array.isArray(pkg.travelOptions)) {
    return { package: pkg, stampedExternalIds }
  }
  pkg.travelOptions = (pkg.travelOptions as unknown[]).map((raw) => {
    const o = asRec(raw)
    const match = optionMatchesPublishedSchedule(o, schedules)
    if (!match) return raw
    const externalId = str(o.externalId)
    if (externalId) stampedExternalIds.push(externalId)
    const notes = [str(o.notes), PUBLISHED_SCHEDULE_NOTE]
      .filter(Boolean)
      .join(' ')
    return {
      ...o,
      sourceType: 'flight_schedule',
      verificationStatus:
        str(o.verificationStatus) === 'verified'
          ? 'estimated'
          : str(o.verificationStatus) || 'estimated',
      sourceUrl: str(o.sourceUrl) || match.sourceUrl,
      checkedAt: str(o.checkedAt) || match.checkedAt,
      provider:
        str(o.provider) || match.carrierName || match.carrierCode || undefined,
      endAt: str(o.endAt) || match.arrivalAt || undefined,
      notes,
    }
  })
  return { package: pkg, stampedExternalIds }
}

/**
 * Register schedule-proven package travelOptions into a grounding context so
 * context claims citing their externalId/id resolve — without accepting
 * fabricated flights that lack toolTrace schedule evidence.
 */
export function augmentContextWithProvenFlightSchedules(
  context: TripContextSnapshot | undefined,
  draftPackage: unknown,
  toolTrace: ToolTraceEntry[],
): TripContextSnapshot | undefined {
  if (!context) return context
  const schedules = parseSchedulesFromTrace(toolTrace)
  if (!schedules.length) return context
  const pkg = asRec(draftPackage)
  const packageId = str(pkg.packageId)
  const options = Array.isArray(pkg.travelOptions)
    ? (pkg.travelOptions as unknown[])
    : []
  const extras: Rec[] = []
  const seen = new Set<string>()
  const push = (row: Rec) => {
    const id = str(row.id)
    const ext = str(row.externalId)
    const key = `${id}|${ext}`
    if (seen.has(key)) return
    seen.add(key)
    extras.push(row)
  }

  for (const raw of options) {
    const o = asRec(raw)
    const match = optionMatchesPublishedSchedule(o, schedules)
    if (!match) continue
    const externalId = str(o.externalId)
    if (!externalId) continue
    const base: Rec = {
      ...o,
      id: externalId,
      externalId,
      type: 'flight',
      title: str(o.title) || `${match.origin}→${match.destination}`,
      startAt: str(o.startAt) || match.departureAt,
      endAt: str(o.endAt) || match.arrivalAt || undefined,
      origin: str(o.origin) || match.origin,
      destination: str(o.destination) || match.destination,
      provider:
        str(o.provider) || match.carrierName || match.carrierCode || undefined,
      sourceType: 'flight_schedule',
      verificationStatus: 'estimated',
      sourceUrl: str(o.sourceUrl) || match.sourceUrl,
      checkedAt: str(o.checkedAt) || match.checkedAt,
      notes: [str(o.notes), PUBLISHED_SCHEDULE_NOTE].filter(Boolean).join(' '),
    }
    push(base)
    if (packageId) {
      push({ ...base, id: `opt-${packageId}-${externalId}` })
    }
  }

  if (!extras.length) return context

  // Ask Travel date updates often reuse Dexie externalIds (outbound-flight-1).
  // Prefer schedule-backed package rows over obsolete Dexie clocks for grounding.
  const byExternal = new Map<string, Rec>()
  for (const e of extras) {
    const ext = str(e.externalId)
    if (ext) byExternal.set(ext, e)
  }
  const existing = [...(context.travelOptions ?? [])] as Rec[]
  const replacedExt = new Set<string>()
  const merged: Rec[] = existing.map((row) => {
    const ext = str(asRec(row).externalId)
    const repl = ext ? byExternal.get(ext) : undefined
    if (repl) {
      replacedExt.add(ext)
      return repl
    }
    return row
  })
  for (const e of extras) {
    const ext = str(e.externalId)
    if (ext && replacedExt.has(ext)) continue
    // Avoid duplicating the same id/externalId already present after replace
    const id = str(e.id)
    const already = merged.some((row) => {
      const r = asRec(row)
      return (id && str(r.id) === id) || (ext && str(r.externalId) === ext)
    })
    if (!already) merged.push(e)
  }

  return {
    ...context,
    travelOptions: merged,
  }
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

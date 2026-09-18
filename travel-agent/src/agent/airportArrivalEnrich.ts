import {
  buildAirportArrivalItinerary,
  type FlightLike,
} from '../../shared/airportArrivalPolicy.ts'
import { stripLlmAirportArrivalItems } from './newTravelCoherence.ts'

type Rec = Record<string, unknown>

function asRec(v: unknown): Rec {
  return v && typeof v === 'object' ? (v as Rec) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Merge airport-arrival itinerary items into a TripPackage draft (idempotent by externalId).
 * Does not invent flights — only enriches existing flight options that already have startAt.
 * Strips LLM duplicate airport rows first; emits one arrival per flight.
 */
export function enrichPackageWithAirportArrivals(pkgIn: unknown): Rec {
  const pkg = stripLlmAirportArrivalItems(pkgIn)
  const options = Array.isArray(pkg.travelOptions) ? [...pkg.travelOptions] : []
  const flights: FlightLike[] = []
  for (const o of options) {
    const r = asRec(o)
    if (str(r.type) !== 'flight') continue
    const externalId = str(r.externalId)
    if (!externalId) continue
    flights.push({
      externalId,
      title: str(r.title) || 'Vuelo',
      origin: str(r.origin) || undefined,
      destination: str(r.destination) || undefined,
      startAt: str(r.startAt) || undefined,
    })
  }

  // Drop stale online twin reminders from older server versions.
  const existing = Array.isArray(pkg.itineraryItems)
    ? pkg.itineraryItems.filter((raw) => {
        const id = str(asRec(raw).externalId)
        return !id.startsWith('airport-arrival-online-')
      })
    : []
  const arrivals = buildAirportArrivalItinerary(flights)
  const byId = new Map<string, Rec>()
  for (const item of existing) {
    const r = asRec(item)
    const id = str(r.externalId)
    if (id) byId.set(id, r)
  }
  for (const a of arrivals) {
    byId.set(a.externalId, {
      externalId: a.externalId,
      title: a.title,
      startAt: a.startAt,
      place: a.place,
      importance: a.importance,
      notes: a.notes,
    })
  }
  pkg.itineraryItems = [...byId.values()]

  // Checklist nudges (idempotent)
  const checklist = Array.isArray(pkg.checklistItems)
    ? [...pkg.checklistItems]
    : []
  const cIds = new Set(
    checklist.map((c) => str(asRec(c).externalId)).filter(Boolean),
  )
  for (const f of flights) {
    if (!f.startAt) continue
    const id = `chk-airport-${f.externalId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80)}`
    if (cIds.has(id)) continue
    checklist.push({
      externalId: id,
      label: `Confirmar documentacion / boarding pass — ${f.title}`,
      sortOrder: checklist.length,
    })
    cIds.add(id)
  }
  pkg.checklistItems = checklist
  return pkg
}

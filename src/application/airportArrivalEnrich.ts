import {
  buildAirportArrivalItinerary,
  type FlightLike,
} from '../../shared/airportArrivalPolicy'
import type { TripPackageV1 } from './tripPackage'

/**
 * Ensure airport-arrival itinerary (+ checklist) items exist for flight options.
 * Idempotent by externalId. Safe to run before validate/import.
 */
export function enrichTripPackageAirportArrivals(
  pkg: TripPackageV1,
): TripPackageV1 {
  const flights: FlightLike[] = pkg.travelOptions
    .filter((o) => o.type === 'flight')
    .map((o) => ({
      externalId: o.externalId,
      title: o.title,
      origin: o.origin,
      destination: o.destination,
      startAt: o.startAt,
    }))
  const arrivals = buildAirportArrivalItinerary(flights)
  if (!arrivals.length) return pkg

  const byId = new Map(pkg.itineraryItems.map((i) => [i.externalId, i]))
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

  const checklist = [...pkg.checklistItems]
  const cIds = new Set(checklist.map((c) => c.externalId))
  for (const f of flights) {
    if (!f.startAt) continue
    const id = `chk-airport-${f.externalId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80)}`
    if (cIds.has(id)) continue
    checklist.push({
      externalId: id,
      label: `Confirmar documentación / boarding pass — ${f.title}`,
      sortOrder: checklist.length,
    })
    cIds.add(id)
  }

  return {
    ...pkg,
    itineraryItems: [...byId.values()],
    checklistItems: checklist,
  }
}

export function isAirportArrivalExternalId(externalId: string): boolean {
  return externalId.startsWith('airport-arrival-')
}

import type { Repositories } from '../data/repositories/types'
import type { TripContextSnapshot } from '../../shared/agentContracts'

/** Build a compact Dexie snapshot for travel-agent (no document blobs). */
export async function buildTripContextSnapshot(
  repos: Repositories,
  tripId: string,
): Promise<TripContextSnapshot> {
  const trip = await repos.trips.getById(tripId)
  if (!trip) {
    throw new Error(`Viaje no encontrado: ${tripId}`)
  }

  const [
    bookings,
    travelOptions,
    itineraryItems,
    checklistItems,
    notes,
    packageImports,
  ] = await Promise.all([
    repos.bookings.listByTrip(tripId),
    repos.travelOptions.listByTrip(tripId),
    repos.itineraryItems.listByTrip(tripId),
    repos.checklist.listByTrip(tripId),
    repos.notes.listByTrip(tripId),
    repos.packageImports.listByTrip(tripId),
  ])

  return {
    trip: { ...trip },
    bookings: bookings.map((b) => ({ ...b })),
    travelOptions: travelOptions.map((o) => ({ ...o })),
    itineraryItems: itineraryItems.map((i) => ({ ...i })),
    checklistItems: checklistItems.map((c) => ({ ...c })),
    notes: notes.map((n) => ({
      id: n.id,
      tripId: n.tripId,
      title: n.title,
      body: n.body.length > 2000 ? `${n.body.slice(0, 2000)}…` : n.body,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    })),
    packageImports: packageImports.map((p) => ({ ...p })),
  }
}

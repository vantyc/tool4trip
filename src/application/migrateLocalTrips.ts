import { db } from '../data/db'
import {
  apiMigrateTrips,
  type TripMigrateBundle,
} from '../data/repositories/httpRepositories'

/**
 * One-shot: read Dexie trips on this device and POST bulk upsert to trip-api.
 * Documents stay local (v1 has no cloud blobs).
 */
export async function migrateLocalTripsToCloud(): Promise<{
  count: number
  tripIds: string[]
}> {
  const trips = await db.trips.toArray()
  if (trips.length === 0) {
    return { count: 0, tripIds: [] }
  }

  const bundles: TripMigrateBundle[] = []
  for (const trip of trips) {
    const [
      bookings,
      travelOptions,
      itineraryItems,
      reminders,
      checklistItems,
      notes,
      packageImports,
    ] = await Promise.all([
      db.bookings.where('tripId').equals(trip.id).toArray(),
      db.travelOptions.where('tripId').equals(trip.id).toArray(),
      db.itineraryItems.where('tripId').equals(trip.id).toArray(),
      db.reminders.where('tripId').equals(trip.id).toArray(),
      db.checklistItems.where('tripId').equals(trip.id).toArray(),
      db.notes.where('tripId').equals(trip.id).toArray(),
      db.packageImports.where('tripId').equals(trip.id).toArray(),
    ])
    bundles.push({
      trip,
      bookings,
      travelOptions,
      itineraryItems,
      reminders,
      checklistItems,
      notes,
      packageImports,
    })
  }

  const result = await apiMigrateTrips(bundles)
  return { count: result.count, tripIds: result.tripIds }
}

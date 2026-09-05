import type { Repositories } from '../data/repositories/types'
import { resolveItineraryItems } from '../domain/resolveItinerary'
import { buildTripSummary, type TripSummary } from './summary'

export function createSummaryService(repos: Repositories) {
  return {
    getTripSummary: async (
      tripId: string,
      now: Date = new Date(),
    ): Promise<TripSummary | null> => {
      const trip = await repos.trips.getById(tripId)
      if (!trip) return null

      const [items, bookings, checklist, reminders] = await Promise.all([
        repos.itineraryItems.listByTrip(tripId),
        repos.bookings.listByTrip(tripId),
        repos.checklist.listByTrip(tripId),
        repos.reminders.listByTrip(tripId),
      ])

      const resolvedItems = resolveItineraryItems(items, bookings)
      return buildTripSummary({
        resolvedItems,
        checklist,
        reminders,
        tripTimeZone: trip.timezone,
        now,
      })
    },
  }
}

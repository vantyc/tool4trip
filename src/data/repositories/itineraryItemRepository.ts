import type { ItineraryItem } from '../../domain/types'
import { db } from '../db'
import type { ItineraryItemRepository } from './types'

export const dexieItineraryItemRepository: ItineraryItemRepository = {
  listByTrip: (tripId) =>
    db.itineraryItems.where('tripId').equals(tripId).toArray(),
  getById: (id) => db.itineraryItems.get(id),
  put: (item: ItineraryItem) =>
    db.itineraryItems.put(item).then(() => undefined),
  delete: (id) => db.itineraryItems.delete(id),
}

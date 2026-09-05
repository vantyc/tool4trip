import type { Trip } from '../../domain/types'
import { db } from '../db'
import type { TripRepository } from './types'

export const dexieTripRepository: TripRepository = {
  getAll: () => db.trips.toArray(),
  getById: (id) => db.trips.get(id),
  put: (trip: Trip) => db.trips.put(trip).then(() => undefined),
  delete: (id) => db.trips.delete(id),
}

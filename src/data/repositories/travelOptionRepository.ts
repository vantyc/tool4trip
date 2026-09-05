import type { TravelOption } from '../../domain/types'
import { db } from '../db'
import type { TravelOptionRepository } from './types'

export const dexieTravelOptionRepository: TravelOptionRepository = {
  listByTrip: (tripId) =>
    db.travelOptions.where('tripId').equals(tripId).toArray(),
  getById: (id) => db.travelOptions.get(id),
  getByPackageId: (packageId) =>
    db.travelOptions.where('packageId').equals(packageId).toArray(),
  put: (option: TravelOption) =>
    db.travelOptions.put(option).then(() => undefined),
  delete: (id) => db.travelOptions.delete(id),
}

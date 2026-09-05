import type { ChecklistItem } from '../../domain/types'
import { db } from '../db'
import type { ChecklistRepository } from './types'

export const dexieChecklistRepository: ChecklistRepository = {
  listByTrip: (tripId) =>
    db.checklistItems.where('tripId').equals(tripId).toArray(),
  getById: (id) => db.checklistItems.get(id),
  put: (item: ChecklistItem) =>
    db.checklistItems.put(item).then(() => undefined),
  delete: (id) => db.checklistItems.delete(id),
}

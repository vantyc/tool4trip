import type { Reminder } from '../../domain/types'
import { db } from '../db'
import type { ReminderRepository } from './types'

export const dexieReminderRepository: ReminderRepository = {
  listByTrip: (tripId) => db.reminders.where('tripId').equals(tripId).toArray(),
  listByItineraryItem: (itineraryItemId) =>
    db.reminders.where('itineraryItemId').equals(itineraryItemId).toArray(),
  getById: (id) => db.reminders.get(id),
  put: (reminder: Reminder) => db.reminders.put(reminder).then(() => undefined),
  delete: (id) => db.reminders.delete(id),
}

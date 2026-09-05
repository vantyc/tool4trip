import { dexieBookingRepository } from './bookingRepository'
import { dexieChecklistRepository } from './checklistRepository'
import { dexieDocumentRepository } from './documentRepository'
import { dexieItineraryItemRepository } from './itineraryItemRepository'
import { dexieNoteRepository } from './noteRepository'
import { dexiePackageImportRepository } from './packageImportRepository'
import { dexieReminderRepository } from './reminderRepository'
import { dexieTravelOptionRepository } from './travelOptionRepository'
import { dexieTripRepository } from './tripRepository'
import type { Repositories } from './types'

/** Local Dexie-backed repositories. Swap later for cloud implementations. */
export const localRepositories: Repositories = {
  trips: dexieTripRepository,
  bookings: dexieBookingRepository,
  itineraryItems: dexieItineraryItemRepository,
  reminders: dexieReminderRepository,
  documents: dexieDocumentRepository,
  checklist: dexieChecklistRepository,
  notes: dexieNoteRepository,
  travelOptions: dexieTravelOptionRepository,
  packageImports: dexiePackageImportRepository,
}

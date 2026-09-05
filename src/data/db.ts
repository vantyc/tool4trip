import Dexie, { type EntityTable } from 'dexie'
import type {
  Booking,
  ChecklistItem,
  DocumentBlobRecord,
  DocumentMeta,
  ItineraryItem,
  Note,
  Reminder,
  Trip,
} from '../domain/types'

/**
 * Local IndexedDB database.
 *
 * IMPORTANT:
 * - Name `viajes_db` is stable across app updates.
 * - Service worker updates must NEVER call delete()/clear() on this DB.
 * - Schema changes go through Dexie `.version(n)` migrations only.
 */
export class ViajesDatabase extends Dexie {
  trips!: EntityTable<Trip, 'id'>
  bookings!: EntityTable<Booking, 'id'>
  itineraryItems!: EntityTable<ItineraryItem, 'id'>
  reminders!: EntityTable<Reminder, 'id'>
  documents!: EntityTable<DocumentMeta, 'id'>
  documentBlobs!: EntityTable<DocumentBlobRecord, 'id'>
  checklistItems!: EntityTable<ChecklistItem, 'id'>
  notes!: EntityTable<Note, 'id'>

  constructor() {
    super('viajes_db')

    // v1 — initial MVP schema. Bump version + add upgrade() for future changes.
    this.version(1).stores({
      trips: 'id, status, startDate, updatedAt',
      bookings: 'id, tripId, type, status, startAt, [tripId+startAt]',
      // No startAt index: linked items resolve schedule from Booking in memory.
      itineraryItems: 'id, tripId, bookingId, importance',
      reminders: 'id, tripId, itineraryItemId',
      documents: 'id, tripId, bookingId, itineraryItemId, type, [tripId+type]',
      documentBlobs: 'id, tripId',
      checklistItems: 'id, tripId, status, sortOrder, [tripId+status]',
      notes: 'id, tripId, updatedAt',
    })
  }
}

export const db = new ViajesDatabase()

/** DB identity used in PWA docs/tests — must stay stable. */
export const IDB_DATABASE_NAME = 'viajes_db'
export const IDB_SCHEMA_VERSION = 1

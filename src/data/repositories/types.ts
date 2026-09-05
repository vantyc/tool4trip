import type {
  Booking,
  ChecklistItem,
  DocumentBlobRecord,
  DocumentMeta,
  ItineraryItem,
  Note,
  PackageImport,
  Reminder,
  TravelOption,
  Trip,
} from '../../domain/types'

export interface TripRepository {
  getAll(): Promise<Trip[]>
  getById(id: string): Promise<Trip | undefined>
  put(trip: Trip): Promise<void>
  delete(id: string): Promise<void>
}

export interface BookingRepository {
  listByTrip(tripId: string): Promise<Booking[]>
  getById(id: string): Promise<Booking | undefined>
  put(booking: Booking): Promise<void>
  delete(id: string): Promise<void>
}

export interface ItineraryItemRepository {
  listByTrip(tripId: string): Promise<ItineraryItem[]>
  getById(id: string): Promise<ItineraryItem | undefined>
  put(item: ItineraryItem): Promise<void>
  delete(id: string): Promise<void>
}

export interface ReminderRepository {
  listByTrip(tripId: string): Promise<Reminder[]>
  listByItineraryItem(itineraryItemId: string): Promise<Reminder[]>
  getById(id: string): Promise<Reminder | undefined>
  put(reminder: Reminder): Promise<void>
  delete(id: string): Promise<void>
}

export interface DocumentRepository {
  listByTrip(tripId: string): Promise<DocumentMeta[]>
  listByBooking(bookingId: string): Promise<DocumentMeta[]>
  listByItineraryItem(itineraryItemId: string): Promise<DocumentMeta[]>
  getById(id: string): Promise<DocumentMeta | undefined>
  put(meta: DocumentMeta, blob: Blob): Promise<void>
  /** Update metadata only; leave blob unchanged. */
  putMeta(meta: DocumentMeta): Promise<void>
  getBlob(id: string): Promise<DocumentBlobRecord | undefined>
  delete(id: string): Promise<void>
}

export interface ChecklistRepository {
  listByTrip(tripId: string): Promise<ChecklistItem[]>
  getById(id: string): Promise<ChecklistItem | undefined>
  put(item: ChecklistItem): Promise<void>
  delete(id: string): Promise<void>
}

export interface NoteRepository {
  listByTrip(tripId: string): Promise<Note[]>
  getById(id: string): Promise<Note | undefined>
  put(note: Note): Promise<void>
  delete(id: string): Promise<void>
}

export interface TravelOptionRepository {
  listByTrip(tripId: string): Promise<TravelOption[]>
  getById(id: string): Promise<TravelOption | undefined>
  getByPackageId(packageId: string): Promise<TravelOption[]>
  put(option: TravelOption): Promise<void>
  delete(id: string): Promise<void>
}

export interface PackageImportRepository {
  getById(id: string): Promise<PackageImport | undefined>
  listByTrip(tripId: string): Promise<PackageImport[]>
  put(record: PackageImport): Promise<void>
  delete(id: string): Promise<void>
}

export interface Repositories {
  trips: TripRepository
  bookings: BookingRepository
  itineraryItems: ItineraryItemRepository
  reminders: ReminderRepository
  documents: DocumentRepository
  checklist: ChecklistRepository
  notes: NoteRepository
  travelOptions: TravelOptionRepository
  packageImports: PackageImportRepository
}

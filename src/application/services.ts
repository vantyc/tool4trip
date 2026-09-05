import type { Repositories } from '../data/repositories/types'
import type {
  Booking,
  ChecklistItem,
  DocumentMeta,
  DocumentType,
  ItineraryItem,
  Note,
  Reminder,
  Trip,
} from '../domain/types'
import {
  resolveItineraryItems,
  resolveReminderTriggerAt,
} from '../domain/resolveItinerary'
import {
  assertAttachableFile,
  DocumentValidationError,
  guessDocumentType,
} from './documents'
import { newId, nowIso, touchTimestamps } from './ids'
import { humanStorageError, isQuotaExceededError } from './storageStats'
import { createSummaryService } from './summaryService'

export function createTripService(repos: Repositories) {
  return {
    list: () => repos.trips.getAll(),
    get: (id: string) => repos.trips.getById(id),
    save: async (input: Omit<Trip, 'createdAt' | 'updatedAt' | 'syncStatus'> & Partial<Pick<Trip, 'createdAt' | 'updatedAt' | 'syncStatus'>>) => {
      const existing = input.id ? await repos.trips.getById(input.id) : undefined
      const trip: Trip = {
        ...input,
        goals: input.goals ?? [],
        syncStatus: input.syncStatus ?? existing?.syncStatus ?? 'local',
        ...touchTimestamps(existing),
      }
      await repos.trips.put(trip)
      return trip
    },
    remove: (id: string) => repos.trips.delete(id),
  }
}

export function createBookingService(repos: Repositories) {
  return {
    listByTrip: (tripId: string) => repos.bookings.listByTrip(tripId),
    get: (id: string) => repos.bookings.getById(id),
    save: async (
      input: Omit<Booking, 'createdAt' | 'updatedAt' | 'syncStatus'> &
        Partial<Pick<Booking, 'createdAt' | 'updatedAt' | 'syncStatus'>>,
    ) => {
      const existing = await repos.bookings.getById(input.id)
      const booking: Booking = {
        ...input,
        syncStatus: input.syncStatus ?? existing?.syncStatus ?? 'local',
        ...touchTimestamps(existing),
      }
      await repos.bookings.put(booking)
      return booking
    },
    remove: (id: string) => repos.bookings.delete(id),
  }
}

export function createItineraryService(repos: Repositories) {
  return {
    listByTrip: (tripId: string) => repos.itineraryItems.listByTrip(tripId),
    get: (id: string) => repos.itineraryItems.getById(id),
    /** Resolved + sorted in memory (Booking is source of truth for linked times). */
    listResolvedByTrip: async (tripId: string) => {
      const [items, bookings] = await Promise.all([
        repos.itineraryItems.listByTrip(tripId),
        repos.bookings.listByTrip(tripId),
      ])
      return resolveItineraryItems(items, bookings)
    },
    save: async (
      input: Omit<ItineraryItem, 'createdAt' | 'updatedAt' | 'syncStatus'> &
        Partial<Pick<ItineraryItem, 'createdAt' | 'updatedAt' | 'syncStatus'>>,
    ) => {
      const existing = await repos.itineraryItems.getById(input.id)
      const item: ItineraryItem = {
        ...input,
        goalIds: input.goalIds ?? [],
        syncStatus: input.syncStatus ?? existing?.syncStatus ?? 'local',
        ...touchTimestamps(existing),
      }
      await repos.itineraryItems.put(item)
      return item
    },
    remove: (id: string) => repos.itineraryItems.delete(id),
  }
}

export function createReminderService(repos: Repositories) {
  return {
    listByTrip: (tripId: string) => repos.reminders.listByTrip(tripId),
    listByItem: (itineraryItemId: string) =>
      repos.reminders.listByItineraryItem(itineraryItemId),
    /** Resolve absolute trigger instants for UI (relative ones recompute from schedule). */
    listResolvedByTrip: async (tripId: string) => {
      const [reminders, items, bookings] = await Promise.all([
        repos.reminders.listByTrip(tripId),
        repos.itineraryItems.listByTrip(tripId),
        repos.bookings.listByTrip(tripId),
      ])
      const resolvedItems = resolveItineraryItems(items, bookings)
      const byItemId = new Map(resolvedItems.map((r) => [r.item.id, r]))
      return reminders.map((reminder) => {
        const resolved = byItemId.get(reminder.itineraryItemId)
        return {
          reminder,
          triggerAt: resolved
            ? resolveReminderTriggerAt(reminder, resolved)
            : undefined,
        }
      })
    },
    save: async (
      input: Omit<Reminder, 'createdAt' | 'updatedAt' | 'syncStatus'> &
        Partial<Pick<Reminder, 'createdAt' | 'updatedAt' | 'syncStatus'>>,
    ) => {
      const existing = await repos.reminders.getById(input.id)
      const reminder = {
        ...input,
        syncStatus: input.syncStatus ?? existing?.syncStatus ?? 'local',
        ...touchTimestamps(existing),
      } as Reminder
      await repos.reminders.put(reminder)
      return reminder
    },
    remove: (id: string) => repos.reminders.delete(id),
  }
}

export function createDocumentService(repos: Repositories) {
  return {
    listByTrip: (tripId: string) => repos.documents.listByTrip(tripId),
    listByBooking: (bookingId: string) =>
      repos.documents.listByBooking(bookingId),
    listByItineraryItem: (itineraryItemId: string) =>
      repos.documents.listByItineraryItem(itineraryItemId),
    get: (id: string) => repos.documents.getById(id),
    getBlob: (id: string) => repos.documents.getBlob(id),

    /** Attach a user-selected File (validates type + size). */
    attachFromFile: async (input: {
      tripId: string
      file: File
      type?: DocumentType
      name?: string
      bookingId?: string
      itineraryItemId?: string
      notes?: string
      capturedAt?: string
    }) => {
      const { mimeType } = assertAttachableFile(input.file)
      const id = newId()
      const type = input.type ?? guessDocumentType(mimeType, input.file.name)
      const meta: DocumentMeta = {
        id,
        tripId: input.tripId,
        name: input.name?.trim() || input.file.name,
        type,
        mimeType,
        sizeBytes: input.file.size,
        bookingId: input.bookingId,
        itineraryItemId: input.itineraryItemId,
        notes: input.notes,
        capturedAt: input.capturedAt ?? nowIso(),
        syncStatus: 'local',
        ...touchTimestamps(),
      }
      try {
        await repos.documents.put(meta, input.file)
        return meta
      } catch (err) {
        if (isQuotaExceededError(err)) {
          throw new DocumentValidationError(humanStorageError(err))
        }
        throw err
      }
    },

    save: async (
      metaInput: Omit<
        DocumentMeta,
        'createdAt' | 'updatedAt' | 'syncStatus' | 'sizeBytes' | 'mimeType'
      > &
        Partial<
          Pick<
            DocumentMeta,
            'createdAt' | 'updatedAt' | 'syncStatus' | 'sizeBytes' | 'mimeType'
          >
        >,
      blob: Blob,
    ) => {
      assertAttachableFile({
        name: metaInput.name,
        type: metaInput.mimeType ?? blob.type,
        size: blob.size,
      })
      const existing = await repos.documents.getById(metaInput.id)
      const mimeType =
        metaInput.mimeType ?? (blob.type || 'application/octet-stream')
      const meta: DocumentMeta = {
        ...metaInput,
        mimeType,
        sizeBytes: metaInput.sizeBytes ?? blob.size,
        syncStatus: metaInput.syncStatus ?? existing?.syncStatus ?? 'local',
        ...touchTimestamps(existing),
      }
      try {
        await repos.documents.put(meta, blob)
        return meta
      } catch (err) {
        if (isQuotaExceededError(err)) {
          throw new DocumentValidationError(humanStorageError(err))
        }
        throw err
      }
    },

    /** Update name/type/associations/notes without rewriting the blob. */
    updateMeta: async (
      input: Pick<
        DocumentMeta,
        'id' | 'name' | 'type' | 'notes' | 'bookingId' | 'itineraryItemId'
      > &
        Partial<Pick<DocumentMeta, 'capturedAt'>>,
    ) => {
      const existing = await repos.documents.getById(input.id)
      if (!existing) {
        throw new Error('Documento no encontrado')
      }
      const meta: DocumentMeta = {
        ...existing,
        name: input.name.trim() || existing.name,
        type: input.type,
        notes: input.notes,
        bookingId: input.bookingId || undefined,
        itineraryItemId: input.itineraryItemId || undefined,
        capturedAt: input.capturedAt ?? existing.capturedAt,
        ...touchTimestamps(existing),
      }
      await repos.documents.putMeta(meta)
      return meta
    },

    remove: (id: string) => repos.documents.delete(id),
  }
}

export function createChecklistService(repos: Repositories) {
  return {
    listByTrip: (tripId: string) => repos.checklist.listByTrip(tripId),
    save: async (
      input: Omit<ChecklistItem, 'createdAt' | 'updatedAt' | 'syncStatus'> &
        Partial<Pick<ChecklistItem, 'createdAt' | 'updatedAt' | 'syncStatus'>>,
    ) => {
      const existing = await repos.checklist.getById(input.id)
      const item: ChecklistItem = {
        ...input,
        syncStatus: input.syncStatus ?? existing?.syncStatus ?? 'local',
        ...touchTimestamps(existing),
      }
      await repos.checklist.put(item)
      return item
    },
    remove: (id: string) => repos.checklist.delete(id),
  }
}

export function createNoteService(repos: Repositories) {
  return {
    listByTrip: (tripId: string) => repos.notes.listByTrip(tripId),
    save: async (
      input: Omit<Note, 'createdAt' | 'updatedAt' | 'syncStatus'> &
        Partial<Pick<Note, 'createdAt' | 'updatedAt' | 'syncStatus'>>,
    ) => {
      const existing = await repos.notes.getById(input.id)
      const note: Note = {
        ...input,
        syncStatus: input.syncStatus ?? existing?.syncStatus ?? 'local',
        ...touchTimestamps(existing),
      }
      await repos.notes.put(note)
      return note
    },
    remove: (id: string) => repos.notes.delete(id),
  }
}

export function createServices(repos: Repositories) {
  return {
    trips: createTripService(repos),
    bookings: createBookingService(repos),
    itinerary: createItineraryService(repos),
    reminders: createReminderService(repos),
    documents: createDocumentService(repos),
    checklist: createChecklistService(repos),
    notes: createNoteService(repos),
    summary: createSummaryService(repos),
    newId,
  }
}

export type Services = ReturnType<typeof createServices>

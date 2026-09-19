import type {
  Booking,
  ChecklistItem,
  ItineraryItem,
  Note,
  PackageImport,
  Reminder,
  TravelOption,
  Trip,
} from '../../domain/types'
import { apiFetch } from './apiClient'
import type {
  BookingRepository,
  ChecklistRepository,
  ItineraryItemRepository,
  NoteRepository,
  PackageImportRepository,
  ReminderRepository,
  Repositories,
  TravelOptionRepository,
  TripRepository,
} from './types'
import { dexieDocumentRepository } from './documentRepository'

const httpTripRepository: TripRepository = {
  getAll: () => apiFetch<Trip[]>('/api/trips'),
  getById: async (id) => {
    try {
      return await apiFetch<Trip>(`/api/trips/${encodeURIComponent(id)}`)
    } catch (err) {
      if (err && typeof err === 'object' && 'status' in err && err.status === 404) {
        return undefined
      }
      throw err
    }
  },
  put: async (trip) => {
    const existing = await httpTripRepository.getById(trip.id)
    if (existing) {
      await apiFetch(`/api/trips/${encodeURIComponent(trip.id)}`, {
        method: 'PUT',
        body: JSON.stringify(trip),
        expectUpdatedAt: existing.updatedAt,
      })
    } else {
      await apiFetch('/api/trips', {
        method: 'POST',
        body: JSON.stringify(trip),
      })
    }
  },
  delete: async (id) => {
    await apiFetch(`/api/trips/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
}

function collectionRepo<T extends { id: string; tripId: string; updatedAt?: string }>(
  collection: string,
): {
  listByTrip: (tripId: string) => Promise<T[]>
  getById: (id: string) => Promise<T | undefined>
  put: (row: T) => Promise<void>
  delete: (id: string) => Promise<void>
} {
  return {
    listByTrip: (tripId) =>
      apiFetch<T[]>(
        `/api/trips/${encodeURIComponent(tripId)}/${collection}`,
      ),
    getById: async (id) => {
      try {
        return await apiFetch<T>(`/api/${collection}/${encodeURIComponent(id)}`)
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          'status' in err &&
          err.status === 404
        ) {
          return undefined
        }
        throw err
      }
    },
    put: async (row) => {
      await apiFetch(
        `/api/trips/${encodeURIComponent(row.tripId)}/${collection}/${encodeURIComponent(row.id)}`,
        {
          method: 'PUT',
          body: JSON.stringify(row),
        },
      )
    },
    delete: async (id) => {
      await apiFetch(`/api/${collection}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
    },
  }
}

const bookings = collectionRepo<Booking>('bookings')
const itineraryItems = collectionRepo<ItineraryItem>('itinerary-items')
const checklist = collectionRepo<ChecklistItem>('checklist-items')
const notes = collectionRepo<Note>('notes')
const remindersBase = collectionRepo<Reminder>('reminders')
const travelOptionsBase = collectionRepo<TravelOption>('travel-options')

const httpBookingRepository: BookingRepository = bookings

const httpItineraryItemRepository: ItineraryItemRepository = itineraryItems

const httpChecklistRepository: ChecklistRepository = checklist

const httpNoteRepository: NoteRepository = notes

const httpReminderRepository: ReminderRepository = {
  ...remindersBase,
  listByItineraryItem: (itineraryItemId) =>
    apiFetch<Reminder[]>(
      `/api/itinerary-items/${encodeURIComponent(itineraryItemId)}/reminders`,
    ),
}

const httpTravelOptionRepository: TravelOptionRepository = {
  ...travelOptionsBase,
  getByPackageId: (packageId) =>
    apiFetch<TravelOption[]>(
      `/api/package-imports/${encodeURIComponent(packageId)}/travel-options`,
    ),
}

const httpPackageImportRepository: PackageImportRepository = {
  getById: async (id) => {
    try {
      return await apiFetch<PackageImport>(
        `/api/package-imports/${encodeURIComponent(id)}`,
      )
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'status' in err &&
        err.status === 404
      ) {
        return undefined
      }
      throw err
    }
  },
  listByTrip: (tripId) =>
    apiFetch<PackageImport[]>(
      `/api/trips/${encodeURIComponent(tripId)}/package-imports`,
    ),
  put: async (record) => {
    await apiFetch(
      `/api/trips/${encodeURIComponent(record.tripId)}/package-imports/${encodeURIComponent(record.id)}`,
      {
        method: 'PUT',
        body: JSON.stringify(record),
      },
    )
  },
  delete: async (id) => {
    await apiFetch(`/api/package-imports/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  },
}

/**
 * Cloud SoT repositories for trip entities.
 * Documents stay on Dexie until blob storage (v2).
 */
export const httpRepositories: Repositories = {
  trips: httpTripRepository,
  bookings: httpBookingRepository,
  itineraryItems: httpItineraryItemRepository,
  reminders: httpReminderRepository,
  documents: dexieDocumentRepository,
  checklist: httpChecklistRepository,
  notes: httpNoteRepository,
  travelOptions: httpTravelOptionRepository,
  packageImports: httpPackageImportRepository,
}

export type ImportPackageApiResult = {
  tripId: string
  packageId: string
  revision: number
  optionCount: number
  createdTrip: boolean
  isUpdate: boolean
  created: number
  updated: number
  unchanged: number
  decisionsPreserved: number
}

/** Server-side transactional import (preferred over many client PUTs). */
export async function apiImportPackage(
  raw: unknown,
  tripId?: string,
): Promise<ImportPackageApiResult> {
  const path = tripId
    ? `/api/trips/${encodeURIComponent(tripId)}/import-package`
    : '/api/trips/import-package'
  return apiFetch<ImportPackageApiResult>(path, {
    method: 'POST',
    body: JSON.stringify(raw),
  })
}

export type TripMigrateBundle = {
  trip: Trip
  bookings?: Booking[]
  travelOptions?: TravelOption[]
  itineraryItems?: ItineraryItem[]
  reminders?: Reminder[]
  checklistItems?: ChecklistItem[]
  notes?: Note[]
  packageImports?: PackageImport[]
}

export async function apiMigrateTrips(
  trips: TripMigrateBundle[],
): Promise<{ ok: boolean; tripIds: string[]; count: number }> {
  return apiFetch('/api/trips/migrate', {
    method: 'POST',
    body: JSON.stringify({ trips }),
  })
}

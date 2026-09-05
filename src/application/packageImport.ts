import type { Repositories } from '../data/repositories/types'
import { db } from '../data/db'
import type {
  Booking,
  BookingType,
  ChecklistItem,
  ItineraryItem,
  Note,
  PackageImport,
  TravelOption,
  TravelOptionType,
  Trip,
  TravelGoal,
} from '../domain/types'
import { newId, nowIso, touchTimestamps } from './ids'
import {
  type TripPackageV1,
  validateTripPackage,
} from './tripPackage'

export class DuplicatePackageError extends Error {
  readonly packageId: string
  constructor(packageId: string) {
    super(`El paquete «${packageId}» ya fue importado`)
    this.name = 'DuplicatePackageError'
    this.packageId = packageId
  }
}

export class PackageValidationImportError extends Error {
  readonly errors: { path: string; message: string }[]
  constructor(errors: { path: string; message: string }[]) {
    super(
      errors.map((e) => `${e.path}: ${e.message}`).join('; ') ||
        'TripPackage inválido',
    )
    this.name = 'PackageValidationImportError'
    this.errors = errors
  }
}

function mapOptionTypeToBookingType(type: TravelOptionType): BookingType {
  switch (type) {
    case 'flight':
    case 'bus':
    case 'train':
    case 'lodging':
    case 'transfer':
    case 'restaurant':
    case 'activity':
    case 'event':
    case 'other':
      return type
    case 'car_rental':
      return 'other'
    default:
      return 'other'
  }
}

function goalsFromLabels(labels: string[]): TravelGoal[] {
  return labels.map((label) => ({ id: newId(), label }))
}

export type ImportPackageResult = {
  tripId: string
  packageId: string
  optionCount: number
  createdTrip: boolean
}

export function createTravelOptionService(repos: Repositories) {
  return {
    listByTrip: (tripId: string) => repos.travelOptions.listByTrip(tripId),
    get: (id: string) => repos.travelOptions.getById(id),

    save: async (
      input: Omit<TravelOption, 'createdAt' | 'updatedAt' | 'syncStatus'> &
        Partial<Pick<TravelOption, 'createdAt' | 'updatedAt' | 'syncStatus'>>,
    ) => {
      const existing = await repos.travelOptions.getById(input.id)
      const option: TravelOption = {
        ...input,
        syncStatus: input.syncStatus ?? existing?.syncStatus ?? 'local',
        ...touchTimestamps(existing),
      }
      await repos.travelOptions.put(option)
      return option
    },

    setStatus: async (
      id: string,
      status: TravelOption['status'],
    ): Promise<TravelOption> => {
      const existing = await repos.travelOptions.getById(id)
      if (!existing) throw new Error('Opción no encontrada')
      const option: TravelOption = {
        ...existing,
        status,
        ...touchTimestamps(existing),
      }
      await repos.travelOptions.put(option)
      return option
    },

    updateNotes: async (id: string, notes: string): Promise<TravelOption> => {
      const existing = await repos.travelOptions.getById(id)
      if (!existing) throw new Error('Opción no encontrada')
      const option: TravelOption = {
        ...existing,
        notes: notes.trim() || undefined,
        ...touchTimestamps(existing),
      }
      await repos.travelOptions.put(option)
      return option
    },

    /**
     * Convert a researched option into a managed Booking.
     * Does not delete the TravelOption; links via bookingId and status=booked.
     */
    convertToBooking: async (optionId: string): Promise<{
      option: TravelOption
      booking: Booking
    }> => {
      const option = await repos.travelOptions.getById(optionId)
      if (!option) throw new Error('Opción no encontrada')
      if (option.bookingId) {
        const existing = await repos.bookings.getById(option.bookingId)
        if (existing) return { option, booking: existing }
      }

      const bookingId = newId()
      const stamps = touchTimestamps()
      const booking: Booking = {
        id: bookingId,
        tripId: option.tripId,
        type: mapOptionTypeToBookingType(option.type),
        // Managed reservation from research — not assumed paid/confirmed.
        status: 'selected',
        title: option.title,
        provider: option.provider,
        startAt: option.startAt,
        endAt: option.endAt,
        origin: option.origin,
        destination: option.destination,
        address: option.address,
        phone: option.phone,
        cost: option.priceObserved,
        currency: option.currency,
        externalUrl: option.sourceUrl,
        notes: [
          option.notes,
          '[Desde opción investigada]',
          option.verificationStatus
            ? `Verificación original: ${option.verificationStatus}`
            : undefined,
        ]
          .filter(Boolean)
          .join('\n'),
        ...stamps,
        syncStatus: 'local',
      }

      const linked: TravelOption = {
        ...option,
        status: 'booked',
        bookingId,
        ...touchTimestamps(option),
      }

      await db.transaction(
        'rw',
        db.bookings,
        db.travelOptions,
        async () => {
          await db.bookings.put(booking)
          await db.travelOptions.put(linked)
        },
      )

      return { option: linked, booking }
    },
  }
}

export function createPackageImportService(repos: Repositories) {
  return {
    getById: (packageId: string) => repos.packageImports.getById(packageId),

    /**
     * Validate + import TripPackage v1 transactionally.
     * Refuses silently-duplicate packageId (throws DuplicatePackageError).
     */
    importPackage: async (
      raw: unknown,
      options?: { force?: boolean },
    ): Promise<ImportPackageResult> => {
      const validated = validateTripPackage(raw)
      if (!validated.ok) {
        throw new PackageValidationImportError(validated.errors)
      }
      const pkg = validated.package

      const existingImport = await repos.packageImports.getById(pkg.packageId)
      if (existingImport && !options?.force) {
        throw new DuplicatePackageError(pkg.packageId)
      }

      const tripId = pkg.trip.id ?? newId()
      const existingTrip = await repos.trips.getById(tripId)
      const createdTrip = !existingTrip
      const now = nowIso()

      const trip: Trip = existingTrip
        ? {
            ...existingTrip,
            title: pkg.trip.title,
            destination: pkg.trip.destination ?? existingTrip.destination,
            startDate: pkg.trip.startDate,
            endDate: pkg.trip.endDate,
            timezone: pkg.trip.timezone,
            goals:
              pkg.trip.goals.length > 0
                ? goalsFromLabels(pkg.trip.goals)
                : existingTrip.goals,
            notes: pkg.trip.notes ?? existingTrip.notes,
            updatedAt: now,
          }
        : {
            id: tripId,
            title: pkg.trip.title,
            destination: pkg.trip.destination,
            startDate: pkg.trip.startDate,
            endDate: pkg.trip.endDate,
            timezone: pkg.trip.timezone,
            goals: goalsFromLabels(pkg.trip.goals),
            status: pkg.trip.status,
            notes: pkg.trip.notes,
            createdAt: now,
            updatedAt: now,
            syncStatus: 'local',
          }

      const optionsToWrite: TravelOption[] = pkg.travelOptions.map((o) => {
        const id = o.externalId
          ? `opt-${pkg.packageId}-${o.externalId}`
          : newId()
        return {
          id,
          tripId,
          type: o.type,
          status: o.status,
          title: o.title,
          provider: o.provider,
          description: o.description,
          startAt: o.startAt,
          endAt: o.endAt,
          origin: o.origin,
          destination: o.destination,
          address: o.address,
          phone: o.phone,
          priceObserved: o.priceObserved,
          currency: o.currency,
          sourceUrl: o.sourceUrl,
          checkedAt: o.checkedAt,
          verificationStatus: o.verificationStatus,
          sourceType: o.sourceType,
          notes: o.notes,
          externalId: o.externalId,
          packageId: pkg.packageId,
          createdAt: now,
          updatedAt: now,
          syncStatus: 'local' as const,
        }
      })

      const itineraryToWrite: ItineraryItem[] = pkg.itineraryItems.map(
        (item, index) => {
          const id = item.externalId
            ? `itin-${pkg.packageId}-${item.externalId}`
            : newId()
          return {
            id,
            tripId,
            title: item.title,
            startAt: item.startAt,
            endAt: item.endAt,
            place: item.place,
            importance: item.importance,
            goalIds: [],
            notes: item.notes,
            createdAt: now,
            updatedAt: now,
            syncStatus: 'local' as const,
            // keep sort via index in notes if needed
            ...(index >= 0 ? {} : {}),
          }
        },
      )

      const checklistToWrite: ChecklistItem[] = pkg.checklistItems.map(
        (item, index) => {
          const id = item.externalId
            ? `chk-${pkg.packageId}-${item.externalId}`
            : newId()
          return {
            id,
            tripId,
            label: item.label,
            status: 'open' as const,
            dueAt: item.dueAt,
            sortOrder: item.sortOrder ?? index,
            createdAt: now,
            updatedAt: now,
            syncStatus: 'local' as const,
          }
        },
      )

      const notesToWrite: Note[] = pkg.notes.map((n) => {
        const id = n.externalId
          ? `note-${pkg.packageId}-${n.externalId}`
          : newId()
        return {
          id,
          tripId,
          title: n.title,
          body: n.body,
          createdAt: now,
          updatedAt: now,
          syncStatus: 'local' as const,
        }
      })

      const importRecord: PackageImport = {
        id: pkg.packageId,
        tripId,
        title: pkg.trip.title,
        importedAt: now,
        optionCount: optionsToWrite.length,
        schemaVersion: pkg.schemaVersion,
      }

      try {
        await db.transaction(
          'rw',
          [
            db.trips,
            db.travelOptions,
            db.itineraryItems,
            db.checklistItems,
            db.notes,
            db.packageImports,
          ],
          async () => {
            if (options?.force && existingImport) {
              const oldOpts = await db.travelOptions
                .where('packageId')
                .equals(pkg.packageId)
                .toArray()
              for (const o of oldOpts) {
                await db.travelOptions.delete(o.id)
              }
            }
            await db.trips.put(trip)
            for (const o of optionsToWrite) await db.travelOptions.put(o)
            for (const i of itineraryToWrite) await db.itineraryItems.put(i)
            for (const c of checklistToWrite) await db.checklistItems.put(c)
            for (const n of notesToWrite) await db.notes.put(n)
            await db.packageImports.put(importRecord)
          },
        )
      } catch (err) {
        throw err instanceof Error
          ? err
          : new Error('Falló la importación transaccional')
      }

      return {
        tripId,
        packageId: pkg.packageId,
        optionCount: optionsToWrite.length,
        createdTrip,
      }
    },

    preview: (raw: unknown) => validateTripPackage(raw),
  }
}

export type { TripPackageV1 }

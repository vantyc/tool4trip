import type { Repositories } from '../data/repositories/types'
import { apiImportPackage } from '../data/repositories/httpRepositories'
import type {
  Booking,
  BookingType,
  TravelOption,
  TravelOptionType,
} from '../domain/types'
import { newId, touchTimestamps } from './ids'
import { enrichTripPackageAirportArrivals } from './airportArrivalEnrich'
import {
  USER_DECISION_STATUSES,
  optionEntityId,
  type TripPackageV1,
  validateTripPackage,
} from './tripPackage'

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

/** @deprecated Re-import now upserts; kept for older callers. */
export class DuplicatePackageError extends Error {
  readonly packageId: string
  constructor(packageId: string) {
    super(`El paquete «${packageId}» ya fue importado`)
    this.name = 'DuplicatePackageError'
    this.packageId = packageId
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

function isUserDecisionStatus(
  status: TravelOption['status'],
): boolean {
  return (USER_DECISION_STATUSES as readonly string[]).includes(status)
}

/** Research fields that define whether an option "changed" for preview. */
function researchFingerprint(o: {
  type: string
  title: string
  provider?: string
  description?: string
  startAt?: string
  endAt?: string
  origin?: string
  destination?: string
  address?: string
  phone?: string
  priceObserved?: number
  currency?: string
  sourceUrl?: string
  checkedAt?: string
  verificationStatus?: string
  sourceType?: string
  notes?: string
  status: string
}): string {
  return JSON.stringify([
    o.type,
    o.title,
    o.provider ?? '',
    o.description ?? '',
    o.startAt ?? '',
    o.endAt ?? '',
    o.origin ?? '',
    o.destination ?? '',
    o.address ?? '',
    o.phone ?? '',
    o.priceObserved ?? null,
    o.currency ?? '',
    o.sourceUrl ?? '',
    o.checkedAt ?? '',
    o.verificationStatus ?? '',
    o.sourceType ?? '',
    o.notes ?? '',
    o.status,
  ])
}

export type ImportUpdatePlan = {
  isUpdate: boolean
  packageId: string
  revision: number
  tripId: string | null
  created: number
  updated: number
  unchanged: number
  decisionsPreserved: number
}

export type ImportPackageResult = {
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
        syncStatus: 'synced',
      }

      const linked: TravelOption = {
        ...option,
        status: 'booked',
        bookingId,
        ...touchTimestamps(option),
        syncStatus: 'synced',
      }

      await repos.bookings.put(booking)
      await repos.travelOptions.put(linked)

      return { option: linked, booking }
    },
  }
}

export function createPackageImportService(repos: Repositories) {
  return {
    getById: (packageId: string) => repos.packageImports.getById(packageId),

    /**
     * Dry-run counts for preview (new / updated / unchanged / decisions kept).
     * Does not write.
     *
     * When the packageId has never been imported, all options are "created"
     * without probing /api/travel-options/:id (those GETs would 404 for every
     * option on a brand-new Nuevo viaje / first import).
     */
    planImport: async (pkg: TripPackageV1): Promise<ImportUpdatePlan> => {
      const existingImport = await repos.packageImports.getById(pkg.packageId)
      const tripId = existingImport?.tripId ?? pkg.trip.id ?? null

      if (!existingImport) {
        return {
          isUpdate: false,
          packageId: pkg.packageId,
          revision: pkg.revision,
          tripId,
          created: pkg.travelOptions.length,
          updated: 0,
          unchanged: 0,
          decisionsPreserved: 0,
        }
      }

      let created = 0
      let updated = 0
      let unchanged = 0
      let decisionsPreserved = 0

      for (const incoming of pkg.travelOptions) {
        const id = optionEntityId(pkg.packageId, incoming.externalId)
        const existing = await repos.travelOptions.getById(id)
        if (!existing) {
          created += 1
          continue
        }
        if (isUserDecisionStatus(existing.status)) {
          decisionsPreserved += 1
        }
        const beforeNorm = researchFingerprint({
          type: existing.type,
          title: existing.title,
          provider: existing.provider,
          description: existing.description,
          startAt: existing.startAt,
          endAt: existing.endAt,
          origin: existing.origin,
          destination: existing.destination,
          address: existing.address,
          phone: existing.phone,
          priceObserved: existing.priceObserved,
          currency: existing.currency,
          sourceUrl: existing.sourceUrl,
          checkedAt: existing.checkedAt,
          verificationStatus: existing.verificationStatus,
          sourceType: existing.sourceType,
          notes: existing.notes,
          status: incoming.status,
        })
        const after = researchFingerprint(incoming)
        if (beforeNorm === after) unchanged += 1
        else updated += 1
      }

      return {
        isUpdate: true,
        packageId: pkg.packageId,
        revision: pkg.revision,
        tripId,
        created,
        updated,
        unchanged,
        decisionsPreserved,
      }
    },

    /**
     * Validate + import/upsert TripPackage v1 via trip-api (transactional on server).
     * Re-import updates by externalId; never deletes missing options;
     * never overwrites selected/booked/rejected or bookingId.
     */
    importPackage: async (
      raw: unknown,
      _options?: { force?: boolean },
    ): Promise<ImportPackageResult> => {
      const validated = validateTripPackage(raw)
      if (!validated.ok) {
        throw new PackageValidationImportError(validated.errors)
      }
      const pkg = enrichTripPackageAirportArrivals(validated.package)
      return apiImportPackage(pkg)
    },

    preview: (raw: unknown) => validateTripPackage(raw),
  }
}

export type { TripPackageV1 }

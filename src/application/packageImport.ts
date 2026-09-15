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
  enrichTripPackageAirportArrivals,
  isAirportArrivalExternalId,
} from './airportArrivalEnrich'
import {
  USER_DECISION_STATUSES,
  checklistEntityId,
  itineraryEntityId,
  noteEntityId,
  optionEntityId,
  type PackageTravelOption,
  type TripPackageV1,
  validateTripPackage,
} from './tripPackage'
import type { AbsoluteReminder } from '../domain/types'

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

function goalsFromLabels(labels: string[]): TravelGoal[] {
  return labels.map((label) => ({ id: newId(), label }))
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

function buildOptionFromPackage(
  pkg: TripPackageV1,
  tripId: string,
  incoming: PackageTravelOption,
  existing: TravelOption | undefined,
  now: string,
): TravelOption {
  const id = optionEntityId(pkg.packageId, incoming.externalId)
  const preserveDecision =
    existing !== undefined && isUserDecisionStatus(existing.status)

  return {
    id,
    tripId,
    type: incoming.type,
    status: preserveDecision ? existing.status : incoming.status,
    title: incoming.title,
    provider: incoming.provider,
    description: incoming.description,
    startAt: incoming.startAt,
    endAt: incoming.endAt,
    origin: incoming.origin,
    destination: incoming.destination,
    address: incoming.address,
    phone: incoming.phone,
    priceObserved: incoming.priceObserved,
    currency: incoming.currency,
    sourceUrl: incoming.sourceUrl,
    checkedAt: incoming.checkedAt,
    verificationStatus: incoming.verificationStatus,
    sourceType: incoming.sourceType,
    notes: incoming.notes,
    externalId: incoming.externalId,
    packageId: pkg.packageId,
    bookingId: existing?.bookingId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    syncStatus: existing?.syncStatus ?? 'local',
  }
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
     * Dry-run counts for preview (new / updated / unchanged / decisions kept).
     * Does not write.
     */
    planImport: async (pkg: TripPackageV1): Promise<ImportUpdatePlan> => {
      const existingImport = await repos.packageImports.getById(pkg.packageId)
      const tripId =
        existingImport?.tripId ?? pkg.trip.id ?? null

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
        isUpdate: Boolean(existingImport),
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
     * Validate + import/upsert TripPackage v1 transactionally.
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

      const existingImport = await repos.packageImports.getById(pkg.packageId)
      const tripId =
        existingImport?.tripId ?? pkg.trip.id ?? newId()
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

      let created = 0
      let updated = 0
      let unchanged = 0
      let decisionsPreserved = 0
      const optionsToWrite: TravelOption[] = []

      for (const incoming of pkg.travelOptions) {
        const id = optionEntityId(pkg.packageId, incoming.externalId)
        const existing = await repos.travelOptions.getById(id)
        const next = buildOptionFromPackage(
          pkg,
          tripId,
          incoming,
          existing,
          now,
        )
        if (!existing) {
          created += 1
        } else {
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
        optionsToWrite.push(next)
      }

      const itineraryToWrite: ItineraryItem[] = []
      for (const item of pkg.itineraryItems) {
        const id = itineraryEntityId(pkg.packageId, item.externalId)
        const existing = await repos.itineraryItems.getById(id)
        // Do not touch items the user linked to a Booking.
        if (existing?.bookingId) {
          continue
        }
        itineraryToWrite.push({
          id,
          tripId,
          title: item.title,
          startAt: item.startAt,
          endAt: item.endAt,
          place: item.place,
          importance: item.importance,
          goalIds: existing?.goalIds ?? [],
          notes: item.notes,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          syncStatus: existing?.syncStatus ?? 'local',
        })
      }

      const checklistToWrite: ChecklistItem[] = []
      for (const [index, item] of pkg.checklistItems.entries()) {
        const id = checklistEntityId(pkg.packageId, item.externalId)
        const existing = await repos.checklist.getById(id)
        checklistToWrite.push({
          id,
          tripId,
          label: item.label,
          // Preserve traveler checklist progress.
          status: existing?.status ?? 'open',
          dueAt: item.dueAt,
          sortOrder: item.sortOrder ?? existing?.sortOrder ?? index,
          relatedBookingId: existing?.relatedBookingId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          syncStatus: existing?.syncStatus ?? 'local',
        })
      }

      const notesToWrite: Note[] = []
      for (const n of pkg.notes) {
        const id = noteEntityId(pkg.packageId, n.externalId)
        const existing = await repos.notes.getById(id)
        notesToWrite.push({
          id,
          tripId,
          title: n.title,
          body: n.body,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          syncStatus: existing?.syncStatus ?? 'local',
        })
      }

      const remindersToWrite: AbsoluteReminder[] = []
      for (const item of itineraryToWrite) {
        const pkgItem = pkg.itineraryItems.find(
          (i) => itineraryEntityId(pkg.packageId, i.externalId) === item.id,
        )
        if (
          !pkgItem ||
          !isAirportArrivalExternalId(pkgItem.externalId) ||
          !item.startAt
        ) {
          continue
        }
        const remId = `rem-${item.id}`
        const existingRem = await repos.reminders.getById(remId)
        const triggerAt: string = item.startAt
        const label: string =
          existingRem?.label ?? item.title ?? 'Arribo al aeropuerto'
        remindersToWrite.push({
          id: remId,
          tripId,
          itineraryItemId: item.id,
          label,
          done: existingRem?.done ?? false,
          kind: 'absolute',
          triggerAt,
          createdAt: existingRem?.createdAt ?? now,
          updatedAt: now,
          syncStatus: existingRem?.syncStatus ?? 'local',
        })
      }

      const importRecord: PackageImport = {
        id: pkg.packageId,
        tripId,
        title: pkg.trip.title,
        importedAt: now,
        optionCount: optionsToWrite.length,
        schemaVersion: pkg.schemaVersion,
        revision: pkg.revision,
        generatedAt: pkg.generatedAt,
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
            db.reminders,
            db.packageImports,
          ],
          async () => {
            // Upsert only — never delete options absent from this revision.
            await db.trips.put(trip)
            for (const o of optionsToWrite) await db.travelOptions.put(o)
            for (const i of itineraryToWrite) await db.itineraryItems.put(i)
            for (const c of checklistToWrite) await db.checklistItems.put(c)
            for (const n of notesToWrite) await db.notes.put(n)
            for (const r of remindersToWrite) await db.reminders.put(r)
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
        revision: pkg.revision,
        optionCount: optionsToWrite.length,
        createdTrip,
        isUpdate: Boolean(existingImport),
        created,
        updated,
        unchanged,
        decisionsPreserved,
      }
    },

    preview: (raw: unknown) => validateTripPackage(raw),
  }
}

export type { TripPackageV1 }

import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import {
  enrichTripPackageAirportArrivals,
  isAirportArrivalExternalId,
} from './airportArrivalEnrich.ts'
import {
  USER_DECISION_STATUSES,
  checklistEntityId,
  itineraryEntityId,
  noteEntityId,
  optionEntityId,
  validateTripPackage,
  type PackageTravelOption,
  type TripPackageV1,
} from './tripPackage.ts'
import type {
  AbsoluteReminder,
  ChecklistItem,
  ItineraryItem,
  Note,
  PackageImport,
  TravelGoal,
  TravelOption,
  Trip,
} from './domainTypes.ts'
import { store } from './store.ts'

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

function nowIso(): string {
  return new Date().toISOString()
}

function goalsFromLabels(labels: string[]): TravelGoal[] {
  return labels.map((label) => ({ id: randomUUID(), label }))
}

function isUserDecisionStatus(status: TravelOption['status']): boolean {
  return (USER_DECISION_STATUSES as readonly string[]).includes(status)
}

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
    syncStatus: 'synced',
  }
}

export async function importPackage(
  client: pg.PoolClient,
  raw: unknown,
  opts?: { tripId?: string },
): Promise<ImportPackageResult> {
  const validated = validateTripPackage(raw)
  if (!validated.ok) {
    throw new PackageValidationImportError(validated.errors)
  }
  const pkg = enrichTripPackageAirportArrivals(validated.package)

  const existingImport = await store.getPackageImport(client, pkg.packageId)
  const tripId =
    opts?.tripId ?? existingImport?.tripId ?? pkg.trip.id ?? randomUUID()
  const existingTrip = await store.getTrip(client, tripId)
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
        syncStatus: 'synced',
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
        syncStatus: 'synced',
      }

  let created = 0
  let updated = 0
  let unchanged = 0
  let decisionsPreserved = 0
  const optionsToWrite: TravelOption[] = []

  for (const incoming of pkg.travelOptions) {
    const id = optionEntityId(pkg.packageId, incoming.externalId)
    const existing = await store.getTravelOption(client, id)
    const next = buildOptionFromPackage(pkg, tripId, incoming, existing, now)
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
    const existing = await store.getItineraryItem(client, id)
    if (existing?.bookingId) continue
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
      syncStatus: 'synced',
    })
  }

  const checklistToWrite: ChecklistItem[] = []
  for (const [index, item] of pkg.checklistItems.entries()) {
    const id = checklistEntityId(pkg.packageId, item.externalId)
    const existing = await store.getChecklistItem(client, id)
    checklistToWrite.push({
      id,
      tripId,
      label: item.label,
      status: existing?.status ?? 'open',
      dueAt: item.dueAt,
      sortOrder: item.sortOrder ?? existing?.sortOrder ?? index,
      relatedBookingId: existing?.relatedBookingId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      syncStatus: 'synced',
    })
  }

  const notesToWrite: Note[] = []
  for (const n of pkg.notes) {
    const id = noteEntityId(pkg.packageId, n.externalId)
    const existing = await store.getNote(client, id)
    notesToWrite.push({
      id,
      tripId,
      title: n.title,
      body: n.body,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      syncStatus: 'synced',
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
    const existingRem = await store.getReminder(client, remId)
    remindersToWrite.push({
      id: remId,
      tripId,
      itineraryItemId: item.id,
      label: existingRem?.label ?? item.title ?? 'Arribo al aeropuerto',
      done: existingRem?.done ?? false,
      kind: 'absolute',
      triggerAt: item.startAt,
      createdAt: existingRem?.createdAt ?? now,
      updatedAt: now,
      syncStatus: 'synced',
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

  await store.putTrip(client, trip)
  for (const o of optionsToWrite) await store.putTravelOption(client, o)
  for (const i of itineraryToWrite) await store.putItineraryItem(client, i)
  for (const c of checklistToWrite) await store.putChecklistItem(client, c)
  for (const n of notesToWrite) await store.putNote(client, n)
  for (const r of remindersToWrite) await store.putReminder(client, r)
  await store.putPackageImport(client, importRecord)

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
}

/** Full trip graph for Dexie → cloud migration. */
export type TripBundle = {
  trip: Trip
  bookings?: BookingLike[]
  travelOptions?: TravelOption[]
  itineraryItems?: ItineraryItem[]
  reminders?: import('./domainTypes.ts').Reminder[]
  checklistItems?: ChecklistItem[]
  notes?: Note[]
  packageImports?: PackageImport[]
}

type BookingLike = import('./domainTypes.ts').Booking

export async function upsertTripBundle(
  client: pg.PoolClient,
  bundle: TripBundle,
): Promise<{ tripId: string }> {
  const now = nowIso()
  const trip: Trip = {
    ...bundle.trip,
    updatedAt: bundle.trip.updatedAt || now,
    createdAt: bundle.trip.createdAt || now,
    syncStatus: 'synced',
  }
  await store.putTrip(client, trip)
  for (const b of bundle.bookings ?? []) {
    await store.putBooking(client, { ...b, syncStatus: 'synced' })
  }
  for (const o of bundle.travelOptions ?? []) {
    await store.putTravelOption(client, { ...o, syncStatus: 'synced' })
  }
  for (const i of bundle.itineraryItems ?? []) {
    await store.putItineraryItem(client, { ...i, syncStatus: 'synced' })
  }
  for (const r of bundle.reminders ?? []) {
    await store.putReminder(client, { ...r, syncStatus: 'synced' })
  }
  for (const c of bundle.checklistItems ?? []) {
    await store.putChecklistItem(client, { ...c, syncStatus: 'synced' })
  }
  for (const n of bundle.notes ?? []) {
    await store.putNote(client, { ...n, syncStatus: 'synced' })
  }
  for (const p of bundle.packageImports ?? []) {
    await store.putPackageImport(client, p)
  }
  return { tripId: trip.id }
}

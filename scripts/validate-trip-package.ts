import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServices } from '../src/application/services.ts'
import {
  DuplicatePackageError,
  PackageValidationImportError,
} from '../src/application/packageImport.ts'
import { validateTripPackage } from '../src/application/tripPackage.ts'
import { db, IDB_SCHEMA_VERSION } from '../src/data/db.ts'
import { localRepositories } from '../src/data/repositories/index.ts'

export interface TripPackageCheck {
  name: string
  pass: boolean
  detail: string
}

function assert(
  checks: TripPackageCheck[],
  name: string,
  pass: boolean,
  detail: string,
) {
  checks.push({ name, pass, detail })
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const examplePath = resolve(root, 'examples/trip-package-example.json')

export async function validateTripPackageInvariants(): Promise<{
  ok: boolean
  checks: TripPackageCheck[]
}> {
  const checks: TripPackageCheck[] = []
  const services = createServices(localRepositories)

  await db.delete()
  await db.open()
  assert(
    checks,
    'dexie schema v2',
    IDB_SCHEMA_VERSION === 2 && db.verno >= 2,
    `IDB_SCHEMA_VERSION=${IDB_SCHEMA_VERSION} verno=${db.verno}`,
  )

  const priorTripId = 'prior-trip-keep'
  await services.trips.save({
    id: priorTripId,
    title: 'Viaje previo',
    startDate: '2026-01-01',
    endDate: '2026-01-02',
    timezone: 'America/Mexico_City',
    goals: [],
    status: 'planned',
  })
  await services.bookings.save({
    id: 'prior-booking',
    tripId: priorTripId,
    type: 'flight',
    status: 'confirmed',
    title: 'Prior booking',
  })

  const example = JSON.parse(readFileSync(examplePath, 'utf8')) as unknown
  const valid = validateTripPackage(example)
  assert(
    checks,
    'example JSON validates',
    valid.ok,
    valid.ok ? 'ok' : JSON.stringify(valid.errors),
  )

  const badVersion = validateTripPackage({
    schemaVersion: 99,
    packageId: 'x',
    trip: {
      title: 'X',
      startDate: '2026-01-01',
      endDate: '2026-01-02',
    },
  })
  assert(
    checks,
    'unknown schemaVersion rejected',
    !badVersion.ok,
    badVersion.ok ? 'accepted' : badVersion.errors[0]?.message ?? 'rejected',
  )

  const badKey = validateTripPackage({
    schemaVersion: 1,
    packageId: 'x',
    trip: {
      title: 'X',
      startDate: '2026-01-01',
      endDate: '2026-01-02',
    },
    bookings: [],
  })
  assert(checks, 'unknown root key rejected', !badKey.ok, 'strict')

  const badBooked = validateTripPackage({
    schemaVersion: 1,
    packageId: 'x',
    trip: {
      title: 'X',
      startDate: '2026-01-01',
      endDate: '2026-01-02',
    },
    travelOptions: [{ type: 'flight', title: 'F', status: 'booked' }],
  })
  assert(checks, 'booked option in package rejected', !badBooked.ok, 'status')

  let importedTripId = ''
  try {
    const result = await services.packages.importPackage(example)
    importedTripId = result.tripId
    assert(
      checks,
      'valid package imports',
      result.optionCount === 8 &&
        result.packageId === 'demo-sma-research-2026-09',
      `opts=${result.optionCount} trip=${result.tripId}`,
    )
  } catch (err) {
    assert(checks, 'valid package imports', false, String(err))
  }

  const opts = await services.travelOptions.listByTrip(importedTripId)
  assert(
    checks,
    'options linked to trip',
    opts.length === 8 && opts.every((o) => o.tripId === importedTripId),
    `n=${opts.length}`,
  )
  assert(
    checks,
    'options are not bookings',
    opts.every((o) => o.status !== 'booked' && !o.bookingId),
    'no booked yet',
  )

  let dupOk = false
  try {
    await services.packages.importPackage(example)
  } catch (err) {
    dupOk = err instanceof DuplicatePackageError
  }
  assert(checks, 'second import refuses duplicate', dupOk, 'DuplicatePackageError')

  const afterDup = await services.travelOptions.listByTrip(importedTripId)
  assert(
    checks,
    'no silent duplicate options',
    afterDup.length === 8,
    `n=${afterDup.length}`,
  )

  const first = opts[0]!
  await services.travelOptions.setStatus(first.id, 'shortlisted')
  const reloaded = await services.travelOptions.get(first.id)
  assert(
    checks,
    'status change persists',
    reloaded?.status === 'shortlisted',
    reloaded?.status ?? 'missing',
  )

  const { option: linked, booking } =
    await services.travelOptions.convertToBooking(first.id)
  assert(
    checks,
    'convert creates booking',
    Boolean(booking.id) && booking.tripId === importedTripId,
    booking.id,
  )
  assert(
    checks,
    'convert links option',
    linked.status === 'booked' && linked.bookingId === booking.id,
    `status=${linked.status}`,
  )
  assert(
    checks,
    'convert keeps researched option',
    Boolean(await services.travelOptions.get(first.id)),
    'option still present',
  )
  assert(
    checks,
    'booking not auto-confirmed',
    booking.status === 'selected',
    booking.status,
  )

  const prior = await services.trips.get(priorTripId)
  const priorBooking = await services.bookings.get('prior-booking')
  assert(
    checks,
    'prior trip survives import',
    prior?.title === 'Viaje previo',
    prior?.title ?? 'missing',
  )
  assert(
    checks,
    'prior booking survives import',
    priorBooking?.title === 'Prior booking',
    priorBooking?.title ?? 'missing',
  )

  let partialRefused = false
  try {
    await services.packages.importPackage({ schemaVersion: 1 })
  } catch (err) {
    partialRefused = err instanceof PackageValidationImportError
  }
  assert(checks, 'invalid import refused', partialRefused, 'validation error')

  db.close()
  await db.open()
  const offlineOpts = await services.travelOptions.listByTrip(importedTripId)
  assert(
    checks,
    'options readable after reopen (offline store)',
    offlineOpts.length === 8,
    `n=${offlineOpts.length}`,
  )

  return {
    ok: checks.every((c) => c.pass),
    checks,
  }
}

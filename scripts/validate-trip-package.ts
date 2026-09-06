import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServices } from '../src/application/services.ts'
import { PackageValidationImportError } from '../src/application/packageImport.ts'
import {
  optionEntityId,
  validateTripPackage,
} from '../src/application/tripPackage.ts'
import { db, IDB_SCHEMA_VERSION } from '../src/data/db.ts'
import { localRepositories } from '../src/data/repositories/index.ts'
import type { TripPackageV1 } from '../src/application/tripPackage.ts'

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

function clonePkg(pkg: TripPackageV1): TripPackageV1 {
  return JSON.parse(JSON.stringify(pkg)) as TripPackageV1
}

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

  for (const status of ['selected', 'booked', 'rejected'] as const) {
    const bad = validateTripPackage({
      schemaVersion: 1,
      packageId: 'x',
      trip: {
        title: 'X',
        startDate: '2026-01-01',
        endDate: '2026-01-02',
      },
      travelOptions: [
        {
          externalId: 'f1',
          type: 'flight',
          title: 'F',
          status,
        },
      ],
    })
    assert(
      checks,
      `import cannot impose ${status}`,
      !bad.ok,
      bad.ok ? 'accepted' : bad.errors[0]?.path ?? 'rejected',
    )
  }

  let importedTripId = ''
  const pkgId = 'demo-sma-research-2026-09'
  try {
    const result = await services.packages.importPackage(example)
    importedTripId = result.tripId
    assert(
      checks,
      'first import creates options',
      result.optionCount === 8 &&
        result.packageId === pkgId &&
        !result.isUpdate &&
        result.created === 8,
      `opts=${result.optionCount} created=${result.created}`,
    )
  } catch (err) {
    assert(checks, 'first import creates options', false, String(err))
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

  // --- Revision upsert suite ---
  if (!valid.ok) {
    return { ok: false, checks }
  }
  const base = valid.package

  // Mark one option selected (user decision)
  const flightAId = optionEntityId(pkgId, 'flight-a')
  await services.travelOptions.setStatus(flightAId, 'selected')

  // Convert another to booked
  const flightBId = optionEntityId(pkgId, 'flight-b')
  const { booking } = await services.travelOptions.convertToBooking(flightBId)
  assert(
    checks,
    'convert creates booking',
    Boolean(booking.id),
    booking.id,
  )

  // Reject a third
  const stayAId = optionEntityId(pkgId, 'stay-a')
  await services.travelOptions.setStatus(stayAId, 'rejected')

  // Leave stay-b as researched; will become "absent" from revision? keep it in package
  // Add orphan option that won't be in revision 2 — should survive
  await services.travelOptions.save({
    id: optionEntityId(pkgId, 'orphan-old'),
    tripId: importedTripId,
    type: 'other',
    status: 'researched',
    title: 'Orphan kept',
    sourceType: 'cursor',
    externalId: 'orphan-old',
    packageId: pkgId,
  })

  const rev2 = clonePkg(base)
  rev2.revision = 2
  rev2.generatedAt = '2026-09-06T12:00:00-06:00'
  // Update research fields on flight-a (user selected — status must stay)
  const flightA = rev2.travelOptions.find((o) => o.externalId === 'flight-a')!
  flightA.priceObserved = 1999
  flightA.checkedAt = '2026-09-06T12:00:00-06:00'
  flightA.sourceUrl = 'https://example.com/demo/flight-a-v2'
  flightA.status = 'researched'
  // Update booked flight research
  const flightB = rev2.travelOptions.find((o) => o.externalId === 'flight-b')!
  flightB.priceObserved = 2200
  flightB.checkedAt = '2026-09-06T12:05:00-06:00'
  flightB.status = 'shortlisted'
  // Rejected stay — research update, status researched in package
  const stayA = rev2.travelOptions.find((o) => o.externalId === 'stay-a')!
  stayA.notes = 'precio revisado'
  stayA.status = 'researched'
  // New option
  rev2.travelOptions.push({
    externalId: 'flight-c-new',
    type: 'flight',
    status: 'researched',
    title: '[FICTICIO] Vuelo nuevo revisión 2',
    sourceType: 'cursor',
    sourceUrl: 'https://example.com/demo/flight-c',
    checkedAt: '2026-09-06T12:10:00-06:00',
    verificationStatus: 'unverified',
  })
  // Remove act-plaza from package — orphan should remain in DB; plaza may remain too
  rev2.travelOptions = rev2.travelOptions.filter(
    (o) => o.externalId !== 'act-plaza',
  )

  const plan = await services.packages.planImport(rev2)
  assert(
    checks,
    'preview informs new/updated/unchanged',
    plan.isUpdate &&
      plan.created === 1 &&
      plan.updated >= 1 &&
      plan.decisionsPreserved === 3,
    `c=${plan.created} u=${plan.updated} un=${plan.unchanged} d=${plan.decisionsPreserved}`,
  )

  const updateResult = await services.packages.importPackage(rev2)
  assert(
    checks,
    'second revision updates by externalId',
    updateResult.isUpdate && updateResult.revision === 2,
    `update=${updateResult.isUpdate} rev=${updateResult.revision}`,
  )

  const after = await services.travelOptions.listByTrip(importedTripId)
  const byExt = (ext: string) =>
    after.find((o) => o.externalId === ext)

  assert(
    checks,
    'no duplicates on revision',
    after.filter((o) => o.externalId === 'flight-a').length === 1,
    'flight-a unique',
  )
  assert(
    checks,
    'new options are added',
    Boolean(byExt('flight-c-new')),
    byExt('flight-c-new')?.title ?? 'missing',
  )
  assert(
    checks,
    'absent options are not deleted',
    Boolean(byExt('orphan-old')) && Boolean(byExt('act-plaza')),
    `orphan=${Boolean(byExt('orphan-old'))} plaza=${Boolean(byExt('act-plaza'))}`,
  )
  assert(
    checks,
    'user selected is preserved',
    byExt('flight-a')?.status === 'selected',
    byExt('flight-a')?.status ?? 'missing',
  )
  assert(
    checks,
    'booked + bookingId are preserved',
    byExt('flight-b')?.status === 'booked' &&
      byExt('flight-b')?.bookingId === booking.id,
    `status=${byExt('flight-b')?.status} bid=${byExt('flight-b')?.bookingId}`,
  )
  assert(
    checks,
    'user rejected is preserved',
    byExt('stay-a')?.status === 'rejected',
    byExt('stay-a')?.status ?? 'missing',
  )
  assert(
    checks,
    'price/checkedAt/sourceUrl update',
    byExt('flight-a')?.priceObserved === 1999 &&
      byExt('flight-a')?.checkedAt === '2026-09-06T12:00:00-06:00' &&
      byExt('flight-a')?.sourceUrl === 'https://example.com/demo/flight-a-v2',
    `price=${byExt('flight-a')?.priceObserved}`,
  )

  const bookingStill = await services.bookings.get(booking.id)
  assert(
    checks,
    'linked booking untouched',
    bookingStill?.id === booking.id && bookingStill.status === 'selected',
    bookingStill?.status ?? 'missing',
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
  assert(
    checks,
    'existing Dexie data survives',
    after.length >= 9,
    `n=${after.length}`,
  )

  let partialRefused = false
  try {
    await services.packages.importPackage({ schemaVersion: 1 })
  } catch (err) {
    partialRefused = err instanceof PackageValidationImportError
  }
  assert(checks, 'invalid import refused', partialRefused, 'validation error')

  // Transactional: failed validation leaves no partial package
  const beforeBad = await services.travelOptions.listByTrip(importedTripId)
  try {
    await services.packages.importPackage({
      schemaVersion: 1,
      packageId: pkgId,
      travelOptions: [{ type: 'flight', title: 'no-ext' }],
    })
  } catch {
    /* expected */
  }
  const afterBad = await services.travelOptions.listByTrip(importedTripId)
  assert(
    checks,
    'operation stays transactional',
    beforeBad.length === afterBad.length,
    `before=${beforeBad.length} after=${afterBad.length}`,
  )

  db.close()
  await db.open()
  const offlineOpts = await services.travelOptions.listByTrip(importedTripId)
  assert(
    checks,
    'options readable after reopen (offline store)',
    offlineOpts.length === after.length,
    `n=${offlineOpts.length}`,
  )

  const pkgRec = await services.packages.getById(pkgId)
  assert(
    checks,
    'package revision recorded',
    pkgRec?.revision === 2,
    `rev=${pkgRec?.revision}`,
  )

  return {
    ok: checks.every((c) => c.pass),
    checks,
  }
}

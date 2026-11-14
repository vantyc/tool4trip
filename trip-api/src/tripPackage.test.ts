import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  validateTripPackage,
  optionEntityId,
  type TripPackageV1,
} from './tripPackage.ts'

/** Minimal Ask Travel update package: two AeroDataBox flight_schedule options. */
function askTravelFlightSchedulePackage(
  overrides?: Partial<TripPackageV1> & {
    trip?: Partial<TripPackageV1['trip']>
  },
): Record<string, unknown> {
  const tripId = 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28'
  return {
    schemaVersion: 1,
    packageId: `agent-${tripId}`,
    revision: 2,
    trip: {
      id: tripId,
      title: 'Viaje a San Miguel el Alto para serenata 2026',
      destination: 'San Miguel el Alto, Jalisco',
      startDate: '2026-09-25',
      endDate: '2026-09-28',
      timezone: 'America/Mexico_City',
      goals: ['Fiestas patronales y serenata tradicional'],
      status: 'planned',
      ...overrides?.trip,
    },
    travelOptions: [
      {
        externalId: 'outbound-flight-1',
        type: 'flight',
        status: 'researched',
        title: 'AM222 MEX→GDL 11:15',
        provider: 'Aeromexico',
        origin: 'MEX',
        destination: 'GDL',
        startAt: '2026-09-25T11:15:00-06:00',
        endAt: '2026-09-25T12:52:00-06:00',
        verificationStatus: 'estimated',
        sourceType: 'flight_schedule',
        sourceUrl:
          'https://aerodatabox.com/?origin=MEX&destination=GDL&date=2026-09-25&flight=AM222',
        notes: 'HORARIO PUBLICADO — no confirma asientos ni tarifa.',
      },
      {
        externalId: 'return-flight-1',
        type: 'flight',
        status: 'researched',
        title: 'Y4141 GDL→MEX 08:22',
        provider: 'Volaris',
        origin: 'GDL',
        destination: 'MEX',
        startAt: '2026-09-28T08:22:00-06:00',
        endAt: '2026-09-28T09:45:00-06:00',
        verificationStatus: 'estimated',
        sourceType: 'flight_schedule',
        sourceUrl:
          'https://aerodatabox.com/?origin=GDL&destination=MEX&date=2026-09-28&flight=Y4141',
        notes: 'HORARIO PUBLICADO — no confirma asientos ni tarifa.',
      },
    ],
    itineraryItems: [],
    checklistItems: [],
    notes: [],
    ...overrides,
  }
}

describe('trip-api TripPackage sourceType flight_schedule', () => {
  it('accepts two flight_schedule travelOptions (Ask Travel Apply repro)', () => {
    const raw = askTravelFlightSchedulePackage()
    const result = validateTripPackage(raw)
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) throw new Error('expected ok')
    assert.equal(result.package.travelOptions.length, 2)
    assert.equal(result.package.travelOptions[0]!.sourceType, 'flight_schedule')
    assert.equal(result.package.travelOptions[1]!.sourceType, 'flight_schedule')
    assert.equal(result.package.trip.id, 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28')
    assert.equal(result.package.trip.startDate, '2026-09-25')
    assert.equal(result.package.trip.endDate, '2026-09-28')
  })

  it('preserves flight_schedule through serialize → validate → re-parse', () => {
    const raw = askTravelFlightSchedulePackage()
    const first = validateTripPackage(raw)
    assert.equal(first.ok, true)
    if (!first.ok) throw new Error('expected ok')
    const json = JSON.stringify(first.package)
    const second = validateTripPackage(JSON.parse(json))
    assert.equal(second.ok, true)
    if (!second.ok) throw new Error('expected ok')
    for (const o of second.package.travelOptions) {
      assert.equal(o.sourceType, 'flight_schedule')
    }
  })

  it('still accepts legacy sourceTypes', () => {
    for (const st of [
      'cursor',
      'manual',
      'imported',
      'agent',
      'other',
    ] as const) {
      const raw = askTravelFlightSchedulePackage()
      ;(raw.travelOptions as Array<Record<string, unknown>>)[0]!.sourceType = st
      ;(raw.travelOptions as Array<Record<string, unknown>>)[1]!.sourceType = st
      const result = validateTripPackage(raw)
      assert.equal(result.ok, true, `${st}: ${JSON.stringify(result)}`)
      if (!result.ok) throw new Error('expected ok')
      assert.equal(result.package.travelOptions[0]!.sourceType, st)
    }
  })

  it('rejects truly invalid sourceType', () => {
    const raw = askTravelFlightSchedulePackage()
    ;(raw.travelOptions as Array<Record<string, unknown>>)[0]!.sourceType =
      'not_a_real_source'
    const result = validateTripPackage(raw)
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('expected fail')
    assert.ok(
      result.errors.some(
        (e) =>
          e.path === 'travelOptions.0.sourceType' &&
          /Invalid enum value/i.test(e.message),
      ),
      JSON.stringify(result.errors),
    )
  })

  it('does not rewrite flight_schedule to agent/other/manual', () => {
    const result = validateTripPackage(askTravelFlightSchedulePackage())
    assert.equal(result.ok, true)
    if (!result.ok) throw new Error('expected ok')
    for (const o of result.package.travelOptions) {
      assert.equal(o.sourceType, 'flight_schedule')
      assert.notEqual(o.sourceType, 'agent')
      assert.notEqual(o.sourceType, 'other')
      assert.notEqual(o.sourceType, 'manual')
    }
  })

  it('stable option ids for update-in-place on existing trip packageId', () => {
    const pkgId = 'agent-bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28'
    assert.equal(
      optionEntityId(pkgId, 'outbound-flight-1'),
      `opt-${pkgId}-outbound-flight-1`,
    )
    assert.equal(
      optionEntityId(pkgId, 'return-flight-1'),
      `opt-${pkgId}-return-flight-1`,
    )
  })
})

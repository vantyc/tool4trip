import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { validateTripPackage } from './tripPackage.ts'

const TRIP_ID = 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28'

function askTravelPackage(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    packageId: `agent-${TRIP_ID}`,
    revision: 2,
    trip: {
      id: TRIP_ID,
      title: 'Viaje a San Miguel el Alto para serenata 2026',
      startDate: '2026-09-25',
      endDate: '2026-09-28',
      timezone: 'America/Mexico_City',
      goals: [],
      status: 'planned',
    },
    travelOptions: [
      {
        externalId: 'outbound-flight-1',
        type: 'flight',
        status: 'researched',
        title: 'AM222 MEX→GDL',
        startAt: '2026-09-25T11:15:00-06:00',
        endAt: '2026-09-25T12:52:00-06:00',
        verificationStatus: 'estimated',
        sourceType: 'flight_schedule',
        sourceUrl:
          'https://aerodatabox.com/?origin=MEX&destination=GDL&date=2026-09-25&flight=AM222',
      },
      {
        externalId: 'return-flight-1',
        type: 'flight',
        status: 'researched',
        title: 'Y4141 GDL→MEX',
        startAt: '2026-09-28T08:22:00-06:00',
        endAt: '2026-09-28T09:45:00-06:00',
        verificationStatus: 'estimated',
        sourceType: 'flight_schedule',
        sourceUrl:
          'https://aerodatabox.com/?origin=GDL&destination=MEX&date=2026-09-28&flight=Y4141',
      },
    ],
    itineraryItems: [],
    checklistItems: [],
    notes: [],
  }
}

describe('PWA TripPackage sourceType flight_schedule', () => {
  it('validates Ask Travel package with flight_schedule (Apply path)', () => {
    const result = validateTripPackage(askTravelPackage())
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) throw new Error('expected ok')
    assert.equal(result.package.trip.id, TRIP_ID)
    assert.ok(
      result.package.travelOptions.every((o) => o.sourceType === 'flight_schedule'),
    )
  })

  it('round-trips flight_schedule through JSON serialize/validate', () => {
    const a = validateTripPackage(askTravelPackage())
    assert.equal(a.ok, true)
    if (!a.ok) throw new Error('expected ok')
    const b = validateTripPackage(JSON.parse(JSON.stringify(a.package)))
    assert.equal(b.ok, true)
    if (!b.ok) throw new Error('expected ok')
    assert.equal(b.package.travelOptions[0]!.sourceType, 'flight_schedule')
    assert.equal(b.package.travelOptions[1]!.sourceType, 'flight_schedule')
  })

  it('rejects invalid sourceType', () => {
    const raw = askTravelPackage()
    ;(raw.travelOptions as Array<Record<string, unknown>>)[0]!.sourceType =
      'bogus'
    const result = validateTripPackage(raw)
    assert.equal(result.ok, false)
  })
})

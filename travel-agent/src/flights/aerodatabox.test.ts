import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { AeroDataBoxScheduleProvider } from './aerodatabox.ts'
import { toIsoOffsetLocal } from './types.ts'
import { mergePublishedSchedulesFromTrace } from './mergeSchedules.ts'
import type { ToolTraceEntry } from '../../shared/agentContracts.ts'

describe('toIsoOffsetLocal', () => {
  it('converts AeroDataBox local datetime to ISO', () => {
    assert.equal(
      toIsoOffsetLocal('2026-09-19 06:00-06:00'),
      '2026-09-19T06:00:00-06:00',
    )
  })
})

describe('AeroDataBoxScheduleProvider', () => {
  it('filters MEX→GDL and maps nested scheduledTime', async () => {
    const depPayload = {
      departures: [
        {
          number: '140',
          status: 'Unknown',
          airline: { iata: 'Y4', name: 'Volaris' },
          departure: {
            scheduledTime: { local: '2026-09-19 06:00-06:00' },
            airport: { iata: 'MEX' },
          },
          arrival: {
            scheduledTime: { local: '2026-09-19 07:18-06:00' },
            airport: { iata: 'GDL' },
          },
        },
        {
          number: '999',
          airline: { iata: 'AM', name: 'Aeromexico' },
          departure: {
            scheduledTime: { local: '2026-09-19 08:00-06:00' },
          },
          arrival: {
            scheduledTime: { local: '2026-09-19 09:00-06:00' },
            airport: { iata: 'CUN' },
          },
        },
      ],
    }
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = mock.fn(async () => {
      calls++
      return new Response(JSON.stringify(depPayload), { status: 200 })
    }) as typeof fetch
    try {
      const provider = new AeroDataBoxScheduleProvider({
        rapidApiKey: 'test-key',
      })
      const result = await provider.searchSchedules({
        origin: 'MEX',
        destination: 'GDL',
        date: '2026-09-19',
      })
      assert.equal(result.ok, true)
      assert.equal(result.flights.length, 1) // same flight deduped across 2 windows
      assert.equal(result.flights[0]!.flightNumber, 'Y4140')
      assert.equal(result.flights[0]!.departureAt, '2026-09-19T06:00:00-06:00')
      assert.equal(result.flights[0]!.arrivalAt, '2026-09-19T07:18:00-06:00')
      assert.equal(result.flights[0]!.sourceType, 'flight_schedule')
      assert.equal(result.flights[0]!.carrierCode, 'Y4')
      assert.equal(calls, 2)
    } finally {
      globalThis.fetch = original
    }
  })

  it('fails cleanly without API key', async () => {
    const provider = new AeroDataBoxScheduleProvider({ rapidApiKey: '' })
    const prev = process.env.AERODATABOX_RAPIDAPI_KEY
    const prev2 = process.env.AERODATABOX_API_KEY
    delete process.env.AERODATABOX_RAPIDAPI_KEY
    delete process.env.AERODATABOX_API_KEY
    try {
      const result = await provider.searchSchedules({
        origin: 'MEX',
        destination: 'GDL',
        date: '2026-09-19',
      })
      assert.equal(result.ok, false)
      assert.match(result.error ?? '', /AERODATABOX_RAPIDAPI_KEY missing/)
    } finally {
      if (prev !== undefined) process.env.AERODATABOX_RAPIDAPI_KEY = prev
      if (prev2 !== undefined) process.env.AERODATABOX_API_KEY = prev2
    }
  })
})

describe('mergePublishedSchedulesFromTrace', () => {
  it('upgrades skeleton flight with schedule clocks + HORARIO PUBLICADO', () => {
    const trace: ToolTraceEntry[] = [
      {
        tool: 'searchFlightSchedules',
        args: {
          origin: 'MEX',
          destination: 'GDL',
          date: '2026-09-19',
          flights: [
            {
              origin: 'MEX',
              destination: 'GDL',
              departureAt: '2026-09-19T06:00:00-06:00',
              arrivalAt: '2026-09-19T07:18:00-06:00',
              carrierCode: 'Y4',
              carrierName: 'Volaris',
              flightNumber: 'Y4140',
              sourceUrl:
                'https://aerodatabox.com/?origin=MEX&destination=GDL&date=2026-09-19&flight=Y4140',
              checkedAt: '2026-09-19T12:00:00+00:00',
            },
          ],
        },
        ok: true,
        sources: [],
        checkedAt: '2026-09-19T12:00:00+00:00',
      },
    ]
    const { package: pkg, warnings } = mergePublishedSchedulesFromTrace(
      {
        travelOptions: [
          {
            externalId: 'flt-out',
            type: 'flight',
            status: 'shortlisted',
            title: 'MEX → GDL estimado',
            origin: 'MEX — CDMX',
            destination: 'GDL — Guadalajara',
            verificationStatus: 'estimated',
            sourceType: 'agent',
          },
        ],
      },
      trace,
    )
    const opt = (pkg.travelOptions as Rec[])[0]!
    assert.equal(opt.sourceType, 'flight_schedule')
    assert.equal(opt.verificationStatus, 'estimated')
    assert.equal(opt.startAt, '2026-09-19T06:00:00-06:00')
    assert.equal(opt.endAt, '2026-09-19T07:18:00-06:00')
    assert.equal(opt.provider, 'Volaris')
    assert.match(String(opt.notes), /HORARIO PUBLICADO/)
    assert.ok(warnings.some((w) => /horario\(s\) publicado/i.test(w)))
  })
})

type Rec = Record<string, unknown>

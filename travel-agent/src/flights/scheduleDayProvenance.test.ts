import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import { phoneNumbersIn, phonesEquivalent } from '../agent/entityEvidence.ts'
import { webSearch } from '../tools/webSearch.ts'
import { stampProvenScheduleOptions } from './mergeSchedules.ts'

const url = (day: string, flight: string) =>
  `https://aerodatabox.com/?origin=MEX&destination=GDL&date=${day}&flight=${flight}`
const NEW_CHECKED = '2026-09-30T17:59:40+00:00'

/** searchFlightSchedules for 1 Oct: VB1392 and Y4140 both leave at 06:00. */
function trace(): ToolTraceEntry[] {
  const row = (flightNumber: string, carrierCode: string, arr: string) => ({
    origin: 'MEX',
    destination: 'GDL',
    departureAt: '2026-10-01T06:00:00-06:00',
    arrivalAt: `2026-10-01T${arr}:00-06:00`,
    carrierCode,
    flightNumber,
    sourceUrl: url('2026-10-01', flightNumber),
    checkedAt: NEW_CHECKED,
  })
  return [
    {
      tool: 'searchFlightSchedules',
      ok: true,
      args: { origin: 'MEX', destination: 'GDL', date: '2026-10-01', flights: [row('VB1392', 'VB', '07:16'), row('Y4140', 'Y4', '07:18')] },
      sources: [],
      checkedAt: NEW_CHECKED,
    },
  ]
}

function stamp(option: Record<string, unknown>) {
  const out = stampProvenScheduleOptions({ travelOptions: [option] }, trace())
  return (out.package.travelOptions as Record<string, unknown>[])[0]!
}

describe('schedule stamping keeps provenance on the right day and flight', () => {
  it('Y4140 re-used from 6 Oct and moved to 1 Oct gets the 1 Oct Y4140 schedule, not VB1392 nor the 6 Oct URL', () => {
    const o = stamp({
      externalId: 'outbound-flight-1',
      type: 'flight',
      title: 'Vuelo estimado Ciudad de México (MEX) a Guadalajara (GDL) el 6 de octubre de 2026',
      origin: 'MEX',
      destination: 'GDL',
      startAt: '2026-10-01T06:00:00-06:00',
      sourceType: 'flight_schedule',
      sourceUrl: url('2026-10-06', 'Y4140'),
      checkedAt: '2026-09-30T03:42:07+00:00',
    })
    assert.equal(o.sourceUrl, url('2026-10-01', 'Y4140'))
    assert.equal(o.checkedAt, NEW_CHECKED)
  })

  it('an option already citing its own day keeps its source', () => {
    const o = stamp({
      externalId: 'outbound-flight-20261001-y4140',
      type: 'flight',
      origin: 'MEX',
      destination: 'GDL',
      startAt: '2026-10-01T06:00:00-06:00',
      sourceUrl: url('2026-10-01', 'Y4140'),
      checkedAt: '2026-09-30T17:59:41+00:00',
    })
    assert.equal(o.sourceUrl, url('2026-10-01', 'Y4140'))
    assert.equal(o.checkedAt, '2026-09-30T17:59:41+00:00')
  })

  it('an option naming its flight in the title is matched to that flight', () => {
    const o = stamp({
      externalId: 'x',
      type: 'flight',
      title: 'Volaris Y4140 MEX → GDL',
      origin: 'MEX',
      destination: 'GDL',
      startAt: '2026-10-01T06:00:00-06:00',
    })
    assert.equal(o.sourceUrl, url('2026-10-01', 'Y4140'))
  })
})

describe('webSearch evidence window', () => {
  const realFetch = globalThis.fetch
  const realKey = process.env.TAVILY_API_KEY
  afterEach(() => {
    globalThis.fetch = realFetch
    if (realKey === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = realKey
  })

  it('keeps a contact block that sits past the first 400 characters of the result', async () => {
    const content =
      'Pueblos de México → Jalisco → Totatiche → Totatiche # Hotel Y Restaurant Don Rafa ⭐ Sé el primero en opinar [...] ' +
      'El equipo de Hotel Y Restaurant Don Rafa se asegurará de que usted tenga una agradable experiencia y disfrute la belleza de Totatiche. ' +
      'Toda la información online de Hotel Y Restaurant Don Rafa, situado en la localidad de Totatiche (Municipio: Totatiche , Estado: Jalisco ). ' +
      'Dirección de Hotel Y Restaurant Don Rafa :: Dirección: Calle Hidalgo, 13 (Centro) :: Código Postal: 46170 ' +
      'Teléfono para llamar a Hotel Y Restaurant Don Rafa :: Teléfono de reservas, consulta de precios: +52 4379640054 Opiniones'
    assert.ok(content.indexOf('+52 4379640054') > 400)
    process.env.TAVILY_API_KEY = 'test-placeholder'
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [{ title: 'Hotel Y Restaurant Don Rafa en Totatiche', url: 'https://mexico.pueblosamerica.com/h/hotel-y-restaurant-el-oasis', content }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch
    const { trace } = await webSearch('teléfono hoteles Totatiche', { provider: 'tavily' })
    const snippet = trace.sources[0]!.snippet ?? ''
    assert.match(snippet, /Calle Hidalgo, 13/)
    assert.ok(phoneNumbersIn(snippet).some((n) => phonesEquivalent(n, '+52 4379640054')))
  })
})

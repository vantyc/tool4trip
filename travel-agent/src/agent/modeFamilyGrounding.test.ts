import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import { validateClaimsAgainstToolTrace } from './claims.ts'

const SCHED = 'https://schedules.example/?origin=AAA&destination=BBB&date=2027-03-10&flight=XY123'
const BUS = 'https://routes.example/es/s/Ciudad-B/Pueblo-C'
const ANN = 'https://venue.example/avisos'
const trace: ToolTraceEntry[] = [
  {
    tool: 'searchFlightSchedules',
    args: { origin: 'AAA', destination: 'BBB', date: '2027-03-10' },
    ok: true,
    sources: [
      {
        url: SCHED,
        title: 'XY XY123 AAA→BBB',
        snippet:
          'vuelo XY123 AAA→BBB · dep 2027-03-10T06:00:00-06:00 arr 2027-03-10T07:16:00-06:00 (salida 06:00, llegada 07:16) · date 2027-03-10 · published schedule only',
      },
    ],
    checkedAt: '2027-03-01T10:00:00+00:00',
  },
  {
    tool: 'webSearch',
    args: { query: 'Ciudad B a Pueblo C' },
    ok: true,
    sources: [{ url: BUS, title: 'Ciudad B a Pueblo C', snippet: 'No hay autobús directo desde Ciudad B a Pueblo C.' }],
    checkedAt: '2027-03-01T10:00:00+00:00',
  },
  {
    tool: 'webSearch',
    args: { query: 'avisos' },
    ok: true,
    sources: [{ url: ANN, title: 'Avisos', snippet: 'El concierto del 12 de marzo fue cancelado.' }],
    checkedAt: '2027-03-01T10:00:00+00:00',
  },
]
const claim = (statement: string, sourceUrl: string) => ({
  kind: 'schedule' as const,
  statement,
  sourceType: 'web' as const,
  sourceUrl,
  evidenceIndex: 0,
  verificationStatus: 'estimated' as const,
  confidence: 'medium' as const,
})
const check = (statement: string, url: string) =>
  validateClaimsAgainstToolTrace([claim(statement, url)], trace)

describe('transport-mode grounding accepts the same word family (a737a0ac)', () => {
  it('"vuelos" is grounded by schedule evidence that says "vuelo"', () => {
    const r = check('Hay vuelos publicados AAA→BBB el 2027-03-10 (horario publicado, no disponibilidad).', SCHED)
    assert.deepEqual(r.invalid, [])
    assert.equal(r.valid.length, 1)
  })

  it('"flights" / "vuelo" are the same family', () => {
    assert.deepEqual(check('Published flights AAA→BBB on 2027-03-10.', SCHED).invalid, [])
    assert.deepEqual(check('Hay un vuelo publicado AAA→BBB el 2027-03-10.', SCHED).invalid, [])
  })

  it('"autobuses" family: "bus" statement is grounded by "autobús" evidence', () => {
    assert.deepEqual(check('No hay bus directo desde Ciudad B a Pueblo C.', BUS).invalid, [])
  })

  it('a different mode is still rejected', () => {
    assert.equal(check('Taxi AAA→BBB el 2027-03-10.', SCHED).invalid[0]?.code, 'transport_mode_ungrounded')
    assert.equal(check('Hay tren desde Ciudad B a Pueblo C.', BUS).invalid[0]?.code, 'transport_mode_ungrounded')
  })

  it('"vuelos" citing evidence without any flight word is still rejected', () => {
    const r = check('Hay vuelos desde Ciudad B a Pueblo C.', BUS)
    assert.equal(r.invalid[0]?.code, 'transport_mode_ungrounded')
    assert.match(r.invalid[0]!.message, /\[vuelos\]/)
  })
})

describe('status grounding accepts the same word family only', () => {
  it('"cancelada" is grounded by "cancelado"', () => {
    assert.deepEqual(check('La función del 12 de marzo está cancelada.', ANN).invalid, [])
  })

  it('a different status stays rejected ("suspendido" vs "cancelado", "confirmado")', () => {
    assert.equal(check('El concierto del 12 de marzo fue suspendido.', ANN).invalid[0]?.code, 'status_ungrounded')
    assert.equal(check('El concierto del 12 de marzo está confirmado.', ANN).invalid[0]?.code, 'status_ungrounded')
  })
})

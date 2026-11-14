import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Booking, TravelOption } from '../../domain/types'
import { filipinasNov2026Bundle } from '../../seed/filipinasNov2026'
import {
  baggageFromNotes,
  buildTripBoard,
  extractFlightNumber,
  stopTitle,
} from './buildTripBoard'

function filipinas(extra: TravelOption[] = [], bookings: Booking[] = [], now?: Date) {
  const b = filipinasNov2026Bundle()
  return buildTripBoard({
    trip: b.trip,
    options: [...b.travelOptions, ...extra],
    bookings,
    checklist: b.checklistItems,
    now,
  })
}

function lodging(partial: Partial<TravelOption> & { id: string }): TravelOption {
  return {
    tripId: 'filipinas-nov-2026',
    type: 'lodging',
    status: 'researched',
    budgetRole: 'pending',
    title: 'Pendiente — hotel',
    sourceType: 'manual',
    createdAt: '2026-11-05T10:00:00-06:00',
    updatedAt: '2026-11-05T10:00:00-06:00',
    syncStatus: 'synced',
    ...partial,
  }
}

describe('buildTripBoard — Filipinas guardado', () => {
  const board = filipinas()

  it('ordena la ruta CDMX → SFO → Manila → Cebú → El Nido → Manila → SFO → CDMX', () => {
    assert.deepEqual(
      board.stops.map((s) => `${s.kind}:${s.label}`),
      [
        'origin:Ciudad de México',
        'layover:San Francisco',
        'stay:Manila',
        'stay:Cebú',
        'stay:El Nido',
        'stay:Manila',
        'layover:San Francisco',
        'end:Ciudad de México',
      ],
    )
    assert.equal(board.legs.length, 7)
  })

  it('San Francisco es escala con tiempo de conexión, sin noches', () => {
    const sfoOut = board.stops[1]!
    const sfoBack = board.stops[6]!
    assert.equal(sfoOut.layoverMinutes, 5 * 60 + 21)
    assert.equal(sfoBack.layoverMinutes, 6 * 60 + 39)
    assert.equal(sfoOut.nights, undefined)
  })

  it('Manila aparece dos veces; Cebú y El Nido en medio', () => {
    const manilas = board.stops.filter((s) => s.label === 'Manila')
    assert.equal(manilas.length, 2)
    assert.deepEqual(
      manilas.map((s) => [s.visit, s.nights, stopTitle(s)]),
      [
        [1, 2, 'Manila · 1ª vez'],
        [2, 3, 'Manila · 2ª vez'],
      ],
    )
    assert.equal(manilas[0]!.arriveAt, '2026-11-17T21:10:00+08:00')
    assert.equal(manilas[1]!.departAt, '2026-11-28T09:55:00+08:00')
    assert.equal(board.stops[3]!.nights, 3)
    assert.equal(board.stops[3]!.status, 'booked')
    assert.equal(stopTitle(board.stops.at(-1)!), 'Ciudad de México · regreso')
  })

  it('El Nido tiene 3 noches y su hotel pendiente', () => {
    const eni = board.stops[4]!
    assert.equal(eni.nights, 3)
    assert.equal(eni.lodging[0]!.provider, 'Huni Lio')
    assert.equal(eni.status, 'pending')
    assert.ok(eni.pending.includes('Elegir cómo llegar'))
  })

  it('traslados internos: Cebú 19, El Nido 22, regreso 25 con rutas guardadas', () => {
    const toCeb = board.legs[2]!
    assert.equal(toCeb.dateHint, '2026-11-19')
    assert.deepEqual(
      toCeb.routes.map((r) => r.items.map((i) => `${i.origin}-${i.destination}`)),
      [['MNL-CEB']],
    )
    const toEni = board.legs[3]!
    assert.equal(toEni.dateHint, '2026-11-22')
    assert.deepEqual(
      toEni.routes.map((r) => r.items.map((i) => `${i.origin}-${i.destination}`)),
      [['CEB-ENI']],
    )
    const back = board.legs[4]!
    assert.equal(back.dateHint, '2026-11-25')
    assert.deepEqual(
      back.routes.map((r) => r.items.map((i) => `${i.origin}-${i.destination}`)),
      [
        ['ENI-CEB', 'CEB-MNL'],
        ['ENI-CRK', 'CRK-Manila'],
      ],
    )
  })

  it('vuelos United: número, duración, reservados y regreso en el boleto', () => {
    const mexSfo = board.legs[0]!
    const sfoMnl = board.legs[1]!
    const mnlSfo = board.legs[5]!
    const sfoMex = board.legs[6]!
    assert.equal(mexSfo.segments[0]!.flightNumber, 'UA822')
    assert.equal(mexSfo.durationMinutes, 4 * 60 + 59)
    assert.equal(sfoMnl.durationMinutes, 15 * 60 + 5)
    assert.equal(mnlSfo.segments[0]!.includedWith, 'UA809')
    assert.equal(sfoMex.segments[0]!.includedWith, 'UA822')
    assert.equal(mexSfo.status, 'booked')
    assert.equal(sfoMnl.status, 'booked')
  })

  it('alternativas United; Clark queda en el regreso El Nido→Manila', () => {
    assert.deepEqual(
      board.unplaced.map((u) => u.id).sort(),
      [
        'filipinas-nov-2026-alt-lax-mnl',
        'filipinas-nov-2026-alt-mex-lax',
        'filipinas-nov-2026-alt-mex-sfo-29',
        'filipinas-nov-2026-alt-sfo-mnl-29',
        'filipinas-nov-2026-alt-united-unico',
        'filipinas-nov-2026-p-car-mnl-crk',
        'filipinas-nov-2026-p-crk-eni',
      ].sort(),
    )
    assert.deepEqual(
      board.legs[1]!.extras.map((e) => e.id),
      ['filipinas-nov-2026-p-asiento'],
    )
  })

  it('resumen: calendario 16→28, cotizado United, sin hueco 15–16', () => {
    const s = board.summary
    assert.equal(s.startDate, '2026-11-16')
    assert.equal(s.endDate, '2026-11-28')
    assert.equal(s.nights, 12)
    assert.equal(s.quoted, 31628)
    assert.equal(s.paid, 0)
    assert.equal(s.toPay, 31628)
    assert.equal(s.startsAt, '2026-11-16T05:45:00-06:00')
    assert.equal(s.endsAt, '2026-11-28T19:35:00-06:00')
    assert.equal(s.quotedTransport, 31628)
    assert.equal(s.quotedLodging, 0)
    assert.equal(s.returnLimit, '2026-11-29')
    assert.deepEqual(board.alerts, [])
  })

  it('cada boleto United liga ida y regreso una vez', () => {
    assert.deepEqual(
      board.summary.tickets.map((t) => [t.label, t.price, t.roundTrip, t.legIds]),
      [
        ['UA822 + UA817', 13105, true, ['leg-1', 'leg-7']],
        ['UA809 + UA190', 18523, true, ['leg-2', 'leg-6']],
      ],
    )
    assert.deepEqual(board.legs[0]!.segments[0]!.includes, ['UA817'])
    assert.equal(board.legs[6]!.segments[0]!.includedWithId, 'filipinas-nov-2026-01-ua822')
  })

  it('pendientes: elegir tramos internos ya guardados y hoteles ENI/Manila 2', () => {
    assert.deepEqual(
      board.tasks.map((t) => `${t.group}: ${t.text}`),
      [
        'choose: Manila → Cebú',
        'choose: Cebú → El Nido',
        'choose: El Nido → Manila',
        'hotels: Hotel en El Nido',
        'hotels: Hotel en Manila · 2ª vez',
      ],
    )
  })

  it('avisa si el regreso pasa del límite', () => {
    const b = filipinasNov2026Bundle()
    const late = buildTripBoard({
      trip: { ...b.trip, endDate: '2026-11-27' },
      options: b.travelOptions,
    })
    assert.deepEqual(late.alerts.map((a) => a.text), [
      'El regreso llega el 28 nov, después del límite del viaje (27 nov).',
    ])
  })
})

describe('buildTripBoard — cambios', () => {
  it('un Cebú extra que se traslapa con El Nido genera aviso', () => {
    const board = filipinas([
      lodging({
        id: 'ceb-extra',
        title: 'Pendiente — hotel extra en Cebú',
        destination: 'Cebú',
        startAt: '2026-11-24T15:00:00+08:00',
        endAt: '2026-11-27T11:00:00+08:00',
      }),
    ])
    assert.ok(
      board.alerts.some((a) => /se traslapa con Cebú/.test(a.text)),
    )
  })

  it('una reserva confirmada marca el vuelo y cuenta lo pagado', () => {
    const booking: Booking = {
      id: 'bk-ua822',
      tripId: 'filipinas-nov-2026',
      type: 'flight',
      status: 'confirmed',
      title: 'United UA822 CDMX → San Francisco',
      confirmationNumber: 'ABC123',
      cost: 13105,
      currency: 'MXN',
      startAt: '2026-11-16T05:45:00-06:00',
      endAt: '2026-11-16T08:44:00-08:00',
      origin: 'MEX',
      destination: 'SFO',
      createdAt: '2026-11-05T10:00:00-06:00',
      updatedAt: '2026-11-05T10:00:00-06:00',
      syncStatus: 'synced',
    }
    const b = filipinasNov2026Bundle()
    const options = b.travelOptions.map((o) =>
      o.id === 'filipinas-nov-2026-01-ua822'
        ? { ...o, status: 'booked' as const, bookingId: booking.id }
        : o,
    )
    const board = buildTripBoard({ trip: b.trip, options, bookings: [booking] })
    const seg = board.legs[0]!.segments[0]!
    assert.equal(seg.status, 'booked')
    assert.equal(seg.confirmation, 'ABC123')
    assert.equal(board.legs[0]!.status, 'booked')
    assert.equal(board.summary.paid, 13105)
    assert.ok(board.summary.booked >= 2)
  })

  it('un hotel que empieza un día después de llegar deja noche sin hotel', () => {
    const b = filipinasNov2026Bundle()
    const options = b.travelOptions.map((o) =>
      o.id === 'filipinas-nov-2026-p-hotel-mnl-15'
        ? {
            ...o,
            status: 'selected' as const,
            priceObserved: 4200,
            currency: 'MXN',
            countsInBudget: true,
            startAt: '2026-11-18T15:00:00+08:00',
          }
        : o,
    )
    const board = buildTripBoard({ trip: b.trip, options })
    assert.ok(
      board.alerts.some((a) =>
        /Noche sin hotel en Manila \(1ª vez\): llegas el 17 nov y el hotel empieza el 18 nov/.test(
          a.text,
        ),
      ),
    )
  })

  it('marca la parada y el tramo en curso durante el viaje', () => {
    const inFlight = filipinas([], [], new Date('2026-11-16T23:00:00Z'))
    assert.equal(inFlight.legs[1]!.isNow, true)
    const inCebu = filipinas([], [], new Date('2026-11-20T04:00:00Z'))
    assert.equal(inCebu.stops.find((s) => s.isNow)?.label, 'Cebú')
  })

  it('sin vuelos, sólo hoteles, arma la ruta por fechas', () => {
    const b = filipinasNov2026Bundle()
    const board = buildTripBoard({
      trip: b.trip,
      options: b.travelOptions.filter((o) => o.type === 'lodging'),
    })
    assert.deepEqual(
      board.stops.map((s) => s.label),
      ['Manila', 'Cebú', 'El Nido', 'Manila'],
    )
    assert.equal(board.legs.length, 3)
  })
})

describe('helpers', () => {
  it('extrae números de vuelo del título', () => {
    assert.equal(extractFlightNumber('United UA822 CDMX → San Francisco'), 'UA822')
    assert.equal(extractFlightNumber('Cebu Pacific 5J 561'), '5J561')
    assert.equal(extractFlightNumber('Pendiente — Manila → El Nido vía Cebu'), undefined)
  })

  it('cita el equipaje desde las notas', () => {
    assert.equal(
      baggageFromNotes('Directo, 15 h. Incluye dos maletas de 23 kg. Asiento gratis.'),
      'Incluye dos maletas de 23 kg.',
    )
    assert.equal(baggageFromNotes('Sin datos.'), undefined)
  })
})

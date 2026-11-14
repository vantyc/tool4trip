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

  it('ordena la ruta CDMX → SFO → Manila → El Nido → Manila → SFO → CDMX', () => {
    assert.deepEqual(
      board.stops.map((s) => `${s.kind}:${s.label}`),
      [
        'origin:Ciudad de México',
        'layover:San Francisco',
        'stay:Manila',
        'stay:El Nido',
        'stay:Manila',
        'layover:San Francisco',
        'end:Ciudad de México',
      ],
    )
    assert.equal(board.legs.length, 6)
  })

  it('San Francisco es escala con tiempo de conexión, sin noches', () => {
    const [, sfoOut, , , , sfoBack] = board.stops
    assert.equal(sfoOut!.layoverMinutes, 5 * 60 + 21)
    assert.equal(sfoBack!.layoverMinutes, 6 * 60 + 39)
    assert.equal(sfoOut!.nights, undefined)
  })

  it('Manila aparece dos veces como estancias separadas', () => {
    const manilas = board.stops.filter((s) => s.label === 'Manila')
    assert.equal(manilas.length, 2)
    assert.deepEqual(
      manilas.map((s) => [s.visit, s.nights, stopTitle(s)]),
      [
        [1, 2, 'Manila · 1ª vez'],
        [2, 1, 'Manila · 2ª vez'],
      ],
    )
    assert.equal(manilas[0]!.arriveAt, '2026-11-15T21:10:00+08:00')
    assert.equal(manilas[1]!.departAt, '2026-11-28T09:55:00+08:00')
    assert.equal(stopTitle(board.stops.at(-1)!), 'Ciudad de México · regreso')
  })

  it('El Nido tiene 8 noches y su hotel pendiente', () => {
    const eni = board.stops[3]!
    assert.equal(eni.nights, 8)
    assert.equal(eni.lodging[0]!.provider, 'Huni Lio')
    assert.equal(eni.status, 'pending')
    assert.ok(eni.pending.includes('Elegir cómo llegar'))
  })

  it('los traslados a El Nido quedan por elegir con sus dos rutas', () => {
    const toEni = board.legs[2]!
    assert.equal(toEni.segments.length, 0)
    assert.equal(toEni.dateHint, '2026-11-19')
    assert.equal(toEni.mode, 'mixed')
    assert.deepEqual(
      toEni.routes.map((r) => r.items.map((i) => `${i.origin}-${i.destination}`)),
      [['MNL-ENI'], ['Manila-CRK', 'CRK-ENI']],
    )
    const back = board.legs[3]!
    assert.deepEqual(
      back.routes.map((r) => r.items.map((i) => `${i.origin}-${i.destination}`)),
      [['ENI-MNL'], ['ENI-CRK', 'CRK-Manila']],
    )
  })

  it('vuelos elegidos: número, duración y regreso incluido en el boleto', () => {
    const [mexSfo, sfoMnl, , , mnlSfo, sfoMex] = board.legs
    assert.equal(mexSfo!.segments[0]!.flightNumber, 'UA822')
    assert.equal(mexSfo!.durationMinutes, 4 * 60 + 59)
    assert.equal(sfoMnl!.durationMinutes, 15 * 60 + 5)
    assert.equal(mnlSfo!.segments[0]!.includedWith, 'UA809')
    assert.equal(sfoMex!.segments[0]!.includedWith, 'UA822')
    assert.equal(mexSfo!.status, 'quoted')
    assert.match(sfoMnl!.segments[0]!.baggage ?? '', /dos maletas de 23 kg/)
  })

  it('alternativas en su tramo; las de otra ruta quedan aparte', () => {
    assert.deepEqual(
      board.legs[0]!.alternatives.map((a) => a.id).sort(),
      ['filipinas-nov-2026-alt-mex-sfo-29', 'filipinas-nov-2026-alt-united-unico'],
    )
    assert.deepEqual(
      board.legs[1]!.alternatives.map((a) => a.id),
      ['filipinas-nov-2026-alt-sfo-mnl-29'],
    )
    assert.deepEqual(
      board.unplaced.map((u) => u.id).sort(),
      ['filipinas-nov-2026-alt-lax-mnl', 'filipinas-nov-2026-alt-mex-lax'],
    )
    assert.deepEqual(
      board.legs[1]!.extras.map((e) => e.id),
      ['filipinas-nov-2026-p-asiento'],
    )
  })

  it('resumen: fechas reales, cotizado, pagado y pendientes', () => {
    const s = board.summary
    assert.equal(s.startDate, '2026-11-14')
    assert.equal(s.endDate, '2026-11-28')
    assert.equal(s.nights, 14)
    assert.equal(s.quoted, 31628)
    assert.equal(s.paid, 0)
    assert.equal(s.toPay, 31628)
    assert.equal(s.startsAt, '2026-11-14T05:45:00-06:00')
    assert.equal(s.endsAt, '2026-11-28T19:35:00-06:00')
    assert.equal(s.quotedTransport, 31628)
    assert.equal(s.quotedLodging, 0)
    assert.deepEqual(s.missing, { hotels: 3, legs: 2, legsAreFlights: true })
  })

  it('cada boleto liga ida y regreso y cuenta su precio una vez', () => {
    assert.deepEqual(
      board.summary.tickets.map((t) => [t.label, t.price, t.roundTrip, t.withBaggage, t.legIds]),
      [
        ['UA822 + UA817', 13105, true, true, ['leg-1', 'leg-6']],
        ['UA809 + UA190', 18523, true, true, ['leg-2', 'leg-5']],
      ],
    )
    assert.deepEqual(board.legs[0]!.segments[0]!.includes, ['UA817'])
    assert.equal(board.legs[5]!.segments[0]!.includedWithId, 'filipinas-nov-2026-01-ua822')
  })

  it('pendientes concretos: traslados, hoteles y boletos por reservar', () => {
    assert.deepEqual(
      board.tasks.map((t) => `${t.group}: ${t.text}`),
      [
        'quote: Manila → El Nido',
        'quote: El Nido → Manila',
        'hotels: Hotel en El Nido',
        'hotels: Hotel en Manila · 2ª vez',
        'book: Boleto UA822 + UA817',
        'book: Boleto UA809 + UA190',
      ],
    )
    assert.equal(board.tasks[0]!.detail, '19 nov · 2 rutas guardadas, sin precio')
    assert.match(board.tasks.at(-1)!.detail!, /18,523 MXN · consultado 3 nov/)
  })

  it('el 29 es el límite de regreso: llegar el 28 no es un aviso', () => {
    assert.equal(board.summary.returnLimit, '2026-11-29')
    assert.deepEqual(
      board.alerts.map((a) => a.text),
      [
        'Noche sin hotel en Manila (1ª vez): llegas el 15 nov y el hotel empieza el 17 nov.',
      ],
    )
  })

  it('avisa si el regreso pasa del límite', () => {
    const b = filipinasNov2026Bundle()
    const late = buildTripBoard({
      trip: { ...b.trip, endDate: '2026-11-27' },
      options: b.travelOptions,
    })
    assert.deepEqual(
      late.alerts.map((a) => a.text),
      [
        'El regreso llega el 28 nov, después del límite del viaje (27 nov).',
        'Noche sin hotel en Manila (1ª vez): llegas el 15 nov y el hotel empieza el 17 nov.',
      ],
    )
  })

  it('estancias seguidas sin vuelo elegido pueden repartirse noches', () => {
    assert.deepEqual(
      board.splits.map((s) => [s.from, s.to, s.total, s.firstNights]),
      [
        ['2026-11-17', '2026-11-27', 10, 2],
        ['2026-11-19', '2026-11-28', 9, 8],
      ],
    )
  })
})

describe('buildTripBoard — cambios', () => {
  it('agregar Cebú crea la estancia, sus tramos y avisa el traslape con El Nido', () => {
    const board = filipinas([
      lodging({
        id: 'ceb',
        title: 'Pendiente — hotel en Cebú',
        destination: 'Cebú',
        startAt: '2026-11-24T15:00:00+08:00',
        endAt: '2026-11-27T11:00:00+08:00',
      }),
    ])
    assert.deepEqual(
      board.stops.map((s) => s.label),
      [
        'Ciudad de México',
        'San Francisco',
        'Manila',
        'El Nido',
        'Cebú',
        'Manila',
        'San Francisco',
        'Ciudad de México',
      ],
    )
    const ceb = board.stops[4]!
    assert.equal(ceb.nights, 3)
    const eniCeb = board.legs.find((l) => l.toStopId === ceb.id)!
    assert.equal(eniCeb.dateHint, '2026-11-24')
    assert.equal(eniCeb.routes.length, 0)
    assert.ok(
      board.alerts.some((a) => /El Nido \(hasta el 27 nov\) se traslapa con Cebú/.test(a.text)),
    )
    assert.ok(!board.alerts.some((a) => /antes de que termine el hotel/.test(a.text)))
  })

  it('una reserva confirmada marca el vuelo como reservado y cuenta lo pagado', () => {
    const booking: Booking = {
      id: 'bk-ua822',
      tripId: 'filipinas-nov-2026',
      type: 'flight',
      status: 'confirmed',
      title: 'United UA822 CDMX → San Francisco',
      confirmationNumber: 'ABC123',
      cost: 13105,
      currency: 'MXN',
      startAt: '2026-11-14T05:45:00-06:00',
      endAt: '2026-11-14T08:44:00-08:00',
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
    // UA822 booking + already-booked Airbnb Kanso
    assert.equal(board.summary.booked, 2)
    assert.deepEqual(
      board.tasks.filter((t) => t.group === 'book').map((t) => t.text),
      ['Boleto UA809 + UA190'],
    )
  })

  it('Cebú sin fechas va entre El Nido y Manila y reparte las noches de El Nido', () => {
    const board = filipinas([
      lodging({
        id: 'ceb',
        title: 'Pendiente — hotel en Cebú, fechas por definir',
        destination: 'Cebú',
        stayWindow: { from: '2026-11-19', to: '2026-11-27' },
      }),
    ])
    assert.deepEqual(
      board.stops.map((s) => stopTitle(s)),
      [
        'Ciudad de México',
        'San Francisco',
        'Manila · 1ª vez',
        'El Nido',
        'Cebú',
        'Manila · 2ª vez',
        'San Francisco',
        'Ciudad de México · regreso',
      ],
    )
    const [eni, ceb] = [board.stops[3]!, board.stops[4]!]
    assert.equal(eni.datesPending, true)
    assert.equal(eni.checkOut, undefined)
    assert.equal(eni.nights, undefined)
    assert.equal(ceb.datesPending, true)
    assert.deepEqual(ceb.window, { from: '2026-11-19', to: '2026-11-27' })
    assert.deepEqual(
      board.splits.map((s) => [s.firstStopId, s.secondStopId, s.total, s.firstNights]),
      [[eni.id, ceb.id, 8, undefined]],
    )
    const toCeb = board.legs.find((l) => l.toStopId === ceb.id)!
    const fromCeb = board.legs.find((l) => l.fromStopId === ceb.id)!
    assert.equal(toCeb.dateHint, undefined)
    assert.equal(fromCeb.dateHint, '2026-11-27')
    assert.ok(toCeb.related.some((r) => r.id === 'filipinas-nov-2026-p-eni-mnl-ceb'))
    assert.ok(!fromCeb.related.some((r) => r.role === 'alternative'))
    assert.deepEqual(board.tasks[0], {
      id: `dates-${ceb.id}`,
      group: 'dates',
      text: 'Elegir fechas de Cebú',
      detail: 'Repartir 8 noches entre El Nido y Cebú (19 nov – 27 nov)',
      stopId: ceb.id,
    })
    assert.deepEqual(
      board.alerts.filter((a) => a.level === 'warn').map((a) => a.text),
      [
        'Noche sin hotel en Manila (1ª vez): llegas el 15 nov y el hotel empieza el 17 nov.',
      ],
    )
  })

  it('un hotel elegido que empieza un día después de llegar deja una noche sin hotel', () => {
    const b = filipinasNov2026Bundle()
    const options = b.travelOptions.map((o) =>
      o.id === 'filipinas-nov-2026-p-hotel-mnl-15'
        ? {
            ...o,
            budgetRole: 'primary' as const,
            status: 'selected' as const,
            priceObserved: 4200,
            currency: 'MXN',
            startAt: '2026-11-16T15:00:00+08:00',
          }
        : o,
    )
    const board = buildTripBoard({ trip: b.trip, options })
    const manila = board.stops[2]!
    assert.equal(manila.status, 'quoted')
    assert.deepEqual(manila.pending, ['Reservar hotel', 'Elegir cómo salir'])
    assert.ok(
      board.alerts.some(
        (a) => a.text === 'Noche sin hotel en Manila (1ª vez): llegas el 15 nov y el hotel empieza el 16 nov.',
      ),
    )
  })

  it('marca la parada y el tramo en curso durante el viaje', () => {
    const inFlight = filipinas([], [], new Date('2026-11-14T23:00:00Z'))
    assert.equal(inFlight.legs[1]!.isNow, true)
    const inElNido = filipinas([], [], new Date('2026-11-20T04:00:00Z'))
    assert.equal(inElNido.stops.find((s) => s.isNow)?.label, 'El Nido')
  })

  it('sin vuelos, sólo hoteles, arma la ruta por fechas', () => {
    const b = filipinasNov2026Bundle()
    const board = buildTripBoard({
      trip: b.trip,
      options: b.travelOptions.filter((o) => o.type === 'lodging'),
    })
    assert.deepEqual(
      board.stops.map((s) => s.label),
      ['Manila', 'El Nido', 'Manila'],
    )
    assert.equal(board.legs.length, 2)
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

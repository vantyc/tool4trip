import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Booking, TravelOption } from '../../domain/types'
import { filipinasNov2026Bundle } from '../../seed/filipinasNov2026'
import { buildTripBoard } from './buildTripBoard'
import {
  applyPlan,
  canSwapAlternative,
  chooseLodgingPlan,
  chooseRoutePlan,
  markOptionBooked,
  newLegOption,
  newStayOption,
  saveOptionEdit,
  splitNightsPlan,
  stayDatesPlan,
  swapAlternativePlan,
} from './boardEdits'

function board() {
  const b = filipinasNov2026Bundle()
  return buildTripBoard({ trip: b.trip, options: b.travelOptions })
}

function memoryServices(seed: TravelOption[]) {
  const options = new Map(seed.map((o) => [o.id, structuredClone(o)]))
  const bookings = new Map<string, Booking>()
  const calls: string[] = []
  return {
    options,
    bookings,
    calls,
    travelOptions: {
      get: async (id: string) => options.get(id),
      save: async (o: TravelOption) => {
        calls.push(`save:${o.id}`)
        options.set(o.id, o)
        return o
      },
      updateQuote: async (
        id: string,
        patch: { priceObserved?: number | null; currency?: string },
      ) => {
        calls.push(`quote:${id}`)
        const prev = options.get(id)!
        const next: TravelOption = {
          ...prev,
          priceObserved:
            patch.priceObserved === null ? undefined : (patch.priceObserved ?? prev.priceObserved),
          currency: patch.currency ?? prev.currency,
          priceHistory:
            prev.priceObserved !== undefined
              ? [...(prev.priceHistory ?? []), { amount: prev.priceObserved, currency: prev.currency ?? 'MXN', checkedAt: prev.checkedAt ?? '' }]
              : prev.priceHistory,
        }
        options.set(id, next)
        return next
      },
      convertToBooking: async (id: string) => {
        const o = options.get(id)!
        const booking: Booking = {
          id: `bk-${id}`,
          tripId: o.tripId,
          type: 'lodging',
          status: 'selected',
          title: o.title,
          cost: o.priceObserved,
          currency: o.currency,
          createdAt: '',
          updatedAt: '',
          syncStatus: 'synced',
        }
        const linked = { ...o, status: 'booked' as const, bookingId: booking.id }
        options.set(id, linked)
        bookings.set(booking.id, booking)
        return { option: linked, booking }
      },
    },
    bookingsService: {
      save: async (b: Booking) => {
        bookings.set(b.id, b)
        return b
      },
    },
  }
}

describe('boardEdits', () => {
  it('elegir la ruta por Clark en El Nido→Manila deja Cebú como alternativa', () => {
    const leg = board().legs.find((l) => l.fromLabel === 'El Nido' && l.toLabel === 'Manila')!
    assert.ok(leg.routes.length >= 2)
    const plan = chooseRoutePlan(leg, leg.routes[1]!.id)
    assert.deepEqual(
      plan.map((c) => [c.option.id, c.patch.budgetRole]),
      [
        ['filipinas-nov-2026-p-eni-ceb', 'alternative'],
        ['filipinas-nov-2026-p-ceb-mnl', 'alternative'],
        ['filipinas-nov-2026-p-eni-crk', 'primary'],
        ['filipinas-nov-2026-p-car-crk-mnl', 'primary'],
      ],
    )
  })

  it('elegir un hotel lo vuelve principal y aparta a los demás de la estancia', () => {
    const b = filipinasNov2026Bundle()
    // Booked lodging is locked; demotion only applies among non-booked options.
    const options = b.travelOptions.map((o) =>
      o.id === 'filipinas-nov-2026-p-hotel-mnl-15'
        ? {
            ...o,
            status: 'researched' as const,
            budgetRole: 'pending' as const,
            title: 'Pendiente — hotel en Manila, 17 al 19 nov 2026',
            provider: 'Seda BGC',
          }
        : o,
    )
    const okura = {
      ...options.find((o) => o.id === 'filipinas-nov-2026-p-hotel-mnl-15')!,
      id: 'okura-15',
      externalId: 'okura-15',
      provider: 'Okura Manila',
      priceObserved: 9800,
      currency: 'MXN',
    }
    const stop = buildTripBoard({ trip: b.trip, options: [...options, okura] }).stops[2]!
    assert.equal(stop.lodging.length, 2)
    assert.deepEqual(
      chooseLodgingPlan(stop, 'okura-15').map((c) => [c.option.id, c.patch.budgetRole]),
      [
        ['okura-15', 'primary'],
        ['filipinas-nov-2026-p-hotel-mnl-15', 'alternative'],
      ],
    )
  })

  it('una alternativa redonda no reemplaza un tramo sencillo', () => {
    const b = filipinasNov2026Bundle()
    // Unlock United so round-trip alts attach to the leg.
    const options = b.travelOptions.map((o) =>
      o.id.startsWith('filipinas-nov-2026-0')
        ? { ...o, status: 'selected' as const }
        : o,
    )
    const leg = buildTripBoard({ trip: b.trip, options }).legs[0]!
    for (const alt of leg.alternatives) assert.equal(canSwapAlternative(leg, alt), false)
    if (leg.alternatives[0]) {
      assert.deepEqual(swapAlternativePlan(leg, leg.alternatives[0].id), [])
    }
  })

  it('una alternativa sencilla del mismo tramo sí se intercambia', () => {
    const b = filipinasNov2026Bundle()
    const options = b.travelOptions.map((o) =>
      o.id === 'filipinas-nov-2026-01-ua822'
        ? { ...o, status: 'selected' as const }
        : o,
    )
    const oneWay: TravelOption = {
      ...options.find((o) => o.id === 'filipinas-nov-2026-01-ua822')!,
      id: 'am-mex-sfo',
      externalId: 'am-mex-sfo',
      budgetRole: 'alternative',
      status: 'shortlisted',
      title: 'Aeroméxico AM668 CDMX → San Francisco',
      startAt: '2026-11-16T07:00:00-06:00',
      endAt: '2026-11-16T09:30:00-08:00',
    }
    const leg = buildTripBoard({ trip: b.trip, options: [...options, oneWay] }).legs[0]!
    assert.deepEqual(
      swapAlternativePlan(leg, 'am-mex-sfo').map((c) => [c.option.id, c.patch.budgetRole]),
      [
        ['am-mex-sfo', 'primary'],
        ['filipinas-nov-2026-01-ua822', 'alternative'],
      ],
    )
  })

  it('nueva estancia en Cebú con horas locales de Filipinas', () => {
    const o = newStayOption('filipinas-nov-2026', {
      place: 'Cebú',
      checkIn: '2026-11-24',
      checkOut: '2026-11-27',
    })
    assert.equal(o.type, 'lodging')
    assert.equal(o.budgetRole, 'pending')
    assert.equal(o.startAt, '2026-11-24T15:00:00+08:00')
    assert.equal(o.endAt, '2026-11-27T11:00:00+08:00')
    assert.equal(o.title, 'Pendiente — hotel en Cebú, 24 al 27 nov 2026')
  })

  it('nueva opción para un tramo queda pendiente', () => {
    const o = newLegOption('t', { type: 'flight', origin: 'ENI', destination: 'CEB', date: '2026-11-24' })
    assert.equal(o.title, 'Pendiente — ENI → CEB, 2026-11-24')
    assert.equal(o.budgetRole, 'pending')
    assert.equal(o.currency, undefined)
  })

  it('editar el precio guarda la cotización anterior y luego el resto', async () => {
    const b = filipinasNov2026Bundle()
    const svc = memoryServices(b.travelOptions)
    const ua822 = svc.options.get('filipinas-nov-2026-01-ua822')!
    await saveOptionEdit(svc.travelOptions, ua822, { priceObserved: 13500, notes: 'nota' })
    const saved = svc.options.get(ua822.id)!
    assert.deepEqual(svc.calls, [`quote:${ua822.id}`, `save:${ua822.id}`])
    assert.equal(saved.priceObserved, 13500)
    assert.equal(saved.priceHistory?.at(-1)?.amount, 13105)
    assert.equal(saved.notes, 'nota')
  })

  it('reservar sin pago completo deja el costo fuera de la reserva y anota lo pagado', async () => {
    const b = filipinasNov2026Bundle()
    const hotel = { ...b.travelOptions.find((o) => o.id === 'filipinas-nov-2026-p-hotel-eni')!, priceObserved: 20000, currency: 'MXN' }
    const svc = memoryServices([hotel])
    await markOptionBooked(
      { travelOptions: svc.travelOptions, bookings: svc.bookingsService },
      hotel,
      { confirmation: ' HL-77 ', fullyPaid: false, amountPaid: 5000 },
    )
    const booking = svc.bookings.get(`bk-${hotel.id}`)!
    assert.equal(booking.status, 'booked')
    assert.equal(booking.confirmationNumber, 'HL-77')
    assert.equal(booking.cost, undefined)
    assert.equal(svc.options.get(hotel.id)!.amountPaid, 5000)

    const after = buildTripBoard({
      trip: b.trip,
      options: [svc.options.get(hotel.id)!],
      bookings: [booking],
    })
    const item = after.stops[0]!.lodging[0]!
    assert.equal(svc.options.get(hotel.id)!.budgetRole, 'primary')
    assert.equal(item.role, 'chosen')
    assert.equal(item.status, 'booked')
    assert.equal(after.stops[0]!.status, 'booked')
    assert.equal(item.price, 20000)
    assert.equal(item.paid, 5000)
  })

  it('repartir noches entre El Nido y un Cebú sin fechas (ventana 22–25)', async () => {
    const b = filipinasNov2026Bundle()
    // Drop booked Cebú lodging so the undated Cebú can split with El Nido.
    const base = b.travelOptions.filter((o) => o.id !== 'filipinas-nov-2026-p-hotel-ceb')
    const ceb = newStayOption(b.trip.id, {
      place: 'Cebú',
      window: { from: '2026-11-22', to: '2026-11-25' },
    })
    const seed = [...base, ceb]
    const before = buildTripBoard({ trip: b.trip, options: seed })
    const split = before.splits.find((s) => s.firstNights === undefined)!
    assert.ok(split)
    const plan = splitNightsPlan(before, split, 2)
    assert.equal(plan.length, 2)
    const svc = memoryServices(seed)
    await applyPlan(svc.travelOptions, plan)
    const saved = [...svc.options.values()].map((o) => JSON.parse(JSON.stringify(o)) as TravelOption)
    const after = buildTripBoard({ trip: b.trip, options: saved })
    assert.ok(after.stops.some((s) => s.label === 'Cebú' && s.nights !== undefined))
    assert.ok(after.stops.some((s) => s.label === 'El Nido'))
  })

  it('cambiar fechas de una estancia mueve todos sus hoteles y conserva la hora', () => {
    const b = filipinasNov2026Bundle()
    // Booked stays lock dates; unlock Kanso for this edit-path check.
    const options = b.travelOptions.map((o) =>
      o.id === 'filipinas-nov-2026-p-hotel-mnl-15'
        ? {
            ...o,
            status: 'researched' as const,
            budgetRole: 'pending' as const,
            title: 'Pendiente — hotel en Manila, 17 al 19 nov 2026',
          }
        : o,
    )
    const stop = buildTripBoard({ trip: b.trip, options }).stops[2]!
    const plan = stayDatesPlan(stop, '2026-11-17', '2026-11-20')
    assert.deepEqual(
      plan.map((c) => [c.option.id, c.patch.startAt, c.patch.endAt, c.patch.title]),
      [
        [
          'filipinas-nov-2026-p-hotel-mnl-15',
          '2026-11-17T15:00:00+08:00',
          '2026-11-20T11:00:00+08:00',
          'Pendiente — hotel en Manila, 17 al 20 nov 2026',
        ],
      ],
    )
    assert.deepEqual(stayDatesPlan(stop, '2026-11-20', '2026-11-20'), [])
  })
})

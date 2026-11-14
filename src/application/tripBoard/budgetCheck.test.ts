import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TravelOption } from '../../domain/types'
import { filipinasNov2026Bundle } from '../../seed/filipinasNov2026'
import { checkBudget } from './budgetCheck'
import { buildTripBoard } from './buildTripBoard'

function board(edit: (options: TravelOption[]) => TravelOption[] = (o) => o) {
  const b = filipinasNov2026Bundle()
  return buildTripBoard({
    trip: b.trip,
    options: edit(b.travelOptions),
    bookings: [],
    checklist: b.checklistItems,
  })
}

function priced(id: string, price: number) {
  return (options: TravelOption[]) =>
    options.map((o) => (o.id === id ? { ...o, priceObserved: price, currency: 'MXN' } : o))
}

describe('checkBudget', () => {
  it('gastos del plan = lo cotizado; lo que no tiene precio queda listado', () => {
    const check = checkBudget(board(), { cap: 93000, currency: 'MXN' })
    assert.equal(check.quoted, 31628)
    assert.equal(check.quotedTransport, 31628)
    assert.equal(check.quotedLodging, 0)
    assert.equal(check.total, 31628)
    assert.equal(check.remaining, 61372)
    assert.equal(check.over, false)
    assert.deepEqual(check.projected, [])
    assert.deepEqual(
      check.unpriced.map((l) => l.text),
      [
        'Hotel Airbnb — Abyzz y Gavt (Manila · 1ª vez)',
        'Hotel en El Nido',
        'Hotel en Manila · 2ª vez',
        'Manila → El Nido',
        'El Nido → Manila',
      ],
    )
  })

  it('avisa cuando el total pasa del tope', () => {
    const check = checkBudget(board(), { cap: 30000, currency: 'MXN' })
    assert.equal(check.over, true)
    assert.equal(check.remaining, -1628)
  })

  it('sin tope solo calcula los gastos del plan', () => {
    const check = checkBudget(board(), { currency: 'MXN' })
    assert.equal(check.total, 31628)
    assert.equal(check.remaining, undefined)
    assert.equal(check.over, false)
  })

  it('proyecta el candidato de hotel con precio en una estancia sin elegir', () => {
    const check = checkBudget(board(priced('filipinas-nov-2026-p-hotel-eni', 28000)), {
      cap: 93000,
      currency: 'MXN',
    })
    assert.deepEqual(
      check.projected.map((l) => [l.text, l.amount]),
      [['Hotel en El Nido: Huni Lio', 28000]],
    )
    assert.equal(check.total, 31628 + 28000)
    assert.ok(!check.unpriced.some((l) => l.text === 'Hotel en El Nido'))
  })

  it('en un tramo sin elegir toma la ruta con precio más barata', () => {
    const check = checkBudget(
      board((o) => priced('filipinas-nov-2026-p-mnl-eni-ceb', 2500)(o)),
      { cap: 93000, currency: 'MXN' },
    )
    assert.deepEqual(
      check.projected.map((l) => [l.text, l.amount]),
      [['Manila → El Nido', 2500]],
    )
  })

  it('no mezcla monedas: lo cotizado en otra moneda queda aparte', () => {
    const check = checkBudget(board(), { cap: 5000, currency: 'USD' })
    assert.equal(check.quoted, 0)
    assert.deepEqual(
      check.otherCurrency.map((l) => [l.text, l.amount, l.currency]),
      [['Subtotal cotizado', 31628, 'MXN']],
    )
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { guestAccess, guestDenial, guestVisible } from './ownership.ts'

const guest = guestAccess('nane', 'nane', 'filipinas-nov-2026, otro')!

describe('guestAccess', () => {
  it('solo reconoce al usuario invitado configurado', () => {
    assert.equal(guestAccess('dueño', 'nane', 'filipinas-nov-2026'), null)
    assert.equal(guestAccess('nane', undefined, 'filipinas-nov-2026'), null)
    assert.equal(guestAccess(undefined, 'nane', 'filipinas-nov-2026'), null)
    assert.deepEqual([...guest.trips], ['filipinas-nov-2026', 'otro'])
  })

  it('sin viajes compartidos no ve ninguno', () => {
    const g = guestAccess('nane', 'nane', '')!
    assert.equal(g.trips.size, 0)
    assert.deepEqual(guestDenial(g, 'GET', { kind: 'trip', tripId: 'filipinas-nov-2026' })?.status, 404)
  })
})

describe('guestDenial', () => {
  it('lee el viaje compartido y sus colecciones', () => {
    assert.equal(guestDenial(guest, 'GET', { kind: 'trips' }), null)
    assert.equal(guestDenial(guest, 'GET', { kind: 'trip', tripId: 'filipinas-nov-2026' }), null)
    assert.equal(guestDenial(guest, 'GET', { kind: 'collection', tripId: 'filipinas-nov-2026' }), null)
  })

  it('no puede escribir ni borrar nada', () => {
    for (const method of ['PUT', 'PATCH', 'POST', 'DELETE']) {
      assert.equal(guestDenial(guest, method, { kind: 'trip', tripId: 'filipinas-nov-2026' })?.status, 403)
      assert.equal(guestDenial(guest, method, { kind: 'byId' })?.status, 403)
    }
  })

  it('no importa paquetes ni pide vistas previas', () => {
    assert.equal(guestDenial(guest, 'GET', { kind: 'compile-preview', tripId: 'filipinas-nov-2026' })?.status, 403)
    assert.equal(guestDenial(guest, 'GET', { kind: 'migrate' })?.status, 403)
  })

  it('otro viaje no existe para la invitada', () => {
    assert.equal(guestDenial(guest, 'GET', { kind: 'trip', tripId: 'totatiche' })?.status, 404)
    assert.equal(guestDenial(guest, 'GET', { kind: 'entity', tripId: 'totatiche' })?.status, 404)
  })
})

describe('guestVisible', () => {
  it('filtra filas de otros viajes', () => {
    const rows = [{ tripId: 'filipinas-nov-2026' }, { tripId: 'totatiche' }, {}]
    assert.deepEqual(guestVisible(guest, rows), [{ tripId: 'filipinas-nov-2026' }])
    assert.equal(guestVisible(null, rows).length, 3)
  })
})

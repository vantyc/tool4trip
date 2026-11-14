import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  cancelTripDeletion,
  confirmTripDeletion,
  initialTripDeletion,
  requestTripDeletion,
  visibleTrips,
} from './tripDeletion.ts'

const trips = [
  { id: 'a', title: 'Viaje a San Miguel el Alto para serenata 2026' },
  { id: 'b', title: 'Viaje a Filipinas noviembre-diciembre' },
]

function recorder(fail?: Error) {
  const calls: string[] = []
  return {
    calls,
    remove: async (id: string) => {
      calls.push(id)
      if (fail) throw fail
    },
  }
}

describe('trip deletion from the trip list', () => {
  it('asking to delete does not delete; cancel keeps the trip', async () => {
    const r = recorder()
    let s = requestTripDeletion(initialTripDeletion, trips[0]!)
    assert.deepEqual(s.pending, { id: 'a', title: trips[0]!.title })
    s = cancelTripDeletion(s)
    assert.equal(s.pending, null)
    assert.deepEqual(r.calls, [])
    assert.deepEqual(visibleTrips(trips, s), trips)
    // Confirming after cancel is a no-op.
    s = await confirmTripDeletion(s, r.remove)
    assert.deepEqual(r.calls, [])
  })

  it('confirm deletes on the backend and the trip leaves the list', async () => {
    const r = recorder()
    let s = requestTripDeletion(initialTripDeletion, trips[0]!)
    s = await confirmTripDeletion(s, r.remove)
    assert.deepEqual(r.calls, ['a'])
    assert.equal(s.pending, null)
    assert.equal(s.error, null)
    assert.deepEqual(visibleTrips(trips, s), [trips[1]])
  })

  it('backend error keeps the trip and shows a clear error', async () => {
    const r = recorder(new Error('HTTP 500'))
    let s = requestTripDeletion(initialTripDeletion, trips[1]!)
    s = await confirmTripDeletion(s, r.remove)
    assert.deepEqual(r.calls, ['b'])
    assert.deepEqual(visibleTrips(trips, s), trips)
    assert.match(s.error ?? '', /No se pudo eliminar "Viaje a Filipinas noviembre-diciembre" \(HTTP 500\)\. El viaje sigue guardado\./)
  })
})

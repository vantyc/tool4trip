import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { placeKey, placeLabel, resolvePlace } from './places'
import {
  daysBetween,
  formatDayEs,
  formatDuration,
  offsetForZone,
  wallToIso,
} from './time'

describe('places', () => {
  it('une aeropuerto, ciudad y dirección en la misma parada', () => {
    assert.equal(placeKey('MNL'), placeKey('Manila'))
    assert.equal(placeKey('Bonifacio Global City, Taguig'), placeKey('MNL'))
    assert.equal(placeKey('CDMX'), placeKey('MEX'))
    assert.equal(placeKey('El Nido'), placeKey('ENI'))
    assert.equal(placeKey('Cebú'), placeKey('CEB'))
    assert.notEqual(placeKey('CRK'), placeKey('MNL'))
  })

  it('lugares desconocidos comparan por nombre normalizado', () => {
    assert.equal(resolvePlace('Totatiche'), undefined)
    assert.equal(placeKey('Totatiche'), placeKey('totatiche'))
    assert.equal(placeLabel('Totatiche'), 'Totatiche')
  })

  it('"Los Angeles" no se confunde con Angeles (Clark)', () => {
    assert.equal(resolvePlace('Los Angeles, CA')?.code, 'LAX')
  })
})

describe('time', () => {
  it('duraciones y días', () => {
    assert.equal(formatDuration(905), '15 h 05 min')
    assert.equal(formatDuration(45), '45 min')
    assert.equal(formatDuration(120), '2 h')
    assert.equal(daysBetween('2026-11-17', '2026-11-27'), 10)
    assert.equal(formatDayEs('2026-11-14T05:45:00-06:00'), 'sáb 14 nov')
  })

  it('offset de la zona del lugar, con horario de verano', () => {
    assert.equal(offsetForZone('Asia/Manila', '2026-11-17T10:00'), '+08:00')
    assert.equal(offsetForZone('America/Los_Angeles', '2026-11-14T14:05'), '-08:00')
    assert.equal(offsetForZone('America/Los_Angeles', '2026-07-14T14:05'), '-07:00')
    assert.equal(
      wallToIso('2026-11-17T10:30', { tz: 'Asia/Manila' }),
      '2026-11-17T10:30:00+08:00',
    )
    assert.equal(
      wallToIso('2026-11-17T10:30', { fallbackOffset: '-06:00' }),
      '2026-11-17T10:30:00-06:00',
    )
  })
})

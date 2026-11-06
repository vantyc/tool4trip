import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { printDocumentTitle } from './printTitle.ts'

describe('printDocumentTitle', () => {
  const at = new Date(2026, 9, 18, 19, 5)

  it('names the trip and the local time', () => {
    assert.equal(
      printDocumentTitle('Viaje a Filipinas 14 noches noviembre 2026', at),
      'Tool4Trip - Viaje a Filipinas 14 noches noviembre 2026 - 2026-10-18 1905',
    )
  })

  it('drops path characters and long tails', () => {
    const t = printDocumentTitle('CDMX / Manila: "ida" ' + 'x'.repeat(200), at)
    assert.doesNotMatch(t, /[\\/:*?"<>|]/)
    assert.ok(t.length <= 'Tool4Trip - '.length + 80 + ' - 2026-10-18 1905'.length)
  })

  it('without a subject keeps brand and time', () => {
    assert.equal(printDocumentTitle('  ', at), 'Tool4Trip - 2026-10-18 1905')
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildCanonicalNarrative,
  collectStructuredEvidence,
  countCanonicalDiff,
  detectDependencyWarnings,
  flightScheduleConfidenceLabels,
  formatDateLongEs,
  isEmptyEvidenceValue,
} from './askTravelProposalView.ts'

describe('askTravelProposalView', () => {
  it('formats full Spanish dates', () => {
    assert.equal(
      formatDateLongEs('2026-09-24'),
      '24 de septiembre de 2026',
    )
    assert.equal(
      formatDateLongEs('2026-09-29'),
      '29 de septiembre de 2026',
    )
  })

  it('canonical narrative uses full trip window dates and never invents GDL alt', () => {
    const narrative = buildCanonicalNarrative({
      tripTitle: 'Viaje a San Miguel el Alto para serenata 2026',
      currentWindow: { startDate: '2026-09-25', endDate: '2026-10-01' },
      proposedWindow: { startDate: '2026-09-24', endDate: '2026-09-29' },
      diff: [
        {
          kind: 'update',
          entityKind: 'trip',
          externalId: 'trip-1',
          fields: [
            { field: 'endDate', before: '2026-10-01', after: '2026-09-29' },
          ],
        },
        {
          kind: 'remove',
          entityKind: 'travelOption',
          externalId: 'outbound-flight-25sep',
        },
        {
          kind: 'remove',
          entityKind: 'travelOption',
          externalId: 'return-flight-01oct',
        },
        {
          kind: 'add',
          entityKind: 'travelOption',
          externalId: 'outbound-flight-24sep',
          note: 'VB1392',
        },
        {
          kind: 'add',
          entityKind: 'travelOption',
          externalId: 'return-flight-29sep',
          note: 'AM201',
        },
        {
          kind: 'update',
          entityKind: 'travelOption',
          externalId: 'lodge-skeleton-1',
          fields: [
            {
              field: 'title',
              before: '3 noche(s)',
              after: '5 noche(s)',
            },
          ],
        },
      ],
      normalizedOptions: [
        {
          externalId: 'outbound-flight-24sep',
          type: 'flight',
          title: 'VB1392',
        },
        {
          externalId: 'return-flight-29sep',
          type: 'flight',
          title: 'AM201',
        },
        {
          externalId: 'lodge-skeleton-1',
          type: 'lodging',
          title: 'Hospedaje 5 noche(s)',
        },
        {
          externalId: 'ground-transfer-1',
          type: 'transfer',
          title: 'Traslado Guadalajara → San Miguel el Alto',
        },
      ],
    })
    assert.match(narrative, /salida el 24 de septiembre de 2026/)
    assert.match(narrative, /regreso el 29 de septiembre de 2026/)
    assert.equal(/alternativa en Guadalajara/i.test(narrative), false)
    assert.equal(/aldurante/i.test(narrative), false)
  })

  it('counts 2 add + 2 update + 2 remove = 6 from canonical diff', () => {
    const counts = countCanonicalDiff(
      [
        { kind: 'remove', entityKind: 'travelOption', externalId: 'a' },
        { kind: 'remove', entityKind: 'travelOption', externalId: 'b' },
        { kind: 'update', entityKind: 'trip', externalId: 't' },
        { kind: 'update', entityKind: 'travelOption', externalId: 'lodge' },
        { kind: 'add', entityKind: 'travelOption', externalId: 'c' },
        { kind: 'add', entityKind: 'travelOption', externalId: 'd' },
      ],
      4,
    )
    assert.equal(counts.adds, 2)
    assert.equal(counts.updates, 2)
    assert.equal(counts.removes, 2)
    assert.equal(counts.totalOps, 6)
  })

  it('detects missing return transfer and checkout after early departure', () => {
    const warnings = detectDependencyWarnings([
      {
        externalId: 'lodge-skeleton-1',
        type: 'lodging',
        title: 'Hospedaje San Miguel',
        startAt: '2026-09-24T15:00:00-06:00',
        endAt: '2026-09-29T12:00:00-06:00',
      },
      {
        externalId: 'ground-transfer-1',
        type: 'transfer',
        title: 'Traslado terrestre estimado Guadalajara → San Miguel el Alto',
        origin: 'GDL',
        destination: 'San Miguel el Alto',
      },
      {
        externalId: 'return-flight-29sep-am201',
        type: 'flight',
        title: 'AM201',
        origin: 'GDL',
        destination: 'MEX',
        startAt: '2026-09-29T05:47:00-06:00',
        endAt: '2026-09-29T07:15:00-06:00',
        sourceType: 'flight_schedule',
      },
    ])
    assert.ok(warnings.some((w) => w.code === 'missing_return_transfer'))
    assert.ok(warnings.some((w) => w.code === 'checkout_after_departure'))
    assert.ok(warnings.some((w) => w.code === 'early_return_needs_gdl_night'))
  })

  it('labels flight_schedule as horario verificado with UNKNOWN price/availability', () => {
    const labels = flightScheduleConfidenceLabels({
      type: 'flight',
      sourceType: 'flight_schedule',
      sourceUrl: 'https://aerodatabox.com/?flight=AM201',
      checkedAt: '2026-09-23T12:00:00Z',
    })
    assert.deepEqual(labels, [
      'horario verificado',
      'precio UNKNOWN',
      'disponibilidad UNKNOWN',
      'equipaje UNKNOWN',
    ])
  })

  it('filters empty evidence / markdown noise and reports none', () => {
    assert.equal(isEmptyEvidenceValue('---'), true)
    assert.equal(isEmptyEvidenceValue('| |'), true)
    assert.equal(isEmptyEvidenceValue('*'), true)
    assert.equal(isEmptyEvidenceValue(''), true)
    const rows = collectStructuredEvidence({
      warnings: ['', '---', 'server: ok'],
      diffSummary: [
        { entityKind: 'travelOption', before: '—', after: '—', note: '' },
        {
          entityKind: 'travelOption',
          entityRef: 'lodge-skeleton-1',
          op: 'update',
          before: '3',
          after: '5',
          note: 'noches',
        },
      ],
      toolTrace: [
        { tool: 'searchFlightSchedules', ok: true, sources: [{ title: '' }] },
      ],
    })
    assert.ok(rows.some((r) => r.title.includes('server: ok')))
    assert.ok(rows.some((r) => /lodge-skeleton-1/.test(r.title)))
    assert.equal(
      rows.some((r) => isEmptyEvidenceValue(r.title) && !r.detail),
      false,
    )
  })
})

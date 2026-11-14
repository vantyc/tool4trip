import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import {
  assertDraftGrounded,
  extractOperationalSignals,
  scrubOperationalFreeText,
} from './claims.ts'

const trace: ToolTraceEntry[] = [
  {
    tool: 'webSearch',
    args: { query: 'hospedaje Pueblo C' },
    ok: true,
    sources: [{ url: 'https://lodging.example/pueblo-c', title: 'Hoteles en Pueblo C', snippet: 'Hay 2 hoteles en Pueblo C.' }],
    checkedAt: '2027-03-01T10:00:00+00:00',
  },
]
const context = {
  trip: { id: 'trip-1', title: 'Viaje a Pueblo C', startDate: '2027-03-12', endDate: '2027-03-15' },
  travelOptions: [
    { id: 'opt-pkg-1-lodging-main', externalId: 'lodging-main', type: 'lodging', title: 'Hospedaje en Pueblo C' },
    { id: 'opt-pkg-1-transfer-arrival', externalId: 'transfer-arrival', type: 'transfer', title: 'Traslado terrestre Ciudad B → Pueblo C' },
  ],
  itineraryItems: [],
  checklistItems: [],
  notes: [],
  bookings: [],
  packageImports: [],
} as never

const WINDOW = 'Se actualiza la ventana del viaje del 10 al 15 de marzo de 2027.'
const KEEP_TRANSFER = 'Se conserva el traslado terrestre Ciudad B → Pueblo C, pendiente de confirmar.'
const GOAL = 'El objetivo principal sigue siendo el evento en Pueblo C.'

const draftWith = (narrative: string, travelOptions: unknown[]) => ({
  narrative,
  warnings: [],
  claims: [],
  diffSummary: [],
  ops: [],
  package: {
    schemaVersion: 1,
    packageId: 'pkg-1',
    revision: 2,
    trip: { id: 'trip-1', title: 'Viaje a Pueblo C', startDate: '2027-03-10', endDate: '2027-03-15' },
    travelOptions,
    itineraryItems: [],
    checklistItems: [],
    notes: [],
  },
})
const lodgingOnly = [{ externalId: 'lodging-main', type: 'lodging', title: 'Hospedaje en Pueblo C', verificationStatus: 'estimated' }]

describe('scrub/residual-scan consistency across sentences (8813692c)', () => {
  it('a mode word that only gains numeric context from another sentence is scrubbed', () => {
    const out = scrubOperationalFreeText(`${WINDOW} ${KEEP_TRANSFER} ${GOAL}`)
    assert.doesNotMatch(out, /traslado/i)
    assert.match(out, /10 al 15 de marzo/)
    assert.match(out, /objetivo principal/)
    assert.deepEqual(extractOperationalSignals(out, 'narrative'), [])
  })

  it('scrub output never carries a residual signal (vuelos / autobús / transfer variants)', () => {
    for (const text of [
      `${WINDOW} Se mantienen los vuelos de regreso.`,
      `Llegada el 12. Hay autobús a Pueblo C. ${GOAL}`,
      `${WINDOW}\nTransfer al hotel pendiente.\n${GOAL}`,
    ]) {
      assert.deepEqual(extractOperationalSignals(scrubOperationalFreeText(text), 'narrative'), [], text)
    }
  })

  it('text without cross-sentence mode context is left unchanged', () => {
    assert.equal(scrubOperationalFreeText(`${WINDOW} ${GOAL}`), `${WINDOW} ${GOAL}`)
    assert.equal(scrubOperationalFreeText(`${KEEP_TRANSFER} ${GOAL}`), `${KEEP_TRANSFER} ${GOAL}`)
  })

  it('window change with the transfer omitted from the package is grounded, not rejected', () => {
    const g = assertDraftGrounded(draftWith(`${WINDOW} ${KEEP_TRANSFER} ${GOAL}`, lodgingOnly), trace, context, {
      userPrompt: 'Adelanta el viaje',
    })
    assert.equal(g.ok, true, g.ok ? '' : g.warnings.join(' / '))
    if (g.ok) {
      assert.doesNotMatch(String(g.draft.narrative), /traslado/i)
      assert.match(String(g.draft.narrative), /10 al 15 de marzo/)
    }
  })

  it('sentences with their own operational assertion are still dropped', () => {
    const out = scrubOperationalFreeText(`Traslado en taxi por 350 MXN. ${GOAL}`)
    assert.equal(out, GOAL)
  })

  it('an ungrounded transport claim still fails closed', () => {
    const draft = draftWith(GOAL, lodgingOnly)
    draft.claims = [
      {
        kind: 'transport_mode',
        statement: 'Hay traslado en taxi a Pueblo C',
        sourceType: 'web',
        sourceUrl: 'https://lodging.example/pueblo-c',
        evidenceIndex: 0,
        verificationStatus: 'verified',
        confidence: 'high',
      },
    ] as never
    const g = assertDraftGrounded(draft, trace, context, { userPrompt: 'x' })
    assert.equal(g.ok, false)
    if (!g.ok) assert.match(g.message, /transport_mode_ungrounded/)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentProposal } from '../../shared/agentContracts'
import {
  discardNewTravelProposal,
  prepareNewTravelPackage,
  summarizeNewTravelProposal,
  UNKNOWN,
} from './newTravelProposal.ts'

function sampleProposal(
  over: Partial<AgentProposal['package']> = {},
): AgentProposal {
  return {
    proposalId: 'prop-1',
    createdAt: '2026-09-17T12:00:00+00:00',
    narrative: 'Esqueleto Filipinas',
    warnings: ['Precios pendientes de verificar'],
    diffSummary: [],
    ops: [],
    toolTrace: [],
    package: {
      schemaVersion: 1,
      packageId: 'new-trip-1',
      revision: 1,
      trip: {
        id: 'trip-new-1',
        title: 'Filipinas nov–dic 2026',
        destination: 'Filipinas',
        startDate: '2026-11-10',
        endDate: '2026-11-24',
        timezone: 'America/Mexico_City',
        goals: ['menor lluvia'],
        status: 'planned',
      },
      travelOptions: [
        {
          externalId: 'flt-out',
          type: 'flight',
          status: 'researched',
          title: 'MEX → MNL estimado',
          origin: 'MEX — CDMX',
          destination: 'MNL — Manila',
          verificationStatus: 'estimated',
          sourceType: 'agent',
        },
        {
          externalId: 'lodge-1',
          type: 'lodging',
          status: 'researched',
          title: 'Hospedaje Manila estimado',
          verificationStatus: 'unverified',
          sourceType: 'agent',
          sourceUrl: 'https://example.com/hotel',
        },
      ],
      itineraryItems: [
        {
          externalId: 'itin-1',
          title: 'Llegada Manila',
          importance: 'recommended',
        },
      ],
      checklistItems: [
        { externalId: 'chk-1', label: 'Confirmar vuelos en aerolínea' },
      ],
      notes: [
        {
          externalId: 'note-1',
          body: 'Ventana climática a verificar con fuentes locales',
        },
      ],
      ...over,
    },
  }
}

describe('newTravelProposal', () => {
  it('summarizes title, DRAFT label, duration, origin, destinations, sources', () => {
    const summary = summarizeNewTravelProposal(sampleProposal())
    assert.equal(summary.title, 'Filipinas nov–dic 2026')
    assert.equal(summary.draftLabel, 'DRAFT')
    assert.equal(summary.domainStatus, 'planned')
    assert.equal(summary.durationDays, 15)
    assert.equal(summary.origin, 'MEX — CDMX')
    assert.ok(summary.destinations.includes('Filipinas'))
    assert.equal(summary.transport.length, 1)
    assert.equal(summary.lodging.length, 1)
    assert.equal(summary.pending[0]?.label, 'Confirmar vuelos en aerolínea')
    assert.deepEqual(summary.sources, ['https://example.com/hotel'])
  })

  it('uses UNKNOWN when origin/destinations missing', () => {
    const summary = summarizeNewTravelProposal(
      sampleProposal({
        trip: {
          id: 't',
          title: 'Sin rutas',
          startDate: '2026-11-01',
          endDate: '2026-11-05',
          timezone: 'America/Mexico_City',
          goals: [],
          status: 'planned',
        },
        travelOptions: [],
      }),
    )
    assert.equal(summary.origin, UNKNOWN)
    assert.deepEqual(summary.destinations, [UNKNOWN])
    assert.equal(summary.transport.length, 0)
  })

  it('prepare accepts valid package and forces planned status', () => {
    const raw = sampleProposal()
    raw.package.trip.status = 'active'
    const prepared = prepareNewTravelPackage(raw)
    assert.equal(prepared.ok, true)
    if (!prepared.ok) return
    assert.equal(prepared.proposal.package.trip.status, 'planned')
    assert.equal(prepared.summary.draftLabel, 'DRAFT')
  })

  it('prepare rejects priceObserved without currency', () => {
    const raw = sampleProposal({
      travelOptions: [
        {
          externalId: 'bad-price',
          type: 'flight',
          status: 'researched',
          title: 'Vuelo',
          priceObserved: 999,
          sourceType: 'agent',
        },
      ],
    })
    const prepared = prepareNewTravelPackage(raw)
    assert.equal(prepared.ok, false)
    if (prepared.ok) return
    assert.ok(prepared.errors.some((e) => /currency|priceObserved/i.test(e)))
  })

  it('prepare rejects missing title', () => {
    const raw = sampleProposal()
    raw.package.trip.title = ''
    const prepared = prepareNewTravelPackage(raw)
    assert.equal(prepared.ok, false)
  })

  it('discard clears proposal without persistence side effects', () => {
    assert.equal(discardNewTravelProposal(), null)
  })
})

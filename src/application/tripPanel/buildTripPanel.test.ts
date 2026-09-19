import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import type { AgentProposal } from '../../../shared/agentContracts'
import type { SharedTripPackageV1 } from '../../../shared/agentContracts'
import type {
  ChecklistItem,
  ItineraryItem,
  Note,
  TravelOption,
  Trip,
} from '../../domain/types'
import {
  buildTripPanelFromPackage,
  buildTripPanelFromPersisted,
  buildTripPanelFromProposal,
} from './buildTripPanel.ts'

const fixDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function loadPkg(name: string): SharedTripPackageV1 {
  return JSON.parse(readFileSync(join(fixDir, name), 'utf8')) as SharedTripPackageV1
}

describe('tripPanel model', () => {
  it('1: propuesta completa con fuentes', () => {
    const pkg = loadPkg('complete-with-sources.json')
    const model = buildTripPanelFromPackage(pkg, {
      narrative: 'Viaje familiar corto con fuentes.',
      warnings: [],
      includeTechnicalJson: true,
    })
    assert.equal(model.diagnostics.sourceCount, 4)
    assert.ok(model.diagnostics.verifiedCount >= 3)
    assert.equal(model.diagnostics.missingCount, 0)
    assert.equal(model.diagnostics.needsCreateConfirm, false)
    assert.equal(model.diagnostics.integrityLight, 'green')
    assert.equal(model.flightsOut.length, 1)
    assert.equal(model.flightsReturn.length, 1)
    assert.equal(model.lodging.length, 1)
    assert.ok(model.lodging[0]!.provider)
    assert.ok(model.lodging[0]!.price !== undefined)
    assert.ok(model.executiveSummary)
    assert.ok(model.technical?.jsonText)
  })

  it('2: propuesta estimada sin fuentes', () => {
    const pkg = loadPkg('estimated-no-sources.json')
    const model = buildTripPanelFromPackage(pkg, { warnings: [] })
    assert.equal(model.diagnostics.sourceCount, 0)
    assert.equal(model.diagnostics.verifiedCount, 0)
    assert.ok(model.diagnostics.pendingCount >= 1)
    assert.equal(model.diagnostics.needsCreateConfirm, true)
    assert.equal(model.diagnostics.integrityLight, 'red')
    assert.ok(
      model.diagnostics.warnings.some((w) => /ausencia de fuentes/i.test(w)),
    )
  })

  it('3: vuelo principal y alternativa', () => {
    const pkg = loadPkg('return-with-alternative.json')
    const model = buildTripPanelFromPackage(pkg)
    assert.equal(model.flightsReturn.length, 2)
    const alts = model.flightsReturn.filter((c) => c.status === 'alternative')
    const primary = model.flightsReturn.filter((c) => c.status !== 'alternative')
    assert.equal(alts.length, 1)
    assert.equal(primary.length, 1)
    assert.ok(
      model.diagnostics.warnings.some((w) => /alternativa/i.test(w)),
    )
  })

  it('4: destinos y actividades duplicados', () => {
    const pkg = loadPkg('duplicates.json')
    const model = buildTripPanelFromPackage(pkg)
    assert.ok(
      model.diagnostics.warnings.some((w) => /duplicad/i.test(w)),
    )
  })

  it('5: traslado de regreso faltante', () => {
    const pkg = loadPkg('missing-return.json')
    const model = buildTripPanelFromPackage(pkg)
    assert.equal(model.flightsOut.length, 1)
    assert.equal(model.flightsReturn.length, 0)
    assert.ok(model.diagnostics.missingCount >= 1)
    assert.ok(
      model.diagnostics.warnings.some((w) => /vuelo de regreso/i.test(w)),
    )
    assert.ok(
      model.lodging.some((c) => c.status === 'missing') ||
        model.diagnostics.missingCount >= 1,
    )
  })

  it('6: campos opcionales y UNKNOWN', () => {
    const pkg = loadPkg('unknown-optional.json')
    const model = buildTripPanelFromPackage(pkg)
    // Trip has no destination; header uses flight destination when present
    assert.ok(model.header.destinations.length >= 1)
    const flight = model.flightsOut[0]!
    assert.equal(flight.startAt, undefined)
    assert.equal(flight.price, undefined)
    assert.ok(
      model.diagnostics.warnings.some((w) => /fecha\/hora ausente/i.test(w)),
    )
    // Card must not invent provider/price fields
    assert.equal(flight.provider, undefined)
    assert.equal(flight.currency, undefined)
    // Nights > 0 without lodging → missing slot
    assert.ok(model.diagnostics.missingCount >= 1)
    assert.ok(model.lodging.some((c) => c.status === 'missing'))
  })

  it('7: renderizado de viaje persistido', () => {
    const trip: Trip = {
      id: 'persisted-1',
      title: 'Filipinas nov–dic',
      destination: 'Filipinas',
      startDate: '2026-11-15',
      endDate: '2026-11-29',
      timezone: 'America/Mexico_City',
      goals: [{ id: 'g1', label: 'clima' }],
      status: 'planned',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      syncStatus: 'synced',
    }
    const options: TravelOption[] = [
      {
        id: 'opt-1',
        tripId: trip.id,
        type: 'flight',
        status: 'shortlisted',
        title: 'MEX → MNL',
        origin: 'MEX',
        destination: 'MNL',
        startAt: '2026-11-15T10:00:00-06:00',
        verificationStatus: 'estimated',
        sourceType: 'agent',
        externalId: 'flt-out',
        createdAt: trip.createdAt,
        updatedAt: trip.updatedAt,
        syncStatus: 'synced',
      },
      {
        id: 'opt-2',
        tripId: trip.id,
        type: 'flight',
        status: 'researched',
        title: 'Regreso MNL → MEX',
        origin: 'MNL',
        destination: 'MEX',
        startAt: '2026-11-29T20:00:00-06:00',
        verificationStatus: 'estimated',
        sourceType: 'agent',
        externalId: 'flt-ret',
        createdAt: trip.createdAt,
        updatedAt: trip.updatedAt,
        syncStatus: 'synced',
      },
      {
        id: 'opt-3',
        tripId: trip.id,
        type: 'lodging',
        status: 'researched',
        title: 'Manila lodging',
        destination: 'Manila',
        verificationStatus: 'unverified',
        sourceType: 'agent',
        externalId: 'lodge-1',
        createdAt: trip.createdAt,
        updatedAt: trip.updatedAt,
        syncStatus: 'synced',
      },
    ]
    const itinerary: ItineraryItem[] = []
    const checklist: ChecklistItem[] = [
      {
        id: 'c1',
        tripId: trip.id,
        label: 'Visa',
        status: 'open',
        sortOrder: 0,
        createdAt: trip.createdAt,
        updatedAt: trip.updatedAt,
        syncStatus: 'synced',
      },
    ]
    const notes: Note[] = [
      {
        id: 'n1',
        tripId: trip.id,
        body: 'Sin reservas aún',
        createdAt: trip.createdAt,
        updatedAt: trip.updatedAt,
        syncStatus: 'synced',
      },
    ]
    const model = buildTripPanelFromPersisted({
      trip,
      options,
      itinerary,
      checklist,
      notes,
      bookings: [],
    })
    assert.equal(model.header.title, 'Filipinas nov–dic')
    assert.equal(model.header.statusLabel, 'planned')
    assert.equal(model.flightsOut.length, 1)
    assert.equal(model.flightsReturn.length, 1)
    assert.equal(model.lodging.length, 1)
    assert.equal(model.checklist.length, 1)
    assert.equal(model.notes.length, 1)
  })

  it('proposal wrapper includes draft status and budget when present', () => {
    const pkg = loadPkg('complete-with-sources.json')
    const proposal: AgentProposal = {
      proposalId: 'p1',
      createdAt: '2026-09-19T12:00:00Z',
      narrative: 'Resumen largo '.repeat(30),
      warnings: ['aviso'],
      diffSummary: [],
      ops: [],
      toolTrace: [],
      package: pkg,
      estimatedCostDelta: {
        amount: 5000,
        currency: 'MXN',
        confidence: 'estimated',
      },
    }
    const model = buildTripPanelFromProposal(proposal)
    assert.match(model.header.statusLabel, /DRAFT/)
    assert.equal(model.header.budgetAmount, 5000)
    assert.equal(model.header.budgetCurrency, 'MXN')
    assert.ok((model.executiveSummary?.length ?? 0) <= 221)
  })
})

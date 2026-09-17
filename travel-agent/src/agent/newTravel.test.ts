import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  arrivalOffsetsFor,
  buildAirportArrivalItinerary,
  classifyFlightScope,
  extractIataCode,
  subtractMinutesIso,
} from '../../shared/airportArrivalPolicy.ts'
import { enrichPackageWithAirportArrivals } from './airportArrivalEnrich.ts'
import { classifyAskIntent } from './intent.ts'
import { hydrateProposal } from './runtime.ts'
import type { AgentAskRequest } from '../../shared/agentContracts.ts'

describe('airport arrival policy', () => {
  it('classifies MX–MX as domestic', () => {
    assert.equal(classifyFlightScope('MEX — CDMX', 'GDL — Guadalajara'), 'domestic')
    assert.equal(arrivalOffsetsFor('MEX', 'GDL').deskMinutes, 150)
    assert.equal(arrivalOffsetsFor('MEX', 'GDL').onlineMinutes, 90)
  })

  it('classifies unknown/intl as international', () => {
    assert.equal(classifyFlightScope('MEX', 'JFK'), 'international')
    assert.equal(arrivalOffsetsFor('MEX', 'JFK').deskMinutes, 210)
  })

  it('subtracts minutes preserving offset', () => {
    const out = subtractMinutesIso('2026-09-15T13:00:00-06:00', 150)
    assert.equal(out, '2026-09-15T10:30:00-06:00')
  })

  it('builds desk + online itinerary drafts', () => {
    const items = buildAirportArrivalItinerary([
      {
        externalId: 'flt-out',
        title: 'Vuelo MEX-GDL',
        origin: 'MEX — CDMX',
        destination: 'GDL',
        startAt: '2026-09-15T13:00:00-06:00',
      },
    ])
    assert.equal(items.length, 2)
    assert.ok(items[0]!.externalId.startsWith('airport-arrival-desk-'))
    assert.equal(items[0]!.startAt, '2026-09-15T10:30:00-06:00')
    assert.equal(items[1]!.startAt, '2026-09-15T11:30:00-06:00')
  })

  it('extractIataCode finds codes in free text', () => {
    assert.equal(extractIataCode('salida MEX terminal 2'), 'MEX')
  })
})

describe('new_travel intent + enrich', () => {
  it('mode new_travel forces intent', () => {
    assert.equal(classifyAskIntent('hola', 'new_travel'), 'new_travel')
    assert.equal(classifyAskIntent('que dia es el regreso?', 'ask'), 'context_answer')
  })

  it('hydrate new_travel pins trip id and adds airport arrivals', () => {
    const tripId = '11111111-1111-4111-8111-111111111111'
    const req: AgentAskRequest = {
      prompt: 'viaje CDMX GDL',
      tripId,
      mode: 'new_travel',
      locale: 'es',
      context: {
        trip: {
          id: tripId,
          title: 'Nuevo viaje',
          startDate: '2026-01-01',
          endDate: '2026-01-02',
          timezone: 'America/Mexico_City',
          goals: [],
          status: 'planned',
        },
        bookings: [],
        travelOptions: [],
        itineraryItems: [],
        checklistItems: [],
        notes: [],
        packageImports: [],
      },
    }
    const draft = {
      narrative: 'Itinerario esqueleto',
      warnings: [],
      diffSummary: [],
      ops: [],
      package: {
        schemaVersion: 1,
        packageId: `new-${tripId}`,
        revision: 1,
        trip: {
          id: tripId,
          title: 'CDMX — GDL grito',
          destination: 'Guadalajara / SMA',
          startDate: '2026-09-15',
          endDate: '2026-09-21',
          timezone: 'America/Mexico_City',
          goals: ['grito'],
          status: 'planned',
        },
        travelOptions: [
          {
            externalId: 'flt-out',
            type: 'flight',
            status: 'shortlisted',
            title: 'Vuelo MEX-GDL esqueleto',
            origin: 'MEX — CDMX',
            destination: 'GDL — Guadalajara',
            startAt: '2026-09-15T13:00:00-06:00',
            verificationStatus: 'estimated',
            sourceType: 'agent',
            notes: 'esqueleto',
          },
        ],
        itineraryItems: [],
        checklistItems: [],
        notes: [],
      },
    }
    const hydrated = hydrateProposal(draft, req, [], { intent: 'new_travel' }) as {
      package: {
        trip: { id: string; title: string }
        itineraryItems: { externalId: string; startAt?: string }[]
      }
    }
    assert.equal(hydrated.package.trip.id, tripId)
    assert.match(hydrated.package.trip.title, /GDL|grito|CDMX/i)
    const arrivals = hydrated.package.itineraryItems.filter((i) =>
      i.externalId.startsWith('airport-arrival-'),
    )
    assert.equal(arrivals.length, 2)
  })

  it('hydrate new_travel keeps planned status (UI DRAFT until create)', () => {
    const tripId = '22222222-2222-4222-8222-222222222222'
    const req: AgentAskRequest = {
      prompt: 'dos semanas Filipinas desde CDMX',
      tripId,
      mode: 'new_travel',
      locale: 'es',
      context: {
        trip: {
          id: tripId,
          title: 'Nuevo viaje',
          startDate: '2026-01-01',
          endDate: '2026-01-02',
          timezone: 'America/Mexico_City',
          goals: [],
          status: 'planned',
        },
        bookings: [],
        travelOptions: [],
        itineraryItems: [],
        checklistItems: [],
        notes: [],
        packageImports: [],
      },
    }
    const draft = {
      narrative: 'Filipinas borrador',
      warnings: ['Clima pendiente de verificar'],
      diffSummary: [],
      ops: [],
      package: {
        schemaVersion: 1,
        packageId: `new-${tripId}`,
        revision: 1,
        trip: {
          id: tripId,
          title: 'Filipinas 2026',
          destination: 'Filipinas',
          startDate: '2026-11-10',
          endDate: '2026-11-24',
          timezone: 'America/Mexico_City',
          goals: ['clima'],
          status: 'planned',
        },
        travelOptions: [
          {
            externalId: 'flt-out',
            type: 'flight',
            status: 'researched',
            title: 'MEX-MNL',
            origin: 'MEX',
            destination: 'MNL',
            verificationStatus: 'estimated',
            sourceType: 'agent',
          },
          {
            externalId: 'lodge-1',
            type: 'lodging',
            status: 'researched',
            title: 'Manila lodging',
            verificationStatus: 'unverified',
            sourceType: 'agent',
          },
        ],
        itineraryItems: [],
        checklistItems: [
          { externalId: 'chk-1', label: 'Confirmar vuelos' },
        ],
        notes: [{ externalId: 'note-1', body: 'Sin reservas' }],
      },
    }
    const hydrated = hydrateProposal(draft, req, [], { intent: 'new_travel' }) as {
      package: { trip: { status: string; title: string } }
    }
    assert.equal(hydrated.package.trip.status, 'planned')
    assert.equal(hydrated.package.trip.title, 'Filipinas 2026')
  })

  it('enrichPackageWithAirportArrivals is idempotent', () => {
    const once = enrichPackageWithAirportArrivals({
      travelOptions: [
        {
          externalId: 'f1',
          type: 'flight',
          title: 'Vuelo',
          origin: 'MEX',
          destination: 'GDL',
          startAt: '2026-09-15T13:00:00-06:00',
        },
      ],
      itineraryItems: [],
      checklistItems: [],
    })
    const twice = enrichPackageWithAirportArrivals(once)
    const n1 = (once.itineraryItems as unknown[]).length
    const n2 = (twice.itineraryItems as unknown[]).length
    assert.equal(n1, n2)
    assert.equal(n1, 2)
  })
})

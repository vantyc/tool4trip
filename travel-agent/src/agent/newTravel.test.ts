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
import {
  ensureNewTravelSkeleton,
  inferGoalDate,
  nightsBetween,
  stripLlmAirportArrivalItems,
  webResearchWarnings,
} from './newTravelCoherence.ts'
import { hydrateProposal } from './runtime.ts'
import type { AgentAskRequest } from '../../shared/agentContracts.ts'

type Rec = Record<string, unknown>

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

  it('builds one desk itinerary draft per flight (online only in notes)', () => {
    const items = buildAirportArrivalItinerary([
      {
        externalId: 'flt-out',
        title: 'Vuelo MEX-GDL',
        origin: 'MEX — CDMX',
        destination: 'GDL',
        startAt: '2026-09-15T13:00:00-06:00',
      },
    ])
    assert.equal(items.length, 1)
    assert.ok(items[0]!.externalId.startsWith('airport-arrival-desk-'))
    assert.equal(items[0]!.startAt, '2026-09-15T10:30:00-06:00')
    assert.match(items[0]!.notes, /documentaste en línea/i)
  })

  it('extractIataCode finds codes in free text', () => {
    assert.equal(extractIataCode('salida MEX terminal 2'), 'MEX')
  })
})

describe('new_travel coherence', () => {
  it('nightsBetween: 19→22 = 3', () => {
    assert.equal(nightsBetween('2026-09-19', '2026-09-22'), 3)
  })

  it('inferGoalDate finds domingo 20 septiembre serenata', () => {
    const d = inferGoalDate(
      'serenata en San Miguel el Alto el domingo 20 de septiembre de 2026',
      'serenata',
      '2026-09-19',
      '2026-09-22',
    )
    assert.equal(d, '2026-09-20')
  })

  it('ensureNewTravelSkeleton adds lodging, serenata, and demotes alt return', () => {
    const prompt =
      'Salida MEX–GDL sábado 19, serenata San Miguel el Alto domingo 20, regreso preferido martes 22 (lunes 21 alternativa)'
    const pkg = ensureNewTravelSkeleton(
      {
        trip: {
          id: 't1',
          title: 'SMA',
          destination: 'San Miguel el Alto, Jalisco',
          startDate: '2026-09-19',
          endDate: '2026-09-22',
          timezone: 'America/Mexico_City',
          goals: ['serenata'],
          status: 'planned',
        },
        travelOptions: [
          {
            externalId: 'flt-out',
            type: 'flight',
            status: 'shortlisted',
            title: 'MEX-GDL ida',
            origin: 'MEX',
            destination: 'GDL',
            startAt: '2026-09-19T10:00:00-06:00',
            verificationStatus: 'estimated',
            sourceType: 'agent',
          },
          {
            externalId: 'flt-ret-21',
            type: 'flight',
            status: 'shortlisted',
            title: 'Regreso GDL-MEX lunes',
            origin: 'GDL',
            destination: 'MEX',
            startAt: '2026-09-21T18:00:00-06:00',
            verificationStatus: 'estimated',
            sourceType: 'agent',
          },
          {
            externalId: 'flt-ret-22',
            type: 'flight',
            status: 'shortlisted',
            title: 'Regreso GDL-MEX martes',
            origin: 'GDL',
            destination: 'MEX',
            startAt: '2026-09-22T18:00:00-06:00',
            verificationStatus: 'estimated',
            sourceType: 'agent',
          },
        ],
        itineraryItems: [
          {
            externalId: 'airport-arrival-desk-flt-out',
            title: 'Arribo al aeropuerto MEX',
            startAt: '2026-09-19T07:30:00-06:00',
          },
          {
            externalId: 'airport-arrival-online-flt-out',
            title: 'Check-in online MEX',
            startAt: '2026-09-19T08:30:00-06:00',
          },
        ],
        checklistItems: [],
        notes: [],
      },
      prompt,
    )

    const lodging = (pkg.travelOptions as Rec[]).filter(
      (o) => o.type === 'lodging',
    )
    assert.equal(lodging.length, 1)
    assert.match(String(lodging[0]!.title), /3 noche/i)

    const ret21 = (pkg.travelOptions as Rec[]).find(
      (o) => o.externalId === 'flt-ret-21',
    )!
    const ret22 = (pkg.travelOptions as Rec[]).find(
      (o) => o.externalId === 'flt-ret-22',
    )!
    assert.equal(ret22.status, 'shortlisted')
    assert.equal(ret21.status, 'researched')
    assert.match(String(ret21.notes), /alternativa/i)

    const ser = (pkg.itineraryItems as Rec[]).find((i) =>
      String(i.title).toLowerCase().includes('serenata'),
    )
    assert.ok(ser)
    assert.match(String(ser!.startAt), /^2026-09-20/)
    assert.match(String(ser!.notes), /pendiente de verificar/i)

    const stripped = stripLlmAirportArrivalItems(pkg)
    const airportish = (stripped.itineraryItems as Rec[]).filter((i) =>
      /arribo|airport|check-in/i.test(String(i.title)),
    )
    assert.equal(airportish.length, 0)
  })

  it('webResearchWarnings when no webSearch', () => {
    const w = webResearchWarnings([])
    assert.ok(w.some((x) => /no se ejecutó websearch/i.test(x)))
  })
})

describe('new_travel intent + enrich', () => {
  it('mode new_travel forces intent', () => {
    assert.equal(classifyAskIntent('hola', 'new_travel'), 'new_travel')
    assert.equal(classifyAskIntent('que dia es el regreso?', 'ask'), 'context_answer')
  })

  it('hydrate new_travel pins trip id, one arrival, lodging + serenata', () => {
    const tripId = '11111111-1111-4111-8111-111111111111'
    const prompt =
      'Salida MEX–GDL sábado 19 de septiembre 2026, serenata en San Miguel el Alto el domingo 20, regreso preferido martes 22'
    const req: AgentAskRequest = {
      prompt,
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
      narrative: 'Itinerario esqueleto SMA',
      warnings: [],
      diffSummary: [],
      ops: [],
      package: {
        schemaVersion: 1,
        packageId: `new-${tripId}`,
        revision: 1,
        trip: {
          id: tripId,
          title: 'SMA serenata sep 2026',
          destination: 'San Miguel el Alto, Jalisco',
          startDate: '2026-09-19',
          endDate: '2026-09-22',
          timezone: 'America/Mexico_City',
          goals: ['serenata'],
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
            startAt: '2026-09-19T10:00:00-06:00',
            verificationStatus: 'estimated',
            sourceType: 'agent',
            notes: 'esqueleto',
          },
          {
            externalId: 'flt-ret-21',
            type: 'flight',
            status: 'shortlisted',
            title: 'Regreso lunes 21',
            origin: 'GDL',
            destination: 'MEX',
            startAt: '2026-09-21T18:00:00-06:00',
            verificationStatus: 'estimated',
            sourceType: 'agent',
          },
          {
            externalId: 'flt-ret-22',
            type: 'flight',
            status: 'shortlisted',
            title: 'Regreso martes 22',
            origin: 'GDL',
            destination: 'MEX',
            startAt: '2026-09-22T18:00:00-06:00',
            verificationStatus: 'estimated',
            sourceType: 'agent',
          },
        ],
        itineraryItems: [
          {
            externalId: 'dup-online',
            title: 'Check-in online MEX',
            startAt: '2026-09-19T08:30:00-06:00',
          },
        ],
        checklistItems: [],
        notes: [],
      },
    }
    const hydrated = hydrateProposal(draft, req, [], { intent: 'new_travel' }) as {
      warnings: string[]
      package: {
        trip: { id: string; title: string }
        travelOptions: { type: string; status: string; externalId: string; notes?: string; title: string }[]
        itineraryItems: { externalId: string; title: string; startAt?: string }[]
      }
    }
    assert.equal(hydrated.package.trip.id, tripId)
    const arrivals = hydrated.package.itineraryItems.filter((i) =>
      i.externalId.startsWith('airport-arrival-'),
    )
    // One desk arrival for each of 3 flights
    assert.equal(arrivals.length, 3)
    assert.ok(!arrivals.some((a) => a.externalId.includes('online')))

    const lodging = hydrated.package.travelOptions.filter((o) => o.type === 'lodging')
    assert.equal(lodging.length, 1)

    const ser = hydrated.package.itineraryItems.find((i) =>
      /serenata/i.test(i.title),
    )
    assert.ok(ser)
    assert.match(ser!.startAt ?? '', /^2026-09-20/)

    const ret21 = hydrated.package.travelOptions.find((o) => o.externalId === 'flt-ret-21')
    const ret22 = hydrated.package.travelOptions.find((o) => o.externalId === 'flt-ret-22')
    assert.equal(ret22?.status, 'shortlisted')
    assert.equal(ret21?.status, 'researched')

    assert.ok(hydrated.warnings.some((w) => /3 noche/i.test(w)))
    assert.ok(hydrated.warnings.some((w) => /webSearch/i.test(w)))
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

  it('enrichPackageWithAirportArrivals is idempotent and strips LLM dups', () => {
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
      itineraryItems: [
        {
          externalId: 'llm-dup',
          title: 'Arribo al aeropuerto MEX genérico',
          startAt: '2026-09-15T10:00:00-06:00',
        },
        {
          externalId: 'airport-arrival-online-f1',
          title: 'Online twin',
          startAt: '2026-09-15T11:30:00-06:00',
        },
      ],
      checklistItems: [],
    })
    const twice = enrichPackageWithAirportArrivals(once)
    const n1 = (once.itineraryItems as unknown[]).length
    const n2 = (twice.itineraryItems as unknown[]).length
    assert.equal(n1, n2)
    assert.equal(n1, 1)
    const ids = (once.itineraryItems as { externalId: string }[]).map(
      (i) => i.externalId,
    )
    assert.ok(ids[0]!.startsWith('airport-arrival-desk-'))
  })
})

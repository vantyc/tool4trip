import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentOpRecord } from '../../shared/agentContracts.ts'
import {
  isLodgingCandidateNote,
  LODGING_CANDIDATE_NOTE,
} from '../../shared/lodgingCandidate.ts'
import { applyMutationInMemory } from './packageMutation.ts'
import { prepareMutationPlan } from './prepareMutationPlan.ts'
import { optionEntityId } from './tripPackage.ts'
import type { TravelOption, Trip } from './domainTypes.ts'
import type { PackageTravelOption, TripPackageV1 } from './tripPackage.ts'

/**
 * Ask Travel on an existing trip: "consigue los teléfonos de hoteles en
 * Totatiche". Researched hotels are added next to the current lodging; they
 * never compete with it for the primary slot unless an op replaces it.
 */

const TRIP_ID = '22222222-3333-4444-8555-666666666666'
const PKG_ID = TRIP_ID
const START = '2026-10-06'
const NEW_START = '2026-10-01'
const END = '2026-10-08'
const TZ = '-06:00'
const TOWN = 'Totatiche, Jalisco'

const JARDIN_URL = 'https://pueblosamerica.example/totatiche/hotel-jardin-16'
const RAFA_URL = 'https://pueblosamerica.example/totatiche/hotel-y-restaurant-el-oasis'

function currentTrip(): Trip {
  return {
    id: TRIP_ID,
    title: 'Fiestas en Totatiche',
    destination: TOWN,
    startDate: START,
    endDate: END,
    timezone: 'America/Mexico_City',
    status: 'planned',
    goals: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    syncStatus: 'synced',
  } as Trip
}

function opt(
  externalId: string,
  partial: Partial<TravelOption> & Pick<TravelOption, 'title' | 'type'>,
): TravelOption {
  return {
    id: optionEntityId(PKG_ID, externalId),
    tripId: TRIP_ID,
    status: 'researched',
    sourceType: 'agent',
    externalId,
    packageId: PKG_ID,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    syncStatus: 'synced',
    ...partial,
  }
}

function currentOptions(): TravelOption[] {
  return [
    opt('lodging-totatiche-1', {
      type: 'lodging',
      title: 'Hospedaje en Totatiche (estimado · 2 noche(s))',
      destination: TOWN,
      startAt: `${START}T15:00:00${TZ}`,
      endAt: `${END}T12:00:00${TZ}`,
      verificationStatus: 'estimated',
    }),
    opt('transfer-gdl-totatiche', {
      type: 'transfer',
      title: 'Traslado GDL → Totatiche',
      origin: 'GDL',
      destination: TOWN,
      startAt: `${START}T14:00:00${TZ}`,
      verificationStatus: 'estimated',
    }),
  ]
}

function currentLodging(start: string): PackageTravelOption {
  return {
    externalId: 'lodging-totatiche-1',
    type: 'lodging',
    status: 'researched',
    title: 'Hospedaje en Totatiche (estimado · 2 noche(s))',
    destination: TOWN,
    startAt: `${start}T15:00:00${TZ}`,
    endAt: `${END}T12:00:00${TZ}`,
    sourceType: 'agent',
    verificationStatus: 'estimated',
  }
}

function hotel(
  externalId: string,
  title: string,
  phone: string,
  sourceUrl: string,
  extra: Partial<PackageTravelOption> = {},
): PackageTravelOption {
  return {
    externalId,
    type: 'lodging',
    status: 'researched',
    title,
    destination: TOWN,
    phone,
    address: 'Centro, Totatiche, Jalisco',
    sourceType: 'agent',
    sourceUrl,
    verificationStatus: 'unverified',
    ...extra,
  }
}

const JARDIN = () => hotel('hotel-jardin', 'Hotel Jardín', '+52 4379640079', JARDIN_URL)
const RAFA = () =>
  hotel('hotel-don-rafa', 'Hotel y Restaurant Don Rafa', '+52 4379640054', RAFA_URL)

function pkg(start: string, lodging: PackageTravelOption[]): TripPackageV1 {
  return {
    schemaVersion: 1,
    packageId: PKG_ID,
    revision: 2,
    generatedAt: '2026-09-30T00:00:00Z',
    trip: {
      id: TRIP_ID,
      title: 'Fiestas en Totatiche',
      destination: TOWN,
      startDate: start,
      endDate: END,
      timezone: 'America/Mexico_City',
      goals: [],
      status: 'planned',
    },
    travelOptions: [
      currentLodging(start),
      ...lodging,
      {
        externalId: 'transfer-gdl-totatiche',
        type: 'transfer',
        status: 'researched',
        title: 'Traslado GDL → Totatiche',
        origin: 'GDL',
        destination: TOWN,
        startAt: `${start}T14:00:00${TZ}`,
        sourceType: 'agent',
        verificationStatus: 'estimated',
      },
    ],
    itineraryItems: [],
    checklistItems: [],
    notes: [],
  }
}

const add = (externalId: string): AgentOpRecord => ({
  op: 'add',
  entityKind: 'travelOption',
  externalId,
})
const update = (externalId: string): AgentOpRecord => ({
  op: 'update',
  entityKind: 'travelOption',
  externalId,
})

function prepare(p: TripPackageV1, llmOps: AgentOpRecord[], current = currentOptions()) {
  return prepareMutationPlan({
    tripId: TRIP_ID,
    currentTrip: currentTrip(),
    currentOptions: current,
    rawPackage: p,
    llmOps,
  })
}

function applied(prepared: ReturnType<typeof prepare>, existing = currentOptions()) {
  return applyMutationInMemory({
    tripId: TRIP_ID,
    packageId: PKG_ID,
    existing,
    packageOptions: prepared.normalizedPackage.travelOptions.map((o) => ({
      externalId: o.externalId,
      type: o.type,
      status: o.status,
      title: o.title,
      startAt: o.startAt,
      endAt: o.endAt,
      sourceType: o.sourceType,
      sourceUrl: o.sourceUrl,
      provider: o.provider,
      verificationStatus: o.verificationStatus,
      notes: o.notes,
    })),
    ops: prepared.canonicalOps,
  }).options
}

const opsFor = (prepared: ReturnType<typeof prepare>, id: string) =>
  prepared.canonicalOps.filter((o) => o.externalId === id).map((o) => o.op)

describe('lodging candidates on an existing trip', () => {
  for (const start of [START, NEW_START]) {
    const label = start === START ? 'same window' : 'window moved to 10-01'
    it(`A (${label}): two researched hotels are added, current lodging kept`, () => {
      const prepared = prepare(pkg(start, [JARDIN(), RAFA()]), [
        update('lodging-totatiche-1'),
        add('hotel-jardin'),
        add('hotel-don-rafa'),
      ])

      assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
      assert.ok(!prepared.conflicts.some((c) => /ambiguous lodging/.test(c)))
      assert.deepEqual(opsFor(prepared, 'hotel-jardin'), ['add'])
      assert.deepEqual(opsFor(prepared, 'hotel-don-rafa'), ['add'])
      assert.ok(
        !prepared.canonicalOps.some(
          (o) =>
            (o.op === 'supersede' || o.op === 'remove') &&
            (o.externalId === 'lodging-totatiche-1' ||
              o.supersedesExternalId === 'lodging-totatiche-1'),
        ),
        'no implicit supersede/delete of the current lodging',
      )

      const byId = new Map(
        prepared.normalizedPackage.travelOptions.map((o) => [o.externalId, o]),
      )
      assert.equal(byId.get('hotel-jardin')?.phone, '+52 4379640079')
      assert.equal(byId.get('hotel-jardin')?.sourceUrl, JARDIN_URL)
      assert.equal(byId.get('hotel-don-rafa')?.phone, '+52 4379640054')
      assert.equal(byId.get('hotel-don-rafa')?.sourceUrl, RAFA_URL)
      assert.ok(isLodgingCandidateNote(byId.get('hotel-jardin')?.notes))
      assert.ok(!isLodgingCandidateNote(byId.get('lodging-totatiche-1')?.notes))

      const final = applied(prepared)
      const lodging = final.filter((o) => o.type === 'lodging').map((o) => o.externalId)
      assert.deepEqual(lodging.sort(), ['hotel-don-rafa', 'hotel-jardin', 'lodging-totatiche-1'])
      const main = final.find((o) => o.externalId === 'lodging-totatiche-1')!
      assert.equal(main.startAt?.slice(0, 10), start)
    })
  }

  it('A: candidates are added even when the model omits the add op for the primary update', () => {
    const prepared = prepare(pkg(START, [JARDIN(), RAFA()]), [
      add('hotel-jardin'),
      add('hotel-don-rafa'),
    ])
    assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
    assert.deepEqual(opsFor(prepared, 'hotel-jardin'), ['add'])
    assert.deepEqual(opsFor(prepared, 'hotel-don-rafa'), ['add'])
  })

  it('B: a single researched hotel does not replace the current lodging', () => {
    const prepared = prepare(pkg(START, [JARDIN()]), [add('hotel-jardin')])
    assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
    assert.deepEqual(opsFor(prepared, 'hotel-jardin'), ['add'])
    assert.ok(!prepared.canonicalOps.some((o) => o.op === 'supersede'))
    const lodging = applied(prepared).filter((o) => o.type === 'lodging')
    assert.equal(lodging.length, 2)
  })

  it('C: an explicit supersede of the current lodging still replaces it', () => {
    const p = pkg(START, [JARDIN()])
    p.travelOptions = p.travelOptions.filter((o) => o.externalId !== 'lodging-totatiche-1')
    const prepared = prepare(p, [
      {
        op: 'supersede',
        entityKind: 'travelOption',
        externalId: 'hotel-jardin',
        supersedesExternalId: 'lodging-totatiche-1',
      },
    ])
    assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
    const sup = prepared.canonicalOps.find((o) => o.op === 'supersede')
    assert.equal(sup?.externalId, 'hotel-jardin')
    assert.equal(sup?.supersedesExternalId, 'lodging-totatiche-1')
    const lodging = applied(prepared).filter((o) => o.type === 'lodging')
    assert.deepEqual(lodging.map((o) => o.externalId), ['hotel-jardin'])
  })

  it('D: an explicit remove of the current lodging with a new hotel replaces it', () => {
    const p = pkg(START, [JARDIN()])
    p.travelOptions = p.travelOptions.filter((o) => o.externalId !== 'lodging-totatiche-1')
    const prepared = prepare(p, [
      { op: 'remove', entityKind: 'travelOption', externalId: 'lodging-totatiche-1' },
      add('hotel-jardin'),
    ])
    assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
    const lodging = applied(prepared).filter((o) => o.type === 'lodging')
    assert.deepEqual(lodging.map((o) => o.externalId), ['hotel-jardin'])
  })

  it('D: an explicit remove of a saved candidate deletes it', () => {
    const current = [
      ...currentOptions(),
      opt('hotel-jardin', {
        type: 'lodging',
        title: 'Hotel Jardín',
        destination: TOWN,
        phone: '+52 4379640079',
        sourceUrl: JARDIN_URL,
        sourceType: 'agent',
        verificationStatus: 'unverified',
        notes: LODGING_CANDIDATE_NOTE,
      }),
    ]
    const prepared = prepare(
      pkg(START, []),
      [{ op: 'remove', entityKind: 'travelOption', externalId: 'hotel-jardin' }],
      current,
    )
    assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
    assert.deepEqual(opsFor(prepared, 'hotel-jardin'), ['remove'])
    assert.deepEqual(opsFor(prepared, 'lodging-totatiche-1').includes('remove'), false)
  })

  it('saved candidates do not make a later edit ambiguous and are kept when omitted', () => {
    const current = [
      ...currentOptions(),
      opt('hotel-jardin', {
        type: 'lodging',
        title: 'Hotel Jardín',
        destination: TOWN,
        phone: '+52 4379640079',
        sourceUrl: JARDIN_URL,
        sourceType: 'agent',
        verificationStatus: 'unverified',
        notes: LODGING_CANDIDATE_NOTE,
      }),
    ]
    const prepared = prepare(pkg(NEW_START, []), [update('lodging-totatiche-1')], current)
    assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
    assert.ok(!prepared.canonicalOps.some((o) => o.externalId === 'hotel-jardin' && o.op !== 'update'))
    const kept = prepared.normalizedPackage.travelOptions.find(
      (o) => o.externalId === 'hotel-jardin',
    )
    assert.equal(kept?.phone, '+52 4379640079')
    const final = applied(prepared, current)
    assert.deepEqual(
      final.filter((o) => o.type === 'lodging').map((o) => o.externalId).sort(),
      ['hotel-jardin', 'lodging-totatiche-1'],
    )
  })

  it('the same hotel proposed twice is added once', () => {
    const prepared = prepare(
      pkg(START, [JARDIN(), { ...JARDIN(), externalId: 'hotel-jardin-2' }]),
      [add('hotel-jardin'), add('hotel-jardin-2')],
    )
    assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
    assert.deepEqual(opsFor(prepared, 'hotel-jardin'), ['add'])
    assert.deepEqual(opsFor(prepared, 'hotel-jardin-2'), [])
  })

  it('I: each hotel keeps its own phone and source', () => {
    const prepared = prepare(pkg(START, [JARDIN(), RAFA()]), [
      add('hotel-jardin'),
      add('hotel-don-rafa'),
    ])
    const out = prepared.normalizedPackage.travelOptions.filter((o) =>
      o.externalId.startsWith('hotel-'),
    )
    assert.deepEqual(
      out.map((o) => [o.externalId, o.phone, o.sourceUrl]).sort(),
      [
        ['hotel-don-rafa', '+52 4379640054', RAFA_URL],
        ['hotel-jardin', '+52 4379640079', JARDIN_URL],
      ],
    )
  })
})

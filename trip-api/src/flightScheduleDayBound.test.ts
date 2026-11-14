import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentOpRecord } from '../../shared/agentContracts.ts'
import { sourceUrlDay } from './compileMutationPlan.ts'
import { applyMutationInMemory } from './packageMutation.ts'
import { prepareMutationPlan } from './prepareMutationPlan.ts'
import { optionEntityId } from './tripPackage.ts'
import type { TravelOption, Trip } from './domainTypes.ts'
import type { PackageTravelOption, TripPackageV1 } from './tripPackage.ts'

/**
 * A published schedule is evidence for one day. Real job c499f0f0: the trip
 * moved 6→8 ⇒ 1→8 and the model re-used outbound-flight-1 (Y4140 of 6 Oct);
 * the preview showed startAt 1 Oct with the 6 Oct sourceUrl/checkedAt/title.
 */

const TRIP_ID = '92801917-c4dc-4088-99d6-52add1a5843a'
const PKG_ID = `pkg-${TRIP_ID}-0001`
const TZ = '-06:00'
const OLD_CHECKED = '2026-09-30T03:42:07+00:00'
const NEW_CHECKED = '2026-09-30T17:59:40+00:00'
const url = (day: string, flight: string) =>
  `https://aerodatabox.com/?origin=MEX&destination=GDL&date=${day}&flight=${flight}`

function trip(startDate: string): Trip {
  return {
    id: TRIP_ID,
    title: 'Viaje a Totatiche',
    destination: 'Totatiche, Jalisco',
    startDate,
    endDate: '2026-10-08',
    timezone: 'America/Mexico_City',
    status: 'planned',
    goals: [],
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-30T03:44:12.203Z',
    syncStatus: 'synced',
  } as Trip
}

function current(): TravelOption[] {
  const base = {
    tripId: TRIP_ID,
    packageId: PKG_ID,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-30T03:44:12.203Z',
    syncStatus: 'synced' as const,
  }
  return [
    {
      ...base,
      id: optionEntityId(PKG_ID, 'outbound-flight-1'),
      externalId: 'outbound-flight-1',
      type: 'flight',
      status: 'researched',
      title: 'Vuelo estimado Ciudad de México (MEX) a Guadalajara (GDL) el 6 de octubre de 2026',
      origin: 'MEX',
      destination: 'GDL',
      provider: 'Volaris',
      startAt: `2026-10-06T06:00:00${TZ}`,
      endAt: `2026-10-06T07:18:00${TZ}`,
      sourceType: 'flight_schedule',
      sourceUrl: url('2026-10-06', 'Y4140'),
      checkedAt: OLD_CHECKED,
      verificationStatus: 'estimated',
      notes:
        'Horarios y disponibilidad pendientes de confirmar.\nFecha asociada (sin hora verificada): 2026-10-06 HORARIO PUBLICADO — verifica disponibilidad y reserva directamente con la aerolínea.',
    },
    {
      ...base,
      id: optionEntityId(PKG_ID, 'return-flight-1'),
      externalId: 'return-flight-1',
      type: 'flight',
      status: 'shortlisted',
      title: 'Vuelo GDL → MEX AM201',
      origin: 'GDL',
      destination: 'MEX',
      startAt: `2026-10-08T05:46:00${TZ}`,
      sourceType: 'flight_schedule',
      sourceUrl: 'https://aerodatabox.com/?origin=GDL&destination=MEX&date=2026-10-08&flight=AM201',
      checkedAt: OLD_CHECKED,
      verificationStatus: 'estimated',
    },
  ]
}

function scheduled(externalId: string, flight: string, day: string, dep: string, arr: string, extra: Partial<PackageTravelOption> = {}): PackageTravelOption {
  return {
    externalId,
    type: 'flight',
    status: 'researched',
    title: 'Opción investigada',
    origin: 'MEX',
    destination: 'GDL',
    provider: flight.startsWith('Y4') ? 'Volaris' : 'VivaAerobus',
    startAt: `${day}T${dep}:00${TZ}`,
    endAt: `${day}T${arr}:00${TZ}`,
    sourceType: 'flight_schedule',
    sourceUrl: url(day, flight),
    checkedAt: NEW_CHECKED,
    verificationStatus: 'estimated',
    notes: 'HORARIO PUBLICADO — verifica disponibilidad y reserva directamente con la aerolínea.',
    ...extra,
  }
}

const VB = () => scheduled('outbound-flight-20261001-vb1392', 'VB1392', '2026-10-01', '06:00', '07:16')

function pkg(startDate: string, travelOptions: PackageTravelOption[]): TripPackageV1 {
  return {
    schemaVersion: 1,
    packageId: PKG_ID,
    revision: 3,
    generatedAt: '2026-09-30T18:00:00Z',
    trip: {
      id: TRIP_ID,
      title: 'Viaje a Totatiche',
      destination: 'Totatiche, Jalisco',
      startDate,
      endDate: '2026-10-08',
      timezone: 'America/Mexico_City',
      goals: [],
      status: 'planned',
    },
    travelOptions,
    itineraryItems: [],
    checklistItems: [],
    notes: [],
  }
}

const op = (o: AgentOpRecord['op'], externalId: string): AgentOpRecord => ({
  op,
  entityKind: 'travelOption',
  externalId,
})

function prepare(p: TripPackageV1, llmOps: AgentOpRecord[], startDate = '2026-10-06') {
  return prepareMutationPlan({
    tripId: TRIP_ID,
    currentTrip: trip(startDate),
    currentOptions: current(),
    rawPackage: p,
    llmOps,
  })
}

const day = (iso?: string) => iso?.slice(0, 10)

/** The invariant, on the preview package and on the applied result. */
function assertNoForeignDayProvenance(prepared: ReturnType<typeof prepare>) {
  const applied = applyMutationInMemory({
    tripId: TRIP_ID,
    packageId: PKG_ID,
    existing: current(),
    packageOptions: prepared.normalizedPackage.travelOptions.map((o) => ({ ...o })),
    ops: prepared.canonicalOps,
  }).options
  const before = new Map(current().map((o) => [o.externalId, o]))
  for (const o of [...prepared.normalizedPackage.travelOptions, ...applied]) {
    if (o.type !== 'flight') continue
    const src = sourceUrlDay(o.sourceUrl)
    if (src) assert.equal(src, day(o.startAt), `${o.externalId}: startAt ${o.startAt} with source ${o.sourceUrl}`)
    const was = before.get(o.externalId)
    if (was && day(was.startAt) !== day(o.startAt)) {
      assert.ok(o.checkedAt !== OLD_CHECKED, `${o.externalId}: 6 Oct checkedAt on a ${day(o.startAt)} flight`)
      assert.doesNotMatch(o.title ?? '', /6 de octubre/, `${o.externalId}: 6 Oct title on a ${day(o.startAt)} flight`)
    }
  }
  return applied
}

describe('flight_schedule provenance is bound to its day', () => {
  it('Y4140 6 Oct re-used for the 1 Oct Y4140 schedule → reconciled with the 1 Oct schedule', () => {
    const prepared = prepare(
      pkg('2026-10-01', [
        scheduled('outbound-flight-1', 'Y4140', '2026-10-01', '06:00', '07:18', {
          title: 'Vuelo estimado Ciudad de México (MEX) a Guadalajara (GDL) el 6 de octubre de 2026',
        }),
        VB(),
      ]),
      [op('update', 'outbound-flight-1'), op('add', 'outbound-flight-20261001-vb1392')],
    )
    assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
    const y = prepared.normalizedPackage.travelOptions.find((o) => o.externalId === 'outbound-flight-1')!
    assert.equal(y.startAt, `2026-10-01T06:00:00${TZ}`)
    assert.equal(y.sourceUrl, url('2026-10-01', 'Y4140'))
    assert.equal(y.checkedAt, NEW_CHECKED)
    assert.match(y.title, /Y4140/)
    assert.doesNotMatch(y.notes ?? '', /2026-10-06/)
    assertNoForeignDayProvenance(prepared)
  })

  for (const [label, extra] of [
    ['keeps the 6 Oct sourceUrl/checkedAt', { sourceUrl: url('2026-10-06', 'Y4140'), checkedAt: OLD_CHECKED }],
    ['carries no source at all', { sourceUrl: undefined, checkedAt: undefined, sourceType: 'agent' as const }],
  ] as const) {
    it(`Y4140 6 Oct moved to 1 Oct whose entry ${label} → never startAt 1 Oct with the 6 Oct source`, () => {
      const prepared = prepare(
        pkg('2026-10-01', [scheduled('outbound-flight-1', 'Y4140', '2026-10-01', '06:00', '07:18', extra), VB()]),
        [op('update', 'outbound-flight-1'), op('add', 'outbound-flight-20261001-vb1392')],
      )
      assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
      assert.ok(
        prepared.canonicalOps.some((o) => o.op === 'remove' && o.externalId === 'outbound-flight-1'),
        'the 6 Oct schedule is replaced, not moved',
      )
      assert.ok(prepared.warnings.some((w) => /outbound-flight-1 moved 2026-10-06→2026-10-01 without a schedule/.test(w)))
      const applied = assertNoForeignDayProvenance(prepared)
      assert.ok(!applied.some((o) => o.externalId === 'outbound-flight-1'))
    })
  }

  it('single outbound Y4140 6 Oct moved to 1 Oct with the 6 Oct source → removed, not moved', () => {
    const prepared = prepare(
      pkg('2026-10-01', [
        scheduled('outbound-flight-1', 'Y4140', '2026-10-01', '06:00', '07:18', {
          sourceUrl: url('2026-10-06', 'Y4140'),
          checkedAt: OLD_CHECKED,
        }),
      ]),
      [op('update', 'outbound-flight-1')],
    )
    assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
    assert.ok(prepared.canonicalOps.some((o) => o.op === 'remove' && o.externalId === 'outbound-flight-1'))
    assertNoForeignDayProvenance(prepared)
  })

  it('single outbound re-used with the 1 Oct schedule → reconciled', () => {
    const prepared = prepare(
      pkg('2026-10-01', [scheduled('outbound-flight-1', 'Y4140', '2026-10-01', '06:00', '07:18')]),
      [op('update', 'outbound-flight-1')],
    )
    assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
    const y = prepared.normalizedPackage.travelOptions.find((o) => o.externalId === 'outbound-flight-1')!
    assert.equal(y.sourceUrl, url('2026-10-01', 'Y4140'))
    assert.equal(y.checkedAt, NEW_CHECKED)
    assertNoForeignDayProvenance(prepared)
  })

  it('return leg moved to another day without its schedule → kept on its own day', () => {
    const ret = current().find((o) => o.externalId === 'return-flight-1')!
    const prepared = prepare(
      pkg('2026-10-06', [
        {
          externalId: 'return-flight-1',
          type: 'flight',
          status: 'shortlisted',
          title: ret.title,
          origin: 'GDL',
          destination: 'MEX',
          startAt: `2026-10-07T05:46:00${TZ}`,
          sourceType: 'flight_schedule',
          sourceUrl: ret.sourceUrl,
          checkedAt: OLD_CHECKED,
          verificationStatus: 'estimated',
        },
      ]),
      [op('update', 'return-flight-1')],
    )
    assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
    const r = prepared.normalizedPackage.travelOptions.find((o) => o.externalId === 'return-flight-1')!
    assert.equal(r.startAt, ret.startAt)
    assertNoForeignDayProvenance(prepared)
  })

  it('new id for the 1 Oct Y4140 (b20fc5f7 shape) → old removed, new added', () => {
    const prepared = prepare(
      pkg('2026-10-01', [scheduled('outbound-flight-20261001-y4140', 'Y4140', '2026-10-01', '06:00', '07:18'), VB()]),
      [op('add', 'outbound-flight-20261001-y4140'), op('add', 'outbound-flight-20261001-vb1392'), op('update', 'outbound-flight-1')],
    )
    assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
    assert.ok(prepared.canonicalOps.some((o) => o.op === 'remove' && o.externalId === 'outbound-flight-1'))
    assertNoForeignDayProvenance(prepared)
  })

  it('a new flight citing another day\'s schedule is not presented as a published schedule', () => {
    const prepared = prepare(
      pkg('2026-10-01', [
        scheduled('outbound-flight-20261001-y4140', 'Y4140', '2026-10-01', '06:00', '07:18', {
          sourceUrl: url('2026-10-06', 'Y4140'),
        }),
      ]),
      [op('add', 'outbound-flight-20261001-y4140')],
    )
    assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
    const y = prepared.normalizedPackage.travelOptions.find((o) => o.externalId === 'outbound-flight-20261001-y4140')!
    assert.equal(y.sourceType, 'agent')
    assert.equal(y.sourceUrl, undefined)
    assert.equal(y.verificationStatus, 'unverified')
    assertNoForeignDayProvenance(prepared)
  })

  it('same window, day moved without a schedule → the flight stays on its own day untouched', () => {
    const prepared = prepare(
      pkg('2026-10-06', [
        scheduled('outbound-flight-1', 'Y4140', '2026-10-07', '06:00', '07:18', {
          sourceUrl: url('2026-10-06', 'Y4140'),
          checkedAt: OLD_CHECKED,
        }),
      ]),
      [op('update', 'outbound-flight-1')],
    )
    assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
    const y = prepared.normalizedPackage.travelOptions.find((o) => o.externalId === 'outbound-flight-1')!
    assert.equal(y.startAt, `2026-10-06T06:00:00${TZ}`)
    assert.equal(y.sourceUrl, url('2026-10-06', 'Y4140'))
    assertNoForeignDayProvenance(prepared)
  })
})

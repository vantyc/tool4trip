import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentOpRecord } from '../../shared/agentContracts.ts'
import { fitToShiftedWindow } from './compileMutationPlan.ts'
import { applyMutationInMemory } from './packageMutation.ts'
import { prepareMutationPlan } from './prepareMutationPlan.ts'
import { optionEntityId } from './tripPackage.ts'
import type { TravelOption, Trip } from './domainTypes.ts'
import type { PackageTravelOption, TripPackageV1 } from './tripPackage.ts'

/**
 * Existing trip, window change on one boundary. The model re-lists flights,
 * emits `update` ops for lodging and ground transfer but omits both from the
 * package. Window-dependent components must follow the moved boundary or
 * block Apply — never stay silently on the old dates.
 */

const TRIP_ID = '22222222-3333-4444-8555-666666666666'
const PKG_ID = `pkg-${TRIP_ID}-0001`
const TZ = '-06:00'
const HINT = 'Fecha asociada (sin hora verificada):'

type Scenario = {
  name: string
  oldStart: string
  newStart: string
  end: string
  hub: string
  gateway: string
  town: string
}
const SCENARIOS: Scenario[] = [
  { name: 'start moves 4 days earlier', oldStart: '2026-10-06', newStart: '2026-10-02', end: '2026-10-08', hub: 'MEX', gateway: 'GDL', town: 'Pueblo Uno, Jalisco' },
  { name: 'start moves 1 day later', oldStart: '2027-03-10', newStart: '2027-03-11', end: '2027-03-15', hub: 'MTY', gateway: 'ZCL', town: 'Villa Dos, Zacatecas' },
]

type Dating = 'hint' | 'clocks'

function trip(s: Scenario, startDate = s.oldStart, endDate = s.end): Trip {
  return {
    id: TRIP_ID,
    title: 'Viaje a fiestas',
    destination: s.town,
    startDate,
    endDate,
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

const url = (o: string, d: string, day: string, n: string) =>
  `https://aerodatabox.com/?origin=${o}&destination=${d}&date=${day}&flight=${n}`

function flight(id: string, o: string, d: string, day: string, clock: string, n: string): TravelOption {
  return opt(id, {
    type: 'flight',
    title: `${o} → ${d} ${n}`,
    origin: o,
    destination: d,
    startAt: `${day}T${clock}:00${TZ}`,
    sourceType: 'flight_schedule',
    sourceUrl: url(o, d, day, n),
    verificationStatus: 'estimated',
  })
}

function current(s: Scenario, dating: Dating): TravelOption[] {
  const lodging =
    dating === 'hint'
      ? opt('lodging-main', {
          type: 'lodging',
          title: 'Hospedaje en destino (pendiente de verificar)',
          destination: s.town,
          notes: `Hospedaje cerca de la plaza.\n${HINT} ${s.oldStart}`,
          verificationStatus: 'unverified',
        })
      : opt('lodging-main', {
          type: 'lodging',
          title: 'Hospedaje en destino (estimado · 2 noche(s))',
          destination: s.town,
          startAt: `${s.oldStart}T15:00:00${TZ}`,
          endAt: `${s.end}T12:00:00${TZ}`,
          verificationStatus: 'estimated',
        })
  const transfer =
    dating === 'hint'
      ? opt('transfer-arrival', {
          type: 'transfer',
          title: `Traslado ${s.gateway} → destino`,
          origin: s.gateway,
          destination: s.town,
          notes: 'Transporte terrestre estimado.',
          verificationStatus: 'unverified',
        })
      : opt('transfer-arrival', {
          type: 'transfer',
          title: `Traslado ${s.gateway} → destino`,
          origin: s.gateway,
          destination: s.town,
          startAt: `${s.oldStart}T14:00:00${TZ}`,
          verificationStatus: 'estimated',
        })
  return [
    flight('outbound-flight-1', s.hub, s.gateway, s.oldStart, '06:00', 'AA100'),
    flight('outbound-sched-2', s.hub, s.gateway, s.oldStart, '07:00', 'AA101'),
    flight('return-flight-1', s.gateway, s.hub, s.end, '05:46', 'BB200'),
    flight('return-sched-2', s.gateway, s.hub, s.end, '06:02', 'BB201'),
    lodging,
    transfer,
  ]
}

function pkgOpt(o: TravelOption, externalId = o.externalId!): PackageTravelOption {
  return {
    externalId,
    type: o.type as PackageTravelOption['type'],
    status: 'researched',
    title: o.title,
    origin: o.origin,
    destination: o.destination,
    startAt: o.startAt,
    endAt: o.endAt,
    sourceType: o.sourceType as PackageTravelOption['sourceType'],
    sourceUrl: o.sourceUrl,
    verificationStatus: o.verificationStatus as PackageTravelOption['verificationStatus'],
  }
}

function pkg(s: Scenario, travelOptions: PackageTravelOption[], startDate = s.newStart): TripPackageV1 {
  return {
    schemaVersion: 1,
    packageId: PKG_ID,
    revision: 2,
    generatedAt: '2026-09-29T00:00:00Z',
    trip: {
      id: TRIP_ID,
      title: 'Viaje a fiestas',
      destination: s.town,
      startDate,
      endDate: s.end,
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

/** Shape of the real model output: new outbound ids, returns re-listed under new ids, lodging/transfer omitted. */
function modelProposal(s: Scenario, dating: Dating): { pkg: TripPackageV1; ops: AgentOpRecord[] } {
  const cur = current(s, dating)
  const newOut = [
    flight('flt-out-new-1', s.hub, s.gateway, s.newStart, '06:00', 'AA300'),
    flight('flt-out-new-2', s.hub, s.gateway, s.newStart, '06:45', 'AA301'),
  ].map((o) => pkgOpt(o))
  const relistedReturns = cur
    .filter((o) => o.externalId!.startsWith('return'))
    .map((o, i) => pkgOpt(o, `flt-ret-new-${i + 1}`))
  const ops: AgentOpRecord[] = [
    { op: 'remove', entityKind: 'travelOption', externalId: 'outbound-flight-1' },
    { op: 'remove', entityKind: 'travelOption', externalId: 'return-flight-1' },
    { op: 'update', entityKind: 'travelOption', externalId: 'lodging-main', note: 'nuevas fechas' },
    { op: 'update', entityKind: 'travelOption', externalId: 'transfer-arrival', note: 'nueva fecha' },
    ...newOut.map((o) => ({ op: 'add' as const, entityKind: 'travelOption' as const, externalId: o.externalId })),
    ...relistedReturns.map((o) => ({ op: 'add' as const, entityKind: 'travelOption' as const, externalId: o.externalId })),
  ]
  return { pkg: pkg(s, [...newOut, ...relistedReturns]), ops }
}

function prepare(s: Scenario, cur: TravelOption[], p: TripPackageV1, ops: AgentOpRecord[], t = trip(s)) {
  return prepareMutationPlan({ tripId: TRIP_ID, currentTrip: t, currentOptions: cur, rawPackage: p, llmOps: ops })
}

function applied(cur: TravelOption[], prepared: ReturnType<typeof prepare>) {
  return applyMutationInMemory({
    tripId: TRIP_ID,
    packageId: prepared.normalizedPackage.packageId,
    existing: cur,
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

const day = (iso?: string) => iso?.slice(0, 10)

for (const s of SCENARIOS) {
  describe(`window shift, lodging/transfer omitted with update ops (${s.name})`, () => {
    for (const dating of ['hint', 'clocks'] as const) {
      it(`${dating}: components follow the moved start; flights replaced/kept; packageId stable`, () => {
        const cur = current(s, dating)
        const { pkg: p, ops } = modelProposal(s, dating)
        const prepared = prepare(s, cur, p, ops)
        assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
        assert.equal(prepared.normalizedPackage.packageId, PKG_ID)
        assert.equal(prepared.normalizedPackage.trip.startDate, s.newStart)

        const removed = prepared.canonicalOps.filter((o) => o.op === 'remove').map((o) => o.externalId).sort()
        assert.deepEqual(removed, ['outbound-flight-1', 'outbound-sched-2'])
        assert.ok(!prepared.canonicalOps.some((o) => ['lodging-main', 'transfer-arrival'].includes(o.externalId) && o.op === 'remove'))

        const final = applied(cur, prepared)
        const ids = final.map((o) => o.externalId).sort()
        assert.deepEqual(ids, [
          'flt-out-new-1',
          'flt-out-new-2',
          'lodging-main',
          'return-flight-1',
          'return-sched-2',
          'transfer-arrival',
        ])
        assert.ok(final.every((o) => o.packageId === PKG_ID))

        const lodging = final.find((o) => o.externalId === 'lodging-main')!
        const transfer = final.find((o) => o.externalId === 'transfer-arrival')!
        assert.equal(lodging.status, 'researched')
        assert.equal(lodging.sourceType, 'agent')
        if (dating === 'hint') {
          assert.equal(lodging.startAt, undefined, 'no invented clock')
          assert.equal(lodging.endAt, undefined)
          assert.ok(lodging.notes?.includes(`${HINT} ${s.newStart}`))
          assert.ok(!lodging.notes?.includes(s.oldStart))
          assert.equal(transfer.startAt, undefined, 'no date to invent for an undated transfer')
          assert.ok(
            prepared.warnings.some((w) => w.includes('transfer-arrival') && /no window-dependent date/.test(w)),
          )
        } else {
          assert.equal(lodging.startAt, `${s.newStart}T15:00:00${TZ}`)
          assert.equal(lodging.endAt, `${s.end}T12:00:00${TZ}`)
          assert.ok(!/2 noche\(s\)/.test(lodging.title) || s.newStart === s.oldStart)
          assert.equal(transfer.startAt, `${s.newStart}T14:00:00${TZ}`)
        }
        assert.ok(
          !final.some((o) => day(o.startAt) === s.oldStart || o.notes?.includes(`${HINT} ${s.oldStart}`)),
          'nothing left on the old start day',
        )
        const updates = prepared.diff.filter((l) => l.kind === 'update').map((l) => l.externalId)
        assert.ok(updates.includes('lodging-main'))
        if (dating === 'clocks') assert.ok(updates.includes('transfer-arrival'))
      })
    }

    it('omission without a window change keeps lodging/transfer intact', () => {
      const cur = current(s, 'clocks')
      const p = pkg(s, cur.filter((o) => o.type === 'flight').map((o) => pkgOpt(o)), s.oldStart)
      const prepared = prepare(s, cur, p, [])
      assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
      assert.ok(!prepared.canonicalOps.some((o) => ['lodging-main', 'transfer-arrival'].includes(o.externalId)))
      const final = applied(cur, prepared)
      const lodging = final.find((o) => o.externalId === 'lodging-main')!
      assert.equal(lodging.startAt, `${s.oldStart}T15:00:00${TZ}`)
      assert.equal(final.find((o) => o.externalId === 'transfer-arrival')!.startAt, `${s.oldStart}T14:00:00${TZ}`)
    })

    it('window shift without update ops still realigns and never deletes', () => {
      const cur = current(s, 'clocks')
      const { pkg: p } = modelProposal(s, 'clocks')
      const prepared = prepare(s, cur, p, [])
      assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
      const final = applied(cur, prepared)
      assert.equal(final.find((o) => o.externalId === 'lodging-main')!.startAt, `${s.newStart}T15:00:00${TZ}`)
      assert.equal(final.find((o) => o.externalId === 'transfer-arrival')!.startAt, `${s.newStart}T14:00:00${TZ}`)
    })

    it('update op for an omitted component without a window change → review, no mutation', () => {
      const cur = current(s, 'clocks')
      const p = pkg(s, cur.filter((o) => o.type === 'flight').map((o) => pkgOpt(o)), s.oldStart)
      const prepared = prepare(s, cur, p, [
        { op: 'update', entityKind: 'travelOption', externalId: 'lodging-main', note: 'cambiar hotel' },
      ])
      assert.equal(prepared.status, 'review_required')
      assert.ok(prepared.conflicts.some((c) => /update op for lodging-main has no package entry/.test(c)))
      assert.deepEqual(prepared.canonicalOps, [])
    })

    it('partial stay the rule cannot place → review, not stale data', () => {
      const cur = current(s, 'clocks').map((o) =>
        o.externalId === 'lodging-main'
          ? { ...o, startAt: `${s.end}T15:00:00${TZ}`, endAt: undefined }
          : o,
      )
      const t = trip(s)
      const { pkg: p, ops } = modelProposal(s, 'clocks')
      const earlierEnd = p.travelOptions.filter((o) => !o.externalId.startsWith('flt-ret'))
      const shrunk = pkg(s, earlierEnd)
      shrunk.trip.endDate = s.newStart
      const prepared = prepare(s, cur, shrunk, ops.filter((o) => !o.externalId.startsWith('flt-ret')), t)
      assert.equal(prepared.status, 'review_required')
      assert.ok(prepared.conflicts.some((c) => /lodging-main .*dates cannot be derived/.test(c)))
    })

    it('verified or protected component that would move → review', () => {
      const verified = current(s, 'clocks').map((o) =>
        o.externalId === 'lodging-main' ? { ...o, verificationStatus: 'verified' as const, sourceUrl: 'https://hotel.example/reserva' } : o,
      )
      const { pkg: p, ops } = modelProposal(s, 'clocks')
      const a = prepare(s, verified, p, ops)
      assert.equal(a.status, 'review_required')
      assert.ok(a.conflicts.some((c) => /lodging-main was verified for the old dates/.test(c)))

      const selected = current(s, 'clocks').map((o) =>
        o.externalId === 'transfer-arrival' ? { ...o, status: 'selected' as const } : o,
      )
      const b = prepare(s, selected, p, ops)
      assert.equal(b.status, 'review_required')
      assert.ok(b.conflicts.some((c) => /protected transfer-arrival/.test(c)))
    })
  })
}

describe('fitToShiftedWindow', () => {
  const from = { startDate: '2026-05-10', endDate: '2026-05-14' }
  const to = { startDate: '2026-05-08', endDate: '2026-05-14' }

  it('undated component → keep (nothing to invent)', () => {
    assert.deepEqual(fitToShiftedWindow({ externalId: 'x' }, 'lodging_primary', from, to), { kind: 'keep' })
    assert.deepEqual(fitToShiftedWindow({ externalId: 'x' }, 'ground_transfer', from, to), { kind: 'keep' })
  })

  it('transfer on the unmoved end day → keep', () => {
    assert.deepEqual(
      fitToShiftedWindow({ externalId: 'x', startAt: '2026-05-14T09:00:00-06:00' }, 'ground_transfer', from, to),
      { kind: 'keep' },
    )
  })

  it('transfer inside the new window, off the boundaries → keep', () => {
    assert.deepEqual(
      fitToShiftedWindow({ externalId: 'x', startAt: '2026-05-12T09:00:00-06:00' }, 'ground_transfer', from, to),
      { kind: 'keep' },
    )
  })

  it('multi-day transfer on a moved boundary → conflict', () => {
    const fit = fitToShiftedWindow(
      { externalId: 'x', startAt: '2026-05-10T22:00:00-06:00', endAt: '2026-05-11T02:00:00-06:00' },
      'ground_transfer',
      from,
      to,
    )
    assert.equal(fit.kind, 'conflict')
  })

  it('whole-stay lodging takes both moved boundaries', () => {
    const fit = fitToShiftedWindow(
      { externalId: 'x', startAt: '2026-05-10T15:00:00-06:00', endAt: '2026-05-14T11:00:00-06:00' },
      'lodging_primary',
      from,
      { startDate: '2026-05-20', endDate: '2026-05-23' },
    )
    assert.equal(fit.kind, 'rebind')
    if (fit.kind === 'rebind') {
      assert.equal(fit.patch.startAt, '2026-05-20T15:00:00-06:00')
      assert.equal(fit.patch.endAt, '2026-05-23T11:00:00-06:00')
    }
  })
})

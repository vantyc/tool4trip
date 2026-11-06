import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentOpRecord } from '../../shared/agentContracts.ts'
import { applyMutationInMemory } from './packageMutation.ts'
import { prepareMutationPlan } from './prepareMutationPlan.ts'
import { optionEntityId } from './tripPackage.ts'
import type { TravelOption, Trip } from './domainTypes.ts'
import type { PackageTravelOption, TripPackageV1 } from './tripPackage.ts'

/**
 * Ask Travel on an existing trip: the user moves the start of the trip
 * (6→8 becomes 2→8). Current trip has several alternatives per flight leg.
 * The outbound leg is replaced as a set, the unchanged return leg is kept,
 * lodging and the arrival transfer follow the new start.
 */

const TRIP_ID = '11111111-2222-4333-8444-555555555555'
const PKG_ID = TRIP_ID
const OLD_START = '2026-10-06'
const NEW_START = '2026-10-02'
const END = '2026-10-08'
const TZ = '-06:00'

type Route = { hub: string; gateway: string; town: string }
const ROUTES: Route[] = [
  { hub: 'MEX', gateway: 'GDL', town: 'Pueblo Uno, Jalisco' },
  { hub: 'MTY', gateway: 'ZCL', town: 'Villa Dos, Zacatecas' },
]

function currentTrip(r: Route): Trip {
  return {
    id: TRIP_ID,
    title: 'Viaje a fiestas',
    destination: r.town,
    startDate: OLD_START,
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
    sourceType: 'flight_schedule',
    externalId,
    packageId: PKG_ID,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    syncStatus: 'synced',
    ...partial,
  }
}

function flightUrl(o: string, d: string, day: string, n: string): string {
  return `https://aerodatabox.com/?origin=${o}&destination=${d}&date=${day}&flight=${n}`
}

const OUT_CLOCKS = ['07:10', '11:40', '16:05']
const RET_CLOCKS = ['09:15', '13:30', '19:50']

function currentOptions(r: Route): TravelOption[] {
  const out = OUT_CLOCKS.map((t, i) =>
    opt(`out-old-${i + 1}`, {
      type: 'flight',
      title: `Vuelo ${r.hub}→${r.gateway} ${OLD_START} ${t}`,
      origin: r.hub,
      destination: r.gateway,
      startAt: `${OLD_START}T${t}:00${TZ}`,
      sourceUrl: flightUrl(r.hub, r.gateway, OLD_START, `XX10${i}`),
      verificationStatus: 'estimated',
    }),
  )
  const ret = RET_CLOCKS.map((t, i) =>
    opt(`ret-${i + 1}`, {
      type: 'flight',
      title: `Vuelo ${r.gateway}→${r.hub} ${END} ${t}`,
      origin: r.gateway,
      destination: r.hub,
      startAt: `${END}T${t}:00${TZ}`,
      sourceUrl: flightUrl(r.gateway, r.hub, END, `XX20${i}`),
      verificationStatus: 'estimated',
    }),
  )
  return [
    ...out,
    ...ret,
    opt('lodging-main', {
      type: 'lodging',
      title: `Hospedaje ${r.town} (estimado · 2 noche(s))`,
      destination: r.town,
      startAt: `${OLD_START}T15:00:00${TZ}`,
      endAt: `${END}T12:00:00${TZ}`,
      sourceType: 'agent',
      verificationStatus: 'estimated',
    }),
    opt('transfer-arrival', {
      type: 'transfer',
      title: `Traslado ${r.gateway} → ${r.town}`,
      origin: r.gateway,
      destination: r.town,
      startAt: `${OLD_START}T14:00:00${TZ}`,
      sourceType: 'agent',
      verificationStatus: 'estimated',
    }),
  ]
}

function newOutbound(r: Route): PackageTravelOption[] {
  return ['06:30', '10:20', '15:45'].map((t, i) => ({
    externalId: `out-new-${i + 1}`,
    type: 'flight',
    status: 'researched',
    title: `Vuelo ${r.hub}→${r.gateway} ${NEW_START} ${t}`,
    origin: r.hub,
    destination: r.gateway,
    startAt: `${NEW_START}T${t}:00${TZ}`,
    sourceType: 'flight_schedule',
    sourceUrl: flightUrl(r.hub, r.gateway, NEW_START, `XX30${i}`),
    verificationStatus: 'estimated',
  }))
}

function sameReturns(r: Route): PackageTravelOption[] {
  return currentOptions(r)
    .filter((o) => o.externalId?.startsWith('ret-'))
    .map((o) => ({
      externalId: o.externalId!,
      type: 'flight',
      status: 'researched',
      title: o.title,
      origin: o.origin,
      destination: o.destination,
      startAt: o.startAt,
      sourceType: 'flight_schedule',
      sourceUrl: o.sourceUrl,
      verificationStatus: 'estimated',
    }))
}

function proposal(
  r: Route,
  opts: { returns: 'omitted' | 'same' },
): TripPackageV1 {
  return {
    schemaVersion: 1,
    packageId: PKG_ID,
    revision: 2,
    generatedAt: '2026-09-29T00:00:00Z',
    trip: {
      id: TRIP_ID,
      title: 'Viaje a fiestas',
      destination: r.town,
      startDate: NEW_START,
      endDate: END,
      timezone: 'America/Mexico_City',
      goals: [],
      status: 'planned',
    },
    travelOptions: [
      ...newOutbound(r),
      ...(opts.returns === 'same' ? sameReturns(r) : []),
      {
        externalId: 'lodging-main',
        type: 'lodging',
        status: 'researched',
        title: `Hospedaje ${r.town} (estimado · 6 noche(s))`,
        destination: r.town,
        startAt: `${NEW_START}T15:00:00${TZ}`,
        endAt: `${END}T12:00:00${TZ}`,
        sourceType: 'agent',
        verificationStatus: 'estimated',
      },
      {
        externalId: 'transfer-arrival',
        type: 'transfer',
        status: 'researched',
        title: `Traslado ${r.gateway} → ${r.town}`,
        origin: r.gateway,
        destination: r.town,
        startAt: `${NEW_START}T14:00:00${TZ}`,
        sourceType: 'agent',
        verificationStatus: 'estimated',
      },
    ],
    itineraryItems: [],
    checklistItems: [],
    notes: [],
  }
}

function prepare(
  r: Route,
  pkg: TripPackageV1,
  current = currentOptions(r),
  llmOps: AgentOpRecord[] = [],
) {
  return prepareMutationPlan({
    tripId: TRIP_ID,
    currentTrip: currentTrip(r),
    currentOptions: current,
    rawPackage: pkg,
    llmOps,
  })
}

function applied(r: Route, prepared: ReturnType<typeof prepare>) {
  return applyMutationInMemory({
    tripId: TRIP_ID,
    packageId: PKG_ID,
    existing: currentOptions(r),
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

for (const r of ROUTES) {
  describe(`leg alternatives + window shift 6→8 ⇒ 2→8 (${r.hub}→${r.gateway})`, () => {
    for (const returns of ['omitted', 'same'] as const) {
      it(`returns ${returns}: outbound set replaced, returns kept, Apply enabled`, () => {
        const prepared = prepare(r, proposal(r, { returns }))

        assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
        assert.deepEqual(prepared.conflicts, [])
        assert.ok(
          !prepared.conflicts.some((c) => /ambiguous flight_outbound/.test(c)),
        )

        const tripLine = prepared.diff.find((l) => l.entityKind === 'trip')
        assert.ok(tripLine, 'preview shows the trip window update')
        assert.deepEqual(
          tripLine!.fields?.find((f) => f.field === 'startDate'),
          { field: 'startDate', before: OLD_START, after: NEW_START },
        )
        assert.equal(prepared.normalizedPackage.trip.startDate, NEW_START)
        assert.equal(prepared.normalizedPackage.trip.endDate, END)

        const removed = prepared.diff
          .filter((l) => l.kind === 'remove')
          .map((l) => l.externalId)
          .sort()
        assert.deepEqual(removed, ['out-old-1', 'out-old-2', 'out-old-3'])
        const addedIds = prepared.diff
          .filter((l) => l.kind === 'add')
          .map((l) => l.externalId)
          .sort()
        assert.deepEqual(addedIds, ['out-new-1', 'out-new-2', 'out-new-3'])
        assert.ok(
          !prepared.canonicalOps.some(
            (o) =>
              o.op === 'remove' &&
              (o.externalId.startsWith('ret-') ||
                o.externalId === 'lodging-main' ||
                o.externalId === 'transfer-arrival'),
          ),
        )

        const final = applied(r, prepared)
        const flights = final.filter((o) => o.type === 'flight')
        const outs = flights.filter((o) => o.externalId?.startsWith('out-'))
        const rets = flights.filter((o) => o.externalId?.startsWith('ret-'))
        assert.equal(outs.length, 3)
        assert.ok(outs.every((o) => day(o.startAt) === NEW_START))
        assert.deepEqual(
          rets.map((o) => o.externalId).sort(),
          ['ret-1', 'ret-2', 'ret-3'],
        )
        assert.ok(rets.every((o) => day(o.startAt) === END))
        assert.ok(
          !final.some((o) => day(o.startAt) === OLD_START),
          'no option left on the old start day',
        )

        const lodging = final.filter((o) => o.type === 'lodging')
        assert.equal(lodging.length, 1)
        assert.equal(day(lodging[0]!.startAt), NEW_START)
        assert.equal(day(lodging[0]!.endAt), END)
        const transfer = final.filter((o) => o.type === 'transfer')
        assert.equal(transfer.length, 1)
        assert.equal(day(transfer[0]!.startAt), NEW_START)
      })
    }

    it('proposal re-listing an old outbound under a new id does not duplicate it', () => {
      const pkg = proposal(r, { returns: 'omitted' })
      const oldCopy = currentOptions(r).find((o) => o.externalId === 'out-old-1')!
      pkg.travelOptions.push({
        externalId: 'out-copy',
        type: 'flight',
        status: 'researched',
        title: oldCopy.title,
        origin: oldCopy.origin,
        destination: oldCopy.destination,
        startAt: oldCopy.startAt,
        sourceType: 'flight_schedule',
        sourceUrl: oldCopy.sourceUrl,
        verificationStatus: 'estimated',
      })
      const prepared = prepare(r, pkg)
      assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
      const final = applied(r, prepared)
      assert.ok(!final.some((o) => o.externalId === 'out-copy'))
      assert.equal(
        final.filter((o) => day(o.startAt) === OLD_START).length,
        1,
        'the re-proposed old flight stays once (it is on a day the new set covers)',
      )
    })

    it('a user-selected old outbound blocks Apply instead of being deleted', () => {
      const current = currentOptions(r).map((o) =>
        o.externalId === 'out-old-2' ? { ...o, status: 'selected' as const } : o,
      )
      const prepared = prepare(r, proposal(r, { returns: 'omitted' }), current)
      assert.equal(prepared.status, 'review_required')
      assert.ok(prepared.conflicts.some((c) => /protected out-old-2/.test(c)))
    })

    it('empty research-only package: no ambiguous conflict, nothing deleted', () => {
      const pkg: TripPackageV1 = {
        ...proposal(r, { returns: 'omitted' }),
        trip: { ...proposal(r, { returns: 'omitted' }).trip, startDate: OLD_START },
        travelOptions: [],
      }
      const prepared = prepare(r, pkg)
      assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
      assert.ok(!prepared.canonicalOps.some((o) => o.op === 'remove'))
    })

    it('window moves but outbound omitted: old outbound kept with a stale-date warning', () => {
      const pkg = proposal(r, { returns: 'omitted' })
      pkg.travelOptions = pkg.travelOptions.filter((o) => o.type !== 'flight')
      const prepared = prepare(r, pkg)
      assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
      assert.ok(!prepared.canonicalOps.some((o) => o.op === 'remove'))
      assert.ok(
        prepared.warnings.some((w) =>
          w.includes(`not on new date ${NEW_START}`),
        ),
      )
    })
  })
}

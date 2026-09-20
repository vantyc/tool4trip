import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { agentOpRecordSchema } from '../../shared/agentContracts.ts'
import { optionEntityId } from './tripPackage.ts'
import type { TravelOption } from './domainTypes.ts'
import {
  PackageMutationConflictError,
  PackageMutationValidationError,
  applyMutationInMemory,
  derivedEntitiesForTravelOption,
  isProtectedTravelOption,
  parseImportBody,
  validateMutationOps,
} from './packageMutation.ts'
import type { TripPackageV1 } from './tripPackage.ts'

const TRIP_ID = 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28'
const PKG_ID = TRIP_ID

function opt(
  externalId: string,
  partial: Partial<TravelOption> & Pick<TravelOption, 'title' | 'startAt'>,
): TravelOption {
  return {
    id: optionEntityId(PKG_ID, externalId),
    tripId: TRIP_ID,
    type: 'flight',
    status: 'shortlisted',
    sourceType: 'agent',
    externalId,
    packageId: PKG_ID,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    syncStatus: 'synced',
    ...partial,
  }
}

function baseExisting(): TravelOption[] {
  return [
    opt('outbound-flight-1', {
      title: 'Vuelo estimado directo MEX → GDL el domingo 20',
      startAt: '2026-09-20T07:00:00-06:00',
    }),
    opt('return-flight-1', {
      title: 'Vuelo estimado directo GDL → MEX el martes 22',
      startAt: '2026-09-22T12:00:00-06:00',
    }),
    opt('return-flight-2', {
      title: 'Vuelo estimado directo GDL → MEX el lunes 21 (alternativa)',
      startAt: '2026-09-21T12:00:00-06:00',
      status: 'researched',
    }),
    {
      ...opt('lodge-skeleton-1', {
        title: 'Hospedaje San Miguel el Alto',
        startAt: '2026-09-19T15:00:00-06:00',
        endAt: '2026-09-22T12:00:00-06:00',
      }),
      type: 'lodging',
      status: 'researched',
    },
    {
      ...opt('ground-transfer-1', {
        title: 'Traslado terrestre estimado Guadalajara → San Miguel el Alto',
        startAt: undefined as unknown as string,
      }),
      type: 'transfer',
      status: 'researched',
      startAt: undefined,
    },
  ]
}

const am222Url =
  'https://aerodatabox.com/?origin=MEX&destination=GDL&date=2026-09-25&flight=AM222'
const y4141Url =
  'https://aerodatabox.com/?origin=GDL&destination=MEX&date=2026-09-28&flight=Y4141'

describe('packageMutation contract', () => {
  it('parses remove and supersede ops', () => {
    const rem = agentOpRecordSchema.parse({
      op: 'remove',
      entityKind: 'travelOption',
      externalId: 'return-flight-2',
    })
    assert.equal(rem.op, 'remove')
    const sup = agentOpRecordSchema.parse({
      op: 'supersede',
      entityKind: 'travelOption',
      externalId: 'outbound-flight-25sep',
      supersedesExternalId: 'outbound-flight-1',
    })
    assert.equal(sup.supersedesExternalId, 'outbound-flight-1')
  })

  it('rejects supersede without supersedesExternalId', () => {
    const r = agentOpRecordSchema.safeParse({
      op: 'supersede',
      entityKind: 'travelOption',
      externalId: 'outbound-flight-25sep',
    })
    assert.equal(r.success, false)
  })

  it('parseImportBody: legacy package has empty ops; wrapped carries ops', () => {
    const legacy = parseImportBody({
      schemaVersion: 1,
      packageId: 'p',
      travelOptions: [],
    })
    assert.equal(legacy.ops.length, 0)
    const wrapped = parseImportBody({
      package: { schemaVersion: 1, packageId: 'p', travelOptions: [] },
      ops: [
        {
          op: 'remove',
          entityKind: 'travelOption',
          externalId: 'return-flight-2',
        },
      ],
    })
    assert.equal(wrapped.ops.length, 1)
    assert.equal(wrapped.ops[0]!.op, 'remove')
  })

  it('derived entities are formula-linked to flight externalId only', () => {
    const d = derivedEntitiesForTravelOption(PKG_ID, 'outbound-flight-1')
    assert.ok(d.itineraryExternalIds.includes('airport-arrival-desk-outbound-flight-1'))
    assert.ok(d.checklistExternalIds.includes('chk-airport-outbound-flight-1'))
    assert.ok(
      d.itineraryEntityIds.every((id) => id.includes('outbound-flight-1')),
    )
  })
})

describe('Ask Travel date-shift Apply (exact repro)', () => {
  it('supersede ida/regreso + remove alternative; keep lodge/transfer; flight_schedule intact', () => {
    const existing = baseExisting()
    const { options, removedExternalIds } = applyMutationInMemory({
      tripId: TRIP_ID,
      packageId: PKG_ID,
      existing,
      packageOptions: [
        {
          externalId: 'outbound-flight-25sep',
          type: 'flight',
          status: 'shortlisted',
          title: 'Vuelo estimado directo MEX → GDL el viernes 25',
          startAt: '2026-09-25T11:15:00-06:00',
          endAt: '2026-09-25T12:52:00-06:00',
          sourceType: 'flight_schedule',
          sourceUrl: am222Url,
          provider: 'Aeromexico',
          verificationStatus: 'estimated',
        },
        {
          externalId: 'return-flight-28sep',
          type: 'flight',
          status: 'shortlisted',
          title: 'Vuelo estimado directo GDL → MEX el lunes 28',
          startAt: '2026-09-28T08:22:00-06:00',
          endAt: '2026-09-28T09:45:00-06:00',
          sourceType: 'flight_schedule',
          sourceUrl: y4141Url,
          provider: 'Volaris',
          verificationStatus: 'estimated',
        },
        {
          externalId: 'lodge-skeleton-1',
          type: 'lodging',
          status: 'researched',
          title: 'Hospedaje San Miguel el Alto (estimado · 3 noche(s))',
          startAt: '2026-09-25T15:00:00-06:00',
          endAt: '2026-09-28T12:00:00-06:00',
          sourceType: 'agent',
        },
        {
          externalId: 'ground-transfer-1',
          type: 'transfer',
          status: 'researched',
          title: 'Traslado terrestre estimado Guadalajara → San Miguel el Alto',
          sourceType: 'agent',
        },
      ],
      ops: [
        {
          op: 'supersede',
          entityKind: 'travelOption',
          externalId: 'outbound-flight-25sep',
          supersedesExternalId: 'outbound-flight-1',
        },
        {
          op: 'supersede',
          entityKind: 'travelOption',
          externalId: 'return-flight-28sep',
          supersedesExternalId: 'return-flight-1',
        },
        {
          op: 'remove',
          entityKind: 'travelOption',
          externalId: 'return-flight-2',
        },
        {
          op: 'update',
          entityKind: 'travelOption',
          externalId: 'lodge-skeleton-1',
        },
      ],
    })

    const byExt = (e: string) => options.find((o) => o.externalId === e)
    assert.equal(byExt('outbound-flight-1'), undefined)
    assert.equal(byExt('return-flight-1'), undefined)
    assert.equal(byExt('return-flight-2'), undefined)
    assert.ok(byExt('outbound-flight-25sep'))
    assert.ok(byExt('return-flight-28sep'))
    assert.equal(byExt('outbound-flight-25sep')!.sourceType, 'flight_schedule')
    assert.equal(byExt('return-flight-28sep')!.sourceType, 'flight_schedule')
    assert.equal(byExt('outbound-flight-25sep')!.sourceUrl, am222Url)
    assert.equal(byExt('return-flight-28sep')!.sourceUrl, y4141Url)
    assert.ok(byExt('lodge-skeleton-1'))
    assert.equal(byExt('lodge-skeleton-1')!.startAt, '2026-09-25T15:00:00-06:00')
    assert.ok(byExt('ground-transfer-1'))
    assert.deepEqual(removedExternalIds.sort(), [
      'outbound-flight-1',
      'return-flight-1',
      'return-flight-2',
    ])
    // no second trip
    assert.ok(options.every((o) => o.tripId === TRIP_ID))
  })

  it('3: entity absent from package WITHOUT remove op → conserved', () => {
    const existing = baseExisting()
    const { options } = applyMutationInMemory({
      tripId: TRIP_ID,
      packageId: PKG_ID,
      existing,
      packageOptions: [
        {
          externalId: 'outbound-flight-25sep',
          type: 'flight',
          status: 'shortlisted',
          title: 'new out',
          startAt: '2026-09-25T11:15:00-06:00',
          sourceType: 'flight_schedule',
          sourceUrl: am222Url,
        },
        {
          externalId: 'lodge-skeleton-1',
          type: 'lodging',
          status: 'researched',
          title: 'lodge',
          startAt: '2026-09-25T15:00:00-06:00',
          sourceType: 'agent',
        },
        {
          externalId: 'ground-transfer-1',
          type: 'transfer',
          status: 'researched',
          title: 'transfer',
          sourceType: 'agent',
        },
      ],
      ops: [
        {
          op: 'add',
          entityKind: 'travelOption',
          externalId: 'outbound-flight-25sep',
        },
      ],
    })
    // Old flights still present — no remove/supersede
    assert.ok(options.find((o) => o.externalId === 'outbound-flight-1'))
    assert.ok(options.find((o) => o.externalId === 'return-flight-1'))
    assert.ok(options.find((o) => o.externalId === 'return-flight-2'))
    assert.ok(options.find((o) => o.externalId === 'outbound-flight-25sep'))
  })
})

describe('packageMutation protections', () => {
  it('1: explicit remove of research option works', () => {
    const { options } = applyMutationInMemory({
      tripId: TRIP_ID,
      packageId: PKG_ID,
      existing: baseExisting(),
      packageOptions: baseExisting()
        .filter((o) => o.externalId !== 'return-flight-2')
        .map((o) => ({
          externalId: o.externalId!,
          type: o.type,
          status: o.status === 'shortlisted' ? 'shortlisted' : 'researched',
          title: o.title,
          startAt: o.startAt,
          sourceType: o.sourceType,
        })),
      ops: [
        {
          op: 'remove',
          entityKind: 'travelOption',
          externalId: 'return-flight-2',
        },
      ],
    })
    assert.equal(
      options.find((o) => o.externalId === 'return-flight-2'),
      undefined,
    )
  })

  it('2: supersede — old out, new in', () => {
    const { options } = applyMutationInMemory({
      tripId: TRIP_ID,
      packageId: PKG_ID,
      existing: baseExisting(),
      packageOptions: [
        {
          externalId: 'outbound-flight-25sep',
          type: 'flight',
          status: 'shortlisted',
          title: 'AM222',
          startAt: '2026-09-25T11:15:00-06:00',
          sourceType: 'flight_schedule',
          sourceUrl: am222Url,
        },
        ...baseExisting()
          .filter((o) => o.externalId !== 'outbound-flight-1')
          .map((o) => ({
            externalId: o.externalId!,
            type: o.type,
            status: 'researched' as const,
            title: o.title,
            startAt: o.startAt,
            sourceType: o.sourceType,
          })),
      ],
      ops: [
        {
          op: 'supersede',
          entityKind: 'travelOption',
          externalId: 'outbound-flight-25sep',
          supersedesExternalId: 'outbound-flight-1',
        },
      ],
    })
    assert.equal(
      options.find((o) => o.externalId === 'outbound-flight-1'),
      undefined,
    )
    assert.ok(options.find((o) => o.externalId === 'outbound-flight-25sep'))
  })

  it('4: selected + remove → conflict (no silent delete)', () => {
    const existing = baseExisting()
    existing[0]!.status = 'selected'
    assert.throws(
      () =>
        applyMutationInMemory({
          tripId: TRIP_ID,
          packageId: PKG_ID,
          existing,
          packageOptions: [
            {
              externalId: 'outbound-flight-25sep',
              type: 'flight',
              status: 'shortlisted',
              title: 'x',
              startAt: '2026-09-25T11:15:00-06:00',
              sourceType: 'flight_schedule',
            },
          ],
          ops: [
            {
              op: 'remove',
              entityKind: 'travelOption',
              externalId: 'outbound-flight-1',
            },
          ],
        }),
      PackageMutationConflictError,
    )
  })

  it('5: bookingId + supersede → conflict', () => {
    const existing = baseExisting()
    existing[0]!.bookingId = 'booking-1'
    existing[0]!.status = 'booked'
    assert.throws(
      () =>
        applyMutationInMemory({
          tripId: TRIP_ID,
          packageId: PKG_ID,
          existing,
          packageOptions: [
            {
              externalId: 'outbound-flight-25sep',
              type: 'flight',
              status: 'shortlisted',
              title: 'x',
              startAt: '2026-09-25T11:15:00-06:00',
              sourceType: 'flight_schedule',
            },
          ],
          ops: [
            {
              op: 'supersede',
              entityKind: 'travelOption',
              externalId: 'outbound-flight-25sep',
              supersedesExternalId: 'outbound-flight-1',
            },
          ],
        }),
      PackageMutationConflictError,
    )
  })

  it('6: supersede new id missing from package → validation error', () => {
    assert.throws(
      () =>
        applyMutationInMemory({
          tripId: TRIP_ID,
          packageId: PKG_ID,
          existing: baseExisting(),
          packageOptions: [
            {
              externalId: 'lodge-skeleton-1',
              type: 'lodging',
              status: 'researched',
              title: 'lodge',
              sourceType: 'agent',
            },
          ],
          ops: [
            {
              op: 'supersede',
              entityKind: 'travelOption',
              externalId: 'outbound-flight-25sep',
              supersedesExternalId: 'outbound-flight-1',
            },
          ],
        }),
      PackageMutationValidationError,
    )
  })

  it('9: option of another package → rejected', () => {
    const existing = baseExisting()
    existing[0]!.packageId = 'other-package'
    assert.throws(
      () =>
        applyMutationInMemory({
          tripId: TRIP_ID,
          packageId: PKG_ID,
          existing,
          packageOptions: [
            {
              externalId: 'outbound-flight-25sep',
              type: 'flight',
              status: 'shortlisted',
              title: 'x',
              startAt: '2026-09-25T11:15:00-06:00',
              sourceType: 'flight_schedule',
            },
          ],
          ops: [
            {
              op: 'remove',
              entityKind: 'travelOption',
              externalId: 'outbound-flight-1',
            },
          ],
        }),
      PackageMutationValidationError,
    )
  })

  it('10: re-apply remove is idempotent when already gone', () => {
    const existing = baseExisting().filter(
      (o) => o.externalId !== 'return-flight-2',
    )
    const { options } = applyMutationInMemory({
      tripId: TRIP_ID,
      packageId: PKG_ID,
      existing,
      packageOptions: existing.map((o) => ({
        externalId: o.externalId!,
        type: o.type,
        status: 'researched' as const,
        title: o.title,
        startAt: o.startAt,
        sourceType: o.sourceType,
      })),
      ops: [
        {
          op: 'remove',
          entityKind: 'travelOption',
          externalId: 'return-flight-2',
        },
      ],
    })
    assert.equal(
      options.find((o) => o.externalId === 'return-flight-2'),
      undefined,
    )
  })

  it('rejects remove of entity also present in same package', () => {
    assert.throws(
      () =>
        applyMutationInMemory({
          tripId: TRIP_ID,
          packageId: PKG_ID,
          existing: baseExisting(),
          packageOptions: [
            {
              externalId: 'outbound-flight-25sep',
              type: 'flight',
              status: 'shortlisted',
              title: 'new',
              startAt: '2026-09-25T11:15:00-06:00',
              sourceType: 'flight_schedule',
            },
          ],
          ops: [
            {
              op: 'remove',
              entityKind: 'travelOption',
              externalId: 'outbound-flight-25sep',
            },
          ],
        }),
      PackageMutationValidationError,
    )
  })

  it('rejects remove + supersede on same target', () => {
    assert.throws(
      () =>
        applyMutationInMemory({
          tripId: TRIP_ID,
          packageId: PKG_ID,
          existing: baseExisting(),
          packageOptions: [
            {
              externalId: 'outbound-flight-25sep',
              type: 'flight',
              status: 'shortlisted',
              title: 'new',
              startAt: '2026-09-25T11:15:00-06:00',
              sourceType: 'flight_schedule',
            },
          ],
          ops: [
            {
              op: 'remove',
              entityKind: 'travelOption',
              externalId: 'outbound-flight-1',
            },
            {
              op: 'supersede',
              entityKind: 'travelOption',
              externalId: 'outbound-flight-25sep',
              supersedesExternalId: 'outbound-flight-1',
            },
          ],
        }),
      PackageMutationValidationError,
    )
  })

  it('rejects duplicate supersede of same old target', () => {
    assert.throws(
      () =>
        applyMutationInMemory({
          tripId: TRIP_ID,
          packageId: PKG_ID,
          existing: baseExisting(),
          packageOptions: [
            {
              externalId: 'outbound-a',
              type: 'flight',
              status: 'shortlisted',
              title: 'a',
              startAt: '2026-09-25T11:15:00-06:00',
              sourceType: 'flight_schedule',
            },
            {
              externalId: 'outbound-b',
              type: 'flight',
              status: 'shortlisted',
              title: 'b',
              startAt: '2026-09-25T12:15:00-06:00',
              sourceType: 'flight_schedule',
            },
          ],
          ops: [
            {
              op: 'supersede',
              entityKind: 'travelOption',
              externalId: 'outbound-a',
              supersedesExternalId: 'outbound-flight-1',
            },
            {
              op: 'supersede',
              entityKind: 'travelOption',
              externalId: 'outbound-b',
              supersedesExternalId: 'outbound-flight-1',
            },
          ],
        }),
      PackageMutationValidationError,
    )
  })

  it('noop produces no deletes', () => {
    const { removedExternalIds } = applyMutationInMemory({
      tripId: TRIP_ID,
      packageId: PKG_ID,
      existing: baseExisting(),
      packageOptions: baseExisting().map((o) => ({
        externalId: o.externalId!,
        type: o.type,
        status: 'researched' as const,
        title: o.title,
        startAt: o.startAt,
        sourceType: o.sourceType,
      })),
      ops: [
        {
          op: 'noop',
          entityKind: 'travelOption',
          externalId: 'outbound-flight-1',
        },
      ],
    })
    assert.deepEqual(removedExternalIds, [])
  })

  it('delete set is order-independent (deterministic)', () => {
    const pkgOpts = [
      {
        externalId: 'outbound-flight-25sep',
        type: 'flight',
        status: 'shortlisted' as const,
        title: 'out',
        startAt: '2026-09-25T11:15:00-06:00',
        sourceType: 'flight_schedule',
      },
      {
        externalId: 'return-flight-28sep',
        type: 'flight',
        status: 'shortlisted' as const,
        title: 'ret',
        startAt: '2026-09-28T08:22:00-06:00',
        sourceType: 'flight_schedule',
      },
      {
        externalId: 'lodge-skeleton-1',
        type: 'lodging',
        status: 'researched' as const,
        title: 'lodge',
        sourceType: 'agent',
      },
      {
        externalId: 'ground-transfer-1',
        type: 'transfer',
        status: 'researched' as const,
        title: 'xfer',
        sourceType: 'agent',
      },
    ]
    const opsA = [
      {
        op: 'remove' as const,
        entityKind: 'travelOption' as const,
        externalId: 'return-flight-2',
      },
      {
        op: 'supersede' as const,
        entityKind: 'travelOption' as const,
        externalId: 'outbound-flight-25sep',
        supersedesExternalId: 'outbound-flight-1',
      },
      {
        op: 'supersede' as const,
        entityKind: 'travelOption' as const,
        externalId: 'return-flight-28sep',
        supersedesExternalId: 'return-flight-1',
      },
    ]
    const opsB = [...opsA].reverse()
    const a = applyMutationInMemory({
      tripId: TRIP_ID,
      packageId: PKG_ID,
      existing: baseExisting(),
      packageOptions: pkgOpts,
      ops: opsA,
    })
    const b = applyMutationInMemory({
      tripId: TRIP_ID,
      packageId: PKG_ID,
      existing: baseExisting(),
      packageOptions: pkgOpts,
      ops: opsB,
    })
    assert.deepEqual(
      a.removedExternalIds.sort(),
      b.removedExternalIds.sort(),
    )
    assert.deepEqual(
      a.options.map((o) => o.externalId).sort(),
      b.options.map((o) => o.externalId).sort(),
    )
  })
})

describe('validateMutationOps atomic fail-closed', () => {
  it('7: conflict detected before any conceptual writes (validation-only)', () => {
    const pkg = {
      schemaVersion: 1,
      packageId: PKG_ID,
      revision: 2,
      generatedAt: '2026-09-20T00:00:00Z',
      trip: {
        id: TRIP_ID,
        title: 't',
        startDate: '2026-09-25',
        endDate: '2026-09-28',
        timezone: 'America/Mexico_City',
        goals: [],
        status: 'planned' as const,
      },
      travelOptions: [
        {
          externalId: 'outbound-flight-25sep',
          type: 'flight' as const,
          status: 'shortlisted' as const,
          title: 'n',
          sourceType: 'flight_schedule' as const,
        },
      ],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
    } satisfies TripPackageV1

    const existing = baseExisting()
    existing[0]!.status = 'selected'

    assert.throws(
      () =>
        validateMutationOps({
          pkg,
          tripId: TRIP_ID,
          ops: [
            {
              op: 'remove',
              entityKind: 'travelOption',
              externalId: 'outbound-flight-1',
            },
            {
              op: 'remove',
              entityKind: 'travelOption',
              externalId: 'return-flight-2',
            },
          ],
          existingOptions: existing,
        }),
      PackageMutationConflictError,
    )
  })
})

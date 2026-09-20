import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentOpRecord } from '../../shared/agentContracts.ts'
import { compileMutationPlan } from './compileMutationPlan.ts'
import { applyMutationInMemory } from './packageMutation.ts'
import { optionEntityId } from './tripPackage.ts'
import type { TravelOption } from './domainTypes.ts'
import type { TripPackageV1 } from './tripPackage.ts'

const TRIP_ID = 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28'
const PKG_ID = TRIP_ID

const am222Url =
  'https://aerodatabox.com/?origin=MEX&destination=GDL&date=2026-09-25&flight=AM222'
const y4141Url =
  'https://aerodatabox.com/?origin=GDL&destination=MEX&date=2026-09-28&flight=Y4141'

function opt(
  externalId: string,
  partial: Partial<TravelOption> &
    Pick<TravelOption, 'title' | 'type'> & { startAt?: string },
): TravelOption {
  return {
    id: optionEntityId(PKG_ID, externalId),
    tripId: TRIP_ID,
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

function currentState(): TravelOption[] {
  return [
    opt('outbound-flight-1', {
      type: 'flight',
      title: 'Vuelo MEX→GDL 20',
      origin: 'MEX',
      destination: 'GDL',
      startAt: '2026-09-20T07:00:00-06:00',
      status: 'shortlisted',
    }),
    opt('return-flight-1', {
      type: 'flight',
      title: 'Vuelo GDL→MEX 22',
      origin: 'GDL',
      destination: 'MEX',
      startAt: '2026-09-22T12:00:00-06:00',
      status: 'shortlisted',
    }),
    opt('return-flight-2', {
      type: 'flight',
      title: 'Vuelo GDL→MEX 21 alternativa',
      origin: 'GDL',
      destination: 'MEX',
      startAt: '2026-09-21T12:00:00-06:00',
      status: 'researched',
    }),
    opt('lodge-skeleton-1', {
      type: 'lodging',
      title: 'Hospedaje San Miguel el Alto',
      startAt: '2026-09-19T15:00:00-06:00',
      endAt: '2026-09-22T12:00:00-06:00',
      status: 'researched',
    }),
    opt('ground-transfer-1', {
      type: 'transfer',
      title: 'Traslado Guadalajara → San Miguel el Alto',
      status: 'researched',
    }),
  ]
}

function basePkg(
  travelOptions: TripPackageV1['travelOptions'],
): TripPackageV1 {
  return {
    schemaVersion: 1,
    packageId: PKG_ID,
    revision: 2,
    generatedAt: '2026-09-20T06:00:00Z',
    trip: {
      id: TRIP_ID,
      title: 'SMA',
      destination: 'San Miguel el Alto, Jalisco',
      startDate: '2026-09-25',
      endDate: '2026-09-28',
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

/** RUN A proposed package (new flight ids + primary lodge + GDL fallback) */
function proposedRunA(): TripPackageV1 {
  return basePkg([
    {
      externalId: 'outbound-flight-2',
      type: 'flight',
      status: 'shortlisted',
      title: 'AM222 MEX→GDL 25',
      origin: 'MEX',
      destination: 'GDL',
      startAt: '2026-09-25T11:15:00-06:00',
      endAt: '2026-09-25T12:52:00-06:00',
      sourceType: 'flight_schedule',
      sourceUrl: am222Url,
      provider: 'Aeromexico',
      verificationStatus: 'estimated',
    },
    {
      externalId: 'return-flight-3',
      type: 'flight',
      status: 'shortlisted',
      title: 'Y4141 GDL→MEX 28',
      origin: 'GDL',
      destination: 'MEX',
      startAt: '2026-09-28T08:22:00-06:00',
      endAt: '2026-09-28T09:45:00-06:00',
      sourceType: 'flight_schedule',
      sourceUrl: y4141Url,
      provider: 'Volaris',
      verificationStatus: 'estimated',
    },
    {
      externalId: 'lodge-skeleton-2',
      type: 'lodging',
      status: 'researched',
      title: 'Hospedaje San Miguel el Alto (estimado · 3 noche(s))',
      startAt: '2026-09-25T15:00:00-06:00',
      endAt: '2026-09-28T12:00:00-06:00',
      sourceType: 'agent',
    },
    {
      externalId: 'lodge-skeleton-3',
      type: 'lodging',
      status: 'researched',
      title: 'Hospedaje Guadalajara alternativa',
      startAt: '2026-09-25T15:00:00-06:00',
      endAt: '2026-09-28T12:00:00-06:00',
      sourceType: 'agent',
    },
  ])
}

/** RUN B: same externalIds, new dates (reflexive supersede + spam updates in llmOps) */
function proposedRunB(): TripPackageV1 {
  return basePkg([
    {
      externalId: 'outbound-flight-1',
      type: 'flight',
      status: 'shortlisted',
      title: 'AM222 MEX→GDL 25',
      origin: 'MEX',
      destination: 'GDL',
      startAt: '2026-09-25T11:15:00-06:00',
      endAt: '2026-09-25T12:52:00-06:00',
      sourceType: 'flight_schedule',
      sourceUrl: am222Url,
      provider: 'Aeromexico',
      verificationStatus: 'estimated',
    },
    {
      externalId: 'return-flight-1',
      type: 'flight',
      status: 'shortlisted',
      title: 'Y4141 GDL→MEX 28',
      origin: 'GDL',
      destination: 'MEX',
      startAt: '2026-09-28T08:22:00-06:00',
      endAt: '2026-09-28T09:45:00-06:00',
      sourceType: 'flight_schedule',
      sourceUrl: y4141Url,
      provider: 'Volaris',
      verificationStatus: 'estimated',
    },
    {
      externalId: 'return-flight-2',
      type: 'flight',
      status: 'researched',
      title: 'still listed wrongly',
      origin: 'GDL',
      destination: 'MEX',
      startAt: '2026-09-21T12:00:00-06:00',
      sourceType: 'agent',
    },
    {
      externalId: 'lodge-skeleton-1',
      type: 'lodging',
      status: 'researched',
      title: 'Hospedaje San Miguel el Alto',
      startAt: '2026-09-25T15:00:00-06:00',
      endAt: '2026-09-28T12:00:00-06:00',
      sourceType: 'agent',
    },
    {
      externalId: 'ground-transfer-1',
      type: 'transfer',
      status: 'researched',
      title: 'Traslado Guadalajara → San Miguel el Alto',
      sourceType: 'agent',
    },
  ])
}

function llmOpsRunA(): AgentOpRecord[] {
  return [
    {
      op: 'supersede',
      entityKind: 'travelOption',
      externalId: 'outbound-flight-2',
      supersedesExternalId: 'outbound-flight-1',
    },
    {
      op: 'supersede',
      entityKind: 'travelOption',
      externalId: 'return-flight-3',
      supersedesExternalId: 'return-flight-1',
    },
    {
      op: 'remove',
      entityKind: 'travelOption',
      externalId: 'return-flight-2',
    },
  ]
}

function llmOpsRunB(): AgentOpRecord[] {
  const spam: AgentOpRecord[] = []
  for (let i = 0; i < 52; i++) {
    spam.push({
      op: 'update',
      entityKind: 'travelOption',
      externalId: 'lodge-skeleton-1',
    })
    spam.push({
      op: 'update',
      entityKind: 'travelOption',
      externalId: 'ground-transfer-1',
    })
  }
  return [
    {
      op: 'supersede',
      entityKind: 'travelOption',
      externalId: 'outbound-flight-1',
      supersedesExternalId: 'outbound-flight-1',
    },
    {
      op: 'supersede',
      entityKind: 'travelOption',
      externalId: 'return-flight-1',
      supersedesExternalId: 'return-flight-1',
    },
    {
      op: 'supersede',
      entityKind: 'travelOption',
      externalId: 'return-flight-2',
      supersedesExternalId: 'return-flight-2',
    },
    ...spam,
  ]
}

function planSignature(ops: AgentOpRecord[]): string {
  return JSON.stringify(
    ops.map((o) => [o.op, o.externalId, o.supersedesExternalId ?? null]),
  )
}

describe('compileMutationPlan canonical Run A / Run B', () => {
  it('Run A and Run B compile to equivalent mutation semantics', () => {
    const current = currentState()
    const trip = {
      startDate: '2026-09-19',
      endDate: '2026-09-22',
      destination: 'San Miguel el Alto, Jalisco',
    }

    const a = compileMutationPlan({
      tripId: TRIP_ID,
      currentTrip: trip,
      currentOptions: current,
      proposedPackage: proposedRunA(),
      llmOps: llmOpsRunA(),
    })
    const b = compileMutationPlan({
      tripId: TRIP_ID,
      currentTrip: trip,
      currentOptions: current,
      proposedPackage: proposedRunB(),
      llmOps: llmOpsRunB(),
    })

    assert.equal(a.status, 'ok', a.conflicts.join('; '))
    assert.equal(b.status, 'ok', b.conflicts.join('; '))

    // Both remove obsolete alt return
    assert.ok(a.ops.some((o) => o.op === 'remove' && o.externalId === 'return-flight-2'))
    assert.ok(b.ops.some((o) => o.op === 'remove' && o.externalId === 'return-flight-2'))

    // Both replace outbound (supersede OR update same id)
    const aOut = a.ops.find(
      (o) =>
        (o.op === 'supersede' && o.supersedesExternalId === 'outbound-flight-1') ||
        (o.op === 'update' && o.externalId === 'outbound-flight-1'),
    )
    const bOut = b.ops.find(
      (o) =>
        (o.op === 'supersede' && o.supersedesExternalId === 'outbound-flight-1') ||
        (o.op === 'update' && o.externalId === 'outbound-flight-1'),
    )
    assert.ok(aOut)
    assert.ok(bOut)

    // Both replace preferred return
    const aRet = a.ops.find(
      (o) =>
        (o.op === 'supersede' && o.supersedesExternalId === 'return-flight-1') ||
        (o.op === 'update' && o.externalId === 'return-flight-1'),
    )
    const bRet = b.ops.find(
      (o) =>
        (o.op === 'supersede' && o.supersedesExternalId === 'return-flight-1') ||
        (o.op === 'update' && o.externalId === 'return-flight-1'),
    )
    assert.ok(aRet)
    assert.ok(bRet)

    // Lodging: exactly one primary action; Run A may supersede to lodge-2; Run B update lodge-1
    const aLodge = a.ops.filter(
      (o) =>
        o.externalId.includes('lodge') ||
        o.supersedesExternalId === 'lodge-skeleton-1',
    )
    const bLodge = b.ops.filter(
      (o) =>
        o.externalId.includes('lodge') ||
        o.supersedesExternalId === 'lodge-skeleton-1',
    )
    assert.ok(aLodge.length >= 1 && aLodge.length <= 2) // primary + maybe fallback add
    assert.ok(bLodge.length >= 1 && bLodge.length <= 2)
    // No spam updates
    assert.ok(
      bLodge.filter((o) => o.op === 'update' && o.externalId === 'lodge-skeleton-1')
        .length <= 1,
    )

    // No spam: ops count bounded by affected entities
    assert.ok(a.ops.length <= 8, `A ops=${a.ops.length}`)
    assert.ok(b.ops.length <= 8, `B ops=${b.ops.length}`)

    // No reflexive supersede in compiled plan
    assert.ok(
      ![...a.ops, ...b.ops].some(
        (o) => o.op === 'supersede' && o.externalId === o.supersedesExternalId,
      ),
    )

    // Fallback GDL lodging only once in Run A package
    const aGdl = a.package.travelOptions.filter(
      (o) => o.type === 'lodging' && /guadalajara/i.test(o.title),
    )
    assert.equal(aGdl.length, 1)

    // Primary lodging only once
    const aPrimaryLodge = a.package.travelOptions.filter(
      (o) => o.type === 'lodging' && /san miguel/i.test(o.title),
    )
    assert.equal(aPrimaryLodge.length, 1)

    const bPrimaryLodge = b.package.travelOptions.filter(
      (o) => o.type === 'lodging' && /san miguel/i.test(o.title),
    )
    assert.equal(bPrimaryLodge.length, 1)
  })

  it('controlled E2E: compiled Run A plan yields clean final state', () => {
    const current = currentState()
    const compiled = compileMutationPlan({
      tripId: TRIP_ID,
      currentTrip: {
        startDate: '2026-09-19',
        endDate: '2026-09-22',
        destination: 'San Miguel el Alto, Jalisco',
      },
      currentOptions: current,
      proposedPackage: proposedRunA(),
      llmOps: llmOpsRunA(),
    })
    assert.equal(compiled.status, 'ok', compiled.conflicts.join('; '))

    const result = applyMutationInMemory({
      tripId: TRIP_ID,
      packageId: PKG_ID,
      existing: current,
      packageOptions: compiled.package.travelOptions.map((o) => ({
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
      ops: compiled.ops,
    })

    const ids = result.options.map((o) => o.externalId).sort()
    assert.equal(result.options.find((o) => o.externalId === 'outbound-flight-1'), undefined)
    assert.equal(result.options.find((o) => o.externalId === 'return-flight-1'), undefined)
    assert.equal(result.options.find((o) => o.externalId === 'return-flight-2'), undefined)
    assert.ok(result.options.find((o) => o.externalId === 'outbound-flight-2'))
    assert.ok(result.options.find((o) => o.externalId === 'return-flight-3'))
    assert.ok(result.options.find((o) => o.externalId === 'ground-transfer-1'))
    const lodges = result.options.filter((o) => o.type === 'lodging')
    assert.ok(lodges.length >= 1 && lodges.length <= 2)
    assert.equal(
      lodges.filter((o) => /san miguel/i.test(o.title)).length,
      1,
    )
    const sched = result.options.filter((o) => o.sourceType === 'flight_schedule')
    assert.equal(sched.length, 2)
    assert.ok(sched.every((o) => o.sourceUrl?.includes('aerodatabox')))
    assert.ok(result.options.every((o) => o.tripId === TRIP_ID))
    assert.ok(!ids.includes('lodge-skeleton-1') || lodges.length === 1)
  })

  it('controlled E2E: compiled Run B plan also cleans 20/21/22', () => {
    const current = currentState()
    const compiled = compileMutationPlan({
      tripId: TRIP_ID,
      currentTrip: {
        startDate: '2026-09-19',
        endDate: '2026-09-22',
        destination: 'San Miguel el Alto, Jalisco',
      },
      currentOptions: current,
      proposedPackage: proposedRunB(),
      llmOps: llmOpsRunB(),
    })
    assert.equal(compiled.status, 'ok', compiled.conflicts.join('; '))

    const result = applyMutationInMemory({
      tripId: TRIP_ID,
      packageId: PKG_ID,
      existing: current,
      packageOptions: compiled.package.travelOptions.map((o) => ({
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
      })),
      ops: compiled.ops,
    })

    assert.equal(result.options.find((o) => o.externalId === 'return-flight-2'), undefined)
    assert.ok(result.options.find((o) => o.externalId === 'outbound-flight-1'))
    assert.equal(
      result.options.find((o) => o.externalId === 'outbound-flight-1')!.sourceType,
      'flight_schedule',
    )
    assert.ok(result.options.find((o) => o.externalId === 'lodge-skeleton-1'))
    assert.ok(result.options.find((o) => o.externalId === 'ground-transfer-1'))
  })

  it('idempotent: recompile same desired state → stable ops', () => {
    const current = currentState()
    const trip = {
      startDate: '2026-09-19',
      endDate: '2026-09-22',
      destination: 'San Miguel el Alto, Jalisco',
    }
    const p1 = compileMutationPlan({
      tripId: TRIP_ID,
      currentTrip: trip,
      currentOptions: current,
      proposedPackage: proposedRunA(),
      llmOps: llmOpsRunA(),
    })
    const p2 = compileMutationPlan({
      tripId: TRIP_ID,
      currentTrip: trip,
      currentOptions: current,
      proposedPackage: proposedRunA(),
      llmOps: llmOpsRunA(),
    })
    assert.equal(planSignature(p1.ops), planSignature(p2.ops))
  })

  it('ambiguous dual primary lodging → review_required', () => {
    const pkg = proposedRunA()
    pkg.travelOptions = pkg.travelOptions.map((o) =>
      o.externalId === 'lodge-skeleton-3'
        ? { ...o, title: 'Otro hospedaje San Miguel el Alto centro' }
        : o,
    )
    const compiled = compileMutationPlan({
      tripId: TRIP_ID,
      currentTrip: {
        startDate: '2026-09-19',
        endDate: '2026-09-22',
        destination: 'San Miguel el Alto, Jalisco',
      },
      currentOptions: currentState(),
      proposedPackage: pkg,
      llmOps: [],
    })
    assert.equal(compiled.status, 'review_required')
    assert.ok(compiled.conflicts.some((c) => /lodging_primary/i.test(c)))
  })

  it('protected outbound → review_required', () => {
    const current = currentState()
    current[0]!.status = 'selected'
    const compiled = compileMutationPlan({
      tripId: TRIP_ID,
      currentTrip: {
        startDate: '2026-09-19',
        endDate: '2026-09-22',
        destination: 'San Miguel el Alto, Jalisco',
      },
      currentOptions: current,
      proposedPackage: proposedRunA(),
      llmOps: llmOpsRunA(),
    })
    assert.equal(compiled.status, 'review_required')
  })

  it('absence without replacement does not remove ground-transfer', () => {
    const pkg = proposedRunA()
    // no transfer in proposal
    const compiled = compileMutationPlan({
      tripId: TRIP_ID,
      currentTrip: {
        startDate: '2026-09-19',
        endDate: '2026-09-22',
        destination: 'San Miguel el Alto, Jalisco',
      },
      currentOptions: currentState(),
      proposedPackage: pkg,
      llmOps: llmOpsRunA(),
    })
    assert.equal(compiled.status, 'ok', compiled.conflicts.join('; '))
    assert.ok(
      compiled.package.travelOptions.some((o) => o.externalId === 'ground-transfer-1'),
    )
    assert.ok(!compiled.ops.some((o) => o.op === 'remove' && o.externalId === 'ground-transfer-1'))
  })
})

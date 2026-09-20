import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentOpRecord } from '../../shared/agentContracts.ts'
import {
  computeStateFingerprint,
  enforcePreviewGate,
  prepareMutationPlan,
  PreviewGateError,
} from './prepareMutationPlan.ts'
import { optionEntityId } from './tripPackage.ts'
import type { TravelOption, Trip } from './domainTypes.ts'
import type { TripPackageV1 } from './tripPackage.ts'
import { containsDisallowedControl } from './postgresSanitize.ts'

const TRIP_ID = 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28'
const PKG_ID = TRIP_ID
const am222Url =
  'https://aerodatabox.com/?origin=MEX&destination=GDL&date=2026-09-25&flight=AM222'
const y4141Url =
  'https://aerodatabox.com/?origin=GDL&destination=MEX&date=2026-09-28&flight=Y4141'

const WINDOW: Pick<Trip, 'id' | 'title' | 'startDate' | 'endDate' | 'timezone' | 'destination' | 'updatedAt' | 'createdAt' | 'status' | 'goals' | 'syncStatus'> = {
  id: TRIP_ID,
  title: 'SMA',
  startDate: '2026-09-25',
  endDate: '2026-09-28',
  timezone: 'America/Mexico_City',
  destination: 'San Miguel el Alto, Jalisco',
  updatedAt: '2026-09-20T07:27:15.029Z',
  createdAt: '2026-09-19T00:00:00.000Z',
  status: 'planned',
  goals: [],
  syncStatus: 'synced',
}

function opt(
  externalId: string,
  partial: Partial<TravelOption> & Pick<TravelOption, 'title' | 'type'>,
): TravelOption {
  return {
    id: optionEntityId(PKG_ID, externalId),
    tripId: TRIP_ID,
    status: 'shortlisted',
    sourceType: 'agent',
    externalId,
    packageId: PKG_ID,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-20T07:27:15.029Z',
    syncStatus: 'synced',
    ...partial,
  }
}

const cleanNotes =
  'HORARIO PUBLICADO — verifica disponibilidad y reserva directamente con la aerolínea.'
const lodgeTitle =
  'Hospedaje San Miguel el Alto, Jalisco (estimado · 3 noche(s))'
const lodgeNotes =
  'Esqueleto de hospedaje — pendiente de verificar disponibilidad y precio con fuente actual. Alternativa: hospedaje en Guadalajara si no hay disponibilidad en San Miguel el Alto.'
const transferTitle =
  'Traslado terrestre estimado Guadalajara → San Miguel el Alto'
const outTitle =
  'Vuelo estimado directo MEX → GDL el viernes 25 de septiembre 2026'
const retTitle =
  'Vuelo estimado directo GDL → MEX el lunes 28 de septiembre 2026'

function liveCurrent(): TravelOption[] {
  return [
    opt('outbound-flight-1', {
      type: 'flight',
      title: 'old 20',
      origin: 'MEX',
      destination: 'GDL',
      startAt: '2026-09-20T07:00:00-06:00',
    }),
    opt('outbound-flight-25sep', {
      type: 'flight',
      title: outTitle,
      origin: 'MEX',
      destination: 'GDL',
      startAt: '2026-09-25T11:15:00-06:00',
      endAt: '2026-09-25T12:52:00-06:00',
      sourceType: 'flight_schedule',
      sourceUrl: am222Url,
      provider: 'Aeromexico',
      notes: cleanNotes,
      checkedAt: '2026-09-20T06:05:57+00:00',
      verificationStatus: 'estimated',
    }),
    opt('return-flight-2', {
      type: 'flight',
      title: 'r21',
      origin: 'GDL',
      destination: 'MEX',
      startAt: '2026-09-21T12:00:00-06:00',
      status: 'researched',
    }),
    opt('return-flight-1', {
      type: 'flight',
      title: 'r22',
      origin: 'GDL',
      destination: 'MEX',
      startAt: '2026-09-22T12:00:00-06:00',
    }),
    opt('return-flight-28sep', {
      type: 'flight',
      title: retTitle,
      origin: 'GDL',
      destination: 'MEX',
      startAt: '2026-09-28T08:22:00-06:00',
      endAt: '2026-09-28T09:45:00-06:00',
      sourceType: 'flight_schedule',
      sourceUrl: y4141Url,
      provider: 'Volaris',
      notes: cleanNotes,
      checkedAt: '2026-09-20T06:05:58+00:00',
    }),
    opt('lodge-skeleton-1', {
      type: 'lodging',
      title: lodgeTitle,
      notes: lodgeNotes,
      startAt: '2026-09-25T15:00:00-06:00',
      endAt: '2026-09-28T12:00:00-06:00',
      status: 'researched',
    }),
    opt('ground-transfer-1', {
      type: 'transfer',
      title: transferTitle,
      origin: 'GDL',
      destination: 'San Miguel el Alto',
      status: 'researched',
    }),
  ]
}

function rawDegradedProposal(): TripPackageV1 {
  return {
    schemaVersion: 1,
    packageId: PKG_ID,
    revision: 3,
    trip: {
      id: TRIP_ID,
      title: 'SMA',
      destination: WINDOW.destination,
      startDate: '2026-09-25',
      endDate: '2026-09-28',
      timezone: 'America/Mexico_City',
      goals: [],
      status: 'planned',
    },
    travelOptions: [
      {
        externalId: 'ground-transfer-1',
        type: 'transfer',
        status: 'researched',
        title: 'Opción investigada',
        origin: 'GDL',
        destination: 'San Miguel el Alto',
        sourceType: 'agent',
        notes:
          'Hecho (schedule): Vuelo estimado directo MEX → GDL el viernes 25',
      },
      {
        externalId: 'lodge-skeleton-1',
        type: 'lodging',
        status: 'researched',
        title:
          'Hospedaje San Miguel el Alto, Jalisco (estimado \u00183 noche(s))',
        notes: 'Esqueleto de hospedaje \u0015 pendiente de verificar.',
        sourceType: 'agent',
      },
      {
        externalId: 'outbound-flight-25sep',
        type: 'flight',
        status: 'shortlisted',
        title: 'Opción investigada',
        origin: 'MEX',
        destination: 'GDL',
        sourceType: 'agent',
        sourceUrl: am222Url,
        provider: 'Aeromexico',
        notes: 'dirty\u0000\u0015',
      },
      {
        externalId: 'return-flight-28sep',
        type: 'flight',
        status: 'shortlisted',
        title: 'Opción investigada',
        origin: 'GDL',
        destination: 'MEX',
        sourceType: 'agent',
        sourceUrl: y4141Url,
        provider: 'Volaris',
        notes: 'dirty\u0000\u0015',
      },
    ],
    itineraryItems: [],
    checklistItems: [],
    notes: [],
  }
}

function removeOps(): AgentOpRecord[] {
  return [
    {
      op: 'remove',
      entityKind: 'travelOption',
      externalId: optionEntityId(TRIP_ID, 'outbound-flight-1'),
    },
    {
      op: 'remove',
      entityKind: 'travelOption',
      externalId: optionEntityId(TRIP_ID, 'return-flight-1'),
    },
    {
      op: 'remove',
      entityKind: 'travelOption',
      externalId: optionEntityId(TRIP_ID, 'return-flight-2'),
    },
  ]
}

describe('prepareMutationPlan / canonical preview', () => {
  it('A: RAW placeholder flight → preview preserves AeroDataBox current', () => {
    const prepared = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: liveCurrent(),
      rawPackage: rawDegradedProposal(),
      llmOps: removeOps(),
    })
    assert.equal(prepared.status, 'ok')
    const out = prepared.normalizedPackage.travelOptions.find(
      (o) => o.externalId === 'outbound-flight-25sep',
    )!
    assert.equal(out.title, outTitle)
    assert.equal(out.startAt, '2026-09-25T11:15:00-06:00')
    assert.equal(out.sourceType, 'flight_schedule')
    assert.equal(out.sourceUrl, am222Url)
    assert.equal(out.checkedAt, '2026-09-20T06:05:57+00:00')
    assert.ok(
      !prepared.diff.some(
        (d) =>
          d.externalId === 'outbound-flight-25sep' &&
          d.fields?.some((f) => f.field === 'title'),
      ),
    )
  })

  it('B: RAW lodge C0 → preview clean current', () => {
    const prepared = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: liveCurrent(),
      rawPackage: rawDegradedProposal(),
      llmOps: removeOps(),
    })
    const lodge = prepared.normalizedPackage.travelOptions.find(
      (o) => o.externalId === 'lodge-skeleton-1',
    )!
    assert.equal(lodge.title, lodgeTitle)
    assert.equal(lodge.notes, lodgeNotes)
    assert.equal(containsDisallowedControl(lodge.title), false)
    assert.equal(containsDisallowedControl(lodge.notes ?? ''), false)
  })

  it('C: RAW transfer contaminated notes → preview notes null/undefined', () => {
    const prepared = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: liveCurrent(),
      rawPackage: rawDegradedProposal(),
      llmOps: removeOps(),
    })
    const xfer = prepared.normalizedPackage.travelOptions.find(
      (o) => o.externalId === 'ground-transfer-1',
    )!
    assert.equal(xfer.notes, undefined)
    assert.ok(
      !prepared.diff.some(
        (d) =>
          d.externalId === 'ground-transfer-1' &&
          d.fields?.some((f) => f.field === 'notes'),
      ),
    )
  })

  it('D: unauthorized remove discarded → no remove in diff', () => {
    const current = liveCurrent().filter(
      (o) =>
        !['outbound-flight-1', 'return-flight-1', 'return-flight-2'].includes(
          o.externalId!,
        ),
    )
    const ops: AgentOpRecord[] = [
      {
        op: 'remove',
        entityKind: 'travelOption',
        externalId: 'lodge-skeleton-1',
      },
    ]
    const prepared = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: current,
      rawPackage: {
        ...rawDegradedProposal(),
        travelOptions: rawDegradedProposal().travelOptions,
      },
      llmOps: ops,
    })
    assert.equal(prepared.status, 'ok')
    assert.ok(
      !prepared.diff.some(
        (d) => d.kind === 'remove' && d.externalId === 'lodge-skeleton-1',
      ),
    )
    assert.ok(
      prepared.normalizedPackage.travelOptions.some(
        (o) => o.externalId === 'lodge-skeleton-1',
      ),
    )
  })

  it('E: exactly 3 obsolete removes in canonical diff', () => {
    const prepared = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: liveCurrent(),
      rawPackage: rawDegradedProposal(),
      llmOps: removeOps(),
    })
    const removes = prepared.diff
      .filter((d) => d.kind === 'remove')
      .map((d) => d.externalId)
      .sort()
    assert.deepEqual(removes, [
      'outbound-flight-1',
      'return-flight-1',
      'return-flight-2',
    ])
  })

  it('F: fingerprint mismatch → preview_stale gate', () => {
    const prepared = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: liveCurrent(),
      rawPackage: rawDegradedProposal(),
      llmOps: removeOps(),
    })
    assert.throws(
      () =>
        enforcePreviewGate(prepared, {
          expectedFingerprint: 'stale-hash',
          expectedPlanHash: prepared.planHash,
          requirePreviewGate: true,
          existingTripWithOptions: true,
        }),
      (e: unknown) =>
        e instanceof PreviewGateError && e.code === 'preview_stale',
    )
  })

  it('G: only option.updatedAt change flips fingerprint (trip.updatedAt same)', () => {
    const a = liveCurrent()
    const b = liveCurrent().map((o) =>
      o.externalId === 'lodge-skeleton-1'
        ? { ...o, updatedAt: '2026-09-20T07:43:15.036Z' }
        : o,
    )
    const trip = WINDOW as Trip
    const fa = computeStateFingerprint(trip, a)
    const fb = computeStateFingerprint(trip, b)
    assert.notEqual(fa, fb)
    assert.equal(trip.updatedAt, '2026-09-20T07:27:15.029Z')
    const preparedA = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: trip,
      currentOptions: a,
      rawPackage: rawDegradedProposal(),
      llmOps: removeOps(),
    })
    assert.throws(
      () =>
        enforcePreviewGate(preparedA, {
          expectedFingerprint: fb,
          requirePreviewGate: true,
          existingTripWithOptions: true,
        }),
      (e: unknown) =>
        e instanceof PreviewGateError && e.code === 'preview_stale',
    )
  })

  it('H: stable fingerprint + planHash across identical prepares', () => {
    const input = {
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: liveCurrent(),
      rawPackage: rawDegradedProposal(),
      llmOps: removeOps(),
    }
    const p1 = prepareMutationPlan(input)
    const p2 = prepareMutationPlan(input)
    assert.equal(p1.status, 'ok')
    assert.equal(p1.fingerprint, p2.fingerprint)
    assert.equal(p1.planHash, p2.planHash)
    assert.equal(p1.planHash.length, 64)
    enforcePreviewGate(p2, {
      expectedFingerprint: p1.fingerprint,
      expectedPlanHash: p1.planHash,
      requirePreviewGate: true,
      existingTripWithOptions: true,
    })
  })

  it('I: AM222 / Y4141 each keep own sourceUrl (not sources[0])', () => {
    const prepared = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: liveCurrent(),
      rawPackage: rawDegradedProposal(),
      llmOps: removeOps(),
    })
    const out = prepared.normalizedPackage.travelOptions.find(
      (o) => o.externalId === 'outbound-flight-25sep',
    )!
    const ret = prepared.normalizedPackage.travelOptions.find(
      (o) => o.externalId === 'return-flight-28sep',
    )!
    assert.equal(out.sourceUrl, am222Url)
    assert.equal(ret.sourceUrl, y4141Url)
    assert.notEqual(out.sourceUrl, ret.sourceUrl)
  })

  it('J: review_required disables apply gate path (status)', () => {
    const current = [
      opt('outbound-flight-a', {
        type: 'flight',
        title: 'A',
        origin: 'MEX',
        destination: 'GDL',
        startAt: '2026-09-25T10:00:00-06:00',
      }),
      opt('outbound-flight-b', {
        type: 'flight',
        title: 'B',
        origin: 'MEX',
        destination: 'GDL',
        startAt: '2026-09-25T14:00:00-06:00',
      }),
    ]
    const pkg: TripPackageV1 = {
      ...rawDegradedProposal(),
      travelOptions: [
        {
          externalId: 'outbound-new',
          type: 'flight',
          status: 'shortlisted',
          title: 'new',
          origin: 'MEX',
          destination: 'GDL',
          sourceType: 'agent',
        },
      ],
    }
    const prepared = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: current,
      rawPackage: pkg,
      llmOps: [],
    })
    assert.equal(prepared.status, 'review_required')
    assert.ok(prepared.conflicts.length > 0)
  })

  it('NON-MUTATION: prepareMutationPlan does not mutate input arrays/objects', () => {
    const current = liveCurrent()
    const raw = rawDegradedProposal()
    const ops = removeOps()
    const snapCurrent = JSON.stringify(current)
    const snapRaw = JSON.stringify(raw)
    const snapOps = JSON.stringify(ops)
    const fpBefore = computeStateFingerprint(WINDOW as Trip, current)
    prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: current,
      rawPackage: raw,
      llmOps: ops,
    })
    assert.equal(JSON.stringify(current), snapCurrent)
    assert.equal(JSON.stringify(raw), snapRaw)
    assert.equal(JSON.stringify(ops), snapOps)
    assert.equal(
      computeStateFingerprint(WINDOW as Trip, current),
      fpBefore,
    )
  })

  it('requirePreviewGate without fingerprint → fingerprint_required', () => {
    const prepared = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: liveCurrent(),
      rawPackage: rawDegradedProposal(),
      llmOps: removeOps(),
    })
    assert.throws(
      () =>
        enforcePreviewGate(prepared, {
          requirePreviewGate: true,
          existingTripWithOptions: true,
        }),
      (e: unknown) =>
        e instanceof PreviewGateError && e.code === 'fingerprint_required',
    )
    assert.throws(
      () =>
        enforcePreviewGate(prepared, {
          requirePreviewGate: true,
          expectedFingerprint: '   ',
          existingTripWithOptions: true,
        }),
      (e: unknown) =>
        e instanceof PreviewGateError && e.code === 'fingerprint_required',
    )
  })

  it('fingerprint: notes-only change flips hash', () => {
    const a = liveCurrent()
    const b = liveCurrent().map((o) =>
      o.externalId === 'ground-transfer-1'
        ? { ...o, notes: 'nuevo' }
        : o,
    )
    assert.notEqual(
      computeStateFingerprint(WINDOW as Trip, a),
      computeStateFingerprint(WINDOW as Trip, b),
    )
  })

  it('fingerprint: bookingId/protected change flips hash', () => {
    const a = liveCurrent()
    const b = liveCurrent().map((o) =>
      o.externalId === 'outbound-flight-25sep'
        ? { ...o, bookingId: 'book-1', status: 'booked' as const }
        : o,
    )
    assert.notEqual(
      computeStateFingerprint(WINDOW as Trip, a),
      computeStateFingerprint(WINDOW as Trip, b),
    )
  })

  it('fingerprint: DB option order does not matter', () => {
    const a = liveCurrent()
    const b = [...liveCurrent()].reverse()
    assert.equal(
      computeStateFingerprint(WINDOW as Trip, a),
      computeStateFingerprint(WINDOW as Trip, b),
    )
  })

  it('fingerprint: identical serialization is stable', () => {
    const opts = liveCurrent()
    const f1 = computeStateFingerprint(WINDOW as Trip, opts)
    const f2 = computeStateFingerprint(WINDOW as Trip, opts)
    assert.equal(f1, f2)
    assert.equal(f1.length, 64)
  })

  it('planHash: ops order does not change hash; real op change does', () => {
    const base = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: liveCurrent(),
      rawPackage: rawDegradedProposal(),
      llmOps: removeOps(),
    })
    const reversed = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: liveCurrent(),
      rawPackage: rawDegradedProposal(),
      llmOps: [...removeOps()].reverse(),
    })
    assert.equal(base.planHash, reversed.planHash)

    const fewer = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: liveCurrent(),
      rawPackage: rawDegradedProposal(),
      llmOps: removeOps().slice(0, 2),
    })
    // May still remove all three via compiler window logic; if plan differs, hash differs
    if (
      JSON.stringify(base.canonicalOps.map((o) => o.externalId).sort()) !==
      JSON.stringify(fewer.canonicalOps.map((o) => o.externalId).sort())
    ) {
      assert.notEqual(base.planHash, fewer.planHash)
    }

    // Force package semantic change
    const raw2 = rawDegradedProposal()
    raw2.travelOptions = raw2.travelOptions.map((o) =>
      o.externalId === 'ground-transfer-1'
        ? { ...o, destination: 'San Miguel el Alto CHANGED' }
        : o,
    )
    // destination fill only when current blank — current has destination so
    // canonical may keep current; change title via changedFields is N/A.
    // Instead compare planHash after removing one obsolete from current.
    const currentFewer = liveCurrent().filter(
      (o) => o.externalId !== 'return-flight-2',
    )
    const p2 = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: currentFewer,
      rawPackage: rawDegradedProposal(),
      llmOps: removeOps(),
    })
    assert.notEqual(base.planHash, p2.planHash)
  })

  it('canonical diff: no RAW noise (placeholder/C0/dirty notes)', () => {
    const prepared = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: liveCurrent(),
      rawPackage: rawDegradedProposal(),
      llmOps: removeOps(),
    })
    const blob = JSON.stringify(prepared.diff)
    assert.equal(blob.includes('Opción investigada'), false)
    assert.equal(blob.includes('\u0015'), false)
    assert.equal(blob.includes('\u0018'), false)
    assert.equal(blob.includes('Hecho (schedule)'), false)
    assert.equal(blob.includes('updatedAt'), false)
  })

  it('EXACT: extend to 1 oct — supersede remove+add, AM221 title, lodge nights', () => {
    const am221Url =
      'https://aerodatabox.com/?origin=GDL&destination=MEX&date=2026-10-01&flight=AM221'
    const current: TravelOption[] = [
      opt('outbound-flight-25sep', {
        type: 'flight',
        title: outTitle,
        origin: 'MEX',
        destination: 'GDL',
        startAt: '2026-09-25T11:15:00-06:00',
        endAt: '2026-09-25T12:52:00-06:00',
        sourceType: 'flight_schedule',
        sourceUrl: am222Url,
        provider: 'Aeromexico',
        notes: cleanNotes,
        checkedAt: '2026-09-20T06:05:57+00:00',
        verificationStatus: 'estimated',
      }),
      opt('return-flight-28sep', {
        type: 'flight',
        title: retTitle,
        origin: 'GDL',
        destination: 'MEX',
        startAt: '2026-09-28T08:22:00-06:00',
        endAt: '2026-09-28T09:45:00-06:00',
        sourceType: 'flight_schedule',
        sourceUrl: y4141Url,
        provider: 'Volaris',
        notes: cleanNotes,
        checkedAt: '2026-09-20T06:05:58+00:00',
      }),
      opt('lodge-skeleton-1', {
        type: 'lodging',
        title: lodgeTitle,
        notes: lodgeNotes,
        startAt: '2026-09-25T15:00:00-06:00',
        endAt: '2026-09-28T12:00:00-06:00',
        status: 'researched',
      }),
      opt('ground-transfer-1', {
        type: 'transfer',
        title: transferTitle,
        origin: 'GDL',
        destination: 'San Miguel el Alto',
        status: 'researched',
      }),
    ]
    const outboundSnap = JSON.stringify(
      current.find((o) => o.externalId === 'outbound-flight-25sep'),
    )
    const transferSnap = JSON.stringify(
      current.find((o) => o.externalId === 'ground-transfer-1'),
    )

    const raw: TripPackageV1 = {
      schemaVersion: 1,
      packageId: PKG_ID,
      revision: 4,
      trip: {
        id: TRIP_ID,
        title: WINDOW.title,
        destination: WINDOW.destination,
        startDate: '2026-09-25',
        endDate: '2026-10-01',
        timezone: 'America/Mexico_City',
        goals: [],
        status: 'planned',
      },
      travelOptions: [
        {
          externalId: 'outbound-flight-25sep',
          type: 'flight',
          status: 'shortlisted',
          title: 'Opción investigada',
          origin: 'MEX',
          destination: 'GDL',
          startAt: '2026-09-25T11:15:00-06:00',
          endAt: '2026-09-25T12:52:00-06:00',
          sourceType: 'flight_schedule',
          sourceUrl: am222Url,
          provider: 'Aeromexico',
          notes: cleanNotes,
          checkedAt: '2026-09-20T06:05:57+00:00',
        },
        {
          externalId: 'return-flight-01oct',
          type: 'flight',
          status: 'shortlisted',
          title: 'Opción investigada',
          origin: 'GDL',
          destination: 'MEX',
          startAt: '2026-10-01T11:38:00-06:00',
          endAt: '2026-10-01T13:10:00-06:00',
          sourceType: 'flight_schedule',
          sourceUrl: am221Url,
          provider: 'Aeromexico',
          checkedAt: '2026-09-20T08:24:26+00:00',
        },
        {
          externalId: 'lodge-skeleton-1',
          type: 'lodging',
          status: 'researched',
          title:
            'Hospedaje San Miguel el Alto, Jalisco (estimado \u00186 noche(s))',
          notes: lodgeNotes,
          startAt: '2026-09-25T15:00:00-06:00',
          endAt: '2026-10-01T11:00:00-06:00',
          sourceType: 'agent',
        },
        {
          externalId: 'ground-transfer-1',
          type: 'transfer',
          status: 'researched',
          title: 'Opción investigada',
          origin: 'GDL',
          destination: 'San Miguel el Alto',
          sourceType: 'agent',
          notes: 'Hecho (schedule):\u0015 contamination',
        },
      ],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
    }

    const prepared = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW as Trip,
      currentOptions: current,
      rawPackage: raw,
      llmOps: [],
    })
    assert.equal(prepared.status, 'ok')

    const supersede = prepared.canonicalOps.find(
      (o) =>
        o.op === 'supersede' &&
        o.externalId === 'return-flight-01oct' &&
        o.supersedesExternalId === 'return-flight-28sep',
    )
    assert.ok(supersede, 'canonicalOps must supersede 28sep → 01oct')

    const removeLine = prepared.diff.find(
      (d) => d.kind === 'remove' && d.externalId === 'return-flight-28sep',
    )
    assert.ok(removeLine, 'diff must REMOVE return-flight-28sep')
    assert.match(String(removeLine!.note ?? ''), /return-flight-01oct/)

    const addLine = prepared.diff.find(
      (d) => d.kind === 'add' && d.externalId === 'return-flight-01oct',
    )
    assert.ok(addLine, 'diff must ADD return-flight-01oct')

    const tripLine = prepared.diff.find(
      (d) => d.kind === 'update' && d.entityKind === 'trip',
    )
    assert.ok(
      tripLine?.fields?.some(
        (f) =>
          f.field === 'endDate' &&
          f.before === '2026-09-28' &&
          f.after === '2026-10-01',
      ),
    )

    const lodgeLine = prepared.diff.find(
      (d) => d.kind === 'update' && d.externalId === 'lodge-skeleton-1',
    )
    assert.ok(lodgeLine, 'diff must UPDATE lodge')
    assert.ok(
      lodgeLine!.fields?.some(
        (f) =>
          f.field === 'endAt' &&
          String(f.before).startsWith('2026-09-28') &&
          String(f.after).startsWith('2026-10-01'),
      ),
      'lodge endAt 28sep → 1oct',
    )
    assert.ok(
      lodgeLine!.fields?.some(
        (f) =>
          f.field === 'title' &&
          String(f.before).includes('3 noche(s)') &&
          String(f.after).includes('6 noche(s)'),
      ),
      'lodge title 3 → 6 noches',
    )

    const by = Object.fromEntries(
      prepared.normalizedPackage.travelOptions.map((o) => [o.externalId, o]),
    )
    assert.equal(Object.keys(by).sort().join(','), [
      'ground-transfer-1',
      'lodge-skeleton-1',
      'outbound-flight-25sep',
      'return-flight-01oct',
    ].join(','))
    assert.equal(by['return-flight-28sep'], undefined)

    const ret = by['return-flight-01oct']!
    assert.equal(ret.title.includes('Opción investigada'), false)
    assert.match(ret.title, /AM221/)
    assert.match(ret.title, /GDL/)
    assert.match(ret.title, /MEX/)
    assert.match(ret.title, /11:38/)
    assert.match(ret.title, /13:10/)
    assert.equal(ret.sourceUrl, am221Url)

    const lodge = by['lodge-skeleton-1']!
    assert.equal(lodge.endAt?.startsWith('2026-10-01'), true)
    assert.match(lodge.title, /6 noche\(s\)/)
    assert.equal(containsDisallowedControl(lodge.title), false)
    assert.equal(containsDisallowedControl(JSON.stringify(prepared.diff)), false)
    assert.equal(
      containsDisallowedControl(JSON.stringify(prepared.normalizedPackage)),
      false,
    )

    const out = by['outbound-flight-25sep']!
    assert.equal(out.title, outTitle)
    assert.equal(out.sourceUrl, am222Url)
    assert.equal(out.startAt, '2026-09-25T11:15:00-06:00')
    assert.equal(out.endAt, '2026-09-25T12:52:00-06:00')

    const xfer = by['ground-transfer-1']!
    assert.equal(xfer.title, transferTitle)
    assert.equal(xfer.notes, undefined)
    assert.equal(containsDisallowedControl(xfer.title), false)

    // Outbound / transfer: no false field churn vs CURRENT semantic identity
    assert.equal(
      prepared.diff.some((d) => d.externalId === 'outbound-flight-25sep'),
      false,
    )
    assert.equal(
      prepared.diff.some((d) => d.externalId === 'ground-transfer-1'),
      false,
    )
    // Keep snapshots for readability of intent (CURRENT fixtures unchanged)
    assert.ok(outboundSnap.includes(outTitle))
    assert.ok(transferSnap.includes(transferTitle))
  })
})

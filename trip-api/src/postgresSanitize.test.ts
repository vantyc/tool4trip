import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  containsNul,
  sanitizeForPostgres,
  stringifyPayloadForPostgres,
} from './postgresSanitize.ts'
import { compileMutationPlan } from './compileMutationPlan.ts'
import { applyMutationInMemory } from './packageMutation.ts'
import { optionEntityId } from './tripPackage.ts'
import type { TravelOption } from './domainTypes.ts'
import type { TripPackageV1 } from './tripPackage.ts'
import type { AgentOpRecord } from '../../shared/agentContracts.ts'

describe('sanitizeForPostgres', () => {
  it('A: strips real U+0000 from notes and keeps surrounding text', () => {
    const notes = 'aerol\u0000nea publicada'
    const { value, changed, events } = sanitizeForPostgres(
      { notes },
      '$.travelOption',
    )
    assert.equal(changed, true)
    assert.equal(value.notes, 'aerolnea publicada')
    assert.equal(events.length, 1)
    assert.equal(events[0]!.removed, 'U+0000')
    assert.equal(events[0]!.count, 1)
    assert.equal(events[0]!.path, '$.travelOption.notes')
  })

  it('B: nested object path is sanitized', () => {
    const { value } = sanitizeForPostgres(
      { metadata: { foo: { bar: 'abc\u0000def' } } },
      '$',
    )
    assert.equal(value.metadata.foo.bar, 'abcdef')
  })

  it('C: arrays of contaminated strings', () => {
    const { value } = sanitizeForPostgres(['ok', 'a\u0000b', 'c\u0000d\u0000e'], '$')
    assert.deepEqual(value, ['ok', 'ab', 'cde'])
  })

  it('D: valid Unicode preserved exactly', () => {
    const s = 'San Miguel el Alto – México 🇲🇽 Привет 你好'
    const { value, changed } = sanitizeForPostgres({ title: s }, '$')
    assert.equal(changed, false)
    assert.equal(value.title, s)
  })

  it('E: literal backslash-u0000 text is NOT treated as NUL', () => {
    const literal = 'code \\u0000 marker'
    assert.equal(containsNul(literal), false)
    const { value, changed } = sanitizeForPostgres({ notes: literal }, '$')
    assert.equal(changed, false)
    assert.equal(value.notes, literal)
  })

  it('null/boolean/number pass through', () => {
    const { value, changed } = sanitizeForPostgres(
      { a: null, b: true, c: 12.5, d: undefined },
      '$',
    )
    assert.equal(changed, false)
    assert.equal(value.a, null)
    assert.equal(value.b, true)
    assert.equal(value.c, 12.5)
  })

  it('stringifyPayloadForPostgres yields jsonb-safe JSON without \\u0000 escapes', () => {
    const json = stringifyPayloadForPostgres(
      { notes: 'aerol\u0000nea' },
      { collection: 'travel_options', externalId: 'x' },
    )
    assert.equal(json.includes('\\u0000'), false)
    assert.deepEqual(JSON.parse(json), { notes: 'aerolnea' })
  })
})

describe('FINAL LIVE APPLY fixture with U+0000 notes', () => {
  const TRIP_ID = 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28'
  const PKG_ID = TRIP_ID
  const am222Url =
    'https://aerodatabox.com/?origin=MEX&destination=GDL&date=2026-09-25&flight=AM222'
  const y4141Url =
    'https://aerodatabox.com/?origin=GDL&destination=MEX&date=2026-09-28&flight=Y4141'

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
      updatedAt: '2026-09-19T00:00:00.000Z',
      syncStatus: 'synced',
      ...partial,
    }
  }

  it('F+I: RAW contaminated notes + clean current → preserve current; sanitize persistable', () => {
    const WINDOW = {
      startDate: '2026-09-25',
      endDate: '2026-09-28',
      destination: 'San Miguel el Alto, Jalisco',
    }
    const cleanNotes =
      'HORARIO PUBLICADO — verifica disponibilidad y reserva directamente con la aerolínea. No implica asientos ni tarifa.'
    const dirtyNotes =
      'HORARIO PUBLICADO \u00151 verifica disponibilidad y reserva directamente con la aerol\u0000nea. No implica asientos ni tarifa.\nFecha asociada (sin hora verificada): 2026-09-25'

    const current: TravelOption[] = [
      opt('outbound-flight-1', {
        type: 'flight',
        title: 'old 20',
        origin: 'MEX',
        destination: 'GDL',
        startAt: '2026-09-20T07:00:00-06:00',
      }),
      opt('outbound-flight-25sep', {
        type: 'flight',
        title: 'Vuelo estimado directo MEX → GDL el viernes 25 de septiembre 2026',
        origin: 'MEX',
        destination: 'GDL',
        startAt: '2026-09-25T11:15:00-06:00',
        endAt: '2026-09-25T12:52:00-06:00',
        sourceType: 'flight_schedule',
        sourceUrl: am222Url,
        provider: 'Aeromexico',
        notes: cleanNotes,
        verificationStatus: 'estimated',
        checkedAt: '2026-09-20T06:05:57+00:00',
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
        title: 'Vuelo estimado directo GDL → MEX el lunes 28 de septiembre 2026',
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
        title: 'Hospedaje San Miguel el Alto, Jalisco (estimado · 3 noche(s))',
        startAt: '2026-09-25T15:00:00-06:00',
        endAt: '2026-09-28T12:00:00-06:00',
        status: 'researched',
      }),
      opt('ground-transfer-1', {
        type: 'transfer',
        title: 'Traslado terrestre estimado Guadalajara → San Miguel el Alto',
        origin: 'GDL',
        destination: 'San Miguel el Alto',
        status: 'researched',
      }),
    ]

    const rawProposed: TripPackageV1 = {
      schemaVersion: 1,
      packageId: PKG_ID,
      revision: 2,
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
        },
        {
          externalId: 'lodge-skeleton-1',
          type: 'lodging',
          status: 'researched',
          title: 'Hospedaje San Miguel el Alto, Jalisco (estimado · 3 noche(s))',
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
          notes: dirtyNotes,
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
          notes: dirtyNotes.replace('2026-09-25', '2026-09-28'),
        },
      ],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
    }

    const llmOps: AgentOpRecord[] = [
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

    const compiled = compileMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW,
      currentOptions: current,
      proposedPackage: rawProposed,
      llmOps,
    })
    assert.equal(compiled.status, 'ok', compiled.conflicts.join('; '))

    const out = compiled.package.travelOptions.find(
      (o) => o.externalId === 'outbound-flight-25sep',
    )!
    assert.equal(out.notes, cleanNotes)
    assert.equal(containsNul(out.notes ?? ''), false)
    assert.equal(out.sourceType, 'flight_schedule')
    assert.equal(out.startAt, '2026-09-25T11:15:00-06:00')

    const sanitized = sanitizeForPostgres(compiled.package, '$.package')
    // may still strip if any residual; after preferText should be clean
    assert.equal(containsNul(JSON.stringify(sanitized.value)), false)
    // JSON for postgres must not contain the escape
    const json = stringifyPayloadForPostgres(out, {
      collection: 'travel_options',
      externalId: out.externalId,
    })
    assert.equal(json.includes('\\u0000'), false)

    const result = applyMutationInMemory({
      tripId: TRIP_ID,
      packageId: PKG_ID,
      existing: current,
      packageOptions: sanitized.value.travelOptions.map((o) => ({
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
    assert.equal(result.options.length, 4)
    assert.deepEqual(
      result.options.map((o) => o.externalId).sort(),
      [
        'ground-transfer-1',
        'lodge-skeleton-1',
        'outbound-flight-25sep',
        'return-flight-28sep',
      ],
    )
    assert.equal(
      result.options.find((o) => o.externalId === 'outbound-flight-25sep')!
        .sourceType,
      'flight_schedule',
    )

    // H: recompile against post-apply state is stable (no recreate obsolete)
    const again = compileMutationPlan({
      tripId: TRIP_ID,
      currentTrip: WINDOW,
      currentOptions: result.options,
      proposedPackage: sanitized.value,
      llmOps: [],
    })
    assert.equal(again.status, 'ok')
    assert.ok(
      !again.ops.some(
        (o) =>
          o.op === 'add' &&
          (o.externalId === 'outbound-flight-1' ||
            o.externalId === 'return-flight-1'),
      ),
    )
  })

  it('G: multi-entity package pre-sanitized as a whole', () => {
    const pkg = {
      travelOptions: [
        { externalId: 'a', notes: 'ok' },
        { externalId: 'b', notes: 'bad\u0000' },
      ],
      notes: [{ body: 'x\u0000y' }],
    }
    const { value, events } = sanitizeForPostgres(pkg, '$.package')
    assert.equal(value.travelOptions[1]!.notes, 'bad')
    assert.equal(value.notes[0]!.body, 'xy')
    assert.ok(events.length >= 2)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  containsDisallowedControl,
  containsNul,
  sanitizeForPostgres,
  stringifyPayloadForPostgres,
} from './postgresSanitize.ts'
import {
  compileMutationPlan,
  mergePreservedPackageOption,
  scrubNewPackageOption,
} from './compileMutationPlan.ts'
import { applyMutationInMemory } from './packageMutation.ts'
import { optionEntityId } from './tripPackage.ts'
import type { TravelOption } from './domainTypes.ts'
import type { TripPackageV1 } from './tripPackage.ts'
import type { AgentOpRecord } from '../../shared/agentContracts.ts'

describe('sanitizeForPostgres — control character policy', () => {
  it('1: strips real U+0000 and keeps surrounding text', () => {
    const { value, changed, events } = sanitizeForPostgres('a\u0000b', '$')
    assert.equal(changed, true)
    assert.equal(value, 'ab')
    assert.equal(events[0]!.removed, 'U+0000')
    assert.equal(events[0]!.count, 1)
  })

  it('2: strips U+0015 (C0_CONTROL)', () => {
    const { value, changed, events } = sanitizeForPostgres('a\u0015b', '$')
    assert.equal(changed, true)
    assert.equal(value, 'ab')
    assert.equal(events[0]!.removed, 'C0_CONTROL')
    assert.equal(events[0]!.count, 1)
  })

  it('3: strips U+0018 (C0_CONTROL)', () => {
    const { value, events } = sanitizeForPostgres('a\u0018b', '$')
    assert.equal(value, 'ab')
    assert.equal(events[0]!.removed, 'C0_CONTROL')
  })

  it('4: preserves allowed whitespace tab/LF/CR', () => {
    const s = 'a\tb\nc\rd'
    const { value, changed } = sanitizeForPostgres(s, '$')
    assert.equal(changed, false)
    assert.equal(value, s)
  })

  it('5: valid Unicode byte-identical (dash, middle-dot, emoji, CJK, Cyrillic)', () => {
    const s = 'San Miguel — México · 🇲🇽 Привет 你好'
    const { value, changed } = sanitizeForPostgres(s, '$')
    assert.equal(changed, false)
    assert.equal(value, s)
  })

  it('strips DEL U+007F', () => {
    const { value } = sanitizeForPostgres('a\u007Fb', '$')
    assert.equal(value, 'ab')
  })

  it('nested object + array recurse', () => {
    const { value } = sanitizeForPostgres(
      { metadata: { foo: { bar: 'abc\u0015def' } }, arr: ['x\u0018y'] },
      '$',
    )
    assert.equal(value.metadata.foo.bar, 'abcdef')
    assert.equal(value.arr[0], 'xy')
  })

  it('literal backslash-u0000 text is NOT treated as NUL', () => {
    const literal = 'code \\u0000 marker'
    assert.equal(containsNul(literal), false)
    const { value, changed } = sanitizeForPostgres({ notes: literal }, '$')
    assert.equal(changed, false)
    assert.equal(value.notes, literal)
  })

  it('stringifyPayloadForPostgres yields jsonb-safe JSON', () => {
    const json = stringifyPayloadForPostgres(
      { notes: 'aerol\u0000nea\u0015x' },
      { collection: 'travel_options', externalId: 'x' },
    )
    assert.equal(json.includes('\\u0000'), false)
    assert.deepEqual(JSON.parse(json), { notes: 'aerolneax' })
  })
})

describe('field ownership / control-aware merge', () => {
  const TRIP_ID = 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28'
  const PKG_ID = TRIP_ID

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

  it('6: current lodge clean + proposed C0 title/notes → current wins (no explicit mask)', () => {
    const cur = opt('lodge-skeleton-1', {
      type: 'lodging',
      title: 'Hospedaje San Miguel el Alto, Jalisco (estimado · 3 noche(s))',
      notes:
        'Esqueleto de hospedaje — pendiente de verificar disponibilidad y precio con fuente actual.',
      startAt: '2026-09-25T15:00:00-06:00',
      endAt: '2026-09-28T12:00:00-06:00',
      status: 'researched',
    })
    const prop = {
      externalId: 'lodge-skeleton-1',
      type: 'lodging' as const,
      status: 'researched' as const,
      title: 'Hospedaje San Miguel el Alto, Jalisco (estimado \u00183 noche(s))',
      notes:
        'Esqueleto de hospedaje \u0015 pendiente de verificar disponibilidad y precio con fuente actual.',
      sourceType: 'agent' as const,
    }
    const merged = mergePreservedPackageOption(cur, prop)
    assert.equal(merged.title, cur.title)
    assert.equal(merged.notes, cur.notes)
    assert.equal(containsDisallowedControl(merged.title), false)
    assert.equal(containsDisallowedControl(merged.notes ?? ''), false)
  })

  it('7: new entity with C0 and no current → sanitized + no flight_schedule on transfer', () => {
    const scrubbed = scrubNewPackageOption({
      externalId: 'ground-transfer-new',
      type: 'transfer',
      status: 'researched',
      title: 'Traslado \u0018 GDL',
      notes: 'nota \u0015 con control',
      sourceType: 'flight_schedule',
      sourceUrl: 'https://aerodatabox.com/?origin=MEX&destination=GDL',
      checkedAt: '2026-09-20T06:05:57+00:00',
    })
    assert.equal(scrubbed.title, 'Traslado  GDL')
    assert.equal(scrubbed.notes, 'nota  con control')
    assert.equal(scrubbed.sourceType, 'agent')
    assert.equal(scrubbed.sourceUrl, undefined)
    assert.equal(scrubbed.checkedAt, undefined)

    const { events } = sanitizeForPostgres(
      { title: 'Traslado \u0018 GDL', notes: 'nota \u0015 x' },
      '$.option',
    )
    assert.ok(events.some((e) => e.removed === 'C0_CONTROL'))
  })

  it('8: transfer notes=null + proposed cross-domain notes + no mask → stays null', () => {
    const cur = opt('ground-transfer-1', {
      type: 'transfer',
      title: 'Traslado terrestre estimado Guadalajara → San Miguel el Alto',
      origin: 'GDL',
      destination: 'San Miguel el Alto',
      status: 'researched',
      notes: undefined,
    })
    const prop = {
      externalId: 'ground-transfer-1',
      type: 'transfer' as const,
      status: 'researched' as const,
      title: 'Opción investigada',
      origin: 'GDL',
      destination: 'San Miguel el Alto',
      sourceType: 'agent' as const,
      notes:
        'Hecho (schedule): Vuelo estimado directo MEX → GDL el viernes 25 de septiembre 2026 a las 11:15 - 12:52\nHecho (schedule): Vuelo estimado directo GDL → MEX el lunes 28 de septiembre 2026 a las 08:22 - 09:45',
    }
    const merged = mergePreservedPackageOption(cur, prop)
    assert.equal(merged.notes, undefined)
    assert.equal(merged.title, cur.title)
  })

  it('9: explicit changedFields notes → legitimate transfer notes update allowed', () => {
    const cur = opt('ground-transfer-1', {
      type: 'transfer',
      title: 'Traslado terrestre estimado Guadalajara → San Miguel el Alto',
      origin: 'GDL',
      destination: 'San Miguel el Alto',
      status: 'researched',
    })
    const prop = {
      externalId: 'ground-transfer-1',
      type: 'transfer' as const,
      status: 'researched' as const,
      title: cur.title,
      origin: 'GDL',
      destination: 'San Miguel el Alto',
      sourceType: 'agent' as const,
      notes: 'Traslado compartido confirmado con operador local.',
    }
    const merged = mergePreservedPackageOption(cur, prop, {
      changedFields: ['notes'],
    })
    assert.equal(merged.notes, prop.notes)
    assert.equal(merged.title, cur.title)
  })

  it('10: explicit flight provenance upgrade still works', () => {
    const cur = opt('outbound-flight-25sep', {
      type: 'flight',
      title: 'Vuelo estimado',
      origin: 'MEX',
      destination: 'GDL',
      startAt: '2026-09-25T11:15:00-06:00',
      endAt: '2026-09-25T12:52:00-06:00',
      sourceType: 'agent',
      notes: 'borrador',
    })
    const prop = {
      externalId: 'outbound-flight-25sep',
      type: 'flight' as const,
      status: 'shortlisted' as const,
      title: 'Opción investigada',
      origin: 'MEX',
      destination: 'GDL',
      sourceType: 'flight_schedule' as const,
      sourceUrl:
        'https://aerodatabox.com/?origin=MEX&destination=GDL&date=2026-09-25&flight=AM222',
      provider: 'Aeromexico',
      checkedAt: '2026-09-20T06:05:57+00:00',
      notes: 'nuevo horario',
    }
    const merged = mergePreservedPackageOption(cur, prop)
    assert.equal(merged.sourceType, 'flight_schedule')
    assert.equal(merged.provider, 'Aeromexico')
    assert.equal(merged.sourceUrl, prop.sourceUrl)
    assert.equal(merged.checkedAt, prop.checkedAt)
    // notes not in mask → preserve current
    assert.equal(merged.notes, 'borrador')
    assert.equal(merged.title, cur.title)
  })

  it('transfer cannot acquire flight_schedule provenance even with stronger proposed', () => {
    const cur = opt('ground-transfer-1', {
      type: 'transfer',
      title: 'Traslado',
      origin: 'GDL',
      destination: 'SMA',
      status: 'researched',
      sourceType: 'agent',
    })
    const prop = {
      externalId: 'ground-transfer-1',
      type: 'transfer' as const,
      status: 'researched' as const,
      title: 'Traslado',
      origin: 'GDL',
      destination: 'SMA',
      sourceType: 'flight_schedule' as const,
      sourceUrl: 'https://aerodatabox.com/?origin=MEX&destination=GDL',
      checkedAt: '2026-09-20T06:05:57+00:00',
      provider: 'Aeromexico',
    }
    const merged = mergePreservedPackageOption(cur, prop, {
      changedFields: ['sourceType', 'sourceUrl', 'checkedAt', 'provider'],
    })
    assert.equal(merged.sourceType, 'agent')
    assert.equal(merged.sourceUrl, undefined)
    assert.equal(merged.checkedAt, undefined)
  })
})

describe('FINAL LIVE APPLY fixture — integrity regression', () => {
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

  it('11: exact final-live fixture → 4 options, no C0, transfer notes not contaminated, flights byte-identical', () => {
    const WINDOW = {
      startDate: '2026-09-25',
      endDate: '2026-09-28',
      destination: 'San Miguel el Alto, Jalisco',
    }
    const cleanNotes =
      'HORARIO PUBLICADO — verifica disponibilidad y reserva directamente con la aerolínea. No implica asientos ni tarifa.'
    const dirtyNotes =
      'HORARIO PUBLICADO \u0015 verifica disponibilidad y reserva directamente con la aerol\u0000nea. No implica asientos ni tarifa.\nFecha asociada (sin hora verificada): 2026-09-25'
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
        title: outTitle,
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
          notes:
            'Hecho (schedule): Vuelo estimado directo MEX → GDL el viernes 25 de septiembre 2026 a las 11:15 - 12:52\nHecho (schedule): Vuelo estimado directo GDL → MEX el lunes 28 de septiembre 2026 a las 08:22 - 09:45',
        },
        {
          externalId: 'lodge-skeleton-1',
          type: 'lodging',
          status: 'researched',
          title:
            'Hospedaje San Miguel el Alto, Jalisco (estimado \u00183 noche(s))',
          notes:
            'Esqueleto de hospedaje \u0015 pendiente de verificar disponibilidad y precio con fuente actual. Alternativa: hospedaje en Guadalajara si no hay disponibilidad en San Miguel el Alto.\nFecha asociada (sin hora verificada): 2026-09-25',
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

    const byId = Object.fromEntries(
      compiled.package.travelOptions.map((o) => [o.externalId, o]),
    )
    assert.equal(compiled.package.travelOptions.length, 4)

    const out = byId['outbound-flight-25sep']!
    const ret = byId['return-flight-28sep']!
    const lodge = byId['lodge-skeleton-1']!
    const xfer = byId['ground-transfer-1']!

    assert.equal(out.title, outTitle)
    assert.equal(out.notes, cleanNotes)
    assert.equal(out.sourceType, 'flight_schedule')
    assert.equal(out.startAt, '2026-09-25T11:15:00-06:00')
    assert.equal(out.provider, 'Aeromexico')
    assert.equal(out.sourceUrl, am222Url)
    assert.equal(out.checkedAt, '2026-09-20T06:05:57+00:00')

    assert.equal(ret.title, retTitle)
    assert.equal(ret.notes, cleanNotes)
    assert.equal(ret.sourceType, 'flight_schedule')
    assert.equal(ret.provider, 'Volaris')

    assert.equal(lodge.title, lodgeTitle)
    assert.equal(lodge.notes, lodgeNotes)
    assert.equal(containsDisallowedControl(lodge.title), false)
    assert.equal(containsDisallowedControl(lodge.notes ?? ''), false)

    assert.equal(xfer.title, transferTitle)
    assert.equal(xfer.notes, undefined)
    assert.ok(!String(xfer.notes ?? '').includes('Hecho (schedule)'))

    const sanitized = sanitizeForPostgres(compiled.package, '$.package')
    for (const o of sanitized.value.travelOptions) {
      assert.equal(containsNul(o.title), false)
      assert.equal(containsDisallowedControl(o.title), false)
      assert.equal(containsDisallowedControl(o.notes ?? ''), false)
    }
    assert.equal(
      containsDisallowedControl(JSON.stringify(sanitized.value)),
      false,
    )

    // byte-identical flight identity fields vs current
    const curOut = current.find((o) => o.externalId === 'outbound-flight-25sep')!
    assert.equal(out.startAt, curOut.startAt)
    assert.equal(out.endAt, curOut.endAt)
    assert.equal(out.sourceUrl, curOut.sourceUrl)
    assert.equal(out.checkedAt, curOut.checkedAt)
    assert.equal(out.notes, curOut.notes)
    assert.equal(out.title, curOut.title)

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
        origin: o.origin,
        destination: o.destination,
      })),
      ops: compiled.ops,
    })
    assert.equal(result.options.length, 4)
  })
})

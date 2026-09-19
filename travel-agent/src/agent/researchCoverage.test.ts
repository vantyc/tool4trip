import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import {
  assessResearchGoals,
  buildDirectedResearchNudge,
  buildResearchDiagnostics,
  classifyCandidates,
  deriveResearchGoals,
  shouldForceAnotherResearchRound,
  scrubUnsupportedFreeTextAssertions,
  consultedSourceCount,
  anchoredSourceCount,
  needsFlightDirectedRetry,
  shouldSkipToolCallForFlightPriority,
  shouldDeferSecondaryResearch,
  flightCriticalAttemptExhausted,
} from './researchCoverage.ts'

const SMA_PROMPT = `
Necesito BUSCAR Y VERIFICAR un viaje de hoy:
- vuelos MEX → GDL disponibles hoy 19 septiembre 2026, horario, precio, terminal AICM
- terminal de autobuses correcta en Guadalajara hacia San Miguel el Alto
- viabilidad de alcanzar la corrida de las 20:00
- hoteles cercanos a la terminal como contingencia
- hospedaje en San Miguel el Alto
- actividades/serenata 19-20 septiembre 2026
`

function traceSearch(
  query: string,
  sources: Array<{ url: string; title?: string; snippet?: string }>,
): ToolTraceEntry {
  return {
    tool: 'webSearch',
    args: { query, provider: 'tavily' },
    ok: true,
    sources,
    checkedAt: '2026-09-19T18:00:00+00:00',
  }
}

describe('researchCoverage', () => {
  it('derives concrete SMA goals from prompt', () => {
    const goals = deriveResearchGoals(SMA_PROMPT)
    const kinds = new Set(goals.map((g) => g.kind))
    assert.ok(kinds.has('flight_day_specific'))
    assert.ok(kinds.has('airport_terminal') || kinds.has('bus_terminal'))
    assert.ok(kinds.has('lodging_destination'))
    assert.ok(kinds.has('event_activities'))
    assert.ok(goals.every((g) => g.status === 'UNRESOLVED'))
  })

  it('1 goal resolved + several unresolved → force another round', () => {
    const goals = deriveResearchGoals(SMA_PROMPT).map((g, i) =>
      i === 0
        ? { ...g, status: 'RESOLVED' as const }
        : { ...g, status: 'UNRESOLVED' as const },
    )
    assert.equal(
      shouldForceAnotherResearchRound({
        goals,
        toolCallsUsed: 4,
        maxToolCalls: 6,
        steps: 2,
        maxSteps: 8,
        forcedExtraRounds: 0,
      }),
      true,
    )
  })

  it('all goals resolved → no extra searches', () => {
    const goals = deriveResearchGoals(SMA_PROMPT).map((g) => ({
      ...g,
      status: 'RESOLVED' as const,
    }))
    assert.equal(
      shouldForceAnotherResearchRound({
        goals,
        toolCallsUsed: 2,
        maxToolCalls: 6,
        steps: 2,
        maxSteps: 8,
        forcedExtraRounds: 0,
      }),
      false,
    )
  })

  it('tool budget exhausted → no force (checklist path)', () => {
    const goals = deriveResearchGoals(SMA_PROMPT)
    assert.equal(
      shouldForceAnotherResearchRound({
        goals,
        toolCallsUsed: 6,
        maxToolCalls: 6,
        steps: 3,
        maxSteps: 8,
        forcedExtraRounds: 0,
      }),
      false,
    )
  })

  it('generic landing + wrong-date flight hits → rejected', () => {
    const goals = deriveResearchGoals(SMA_PROMPT)
    const toolTrace = [
      traceSearch('vuelos MEX GDL hoy', [
        {
          url: 'https://www.volaris.com/es-us/vuelos-a-guadalajara',
          title: 'Vuelos baratos a Guadalajara',
          snippet: 'Dallas (DFW) a Guadalajara (GDL) Salida 11/04/2026 desde USD72',
        },
      ]),
    ]
    const decisions = classifyCandidates(toolTrace, goals, [
      '2026-09-19',
      '2026-09-20',
    ])
    assert.ok(decisions.length >= 1)
    assert.equal(decisions[0]!.decision, 'rejected')
    assert.ok(
      decisions[0]!.reason === 'wrong_date' ||
        decisions[0]!.reason === 'generic_landing_page',
    )
  })

  it('named hotel hit without fetch → not verified (partial candidate only)', () => {
    const goals = deriveResearchGoals(SMA_PROMPT)
    const toolTrace = [
      traceSearch('hoteles San Miguel el Alto', [
        {
          url: 'https://www.sanmiguelelalto.gob.mx/turismo/opc/detalle/hotel-san-miguel',
          title: 'Hotel San Miguel',
          snippet: 'Genáro Alcalá #10 San Miguel El Alto Teléfono: 347 788 2132',
        },
      ]),
    ]
    const assessed = assessResearchGoals(goals, toolTrace, {
      tripDates: ['2026-09-19'],
    })
    const lodging = assessed.find((g) => g.kind === 'lodging_destination')
    assert.ok(lodging)
    assert.notEqual(lodging!.status, 'RESOLVED')
    const pkg = {
      travelOptions: [
        {
          externalId: 'lodge-1',
          type: 'lodging',
          status: 'researched',
          title: 'Hospedaje San Miguel el Alto (estimado)',
          verificationStatus: 'estimated',
          sourceType: 'agent',
        },
      ],
    }
    const diag = buildResearchDiagnostics({
      goals,
      toolTrace,
      toolRounds: 1,
      toolCallsUsed: 1,
      maxToolCalls: 6,
      forcedExtraRounds: 0,
      package: pkg,
      tripDates: ['2026-09-19'],
    })
    assert.equal(diag.anchoredSourceCount, 0)
    assert.ok(diag.consultedSourceCount >= 1)
    // promising hit not anchored → rejected insufficient_evidence in final pass
    assert.ok(
      diag.candidates.some(
        (c) =>
          c.url.includes('hotel-san-miguel') &&
          (c.reason === 'insufficient_evidence' ||
            c.reason === 'accepted_partial'),
      ),
    )
  })

  it('valid anchored hit → sourceUrl counts as anchored', () => {
    const goals = deriveResearchGoals(SMA_PROMPT)
    const url =
      'https://www.sanmiguelelalto.gob.mx/turismo/opc/detalle/hotel-san-miguel'
    const toolTrace = [
      traceSearch('hoteles', [
        { url, title: 'Hotel San Miguel', snippet: 'Hotel San Miguel contacto' },
      ]),
      {
        tool: 'fetchUrl',
        args: { url },
        ok: true,
        sources: [{ url, title: 'Hotel San Miguel', snippet: 'Teléfono 347' }],
        checkedAt: '2026-09-19T18:01:00+00:00',
      },
    ]
    const pkg = {
      travelOptions: [
        {
          externalId: 'lodge-1',
          type: 'lodging',
          status: 'researched',
          title: 'Hotel San Miguel — San Miguel el Alto',
          verificationStatus: 'verified',
          sourceType: 'agent',
          sourceUrl: url,
        },
      ],
    }
    const assessed = assessResearchGoals(goals, toolTrace, {
      package: pkg,
      tripDates: ['2026-09-19'],
    })
    const lodging = assessed.find((g) => g.kind === 'lodging_destination')
    assert.equal(lodging?.status, 'RESOLVED')
    assert.equal(anchoredSourceCount(pkg), 1)
    assert.ok(consultedSourceCount(toolTrace) >= 1)
  })

  it('notes Central Nueva basada en búsqueda without provenance → scrubbed', () => {
    const draft: Record<string, unknown> = {
      narrative: 'Viaje corto.',
      warnings: [
        'La terminal correcta se asume como Central Nueva basada en búsqueda de hoteles.',
      ],
      package: {
        notes: [
          {
            externalId: 'note-1',
            title: 'Notas',
            body: 'La terminal de autobuses en Guadalajara para la ruta a San Miguel el Alto se asume como Central Nueva de Autobuses de Guadalajara basada en búsqueda de hoteles cercanos.',
          },
        ],
        travelOptions: [],
      },
    }
    const w = scrubUnsupportedFreeTextAssertions(draft, [])
    assert.ok(w.length >= 1)
    const body = (draft.package as { notes: Array<{ body: string }> }).notes[0]!
      .body
    assert.match(body, /UNKNOWN|hipótesis no verificada|pendiente de verificar/i)
    assert.doesNotMatch(body, /basada en búsqueda de hoteles cercanos/i)
  })

  it('0 option sources but toolTrace hits → consulted vs anchored distinguished', () => {
    const toolTrace = [
      traceSearch('x', [
        {
          url: 'https://example.com/a',
          title: 'A',
          snippet: 'info',
        },
        {
          url: 'https://example.com/b',
          title: 'B',
          snippet: 'info',
        },
      ]),
    ]
    const pkg = { travelOptions: [] }
    assert.equal(consultedSourceCount(toolTrace), 2)
    assert.equal(anchoredSourceCount(pkg), 0)
  })

  it('PARTIAL without fetchUrl → force directed round', () => {
    const goals = deriveResearchGoals(SMA_PROMPT).map((g) => ({
      ...g,
      status: 'PARTIAL' as const,
    }))
    assert.equal(
      shouldForceAnotherResearchRound({
        goals,
        toolCallsUsed: 4,
        maxToolCalls: 6,
        steps: 2,
        maxSteps: 8,
        forcedExtraRounds: 0,
        hasSuccessfulFetch: false,
      }),
      true,
    )
    assert.equal(
      shouldForceAnotherResearchRound({
        goals,
        toolCallsUsed: 4,
        maxToolCalls: 6,
        steps: 2,
        maxSteps: 8,
        forcedExtraRounds: 0,
        hasSuccessfulFetch: true,
      }),
      false,
    )
  })

  it('generic first search → directed nudge prefers fetchUrl/refined, not repeat', () => {
    const goals = deriveResearchGoals(SMA_PROMPT)
    const prior = 'vuelos MEX GDL hoy'
    const toolTrace = [
      traceSearch(prior, [
        {
          url: 'https://www.expedia.mx/Flights-Search?leg1=from:MEX,to:GDL',
          title: 'Vuelos MEX a GDL',
          snippet: 'Compara vuelos Ciudad de México Guadalajara',
        },
        {
          url: 'https://www.sanmiguelelalto.gob.mx/turismo/opc/detalle/hotel-san-miguel',
          title: 'Hotel San Miguel',
          snippet: 'Hospedaje en San Miguel El Alto',
        },
      ]),
    ]
    const assessed = assessResearchGoals(goals, toolTrace, {
      tripDates: ['2026-09-19', '2026-09-20'],
    })
    const nudge = buildDirectedResearchNudge({
      goals: assessed,
      toolTrace,
      tripDates: ['2026-09-19', '2026-09-20'],
      prompt: SMA_PROMPT,
    })
    assert.match(nudge, /flight_day_specific|Do NOT spend tool budget on lodging/i)
    assert.match(nudge, /Do NOT repeat prior webSearch queries/i)
    assert.match(nudge, new RegExp(prior.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(nudge, /searchFlightSchedules|Aeromexico|Volaris|flight schedule/i)
  })

  it('A: first flight search wrong_date/generic → directed flight retry BEFORE lodging', () => {
    const goals = deriveResearchGoals(SMA_PROMPT)
    const toolTrace = [
      traceSearch(
        'vuelos directos hoy 19 septiembre 2026 MEX GDL horarios',
        [
          {
            url: 'https://www.volaris.com/es-mx/vuelos-desde-mexico-df-a-guadalajara',
            title: 'Volaris MEX GDL',
            snippet: 'MEX–GDL, 11/10/2026: Desde 495MXN',
          },
          {
            url: 'https://www.aa.com/es-us/vuelos-a-guadalajara',
            title: 'AA to GDL',
            snippet: 'Dallas (DFW) Guadalajara (GDL) 10/14/26',
          },
        ],
      ),
    ]
    const assessed = assessResearchGoals(goals, toolTrace, {
      tripDates: ['2026-09-19'],
    })
    assert.equal(
      needsFlightDirectedRetry({
        goals: assessed,
        toolTrace,
        tripDates: ['2026-09-19'],
      }),
      true,
    )
    assert.equal(
      shouldSkipToolCallForFlightPriority({
        toolName: 'webSearch',
        argsJson: JSON.stringify({
          query: 'hoteles cerca terminal autobuses Guadalajara',
        }),
        goals: assessed,
        toolTrace,
        tripDates: ['2026-09-19'],
      }),
      true,
    )
    // Until searchFlightSchedules runs, even flight webSearch is deferred
    assert.equal(
      shouldSkipToolCallForFlightPriority({
        toolName: 'webSearch',
        argsJson: JSON.stringify({
          query: 'MEX GDL 19 Sep 2026 Volaris',
        }),
        goals: assessed,
        toolTrace,
        tripDates: ['2026-09-19'],
      }),
      true,
    )
    assert.equal(
      shouldSkipToolCallForFlightPriority({
        toolName: 'searchFlightSchedules',
        argsJson: JSON.stringify({
          origin: 'MEX',
          destination: 'GDL',
          date: '2026-09-19',
        }),
        goals: assessed,
        toolTrace,
        tripDates: ['2026-09-19'],
      }),
      false,
    )
  })

  it('after searchFlightSchedules, flight webSearch fallback allowed; lodging still deferred if unresolved', () => {
    const goals = deriveResearchGoals(SMA_PROMPT).map((g) =>
      g.kind === 'flight_day_specific' ? { ...g, status: 'UNRESOLVED' as const } : g,
    )
    const toolTrace = [
      {
        tool: 'searchFlightSchedules',
        args: { origin: 'MEX', destination: 'GDL', date: '2026-09-19', flights: [] },
        ok: true,
        sources: [],
        checkedAt: '2026-09-19T12:00:00+00:00',
      },
    ]
    // Empty schedule → exhausted → secondary lodging may proceed; flight web ok
    assert.equal(
      shouldSkipToolCallForFlightPriority({
        toolName: 'webSearch',
        argsJson: JSON.stringify({ query: 'MEX GDL 19 Sep 2026 Volaris' }),
        goals,
        toolTrace,
        tripDates: ['2026-09-19'],
      }),
      false,
    )
  })

  it('B: Kayak times for 20-Sep when trip is 19-Sep → flight stays UNRESOLVED', () => {
    const goals = deriveResearchGoals(SMA_PROMPT)
    const toolTrace = [
      traceSearch('vuelos MEX GDL 19 septiembre 2026', [
        {
          url: 'https://www.es.kayak.com/vuelos/MEX/GDL',
          title: 'Kayak MEX-GDL',
          snippet:
            'Aeromexico 7:41 - 9:15 GDL 1 h 34 min directo $174 dom., 20 sep. - dom., 27 sep.',
        },
      ]),
    ]
    const assessed = assessResearchGoals(goals, toolTrace, {
      tripDates: ['2026-09-19'],
    })
    const flight = assessed.find((g) => g.kind === 'flight_day_specific')
    assert.equal(flight?.status, 'UNRESOLVED')
    const decisions = classifyCandidates(toolTrace, goals, ['2026-09-19'])
    assert.ok(
      decisions.some(
        (c) =>
          c.url.includes('kayak') &&
          (c.reason === 'insufficient_day_specific_evidence' ||
            c.reason === 'insufficient_evidence' ||
            c.reason === 'wrong_date'),
      ),
    )
  })

  it('C: fetchUrl captcha/JS wall → UNRESOLVED + fetch_blocked_js', () => {
    const goals = deriveResearchGoals(SMA_PROMPT)
    const url = 'https://www.flightconnections.com/es/vuelos-desde-mex-a-gdl'
    const toolTrace: ToolTraceEntry[] = [
      traceSearch('vuelos MEX GDL', [
        { url, title: 'FlightConnections', snippet: '119 vuelos por semana' },
      ]),
      {
        tool: 'fetchUrl',
        args: { url },
        ok: true,
        sources: [
          {
            url,
            title: '',
            snippet:
              'JavaScript is disabled In order to continue, we need to verify that you\'re not a robot.',
          },
        ],
        checkedAt: '2026-09-19T18:01:00+00:00',
      },
    ]
    const decisions = classifyCandidates(toolTrace, goals, ['2026-09-19'])
    assert.ok(
      decisions.some(
        (c) => c.url === url && c.reason === 'fetch_blocked_js',
      ),
    )
    const assessed = assessResearchGoals(goals, toolTrace, {
      tripDates: ['2026-09-19'],
    })
    assert.equal(
      assessed.find((g) => g.kind === 'flight_day_specific')?.status,
      'UNRESOLVED',
    )
  })

  it('D: bus sourceUrl with "terminal" text does NOT resolve airport_terminal', () => {
    const goals = deriveResearchGoals(SMA_PROMPT)
    const pkg = {
      travelOptions: [
        {
          externalId: 'bus-1',
          type: 'bus',
          title: 'Autobús GDL → SMA',
          notes:
            'Terminal confirmada Central Autobuses San Miguel el Alto',
          verificationStatus: 'verified',
          sourceType: 'agent',
          sourceUrl:
            'https://terminal.horariodeautobuses.com.mx/central-autobuses-san-miguel-el-alto',
        },
      ],
    }
    const assessed = assessResearchGoals(goals, [], {
      package: pkg,
      tripDates: ['2026-09-19'],
    })
    assert.notEqual(
      assessed.find((g) => g.kind === 'airport_terminal')?.status,
      'RESOLVED',
    )
  })

  it('E: bus schedule but flight arrival unknown → connection_feasibility NOT RESOLVED', () => {
    const goals = deriveResearchGoals(SMA_PROMPT)
    const pkg = {
      travelOptions: [
        {
          externalId: 'flt-1',
          type: 'flight',
          title: 'Vuelo estimado MEX GDL',
          verificationStatus: 'estimated',
          sourceType: 'agent',
          // no startAt clock
        },
        {
          externalId: 'bus-1',
          type: 'bus',
          title: 'Autobús 20:00',
          notes: 'salida 20:00',
          verificationStatus: 'verified',
          sourceType: 'agent',
          sourceUrl: 'https://example.com/bus',
          startAt: '2026-09-19T20:00:00-06:00',
        },
      ],
    }
    const assessed = assessResearchGoals(goals, [], {
      package: pkg,
      tripDates: ['2026-09-19'],
    })
    const conn = assessed.find((g) => g.kind === 'connection_feasibility')
    assert.ok(conn)
    assert.notEqual(conn!.status, 'RESOLVED')
    assert.match(
      conn!.evidenceNote ?? '',
      /flight arrival unknown/i,
    )
  })

  it('F: complete day-specific evidence can advance without relaxing verified rules', () => {
    const goals = deriveResearchGoals(SMA_PROMPT)
    const url = 'https://example.com/am-mex-gdl-2026-09-19'
    const snippet =
      'Aeromexico AM200 MEX→GDL 19 septiembre 2026 salida 16:05 llegada 17:35'
    const toolTrace = [
      traceSearch('MEX GDL 19 Sep 2026 Aeromexico', [
        { url, title: 'AM schedule', snippet },
      ]),
      {
        tool: 'fetchUrl' as const,
        args: { url },
        ok: true,
        sources: [{ url, title: 'AM', snippet }],
        checkedAt: '2026-09-19T18:02:00+00:00',
      },
    ]
    const decisions = classifyCandidates(toolTrace, goals, ['2026-09-19'])
    assert.ok(
      decisions.some(
        (c) => c.url === url && c.decision === 'accepted',
      ),
    )
    const pkg = {
      travelOptions: [
        {
          externalId: 'flt-1',
          type: 'flight',
          title: 'Aeroméxico MEX→GDL',
          origin: 'MEX',
          destination: 'GDL',
          provider: 'Aeroméxico',
          startAt: '2026-09-19T16:05:00-06:00',
          endAt: '2026-09-19T17:35:00-06:00',
          verificationStatus: 'estimated',
          sourceType: 'agent',
          sourceUrl: url,
        },
      ],
    }
    const assessed = assessResearchGoals(goals, toolTrace, {
      package: pkg,
      tripDates: ['2026-09-19'],
    })
    const flight = assessed.find((g) => g.kind === 'flight_day_specific')
    // estimated + sourceUrl + clock → PARTIAL (not auto VERIFIED)
    assert.equal(flight?.status, 'PARTIAL')
    const verifiedPkg = {
      travelOptions: [
        {
          ...pkg.travelOptions[0],
          verificationStatus: 'verified',
        },
      ],
    }
    const resolved = assessResearchGoals(goals, toolTrace, {
      package: verifiedPkg,
      tripDates: ['2026-09-19'],
    }).find((g) => g.kind === 'flight_day_specific')
    assert.equal(resolved?.status, 'RESOLVED')
  })

  it('G: limited budget → critical flight attempt before lodging/event', () => {
    const goals = deriveResearchGoals(SMA_PROMPT)
    assert.equal(
      goals.find((g) => g.kind === 'flight_day_specific')?.tier,
      'critical',
    )
    assert.equal(
      goals.find((g) => g.kind === 'lodging_destination')?.tier,
      'secondary',
    )
    const toolTrace = [
      traceSearch('vuelos MEX GDL 19 septiembre 2026', [
        {
          url: 'https://www.volaris.com/x',
          title: 'Volaris',
          snippet: 'MEX–GDL, 11/10/2026: Desde 495MXN',
        },
      ]),
    ]
    const assessed = assessResearchGoals(goals, toolTrace, {
      tripDates: ['2026-09-19'],
    })
    assert.equal(
      shouldDeferSecondaryResearch({
        goals: assessed,
        toolTrace,
        tripDates: ['2026-09-19'],
      }),
      true,
    )
  })

  it('H: after reasonable flight attempt exhausted → secondary allowed, no infinite loop', () => {
    const goals = deriveResearchGoals(SMA_PROMPT)
    const toolTrace = [
      traceSearch('vuelos MEX GDL 19 septiembre 2026', [
        {
          url: 'https://www.volaris.com/x',
          title: 'Volaris',
          snippet: 'MEX–GDL, 11/10/2026: Desde 495MXN',
        },
      ]),
      traceSearch('MEX GDL 19 Sep 2026 Volaris', [
        {
          url: 'https://www.volaris.com/y',
          title: 'Volaris retry',
          snippet: 'MEX–GDL, 12/10/2026: Desde 600MXN',
        },
      ]),
      {
        tool: 'fetchUrl' as const,
        args: { url: 'https://www.volaris.com/y' },
        ok: true,
        sources: [
          {
            url: 'https://www.volaris.com/y',
            snippet: 'JavaScript is disabled verify that you\'re not a robot',
          },
        ],
        checkedAt: '2026-09-19T18:03:00+00:00',
      },
    ]
    const assessed = assessResearchGoals(goals, toolTrace, {
      tripDates: ['2026-09-19'],
    })
    assert.equal(
      flightCriticalAttemptExhausted({
        goals: assessed,
        toolTrace,
        tripDates: ['2026-09-19'],
      }),
      true,
    )
    assert.equal(
      shouldDeferSecondaryResearch({
        goals: assessed,
        toolTrace,
        tripDates: ['2026-09-19'],
      }),
      false,
    )
    assert.equal(
      shouldSkipToolCallForFlightPriority({
        toolName: 'webSearch',
        argsJson: JSON.stringify({
          query: 'hospedaje San Miguel el Alto',
        }),
        goals: assessed,
        toolTrace,
        tripDates: ['2026-09-19'],
      }),
      false,
    )
    // Force round still false when budget exhausted
    assert.equal(
      shouldForceAnotherResearchRound({
        goals: assessed,
        toolCallsUsed: 6,
        maxToolCalls: 6,
        steps: 4,
        maxSteps: 8,
        forcedExtraRounds: 1,
        toolTrace,
        tripDates: ['2026-09-19'],
      }),
      false,
    )
  })
})

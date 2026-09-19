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
    const nudge = buildDirectedResearchNudge({
      goals,
      toolTrace,
      tripDates: ['2026-09-19', '2026-09-20'],
    })
    assert.match(nudge, /fetchUrl/i)
    assert.match(nudge, /Do NOT repeat prior webSearch queries/i)
    assert.match(nudge, new RegExp(prior.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(nudge, /refined|day-specific|terminal|serenata/i)
    assert.match(nudge, /never set verificationStatus=verified from a Tavily snippet alone/i)
  })
})

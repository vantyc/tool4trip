import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ToolTraceEntry } from '../../shared/agentContracts.ts'
import { validateClaimsAgainstToolTrace, type AgentClaimDraft } from './claims.ts'
import {
  anchoredSourceCount,
  assessResearchGoals,
  buildDirectedResearchNudge,
  buildResearchDiagnostics,
  deriveResearchGoals,
  shouldSkipToolCallForFlightPriority,
  toPublicResearchGoal,
} from './researchCoverage.ts'
import {
  assessPlannerGoals,
  buildPlannerNudge,
  classifyQueryDimensions,
  computePlannerState,
  decideResponseShape,
  deriveResearchPlan,
  eventTiming,
  extractEventTarget,
  extractPromptCandidates,
  buildResearchTransitionNote,
  filterUnresearchedNegativeWarnings,
  nextRequiredResearchAction,
  pendingGoalWarnings,
  otherEditionYear,
  placeIdentity,
  proposedCandidateVerdict,
  plannedCallLevel,
  planToolCallDecision,
  shouldForcePlannerRound,
  toResearchOnlyDraft,
  type ResearchPlan,
} from './researchPlanner.ts'
import { toolCallOutcome, webResearchWarnings } from './newTravelCoherence.ts'

const MULTI_PROMPT =
  'Quiero ir a la próxima serenata verificable. Compara los municipios Villa Alba, Bosque Bajo y Cerro Claro: incidencia delictiva, hospedaje y cómo llegar en autobús desde la capital. Después vuelo MEX-GDL.'

const MULTI_PROMPT_B =
  '¿Cuándo es la próxima feria en Santa Inés del Monte, Loma Seca o Río Claro? Revisa seguridad y hoteles antes de elegir.'

/** Discovery prompt without a candidate list: event research must surface them. */
const DISCOVERY_PROMPT =
  'Busca las próximas serenatas en municipios del norte del estado; compara seguridad y hospedaje de los candidatos antes de proponer destino.'

function search(
  query: string,
  sources: Array<{ url: string; title?: string; snippet?: string }>,
  extraArgs: Record<string, unknown> = {},
): ToolTraceEntry {
  return {
    tool: 'webSearch',
    args: { query, provider: 'tavily', ...extraArgs },
    ok: true,
    sources,
    checkedAt: '2026-09-28T18:00:00+00:00',
  }
}

function fetchOk(url: string, snippet = 'page text'): ToolTraceEntry {
  return {
    tool: 'fetchUrl',
    args: { url },
    ok: true,
    sources: [{ url, snippet }],
    checkedAt: '2026-09-28T18:01:00+00:00',
  }
}

function schedules(): ToolTraceEntry {
  return {
    tool: 'searchFlightSchedules',
    args: { origin: 'MEX', destination: 'GDL', date: '2026-10-02' },
    ok: true,
    sources: [
      {
        url: 'https://aerodatabox.example/flights/mex-gdl/2026-10-02',
        title: 'MEX → GDL 2026-10-02',
        snippet: 'AM 230 08:00 → 09:40',
      },
    ],
    checkedAt: '2026-09-28T18:00:00+00:00',
  }
}

function webClaim(statement: string, url: string): AgentClaimDraft {
  return {
    kind: 'other_factual',
    statement,
    sourceType: 'web',
    sourceUrl: url,
    evidenceIndex: 0,
    verificationStatus: 'verified',
    confidence: 'high',
    sourceTitle: '',
    quotedFact: statement,
  }
}

describe('deriveResearchPlan', () => {
  it('multi-objective prompt → event/destination decision-critical, flights secondary', () => {
    const plan = deriveResearchPlan(MULTI_PROMPT)
    assert.equal(plan.multiObjective, true)
    assert.deepEqual(plan.promptCandidates, ['Villa Alba', 'Bosque Bajo', 'Cerro Claro'])
    const byKind = new Map(plan.goals.map((g) => [g.kind, g]))
    const event = byKind.get('event_discovery')!
    const dest = byKind.get('destination_selection')!
    assert.equal(event.tier, 'critical')
    assert.equal(event.decisionCritical, true)
    assert.equal(dest.tier, 'critical')
    assert.equal(dest.decisionCritical, true)
    assert.deepEqual(dest.dependsOn, [
      'goal-event-discovery',
      'goal-public-safety',
      'goal-lodging-dest',
    ])
    assert.equal(byKind.get('public_safety')!.tier, 'supporting')
    assert.equal(byKind.get('lodging_destination')!.tier, 'supporting')
    assert.equal(byKind.get('ground_leg')!.tier, 'supporting')
    const flight = byKind.get('flight_day_specific')!
    assert.equal(flight.tier, 'secondary')
    assert.equal(flight.important, false)
    assert.ok(!byKind.has('event_activities'))
    // Priority: decision goals first, flights last
    assert.equal(plan.goals[0]!.kind, 'event_discovery')
    assert.equal(plan.goals[1]!.kind, 'destination_selection')
    assert.ok(
      plan.goals.findIndex((g) => g.kind === 'flight_day_specific') >
        plan.goals.findIndex((g) => g.kind === 'ground_leg'),
    )
  })

  it('second fictional town set (o-separated list, question form)', () => {
    const plan = deriveResearchPlan(MULTI_PROMPT_B)
    assert.equal(plan.multiObjective, true)
    assert.deepEqual(plan.promptCandidates, [
      'Santa Inés del Monte',
      'Loma Seca',
      'Río Claro',
    ])
    assert.ok(plan.goals.some((g) => g.kind === 'event_discovery'))
    assert.ok(plan.goals.some((g) => g.kind === 'destination_selection'))
    assert.ok(plan.goals.some((g) => g.kind === 'public_safety'))
    assert.ok(!plan.goals.some((g) => g.kind === 'flight_day_specific'))
  })

  it('control positive: simple flight ask keeps legacy critical flight goal', () => {
    const plan = deriveResearchPlan('vuelo MEX-GDL mañana')
    assert.equal(plan.multiObjective, false)
    assert.deepEqual(plan.goals, deriveResearchGoals('vuelo MEX-GDL mañana'))
    const flight = plan.goals.find((g) => g.kind === 'flight_day_specific')!
    assert.equal(flight.tier, 'critical')
  })

  it('dated target event in a fixed destination IS multi-objective: event discovery before flights', () => {
    const prompt =
      'Salida MEX–GDL sábado 19 de septiembre 2026 para asistir a la serenata en San Miguel el Alto el domingo 20, regreso preferido martes 22'
    const plan = deriveResearchPlan(prompt)
    assert.equal(plan.eventDiscovery, true)
    assert.equal(plan.multiObjective, true)
    assert.equal(plan.destinationSelection, false)
    assert.equal(plan.eventTarget, 'serenata')
    assert.equal(plan.eventWindow?.from, '2026-09-19')
    assert.deepEqual(plan.promptCandidates, ['San Miguel el Alto'])
    assert.equal(plan.goals[0]!.kind, 'event_discovery')
    assert.equal(plan.goals[0]!.tier, 'critical')
    assert.equal(plan.goals.find((g) => g.kind === 'flight_day_specific')?.tier, 'secondary')
    assert.ok(!plan.goals.some((g) => g.kind === 'destination_selection'))
  })

  it('same routing for any target type and a fictional town (no hardcoded event/place)', () => {
    const plan = deriveResearchPlan(
      'Hoy es 28 de septiembre de 2026. Quiero ir a la procesión de Cerro Claro, Jalisco, del 6 al 8 de octubre de 2026. Vuelo MEX-GDL y hotel.',
    )
    assert.equal(plan.multiObjective, true)
    assert.equal(plan.eventTarget, 'procesion')
    assert.deepEqual(plan.promptCandidates, ['Cerro Claro'])
    assert.deepEqual(plan.eventWindow, { from: '2026-09-28', to: '2026-10-08' })
  })

  it('control: fixed destination + fixed date without a target event keeps legacy flight-first', () => {
    for (const prompt of [
      'Salida MEX–GDL sábado 19 de septiembre 2026 a San Miguel el Alto, hotel en el centro, regreso preferido martes 22',
      // Mentioned but not asked to attend/verify (e.g. an edit on a saved trip)
      'Salida MEX–GDL sábado 19 de septiembre 2026, serenata en San Miguel el Alto el domingo 20, regreso preferido martes 22',
    ]) {
      const plan = deriveResearchPlan(prompt)
      assert.equal(plan.multiObjective, false, prompt)
      assert.equal(plan.eventDiscovery, false, prompt)
      assert.deepEqual(plan.goals, deriveResearchGoals(prompt))
      assert.equal(plan.goals.find((g) => g.kind === 'flight_day_specific')?.tier, 'critical')
    }
  })

  it('candidate extraction ignores IATA codes, platforms and sentence starters', () => {
    assert.deepEqual(
      extractPromptCandidates('Compara Facebook, MEX y GDL con Google'),
      [],
    )
    assert.deepEqual(extractPromptCandidates('Busca vuelos MEX-GDL'), [])
  })
})

describe('planner loop gating', () => {
  it('flights cannot monopolize the budget (replay of the failing sequence)', () => {
    const plan = deriveResearchPlan(MULTI_PROMPT)
    const state = computePlannerState(plan, [])
    const flight = planToolCallDecision({
      plan,
      state,
      toolName: 'searchFlightSchedules',
      argsJson: JSON.stringify({ origin: 'MEX', destination: 'GDL', date: '2026-10-02' }),
      toolTrace: [],
    })
    assert.equal(flight.allow, false)
    assert.equal(flight.allow === false && flight.reason, 'deferred_by_dependency')

    const event = planToolCallDecision({
      plan,
      state,
      toolName: 'webSearch',
      argsJson: JSON.stringify({ query: 'serenata Villa Alba 2026 fecha' }),
      toolTrace: [],
    })
    assert.equal(event.allow, true)

    // Schedules already fetched (old behavior): the AeroDataBox fetch is flight work too
    const trace = [schedules()]
    const st2 = computePlannerState(plan, trace)
    const aeroFetch = planToolCallDecision({
      plan,
      state: st2,
      toolName: 'fetchUrl',
      argsJson: JSON.stringify({
        url: 'https://aerodatabox.example/flights/mex-gdl/2026-10-02',
      }),
      toolTrace: trace,
    })
    assert.equal(aeroFetch.allow, false)

    // Legacy flight-first gate must not fire when flight is secondary
    assert.equal(
      shouldSkipToolCallForFlightPriority({
        toolName: 'webSearch',
        argsJson: JSON.stringify({ query: 'serenata Villa Alba' }),
        goals: plan.goals,
        toolTrace: [],
        tripDates: [],
      }),
      false,
    )
  })

  it('forces rounds only while level-0 research is open; never for flights', () => {
    const plan = deriveResearchPlan(MULTI_PROMPT)
    const base = {
      plan,
      forcedRounds: 0,
      toolCallsUsed: 2,
      maxToolCalls: 12,
      steps: 2,
      maxSteps: 8,
    }
    assert.equal(
      shouldForcePlannerRound({ ...base, state: computePlannerState(plan, []) }),
      true,
    )
    assert.equal(
      shouldForcePlannerRound({
        ...base,
        forcedRounds: 3,
        state: computePlannerState(plan, []),
      }),
      false,
    )
    assert.equal(
      shouldForcePlannerRound({
        ...base,
        toolCallsUsed: 12,
        state: computePlannerState(plan, []),
      }),
      false,
    )
  })

  it('decision budget closes once event/safety/lodging are covered (no spending leftovers)', () => {
    const plan = deriveResearchPlan(
      'Próxima serenata entre Villa Alba y Cerro Claro; compara seguridad y hospedaje',
    )
    const eventUrl = 'https://villa-alba.example/serenata'
    const trace: ToolTraceEntry[] = [
      search('serenata Villa Alba Cerro Claro fechas', [
        {
          url: eventUrl,
          title: 'Serenata',
          snippet: 'Serenata en Villa Alba el 3 de octubre',
        },
      ]),
      fetchOk(eventUrl, 'Serenata en Villa Alba el 3 de octubre'),
      search('seguridad Villa Alba', [
        { url: 'https://s.example/a', snippet: 'Villa Alba baja incidencia delictiva' },
      ]),
      search('hospedaje Villa Alba', [
        { url: 'https://h.example/a', title: 'Hotel Centro Villa Alba', snippet: 'Hotel en Villa Alba' },
      ]),
    ]
    const state = computePlannerState(plan, trace)
    // Only Villa Alba is event-backed → the only relevant candidate
    assert.deepEqual(state.relevantCandidates, ['Villa Alba'])
    assert.equal(state.decisionBudgetOpen, false)
  })
})

describe('candidate evaluation (A/B/C)', () => {
  const eventUrl = 'https://turismo.example/serenatas-octubre'
  const calendar = {
    url: eventUrl,
    title: 'Calendario de serenatas',
    snippet:
      'Serenata en Villa Alba el 3 de octubre; serenata en Bosque Bajo el 10 de octubre; serenata en Cerro Claro el 17 de octubre.',
  }
  const trace: ToolTraceEntry[] = [
    search('próximas serenatas municipios norte octubre 2026', [calendar]),
    // The model proposes the towns it found as candidates, explicitly.
    search('serenatas Villa Alba Bosque Bajo Cerro Claro programa', [], {
      candidates: ['Villa Alba', 'Bosque Bajo', 'Cerro Claro'],
    }),
    fetchOk(eventUrl, 'Calendario oficial de serenatas 2026'),
    search('seguridad municipios norte incidencia delictiva', [
      {
        url: 'https://noticias.example/alerta',
        title: 'Alerta de viaje',
        snippet:
          'Alerta en Bosque Bajo por enfrentamientos recientes. Villa Alba y Cerro Claro con baja incidencia delictiva.',
      },
    ]),
    search('hospedaje Villa Alba', [
      {
        url: 'https://hoteles.example/villa-alba',
        title: 'Hotel Plaza Villa Alba',
        snippet: 'Hotel Plaza en Villa Alba, habitaciones dobles.',
      },
    ]),
  ]

  it('event discovers A, B, C; safety discards B; lodging pending for C only', () => {
    const plan = deriveResearchPlan(DISCOVERY_PROMPT)
    assert.equal(plan.multiObjective, true)
    assert.equal(plan.destinationSelection, true)
    assert.deepEqual(plan.promptCandidates, [])
    // Without the model's explicit proposal the snippet alone creates no candidate.
    assert.deepEqual(computePlannerState(plan, [trace[0]!]).candidates, [])
    const state = computePlannerState(plan, trace)
    const names = state.candidates.map((c) => c.name)
    assert.deepEqual(names, ['Villa Alba', 'Bosque Bajo', 'Cerro Claro'])
    const b = state.candidates.find((c) => c.name === 'Bosque Bajo')!
    assert.equal(b.status, 'discarded')
    assert.deepEqual(state.relevantCandidates, ['Villa Alba', 'Cerro Claro'])
    const lodging = state.dimensions.find((d) => d.dimension === 'lodging')!
    assert.deepEqual(lodging.pendingCandidates, ['Cerro Claro'])
    assert.equal(lodging.satisfied, false)
    assert.equal(lodging.level, 0)
    assert.equal(state.decisionBudgetOpen, true)
  })

  it('planner keeps researching A/C while destination_selection is still open', () => {
    const plan = deriveResearchPlan(DISCOVERY_PROMPT)
    const state = computePlannerState(plan, trace)
    const goals = assessPlannerGoals(plan, trace)
    const dest = goals.find((g) => g.kind === 'destination_selection')!
    assert.equal(dest.status, 'PARTIAL')
    assert.match(dest.evidenceNote ?? '', /open candidates: Villa Alba, Cerro Claro/)

    const lodgingC = planToolCallDecision({
      plan,
      state,
      toolName: 'webSearch',
      argsJson: JSON.stringify({ query: 'hoteles en Cerro Claro' }),
      toolTrace: trace,
    })
    assert.equal(lodgingC.allow, true)

    const lodgingB = planToolCallDecision({
      plan,
      state,
      toolName: 'webSearch',
      argsJson: JSON.stringify({ query: 'hoteles en Bosque Bajo' }),
      toolTrace: trace,
    })
    assert.equal(lodgingB.allow, false)
    assert.equal(lodgingB.allow === false && lodgingB.reason, 'candidate_discarded')

    const flight = planToolCallDecision({
      plan,
      state,
      toolName: 'searchFlightSchedules',
      argsJson: JSON.stringify({ origin: 'MEX', destination: 'GDL', date: '2026-10-03' }),
      toolTrace: trace,
    })
    assert.equal(flight.allow, false)
  })
})

describe('planner goal assessment + response shape', () => {
  const eventUrl = 'https://villa-alba.example/serenata'
  const trace: ToolTraceEntry[] = [
    search('próxima serenata Villa Alba', [
      { url: eventUrl, title: 'Serenata', snippet: 'Serenata en Villa Alba el 3 de octubre de 2026' },
    ]),
    fetchOk(eventUrl, 'Serenata en Villa Alba el 3 de octubre de 2026'),
  ]

  it('event_discovery is never RESOLVED inside the loop (PARTIAL at most)', () => {
    const plan = deriveResearchPlan('¿Cuándo es la próxima serenata en Villa Alba?')
    const goals = assessPlannerGoals(plan, trace)
    assert.equal(goals.find((g) => g.kind === 'event_discovery')!.status, 'PARTIAL')
    assert.equal(
      decideResponseShape({ noMutation: false, goals }).shape,
      'research_only',
    )
  })

  it('RESOLVED only with a grounded verified https claim', () => {
    const plan = deriveResearchPlan('¿Cuándo es la próxima serenata en Villa Alba?')
    const goals = assessPlannerGoals(plan, trace, {
      grounded: {
        validClaims: [
          webClaim('Serenata en Villa Alba el 3 de octubre de 2026', eventUrl),
        ],
        package: { trip: { destination: 'Villa Alba' } },
      },
    })
    assert.equal(goals.find((g) => g.kind === 'event_discovery')!.status, 'RESOLVED')
    assert.equal(decideResponseShape({ noMutation: false, goals }).shape, 'package')
    // …but the user's "no crear todavía" still wins
    assert.equal(decideResponseShape({ noMutation: true, goals }).shape, 'research_only')
  })

  it('unverified claim does not resolve the event', () => {
    const plan = deriveResearchPlan('¿Cuándo es la próxima serenata en Villa Alba?')
    const claim = {
      ...webClaim('Serenata en Villa Alba el 3 de octubre de 2026', eventUrl),
      verificationStatus: 'estimated' as const,
    }
    const goals = assessPlannerGoals(plan, trace, {
      grounded: { validClaims: [claim], package: {} },
    })
    assert.equal(goals.find((g) => g.kind === 'event_discovery')!.status, 'PARTIAL')
  })

  it('no event evidence → UNRESOLVED; no web tools → UNSUPPORTED mapped publicly', () => {
    const plan = deriveResearchPlan('¿Cuándo es la próxima serenata en Villa Alba?')
    const unresolved = assessPlannerGoals(plan, [])
    assert.equal(unresolved.find((g) => g.kind === 'event_discovery')!.status, 'UNRESOLVED')

    const unsupported = assessPlannerGoals(plan, [], { availableTools: ['searchFlightSchedules'] })
    const ev = unsupported.find((g) => g.kind === 'event_discovery')!
    assert.equal(ev.status, 'UNSUPPORTED')
    const pub = toPublicResearchGoal(ev)
    assert.equal(pub.status, 'UNRESOLVED')
    assert.match(pub.evidenceNote ?? '', /^unsupported:/)
    assert.ok(!('decisionCritical' in pub))
    assert.ok(!('dependsOn' in pub))
  })

  it('public diagnostics never leak internal fields or UNSUPPORTED', () => {
    const plan = deriveResearchPlan(MULTI_PROMPT)
    const assessed = assessPlannerGoals(plan, [], { availableTools: [] })
    const diag = buildResearchDiagnostics({
      goals: plan.goals,
      assessedGoals: assessed,
      toolTrace: [],
      toolRounds: 0,
      toolCallsUsed: 0,
      maxToolCalls: 12,
      forcedExtraRounds: 0,
    })
    for (const g of diag.goals) {
      assert.ok(['RESOLVED', 'PARTIAL', 'UNRESOLVED'].includes(g.status))
      assert.deepEqual(
        Object.keys(g).filter((k) => !['id', 'kind', 'label', 'important', 'status', 'evidenceNote', 'tier'].includes(k)),
        [],
      )
    }
  })
})

describe('attribution: no coverage inflation from a fetched page', () => {
  it('a fetched social page surfaced by an event query does not count for lodging', () => {
    const goals = deriveResearchGoals(
      'Vuelo MEX-GDL 2 octubre 2026, serenata en el pueblo y hospedaje en destino',
    )
    const fb = 'https://www.facebook.com/HotelPlazaFiestasPatronales/posts/1'
    const trace: ToolTraceEntry[] = [
      search('serenata Villa Alba 2026', [
        { url: fb, title: 'Publicación', snippet: 'Invitación de la parroquia' },
      ]),
      fetchOk(fb, 'Log in to Facebook'),
    ]
    const assessed = assessResearchGoals(goals, trace, { tripDates: ['2026-10-02'] })
    const lodging = assessed.find((g) => g.kind === 'lodging_destination')!
    assert.equal(lodging.status, 'UNRESOLVED')
  })
})

// ---------------------------------------------------------------------------
// Regressions from job d298f3b6 (real Ask Travel E2E)
// ---------------------------------------------------------------------------

function decide(
  plan: ResearchPlan,
  trace: ToolTraceEntry[],
  toolName: string,
  args: Record<string, unknown>,
) {
  return planToolCallDecision({
    plan,
    state: computePlannerState(plan, trace),
    toolName,
    argsJson: JSON.stringify(args),
    toolTrace: trace,
  })
}

function skipped(tool: string, reason: string): ToolTraceEntry {
  return {
    tool,
    args: { skipped: true, deferred: reason },
    ok: false,
    sources: [],
    error: `deferred: ${reason}`,
    checkedAt: '2026-09-28T18:02:00+00:00',
  }
}

describe('discovery vs verification budget (d298f3b6 deadlock)', () => {
  const prompt =
    'Quiero ir a la próxima serenata verificable. Compara los municipios Villa Alba, Bosque Bajo, Cerro Claro y Loma Seca: incidencia delictiva y hospedaje.'
  const towns = ['Villa Alba', 'Bosque Bajo', 'Cerro Claro', 'Loma Seca']
  const url = (t: string) => `https://noticias.example/${t.toLowerCase().replace(/\s+/g, '-')}`
  const searches = towns.map((t, i) =>
    search(`serenata ${t} octubre 2026`, [
      { url: url(t), title: `Fiestas ${t}`, snippet: `Serenata en ${t} el ${i + 3} de octubre` },
    ]),
  )

  it('discovery spent (A–D already searched): fetching promising A and C is still allowed', () => {
    const plan = deriveResearchPlan(prompt)
    const trace: ToolTraceEntry[] = [...searches]
    const event = computePlannerState(plan, trace).dimensions.find((d) => d.dimension === 'event')!
    assert.equal(event.discoveryExhausted, true)
    assert.equal(event.exhausted, false, 'discovered results still pending verification')
    assert.ok(event.pendingVerification.includes(url('Villa Alba')))
    assert.ok(event.pendingVerification.includes(url('Cerro Claro')))

    const fifth = decide(plan, trace, 'webSearch', { query: 'serenata Villa Alba programa' })
    assert.equal(fifth.allow, false)

    const fetchA = decide(plan, trace, 'fetchUrl', { url: url('Villa Alba') })
    assert.equal(fetchA.allow, true)
    assert.equal(fetchA.allow && fetchA.phase, 'verification')
    trace.push(fetchOk(url('Villa Alba'), 'Programa oficial: serenata el 3 de octubre'))

    const fetchC = decide(plan, trace, 'fetchUrl', { url: url('Cerro Claro') })
    assert.equal(fetchC.allow, true)
    assert.equal(fetchC.allow && fetchC.phase, 'verification')
  })

  it('verification has its own ceiling (not unlimited fetches)', () => {
    const plan = deriveResearchPlan(prompt)
    const trace: ToolTraceEntry[] = [
      ...searches,
      fetchOk(url('Villa Alba')),
      fetchOk(url('Bosque Bajo')),
      fetchOk(url('Cerro Claro')),
    ]
    const fourth = decide(plan, trace, 'fetchUrl', { url: url('Loma Seca') })
    assert.equal(fourth.allow === false && fourth.reason, 'verification_budget_exhausted')
  })

  it('a fetch of a URL no search returned is discovery, not verification', () => {
    const plan = deriveResearchPlan(prompt)
    const unknown = JSON.stringify({ url: 'https://otro.example/pagina' })
    assert.equal(plannedCallLevel(plan, 'fetchUrl', unknown, searches).phase, 'discovery')
    assert.equal(
      plannedCallLevel(plan, 'fetchUrl', JSON.stringify({ url: url('Loma Seca') }), searches).phase,
      'verification',
    )
    // An unrelated page is not a free verification slot while event research is open.
    const d = decide(plan, searches, 'fetchUrl', { url: 'https://otro.example/pagina' })
    assert.equal(d.allow === false && d.reason, 'deferred_by_dependency')
  })
})

describe('candidate identity: three different "San Miguel" (d298f3b6)', () => {
  const prompt =
    'Busca la próxima serenata en Jalisco. Compara los municipios San Miguel el Alto, San Julián y Jalostotitlán: incidencia delictiva y hospedaje.'
  const sma = (state: ReturnType<typeof computePlannerState>) =>
    state.candidates.find((c) => c.name === 'San Miguel el Alto')!

  it('plan records the region state and the three candidates', () => {
    const plan = deriveResearchPlan(prompt)
    assert.deepEqual(plan.promptCandidates, ['San Miguel el Alto', 'San Julián', 'Jalostotitlán'])
    assert.deepEqual(plan.regionStates, ['jalisco'])
  })

  it('San Miguel el Alto, Jalisco (named) → identified; event supported', () => {
    const plan = deriveResearchPlan(prompt)
    const state = computePlannerState(plan, [
      search('serenata San Miguel el Alto octubre', [
        {
          url: 'https://sma.example/serenata',
          title: 'Serenata',
          snippet: 'Serenata en San Miguel el Alto, Jalisco, el 4 de octubre',
        },
      ]),
    ])
    assert.equal(sma(state).cells.event, 'supported')
    assert.equal(sma(state).status, 'open')
  })

  it('San Miguel de Allende, Guanajuato → never affects San Miguel el Alto (no discard, no safety verdict)', () => {
    const plan = deriveResearchPlan(prompt)
    const state = computePlannerState(plan, [
      search('incidencia delictiva San Miguel el Alto 2026', [
        {
          url: 'https://periodico.example/guanajuato',
          title: 'Trece municipios de Guanajuato no registran homicidios en 2026',
          snippet:
            'July 13, 2026 - San Miguel · Celaya · Otros municipios · Seguridad. Alta incidencia delictiva en León y San Miguel de Allende.',
        },
      ]),
    ])
    assert.equal(sma(state).status, 'open')
    assert.equal(sma(state).cells.safety, 'attempted')
  })

  it('even a sentence naming San Miguel el Alto is ambiguous when the source is about another state', () => {
    const plan = deriveResearchPlan(prompt)
    const state = computePlannerState(plan, [
      search('seguridad San Miguel el Alto', [
        {
          url: 'https://periodico.example/gto-alerta',
          title: 'Guanajuato: reporte regional',
          snippet: 'Alta incidencia delictiva en San Miguel el Alto',
        },
      ]),
    ])
    assert.equal(sma(state).status, 'open')
    assert.equal(sma(state).cells.safety, 'attempted')
  })

  it('San Miguel Cuyutlán, Jalisco → does not support San Miguel el Alto', () => {
    const plan = deriveResearchPlan(prompt)
    const state = computePlannerState(plan, [
      search('serenata tradicional San Miguel el Alto septiembre octubre 2026', [
        {
          url: 'https://www.instagram.com/reel/cuyutlan',
          title: 'Estas son las Tradicionales Serenatas de San Miguel el Alto ...',
          snippet: 'Del 20 al 29 de septiembre de 2026 ¡San Miguel Cuyutlán está de fiesta!',
        },
      ]),
    ])
    assert.equal(sma(state).cells.event, 'attempted')
    assert.equal(state.hasEventEvidence, true, 'the dated mention still counts as event evidence')
  })

  it('placeIdentity: prefix, sibling and conflicting state are never identified', () => {
    const base = { name: 'San Miguel el Alto', regionStates: ['jalisco'] }
    assert.equal(placeIdentity({ ...base, sentence: 'Serenata en San Miguel el Alto el 4 de octubre' }), 'identified')
    assert.equal(placeIdentity({ ...base, sentence: 'Seguridad en San Miguel · Celaya' }), 'absent')
    assert.equal(placeIdentity({ ...base, sentence: 'San Miguel de Allende, Guanajuato' }), 'absent')
    assert.equal(placeIdentity({ ...base, sentence: 'San Miguel Cuyutlán está de fiesta' }), 'absent')
    assert.equal(
      placeIdentity({ ...base, sentence: 'Serenatas en San Miguel el Alto y San Miguel Cuyutlán el 3 de octubre' }),
      'ambiguous',
    )
    assert.equal(
      placeIdentity({ ...base, sentence: 'Alerta en San Miguel el Alto', sourceTitle: 'Noticias de Guanajuato' }),
      'ambiguous',
    )
    assert.equal(
      placeIdentity({ ...base, sentence: 'Hotel en San Miguel el Alto, Jalisco' }),
      'identified',
    )
  })

  it('an ambiguous safety result never discards a candidate', () => {
    const plan = deriveResearchPlan(prompt)
    const state = computePlannerState(plan, [
      search('seguridad San Miguel el Alto', [
        { url: 'https://n.example/1', title: 'Alerta', snippet: 'Alerta de viaje en San Miguel por enfrentamientos' },
        {
          url: 'https://n.example/2',
          title: 'Alerta',
          snippet: 'Enfrentamientos en San Miguel el Alto y San Miguel de Allende',
        },
      ]),
    ])
    assert.equal(sma(state).status, 'open')
    assert.notEqual(sma(state).cells.safety, 'rejected')
  })

  it('control positive: identified negative safety evidence still discards', () => {
    const plan = deriveResearchPlan(prompt)
    const state = computePlannerState(plan, [
      search('seguridad San Julián', [
        { url: 'https://n.example/3', title: 'Alerta Jalisco', snippet: 'Alerta en San Julián por enfrentamientos recientes' },
      ]),
    ])
    assert.equal(state.candidates.find((c) => c.name === 'San Julián')!.status, 'discarded')
  })
})

const REAL_PROMPT_EXCERPT = [
  'Mi objetivo principal es asistir a una serenata tradicional de pueblo que todavía no haya ocurrido.',
  'Investiga en Jalisco, especialmente Los Altos y la zona norte, pero no te limites a San Miguel el Alto. Incluye y verifica municipios como San Miguel el Alto, San Julián, Jalostotitlán, Yahualica, Totatiche, Huejúcar, Colotlán y otros municipios de Jalisco que tengan fiestas patronales o ferias todavía activas.',
  '3. Prioriza municipios con menor incidencia delictiva registrada.',
  '6. Verifica hospedaje en el municipio o muy cerca.',
  'Si Totatiche tiene serenatas durante su Feria 2026, verifícalas en la web y compáralas con las demás opciones; no lo elijas automáticamente.',
  'Colotlán tiene un significado personal para mí y me gustaría visitarlo si encaja naturalmente en la ruta.',
  'No modifiques todavía mi viaje guardado.',
].join('\n')

const SEVEN = [
  'San Miguel el Alto',
  'San Julián',
  'Jalostotitlán',
  'Yahualica',
  'Totatiche',
  'Huejúcar',
  'Colotlán',
]

describe('coverage of explicitly named candidates (d298f3b6)', () => {
  it('7 explicit candidates; the one with its own verification instruction goes first', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    assert.deepEqual(plan.promptCandidates, SEVEN)
    assert.deepEqual(plan.priorityCandidates, ['Totatiche'])
    const state = computePlannerState(plan, [])
    assert.equal(state.candidates[0]!.name, 'Totatiche')
    assert.equal(state.candidates[0]!.priority, 'verify_requested')
    assert.deepEqual(state.relevantCandidates.length, 7, 'no arbitrary cut at four')
    assert.deepEqual([...state.uncoveredCandidates].sort(), [...SEVEN].sort())
  })

  it('the real first turn: the 4th event query is deferred until Totatiche is researched', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    const trace: ToolTraceEntry[] = []
    const verdicts: string[] = []
    for (const town of ['San Miguel el Alto', 'San Julián', 'Jalostotitlán', 'Yahualica']) {
      const args = { query: `serenata tradicional ${town} septiembre octubre 2026` }
      const d = decide(plan, trace, 'webSearch', args)
      verdicts.push(d.allow ? 'allow' : d.reason)
      if (d.allow) trace.push(search(args.query, []))
    }
    assert.deepEqual(verdicts, ['allow', 'allow', 'allow', 'deferred_for_priority_candidate'])
    const tot = decide(plan, trace, 'webSearch', { query: 'serenata Feria Totatiche 2026' })
    assert.equal(tot.allow, true)
  })

  it('generic discovery cannot starve named candidates; grouped queries cover two at once', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    const trace: ToolTraceEntry[] = [
      search('serenata Feria Totatiche 2026', []),
      search('serenata San Miguel el Alto San Julián octubre', []),
    ]
    const generic = decide(plan, trace, 'webSearch', { query: 'serenatas Los Altos octubre 2026' })
    assert.equal(generic.allow === false && generic.reason, 'deferred_for_explicit_candidate')
    const grouped = decide(plan, trace, 'webSearch', { query: 'serenata Huejúcar Colotlán octubre' })
    assert.equal(grouped.allow, true)
    trace.push(search('serenata Huejúcar Colotlán octubre', []))
    const state = computePlannerState(plan, trace)
    assert.deepEqual(state.uncoveredCandidates, ['Jalostotitlán', 'Yahualica'])
    assert.match(buildPlannerNudge({ plan, state, remainingCalls: 8 }), /at most 2 of them per query/)
  })

  it('candidates left without research are reported, never silently dropped', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    const trace: ToolTraceEntry[] = [
      search('serenata Feria Totatiche 2026', []),
      search('serenata San Miguel el Alto', []),
      search('serenata San Julián', []),
      search('serenata Jalostotitlán', []),
    ]
    const state = computePlannerState(plan, trace)
    const goals = assessPlannerGoals(plan, trace)
    const dest = goals.find((g) => g.kind === 'destination_selection')!
    assert.match(dest.evidenceNote ?? '', /not researched: Yahualica, Huejúcar, Colotlán/)
    const draft = toResearchOnlyDraft({ narrative: '', warnings: [] }, researchReq(REAL_PROMPT_EXCERPT), {
      isNewTravel: true,
      goals,
      reasons: ['el usuario pidió no crear/modificar nada todavía'],
      validClaims: [],
      planner: { state, dimensions: plan.dimensions },
    })
    assert.match(String(draft.narrative), /Candidatos nombrados sin investigar: Yahualica, Huejúcar, Colotlán/)
    assert.match(String(draft.narrative), /Totatiche \(verificación pedida por el usuario\)/)
  })
})

function researchReq(prompt: string) {
  const tripId = '55555555-5555-4555-8555-555555555555'
  return {
    prompt,
    tripId,
    mode: 'new_travel' as const,
    locale: 'es',
    context: {
      trip: {
        id: tripId,
        title: 'Nuevo viaje',
        startDate: '2026-01-01',
        endDate: '2026-01-02',
        timezone: 'America/Mexico_City',
        goals: [],
        status: 'planned' as const,
      },
      bookings: [],
      travelOptions: [],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
      packageImports: [],
    },
  }
}

describe('research-only narrative is server-built (d298f3b6)', () => {
  const rejected = 'San Miguel el Alto tiene serenata hasta el 29 de septiembre de 2026'

  it('model narrative and concrete model warnings never reach the research-only answer', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    const trace = [
      search('serenata tradicional San Miguel el Alto septiembre octubre 2026', [
        {
          url: 'https://www.instagram.com/reel/cuyutlan',
          title: 'Estas son las Tradicionales Serenatas de San Miguel el Alto ...',
          snippet: 'Del 20 al 29 de septiembre de 2026 ¡San Miguel Cuyutlán está de fiesta!',
        },
      ]),
    ]
    const draft = toResearchOnlyDraft(
      {
        narrative: `${rejected}, pero la ventana es corta.`,
        warnings: [
          `${rejected} (no verificado).`,
          'No se pudo confirmar disponibilidad ni calidad de Wi-Fi en hospedajes.',
          'server: claim[0] no grounded (number_mismatch) — statement numbers [29,2026] not all present in server evidence',
        ],
      },
      researchReq(REAL_PROMPT_EXCERPT),
      {
        isNewTravel: true,
        goals: assessPlannerGoals(plan, trace),
        reasons: ['el usuario pidió no crear/modificar nada todavía'],
        validClaims: [],
        planner: { state: computePlannerState(plan, trace), dimensions: plan.dimensions },
      },
    )
    const narrative = String(draft.narrative)
    assert.doesNotMatch(narrative, /hasta el 29/)
    assert.doesNotMatch(narrative, /tiene serenata/)
    assert.doesNotMatch(narrative, /ventana es corta/)
    assert.match(narrative, /Estado de la investigación/)
    assert.match(narrative, /San Miguel el Alto: evento: buscado, sin evidencia que identifique el lugar/)
    assert.doesNotMatch(narrative, /Hallazgos con fuente/)
    const warnings = draft.warnings as string[]
    assert.ok(!warnings.some((w) => w.includes(rejected)))
    assert.ok(warnings.some((w) => /Wi-Fi/.test(w)), 'non-concrete model warning kept')
    assert.ok(warnings.some((w) => /number_mismatch/.test(w)), 'server warning kept')
    assert.ok(warnings.some((w) => /1 advertencia\(s\) del modelo omitida/.test(w)))
    assert.deepEqual(draft.ops, [])
  })

  it('grounded findings are the only external facts shown', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    const url = 'https://totatiche.example/feria-2026'
    const draft = toResearchOnlyDraft({ narrative: 'texto del modelo' }, researchReq(REAL_PROMPT_EXCERPT), {
      isNewTravel: true,
      goals: assessPlannerGoals(plan, []),
      reasons: ['x'],
      validClaims: [webClaim('Serenata en Totatiche el 3 de octubre de 2026', url)],
      planner: { state: computePlannerState(plan, []), dimensions: plan.dimensions },
    })
    const narrative = String(draft.narrative)
    assert.match(narrative, /Hallazgos con fuente:\n- Serenata en Totatiche el 3 de octubre de 2026 \(verified; https:\/\/totatiche\.example\/feria-2026\)/)
    assert.doesNotMatch(narrative, /texto del modelo/)
  })
})

describe('ground transport classification (d298f3b6)', () => {
  it('"transporte Guadalajara a X" is ground research', () => {
    assert.ok(classifyQueryDimensions('transporte Guadalajara a San Julián 2026').includes('ground'))
    assert.ok(classifyQueryDimensions('transporte Guadalajara a Jalostotitlán 2026').includes('ground'))
    assert.ok(classifyQueryDimensions('central camionera Jalostotitlán horarios').includes('ground'))
    assert.deepEqual(classifyQueryDimensions('serenata San Julián octubre'), ['event'])
  })

  it('the two real ground searches count as ground attempts', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT + '\nCómo llegar desde CDMX en autobús.')
    const state = computePlannerState(plan, [
      search('transporte Guadalajara a San Julián 2026', [
        { url: 'https://www.primeraplus.com.mx/terminales/t-san-julian-san-julian', title: 'Boletos de autobús a Central de autobuses, San Julián' },
      ]),
      search('transporte Guadalajara a Jalostotitlán 2026', []),
    ])
    const ground = state.dimensions.find((d) => d.dimension === 'ground')!
    assert.equal(ground.attempts, 2)
    assert.equal(state.candidates.find((c) => c.name === 'San Julián')!.cells.ground, 'supported')
  })
})

describe('tool call outcomes vs failures (d298f3b6 warnings)', () => {
  const okSearch = search('serenata San Julián', [{ url: 'https://a.example/1', title: 'x' }])
  const failed: ToolTraceEntry = {
    tool: 'webSearch',
    args: { query: 'serenata Yahualica' },
    ok: false,
    sources: [],
    error: 'tavily 502',
    checkedAt: '2026-09-28T18:00:00+00:00',
  }

  it('classifies failure / deferred / blocked / budget', () => {
    assert.equal(toolCallOutcome(okSearch), 'ok')
    assert.equal(toolCallOutcome(failed), 'tool_failure')
    assert.equal(toolCallOutcome(skipped('webSearch', 'deferred_by_dependency')), 'planner_deferred')
    assert.equal(toolCallOutcome(skipped('webSearch', 'deferred_for_priority_candidate')), 'planner_deferred')
    assert.equal(toolCallOutcome(skipped('webSearch', 'candidate_discarded')), 'planner_blocked')
    assert.equal(toolCallOutcome(skipped('fetchUrl', 'discovery_budget_exhausted')), 'budget_exhausted')
    assert.equal(toolCallOutcome(skipped('fetchUrl', 'verification_budget_exhausted')), 'budget_exhausted')
    assert.equal(
      toolCallOutcome({
        tool: 'webSearch',
        args: { skipped: true },
        ok: false,
        sources: [],
        error: 'AGENT_MAX_TOOL_CALLS research budget 12 reached (multi-objective ceiling 12)',
        checkedAt: '2026-09-28T18:00:00+00:00',
      }),
      'budget_exhausted',
    )
  })

  it('planner skips are never reported as "webSearch falló"', () => {
    const w = webResearchWarnings([
      okSearch,
      skipped('webSearch', 'discovery_budget_exhausted'),
      skipped('webSearch', 'candidate_discarded'),
      skipped('fetchUrl', 'deferred_by_dependency'),
    ])
    assert.ok(!w.some((x) => /falló/.test(x)))
    assert.ok(w.some((x) => /1 llamada\(s\) diferida\(s\) por el planificador/.test(x)))
    assert.ok(w.some((x) => /1 llamada\(s\) bloqueada\(s\) por el planificador/.test(x)))
    assert.ok(w.some((x) => /1 llamada\(s\) no ejecutada\(s\) por presupuesto/.test(x)))
  })

  it('control positive: a real tool failure is still reported', () => {
    const w = webResearchWarnings([okSearch, failed, skipped('webSearch', 'candidate_discarded')])
    assert.ok(w.some((x) => /webSearch falló \(1\)/.test(x)))
  })
})

// ---------------------------------------------------------------------------
// Regressions from job cabef4a6 (second real Ask Travel E2E)
// ---------------------------------------------------------------------------

const TONATICO = {
  url: 'https://www.feriasenmexico.com.mx/feria-tonatico-2026',
  title: 'Feria Tonatico 2026 PROGRAMA - Ferias en México',
  snippet:
    'January 6, 2026 - Del 12 de enero al 3 de febrero se celebrará la Feria Tonatico 2026, una tradición fundamental para este municipio del sur del Estado de México.',
}
const ALLENDE = {
  url: 'https://www.riotimesonline.com/feria-de-san-miguel-de-allende-2026-mexico-4-october',
  title: 'Feria de San Miguel 2026 Dates and Line-Up, Mexico',
  snippet: 'La feria corre del 18 de septiembre al 4 de octubre de 2026.',
}
const TOTATICHE_HTML_HIT = {
  url: 'https://www.feriasenmexico.com.mx/feria-totatiche',
  title: 'Feria Totatiche 2026 - Ferias en México',
  snippet:
    '29 de septiembre: Gran inauguración; 30 de septiembre: Ballet Folklórico de la Región y serenata en la plaza.',
}
const JALISCO_CALENDAR = {
  url: 'https://www.zonaturistica.com/en/events-in/jalisco',
  title: 'Events in 2026, Festivities and Mexican Fiestas',
  snippet: 'Calendar of Tourism Events in JALISCO 2026. Ferias en Jalisco: 3 de octubre, Ciudad de México y Estado de México también.',
}

describe('P2 candidates only from the prompt or an explicit model proposal (cabef4a6)', () => {
  it('incidental place names in snippets never create a candidate ("México", "San Miguel", "Jalisco")', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    const state = computePlannerState(plan, [
      search('serenata feria Totatiche 2026 fechas septiembre octubre', [
        TOTATICHE_HTML_HIT,
        TONATICO,
        JALISCO_CALENDAR,
      ]),
      search('serenata feria San Miguel el Alto 2026', [ALLENDE]),
    ])
    assert.deepEqual(state.candidates.map((c) => c.name).sort(), [...SEVEN].sort())
    assert.ok(!state.candidates.some((c) => /^(méxico|san miguel|jalisco)$/i.test(c.name)))
  })

  it('explicit proposals must be complete geographic entities', () => {
    const verdict = (name: string, snippet: string, existing: string[] = []) =>
      proposedCandidateVerdict({
        name,
        evidence: [{ title: '', snippet }],
        existing,
        regionStates: ['jalisco'],
      })
    assert.equal(verdict('México', TONATICO.snippet), 'region_not_destination')
    assert.equal(verdict('México', 'Serenata en la Ciudad de México el 3 de octubre'), 'region_not_destination')
    assert.equal(verdict('Jalisco', 'Fiestas en Jalisco el 3 de octubre'), 'region_not_destination')
    assert.equal(verdict('Los Altos', 'Serenatas en Los Altos de Jalisco'), 'region_not_destination')
    // "San Miguel de Allende" never yields "San Miguel"
    assert.equal(verdict('San Miguel', 'Fiestas de San Miguel de Allende el 3 de octubre'), 'not_identified_in_evidence')
    assert.equal(
      verdict('San Miguel', 'Fiestas de San Miguel el 3 de octubre', ['San Miguel el Alto']),
      'overlaps_candidate',
    )
    // A real municipality written whole, but in another state, is not a candidate here.
    assert.equal(verdict('Tonatico', TONATICO.snippet), 'not_identified_in_evidence')
  })

  it('control positive: a municipality the model proposes explicitly is added and researched', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    const state = computePlannerState(plan, [
      search(
        'fiestas patronales Villa Guerrero octubre 2026',
        [
          {
            url: 'https://villaguerrero.example/fiestas',
            title: 'Fiestas patronales',
            snippet: 'Serenata en Villa Guerrero, Jalisco, el 3 de octubre de 2026 en la plaza principal.',
          },
        ],
        { candidates: ['Villa Guerrero', 'México'] },
      ),
    ])
    const vg = state.candidates.find((c) => c.name === 'Villa Guerrero')!
    assert.equal(vg.origin, 'model_proposed')
    assert.equal(vg.cells.event, 'supported')
    assert.deepEqual(state.rejectedProposals, [{ name: 'México', reason: 'region_not_destination' }])
  })
})

describe('P3 unusable fetches: own allowance, never retried, fetchable sources first (cabef4a6)', () => {
  const ig = 'https://www.instagram.com/p/DcFtQQLNmEk'
  const ig2 = 'https://www.instagram.com/reel/DdakH2aEQTY'
  const fb = 'https://www.facebook.com/Totatiche.Jalisco/posts/1605287477823544'
  const html = TOTATICHE_HTML_HIT.url
  const hit = (url: string) => ({
    url,
    title: 'Feria Regional Totatiche 2026',
    snippet: 'Feria Regional Totatiche 2026: del 26 de septiembre al 7 de octubre habrá serenatas.',
  })
  const firstSearch = search('serenata feria Totatiche 2026 fechas', [hit(ig), hit(html), hit(fb)])
  function unusable(url: string, quality: string): ToolTraceEntry {
    return {
      tool: 'fetchUrl',
      args: { url, httpStatus: 200, quality },
      ok: false,
      sources: [],
      error: `unusable: ${quality}`,
      checkedAt: '2026-09-28T18:01:00+00:00',
    }
  }

  it('two walls spend no event verification; the usable HTML page can still be verified', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    const trace = [firstSearch, unusable(ig, 'login_wall'), unusable(fb, 'js_required')]
    const event = computePlannerState(plan, trace).dimensions.find((d) => d.dimension === 'event')!
    assert.equal(event.verifications, 0)
    assert.equal(event.failedFetches, 2)
    const d = decide(plan, trace, 'fetchUrl', { url: html })
    assert.equal(d.allow, true)
    assert.equal(d.allow && d.phase, 'verification')
  })

  it('the same unusable URL is never retried', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    const trace = [firstSearch, unusable(ig, 'login_wall')]
    const again = decide(plan, trace, 'fetchUrl', { url: ig })
    assert.equal(again.allow === false && again.reason, 'unusable_url_repeat')
    assert.equal(toolCallOutcome(skipped('fetchUrl', 'unusable_url_repeat')), 'planner_blocked')
  })

  it('failures beyond the allowance spend verification budget (retries stay bounded)', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    const more = search('feria Totatiche programa oficial', [hit(ig2)])
    const trace = [
      firstSearch,
      more,
      unusable(ig, 'login_wall'),
      unusable(fb, 'js_required'),
      unusable(ig2, 'login_wall'),
    ]
    const event = computePlannerState(plan, trace).dimensions.find((d) => d.dimension === 'event')!
    assert.equal(event.failedFetches, 3)
    assert.equal(event.verifications, 1)
  })

  it('after a wall, other URLs on that host are suggested last; the nudge says so', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    const trace = [
      search('serenata feria Totatiche 2026 fechas', [hit(ig), hit(ig2), hit(html)]),
      unusable(ig, 'login_wall'),
    ]
    const state = computePlannerState(plan, trace)
    const event = state.dimensions.find((d) => d.dimension === 'event')!
    assert.deepEqual(event.pendingVerification, [html, ig2])
    const nudge = buildPlannerNudge({ plan, state, remainingCalls: 6 })
    assert.match(nudge, /never fetch again: https:\/\/www\.instagram\.com\/p\/DcFtQQLNmEk/)
    assert.match(nudge, /Prefer fetchable HTML pages/)
  })
})

describe('P4 future-event semantics with a temporal restriction (cabef4a6)', () => {
  const prompt =
    'Hoy es lunes 28 de septiembre de 2026. Quiero asistir a una serenata que todavía no haya ocurrido, entre hoy y el 7 de octubre de 2026. Compara los municipios San Julián, Totatiche y Colotlán: incidencia delictiva y hospedaje.'
  const url = 'https://www.instagram.com/p/DTAzgTKgf1K'
  const sanJulian = (state: ReturnType<typeof computePlannerState>) =>
    state.candidates.find((c) => c.name === 'San Julián')!
  const stateWith = (snippet: string, title = 'Feria de San Julián') => {
    const plan = deriveResearchPlan(prompt)
    const trace = [search('serenata feria San Julián 2026', [{ url, title, snippet }])]
    return { plan, trace, state: computePlannerState(plan, trace) }
  }

  it('the plan records the window of the request', () => {
    assert.deepEqual(deriveResearchPlan(prompt).eventWindow, { from: '2026-09-28', to: '2026-10-07' })
  })

  it('a January 2026 fair does not support the candidate (past, not positive evidence)', () => {
    const { plan, trace, state } = stateWith(
      'Feria de San Julián 2026: serenata, terraza, gallos y juegos mecánicos del 18 de enero al 2 de febrero.',
      'Feria de San Julián 2026 ✨ Del 18 de enero al 2 de febrero',
    )
    assert.equal(sanJulian(state).cells.event, 'attempted')
    assert.equal(state.hasEventEvidence, false)
    assert.equal(sanJulian(state).status, 'open', 'past is irrelevant, not a rejection')
    const goal = assessPlannerGoals(plan, trace).find((g) => g.kind === 'event_discovery')!
    assert.equal(goal.status, 'UNRESOLVED')
    assert.match(goal.evidenceNote ?? '', /inside 2026-09-28–2026-10-07/)
  })

  it('a date inside the window (1 de octubre) supports the candidate', () => {
    const { state } = stateWith('Serenata en San Julián el 1 de octubre en la plaza principal.')
    assert.equal(sanJulian(state).cells.event, 'supported')
    assert.equal(state.hasEventEvidence, true)
  })

  it('no date → partial / unknown (goal PARTIAL, never supported)', () => {
    const { plan, trace, state } = stateWith('Fiestas patronales de San Julián con serenata en la plaza.')
    assert.equal(sanJulian(state).cells.event, 'partial')
    assert.equal(state.hasEventEvidence, false)
    assert.equal(state.hasPartialEventEvidence, true)
    const goals = assessPlannerGoals(plan, trace)
    assert.equal(goals.find((g) => g.kind === 'event_discovery')!.status, 'PARTIAL')
    const draft = toResearchOnlyDraft({}, researchReq(prompt), {
      isNewTravel: true,
      goals,
      reasons: ['x'],
      validClaims: [],
      planner: { state, dimensions: plan.dimensions },
    })
    assert.match(String(draft.narrative), /San Julián: evento: mencionado sin fecha verificable/)
  })

  it('a grounded claim about a past edition never resolves event discovery', () => {
    const plan = deriveResearchPlan(prompt)
    const past = assessPlannerGoals(plan, [], {
      grounded: { validClaims: [webClaim('Serenata en San Julián el 20 de enero de 2026', url)], package: {} },
    })
    assert.notEqual(past.find((g) => g.kind === 'event_discovery')!.status, 'RESOLVED')
    const next = assessPlannerGoals(plan, [], {
      grounded: { validClaims: [webClaim('Serenata en San Julián el 1 de octubre de 2026', url)], package: {} },
    })
    assert.equal(next.find((g) => g.kind === 'event_discovery')!.status, 'RESOLVED')
  })

  it('eventTiming: a range that started before today and is still running counts', () => {
    const w = { from: '2026-09-28', to: '2026-10-07' }
    assert.equal(eventTiming('Del 26 de septiembre al 7 de octubre', w), 'in_window')
    assert.equal(eventTiming('Del 18 de septiembre al 25 de septiembre', w), 'past')
    assert.equal(eventTiming('Feria del 12 de diciembre de 2026', w), 'outside')
    assert.equal(eventTiming('Serenata en la plaza', w), 'undated')
  })

  it('control: without dates in the prompt the previous semantics hold', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    assert.equal(plan.eventWindow, undefined)
  })
})

describe('P5 pending verification is filtered by place identity (cabef4a6)', () => {
  it('Tonatico (Estado de México) and San Miguel de Allende are never pending for Jalisco candidates', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    const trace = [
      search('serenata feria Totatiche 2026 fechas septiembre octubre', [TOTATICHE_HTML_HIT, TONATICO]),
      search('serenata feria San Miguel el Alto 2026 fechas', [ALLENDE]),
    ]
    const state = computePlannerState(plan, trace)
    const event = state.dimensions.find((d) => d.dimension === 'event')!
    assert.ok(event.pendingVerification.includes(TOTATICHE_HTML_HIT.url))
    assert.ok(!event.pendingVerification.includes(TONATICO.url))
    assert.ok(!event.pendingVerification.includes(ALLENDE.url))
    const excluded = new Map(event.excludedVerification.map((e) => [e.url, e.reason]))
    assert.match(excluded.get(TONATICO.url) ?? '', /another state: estado de mexico/)
    assert.match(excluded.get(ALLENDE.url) ?? '', /other than San Miguel el Alto/)

    const draft = toResearchOnlyDraft({}, researchReq(REAL_PROMPT_EXCERPT), {
      isNewTravel: true,
      goals: assessPlannerGoals(plan, trace),
      reasons: ['x'],
      validClaims: [],
      planner: { state, dimensions: plan.dimensions },
    })
    const narrative = String(draft.narrative)
    assert.match(narrative, /fetch pendiente\): https:\/\/www\.feriasenmexico\.com\.mx\/feria-totatiche/)
    assert.doesNotMatch(narrative, /tonatico/)
    assert.doesNotMatch(narrative, /allende/)
  })
})

describe('P6 no negative conclusion about a candidate that was never researched (cabef4a6)', () => {
  const modelWarnings = [
    'No se encontró evidencia verificable de serenatas futuras en San Julián, Jalostotitlán, Yahualica, Huejúcar ni Colotlán para el periodo solicitado.',
    'No se dispone de datos específicos de incidencia delictiva por municipio para Totatiche y San Miguel el Alto.',
    'No se pudo verificar la calidad de Wi-Fi en hospedajes ni detalles específicos de transporte terrestre.',
  ]
  const trace = [
    search('serenata feria Totatiche 2026', []),
    search('serenata feria San Miguel el Alto 2026', []),
    search('serenata feria San Julián 2026', []),
    search('serenata feria Jalostotitlán 2026', []),
    search('incidencia delictiva Totatiche Jalisco 2026', []),
    search('incidencia delictiva San Miguel el Alto 2026', []),
  ]

  it('drops the warning about Yahualica/Huejúcar/Colotlán, keeps warnings about researched ones', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    const state = computePlannerState(plan, trace)
    const draft = toResearchOnlyDraft({ warnings: modelWarnings }, researchReq(REAL_PROMPT_EXCERPT), {
      isNewTravel: true,
      goals: assessPlannerGoals(plan, trace),
      reasons: ['x'],
      validClaims: [],
      planner: { state, dimensions: plan.dimensions },
    })
    const warnings = draft.warnings as string[]
    assert.ok(!warnings.some((w) => /serenatas futuras/.test(w)))
    assert.ok(warnings.some((w) => /incidencia delictiva por municipio para Totatiche/.test(w)))
    assert.ok(warnings.some((w) => /Wi-Fi/.test(w)))
    assert.ok(
      warnings.some((w) =>
        /^server: .*candidatos que no se investigaron \(Yahualica, Huejúcar, Colotlán\)/.test(w),
      ),
    )
  })

  it('the rule is per dimension: researched in safety only ≠ researched for events', () => {
    const plan = deriveResearchPlan(REAL_PROMPT_EXCERPT)
    const state = computePlannerState(plan, [search('incidencia delictiva Colotlán 2026', [])])
    const out = filterUnresearchedNegativeWarnings(
      [
        'No hay datos de incidencia delictiva para Colotlán.',
        'No se encontró serenata en Colotlán.',
        'Colotlán podría encajar en la ruta.',
      ],
      state,
    )
    assert.ok(out.includes('No hay datos de incidencia delictiva para Colotlán.'))
    assert.ok(!out.includes('No se encontró serenata en Colotlán.'))
    assert.ok(out.includes('Colotlán podría encajar en la ruta.'), 'not a negative conclusion')
  })
})

// ---------------------------------------------------------------------------
// Depth-first event verification (bb3746c8): verify a candidate's promising
// source before spending discovery on further candidates.
// ---------------------------------------------------------------------------

describe('depth-first: verify the priority candidate before more discovery', () => {
  const prompt =
    'Hoy es lunes 28 de septiembre de 2026. Quiero asistir a una serenata entre hoy y el 7 de octubre de 2026. Compara los municipios Villa Alba, Bosque Bajo y Cerro Claro en Jalisco: incidencia delictiva y hospedaje. Si Cerro Claro tiene serenatas, verifícalas.'
  const A1 = 'https://cerro-claro.example/feria-2026'
  const A2 = 'https://noticias.example/cerro-claro-fiestas'
  const leadA = (url: string) => ({
    url,
    title: 'Feria Cerro Claro 2026',
    snippet: 'Serenata en Cerro Claro el 4 de octubre de 2026.',
  })
  const searchA = (sources: Array<{ url: string; title?: string; snippet?: string }>) =>
    search('serenata Cerro Claro octubre 2026', sources, { candidates: ['Cerro Claro'] })
  const unusable = (url: string): ToolTraceEntry => ({
    tool: 'fetchUrl',
    args: { url, quality: 'login_wall' },
    ok: false,
    sources: [],
    error: 'unusable: login_wall',
    checkedAt: '2026-09-28T18:01:00+00:00',
  })
  const searchB = { query: 'serenata Villa Alba octubre 2026' }

  it('A prioritario → search A → promising URL → fetch A before search B', () => {
    const plan = deriveResearchPlan(prompt)
    assert.deepEqual(plan.priorityCandidates, ['Cerro Claro'])
    const trace: ToolTraceEntry[] = [searchA([leadA(A1)])]

    assert.deepEqual(computePlannerState(plan, trace).verifyFirst, {
      candidate: 'Cerro Claro',
      urls: [A1],
    })
    const b = decide(plan, trace, 'webSearch', searchB)
    assert.equal(b.allow === false && b.reason, 'verify_candidate_first')
    assert.ok(b.allow === false && b.hint.includes(A1))
    // Its safety/lodging also wait until the critical event is verified.
    const safetyA = decide(plan, trace, 'webSearch', { query: 'incidencia delictiva Cerro Claro' })
    assert.equal(safetyA.allow === false && safetyA.reason, 'verify_candidate_first')

    const fetchA = decide(plan, trace, 'fetchUrl', { url: A1 })
    assert.equal(fetchA.allow, true)
    assert.equal(fetchA.allow && fetchA.phase, 'verification')
    trace.push(fetchOk(A1, 'Domingo 4 de octubre de 2026: serenata en la plaza de Cerro Claro.'))

    // Resolved → safety/lodging of A, then the other candidates.
    assert.equal(computePlannerState(plan, trace).verifyFirst, null)
    assert.equal(decide(plan, trace, 'webSearch', { query: 'incidencia delictiva Cerro Claro' }).allow, true)
    assert.equal(decide(plan, trace, 'webSearch', searchB).allow, true)
  })

  it('fetch A insufficient → next promising A source; once A is used up → search B', () => {
    const plan = deriveResearchPlan(prompt)
    const trace: ToolTraceEntry[] = [searchA([leadA(A1), leadA(A2)])]
    trace.push(fetchOk(A1, 'Bienvenidos al sitio del municipio.'))

    assert.deepEqual(computePlannerState(plan, trace).verifyFirst, {
      candidate: 'Cerro Claro',
      urls: [A2],
    })
    const b = decide(plan, trace, 'webSearch', searchB)
    assert.equal(b.allow === false && b.reason, 'verify_candidate_first')
    assert.equal(decide(plan, trace, 'fetchUrl', { url: A2 }).allow, true)
    trace.push(unusable(A2))

    assert.equal(computePlannerState(plan, trace).verifyFirst, null)
    assert.equal(decide(plan, trace, 'webSearch', searchB).allow, true)
  })

  it('per-candidate fetch budget: after 2 insufficient fetches of A, search B even if A has more sources', () => {
    const plan = deriveResearchPlan(prompt)
    const A3 = 'https://turismo.example/cerro-claro'
    const trace: ToolTraceEntry[] = [
      searchA([leadA(A1), leadA(A2), leadA(A3)]),
      fetchOk(A1, 'Bienvenidos al sitio del municipio.'),
      unusable(A2),
    ]
    assert.equal(computePlannerState(plan, trace).verifyFirst, null)
    assert.equal(decide(plan, trace, 'webSearch', searchB).allow, true)
  })

  it('search A without a promising source → search B right away', () => {
    const plan = deriveResearchPlan(prompt)
    const trace: ToolTraceEntry[] = [
      searchA([{ url: 'https://cerro-claro.example/', title: 'Cerro Claro', snippet: 'Historia del municipio.' }]),
    ]
    assert.equal(computePlannerState(plan, trace).verifyFirst, null)
    assert.equal(decide(plan, trace, 'webSearch', searchB).allow, true)
  })

  it('a lead about another place never triggers depth-first', () => {
    const plan = deriveResearchPlan(prompt)
    const trace: ToolTraceEntry[] = [
      searchA([
        {
          url: 'https://otro.example/cerro-claro-zacatecas',
          title: 'Feria Cerro Claro, Zacatecas 2026',
          snippet: 'Serenata en Cerro Claro el 4 de octubre de 2026.',
        },
      ]),
    ]
    assert.equal(computePlannerState(plan, trace).verifyFirst, null)
  })
})

describe('explicit event target: a feria never satisfies "serenata"', () => {
  const serenataAsk =
    'Hoy es lunes 28 de septiembre de 2026. Quiero una serenata entre hoy y el 7 de octubre de 2026. Compara los municipios Villa Alba, Bosque Bajo y Cerro Claro en Jalisco: incidencia delictiva y hospedaje. Si Cerro Claro tiene serenatas, verifícalas.'
  const genericAsk =
    'Hoy es lunes 28 de septiembre de 2026. Quiero encontrar una fiesta o evento entre hoy y el 7 de octubre de 2026. Compara los municipios Villa Alba, Bosque Bajo y Cerro Claro en Jalisco: incidencia delictiva y hospedaje. Si Cerro Claro tiene fiesta, verifícala.'
  const A1 = 'https://cerro-claro.example/feria-2026'
  const A2 = 'https://cerro-claro.example/programa'
  const FERIA = 'Feria Cerro Claro 2026 del 29 de septiembre al 7 de octubre en la plaza de Cerro Claro.'
  const SERENATA = 'Domingo 4 de octubre de 2026 — Serenata en la plaza de Cerro Claro.'
  const trace0 = () => [
    search(
      'serenata Cerro Claro octubre 2026',
      [
        { url: A1, title: 'Feria Cerro Claro 2026', snippet: FERIA },
        { url: A2, title: 'Programa Cerro Claro', snippet: FERIA },
      ],
      { candidates: ['Cerro Claro'] },
    ),
  ]
  const eventGoal = (plan: ResearchPlan, trace: ToolTraceEntry[], statement: string) =>
    assessPlannerGoals(plan, trace, {
      grounded: { validClaims: [webClaim(statement, A1)], package: {} },
    }).find((g) => g.kind === 'event_discovery')!.status

  it('target extraction: specific type kept; generic ask has none', () => {
    assert.equal(deriveResearchPlan(serenataAsk).eventTarget, 'serenata')
    assert.equal(deriveResearchPlan(genericAsk).eventTarget, undefined)
    assert.equal(extractEventTarget('quiero encontrar una fiesta/evento este fin de semana'), undefined)
  })

  it('ask "serenata" + verified "Feria … 2026" → event NOT resolved; a feria-only lead is not pending', () => {
    const plan = deriveResearchPlan(serenataAsk)
    const trace: ToolTraceEntry[] = [...trace0(), fetchOk(A1, FERIA)]
    const state = computePlannerState(plan, trace)
    assert.equal(state.verifyFirst, null)
    const event = state.dimensions.find((d) => d.dimension === 'event')!
    assert.equal(event.satisfied, false)
    assert.deepEqual(event.pendingVerification, [])
    assert.match(
      event.excludedVerification.find((e) => e.url === A2)?.reason ?? '',
      /no mention of the target event \(serenata\)/,
    )
    assert.notEqual(eventGoal(plan, trace, FERIA), 'RESOLVED')
    // The feria stays useful context (promising evidence), not a verdict.
    assert.equal(state.candidates.find((c) => c.name === 'Cerro Claro')!.cells.event, 'supported')
  })

  it('ask "serenata" + "Domingo 4 de octubre — Serenata…" → verified; verifyFirst released', () => {
    const plan = deriveResearchPlan(serenataAsk)
    const trace: ToolTraceEntry[] = [...trace0(), fetchOk(A1, SERENATA)]
    assert.equal(computePlannerState(plan, trace).verifyFirst, null)
    assert.equal(eventGoal(plan, trace, SERENATA), 'RESOLVED')
  })

  it('generic ask + compatible feria evidence → current behavior (feria resolves)', () => {
    const plan = deriveResearchPlan(genericAsk)
    const trace: ToolTraceEntry[] = [...trace0(), fetchOk(A1, FERIA)]
    assert.equal(computePlannerState(plan, trace).verifyFirst, null)
    assert.equal(eventGoal(plan, trace, FERIA), 'RESOLVED')
  })
})

describe('prompt candidates: states, regions and exclusion mentions (6d70789e)', () => {
  it('states, the country and regions are never candidates', () => {
    assert.deepEqual(
      extractPromptCandidates('Compara los municipios Villa Alba, Jalisco, Bosque Bajo, Zacatecas y México'),
      ['Villa Alba', 'Bosque Bajo'],
    )
    assert.deepEqual(
      extractPromptCandidates('Compara Villa Alba, Bosque Bajo, Los Altos y Zona Norte'),
      ['Villa Alba', 'Bosque Bajo'],
    )
  })

  it('places named only to exclude/disambiguate are never candidates', () => {
    assert.deepEqual(
      extractPromptCandidates(
        'Compara los pueblos Villa Alba y Bosque Bajo (no confundir con Villa Albana, Bosque Alto o Monte Alba, Estado de México).',
      ),
      ['Villa Alba', 'Bosque Bajo'],
    )
    assert.deepEqual(
      extractPromptCandidates(
        'Compara Villa Alba, Bosque Bajo y Cerro Claro. No son Loma Seca, Río Seco o Monte Bajo, que están en otro estado.',
      ),
      ['Villa Alba', 'Bosque Bajo', 'Cerro Claro'],
    )
    assert.deepEqual(
      extractPromptCandidates(
        'Compara los pueblos Villa Alba, Jalisco y Bosque Bajo, Jalisco (no confundir con Villa Albana ni Bosque Alto, Estado de México)',
      ),
      ['Villa Alba', 'Bosque Bajo'],
    )
  })

  it('control: "no te limites a X" still keeps X', () => {
    assert.ok(deriveResearchPlan(REAL_PROMPT_EXCERPT).promptCandidates.includes('San Miguel el Alto'))
  })
})

describe('eventTiming: an explicit year outside the window never counts (6d70789e)', () => {
  const w = { from: '2026-10-04', to: '2026-10-08' }

  it('7 octubre 2019 vs window October 2026 → out of window', () => {
    assert.equal(
      eventTiming('Evidencia histórica de la serenata y vueltas en la plaza el 7 de octubre en Totatiche en 2019.', w),
      'past',
    )
    assert.equal(eventTiming('Serenata el 7 de octubre de 2019', w), 'past')
    assert.equal(eventTiming('7 de Octubre del 2019. Fotos del cierre de Feria, serenata', w), 'past')
  })

  it('7 octubre 2026 vs window October 2026 → in window', () => {
    assert.equal(eventTiming('Serenata el 7 de octubre de 2026', w), 'in_window')
    assert.equal(eventTiming('Feria Regional 2026 del 29 de septiembre al 7 de octubre', w), 'in_window')
  })

  it('a date without a year keeps the current semantics', () => {
    assert.equal(eventTiming('Serenata el 7 de octubre', w), 'in_window')
  })
})

describe('regression 6d70789e: historical edition + exclusion mentions', () => {
  const prompt =
    'Hoy es lunes 28 de septiembre de 2026. Quiero asistir a la serenata tradicional de Villa Alba, Jalisco, del 4 al 8 de octubre de 2026. Compara los pueblos Villa Alba y Bosque Bajo (no confundir con Villa Albana, Bosque Alto o Monte Alba, Estado de México): hospedaje y cómo llegar en autobús. Si Villa Alba tiene serenata, verifícala.'
  const URL_2019 = 'https://www.villa-alba.example/Eventos/2019/fiestas_octubre2019/7OctNoche2019.php'
  const trace: ToolTraceEntry[] = [
    search(
      'serenata tradicional 7 octubre 2026 Villa Alba Jalisco fiestas patronales',
      [{ url: URL_2019, title: '7 Octubre Noche - Villa Alba Jalisco', snippet: 'Fotos del cierre de Feria, serenata, bandas, mucha fiesta y música.' }],
      { candidates: ['Villa Alba'] },
    ),
    {
      tool: 'fetchUrl',
      args: { url: URL_2019, httpStatus: 200, quality: 'usable', passages: 3 },
      ok: true,
      sources: [
        { url: URL_2019, title: 'Villa Alba Jalisco', snippet: '7 de Octubre del 2019. Fotos del cierre de Feria, serenata, bandas, mucha fiesta y música.' },
        { url: URL_2019, title: 'Villa Alba Jalisco', snippet: 'Se parte de la Feria, vuelta a la plaza por ahí de las 9:30 de la noche' },
        { url: URL_2019, title: 'Villa Alba Jalisco', snippet: 'Última vuelta a la plaza en esta Feria Villa Alba 2019. Cerramos así la cobertura.' },
      ],
      checkedAt: '2026-09-28T18:01:00+00:00',
    },
  ]
  const statement = 'Evidencia histórica de la serenata y vueltas en la plaza el 7 de octubre en Villa Alba en 2019.'

  it('the historical claim grounds, but event_discovery is NOT resolved by it', () => {
    const plan = deriveResearchPlan(prompt)
    assert.deepEqual(plan.eventWindow, { from: '2026-09-28', to: '2026-10-08' })
    assert.equal(plan.eventTarget, 'serenata')
    const grounded = validateClaimsAgainstToolTrace(
      [{ kind: 'other_factual', statement, sourceType: 'web', sourceUrl: URL_2019, evidenceIndex: 1, verificationStatus: 'verified', confidence: 'high' }],
      trace,
    )
    assert.equal(grounded.valid.length, 1, JSON.stringify(grounded.invalid))
    const goals = assessPlannerGoals(plan, trace, { grounded: { validClaims: grounded.valid, package: {} } })
    assert.notEqual(goals.find((g) => g.kind === 'event_discovery')!.status, 'RESOLVED')
    const state = computePlannerState(plan, trace)
    assert.notEqual(state.candidates.find((c) => c.name === 'Villa Alba')!.cells.event, 'supported')
    assert.equal(state.dimensions.find((d) => d.dimension === 'event')!.satisfied, false)
  })

  it('the correct candidate stays; exclusion mentions never enter destination_selection', () => {
    const plan = deriveResearchPlan(prompt)
    assert.deepEqual(plan.promptCandidates, ['Villa Alba', 'Bosque Bajo'])
    assert.deepEqual(plan.priorityCandidates, ['Villa Alba'])
    const dest = plan.goals.find((g) => g.kind === 'destination_selection')!
    for (const name of ['Villa Albana', 'Bosque Alto', 'Monte Alba', 'México', 'Jalisco']) {
      assert.ok(!dest.label.includes(name), `${name} in ${dest.label}`)
      assert.ok(!computePlannerState(plan, trace).candidates.some((c) => c.name === name))
    }
  })
})

const FIXED_TARGET_PROMPT =
  'Hoy es 28 de septiembre de 2026. Quiero asistir a la serenata de Cerro Claro, Jalisco, del 4 al 8 de octubre de 2026. Vuelo MEX-GDL.'
const flightArgs = { origin: 'MEX', destination: 'GDL', date: '2026-10-04' }

describe('fixed destination + target event: event first, target governs (9479adfc)', () => {
  const A1 = 'https://cerro-claro.example/feria-2026'
  const A2 = 'https://cerro-claro.example/programa'
  const FERIA = 'Feria Cerro Claro 2026 del 29 de septiembre al 7 de octubre en la plaza de Cerro Claro.'
  const SERENATA = 'Domingo 4 de octubre de 2026 — Serenata en la plaza de Cerro Claro.'
  const eventSearch = () =>
    search('serenata Cerro Claro octubre 2026', [
      { url: A1, title: 'Feria Cerro Claro 2026', snippet: FERIA },
      { url: A2, title: 'Programa Cerro Claro', snippet: FERIA },
    ])

  it('the explicit target governs: a verified feria does not resolve "serenata"', () => {
    const plan = deriveResearchPlan(FIXED_TARGET_PROMPT)
    const trace: ToolTraceEntry[] = [eventSearch(), fetchOk(A1, FERIA)]
    const state = computePlannerState(plan, trace)
    assert.equal(state.dimensions.find((d) => d.dimension === 'event')!.satisfied, false)
    assert.equal(state.verifyFirst, null)
    assert.equal(nextRequiredResearchAction(plan, state)?.type, 'SEARCH_EVENT')
    const goals = assessPlannerGoals(plan, trace, {
      grounded: { validClaims: [webClaim(FERIA, A1)], package: {} },
    })
    assert.notEqual(goals.find((g) => g.kind === 'event_discovery')!.status, 'RESOLVED')
    assert.equal(decide(plan, trace, 'searchFlightSchedules', flightArgs).allow, false)

    const done: ToolTraceEntry[] = [eventSearch(), fetchOk(A1, SERENATA)]
    assert.equal(computePlannerState(plan, done).dimensions.find((d) => d.dimension === 'event')!.satisfied, true)
  })

  it('order: event search → promising source → fetch, and only then flights', () => {
    const plan = deriveResearchPlan(FIXED_TARGET_PROMPT)
    const empty: ToolTraceEntry[] = []
    const early = decide(plan, empty, 'searchFlightSchedules', flightArgs)
    assert.equal(early.allow === false && early.reason, 'deferred_by_dependency')
    assert.equal(decide(plan, empty, 'webSearch', { query: 'serenata Cerro Claro octubre 2026' }).allow, true)

    const trace: ToolTraceEntry[] = [
      search('serenata Cerro Claro octubre 2026', [
        { url: A1, title: 'Serenata Cerro Claro 2026', snippet: SERENATA },
        { url: A2, title: 'Programa Cerro Claro', snippet: SERENATA },
      ]),
    ]
    assert.deepEqual(computePlannerState(plan, trace).verifyFirst, { candidate: 'Cerro Claro', urls: [A1, A2] })
    assert.equal(decide(plan, trace, 'searchFlightSchedules', flightArgs).allow, false)
    assert.equal(decide(plan, trace, 'fetchUrl', { url: A1 }).allow, true)

    trace.push(fetchOk(A1, SERENATA))
    assert.equal(decide(plan, trace, 'searchFlightSchedules', flightArgs).allow, true)
  })
})

describe('schedule provenance URLs are flight sources, never fetch suggestions (9479adfc)', () => {
  const provenance = (i: number) =>
    `https://aerodatabox.com/?origin=MEX&destination=GDL&date=2026-10-04&flight=AM%20${230 + i}`
  const schedules8 = (): ToolTraceEntry => ({
    tool: 'searchFlightSchedules',
    args: flightArgs,
    ok: true,
    sources: Array.from({ length: 8 }, (_, i) => ({
      url: provenance(i),
      title: `MEX → GDL 2026-10-04 AM ${230 + i}`,
      snippet: `Aeroméxico AM ${230 + i} MEX → GDL 2026-10-04 salida 0${i}:15 llegada 0${i + 1}:40`,
    })),
    checkedAt: '2026-09-28T18:00:00+00:00',
  })
  const EVENT_URL = 'https://www.facebook.com/cerroclaro/videos/serenata-2026'
  const eventHit = () =>
    search('serenata Cerro Claro octubre 2026', [
      {
        url: EVENT_URL,
        title: 'Serenata Cerro Claro 2026',
        snippet: 'Serenata en Cerro Claro el 4 de octubre de 2026 en la plaza principal.',
      },
    ])
  const legacyPrompt = 'Vuelo MEX-GDL 4 de octubre 2026 y serenata en Cerro Claro'
  const legacyNudge = (trace: ToolTraceEntry[]) =>
    buildDirectedResearchNudge({
      goals: deriveResearchGoals(legacyPrompt),
      toolTrace: trace,
      tripDates: ['2026-10-04'],
      prompt: legacyPrompt,
    })

  it('the provenance URL can still be the flight sourceUrl (anchored)', () => {
    const trace = [schedules8()]
    const pkg = {
      travelOptions: [
        { type: 'flight', sourceType: 'flight_schedule', verificationStatus: 'estimated', sourceUrl: provenance(0) },
      ],
    }
    assert.equal(anchoredSourceCount(pkg), 1)
    const diag = buildResearchDiagnostics({
      goals: deriveResearchGoals(legacyPrompt),
      toolTrace: trace,
      toolRounds: 1,
      toolCallsUsed: 1,
      maxToolCalls: 6,
      forcedExtraRounds: 0,
      package: pkg,
      tripDates: ['2026-10-04'],
    })
    assert.equal(diag.candidates.find((c) => c.url === provenance(0))?.reason, 'accepted_anchor')
  })

  it('never listed as promising / to fetch (legacy nudge) nor pending verification (planner)', () => {
    const nudge = legacyNudge([schedules8()])
    for (let i = 0; i < 8; i++) assert.ok(!nudge.includes(provenance(i)), nudge)

    const plan = deriveResearchPlan(FIXED_TARGET_PROMPT)
    const state = computePlannerState(plan, [schedules8()])
    for (const d of state.dimensions) {
      assert.ok(!d.pendingVerification.some((u) => u.includes('aerodatabox')), d.dimension)
    }
    assert.equal(state.verifyFirst, null)
  })

  it('a real webSearch URL stays verifiable', () => {
    const emptySchedules: ToolTraceEntry = { ...schedules8(), sources: [] }
    assert.ok(legacyNudge([emptySchedules, eventHit()]).includes(EVENT_URL))
    const plan = deriveResearchPlan(FIXED_TARGET_PROMPT)
    assert.deepEqual(computePlannerState(plan, [eventHit()]).verifyFirst?.urls, [EVENT_URL])
  })

  it('8 provenance URLs + 1 real event URL → the event URL is not displaced', () => {
    const trace = [schedules8(), eventHit()]
    const nudge = legacyNudge(trace)
    assert.ok(nudge.includes(EVENT_URL), nudge)
    assert.ok(!nudge.includes('aerodatabox.com'), nudge)

    const plan = deriveResearchPlan(FIXED_TARGET_PROMPT)
    const state = computePlannerState(plan, trace)
    assert.deepEqual(state.verifyFirst, { candidate: 'Cerro Claro', urls: [EVENT_URL] })
    assert.deepEqual(state.dimensions.find((d) => d.dimension === 'event')!.pendingVerification, [EVENT_URL])
  })
})

describe('deferred_by_dependency tells the model the event action to do now (9153aadd)', () => {
  const L1 = 'https://cerro-claro.example/feria-2026'
  const L2 = 'https://noticias.example/cerro-claro-fiestas'
  const L3 = 'https://turismo.example/cerro-claro'
  const OTHER = 'https://otro.example/cerro-claro-zacatecas'
  const lead = (url: string) => ({
    url,
    title: 'Feria Cerro Claro 2026',
    snippet: 'Serenatas en las fiestas de Cerro Claro del 29 de septiembre al 7 de octubre de 2026.',
  })
  const eventSearch = (sources: Array<{ url: string; title?: string; snippet?: string }>) =>
    search('serenata Cerro Claro octubre 2026', sources)
  const laterLevel = [
    ['webSearch', { query: 'hospedaje Cerro Claro Jalisco' }],
    ['webSearch', { query: 'autobús Guadalajara Cerro Claro' }],
    ['searchFlightSchedules', flightArgs],
  ] as const
  const unusable = (url: string): ToolTraceEntry => ({
    tool: 'fetchUrl',
    args: { url, quality: 'js_required' },
    ok: false,
    sources: [],
    error: 'unusable: js_required',
    checkedAt: '2026-09-28T18:01:00+00:00',
  })

  it('verifyFirst active: later-level calls stay deferred and the hint names the eligible fetchUrl URLs only', () => {
    const plan = deriveResearchPlan(FIXED_TARGET_PROMPT)
    const trace: ToolTraceEntry[] = [
      eventSearch([
        lead(L1),
        lead(L2),
        lead(L3),
        { url: OTHER, title: 'Feria Cerro Claro, Zacatecas 2026', snippet: 'Serenata en Cerro Claro el 4 de octubre de 2026.' },
      ]),
      schedules(),
    ]
    assert.deepEqual(computePlannerState(plan, trace).verifyFirst, { candidate: 'Cerro Claro', urls: [L1, L2, L3] })
    for (const [tool, args] of laterLevel) {
      const d = decide(plan, trace, tool, args)
      assert.equal(d.allow, false, tool)
      assert.equal(d.allow === false && d.reason, 'deferred_by_dependency', tool)
      const hint = d.allow === false ? d.hint : ''
      assert.ok(hint.includes(`Depth-first: verify Cerro Claro now with fetchUrl ${L1} ${L2} ${L3}.`), hint)
      assert.ok(!hint.includes(OTHER), hint)
      assert.ok(!hint.includes('aerodatabox'), hint)
    }
  })

  it('no verifyFirst but pending event verification: the hint asks fetchUrl of the pending URL', () => {
    const plan = deriveResearchPlan(FIXED_TARGET_PROMPT)
    const trace: ToolTraceEntry[] = [
      eventSearch([lead(L1), lead(L2), lead(L3)]),
      fetchOk(L1, 'Bienvenidos al sitio del municipio.'),
      unusable(L2),
    ]
    const state = computePlannerState(plan, trace)
    assert.equal(state.verifyFirst, null)
    assert.deepEqual(state.dimensions.find((d) => d.dimension === 'event')!.pendingVerification, [L3])
    const d = decide(plan, trace, 'webSearch', { query: 'hospedaje Cerro Claro Jalisco' })
    assert.equal(d.allow === false && d.reason, 'deferred_by_dependency')
    const hint = d.allow === false ? d.hint : ''
    assert.ok(hint.includes(`Do this now: fetchUrl ${L3} to verify the event.`), hint)
    assert.ok(!hint.includes(L1) && !hint.includes(L2), hint)
  })

  it('no pending URLs but event discovery left: the hint asks webSearch for the target event and candidate', () => {
    const plan = deriveResearchPlan(FIXED_TARGET_PROMPT)
    const trace: ToolTraceEntry[] = [
      eventSearch([{ url: 'https://cerro-claro.example/', title: 'Cerro Claro', snippet: 'Historia del municipio.' }]),
    ]
    const d = decide(plan, trace, 'webSearch', { query: 'hospedaje Cerro Claro Jalisco' })
    assert.equal(d.allow === false && d.reason, 'deferred_by_dependency')
    const hint = d.allow === false ? d.hint : ''
    assert.ok(hint.includes('Do this now: webSearch for the serenata in Cerro Claro dated between'), hint)
    assert.ok(hint.includes('(event discovery 1/3)'), hint)
    assert.ok(!hint.includes('fetchUrl'), hint)
  })

  it('event research used up: no instruction to keep researching it', () => {
    const plan = deriveResearchPlan(`${FIXED_TARGET_PROMPT} Hospedaje en el centro.`)
    const trace: ToolTraceEntry[] = [1, 2, 3, 4].map((i) =>
      search(`serenata Cerro Claro octubre 2026 ${i}`, []),
    )
    const state = computePlannerState(plan, trace)
    assert.equal(state.dimensions.find((d) => d.dimension === 'event')!.exhausted, true)
    const d = decide(plan, trace, 'searchFlightSchedules', flightArgs)
    assert.equal(d.allow === false && d.reason, 'deferred_by_dependency')
    const hint = d.allow === false ? d.hint : ''
    assert.ok(!hint.includes('Do this now'), hint)
    assert.ok(!hint.includes('webSearch for the'), hint)
  })

  it('regression: verify_candidate_first keeps its exact behavior and hint', () => {
    const plan = deriveResearchPlan(FIXED_TARGET_PROMPT)
    const trace: ToolTraceEntry[] = [eventSearch([lead(L1)])]
    const d = decide(plan, trace, 'webSearch', { query: 'serenata Cerro Claro programa 2026' })
    assert.deepEqual(d, {
      allow: false,
      level: 0,
      reason: 'verify_candidate_first',
      hint: `Verify Cerro Claro before more discovery: fetchUrl ${L1} (a discovered event source may resolve the critical requirement). If it does not, the next source or candidate follows.`,
    })
    assert.equal(decide(plan, trace, 'fetchUrl', { url: L1 }).allow, true)
  })
})

describe('forced event routing + relevant leads (b24430d9)', () => {
  const PROMPT =
    'Hoy es 28 de septiembre de 2026. Quiero asistir a la procesión de Villa Alba, Jalisco, del 6 al 8 de octubre de 2026. Hospedaje en el centro y vuelo MEX-GDL.'
  const SOC1 = 'https://www.instagram.com/p/VillaAlbaProcesion'
  const FERIA_2019 = 'https://villa-alba.example/Eventos/2019/feria'
  const HIST_2019 = 'https://villa-alba.example/index.php?id=12'
  const SOC2 = 'https://www.facebook.com/villaalba/posts/77'
  const HOME = 'https://villa-alba.example/'
  const firstSearch = () =>
    search('procesión Villa Alba octubre 2026', [
      { url: SOC1, title: 'Procesión Villa Alba 2026', snippet: 'Procesión de Villa Alba el 7 de octubre de 2026.' },
      {
        url: FERIA_2019,
        title: 'Feria Villa Alba',
        snippet: 'Fiestas de Villa Alba del 29 de septiembre al 7 de octubre en la plaza.',
      },
      {
        url: HIST_2019,
        title: 'Fiestas Octubre 2019 - Villa Alba',
        snippet: 'Del 29 de septiembre al 7 de octubre. La procesión de Villa Alba recorre el centro.',
      },
      { url: SOC2, title: 'Villa Alba', snippet: 'Procesión Villa Alba 2026 el 7 de octubre por la tarde.' },
      { url: HOME, title: 'Villa Alba — Gobierno municipal', snippet: 'Avisos de las fiestas 2026 de Villa Alba.' },
    ])
  const unusable = (url: string): ToolTraceEntry => ({
    tool: 'fetchUrl',
    args: { url, quality: 'js_required' },
    ok: false,
    sources: [],
    error: 'unusable: js_required',
    checkedAt: '2026-09-28T18:01:00+00:00',
  })
  const planFor = (prompt = PROMPT) => {
    const plan = deriveResearchPlan(prompt)
    plan.eventWindow = { from: '2026-10-06', to: '2026-10-08' }
    return plan
  }
  const event = (state: ReturnType<typeof computePlannerState>) =>
    state.dimensions.find((d) => d.dimension === 'event')!
  const lodging = { query: 'hospedaje Villa Alba centro' }
  const ground = { query: 'autobús Guadalajara Villa Alba' }
  const flight = { origin: 'MEX', destination: 'GDL', date: '2026-10-06' }

  it('real case: 2019 and target-less pages never become leads; only the target leads are verified', () => {
    const plan = planFor()
    assert.equal(plan.eventTarget, 'procesion')
    const state = computePlannerState(plan, [firstSearch()])
    assert.deepEqual(state.verifyFirst, { candidate: 'Villa Alba', urls: [SOC1, SOC2] })
    const excluded = new Map(event(state).excludedVerification.map((e) => [e.url, e.reason]))
    assert.match(excluded.get(FERIA_2019) ?? '', /edition 2019/)
    assert.match(excluded.get(HIST_2019) ?? '', /edition 2019/)
    assert.match(excluded.get(HOME) ?? '', /no mention of the target event \(procesion\)/)
    const only2019 = computePlannerState(plan, [
      search('procesión Villa Alba octubre', firstSearch().sources!.filter((s) => /2019|index\.php/.test(`${s.url} ${s.title}`))),
    ])
    assert.equal(only2019.hasEventEvidence, false, '2019 pages are no evidence for 2026')
    assert.equal(only2019.verifyFirst, null)
    assert.deepEqual(event(only2019).pendingVerification, [])
    assert.deepEqual(nextRequiredResearchAction(plan, state), {
      type: 'VERIFY_EVENT',
      candidate: 'Villa Alba',
      eligibleUrls: [SOC1, SOC2],
      reason: 'verify_first',
    })
  })

  it('real case: after the useless leads, a NEW event search is required before lodging/transport/flights', () => {
    const plan = planFor()
    const trace: ToolTraceEntry[] = [firstSearch(), unusable(SOC1)]
    assert.deepEqual(nextRequiredResearchAction(plan, computePlannerState(plan, trace)), {
      type: 'VERIFY_EVENT',
      candidate: 'Villa Alba',
      eligibleUrls: [SOC2],
      reason: 'verify_first',
    })
    trace.push(unusable(SOC2))
    const state = computePlannerState(plan, trace)
    assert.equal(state.verifyFirst, null)
    assert.deepEqual(event(state).pendingVerification, [])
    assert.ok(!event(state).pendingVerification.includes(SOC1), 'js_required URL never returns')
    const action = nextRequiredResearchAction(plan, state)
    assert.equal(action?.type, 'SEARCH_EVENT')
    assert.equal(action?.candidate, 'Villa Alba')
    assert.equal(action?.type === 'SEARCH_EVENT' && action.targetEvent, 'procesion')
    assert.deepEqual(action?.type === 'SEARCH_EVENT' && action.dateWindow, { from: '2026-10-06', to: '2026-10-08' })
    assert.equal(decide(plan, trace, 'webSearch', lodging).allow, false)
    assert.equal(decide(plan, trace, 'webSearch', ground).allow, false)
    assert.equal(decide(plan, trace, 'searchFlightSchedules', flight).allow, false)
    const second = decide(plan, trace, 'webSearch', { query: 'procesión Villa Alba 7 octubre 2026 programa' })
    assert.equal(second.allow, true)
    assert.equal(second.allow && second.phase, 'discovery')
  })

  it('year: URL path, title and "en 2019" / "del 2019" mark another edition; a range never inherits 2026', () => {
    const w = { from: '2026-10-06', to: '2026-10-08' }
    assert.equal(otherEditionYear({ url: FERIA_2019, snippet: 'Del 29 de septiembre al 7 de octubre' }, w), 2019)
    assert.equal(otherEditionYear({ url: HIST_2019, title: 'Fiestas Octubre 2019' }, w), 2019)
    assert.equal(otherEditionYear({ snippet: 'La procesión fue el 7 de octubre y reunió a miles en 2019.' }, w), 2019)
    assert.equal(otherEditionYear({ snippet: 'Procesión: 7 de Octubre del 2019.' }, w), 2019)
    assert.equal(otherEditionYear({ title: 'Procesión 2026', snippet: 'Crónica de la edición 2019.' }, w), null)
    assert.equal(otherEditionYear({ snippet: 'Procesión el 7 de octubre en el centro.' }, w), null)
  })

  it('control: a 2026 page naming the target is a lead', () => {
    const plan = planFor()
    const url = 'https://villa-alba.example/procesion-2026'
    const state = computePlannerState(plan, [
      search('procesión Villa Alba 2026', [
        { url, title: 'Procesión Villa Alba 2026', snippet: 'La procesión de Villa Alba será el 7 de octubre de 2026.' },
      ]),
    ])
    assert.deepEqual(state.verifyFirst, { candidate: 'Villa Alba', urls: [url] })
  })

  it('control: a page without a year and without conflict keeps the existing semantics', () => {
    const plan = planFor()
    const url = 'https://villa-alba.example/procesion'
    const state = computePlannerState(plan, [
      search('procesión Villa Alba', [
        { url, title: 'Procesión de Villa Alba', snippet: 'La procesión de Villa Alba recorre el centro el 7 de octubre.' },
      ]),
    ])
    assert.deepEqual(state.verifyFirst, { candidate: 'Villa Alba', urls: [url] })
  })

  it('control: useful social HTML stays eligible and verifies the event', () => {
    const plan = planFor()
    const trace: ToolTraceEntry[] = [
      firstSearch(),
      fetchOk(SOC1, 'Procesión de Villa Alba el 7 de octubre de 2026 a las 18:00.'),
    ]
    const state = computePlannerState(plan, trace)
    assert.equal(event(state).satisfied, true)
    assert.equal(nextRequiredResearchAction(plan, state), null)
  })

  it('control: a resolved event releases lodging and transport', () => {
    const plan = planFor()
    const trace: ToolTraceEntry[] = [
      firstSearch(),
      fetchOk(SOC1, 'Procesión de Villa Alba el 7 de octubre de 2026 a las 18:00.'),
    ]
    assert.equal(decide(plan, trace, 'webSearch', lodging).allow, true)
  })

  it('control: an exhausted event releases the next level', () => {
    const plan = planFor()
    const trace: ToolTraceEntry[] = [1, 2, 3, 4].map((i) => search(`procesión Villa Alba octubre 2026 ${i}`, []))
    const state = computePlannerState(plan, trace)
    assert.equal(event(state).exhausted, true)
    assert.equal(nextRequiredResearchAction(plan, state), null)
    assert.equal(decide(plan, trace, 'webSearch', lodging).allow, true)
  })

  it('control: without a target event, generic event research keeps working', () => {
    const genericAsk =
      'Hoy es lunes 28 de septiembre de 2026. Quiero encontrar una fiesta o evento entre hoy y el 7 de octubre de 2026. Compara los municipios Villa Alba, Bosque Bajo y Cerro Claro en Jalisco: incidencia delictiva y hospedaje. Si Cerro Claro tiene fiesta, verifícala.'
    const plan = deriveResearchPlan(genericAsk)
    assert.equal(plan.eventTarget, undefined)
    const A1 = 'https://cerro-claro.example/feria-2026'
    const state = computePlannerState(plan, [
      search('fiestas Cerro Claro octubre 2026', [
        { url: A1, title: 'Feria Cerro Claro 2026', snippet: 'Feria Cerro Claro 2026 del 29 de septiembre al 7 de octubre.' },
      ]),
    ])
    assert.deepEqual(state.verifyFirst, { candidate: 'Cerro Claro', urls: [A1] })
    assert.equal(nextRequiredResearchAction(plan, state)?.type, 'VERIFY_EVENT')
  })

  it('no forcing outside multi-objective event research', () => {
    const plan = deriveResearchPlan('Vuelo MEX-GDL el 4 de octubre de 2026.')
    assert.equal(nextRequiredResearchAction(plan, computePlannerState(plan, [])), null)
  })
})

describe('unproductive event line closes; the rest of the trip is researched (e8dfc667)', () => {
  const PROMPT =
    'Quiero asistir a la serenata de las fiestas de Villa Alba, Jalisco, el 7 de octubre de 2026. Viajo desde CDMX del 6 al 8 de octubre de 2026. Si Villa Alba tiene serenata, verifícala. Busca hospedaje en Villa Alba, transporte terrestre desde Guadalajara y vuelo MEX-GDL.'
  const SOCIAL = 'https://www.instagram.com/reel/VillaAlbaFeria2026'
  const OLD = 'https://villa-alba.example/Eventos/2019/serenata.php'
  const firstSearch = () =>
    search('serenata fiestas Villa Alba 7 de octubre 2026', [
      { url: SOCIAL, title: 'Villa Alba 2026', snippet: 'Feria de Villa Alba del 26 de septiembre al 7 de octubre de 2026. Serenata 10:00 PM.' },
      { url: OLD, title: 'Villa Alba', snippet: '7 de Octubre del 2019. Serenata y bandas en la plaza de Villa Alba.' },
      { url: 'https://villa-alba.example/', title: 'Villa Alba', snippet: 'Fiesta en la Sementera 11 de octubre 2025.' },
    ])
  const junkSearch = (q = 'Feria Regional Villa Alba Jalisco octubre 2026') =>
    search(q, [
      { url: 'https://directorio.example/villa-alba-cerveza', title: 'Comercio en Villa Alba', snippet: 'Comercio al por menor en Villa Alba.' },
      { url: SOCIAL, title: 'Villa Alba 2026', snippet: 'Feria de Villa Alba del 26 de septiembre al 7 de octubre de 2026. Serenata 10:00 PM.' },
    ])
  const walled = (url: string): ToolTraceEntry => ({
    tool: 'fetchUrl',
    args: { url, quality: 'js_required' },
    ok: false,
    sources: [],
    error: 'unusable: js_required',
    checkedAt: '2026-09-28T18:01:00+00:00',
  })
  const event = (plan: ResearchPlan, trace: ToolTraceEntry[]) =>
    computePlannerState(plan, trace).dimensions.find((d) => d.dimension === 'event')!
  const flightArgs6 = { origin: 'MEX', destination: 'GDL', date: '2026-10-06' }

  it('the user fixed destination and dates: the event is researched first but does not gate the package', () => {
    const plan = deriveResearchPlan(PROMPT)
    assert.deepEqual(plan.promptCandidates, ['Villa Alba'])
    const goal = plan.goals.find((g) => g.kind === 'event_discovery')!
    assert.equal(goal.tier, 'critical')
    assert.equal(goal.decisionCritical, false)
    assert.equal(nextRequiredResearchAction(plan, computePlannerState(plan, []))?.type, 'SEARCH_EVENT')
  })

  it('the event still gates when destination or dates depend on it', () => {
    const openDate = deriveResearchPlan(
      'Quiero ir a la próxima serenata de Villa Alba, Jalisco. Busca hospedaje y vuelo MEX-GDL.',
    )
    assert.equal(openDate.goals.find((g) => g.kind === 'event_discovery')!.decisionCritical, true)
    const compare = deriveResearchPlan(MULTI_PROMPT)
    assert.equal(compare.goals.find((g) => g.kind === 'event_discovery')!.decisionCritical, true)
  })

  it('real case: lead → wall → a reformulated search with nothing new closes the event line after 3 calls', () => {
    const plan = deriveResearchPlan(PROMPT)
    const trace: ToolTraceEntry[] = [firstSearch()]
    assert.deepEqual(event(plan, trace).pendingVerification, [SOCIAL], 'the 2019 page and the homepage are no leads')
    trace.push(walled(SOCIAL))
    assert.equal(nextRequiredResearchAction(plan, computePlannerState(plan, trace))?.type, 'SEARCH_EVENT')
    trace.push(junkSearch())
    const ev = event(plan, trace)
    assert.equal(ev.stalled, true)
    assert.equal(ev.exhausted, true)
    assert.equal(ev.attempts, 2, 'closed before the discovery limit')
    const state = computePlannerState(plan, trace)
    assert.equal(nextRequiredResearchAction(plan, state), null)
    assert.equal(state.minOpenLevel, 1)
    assert.equal(decide(plan, trace, 'webSearch', { query: 'hospedaje Villa Alba' }).allow, true)
    assert.equal(decide(plan, trace, 'webSearch', { query: 'autobús Guadalajara Villa Alba' }).allow, true)
    assert.equal(decide(plan, trace, 'searchFlightSchedules', flightArgs6).allow, false, 'flights after lodging/transport')
    const again = decide(plan, trace, 'webSearch', { query: 'serenata Villa Alba programa oficial 2026' })
    assert.equal(again.allow, false)
    assert.equal(again.allow === false && again.reason, 'discovery_budget_exhausted')
    assert.match(again.allow === false ? again.hint : '', /no new usable source/)
  })

  it('a closed event line does not spend more calls verifying non-leads', () => {
    const plan = deriveResearchPlan(PROMPT)
    const trace: ToolTraceEntry[] = [firstSearch(), walled(SOCIAL), junkSearch()]
    const d = decide(plan, trace, 'fetchUrl', { url: OLD })
    assert.equal(d.allow === false && d.reason, 'research_line_closed')
    assert.equal(toolCallOutcome(skipped('fetchUrl', 'research_line_closed')), 'planner_blocked')
  })

  it('a search that repeats known URLs is unproductive; one with a new lead keeps the line open', () => {
    const plan = deriveResearchPlan(PROMPT)
    const NEW = 'https://noticias.example/villa-alba-serenata-2026'
    const productive: ToolTraceEntry[] = [
      firstSearch(),
      walled(SOCIAL),
      search('serenata Villa Alba 7 octubre 2026 programa', [
        { url: NEW, title: 'Serenata Villa Alba 2026', snippet: 'Serenata en Villa Alba el 7 de octubre de 2026.' },
      ]),
    ]
    assert.equal(event(plan, productive).stalled, false)
    assert.deepEqual(nextRequiredResearchAction(plan, computePlannerState(plan, productive))?.type, 'VERIFY_EVENT')
    productive.push(walled(NEW))
    assert.equal(nextRequiredResearchAction(plan, computePlannerState(plan, productive))?.type, 'SEARCH_EVENT')
    productive.push(junkSearch('serenata Villa Alba cartelera'))
    assert.equal(event(plan, productive).exhausted, true, 'limit 3 for one destination')
  })

  it('verified event releases the trip; the verified page is used, not just snippets', () => {
    const plan = deriveResearchPlan(PROMPT)
    const trace: ToolTraceEntry[] = [
      search('serenata Villa Alba 7 de octubre 2026', [
        { url: 'https://villa-alba.example/programa-2026', title: 'Programa Villa Alba 2026', snippet: 'Serenata en Villa Alba el 7 de octubre de 2026.' },
      ]),
      fetchOk('https://villa-alba.example/programa-2026', 'Serenata en Villa Alba el 7 de octubre de 2026 a las 21:00 en la plaza.'),
    ]
    assert.equal(event(plan, trace).satisfied, true)
    assert.equal(decide(plan, trace, 'webSearch', { query: 'hospedaje Villa Alba' }).allow, true)
  })

  it('comparing places keeps per-candidate event searches (limit 4, no early close while candidates are uncovered)', () => {
    const plan = deriveResearchPlan(MULTI_PROMPT)
    const trace = [search('serenata Villa Alba octubre', []), search('serenata Villa Alba 2026', [])]
    const ev = event(plan, trace)
    assert.equal(ev.limit, 4)
    assert.equal(ev.stalled, false)
  })

  it('every open part of the trip gets its nudge; nothing once all is covered or closed', () => {
    const plan = deriveResearchPlan(PROMPT)
    const trace: ToolTraceEntry[] = [
      firstSearch(),
      walled(SOCIAL),
      junkSearch(),
      search('hospedaje Villa Alba', [{ url: 'https://hotel.example/va', title: 'Hotel Villa Alba', snippet: 'Hotel en Villa Alba' }]),
      search('autobús Guadalajara Villa Alba', []),
    ]
    const args = { plan, forcedRounds: 0, toolCallsUsed: 5, maxToolCalls: 12, steps: 5, maxSteps: 10 }
    assert.equal(shouldForcePlannerRound({ ...args, state: computePlannerState(plan, trace) }), true, 'flights still open')
    trace.push(schedules())
    assert.equal(shouldForcePlannerRound({ ...args, state: computePlannerState(plan, trace) }), false)
  })

  it('the transition note says what closed unverified and what to research now, together', () => {
    const plan = deriveResearchPlan(PROMPT)
    const state = computePlannerState(plan, [firstSearch(), walled(SOCIAL), junkSearch()])
    const note = buildResearchTransitionNote(state, 9)
    assert.match(note, /event: closed unverified \(the last search found no new usable source\) — report it as pending/)
    assert.match(note, /Research now: lodging \+ ground — issue these calls together in this turn/)
    assert.match(note, /Remaining tool budget: 9/)
  })

  it('package answer: unverified parts are flagged, the trip is still a package', () => {
    const plan = deriveResearchPlan(PROMPT)
    const trace: ToolTraceEntry[] = [firstSearch(), walled(SOCIAL), junkSearch()]
    const goals = assessPlannerGoals(plan, trace)
    assert.equal(goals.find((g) => g.kind === 'event_discovery')!.status, 'PARTIAL')
    assert.deepEqual(decideResponseShape({ noMutation: false, goals }), { shape: 'package', reasons: [] })
    const warnings = pendingGoalWarnings(goals)
    assert.ok(
      warnings.some((w) => /pendiente de verificar — Próximo evento verificable .*: parcial\. No se presenta como confirmado\./.test(w)),
      warnings.join('\n'),
    )
    assert.deepEqual(decideResponseShape({ noMutation: true, goals }).shape, 'research_only', 'noMutation still wins')
  })
})

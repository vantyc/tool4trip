import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  agentProposalSchema,
  type AgentAskRequest,
  type ToolTraceEntry,
} from '../../shared/agentContracts.ts'
import type { LlmEnvConfig } from '../llm/config.ts'
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  LLMProvider,
  ToolCall,
} from '../llm/types.ts'
import { ToolRegistry, wrapUntrustedToolPayload } from '../tools/registry.ts'
import { prepareMutationPlan } from '../../../trip-api/src/prepareMutationPlan.ts'
import { runAgentAsk } from './runtime.ts'
import {
  assessPlannerGoals,
  classifyQueryDimensions,
  computePlannerState,
  decideResponseShape,
  planToolCallDecision,
  deriveResearchPlan,
  extractPromptCandidates,
  proposedCandidateVerdict,
} from './researchPlanner.ts'
import { markTentativeTripWindow, promptPinsExactDays } from './newTravelCoherence.ts'

/** Excerpt of the real request of job cd97f6ab (Filipinas, empty package). */
const FILIPINAS_PROMPT = [
  'Organiza un viaje de **14 noches a Filipinas**, saliendo de Ciudad de México, preferentemente en noviembre o diciembre de 2026.',
  '',
  '### Destinos',
  '',
  'Compara estos tres paraísos y selecciona la mejor ruta:',
  '',
  '1. **Boracay:** playas blancas, mar turquesa y vida nocturna.',
  '2. **El Nido, Palawan:** lagunas, acantilados y naturaleza espectacular.',
  '3. **Panglao, Bohol:** playas paradisíacas y naturaleza tropical.',
  '',
  '**Priorizar una sola base, máximo dos.** Evitar traslados innecesarios.',
  '',
  '### Hoteles sugeridos',
  '',
  'Investiga precios y disponibilidad de estos hoteles:',
  '',
  '- **Boracay:** Ferra Hotel & Garden Suites (alberca infinita).',
  '- **El Nido:** Karuna El Nido Villas (alberca infinita y vistas espectaculares).',
  '- **Batangas:** Vivere Azure Resort (alberca infinita frente al mar).',
  '- **Makati, si requiere escala:** City Garden Hotel Makati (alberca en azotea).',
  '',
  'Para Panglao, buscar un hotel equivalente.',
  '',
  '### Vuelos',
  '',
  'Buscar vuelos redondos desde CDMX con regreso modificable.',
  '',
  '### Entrega',
  '',
  '1. La mejor ruta con una o máximo dos bases.',
  '2. Itinerario relajado de 14 noches.',
  '3. Hoteles recomendados con precios y enlaces.',
  '',
  'No es obligatorio visitar todos los destinos. Usa precios y disponibilidad actualizados. No hagas reservas todavía.',
].join('\n')

describe('requested destinations are candidates (cd97f6ab)', () => {
  it('a numbered markdown list under "compara estos tres" yields the three destinations', () => {
    assert.deepEqual(extractPromptCandidates(FILIPINAS_PROMPT), ['Boracay', 'El Nido', 'Panglao'])
  })

  it('hotel-list scopes, delivery items and instructions are not candidates', () => {
    const c = extractPromptCandidates(FILIPINAS_PROMPT)
    for (const name of ['Batangas', 'Makati', 'Palawan', 'Bohol', 'La mejor']) {
      assert.ok(!c.includes(name), name)
    }
    const instructions = [
      'Compara municipios:',
      '3. Prioriza municipios con menor incidencia delictiva registrada.',
      '6. Verifica hospedaje en el municipio o muy cerca.',
    ].join('\n')
    assert.deepEqual(extractPromptCandidates(instructions), [])
  })

  it('a list with an exclusion intro is not a candidate list', () => {
    const p = 'Compara destinos, pero evita estos lugares:\n1. Boracay: muy lleno\n2. Coron: lejos'
    assert.deepEqual(extractPromptCandidates(p), [])
  })

  it('an article that starts the name is kept ("El Nido"), not stripped', () => {
    assert.ok(extractPromptCandidates('Compara los destinos El Nido y Coron para la playa').includes('El Nido'))
    const verdict = proposedCandidateVerdict({
      name: 'El Nido',
      evidence: [{ title: 'Consejos para viajar a El Nido (Filipinas)', snippet: 'El Nido, Palawan' }],
      existing: ['Boracay'],
      regionStates: [],
    })
    assert.notEqual(verdict, 'not_a_place_name')
  })
})

describe('destination choice without an event yields a preliminary package (cd97f6ab)', () => {
  it('compare-and-pick among named destinations is not decision-critical', () => {
    const plan = deriveResearchPlan(FILIPINAS_PROMPT)
    assert.equal(plan.destinationSelection, true)
    const goals = assessPlannerGoals(plan, [], {})
    assert.ok(goals.every((g) => !g.decisionCritical), JSON.stringify(goals.map((g) => g.kind)))
    assert.deepEqual(decideResponseShape({ noMutation: false, goals }), { shape: 'package', reasons: [] })
  })

  it('control: a pick that hinges on an unverified event still withholds the package', () => {
    const plan = deriveResearchPlan(
      'Quiero ir a la próxima serenata verificable. Compara los municipios Villa Alba, Bosque Bajo y Cerro Claro.',
    )
    const goals = assessPlannerGoals(plan, [], {})
    assert.ok(goals.find((g) => g.kind === 'destination_selection')?.decisionCritical)
    assert.equal(decideResponseShape({ noMutation: false, goals }).shape, 'research_only')
  })

  it('control: an explicit no-mutation directive still wins', () => {
    const goals = assessPlannerGoals(deriveResearchPlan(FILIPINAS_PROMPT), [], {})
    assert.equal(decideResponseShape({ noMutation: true, goals }).shape, 'research_only')
  })
})

describe('research budget per dimension (cd97f6ab)', () => {
  it('airport → hotel transfers are ground research only', () => {
    assert.deepEqual(classifyQueryDimensions('traslados aeropuerto Boracay a hotel Ferra Hotel & Garden Suites'), ['ground'])
    assert.deepEqual(
      classifyQueryDimensions('traslados aeropuerto Panglao a hotel equivalente Ferra Hotel & Garden Suites'),
      ['ground'],
    )
  })

  it('a query about flights keeps the flight dimension even if it mentions a transfer', () => {
    assert.ok(classifyQueryDimensions('vuelos Manila Caticlan y traslado a Boracay').includes('flight'))
  })

  it('villas/resorts are lodging research', () => {
    assert.ok(classifyQueryDimensions('Karuna El Nido Villas 2026 precios y disponibilidad').includes('lodging'))
    assert.ok(classifyQueryDimensions('Vivere Azure Resort Batangas').includes('lodging'))
  })
})

describe('approximate period → tentative window, never invented exact dates', () => {
  it('detects prompts that pin exact days', () => {
    assert.equal(promptPinsExactDays(FILIPINAS_PROMPT), false)
    assert.equal(promptPinsExactDays('Viaje en diciembre, unas dos semanas'), false)
    assert.equal(promptPinsExactDays('Viaje del 19 al 22 de septiembre a Guadalajara'), true)
    assert.equal(promptPinsExactDays('Salgo el 2026-11-03'), true)
    assert.equal(promptPinsExactDays('Salgo mañana a Puebla'), true)
    assert.equal(promptPinsExactDays('Salgo el próximo viernes'), true)
  })

  it('a month-only prompt labels the model window as provisional (UNKNOWN exact days)', () => {
    const pkg = { trip: { title: 'Filipinas', startDate: '2026-11-01', endDate: '2026-11-15' } }
    const out = markTentativeTripWindow(pkg, FILIPINAS_PROMPT)
    const notes = String((out.pkg.trip as Record<string, unknown>).notes)
    assert.match(notes, /Fechas tentativas: el usuario indicó noviembre o diciembre de 2026 sin día exacto/)
    assert.match(notes, /Días exactos: UNKNOWN/)
    assert.equal(out.warnings.length, 1)
    assert.match(out.warnings[0], /fechas tentativas/)
    const again = markTentativeTripWindow(out.pkg, FILIPINAS_PROMPT)
    assert.equal(String((again.pkg.trip as Record<string, unknown>).notes).match(/Fechas tentativas/g)?.length, 1)
  })

  it('control: exact days in the prompt leave the window untouched', () => {
    const pkg = { trip: { title: 'GDL', startDate: '2026-09-19', endDate: '2026-09-22' } }
    const out = markTentativeTripWindow(pkg, 'Viaje del 19 al 22 de septiembre a Guadalajara')
    assert.equal((out.pkg.trip as Record<string, unknown>).notes, undefined)
    assert.deepEqual(out.warnings, [])
  })
})

/** Real request of job 19f331b9 (exact dates, named hotels, bulleted destinations). */
const FILIPINAS_EXACT_PROMPT = [
  'Organiza un viaje a **Filipinas para 1 adulto**, saliendo de Ciudad de México el **12 de noviembre de 2026**, con **14 noches de hospedaje**, del 14 al 28 de noviembre.',
  '',
  'Compara estos destinos:',
  '- **Boracay**',
  '- **El Nido, Palawan**',
  '- **Panglao, Bohol**',
  '',
  'Investiga estos hoteles para **check-in el 14 y check-out el 28 de noviembre**:',
  '- **Boracay:** Ferra Hotel & Garden Suites.',
  '- **El Nido:** Karuna El Nido Villas.',
  '- **Panglao:** busca dos hoteles con alberca infinita y vistas espectaculares.',
  '',
  'Opciones adicionales:',
  '- **Batangas:** Vivere Azure Resort, 1–2 noches.',
  '- **Batangas:** Acuatico Beach Resort, opción de day pass.',
  '- **Makati:** City Garden Hotel Makati, 1 noche si las conexiones lo requieren.',
  '',
  '**Prioriza una sola base, máximo dos.**',
  '',
  'Presupuesto de hotel: **$1,000–$2,100 MXN por noche**.',
  '',
  'Busca vuelos de ida desde MEX el 12 de noviembre y regreso desde Filipinas al terminar la estancia.',
  '',
  'Presenta hoteles, fechas, precios disponibles y una propuesta de distribución de las 14 noches. No hagas reservaciones.',
].join('\n')

describe('named hotels and flights fit the research budget (19f331b9)', () => {
  it('bulleted "Boracay / El Nido, Palawan / Panglao, Bohol" → three destinations, no provinces', () => {
    assert.deepEqual(extractPromptCandidates(FILIPINAS_EXACT_PROMPT), ['Boracay', 'El Nido', 'Panglao'])
  })

  it('the plan is a package with exact dates, and counts the requested hotels', () => {
    const plan = deriveResearchPlan(FILIPINAS_EXACT_PROMPT)
    assert.equal(plan.lodgingTargets, 7)
    assert.equal(decideResponseShape({ noMutation: false, goals: assessPlannerGoals(plan, [], {}) }).shape, 'package')
    assert.equal(promptPinsExactDays(FILIPINAS_EXACT_PROMPT), true)
  })

  it('English lodging words are lodging research', () => {
    assert.ok(classifyQueryDimensions('Panglao Bohol hotels infinity pool spectacular views November 2026').includes('lodging'))
    assert.ok(classifyQueryDimensions('El Nido accommodation November 2026').includes('lodging'))
  })

  it('the six hotel searches, two page reads, both schedule legs and a fare search are all allowed', () => {
    const plan = deriveResearchPlan(FILIPINAS_EXACT_PROMPT)
    const calls: Array<[string, Record<string, unknown>]> = [
      ['webSearch', { query: 'Karuna El Nido Villas El Nido Palawan hotel November 14 to 28 2026' }],
      ['webSearch', { query: 'Panglao Bohol hotels infinity pool spectacular views November 2026' }],
      ['webSearch', { query: 'Ferra Hotel & Garden Suites Boracay November 14 to 28 2026' }],
      ['webSearch', { query: 'Vivere Azure Resort Batangas November 2026' }],
      ['webSearch', { query: 'Acuatico Beach Resort day pass Batangas 2026' }],
      ['webSearch', { query: 'City Garden Hotel Makati November 14 to 15 2026' }],
      ['fetchUrl', { url: 'https://hotels.example/0' }],
      ['fetchUrl', { url: 'https://hotels.example/2' }],
      ['searchFlightSchedules', { origin: 'MEX', destination: 'MNL', date: '2026-11-12' }],
      ['searchFlightSchedules', { origin: 'MNL', destination: 'MEX', date: '2026-11-28' }],
      ['webSearch', { query: 'vuelos CDMX Manila 12 noviembre 2026 tarifa modificable' }],
    ]
    const trace: ToolTraceEntry[] = []
    for (const [tool, args] of calls) {
      const d = planToolCallDecision({
        plan,
        state: computePlannerState(plan, trace),
        toolName: tool,
        argsJson: JSON.stringify(args),
        toolTrace: trace,
      })
      assert.ok(d.allow, `${tool} ${JSON.stringify(args)} → ${d.allow ? '' : d.reason}`)
      const sources =
        tool === 'searchFlightSchedules'
          ? []
          : [{ url: tool === 'fetchUrl' ? String(args.url) : `https://hotels.example/${trace.length}`, title: String(args.query ?? 'hotel'), snippet: 'hotel' }]
      trace.push({ tool, args, ok: true, sources, checkedAt: '2026-10-18T15:00:00+00:00' })
    }
  })

  it('control: schedule lookups that return flights still spend the flight budget', () => {
    const plan = deriveResearchPlan(FILIPINAS_EXACT_PROMPT)
    const flightHit = (n: number): ToolTraceEntry => ({
      tool: 'searchFlightSchedules',
      args: { origin: 'MEX', destination: 'GDL', date: '2026-11-12' },
      ok: true,
      sources: [{ url: `https://schedules.example/${n}`, title: 'AM 123 MEX→GDL', snippet: 'vuelo' }],
      checkedAt: '2026-10-18T15:00:00+00:00',
    })
    const state = computePlannerState(plan, [flightHit(1), flightHit(2)])
    assert.equal(state.dimensions.find((d) => d.dimension === 'flight')?.discoveryExhausted, true)
  })
})

// ---------------------------------------------------------------------------
// Offline replay of job cd97f6ab: the same searches, a model draft with the
// recommended base and the other requested destinations as alternatives.

type FakeSource = { url: string; title?: string; snippet?: string }

const TRACE_SOURCES: Array<[RegExp, FakeSource[]]> = [
  [/seguridad en Boracay/i, [{ url: 'https://kakapo.travel/es/blog/city/es-boracay-filipinas-seguro', title: '¿Es seguro Boracay, Filipinas? Guía 2026', snippet: 'Boracay es uno de los destinos de playa más seguros del sudeste asiático para turistas.' }]],
  [/seguridad en El Nido/i, [{ url: 'https://viajerosconruta.com/guia-de-el-nido', title: 'Consejos para viajar a El Nido (Filipinas): Guía 2026', snippet: 'El Nido, al estar protegido por la orografía de Palawan, no suele recibir el impacto directo de los tifones.' }]],
  [/seguridad en Panglao/i, [{ url: 'https://www.viajarporfilipinas.com/que-hacer-panglao-bohol', title: 'Qué hacer en PANGLAO - Mega Guía 2026', snippet: 'Panglao, Bohol: playas y naturaleza tropical.' }]],
  [/^Ferra Hotel/i, [{ url: 'https://www.expedia.com/es/Boracay-Island-Hoteles-Ferra-Hotel-And-Garden-Suites.h21302133.Informacion-Hotel', title: 'Ferra Hotel and Garden Suites', snippet: 'Hospédate en este hotel de negocios en Boracay. Wifi gratis, 2 restaurantes y alberca.' }]],
  [/equivalente a Ferra/i, [{ url: 'https://www.tripadvisor.com/Hotel_Review-g294260-d20316092-Reviews-Ferra_Hotel_And_Garden_Suites', title: 'FERRA HOTEL AND GARDEN SUITES - 2026 Reviews', snippet: 'Nestled in Station 2 at the heart of Boracay.' }]],
  [/Karuna/i, [{ url: 'https://www.booking.com/hotel/ph/karuna-el-nido.es.html', title: 'Karuna El Nido Villas, El Nido', snippet: 'Karuna El Nido Villas está en El Nido, a 4 min a pie de Corong Corong Beach.' }]],
  [/traslados aeropuerto/i, [{ url: 'https://www.expedia.com/Boracay-Island-Hotels-Ferra-Hotel-And-Garden-Suites.h21302133.Hotel-Information', title: 'Ferra Hotel and Garden Suites, Boracay Island', snippet: 'There is an airport shuttle (surcharges may apply).' }]],
]

function replayRegistry(executed: string[]): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    definition: {
      type: 'function',
      function: { name: 'webSearch', description: 's', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
    },
    handler: async (args) => {
      const query = String(args.query ?? '')
      executed.push(`webSearch:${query}`)
      const hits = TRACE_SOURCES.find(([re]) => re.test(query))?.[1] ?? []
      return {
        contentForModel: wrapUntrustedToolPayload('webSearch', { hits }),
        trace: { tool: 'webSearch', args, ok: true, sources: hits, checkedAt: '2026-10-18T13:00:00+00:00' },
      }
    },
  })
  registry.register({
    definition: {
      type: 'function',
      function: { name: 'searchFlightSchedules', description: 'fs', parameters: { type: 'object', properties: {} } },
    },
    handler: async (args) => {
      executed.push('searchFlightSchedules')
      return {
        contentForModel: '{}',
        trace: { tool: 'searchFlightSchedules', args, ok: true, sources: [], checkedAt: '2026-10-18T13:00:00+00:00' },
      }
    },
  })
  return registry
}

/** One tool batch per tool turn, then structured drafts in order. */
class ReplayLlm implements LLMProvider {
  readonly providerId = 'mock'
  readonly model = 'mock-gpt'
  private turn = 0
  constructor(
    private readonly batches: ToolCall[][],
    private readonly finalDrafts: string[],
  ) {}
  async chat(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    if (params.response_format) {
      const next = this.finalDrafts.shift()
      if (!next) throw new Error('no more final drafts')
      return { message: { role: 'assistant', content: next }, finishReason: 'stop' }
    }
    const batch = this.batches[this.turn++]
    if (batch?.length) return { message: { role: 'assistant', content: null, tool_calls: batch }, finishReason: 'tool_calls' }
    return { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' }
  }
}

function call(name: string, args: Record<string, unknown>, id: string): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

const TRIP_ID = '55555555-5555-4555-8555-555555555555'

function replayRequest(): AgentAskRequest {
  return {
    prompt: FILIPINAS_PROMPT,
    tripId: TRIP_ID,
    mode: 'new_travel',
    locale: 'es',
    context: {
      trip: { id: TRIP_ID, title: 'Nuevo viaje', startDate: '2026-01-01', endDate: '2026-01-02', timezone: 'America/Mexico_City', goals: [], status: 'planned' },
      bookings: [],
      travelOptions: [],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
      packageImports: [],
    },
  }
}

function replayCfg(): LlmEnvConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    tavilyApiKey: 'test-tavily',
    timeoutMs: 5_000,
    maxTokens: 8192,
    maxToolCalls: 12,
    maxSteps: 10,
    enableWebTools: true,
    webSearchProvider: 'tavily',
    enableDdgFallback: false,
  }
}

function preliminaryDraft(): string {
  return JSON.stringify({
    narrative:
      'Ruta recomendada: una sola base en Boracay. El Nido y Panglao quedan como alternativas investigadas. Precios y disponibilidad pendientes de verificar.',
    warnings: [],
    diffSummary: [],
    ops: [],
    claims: [],
    package: {
      schemaVersion: 1,
      packageId: `new-${TRIP_ID}`,
      revision: 1,
      trip: {
        id: TRIP_ID,
        title: '14 noches en Filipinas',
        destination: 'Boracay, Filipinas',
        startDate: '2026-11-01',
        endDate: '2026-11-15',
        timezone: 'Asia/Manila',
        goals: ['playa', 'descanso'],
        status: 'planned',
      },
      travelOptions: [
        {
          externalId: 'flt-out',
          type: 'flight',
          status: 'researched',
          title: 'Vuelo CDMX → Manila (modificable)',
          origin: 'MEX',
          destination: 'MNL',
          startAt: '2026-11-01T23:55:00-06:00',
          priceObserved: 28000,
          currency: 'MXN',
          verificationStatus: 'estimated',
          sourceType: 'agent',
          logicalRole: 'flight_outbound',
        },
        {
          externalId: 'lodge-ferra',
          type: 'lodging',
          status: 'shortlisted',
          title: 'Ferra Hotel & Garden Suites',
          destination: 'Boracay',
          priceObserved: 1900,
          currency: 'MXN',
          verificationStatus: 'unverified',
          sourceType: 'agent',
          logicalRole: 'lodging_primary',
        },
        {
          externalId: 'lodge-karuna',
          type: 'lodging',
          status: 'researched',
          title: 'Karuna El Nido Villas',
          destination: 'El Nido',
          sourceUrl: 'https://www.booking.com/hotel/ph/karuna-el-nido.es.html',
          verificationStatus: 'unverified',
          sourceType: 'agent',
          notes: 'Alternativa: El Nido. Precio y disponibilidad: UNKNOWN.',
        },
        {
          externalId: 'lodge-panglao',
          type: 'lodging',
          status: 'researched',
          title: 'Hotel equivalente en Panglao (por definir)',
          destination: 'Panglao',
          verificationStatus: 'unverified',
          sourceType: 'agent',
          notes: 'Alternativa: Panglao. Hotel por elegir.',
        },
      ],
      itineraryItems: [
        { externalId: 'it-llegada', title: 'Llegada a Boracay y descanso', place: 'Boracay', importance: 'recommended' },
        { externalId: 'it-playa', title: 'Días de playa y alberca infinita', place: 'Boracay', importance: 'recommended' },
      ],
      checklistItems: [{ externalId: 'chk-vuelo', label: 'Elegir vuelo modificable' }],
      notes: [],
    },
  })
}

describe('offline replay of cd97f6ab: preliminary package with incomplete data', () => {
  it('keeps destinations, hotels and itinerary; scrubs unsourced price/clock; dates tentative; flights searched', async () => {
    const executed: string[] = []
    const llm = new ReplayLlm(
      [
        [
          call('webSearch', { query: 'seguridad en Boracay Filipinas 2026' }, 'w1'),
          call('webSearch', { query: 'seguridad en El Nido Palawan Filipinas 2026' }, 'w2'),
          call('webSearch', { query: 'seguridad en Panglao Bohol Filipinas 2026' }, 'w3'),
          call('webSearch', { query: 'Ferra Hotel & Garden Suites Boracay 2026 precios y disponibilidad' }, 'w4'),
          call('webSearch', { query: 'hotel equivalente a Ferra Hotel & Garden Suites en Panglao Bohol 2026' }, 'w5'),
          call('webSearch', { query: 'Karuna El Nido Villas 2026 precios y disponibilidad' }, 'w6'),
          call('webSearch', { query: 'traslados aeropuerto Boracay a hotel Ferra Hotel & Garden Suites' }, 'w7'),
          call('webSearch', { query: 'traslados aeropuerto Panglao a hotel equivalente Ferra Hotel & Garden Suites' }, 'w8'),
        ],
        [call('searchFlightSchedules', { origin: 'MEX', destination: 'MNL', date: '2026-11-01' }, 'f1')],
      ],
      [preliminaryDraft()],
    )
    const { proposal } = await runAgentAsk(replayRequest(), {
      llm,
      cfg: replayCfg(),
      createRegistry: () => replayRegistry(executed),
    })

    assert.ok(agentProposalSchema.safeParse(proposal).success)
    assert.ok(!proposal.warnings.some((w) => /sólo de investigación/.test(w)), proposal.warnings.join('\n'))

    const pkg = proposal.package
    assert.match(pkg.trip.destination ?? '', /Boracay/)
    const lodging = pkg.travelOptions.filter((o) => o.type === 'lodging').map((o) => o.title)
    assert.ok(lodging.some((t) => /Ferra/.test(t)), lodging.join(', '))
    assert.ok(lodging.some((t) => /Karuna/.test(t)), lodging.join(', '))
    assert.ok(lodging.some((t) => /Panglao/.test(t)), lodging.join(', '))
    assert.ok(pkg.itineraryItems.some((i) => /Boracay/.test(i.place ?? i.title)))

    // Prices and clock times still need a verifiable source.
    const flight = pkg.travelOptions.find((o) => o.externalId === 'flt-out')
    assert.ok(flight)
    assert.equal(flight.priceObserved, undefined)
    assert.ok(!flight.startAt || !/T23:55/.test(flight.startAt))
    const ferra = pkg.travelOptions.find((o) => o.externalId === 'lodge-ferra')
    assert.equal(ferra?.priceObserved, undefined)

    // Month-only request: the window is provisional, exact days UNKNOWN.
    assert.match(pkg.trip.notes ?? '', /Fechas tentativas/)
    assert.match(pkg.trip.notes ?? '', /UNKNOWN/)
    assert.ok(proposal.warnings.some((w) => /fechas tentativas/.test(w)))

    // Transfers no longer spend the flight budget.
    assert.ok(executed.includes('searchFlightSchedules'), executed.join('\n'))
    assert.ok(!proposal.toolTrace.some((t) => /discovery_budget_exhausted/.test(t.error ?? '')))

    // The new trip compiles for import.
    const compiled = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: undefined,
      currentOptions: [],
      rawPackage: pkg,
      llmOps: [],
    })
    assert.equal(compiled.status, 'ok', JSON.stringify(compiled.conflicts))
  })
})

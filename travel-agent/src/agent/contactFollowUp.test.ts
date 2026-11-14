import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  agentProposalSchema,
  type AgentAskRequest,
  type AgentProposal,
  type ToolTraceEntry,
} from '../../shared/agentContracts.ts'
import { isLodgingCandidateNote } from '../../shared/lodgingCandidate.ts'
import { prepareMutationPlan } from '../../../trip-api/src/prepareMutationPlan.ts'
import { optionEntityId } from '../../../trip-api/src/tripPackage.ts'
import type { TravelOption, Trip } from '../../../trip-api/src/domainTypes.ts'
import { optionDetailLines } from '../../../src/application/askTravelProposalView.ts'
import type { LlmEnvConfig } from '../llm/config.ts'
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  ChatMessage,
  LLMProvider,
} from '../llm/types.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { registerTravelTools } from '../tools/travelTools.ts'
import {
  CONTACT_FOLLOW_UP_MAX_URLS,
  contactFollowUpUrls,
  hasUsablePhone,
  isContactFetchableUrl,
  userAskedForContact,
} from './contactFollowUp.ts'
import { phoneNumbersIn, phonesEquivalent } from './entityEvidence.ts'
import { runAgentAsk } from './runtime.ts'

/**
 * Job 27d12ec8 (E2E 2026-09-30): Tavily returned Don Rafa's directory page with
 * the phone line elided ("## Teléfono para llamar a … [...]"), the model stopped
 * without fetchUrl and the candidate reached the preview without a phone.
 */

const PROMPT =
  'reorganiza el viaje saliendo mañana 1 de octubre, consigue los telefonos de hoteles en totatiche para ver si puedo hablar'
const PHONE = '+52 4379640054'
const TRIP_ID = '92801917-c4dc-4088-99d6-52add1a5843a'
const TOWN = 'Totatiche, Jalisco'
const RAFA_URL = 'https://mexico.pueblosamerica.com/h/hotel-y-restaurant-el-oasis'
const RAFA_FB_URL = 'https://www.facebook.com/p/Hotel-y-Restaurant-Don-Rafa-100063474224834'
const ALOJAMIENTO_URL =
  'https://www.alojamiento.io/property/apartamento-vacacional-de-renta-temastian-jalisco/HA-61510847324'
const HISTORIA_URL = 'https://www.totatichejalisco.com/Historia'
const EXPEDIA_URL =
  'https://www.expedia.com/es/Totatiche-Hoteles.d553248635640666087.Guia-Viajes-Hoteles'
const CANDIDATE_ID = 'lodging-totatiche-don-rafa'

const RAFA_HTML = readFileSync(
  new URL('./testdata/donrafa-pueblosamerica.html', import.meta.url),
  'utf8',
)
const RAFA_HTML_NO_PHONE = RAFA_HTML.replaceAll('tel:+524379640054', '#telefono').replaceAll(
  PHONE,
  'pendiente de publicar',
)

/** Tavily results exactly as stored in the job's toolTrace (content = snippet). */
const JOB_RESULTS = [
  {
    url: RAFA_URL,
    title: 'Hotel Y Restaurant Don Rafa en Totatiche: Teléfono, Mapa y Opiniones',
    content:
      'El equipo de Hotel Y Restaurant Don Rafa se asegurará de que usted tenga una agradable experiencia y disfrute la belleza de Totatiche. Toda la información online de Hotel Y Restaurant Don Rafa, situado en la localidad de Totatiche (Municipio: Totatiche, Estado: Jalisco).  \n \n\n## Dirección de Hotel Y Restaurant Don Rafa\n\n  \n:: Dirección: Calle Hidalgo, 13 (Centro)   \n:: Código Postal: 46170   \n   \n \n\n## Teléfono para llamar a Hotel Y Restaurant Don Rafa [...] Hotel Y Restaurant Don Rafa se encuentra situado en Centro a 300 metros del centro de Totatiche, en Centro. Andando tardarías entre 4 y 5 minutos en llegar al hotel.\n\nUtilice este mapa para situar el alojamiento y descubrir sus alrededores:\n\nPor si le puede servir de ayuda, también está cerca de Calle Morelos y de Calle Juan De Dios Re',
  },
  {
    url: ALOJAMIENTO_URL,
    title: 'Apartamento vacacional de renta Temastian Jalisco!! Apartamento en Totatiche, Mexico',
    content:
      'Las mejores tarifas para Totatiche apartamento comienzan desde $48 por noche con incluye Estacionamiento, Area designada para fumar, TV, Niño amigable, Cocina, Lavandería con todas las demás instalaciones. Alojamiento combina a cada viajero con su Alojamiento perfecto, ya sea que viaje con un grupo, amigos, familia o mascotas.',
  },
  {
    url: HISTORIA_URL,
    title: 'Totatiche Jalisco',
    content:
      '###### Actividades Artesanales:\n\nElaboración de: Talabartería, huaraches, sillas de montar, textiles, artículos de piel y cerámica.\n\nHospedaje (2000)\n\nCategoría No. de Hoteles No. de Cuartos\n\nUna estrella 1 3\n\nClase económica 5 59',
  },
  {
    url: EXPEDIA_URL,
    title: 'Hoteles en Totatiche & Alojamiento 2026 desde $14',
    content:
      'Estás buscando estadía? Expedia.com te puede ayudar a elegir entre más de 8256 hoteles. ¡Reserva un hotel en Totatiche hoy mismo y paga después!',
  },
  {
    url: RAFA_FB_URL,
    title: 'Hotel y Restaurant "Don Rafa" | Totatiche',
    content:
      'Un lugar con tradición en Totatiche a su servicio desde 1970, donde podrá degustar platillos con recetas preparadas artesanalmente para satisfacer tu',
  },
]

function cfg(over: Partial<LlmEnvConfig> = {}): LlmEnvConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    tavilyApiKey: 'test-tavily',
    timeoutMs: 5_000,
    maxTokens: 8192,
    maxToolCalls: 6,
    maxSteps: 10,
    enableWebTools: true,
    webSearchProvider: 'tavily',
    enableDdgFallback: false,
    ...over,
  }
}

function registry(): ToolRegistry {
  const r = new ToolRegistry()
  registerTravelTools(r, { enableWebTools: true, webSearchProvider: 'tavily', enableDdgFallback: false })
  return r
}

const LODGING_CURRENT = {
  externalId: 'lodging-totatiche-1',
  type: 'lodging',
  status: 'researched',
  title: 'Hospedaje en Totatiche (pendiente de verificar)',
  destination: TOWN,
  startAt: '2026-10-06T15:00:00-06:00',
  endAt: '2026-10-08T12:00:00-06:00',
  sourceType: 'agent',
  verificationStatus: 'unverified',
} as const

function request(prompt = PROMPT): AgentAskRequest {
  return {
    prompt,
    tripId: TRIP_ID,
    locale: 'es-MX',
    context: {
      trip: {
        id: TRIP_ID,
        title: 'Fiestas en Totatiche',
        destination: TOWN,
        startDate: '2026-10-06',
        endDate: '2026-10-08',
        timezone: 'America/Mexico_City',
        goals: [],
        status: 'planned',
      },
      bookings: [],
      travelOptions: [{ ...LODGING_CURRENT }],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
      packageImports: [{ id: TRIP_ID, revision: 1 }],
    },
  }
}

type Payload = Record<string, unknown>
type Passage = { sourceUrl: string; evidenceIndex: number; text: string }

function toolPayloads(messages: ChatMessage[], tool: string): Payload[] {
  const out: Payload[] = []
  for (const m of messages) {
    if (m.role !== 'tool') continue
    try {
      const parsed = JSON.parse(String(m.content)) as { tool?: string; payload?: Payload }
      if (parsed.tool === tool && parsed.payload) out.push(parsed.payload)
    } catch {
      // non-JSON tool content
    }
  }
  return out
}

function fetchedPassages(messages: ChatMessage[]): Passage[] {
  return toolPayloads(messages, 'fetchUrl').flatMap((p) => (p.passages as Passage[] | undefined) ?? [])
}

/**
 * Plays the model of job 27d12ec8: one webSearch, then it stops. On the final
 * turn it writes Don Rafa with a phone only when a fetched passage for that
 * URL shows one (or, with `invent`, regardless of evidence).
 */
class JobLlm implements LLMProvider {
  readonly providerId = 'mock'
  readonly model = 'mock-gpt'
  toolTurns = 0
  finalTurns = 0
  evidenceSeenOnTurn: number | null = null
  finalSawNote = false

  constructor(
    private readonly opts: { invent?: boolean; fetchItself?: boolean } = {},
  ) {}

  async chat(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const phonePassage = fetchedPassages(params.messages).find(
      (p) => p.sourceUrl === RAFA_URL && phoneNumbersIn(p.text).some((n) => phonesEquivalent(n, PHONE)),
    )
    if (params.response_format) {
      this.finalTurns += 1
      this.finalSawNote = params.messages.some(
        (m) => m.role === 'user' && String(m.content).startsWith('CONTACT FOLLOW-UP (server)'),
      )
      const phone = phonePassage ? PHONE : this.opts.invent ? PHONE : null
      return {
        message: { role: 'assistant', content: JSON.stringify(this.draft(phone, phonePassage)) },
        finishReason: 'stop',
      }
    }
    this.toolTurns += 1
    if (phonePassage && this.evidenceSeenOnTurn === null) this.evidenceSeenOnTurn = this.toolTurns
    if (this.toolTurns === 1) {
      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'w1',
              type: 'function',
              function: { name: 'webSearch', arguments: JSON.stringify({ query: 'hoteles en Totatiche Jalisco' }) },
            },
          ],
        },
        finishReason: 'tool_calls',
      }
    }
    if (this.toolTurns === 2 && this.opts.fetchItself) {
      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'f1', type: 'function', function: { name: 'fetchUrl', arguments: JSON.stringify({ url: RAFA_URL }) } },
          ],
        },
        finishReason: 'tool_calls',
      }
    }
    return {
      message: { role: 'assistant', content: 'Don Rafa encontrado; teléfono pendiente de verificar.' },
      finishReason: 'stop',
    }
  }

  private draft(phone: string | null, passage: Passage | undefined) {
    return {
      narrative:
        'Se mueve la salida al 1 de octubre y se agrega el Hotel y Restaurant Don Rafa como candidato para comparar, sin reemplazar el hospedaje actual.',
      warnings: [],
      claims: passage
        ? [
            {
              kind: 'other_factual',
              statement: `Teléfono de reservas de Hotel Y Restaurant Don Rafa: ${PHONE}`,
              sourceType: 'web',
              sourceUrl: RAFA_URL,
              evidenceIndex: passage.evidenceIndex,
              entityType: 'travelOption',
              entityId: CANDIDATE_ID,
              verificationStatus: 'unverified',
              confidence: 'medium',
            },
          ]
        : [],
      diffSummary: [
        { entityKind: 'travelOption', entityRef: 'lodging-totatiche-1', op: 'update', note: 'Hospedaje actual, fechas ajustadas.' },
        { entityKind: 'travelOption', entityRef: CANDIDATE_ID, op: 'add', note: 'Nuevo candidato de hospedaje agregado para comparar.' },
      ],
      ops: [
        { op: 'update', entityKind: 'travelOption', externalId: 'lodging-totatiche-1', note: 'Hospedaje actual, fechas ajustadas.' },
        { op: 'add', entityKind: 'travelOption', externalId: CANDIDATE_ID, note: 'Nuevo candidato de hospedaje agregado para comparar.' },
      ],
      package: {
        schemaVersion: 1,
        packageId: TRIP_ID,
        revision: 2,
        generatedAt: '2026-09-30T20:13:00+00:00',
        trip: {
          id: TRIP_ID,
          title: 'Fiestas en Totatiche',
          destination: TOWN,
          startDate: '2026-10-01',
          endDate: '2026-10-08',
          timezone: 'America/Mexico_City',
          goals: [],
          status: 'planned',
        },
        travelOptions: [
          {
            externalId: 'lodging-totatiche-1',
            type: 'lodging',
            status: 'researched',
            title: 'Hospedaje en Totatiche (pendiente de verificar)',
            destination: TOWN,
            sourceType: 'agent',
            verificationStatus: 'unverified',
            notes: 'Hospedaje actual, no reemplazado.',
          },
          {
            externalId: CANDIDATE_ID,
            type: 'lodging',
            status: 'researched',
            title: 'Hotel y Restaurant Don Rafa',
            destination: TOWN,
            address: 'Calle Hidalgo, 13 (Centro), Totatiche, Jalisco, México',
            phone,
            sourceType: 'agent',
            sourceUrl: RAFA_URL,
            verificationStatus: 'unverified',
          },
        ],
        itineraryItems: [],
        checklistItems: [],
        notes: [],
      },
    }
  }
}

type FetchLog = string[]

async function withWeb<T>(
  html: string,
  results: typeof JOB_RESULTS,
  run: (log: FetchLog) => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch
  const prevKey = process.env.TAVILY_API_KEY
  process.env.TAVILY_API_KEY = 'test-tavily'
  const log: FetchLog = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url === 'https://api.tavily.com/search') {
      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    log.push(url)
    if (url === RAFA_URL) {
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  try {
    return await run(log)
  } finally {
    globalThis.fetch = realFetch
    if (prevKey === undefined) delete process.env.TAVILY_API_KEY
    else process.env.TAVILY_API_KEY = prevKey
  }
}

async function runJob(opts: {
  html?: string
  results?: typeof JOB_RESULTS
  prompt?: string
  llm?: JobLlm
  cfg?: Partial<LlmEnvConfig>
} = {}) {
  const llm = opts.llm ?? new JobLlm()
  return withWeb(opts.html ?? RAFA_HTML, opts.results ?? JOB_RESULTS, async (fetchLog) => {
    const result = await runAgentAsk(request(opts.prompt), {
      llm,
      cfg: cfg(opts.cfg),
      createRegistry: registry,
    })
    return { ...result, llm, fetchLog }
  })
}

function candidate(proposal: AgentProposal) {
  return proposal.package.travelOptions.find((o) => o.externalId === CANDIDATE_ID)
}

function tripApiCurrent(): { trip: Trip; options: TravelOption[] } {
  const stamp = { createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', syncStatus: 'synced' }
  return {
    trip: {
      id: TRIP_ID,
      title: 'Fiestas en Totatiche',
      destination: TOWN,
      startDate: '2026-10-06',
      endDate: '2026-10-08',
      timezone: 'America/Mexico_City',
      status: 'planned',
      goals: [],
      ...stamp,
    } as Trip,
    options: [
      {
        ...LODGING_CURRENT,
        id: optionEntityId(TRIP_ID, LODGING_CURRENT.externalId),
        tripId: TRIP_ID,
        packageId: TRIP_ID,
        ...stamp,
      } as TravelOption,
    ],
  }
}

describe('contact follow-up — job 27d12ec8 replay', () => {
  it('1: webSearch without the number → runtime fetches the Don Rafa page once → the model gets it and emits a backed phone', async () => {
    const { proposal, llm, fetchLog } = await runJob()

    const search = proposal.toolTrace.find((t) => t.tool === 'webSearch')!
    const rafaHit = search.sources.find((s) => s.url === RAFA_URL)!
    assert.equal(hasUsablePhone(`${rafaHit.title}\n${rafaHit.snippet}`), false, 'real snippet has no number')

    assert.deepEqual(fetchLog, [RAFA_URL])
    const fetches = proposal.toolTrace.filter((t) => t.tool === 'fetchUrl')
    assert.equal(fetches.length, 1)
    assert.equal(fetches[0]!.ok, true)
    assert.equal(fetches[0]!.args?.contactFollowUp, true)
    assert.ok(fetches[0]!.sources.every((s) => s.url === RAFA_URL))
    assert.ok(fetches[0]!.sources.some((s) => phoneNumbersIn(s.snippet ?? '').some((n) => phonesEquivalent(n, PHONE))))

    assert.equal(llm.evidenceSeenOnTurn, 3, 'the tool turn after the follow-up already sees the passage')
    assert.equal(llm.toolTurns, 3)
    assert.ok(llm.finalSawNote)

    assert.equal(candidate(proposal)?.phone, PHONE)
    assert.ok(!proposal.warnings.some((w) => /teléfono sin evidencia/.test(w)), proposal.warnings.join('\n'))
  })

  it('7: full chain — webSearch sin número → modelo termina → ronda de contacto → fetchUrl → evidencia en contexto → phone respaldado → grounding → hydrate → compileMutationPlan → Estado deseado', async () => {
    const { proposal, llm, fetchLog } = await runJob()

    // webSearch sin número
    const rafaHit = proposal.toolTrace
      .find((t) => t.tool === 'webSearch')!
      .sources.find((s) => s.url === RAFA_URL)!
    assert.deepEqual(phoneNumbersIn(`${rafaHit.title}\n${rafaHit.snippet}`), [])
    // → modelo intenta terminar (turn 2 had no tool calls) → runtime detecta
    //   investigación de contacto incompleta → fetchUrl determinista
    assert.equal(llm.evidenceSeenOnTurn, 3)
    assert.deepEqual(fetchLog, [RAFA_URL])
    // → nueva evidencia entra al contexto; modelo produce Don Rafa con phone
    //   → grounding acepta phone → hydrate/sanitize lo conserva
    assert.ok(agentProposalSchema.safeParse(proposal).success)
    const rafa = candidate(proposal)!
    assert.equal(rafa.phone, PHONE)
    assert.equal(rafa.sourceUrl, RAFA_URL)
    assert.ok(!proposal.warnings.some((w) => /teléfono sin evidencia/.test(w)))
    assert.ok(proposal.ops.some((o) => o.op === 'add' && o.externalId === CANDIDATE_ID))

    // → compileMutationPlan conserva el candidato
    const { trip, options } = tripApiCurrent()
    const prepared = prepareMutationPlan({
      tripId: TRIP_ID,
      currentTrip: trip,
      currentOptions: options,
      rawPackage: proposal.package,
      llmOps: proposal.ops,
    })
    assert.equal(prepared.status, 'ok', prepared.conflicts.join('; '))
    assert.deepEqual(
      prepared.canonicalOps.filter((o) => o.externalId === CANDIDATE_ID).map((o) => o.op),
      ['add'],
    )
    assert.ok(
      !prepared.canonicalOps.some(
        (o) => (o.op === 'remove' || o.op === 'supersede') && o.externalId === 'lodging-totatiche-1',
      ),
    )
    const compiled = prepared.normalizedPackage.travelOptions.find((o) => o.externalId === CANDIDATE_ID)!
    assert.equal(compiled.phone, PHONE)
    assert.ok(isLodgingCandidateNote(compiled.notes))

    // → Estado deseado muestra Tel: +52 4379640054
    const lines = optionDetailLines(compiled)
    assert.ok(lines.includes(`Tel: ${PHONE}`), lines.join(' | '))
    assert.ok(lines.includes(`Fuente: ${RAFA_URL}`))
  })

  it('2: no follow-up fetch when the user did not ask for phones/contact', async () => {
    const { proposal, llm, fetchLog } = await runJob({
      prompt: 'reorganiza el viaje saliendo mañana 1 de octubre y busca hoteles en totatiche para comparar',
    })
    assert.deepEqual(fetchLog, [])
    assert.ok(!proposal.toolTrace.some((t) => t.tool === 'fetchUrl'))
    assert.equal(llm.toolTurns, 2)
    assert.equal(candidate(proposal)?.phone, undefined)
  })

  it('3: no follow-up fetch when the search item already carries a usable phone', async () => {
    const results = JOB_RESULTS.map((r) =>
      r.url === RAFA_URL ? { ...r, content: `# Hotel Y Restaurant Don Rafa\n\n📞 Llamar: ${PHONE}\n\n${r.content}` } : r,
    )
    const { proposal, fetchLog } = await runJob({ results })
    assert.deepEqual(fetchLog, [])
    assert.ok(!proposal.toolTrace.some((t) => t.tool === 'fetchUrl'))
  })

  it('4: AGENT_MAX_TOOL_CALLS is respected — no follow-up once the budget is spent', async () => {
    const { proposal, fetchLog } = await runJob({ cfg: { maxToolCalls: 1 } })
    assert.deepEqual(fetchLog, [])
    assert.ok(!proposal.toolTrace.some((t) => t.tool === 'fetchUrl'))
    assert.equal(candidate(proposal)?.phone, undefined)
  })

  it('4: AGENT_MAX_STEPS is respected — the follow-up adds no LLM step beyond the ceiling', async () => {
    const llm = new JobLlm()
    const { proposal, fetchLog, meta } = await runJob({ llm, cfg: { maxSteps: 2 } })
    // steps 1–2 are the tool turns; the loop exits at the ceiling, the final
    // structured turn (always run) still reads the fetched passage.
    assert.deepEqual(fetchLog, [RAFA_URL])
    assert.equal(llm.toolTurns, 2)
    assert.equal(meta.llmCalls, 3)
    assert.equal(candidate(proposal)?.phone, PHONE)
  })

  it('5: a URL the model already fetched is not fetched again', async () => {
    const llm = new JobLlm({ fetchItself: true })
    const { proposal, fetchLog } = await runJob({ llm })
    assert.deepEqual(fetchLog, [RAFA_URL])
    const fetches = proposal.toolTrace.filter((t) => t.tool === 'fetchUrl')
    assert.equal(fetches.length, 1)
    assert.equal(fetches[0]!.args?.contactFollowUp, undefined)
    assert.equal(candidate(proposal)?.phone, PHONE)
  })

  it('6: page without the number and a model that invents it → phone dropped; second stop does not loop', async () => {
    const llm = new JobLlm({ invent: true })
    const { proposal, fetchLog } = await runJob({ html: RAFA_HTML_NO_PHONE, llm })
    assert.deepEqual(fetchLog, [RAFA_URL], 'one follow-up only')
    assert.equal(llm.toolTurns, 3, 'model stopped twice; the runtime went to the final turn')
    assert.equal(llm.finalTurns, 1)
    assert.equal(candidate(proposal)?.phone, undefined)
    assert.ok(proposal.warnings.some((w) => /teléfono sin evidencia/.test(w) && w.includes(CANDIDATE_ID)))
  })

  it('6: page without the number and an honest model → no phone, no loop', async () => {
    const llm = new JobLlm()
    const { proposal, fetchLog } = await runJob({ html: RAFA_HTML_NO_PHONE, llm })
    assert.deepEqual(fetchLog, [RAFA_URL])
    assert.equal(llm.toolTurns, 3)
    assert.equal(candidate(proposal)?.phone, undefined)
    assert.ok(!proposal.warnings.some((w) => /teléfono sin evidencia/.test(w)))
  })
})

describe('contact follow-up — selection rules', () => {
  const hit = (url: string, title: string, snippet: string): ToolTraceEntry['sources'][number] => ({
    url,
    title,
    snippet,
  })
  const search = (sources: ToolTraceEntry['sources']): ToolTraceEntry => ({
    tool: 'webSearch',
    ok: true,
    checkedAt: '2026-09-30T20:12:49+00:00',
    sources,
  })

  it('detects explicit phone/contact requests only', () => {
    assert.ok(userAskedForContact(PROMPT))
    assert.ok(userAskedForContact('dame el teléfono del hotel'))
    assert.ok(userAskedForContact('necesito contactar a los hoteles'))
    assert.ok(userAskedForContact('¿tienes el whatsapp de la posada?'))
    assert.ok(!userAskedForContact('busca hoteles en Totatiche para comparar'))
    assert.ok(!userAskedForContact('reorganiza el viaje saliendo mañana'))
  })

  it('5: Facebook, Expedia, Booking and equivalents are never fetched', () => {
    for (const url of [
      RAFA_FB_URL,
      EXPEDIA_URL,
      'https://www.expedia.mx/Totatiche.dx553248635640666087',
      'https://www.booking.com/hotel/mx/don-rafa.es.html',
      'https://www.tripadvisor.com.mx/Hotel_Review-g1-d2',
      'https://www.instagram.com/donrafa',
      'https://x.com/donrafa',
      'https://www.google.com/maps/place/Don+Rafa',
      ALOJAMIENTO_URL,
    ]) {
      assert.equal(isContactFetchableUrl(url), false, url)
    }
    assert.ok(isContactFetchableUrl(RAFA_URL))
    assert.ok(isContactFetchableUrl('https://hoteldonrafa.mx/contacto'))
  })

  it('5: picks only items that signal contact data without a number, at most 2, never an already fetched URL', () => {
    const trace: ToolTraceEntry[] = [
      search([
        hit('https://dir.example/a', 'Hotel A: Teléfono y mapa', 'Teléfono para llamar a Hotel A [...]'),
        hit('https://dir.example/b', 'Hotel B', 'Contacto: ver página'),
        hit('https://dir.example/c', 'Hotel C: Teléfono', 'Teléfono: +52 437 964 0011'),
        hit('https://dir.example/d', 'Hotel D', 'Habitaciones amplias y estacionamiento'),
        hit('https://dir.example/e', 'Hotel E: Teléfono', 'Teléfono para llamar a Hotel E'),
        hit('https://www.facebook.com/hotelf', 'Hotel F', 'Contact info'),
      ]),
    ]
    assert.deepEqual(contactFollowUpUrls(trace), ['https://dir.example/a', 'https://dir.example/b'])
    assert.equal(CONTACT_FOLLOW_UP_MAX_URLS, 2)

    const fetchedA: ToolTraceEntry = {
      tool: 'fetchUrl',
      ok: false,
      args: { url: 'https://dir.example/a', httpStatus: 403 },
      sources: [],
      error: 'HTTP 403',
      checkedAt: '2026-09-30T20:13:00+00:00',
    }
    assert.deepEqual(contactFollowUpUrls([...trace, fetchedA]), ['https://dir.example/b', 'https://dir.example/e'])
  })

  it('3: a number already stored for that URL (any tool) counts; dates and postcodes do not', () => {
    const base = search([hit(RAFA_URL, 'Don Rafa: Teléfono', 'Teléfono para llamar [...] 2026-10-01 · CP 46170')])
    assert.deepEqual(contactFollowUpUrls([base]), [RAFA_URL])
    const withPhone: ToolTraceEntry = search([hit(RAFA_URL, 'Don Rafa', `Llamar: ${PHONE}`)])
    assert.deepEqual(contactFollowUpUrls([base, withPhone]), [])
  })
})

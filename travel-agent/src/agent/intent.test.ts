import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentAskRequest } from '../../shared/agentContracts.ts'
import { agentProposalSchema } from '../../shared/agentContracts.ts'
import {
  assertDraftGrounded,
  validateClaimsAgainstToolTrace,
} from './claims.ts'
import {
  classifyAskIntent,
  formatTripDateEs,
  tryContextAnswer,
  buildContextOnlyDraft,
} from './intent.ts'
import { hydrateProposal, runAgentAsk } from './runtime.ts'
import type { LlmEnvConfig } from '../llm/config.ts'
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  LLMProvider,
} from '../llm/types.ts'
import { ToolRegistry } from '../tools/registry.ts'

function smaRequest(
  prompt: string,
  tripNotes?: string,
): AgentAskRequest {
  return {
    prompt,
    tripId: 'sma-2026-sep25-oct01',
    locale: 'es-MX',
    context: {
      trip: {
        id: 'sma-2026-sep25-oct01',
        title: 'San Miguel el Alto — fiestas sep 2026',
        destination: 'San Miguel el Alto, Jalisco, México',
        startDate: '2026-09-25',
        endDate: '2026-10-01',
        timezone: 'America/Mexico_City',
        goals: ['fiestas'],
        status: 'planned',
        ...(tripNotes !== undefined ? { notes: tripNotes } : {}),
      },
      bookings: [],
      travelOptions: [
        {
          externalId: 'opt-lodge-1',
          type: 'lodging',
          status: 'shortlisted',
          title: 'Hotel centro SMA',
          notes: 'posible transfer desde terminal',
        },
      ],
      itineraryItems: [],
      checklistItems: [],
      notes: [
        {
          externalId: 'note-1',
          title: 'transporte',
          body: 'considerar bus y vuelos',
        },
      ],
      packageImports: [],
    },
  }
}

function baseCfg(over: Partial<LlmEnvConfig> = {}): LlmEnvConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    apiKey: 'test-key',
    tavilyApiKey: 'test-tavily',
    timeoutMs: 5_000,
    maxTokens: 8192,
    maxToolCalls: 6,
    maxSteps: 8,
    enableWebTools: true,
    webSearchProvider: 'tavily',
    enableDdgFallback: false,
    ...over,
  }
}

class ScriptedLlm implements LLMProvider {
  readonly providerId = 'mock'
  readonly model = 'mock-gpt'
  calls: ChatCompletionParams[] = []
  private readonly scripts: ((
    p: ChatCompletionParams,
  ) => ChatCompletionResult)[]
  constructor(
    scripts: ((p: ChatCompletionParams) => ChatCompletionResult)[],
  ) {
    this.scripts = scripts
  }
  async chat(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    this.calls.push(params)
    const fn = this.scripts.shift()
    if (!fn) throw new Error('no more scripts')
    return fn(params)
  }
}

describe('intent routing', () => {
  it('classifies return-date question as context_answer', () => {
    assert.equal(
      classifyAskIntent('que dia es el regreso a cdmx?'),
      'context_answer',
    )
  })

  it('classifies explicit internet verify as research', () => {
    assert.equal(
      classifyAskIntent('verifica en internet los horarios de autobús'),
      'research',
    )
  })

  it('classifies change request as mutation', () => {
    assert.equal(
      classifyAskIntent('cambia el hospedaje al Hotel Centro'),
      'mutation',
    )
  })
})

describe('context-only answers', () => {
  it('1: fecha regreso desde context -> pass, 0 tools', async () => {
    const req = smaRequest('que dia es el regreso a cdmx?')
    const hit = tryContextAnswer(req)
    assert.ok(hit)
    assert.match(hit!.narrative, /1 de octubre de 2026/i)
    assert.equal(hit!.claims[0]?.sourceType, 'context')
    assert.equal(hit!.claims[0]?.field, 'endDate')

    const llm = new ScriptedLlm([])
    const { proposal, meta } = await runAgentAsk(req, {
      llm,
      cfg: baseCfg(),
      createRegistry: () => new ToolRegistry(),
    })
    assert.equal(meta.llmCalls, 0)
    assert.equal(meta.toolTrace.length, 0)
    assert.equal(proposal.ops.length, 0)
    assert.deepEqual(proposal.warnings, [])
    assert.match(proposal.narrative, /1 de octubre de 2026/i)
    assert.equal(formatTripDateEs('2026-10-01').toLowerCase().includes('octubre'), true)
    assert.equal(llm.calls.length, 0)
  })

  it('1b: notes con bus/vuelos/transfer no disparan ungrounded_claims', async () => {
    const noisyNotes =
      'Opciones: bus Primera Plus; vuelos GDL; transfer al centro.'
    const req = smaRequest('que dia es el regreso a cdmx?', noisyNotes)
    assert.equal(classifyAskIntent(req.prompt), 'context_answer')

    const draft = buildContextOnlyDraft(req, tryContextAnswer(req)!)
    const pkgTrip = (draft.package as { trip: { notes?: unknown } }).trip
    assert.equal(pkgTrip.notes == null || pkgTrip.notes === '', true)

    const g = assertDraftGrounded(draft, [], req.context)
    assert.equal(g.ok, true, g.ok ? '' : g.message)

    const { proposal, meta } = await runAgentAsk(req, {
      llm: new ScriptedLlm([]),
      cfg: baseCfg(),
      createRegistry: () => new ToolRegistry(),
    })
    assert.equal(meta.llmCalls, 0)
    assert.equal(meta.toolTrace.length, 0)
    assert.equal(proposal.ops.length, 0)
    assert.deepEqual(proposal.warnings, [])
    assert.deepEqual(proposal.diffSummary, [])
    assert.match(proposal.narrative, /jueves.*1 de octubre de 2026/i)
    assert.equal(proposal.toolTrace.length, 0)
    assert.equal(
      proposal.package.trip.notes,
      undefined,
      'historical Dexie notes must not be re-injected into proposal package',
    )
    assert.ok(
      !/bus|vuelos|transfer/i.test(JSON.stringify(proposal.package)),
      'historical transport notes must not appear in package',
    )
  })

  it('2: pregunta sobre opción guardada -> pass, 0 tools', async () => {
    const req = smaRequest(
      'dónde me hospedo?',
      'notas irrelevantes: bus, vuelos, transfer',
    )
    const { proposal, meta } = await runAgentAsk(req, {
      llm: new ScriptedLlm([]),
      cfg: baseCfg(),
      createRegistry: () => new ToolRegistry(),
    })
    assert.equal(meta.llmCalls, 0)
    assert.equal(meta.toolTrace.length, 0)
    assert.deepEqual(proposal.warnings, [])
    assert.match(proposal.narrative, /Hotel centro SMA/)
  })

  it('3: dato inexistente (vuelo) -> puede pasar a research', () => {
    const req = smaRequest('cuál es mi vuelo seleccionado?')
    assert.equal(tryContextAnswer(req), null)
    // No flight in context → not a deterministic context hit (research/LLM may follow)
  })

  it('4: prompt explícito internet -> research', () => {
    assert.equal(
      classifyAskIntent('verifica en internet el precio del hotel'),
      'research',
    )
  })

  it('5: mutation basada en contexto', () => {
    assert.equal(
      classifyAskIntent('cambia el título del viaje a Fiestas SMA'),
      'mutation',
    )
  })

  it('6: context claim jamás requiere URL web', () => {
    const req = smaRequest(
      'que dia es el regreso a cdmx?',
      'histórico: bus y vuelos',
    )
    const hit = tryContextAnswer(req)!
    const draft = buildContextOnlyDraft(req, hit)
    const g = assertDraftGrounded(draft, [], req.context)
    assert.equal(g.ok, true)
    if (g.ok) {
      assert.equal(g.validClaims[0]?.sourceType, 'context')
      assert.equal(g.validClaims[0]?.sourceUrl, null)
      assert.match(g.validClaims[0]!.quotedFact, /2026-10-01/)
      assert.deepEqual(g.serverWarnings, [])
      assert.deepEqual(g.draft.warnings, [])
    }
    const hydrated = hydrateProposal(
      g.ok ? g.draft : draft,
      req,
      [],
    )
    const parsed = agentProposalSchema.safeParse(hydrated)
    assert.equal(parsed.success, true)
    assert.equal('claims' in (parsed.data as object), false)
    assert.deepEqual(parsed.success ? parsed.data.warnings : null, [])
  })

  it('7: web claim sigue fail-closed sin URL en toolTrace', () => {
    const result = validateClaimsAgainstToolTrace(
      [
        {
          kind: 'other_factual',
          statement: 'vuelo barato',
          sourceType: 'web',
          sourceUrl: 'https://www.google.com/travel/flights?q=fake',
          evidenceIndex: 0,
          verificationStatus: 'unverified',
          confidence: 'low',
        },
      ],
      [],
    )
    assert.equal(result.valid.length, 0)
    assert.equal(result.invalid[0]?.code, 'source_url_missing')
  })
})

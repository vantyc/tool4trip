/**
 * Ask Travel: MEX→GDL 2026-09-20 between 11:00–15:00 (direct flights).
 * Reproduces / validates context_entity_missing fix for searchFlightSchedules.
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { runAgentAsk } from '../travel-agent/src/agent/runtime.ts'
import { loadLlmEnv } from '../travel-agent/src/llm/config.ts'
import { OpenAICompatibleProvider } from '../travel-agent/src/llm/openaiCompatible.ts'
import type { AgentAskRequest } from '../shared/agentContracts.ts'

function loadAdbKey(): void {
  if (process.env.AERODATABOX_RAPIDAPI_KEY) return
  const p = resolve('k8s/secrets/aerodatabox-secret.yaml')
  if (!existsSync(p)) return
  const m = readFileSync(p, 'utf8').match(/AERODATABOX_RAPIDAPI_KEY:\s*(\S+)/)
  if (m) process.env.AERODATABOX_RAPIDAPI_KEY = m[1]
}

function loadLlmFromK8s(): void {
  if (process.env.LLM_API_KEY && process.env.TAVILY_API_KEY) return
  const raw = execSync(
    'kubectl -n tool4trip get secret travel-agent-llm -o json',
    { encoding: 'utf8' },
  )
  const data = JSON.parse(raw).data as Record<string, string>
  for (const [k, v] of Object.entries(data)) {
    if (!process.env[k]) process.env[k] = Buffer.from(v, 'base64').toString('utf8')
  }
}

const PROMPT =
  'Busca vuelos directos MEX→GDL el 2026-09-20 entre las 11:00 y las 15:00 (hora local). ' +
  'Usa searchFlightSchedules. Incluye horarios publicados con aerolínea. ' +
  'No inventes disponibilidad ni precios. Marca HORARIO PUBLICADO.'

async function main() {
  loadAdbKey()
  loadLlmFromK8s()
  process.env.LLM_PROVIDER ||= 'openai-compatible'
  process.env.LLM_BASE_URL ||= 'https://api.openai.com/v1'
  process.env.LLM_MODEL ||= 'gpt-4.1-mini'
  process.env.ENABLE_WEB_TOOLS ||= '1'
  process.env.WEB_SEARCH_PROVIDER ||= 'tavily'

  const cfg = loadLlmEnv()
  const tripId = randomUUID()
  const req: AgentAskRequest = {
    prompt: PROMPT,
    tripId,
    locale: 'es-MX',
    mode: 'ask',
    context: {
      trip: {
        id: tripId,
        title: 'CDMX — GDL sep 2026',
        destination: 'Guadalajara',
        startDate: '2026-09-20',
        endDate: '2026-09-22',
        timezone: 'America/Mexico_City',
        status: 'planned',
        goals: ['vuelos MEX GDL'],
      },
      bookings: [],
      travelOptions: [],
      itineraryItems: [],
      checklistItems: [],
      notes: [],
      packageImports: [],
    },
  }

  const llm = new OpenAICompatibleProvider(
    cfg.model,
    cfg.baseUrl,
    cfg.apiKey,
    cfg.maxTokens,
  )

  const t0 = Date.now()
  try {
    const { proposal, meta } = await runAgentAsk(req, { llm, cfg })
    const elapsedMs = Date.now() - t0
    if (!proposal) throw new Error('No proposal')

    const scheduleCalls = (proposal.toolTrace ?? []).filter(
      (t) => t.tool === 'searchFlightSchedules',
    )
    const flights = proposal.package.travelOptions.filter((o) => o.type === 'flight')
    const inWindow = flights.filter((o) => {
      const m = (o.startAt ?? '').match(/T(\d{2}):(\d{2})/)
      if (!m) return false
      const mins = Number(m[1]) * 60 + Number(m[2])
      return mins >= 11 * 60 && mins <= 15 * 60
    })

    console.log(
      JSON.stringify(
        {
          status: 'succeeded',
          elapsedMs,
          llmCalls: meta.llmCalls,
          hadRepair: meta.hadRepair,
          scheduleCalls: scheduleCalls.map((t) => ({
            ok: t.ok,
            origin: t.args?.origin,
            destination: t.args?.destination,
            date: t.args?.date,
            flights: Array.isArray(t.args?.flights)
              ? (t.args.flights as unknown[]).length
              : 0,
          })),
          flightCount: flights.length,
          inWindowCount: inWindow.length,
          flights: flights.map((o) => ({
            externalId: o.externalId,
            title: o.title,
            provider: o.provider,
            startAt: o.startAt,
            endAt: o.endAt,
            sourceType: o.sourceType,
            verificationStatus: o.verificationStatus,
            sourceUrl: o.sourceUrl,
            notesHasHorario: /HORARIO PUBLICADO/i.test(o.notes ?? ''),
            hasPrice: o.priceObserved != null,
          })),
          warningsHead: (proposal.warnings ?? []).slice(0, 8),
          narrativeHead: (proposal.narrative ?? '').slice(0, 240),
        },
        null,
        2,
      ),
    )
  } catch (e) {
    const err = e as Error & { code?: string; runMeta?: unknown }
    console.log(
      JSON.stringify(
        {
          status: 'failed',
          elapsedMs: Date.now() - t0,
          code: err.code ?? err.name,
          message: err.message?.slice(0, 2000),
        },
        null,
        2,
      ),
    )
    process.exitCode = 1
  }
}

main()

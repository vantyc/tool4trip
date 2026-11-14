/**
 * NewTravel SMA validation — real agent run consuming searchFlightSchedules.
 *
 * Loads LLM/Tavily from k8s secret (no secret values printed) and AeroDataBox key
 * from k8s/secrets/aerodatabox-secret.yaml.
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
  try {
    const raw = execSync(
      'kubectl -n tool4trip get secret travel-agent-llm -o json',
      { encoding: 'utf8' },
    )
    const data = JSON.parse(raw).data as Record<string, string>
    for (const [k, v] of Object.entries(data)) {
      if (!process.env[k]) {
        process.env[k] = Buffer.from(v, 'base64').toString('utf8')
      }
    }
  } catch {
    console.error('Could not load travel-agent-llm secret from k8s')
  }
}

const SMA_PROMPT = `Viaje de última hora: hoy sábado 19 de septiembre de 2026 salgo de Ciudad de México (AICM / MEX) a Guadalajara (GDL). Quiero llegar a San Miguel el Alto, Jalisco, para las fiestas; la serenata es el domingo 20 de septiembre de 2026. Regreso preferido martes 22 (lunes 21 solo alternativa).

Prioridades del día de salida: vuelo MEX→GDL razonable hoy; si hay tiempo, una torta ahogada tradicional cerca del aeropuerto de Guadalajara; autobús o traslado GDL→San Miguel el Alto; hospedaje cerca de Plaza de Armas / Ramón Corona para las noches del 19, 20 y 21.

Si el traslado de hoy sale tan tarde que implique transporte peligroso o pagar una cantidad desproporcionada, propone como alternativa salir temprano mañana domingo 20 y llegar antes de la serenata. No inventes vuelos, horarios, precios, disponibilidad ni eventos. Los datos no comprobados deben quedar como UNKNOWN o pendientes de confirmar. No hagas reservaciones ni compras.`

async function main() {
  loadAdbKey()
  loadLlmFromK8s()
  process.env.LLM_PROVIDER ||= 'openai-compatible'
  process.env.LLM_BASE_URL ||= 'https://api.openai.com/v1'
  process.env.LLM_MODEL ||= 'gpt-4.1-mini'
  process.env.ENABLE_WEB_TOOLS ||= '1'
  process.env.WEB_SEARCH_PROVIDER ||= 'tavily'

  const cfg = loadLlmEnv()
  if (!cfg.apiKey) throw new Error('LLM_API_KEY missing')
  if (!cfg.tavilyApiKey) throw new Error('TAVILY_API_KEY missing')
  if (!process.env.AERODATABOX_RAPIDAPI_KEY) {
    throw new Error('AERODATABOX_RAPIDAPI_KEY missing')
  }

  const tripId = randomUUID()
  const req: AgentAskRequest = {
    prompt: SMA_PROMPT,
    tripId,
    locale: 'es-MX',
    mode: 'new_travel',
    context: {
      trip: {
        id: tripId,
        title: 'Nuevo viaje',
        startDate: '2026-09-19',
        endDate: '2026-09-22',
        timezone: 'America/Mexico_City',
        status: 'planned',
        goals: [],
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
  const { proposal, meta } = await runAgentAsk(req, { llm, cfg })
  const elapsedMs = Date.now() - t0
  if (!proposal) throw new Error('No proposal returned')

  const tools = (proposal.toolTrace ?? []).map((t) => ({
    tool: t.tool,
    ok: t.ok,
    error: t.error,
    sources: t.sources?.length ?? 0,
    argsSummary:
      t.tool === 'searchFlightSchedules'
        ? {
            origin: t.args?.origin,
            destination: t.args?.destination,
            date: t.args?.date,
            flights: Array.isArray(t.args?.flights)
              ? (t.args.flights as unknown[]).length
              : 0,
          }
        : t.tool === 'webSearch'
          ? { query: String(t.args?.query ?? '').slice(0, 80) }
          : undefined,
  }))

  const flights = proposal.package.travelOptions.filter(
    (o) => o.type === 'flight',
  )
  const scheduleFlights = flights.filter(
    (o) => o.sourceType === 'flight_schedule',
  )
  const usedScheduleTool = (proposal.toolTrace ?? []).some(
    (t) => t.tool === 'searchFlightSchedules',
  )
  const scheduleOk = (proposal.toolTrace ?? []).some(
    (t) =>
      t.tool === 'searchFlightSchedules' &&
      t.ok &&
      (Array.isArray(t.args?.flights)
        ? (t.args.flights as unknown[]).length > 0
        : (t.sources?.length ?? 0) > 0),
  )

  console.log(
    JSON.stringify(
      {
        elapsedMs,
        llmCalls: meta.llmCalls,
        steps: meta.steps,
        toolTraceCount: meta.toolTrace.length,
        usedSearchFlightSchedules: usedScheduleTool,
        scheduleToolReturnedFlights: scheduleOk,
        tools,
        researchDiagnostics: proposal.researchDiagnostics ?? null,
        flightCount: flights.length,
        scheduleFlightCount: scheduleFlights.length,
        sampleSchedule: scheduleFlights.slice(0, 3).map((o) => ({
          title: o.title,
          provider: o.provider,
          startAt: o.startAt,
          endAt: o.endAt,
          sourceType: o.sourceType,
          verificationStatus: o.verificationStatus,
          notesHasHorario: /HORARIO PUBLICADO/i.test(o.notes ?? ''),
          hasPrice: o.priceObserved != null,
        })),
        warnings: (proposal.warnings ?? []).slice(0, 12),
        narrativeHead: (proposal.narrative ?? '').slice(0, 280),
      },
      null,
      2,
    ),
  )

  if (!usedScheduleTool) {
    console.error('FAIL: agent did not call searchFlightSchedules')
    process.exitCode = 1
  } else if (!scheduleOk) {
    console.error('FAIL: searchFlightSchedules returned no flights')
    process.exitCode = 1
  } else if (scheduleFlights.length === 0) {
    console.error('FAIL: package has no flight_schedule options after hydrate')
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

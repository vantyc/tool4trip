/**
 * Smoke: Ask Travel 19–22 → 25–28 on real trip — event-date demotion.
 * Does NOT apply / mutate the persisted trip.
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runAgentAsk } from '../travel-agent/src/agent/runtime.ts'
import { loadLlmEnv, AgentRuntimeError } from '../travel-agent/src/llm/config.ts'
import { OpenAICompatibleProvider } from '../travel-agent/src/llm/openaiCompatible.ts'
import { demoteUnverifiedExternalEventDates } from '../travel-agent/src/agent/eventDateGrounding.ts'
import { assertDraftGrounded } from '../travel-agent/src/agent/claims.ts'
import { stampProvenScheduleOptions } from '../travel-agent/src/flights/mergeSchedules.ts'
import type { AgentAskRequest, ToolTraceEntry } from '../shared/agentContracts.ts'

const TRIP_ID = 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28'

const PROMPT = `Cambiaron mis planes. Quiero actualizar este mismo viaje, no crear uno nuevo.
Mantén como objetivo principal asistir a las fiestas patronales y a la serenata tradicional de San Miguel el Alto, Jalisco.
Cambia las fechas del viaje al viernes 25 de septiembre de 2026 al lunes 28 de septiembre de 2026.
Usa Guadalajara como ciudad pivote. Busca vuelos directos MEX → GDL para el viernes 25, preferentemente entre 11:00 y 15:00, y GDL → MEX para el lunes 28.
Mi intención es hospedarme en San Miguel el Alto si encuentro disponibilidad. Si no encuentro alojamiento allí, Guadalajara debe quedar como alternativa de hospedaje.
Conserva del viaje actual toda la información que siga siendo válida y sustituye únicamente lo que haya quedado obsoleto por el cambio de fechas.
Antes de aplicar los cambios, muéstrame claramente qué propones modificar.`

function loadSecrets() {
  if (!process.env.AERODATABOX_RAPIDAPI_KEY) {
    const p = resolve('k8s/secrets/aerodatabox-secret.yaml')
    if (existsSync(p)) {
      const m = readFileSync(p, 'utf8').match(/AERODATABOX_RAPIDAPI_KEY:\s*(\S+)/)
      if (m) process.env.AERODATABOX_RAPIDAPI_KEY = m[1]
    }
  }
  if (!process.env.LLM_API_KEY) {
    const raw = execSync(
      'kubectl -n tool4trip get secret travel-agent-llm -o json',
      { encoding: 'utf8' },
    )
    const data = JSON.parse(raw).data as Record<string, string>
    for (const [k, v] of Object.entries(data)) {
      if (!process.env[k]) process.env[k] = Buffer.from(v, 'base64').toString('utf8')
    }
  }
}

function kubectlJson(path: string): unknown {
  const out = execSync(
    `kubectl -n tool4trip exec deploy/trip-api -- wget -qO- "http://127.0.0.1:8080${path}"`,
    { encoding: 'utf8', maxBuffer: 10_000_000 },
  )
  return JSON.parse(out)
}

function tripSnapshot() {
  const trip = kubectlJson(`/api/trips/${TRIP_ID}`) as Record<string, unknown>
  return {
    id: trip.id,
    startDate: trip.startDate,
    endDate: trip.endDate,
    title: trip.title,
    updatedAt: trip.updatedAt ?? trip.modifiedAt ?? null,
  }
}

function buildContext(): AgentAskRequest['context'] {
  return {
    trip: kubectlJson(`/api/trips/${TRIP_ID}`) as AgentAskRequest['context']['trip'],
    travelOptions: kubectlJson(
      `/api/trips/${TRIP_ID}/travel-options`,
    ) as AgentAskRequest['context']['travelOptions'],
    itineraryItems: kubectlJson(
      `/api/trips/${TRIP_ID}/itinerary-items`,
    ) as AgentAskRequest['context']['itineraryItems'],
    checklistItems: kubectlJson(
      `/api/trips/${TRIP_ID}/checklist-items`,
    ) as AgentAskRequest['context']['checklistItems'],
    notes: kubectlJson(
      `/api/trips/${TRIP_ID}/notes`,
    ) as AgentAskRequest['context']['notes'],
    bookings: kubectlJson(
      `/api/trips/${TRIP_ID}/bookings`,
    ) as AgentAskRequest['context']['bookings'],
    packageImports: kubectlJson(
      `/api/trips/${TRIP_ID}/package-imports`,
    ) as AgentAskRequest['context']['packageImports'],
  }
}

function eventKind(text: string): 'serenata' | 'fiestas' | null {
  const n = text.toLowerCase()
  if (/serenata/.test(n)) return 'serenata'
  if (/fiestas?\s+patronales|fiesta\s+patronal/.test(n)) return 'fiestas'
  return null
}

function affirmsConcreteDay(
  title: string,
  notes: string,
  startAt: unknown,
  iso: string,
  day: string,
): boolean {
  if (typeof startAt === 'string' && startAt.startsWith(iso)) return true
  const blob = `${title} ${notes}`
  if (blob.includes(iso)) return true
  if (
    new RegExp(`\\b${day}\\s+de\\s+septiembre`, 'i').test(blob) &&
    !/pendiente de verificar|fecha tentativa/i.test(notes + title)
  ) {
    return true
  }
  return false
}

function analyzePackage(draft: Record<string, unknown>, label: string) {
  const pkg = draft.package as
    | {
        trip?: { startDate?: string; endDate?: string }
        itineraryItems?: Array<Record<string, unknown>>
        travelOptions?: Array<Record<string, unknown>>
      }
    | undefined
  const narrative = String(draft.narrative ?? '')
  const warnings = Array.isArray(draft.warnings)
    ? (draft.warnings as unknown[]).filter((w): w is string => typeof w === 'string')
    : []
  const itin = pkg?.itineraryItems ?? []
  const opts = pkg?.travelOptions ?? []
  const all = [...itin, ...opts]
  const serenataItems = all.filter(
    (r) => eventKind(`${r.title ?? ''} ${r.notes ?? ''}`) === 'serenata',
  )
  const fiestasItems = all.filter(
    (r) => eventKind(`${r.title ?? ''} ${r.notes ?? ''}`) === 'fiestas',
  )
  const serenataAffirms27 = serenataItems.some((r) =>
    affirmsConcreteDay(
      String(r.title ?? ''),
      String(r.notes ?? ''),
      r.startAt,
      '2026-09-27',
      '27',
    ),
  )
  const fiestasAffirms26 = fiestasItems.some((r) =>
    affirmsConcreteDay(
      String(r.title ?? ''),
      String(r.notes ?? ''),
      r.startAt,
      '2026-09-26',
      '26',
    ),
  )
  const narrSerenata27 =
    /serenata[^\n.]{0,80}27\s+de\s+septiembre/i.test(narrative) &&
    !/serenata[^\n.]{0,100}(pendiente|tentativa)/i.test(narrative)
  const narrFiestas26 =
    /fiestas?[^\n.]{0,80}26\s+de\s+septiembre/i.test(narrative) &&
    !/fiestas?[^\n.]{0,100}(pendiente|tentativa)/i.test(narrative)

  const flights = opts.filter((o) => o.type === 'flight')
  const scheduleFlights = flights.filter((o) => o.sourceType === 'flight_schedule')

  return {
    label,
    packageDates: pkg
      ? { startDate: pkg.trip?.startDate, endDate: pkg.trip?.endDate }
      : null,
    serenataItemCount: serenataItems.length,
    fiestasItemCount: fiestasItems.length,
    serenataAffirms27: serenataAffirms27 || narrSerenata27,
    fiestasAffirms26: fiestasAffirms26 || narrFiestas26,
    intentKept:
      (serenataItems.length > 0 || /serenata/i.test(narrative)) &&
      (fiestasItems.length > 0 || /fiestas?\s+patronales/i.test(narrative)),
    serenataSample: serenataItems.slice(0, 2).map((r) => ({
      title: r.title,
      startAt: r.startAt ?? null,
      notes: String(r.notes ?? '').slice(0, 220),
      verificationStatus: r.verificationStatus ?? null,
    })),
    fiestasSample: fiestasItems.slice(0, 2).map((r) => ({
      title: r.title,
      startAt: r.startAt ?? null,
      notes: String(r.notes ?? '').slice(0, 220),
      verificationStatus: r.verificationStatus ?? null,
    })),
    demoteWarnings: warnings.filter((w) =>
      /evento externo|fecha tentativa|pendiente de verificar|no afirmar|degradada/i.test(
        w,
      ),
    ),
    flights: {
      total: flights.length,
      flightScheduleCount: scheduleFlights.length,
      sample: scheduleFlights.slice(0, 4).map((f) => ({
        title: f.title,
        sourceType: f.sourceType,
        startAt: f.startAt,
        externalId: f.externalId,
      })),
    },
  }
}

async function main() {
  loadSecrets()
  process.env.LLM_PROVIDER ||= 'openai-compatible'
  process.env.LLM_BASE_URL ||= 'https://api.openai.com/v1'
  process.env.LLM_MODEL ||= 'gpt-4.1-mini'
  process.env.ENABLE_WEB_TOOLS ||= '1'
  process.env.WEB_SEARCH_PROVIDER ||= 'tavily'

  const before = tripSnapshot()
  const context = buildContext()

  const cfg = loadLlmEnv()
  const llm = new OpenAICompatibleProvider(
    cfg.model,
    cfg.baseUrl,
    cfg.apiKey,
    cfg.maxTokens,
  )

  const drafts: string[] = []
  const origChat = llm.chat.bind(llm)
  llm.chat = async (params) => {
    const result = await origChat(params)
    if (params.response_format && result.message.content) {
      drafts.push(result.message.content)
    }
    return result
  }

  const req: AgentAskRequest = {
    prompt: PROMPT,
    tripId: TRIP_ID,
    locale: 'es-MX',
    mode: 'ask',
    context,
  }

  const t0 = Date.now()
  let toolTrace: ToolTraceEntry[] = []
  let runError: Record<string, unknown> | null = null
  let proposalOk = false

  try {
    const { proposal, meta } = await runAgentAsk(req, { llm, cfg })
    toolTrace = meta.toolTrace
    proposalOk = Boolean(proposal)
  } catch (e) {
    const err = e as AgentRuntimeError
    toolTrace = (err.runMeta?.toolTrace as ToolTraceEntry[]) ?? []
    runError = {
      code: err.code,
      message: err.message?.slice(0, 2500),
    }
  }

  const after = tripSnapshot()

  let lastDraft: Record<string, unknown> | null = null
  for (let i = drafts.length - 1; i >= 0; i--) {
    try {
      const text = drafts[i]!
      const start = text.indexOf('{')
      lastDraft = JSON.parse(start >= 0 ? text.slice(start) : text)
      break
    } catch {
      /* try earlier */
    }
  }

  let beforeDemote = null as ReturnType<typeof analyzePackage> | null
  let afterDemote = null as ReturnType<typeof analyzePackage> | null
  let groundingOnDemoted: ReturnType<typeof assertDraftGrounded> | null = null
  let demoteWarnings: string[] = []

  if (lastDraft?.package) {
    const stamped = stampProvenScheduleOptions(lastDraft.package, toolTrace)
    lastDraft.package = stamped.package
    beforeDemote = analyzePackage(structuredClone(lastDraft), 'llm_draft_before_demote')
    demoteWarnings = demoteUnverifiedExternalEventDates(
      lastDraft,
      toolTrace,
      context,
    )
    afterDemote = analyzePackage(lastDraft, 'after_server_demote')
    groundingOnDemoted = assertDraftGrounded(lastDraft, toolTrace, context)
  }

  const webEventEvidence = toolTrace.some((t) => {
    if (t.tool !== 'webSearch' && t.tool !== 'fetchUrl') return false
    if (!t.ok) return false
    return (t.sources ?? []).some((s) => {
      const blob = `${s.title ?? ''} ${s.snippet ?? ''}`.toLowerCase()
      return (
        (/serenata/.test(blob) && /\b27\b/.test(blob)) ||
        (/patronal/.test(blob) && /\b26\b/.test(blob))
      )
    })
  })

  const eventPass =
    afterDemote &&
    !afterDemote.serenataAffirms27 &&
    !afterDemote.fiestasAffirms26 &&
    afterDemote.intentKept

  const flightPass = (afterDemote?.flights.flightScheduleCount ?? 0) > 0
  const demotedGroundingOk = groundingOnDemoted?.ok === true
  const tripUnchanged =
    before.startDate === after.startDate &&
    before.endDate === after.endDate &&
    before.startDate === '2026-09-19' &&
    before.endDate === '2026-09-22'

  const report = {
    smoke: 'event-date-ask-travel',
    tripId: TRIP_ID,
    elapsedMs: Date.now() - t0,
    proposalReturned: proposalOk,
    runError,
    webEventEvidence,
    tripBefore: before,
    tripAfter: after,
    realTripUnchanged: tripUnchanged,
    scheduleTools: toolTrace
      .filter((t) => t.tool === 'searchFlightSchedules')
      .map((t) => ({ ok: t.ok, sources: t.sources?.length ?? 0 })),
    beforeDemote,
    afterDemote,
    demoteWarnings,
    demotedDraftGrounding: groundingOnDemoted
      ? {
          ok: groundingOnDemoted.ok,
          code: groundingOnDemoted.ok ? undefined : groundingOnDemoted.code,
          message: groundingOnDemoted.ok
            ? undefined
            : groundingOnDemoted.message?.slice(0, 800),
          serverWarnings: groundingOnDemoted.ok
            ? groundingOnDemoted.serverWarnings.slice(0, 12)
            : groundingOnDemoted.warnings?.slice(0, 12),
        }
      : null,
    pass: {
      noSerenata27Fact: Boolean(afterDemote && !afterDemote.serenataAffirms27),
      noFiestas26Fact: Boolean(afterDemote && !afterDemote.fiestasAffirms26),
      intentKept: Boolean(afterDemote?.intentKept),
      flightScheduleOk: flightPass,
      tripUnchanged,
      eventDateGate: Boolean(eventPass),
      demotedDraftGroundingOk: demotedGroundingOk,
    },
  }

  writeFileSync(
    '/tmp/ask-travel-event-date-smoke.json',
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report, null, 2))

  const critical = [
    report.pass.noSerenata27Fact,
    report.pass.noFiestas26Fact,
    report.pass.intentKept,
    report.pass.flightScheduleOk,
    report.pass.tripUnchanged,
    report.pass.eventDateGate,
  ]
  if (!critical.every(Boolean)) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

/**
 * Diagnose residual operational assertion: transport_mode: traslado
 * Ask Travel date-update on persisted trip bd4d0e9a-…
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runAgentAsk } from '../travel-agent/src/agent/runtime.ts'
import { loadLlmEnv } from '../travel-agent/src/llm/config.ts'
import { OpenAICompatibleProvider } from '../travel-agent/src/llm/openaiCompatible.ts'
import {
  assertDraftGrounded,
  extractOperationalSignals,
  scrubOperationalFreeText,
  applyClaimsSourceOfTruth,
  validateClaimsAgainstToolTrace,
  sanitizeLlmClaimInput,
  agentClaimLlmSchema,
} from '../travel-agent/src/agent/claims.ts'
import {
  augmentContextWithProvenFlightSchedules,
  stampProvenScheduleOptions,
} from '../travel-agent/src/flights/mergeSchedules.ts'
import type { AgentAskRequest, ToolTraceEntry } from '../shared/agentContracts.ts'
import { AgentRuntimeError } from '../travel-agent/src/llm/config.ts'

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

function findTrasladoContext(text: string): string[] {
  const parts = text.split(/(?<=[.!?…\n])\s+/)
  return parts.filter((p) => /\btraslado|\btransfer\b/i.test(p))
}

async function main() {
  loadSecrets()
  process.env.LLM_PROVIDER ||= 'openai-compatible'
  process.env.LLM_BASE_URL ||= 'https://api.openai.com/v1'
  process.env.LLM_MODEL ||= 'gpt-4.1-mini'
  process.env.ENABLE_WEB_TOOLS ||= '1'
  process.env.WEB_SEARCH_PROVIDER ||= 'tavily'

  const cfg = loadLlmEnv()
  const context = buildContext()
  const req: AgentAskRequest = {
    prompt: PROMPT,
    tripId: TRIP_ID,
    locale: 'es-MX',
    mode: 'ask',
    context,
  }

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

  const t0 = Date.now()
  let toolTrace: ToolTraceEntry[] = []
  let outcome: Record<string, unknown>
  try {
    const { proposal, meta } = await runAgentAsk(req, { llm, cfg })
    toolTrace = meta.toolTrace
    outcome = {
      status: 'succeeded',
      elapsedMs: Date.now() - t0,
      llmCalls: meta.llmCalls,
      hadRepair: meta.hadRepair,
      narrative: proposal?.narrative,
      flightCount: proposal?.package.travelOptions.filter((o) => o.type === 'flight')
        .length,
    }
  } catch (e) {
    const err = e as AgentRuntimeError
    toolTrace = (err.runMeta?.toolTrace as ToolTraceEntry[]) ?? []
    outcome = {
      status: 'failed',
      elapsedMs: Date.now() - t0,
      code: err.code,
      message: err.message?.slice(0, 2500),
      warnings: err.runMeta ? undefined : undefined,
    }
  }

  const draftReports = []
  for (let di = 0; di < drafts.length; di++) {
    let draft: Record<string, unknown>
    try {
      const text = drafts[di]!
      const start = text.indexOf('{')
      draft = JSON.parse(start >= 0 ? text.slice(start) : text)
    } catch {
      continue
    }

    const narrativeBefore = String(draft.narrative ?? '')
    const trasladoSentences = findTrasladoContext(narrativeBefore)
    const narrativeSignals = extractOperationalSignals(narrativeBefore, 'narrativa')
    const trasladoSignals = narrativeSignals.filter(
      (s) => s.kind === 'transport_mode' && /traslado|transfer/i.test(s.text),
    )

    const stamped = stampProvenScheduleOptions(draft.package, toolTrace)
    draft.package = stamped.package
    const groundingContext = augmentContextWithProvenFlightSchedules(
      context,
      draft.package,
      toolTrace,
    )

    const rawClaims = Array.isArray(draft.claims) ? draft.claims : []
    const llmClaims = rawClaims
      .map((c) => agentClaimLlmSchema.safeParse(sanitizeLlmClaimInput(c)))
      .filter((p) => p.success)
      .map((p) => p.data)

    const { valid, invalid } = validateClaimsAgainstToolTrace(
      llmClaims,
      toolTrace,
      groundingContext,
    )

    // Simulate SoT scrub then residual scan like assertDraftGrounded
    const clone = structuredClone(draft) as Record<string, unknown>
    clone.claims = valid
    const { draft: rewritten } = applyClaimsSourceOfTruth(clone, valid)
    const narrativeAfter = String(rewritten.narrative ?? '')
    const afterScrubSignals = extractOperationalSignals(narrativeAfter, 'narrativa')
    const residualTraslado = afterScrubSignals.filter(
      (s) => s.kind === 'transport_mode' && /traslado|transfer/i.test(s.text),
    )

    const pkg = draft.package as Record<string, unknown>
    const travelOptions = Array.isArray(pkg?.travelOptions) ? pkg.travelOptions : []
    const itineraryItems = Array.isArray(pkg?.itineraryItems) ? pkg.itineraryItems : []
    const relatedOptions = travelOptions.filter((o) => {
      const r = o as Record<string, unknown>
      const blob = JSON.stringify(r).toLowerCase()
      return (
        blob.includes('traslado') ||
        blob.includes('transfer') ||
        blob.includes('san miguel') ||
        (String(r.type) === 'ground' || String(r.type) === 'bus' || String(r.type) === 'car')
      )
    })
    const relatedItinerary = itineraryItems.filter((o) => {
      const blob = JSON.stringify(o).toLowerCase()
      return blob.includes('traslado') || blob.includes('transfer') || blob.includes('san miguel')
    })

    const dexieTransferish = context.travelOptions.filter((o) => {
      const r = o as Record<string, unknown>
      const blob = `${r.title ?? ''} ${r.type ?? ''} ${r.notes ?? ''}`.toLowerCase()
      return (
        blob.includes('traslado') ||
        blob.includes('transfer') ||
        blob.includes('san miguel') ||
        String(r.type) === 'ground' ||
        String(r.type) === 'bus'
      )
    })

    const g = assertDraftGrounded(structuredClone(draft), toolTrace, context, {
      allowSkeletonPackage: false,
      userPrompt: PROMPT,
    })

    draftReports.push({
      draftIndex: di,
      narrativeBefore,
      narrativeAfterScrub: narrativeAfter,
      trasladoSentences,
      narrativeSignals: narrativeSignals.map((s) => ({
        kind: s.kind,
        text: s.text,
        where: s.where,
        numbers: s.numbers,
        modes: s.modes,
      })),
      trasladoSignals,
      residualTrasladoAfterSoT: residualTraslado,
      claimsRaw: rawClaims,
      claimsValid: valid.map((c) => ({
        kind: c.kind,
        statement: c.statement,
        sourceType: c.sourceType,
        entityId: c.entityId,
        field: c.field,
        quotedFact: c.quotedFact?.slice(0, 200),
      })),
      claimsInvalid: invalid.map((v) => ({
        index: v.index,
        code: v.code,
        message: v.message,
      })),
      relatedPackageOptions: relatedOptions,
      relatedItinerary,
      dexieTransferish,
      scrubPreview: scrubOperationalFreeText(narrativeBefore).slice(0, 500),
      groundingOk: g.ok,
      groundingCode: g.ok ? null : g.code,
      groundingMessage: g.ok ? null : g.message?.slice(0, 800),
      groundingWarnings: g.ok ? g.serverWarnings?.slice(0, 20) : g.warnings?.slice(0, 20),
      uncoveredSignals: g.ok ? [] : g.uncoveredSignals,
    })
  }

  const report = {
    outcome,
    toolTraceSummary: toolTrace.map((t) => ({
      tool: t.tool,
      ok: t.ok,
      args:
        t.tool === 'searchFlightSchedules' || t.tool === 'webSearch'
          ? t.args
          : undefined,
      sourceCount: t.sources?.length ?? 0,
      sources: (t.sources ?? []).slice(0, 5).map((s) => ({
        url: s.url,
        title: s.title,
        snippet: s.snippet?.slice(0, 180),
      })),
    })),
    draftReports,
  }
  writeFileSync('/tmp/ask-travel-traslado-residual-diag.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

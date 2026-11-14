/**
 * Diagnostic: Ask Travel date-update on persisted trip — capture context_statement_mismatch.
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runAgentAsk } from '../travel-agent/src/agent/runtime.ts'
import { loadLlmEnv } from '../travel-agent/src/llm/config.ts'
import { OpenAICompatibleProvider } from '../travel-agent/src/llm/openaiCompatible.ts'
import {
  assertDraftGrounded,
  normalizeEvidenceText,
  sanitizeLlmClaimInput,
  agentClaimLlmSchema,
  statementIncludesContextValue,
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
  const trip = kubectlJson(`/api/trips/${TRIP_ID}`) as AgentAskRequest['context']['trip']
  return {
    trip,
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

function resolveFieldValue(
  context: AgentAskRequest['context'],
  entityType: string,
  entityId: string | null | undefined,
  field: string,
): { source: 'dexie' | 'missing'; value?: string; entity?: Record<string, unknown> } {
  if (entityType === 'trip') {
    const v = (context.trip as Record<string, unknown>)[field]
    return {
      source: 'dexie',
      value: v == null ? undefined : String(v),
      entity: context.trip as unknown as Record<string, unknown>,
    }
  }
  if (entityType === 'travelOption') {
    const hit = context.travelOptions.find((o) => {
      const r = o as Record<string, unknown>
      return entityId === String(r.id ?? '') || entityId === String(r.externalId ?? '')
    }) as Record<string, unknown> | undefined
    if (!hit) return { source: 'missing' }
    const v = hit[field]
    return {
      source: 'dexie',
      value: v == null ? undefined : String(v),
      entity: hit,
    }
  }
  return { source: 'missing' }
}

function diagnoseClaim(
  claim: Record<string, unknown>,
  context: AgentAskRequest['context'],
  groundingContext: AgentAskRequest['context'],
  packageOpts: unknown[],
) {
  const entityType = String(claim.entityType ?? '')
  const entityId = claim.entityId == null ? null : String(claim.entityId)
  const field = String(claim.field ?? '')
  const statement = String(claim.statement ?? '')

  const inDexie = resolveFieldValue(context, entityType, entityId, field)
  const inGround = resolveFieldValue(groundingContext, entityType, entityId, field)
  const inPackage = packageOpts.find((o) => {
    const r = o as Record<string, unknown>
    return entityId === String(r.id ?? '') || entityId === String(r.externalId ?? '')
  }) as Record<string, unknown> | undefined

  const contextValue = inGround.value ?? inDexie.value ?? ''
  const normStmt = normalizeEvidenceText(statement)
  const normVal = normalizeEvidenceText(contextValue)
  const slice10 = normVal.slice(0, 10)
  const includesNatural = statementIncludesContextValue(statement, contextValue)

  const provenance =
    inDexie.source === 'dexie' && inDexie.value != null
      ? 'TripContextSnapshot (Dexie)'
      : inPackage
        ? 'package schedule-backed / proposal option'
        : inGround.source === 'dexie'
          ? 'augmented grounding context'
          : 'unknown/missing'

  return {
    claim,
    entityId,
    field,
    entityType,
    provenance,
    expectedContextValue: contextValue || null,
    statement,
    normStmt,
    normVal,
    slice10,
    includesFull: Boolean(normVal) && normStmt.includes(normVal),
    includesSlice10: Boolean(normVal) && normStmt.includes(slice10),
    includesNatural,
    whyFalse:
      !normVal
        ? 'empty_context_value'
        : includesNatural
          ? 'passes_statementIncludesContextValue'
          : `FAIL: statementIncludesContextValue=false for value="${contextValue}"`,
    packageOption: inPackage
      ? {
          externalId: inPackage.externalId,
          title: inPackage.title,
          startAt: inPackage.startAt,
          sourceType: inPackage.sourceType,
        }
      : null,
    dexieEntity: inDexie.entity
      ? {
          id: inDexie.entity.id,
          externalId: inDexie.entity.externalId,
          title: inDexie.entity.title,
          startAt: inDexie.entity.startAt,
          startDate: inDexie.entity.startDate,
          endDate: inDexie.entity.endDate,
        }
      : null,
  }
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
      toolTraceTools: toolTrace.map((t) => ({
        tool: t.tool,
        ok: t.ok,
        args: t.tool === 'searchFlightSchedules' ? t.args : undefined,
      })),
    }
  }

  const claimReports = []
  for (let di = 0; di < drafts.length; di++) {
    let draft: Record<string, unknown>
    try {
      const text = drafts[di]!
      const start = text.indexOf('{')
      draft = JSON.parse(start >= 0 ? text.slice(start) : text)
    } catch {
      continue
    }
    const stamped = stampProvenScheduleOptions(draft.package, toolTrace)
    draft.package = stamped.package
    const groundingContext = augmentContextWithProvenFlightSchedules(
      context,
      draft.package,
      toolTrace,
    )!
    const pkgOpts = Array.isArray((draft.package as { travelOptions?: unknown[] })?.travelOptions)
      ? ((draft.package as { travelOptions: unknown[] }).travelOptions)
      : []

    const claims = Array.isArray(draft.claims) ? draft.claims : []
    const perClaim = claims.map((c, index) => {
      const parsed = agentClaimLlmSchema.safeParse(sanitizeLlmClaimInput(c))
      const raw = parsed.success
        ? (parsed.data as unknown as Record<string, unknown>)
        : (c as Record<string, unknown>)
      return {
        index,
        parseOk: parsed.success,
        ...diagnoseClaim(raw, context, groundingContext, pkgOpts),
      }
    })

    const g = assertDraftGrounded(draft, toolTrace, context, {
      allowSkeletonPackage: false,
      userPrompt: PROMPT,
    })

    claimReports.push({
      draftIndex: di,
      groundingOk: g.ok,
      groundingCode: g.ok ? null : g.code,
      groundingMessage: g.ok ? null : g.message?.slice(0, 500),
      violations: g.ok
        ? []
        : g.violations.map((v) => ({
            index: v.index,
            code: v.code,
            message: v.message,
          })),
      perClaim,
    })
  }

  const report = { outcome, claimReports }
  writeFileSync('/tmp/ask-travel-statement-mismatch-diag.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

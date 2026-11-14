/**
 * Controlled E2E: Ask Travel ops generation on pre-Apply fixture (19→22).
 * Does NOT touch production trip persistence / Apply.
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runAgentAsk } from '../travel-agent/src/agent/runtime.ts'
import { loadLlmEnv, AgentRuntimeError } from '../travel-agent/src/llm/config.ts'
import { OpenAICompatibleProvider } from '../travel-agent/src/llm/openaiCompatible.ts'
import type {
  AgentAskRequest,
  AgentOpRecord,
  AgentProposal,
} from '../shared/agentContracts.ts'
import { agentOpRecordSchema } from '../shared/agentContracts.ts'
import {
  applyMutationInMemory,
  PackageMutationConflictError,
  PackageMutationValidationError,
  parseImportBody,
  validateMutationOps,
} from '../trip-api/src/packageMutation.ts'
import { optionEntityId } from '../trip-api/src/tripPackage.ts'
import type { TravelOption } from '../trip-api/src/domainTypes.ts'
import type { TripPackageV1 } from '../trip-api/src/tripPackage.ts'

const TRIP_ID = 'bd4d0e9a-b5df-4dbc-bb7e-ce6f869aae28'
const PKG_ID = TRIP_ID

const PROMPT = `Cambiaron mis planes. Quiero actualizar este mismo viaje, no crear uno nuevo.
Mantén como objetivo principal asistir a las fiestas patronales y a la serenata tradicional de San Miguel el Alto, Jalisco.
Cambia las fechas del viaje al viernes 25 de septiembre de 2026 al lunes 28 de septiembre de 2026.
Usa Guadalajara como ciudad pivote. Busca vuelos directos MEX → GDL para el viernes 25, preferentemente entre 11:00 y 15:00, y GDL → MEX para el lunes 28.
Mi intención es hospedarme en San Miguel el Alto si encuentro disponibilidad. Si no encuentro alojamiento allí, Guadalajara debe quedar como alternativa de hospedaje.
Conserva del viaje actual toda la información que siga siendo válida y sustituye únicamente lo que haya quedado obsoleto por el cambio de fechas.
Antes de aplicar los cambios, muéstrame claramente qué propones modificar.
IMPORTANTE: en ops[] usa supersede/remove con los externalId existentes (outbound-flight-1, return-flight-1, return-flight-2) — la ausencia en package no elimina nada.
IMPORTANTE: reutiliza lodge-skeleton-1 y ground-transfer-1 con el MISMO externalId (op=update). No crees lodge-skeleton-2/3.`

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

function fixtureContext(): AgentAskRequest['context'] {
  const trip = {
    id: TRIP_ID,
    title: 'Viaje a San Miguel el Alto para serenata 2026',
    destination: 'San Miguel el Alto, Jalisco',
    startDate: '2026-09-19',
    endDate: '2026-09-22',
    timezone: 'America/Mexico_City',
    goals: [
      {
        id: 'g1',
        label:
          'Asistir a las fiestas patronales y a la serenata tradicional en San Miguel el Alto, Jalisco',
      },
    ],
    status: 'planned' as const,
  }
  const travelOptions = [
    {
      id: optionEntityId(PKG_ID, 'outbound-flight-1'),
      tripId: TRIP_ID,
      type: 'flight' as const,
      status: 'shortlisted' as const,
      title: 'Vuelo estimado directo MEX → GDL el domingo 20 de septiembre 2026',
      startAt: '2026-09-20T07:00:00-06:00',
      origin: 'MEX',
      destination: 'GDL',
      sourceType: 'agent' as const,
      externalId: 'outbound-flight-1',
      packageId: PKG_ID,
      verificationStatus: 'estimated' as const,
    },
    {
      id: optionEntityId(PKG_ID, 'return-flight-1'),
      tripId: TRIP_ID,
      type: 'flight' as const,
      status: 'shortlisted' as const,
      title: 'Vuelo estimado directo GDL → MEX el martes 22 de septiembre 2026',
      startAt: '2026-09-22T12:00:00-06:00',
      origin: 'GDL',
      destination: 'MEX',
      sourceType: 'agent' as const,
      externalId: 'return-flight-1',
      packageId: PKG_ID,
      verificationStatus: 'estimated' as const,
    },
    {
      id: optionEntityId(PKG_ID, 'return-flight-2'),
      tripId: TRIP_ID,
      type: 'flight' as const,
      status: 'researched' as const,
      title:
        'Vuelo estimado directo GDL → MEX el lunes 21 de septiembre 2026 (alternativa)',
      startAt: '2026-09-21T12:00:00-06:00',
      origin: 'GDL',
      destination: 'MEX',
      sourceType: 'agent' as const,
      externalId: 'return-flight-2',
      packageId: PKG_ID,
      verificationStatus: 'estimated' as const,
    },
    {
      id: optionEntityId(PKG_ID, 'lodge-skeleton-1'),
      tripId: TRIP_ID,
      type: 'lodging' as const,
      status: 'researched' as const,
      title: 'Hospedaje San Miguel el Alto, Jalisco (estimado · 3 noche(s))',
      startAt: '2026-09-19T15:00:00-06:00',
      endAt: '2026-09-22T12:00:00-06:00',
      sourceType: 'agent' as const,
      externalId: 'lodge-skeleton-1',
      packageId: PKG_ID,
      verificationStatus: 'estimated' as const,
    },
    {
      id: optionEntityId(PKG_ID, 'ground-transfer-1'),
      tripId: TRIP_ID,
      type: 'transfer' as const,
      status: 'researched' as const,
      title: 'Traslado terrestre estimado Guadalajara → San Miguel el Alto',
      sourceType: 'agent' as const,
      externalId: 'ground-transfer-1',
      packageId: PKG_ID,
      verificationStatus: 'estimated' as const,
    },
  ]
  return {
    trip,
    travelOptions,
    itineraryItems: [
      {
        id: `itin-${PKG_ID}-itinerary-serenata-20sep`,
        tripId: TRIP_ID,
        title: 'Serenata tradicional en la plaza de San Miguel el Alto',
        startAt: '2026-09-20T20:00:00-06:00',
        notes: 'Objetivo del viajero — pendiente de verificar con fuente actual',
      },
    ],
    checklistItems: [],
    notes: [],
    bookings: [],
    packageImports: [
      {
        id: PKG_ID,
        tripId: TRIP_ID,
        title: trip.title,
        importedAt: '2026-09-20T00:20:51.639Z',
        optionCount: 5,
        schemaVersion: 1,
        revision: 1,
        generatedAt: '2026-09-19T12:00:00Z',
      },
    ],
  }
}

function existingFromContext(
  ctx: AgentAskRequest['context'],
): TravelOption[] {
  return ctx.travelOptions.map((o) => {
    const r = o as Record<string, unknown>
    return {
      id: String(r.id),
      tripId: TRIP_ID,
      type: r.type as TravelOption['type'],
      status: r.status as TravelOption['status'],
      title: String(r.title),
      startAt: r.startAt as string | undefined,
      endAt: r.endAt as string | undefined,
      origin: r.origin as string | undefined,
      destination: r.destination as string | undefined,
      sourceType: r.sourceType as TravelOption['sourceType'],
      externalId: String(r.externalId),
      packageId: String(r.packageId ?? PKG_ID),
      verificationStatus: r.verificationStatus as TravelOption['verificationStatus'],
      createdAt: '2026-09-19T00:00:00.000Z',
      updatedAt: '2026-09-19T00:00:00.000Z',
      syncStatus: 'synced' as const,
    }
  })
}

function analyzeOps(
  ops: AgentOpRecord[],
  pkg: TripPackageV1 | undefined,
): Record<string, unknown> {
  const travelOps = ops.filter((o) => o.entityKind === 'travelOption')
  const supersedes = travelOps.filter((o) => o.op === 'supersede')
  const removes = travelOps.filter((o) => o.op === 'remove')
  const updates = travelOps.filter((o) => o.op === 'update')
  const adds = travelOps.filter((o) => o.op === 'add')

  const pkgExt = new Set((pkg?.travelOptions ?? []).map((o) => o.externalId))

  const supersedeOutbound = supersedes.find(
    (o) => o.supersedesExternalId === 'outbound-flight-1',
  )
  const supersedeReturn = supersedes.find(
    (o) => o.supersedesExternalId === 'return-flight-1',
  )
  const removeAlt = removes.find((o) => o.externalId === 'return-flight-2')
  const updateLodge = updates.find((o) => o.externalId === 'lodge-skeleton-1')
  const touchesTransfer = travelOps.some(
    (o) =>
      o.externalId === 'ground-transfer-1' ||
      o.supersedesExternalId === 'ground-transfer-1',
  )
  const removesTransfer = removes.some((o) => o.externalId === 'ground-transfer-1')

  return {
    rawOps: ops,
    travelOpsCount: travelOps.length,
    supersedes: supersedes.map((o) => ({
      new: o.externalId,
      old: o.supersedesExternalId,
    })),
    removes: removes.map((o) => o.externalId),
    updates: updates.map((o) => o.externalId),
    adds: adds.map((o) => o.externalId),
    expectations: {
      supersedeOutboundFlight1: Boolean(supersedeOutbound),
      supersedeOutboundNewInPackage: supersedeOutbound
        ? pkgExt.has(supersedeOutbound.externalId)
        : false,
      supersedeReturnFlight1: Boolean(supersedeReturn),
      supersedeReturnNewInPackage: supersedeReturn
        ? pkgExt.has(supersedeReturn.externalId)
        : false,
      removeReturnFlight2: Boolean(removeAlt),
      removeReturnFlight2NotInPackage: removeAlt
        ? !pkgExt.has('return-flight-2')
        : false,
      updateOrPreserveLodge:
        Boolean(updateLodge) || pkgExt.has('lodge-skeleton-1'),
      lodgeNotDuplicated:
        !pkgExt.has('lodge-skeleton-2') &&
        !pkgExt.has('lodge-skeleton-3') &&
        (pkgExt.has('lodge-skeleton-1') || Boolean(updateLodge)),
      groundTransferNotRemoved: !removesTransfer,
      groundTransferInPackageOrUntouched:
        pkgExt.has('ground-transfer-1') || !touchesTransfer,
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

  const context = fixtureContext()
  const existing = existingFromContext(context)

  // Snapshot prod trip (must remain unchanged)
  const prodBefore = execSync(
    `kubectl -n tool4trip exec deploy/trip-api -- wget -qO- http://127.0.0.1:8080/api/trips/${TRIP_ID}`,
    { encoding: 'utf8' },
  )

  const cfg = loadLlmEnv()
  const llm = new OpenAICompatibleProvider(
    cfg.model,
    cfg.baseUrl,
    cfg.apiKey,
    cfg.maxTokens,
  )

  const drafts: string[] = []
  const orig = llm.chat.bind(llm)
  llm.chat = async (params) => {
    const result = await orig(params)
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
  let proposal: AgentProposal | null = null
  let runError: Record<string, unknown> | null = null

  try {
    const out = await runAgentAsk(req, { llm, cfg })
    proposal = out.proposal
  } catch (e) {
    const err = e as AgentRuntimeError
    runError = { code: err.code, message: err.message?.slice(0, 2000) }
    // Recover last draft if grounding failed after structured output
    for (let i = drafts.length - 1; i >= 0; i--) {
      try {
        const text = drafts[i]!
        const start = text.indexOf('{')
        const draft = JSON.parse(start >= 0 ? text.slice(start) : text)
        if (draft?.package && Array.isArray(draft.ops)) {
          proposal = {
            proposalId: 'draft-capture',
            createdAt: new Date().toISOString(),
            narrative: String(draft.narrative ?? ''),
            warnings: draft.warnings ?? [],
            diffSummary: draft.diffSummary ?? [],
            package: draft.package,
            ops: draft.ops,
            toolTrace: (err.runMeta?.toolTrace as AgentProposal['toolTrace']) ?? [],
          } as AgentProposal
          break
        }
      } catch {
        /* continue */
      }
    }
  }

  const opsRaw = proposal?.ops ?? []
  const opsParsed: AgentOpRecord[] = []
  const opsParseErrors: string[] = []
  for (const o of opsRaw) {
    const p = agentOpRecordSchema.safeParse(o)
    if (p.success) opsParsed.push(p.data)
    else opsParseErrors.push(p.error.message.slice(0, 200))
  }

  const pkg = proposal?.package as TripPackageV1 | undefined
  const analysis = analyzeOps(opsParsed, pkg)

  const expectations = analysis.expectations as Record<string, boolean>
  const opsGenerationPass = Boolean(
    expectations.supersedeOutboundFlight1 &&
      expectations.supersedeOutboundNewInPackage &&
      expectations.supersedeReturnFlight1 &&
      expectations.supersedeReturnNewInPackage &&
      expectations.removeReturnFlight2 &&
      expectations.removeReturnFlight2NotInPackage &&
      expectations.updateOrPreserveLodge &&
      expectations.lodgeNotDuplicated &&
      expectations.groundTransferNotRemoved,
  )

  // B) Execute GENERATED ops only (isolated in-memory) — never invent ops
  let e2e: Record<string, unknown> | null = null
  let opsValidation: Record<string, unknown> | null = null

  if (pkg && opsParsed.length) {
    try {
      const plan = validateMutationOps({
        pkg,
        tripId: TRIP_ID,
        ops: opsParsed,
        existingOptions: existing,
      })
      opsValidation = { ok: true, plan }
    } catch (e) {
      opsValidation = {
        ok: false,
        error:
          e instanceof Error
            ? { name: e.name, message: e.message }
            : String(e),
      }
    }

    if (opsValidation?.ok) {
      try {
        const result = applyMutationInMemory({
          tripId: TRIP_ID,
          packageId: PKG_ID,
          existing,
          packageOptions: pkg.travelOptions.map((o) => ({
            externalId: o.externalId,
            type: o.type,
            status: o.status,
            title: o.title,
            startAt: o.startAt,
            endAt: o.endAt,
            sourceType: o.sourceType,
            sourceUrl: o.sourceUrl,
            provider: o.provider,
            verificationStatus: o.verificationStatus,
            notes: o.notes,
          })),
          ops: opsParsed,
        })
        const byExt = (e: string) =>
          result.options.find((o) => o.externalId === e)
        const scheduleFlights = result.options.filter(
          (o) => o.type === 'flight' && o.sourceType === 'flight_schedule',
        )
        e2e = {
          ok: true,
          externalIds: result.options.map((o) => o.externalId).sort(),
          removed: result.removedExternalIds.sort(),
          hasOutboundOld: Boolean(byExt('outbound-flight-1')),
          hasReturnOld: Boolean(byExt('return-flight-1')),
          hasReturnAlt: Boolean(byExt('return-flight-2')),
          hasLodge: Boolean(byExt('lodge-skeleton-1')),
          hasTransfer: Boolean(byExt('ground-transfer-1')),
          scheduleFlightCount: scheduleFlights.length,
          scheduleSample: scheduleFlights.map((f) => ({
            externalId: f.externalId,
            sourceType: f.sourceType,
            sourceUrl: f.sourceUrl,
            startAt: f.startAt,
          })),
          sameTrip: result.options.every((o) => o.tripId === TRIP_ID),
          pass:
            !byExt('outbound-flight-1') &&
            !byExt('return-flight-1') &&
            !byExt('return-flight-2') &&
            Boolean(byExt('lodge-skeleton-1')) &&
            !byExt('lodge-skeleton-2') &&
            !byExt('lodge-skeleton-3') &&
            Boolean(byExt('ground-transfer-1')) &&
            scheduleFlights.length >= 1 &&
            result.options.every((o) => o.tripId === TRIP_ID),
        }
      } catch (e) {
        e2e = {
          ok: false,
          error:
            e instanceof PackageMutationConflictError ||
            e instanceof PackageMutationValidationError
              ? { name: e.name, message: e.message }
              : e instanceof Error
                ? e.message
                : String(e),
        }
      }
    }
  }

  // Legacy compatibility check (no ops)
  const legacy = parseImportBody({
    schemaVersion: 1,
    packageId: PKG_ID,
    revision: 2,
    travelOptions: [],
  })
  const legacyCompat = {
    opsEmpty: legacy.ops.length === 0,
    note: 'legacy raw package → upsert-only, no deletes',
  }

  const prodAfter = execSync(
    `kubectl -n tool4trip exec deploy/trip-api -- wget -qO- http://127.0.0.1:8080/api/trips/${TRIP_ID}`,
    { encoding: 'utf8' },
  )
  const prodOptsAfter = execSync(
    `kubectl -n tool4trip exec deploy/trip-api -- wget -qO- http://127.0.0.1:8080/api/trips/${TRIP_ID}/travel-options`,
    { encoding: 'utf8' },
  )
  const beforeTrip = JSON.parse(prodBefore)
  const afterTrip = JSON.parse(prodAfter)
  const optCount = JSON.parse(prodOptsAfter).length

  const report = {
    elapsedMs: Date.now() - t0,
    runError,
    proposalReturned: Boolean(proposal),
    packageDates: pkg
      ? { startDate: pkg.trip?.startDate, endDate: pkg.trip?.endDate }
      : null,
    packageTravelExternalIds: (pkg?.travelOptions ?? []).map((o) => o.externalId),
    A_GENERATED_OPS: analysis,
    opsParseErrors,
    opsGenerationPass,
    B_OPS_VALIDATION: opsValidation,
    B_CONTROLLED_E2E: e2e,
    legacyCompat,
    realTripUnchanged:
      beforeTrip.updatedAt === afterTrip.updatedAt &&
      beforeTrip.startDate === afterTrip.startDate &&
      beforeTrip.endDate === afterTrip.endDate &&
      optCount === 7,
    prodSnapshot: {
      startDate: afterTrip.startDate,
      endDate: afterTrip.endDate,
      updatedAt: afterTrip.updatedAt,
      optionCount: optCount,
    },
    readyForCommit: Boolean(
      opsGenerationPass &&
        e2e &&
        (e2e as { pass?: boolean }).pass &&
        beforeTrip.updatedAt === afterTrip.updatedAt,
    ),
  }

  writeFileSync(
    '/tmp/ask-travel-ops-generation-e2e.json',
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report, null, 2))
  if (!report.readyForCommit) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

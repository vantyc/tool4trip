import {
  agentAskRequestSchema,
  agentJobCreateResponseSchema,
  agentJobStatusResponseSchema,
  agentProposalSchema,
  type AgentAskRequest,
  type AgentProposal,
} from '../../shared/agentContracts'
import type { Services } from './services'
import type { ImportUpdatePlan } from './packageImport'
import { enrichTripPackageAirportArrivals } from './airportArrivalEnrich'
import { validateTripPackage } from './tripPackage'
import { buildTripContextSnapshot } from './tripContextSnapshot'
import { httpRepositories } from '../data/repositories/httpRepositories'

export type { AgentProposal }

const POLL_MS = 2000
const POLL_MAX_MS = 5 * 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export type AskTravelProgress = {
  jobId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
}

async function postAgentAsk(
  body: AgentAskRequest,
  opts?: {
    onProgress?: (p: AskTravelProgress) => void
    signal?: AbortSignal
  },
): Promise<AgentProposal> {
  const res = await fetch('/api/agent/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
    signal: opts?.signal,
  })

  if (res.status === 401) {
    throw new Error('Sesión requerida — vuelve a iniciar sesión.')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `Error del agente (${res.status})`)
  }

  if (res.status === 200) {
    return agentProposalSchema.parse(await res.json())
  }

  const created = agentJobCreateResponseSchema.parse(await res.json())
  opts?.onProgress?.({ jobId: created.jobId, status: 'queued' })

  const t0 = Date.now()
  let waited = false
  while (Date.now() - t0 < POLL_MAX_MS) {
    if (opts?.signal?.aborted) {
      throw new Error('Consulta cancelada')
    }
    if (waited) await sleep(POLL_MS)
    waited = true
    const stRes = await fetch(
      `/api/agent/jobs/${encodeURIComponent(created.jobId)}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        signal: opts?.signal,
      },
    )
    if (stRes.status === 401) {
      throw new Error('Sesión requerida — vuelve a iniciar sesión.')
    }
    if (stRes.status === 404) {
      throw new Error('Trabajo del agente no encontrado (¿expiró?)')
    }
    if (!stRes.ok) {
      const text = await stRes.text().catch(() => '')
      throw new Error(text || `Error consultando job (${stRes.status})`)
    }
    const status = agentJobStatusResponseSchema.parse(await stRes.json())
    opts?.onProgress?.({ jobId: status.jobId, status: status.status })

    if (status.status === 'succeeded') {
      if (!status.proposal) {
        throw new Error('Job succeeded sin proposal')
      }
      return agentProposalSchema.parse(status.proposal)
    }
    if (status.status === 'failed') {
      throw new Error(status.error?.message || 'El agente falló sin detalle')
    }
  }

  throw new Error('Tiempo de espera agotado mientras investigaba')
}

/**
 * Async Ask Travel: POST → 202 jobId → poll GET /api/agent/jobs/:id.
 * Never auto-applies; caller shows proposal then Apply/Discard.
 */
export async function askTravelAgent(
  _services: Services,
  input: { tripId: string; prompt: string },
  opts?: {
    onProgress?: (p: AskTravelProgress) => void
    signal?: AbortSignal
  },
): Promise<AgentProposal> {
  const context = await buildTripContextSnapshot(
    httpRepositories,
    input.tripId,
  )
  const body: AgentAskRequest = agentAskRequestSchema.parse({
    prompt: input.prompt,
    tripId: input.tripId,
    context,
    locale: 'es',
    mode: 'ask',
  })
  return postAgentAsk(body, opts)
}

/** Empty snapshot shell for creating a brand-new trip (cloud SoT). */
function emptyNewTravelContext(tripId: string) {
  return {
    trip: {
      id: tripId,
      title: 'Nuevo viaje',
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      timezone: 'America/Mexico_City',
      goals: [],
      status: 'planned',
    },
    bookings: [],
    travelOptions: [],
    itineraryItems: [],
    checklistItems: [],
    notes: [],
    packageImports: [],
  }
}

/**
 * Nuevo viaje: natural-language prompt → TripPackage skeleton (async job).
 */
export async function newTravelAgent(
  _services: Services,
  input: { prompt: string; tripId?: string },
  opts?: {
    onProgress?: (p: AskTravelProgress) => void
    signal?: AbortSignal
  },
): Promise<AgentProposal> {
  const tripId =
    input.tripId ??
    (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `new-${Date.now()}`)
  const body: AgentAskRequest = agentAskRequestSchema.parse({
    prompt: input.prompt,
    tripId,
    context: emptyNewTravelContext(tripId),
    locale: 'es',
    mode: 'new_travel',
  })
  return postAgentAsk(body, opts)
}

export async function previewAgentProposal(
  services: Services,
  proposal: AgentProposal,
  opts?: {
    /**
     * Nuevo viaje drafts are never persisted yet. Skip remote existence probes
     * (avoids GET /api/package-imports/:id 404 on every generate).
     */
    assumeNewPackage?: boolean
  },
): Promise<{ plan: ImportUpdatePlan }> {
  const validated = validateTripPackage(proposal.package)
  if (!validated.ok) {
    throw new Error(
      validated.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
    )
  }
  const enriched = enrichTripPackageAirportArrivals(validated.package)
  if (opts?.assumeNewPackage) {
    return {
      plan: {
        isUpdate: false,
        packageId: enriched.packageId,
        revision: enriched.revision,
        tripId: enriched.trip.id ?? null,
        created: enriched.travelOptions.length,
        updated: 0,
        unchanged: 0,
        decisionsPreserved: 0,
      },
    }
  }
  const plan = await services.packages.planImport(enriched)
  return { plan }
}

export async function applyAgentProposal(
  services: Services,
  proposal: AgentProposal,
): Promise<{ tripId: string }> {
  const validated = validateTripPackage(proposal.package)
  if (!validated.ok) {
    throw new Error(
      validated.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
    )
  }
  const result = await services.packages.importPackage(validated.package)
  return { tripId: result.tripId }
}

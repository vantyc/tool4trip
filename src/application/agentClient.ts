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
import { validateTripPackage } from './tripPackage'
import { buildTripContextSnapshot } from './tripContextSnapshot'
import { localRepositories } from '../data/repositories'

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
    localRepositories,
    input.tripId,
  )
  const body: AgentAskRequest = agentAskRequestSchema.parse({
    prompt: input.prompt,
    tripId: input.tripId,
    context,
    locale: 'es',
  })

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

  // Legacy sync rollback path (200 + proposal body).
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
    const stRes = await fetch(`/api/agent/jobs/${encodeURIComponent(created.jobId)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal: opts?.signal,
    })
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
      throw new Error(
        status.error?.message || 'El agente falló sin detalle',
      )
    }
  }

  throw new Error('Tiempo de espera agotado mientras investigaba')
}

export async function previewAgentProposal(
  services: Services,
  proposal: AgentProposal,
): Promise<{ plan: ImportUpdatePlan }> {
  const validated = validateTripPackage(proposal.package)
  if (!validated.ok) {
    throw new Error(
      validated.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
    )
  }
  const plan = await services.packages.planImport(validated.package)
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

import {
  agentAskRequestSchema,
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

export async function askTravelAgent(
  _services: Services,
  input: { tripId: string; prompt: string },
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
  })

  if (res.status === 401) {
    throw new Error('Sesión requerida — vuelve a iniciar sesión.')
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `Error del agente (${res.status})`)
  }

  const json: unknown = await res.json()
  return agentProposalSchema.parse(json)
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

import type { AgentAskRequest, AgentProposal } from '../shared/agentContracts.ts'
import {
  assertLlmReady,
  assertWebSearchReady,
  loadLlmEnv,
  type LlmEnvConfig,
} from './llm/config.ts'
import { OpenAICompatibleProvider } from './llm/openaiCompatible.ts'
import type { LLMProvider } from './llm/types.ts'
import {
  runAgentAsk,
  type AgentRunResult,
  type AgentRuntimeDeps,
} from './agent/runtime.ts'

export type BuildProposalDeps = {
  cfg?: LlmEnvConfig
  llm?: LLMProvider
  jobId?: string
  requestId?: string
}

/**
 * Entry used by HTTP/job worker — AgentRuntime only (no heuristic wantsResearch).
 */
export async function buildProposal(
  req: AgentAskRequest,
  deps: BuildProposalDeps = {},
): Promise<AgentProposal> {
  const result = await buildProposalWithMeta(req, deps)
  return result.proposal
}

export async function buildProposalWithMeta(
  req: AgentAskRequest,
  deps: BuildProposalDeps = {},
): Promise<AgentRunResult> {
  const cfg = deps.cfg ?? loadLlmEnv()
  assertLlmReady(cfg)
  if (cfg.enableWebTools) {
    assertWebSearchReady(cfg)
  }

  const llm =
    deps.llm ??
    new OpenAICompatibleProvider(
      cfg.model,
      cfg.baseUrl,
      cfg.apiKey,
      cfg.maxTokens,
    )

  const runDeps: AgentRuntimeDeps = {
    llm,
    cfg,
    jobId: deps.jobId,
    requestId: deps.requestId,
    tripId: req.tripId,
  }

  return runAgentAsk(req, runDeps)
}

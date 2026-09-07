import type { AgentAskRequest, AgentProposal } from '../shared/agentContracts.ts'
import {
  assertLlmReady,
  assertWebSearchReady,
  loadLlmEnv,
  type LlmEnvConfig,
} from './llm/config.ts'
import { OpenAICompatibleProvider } from './llm/openaiCompatible.ts'
import type { LLMProvider } from './llm/types.ts'
import { runAgentAsk } from './agent/runtime.ts'

export type BuildProposalDeps = {
  cfg?: LlmEnvConfig
  llm?: LLMProvider
}

/**
 * Entry used by HTTP handler — AgentRuntime only (no heuristic wantsResearch).
 */
export async function buildProposal(
  req: AgentAskRequest,
  deps: BuildProposalDeps = {},
): Promise<AgentProposal> {
  const cfg = deps.cfg ?? loadLlmEnv()
  assertLlmReady(cfg)
  if (cfg.enableWebTools) {
    assertWebSearchReady(cfg)
  }

  const llm =
    deps.llm ??
    new OpenAICompatibleProvider(cfg.model, cfg.baseUrl, cfg.apiKey)

  return runAgentAsk(req, { llm, cfg })
}

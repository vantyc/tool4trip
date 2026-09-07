import type { LLMProvider } from './types.ts'

export class AgentConfigError extends Error {
  readonly code = 'agent_config'

  constructor(message: string) {
    super(message)
    this.name = 'AgentConfigError'
  }
}

export class AgentRuntimeError extends Error {
  readonly code: string

  constructor(message: string, code = 'agent_runtime') {
    super(message)
    this.name = 'AgentRuntimeError'
    this.code = code
  }
}

export type LlmEnvConfig = {
  provider: string
  baseUrl: string
  model: string
  apiKey: string
  tavilyApiKey: string
  timeoutMs: number
  maxToolCalls: number
  maxSteps: number
  enableWebTools: boolean
  webSearchProvider: string
  enableDdgFallback: boolean
}

export function loadLlmEnv(
  env: NodeJS.ProcessEnv = process.env,
): LlmEnvConfig {
  const provider = (env.LLM_PROVIDER || 'openai-compatible').trim()
  const baseUrl = (env.LLM_BASE_URL || '').trim().replace(/\/$/, '')
  const model = (env.LLM_MODEL || '').trim()
  const apiKey = (env.LLM_API_KEY || '').trim()
  const tavilyApiKey = (env.TAVILY_API_KEY || '').trim()
  const timeoutMs = positiveInt(env.LLM_TIMEOUT_MS, 60_000)
  const maxToolCalls = positiveInt(env.AGENT_MAX_TOOL_CALLS, 6)
  const maxSteps = positiveInt(env.AGENT_MAX_STEPS, 8)
  const enableWebTools = env.ENABLE_WEB_TOOLS !== '0'
  const webSearchProvider = (env.WEB_SEARCH_PROVIDER || 'tavily').trim().toLowerCase()
  const enableDdgFallback = env.ENABLE_DDG_FALLBACK === '1'

  return {
    provider,
    baseUrl,
    model,
    apiKey,
    tavilyApiKey,
    timeoutMs,
    maxToolCalls,
    maxSteps,
    enableWebTools,
    webSearchProvider,
    enableDdgFallback,
  }
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

/** Fail fast before calling the LLM if env is incomplete. Does not log secrets. */
export function assertLlmReady(cfg: LlmEnvConfig): void {
  if (cfg.provider !== 'openai-compatible') {
    throw new AgentConfigError(
      `LLM_PROVIDER="${cfg.provider}" no soportado; use openai-compatible`,
    )
  }
  if (!cfg.baseUrl) {
    throw new AgentConfigError('LLM_BASE_URL es obligatorio')
  }
  if (!cfg.model) {
    throw new AgentConfigError('LLM_MODEL es obligatorio')
  }
  if (!cfg.apiKey) {
    throw new AgentConfigError(
      'LLM_API_KEY ausente; configure el Secret k8s travel-agent-llm',
    )
  }
}

export function assertWebSearchReady(cfg: LlmEnvConfig): void {
  if (!cfg.enableWebTools) return
  if (cfg.webSearchProvider === 'tavily' && !cfg.tavilyApiKey) {
    throw new AgentConfigError(
      'TAVILY_API_KEY ausente; configure el Secret k8s travel-agent-llm (WEB_SEARCH_PROVIDER=tavily)',
    )
  }
}

export type ProviderFactory = (cfg: LlmEnvConfig) => LLMProvider

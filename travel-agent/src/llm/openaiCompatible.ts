import type {
  ChatCompletionParams,
  ChatCompletionResult,
  ChatMessage,
  LLMProvider,
  ToolCall,
  TokenUsage,
} from './types.ts'
import { AgentRuntimeError } from './config.ts'

type OpenAiChatResponse = {
  choices?: {
    message?: {
      role?: string
      content?: string | null
      reasoning?: string
      tool_calls?: {
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  error?: { message?: string }
}

/**
 * OpenAI-compatible chat completions client (OpenAI today; Ollama later via same shape).
 * Swap only via LLM_BASE_URL / LLM_MODEL / LLM_API_KEY — no PWA changes.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly providerId = 'openai-compatible'

  constructor(
    readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly defaultMaxTokens = 8192,
  ) {}

  async chat(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const url = `${this.baseUrl}/chat/completions`
    const body: Record<string, unknown> = {
      model: this.model,
      messages: params.messages.map(serializeMessage),
      temperature: params.temperature ?? 0.2,
      max_tokens: params.max_tokens ?? this.defaultMaxTokens,
    }
    // OpenAI rejects tool_choice when tools are omitted; only send with tools.
    if (params.tools?.length) {
      body.tools = params.tools
      body.tool_choice = params.tool_choice ?? 'auto'
    }
    if (params.response_format) {
      body.response_format = params.response_format
    }

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: params.signal,
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AgentRuntimeError('LLM timeout / aborted', 'llm_timeout')
      }
      throw new AgentRuntimeError(
        `LLM request failed: ${err instanceof Error ? err.message : 'network'}`,
        'llm_network',
      )
    }

    const rawText = await res.text()
    let data: OpenAiChatResponse
    try {
      data = JSON.parse(rawText) as OpenAiChatResponse
    } catch {
      throw new AgentRuntimeError(
        `LLM response not JSON (HTTP ${res.status})`,
        'llm_bad_response',
      )
    }

    if (!res.ok) {
      const msg = data.error?.message || `HTTP ${res.status}`
      // Never echo Authorization or key material
      throw new AgentRuntimeError(`LLM error: ${msg}`, 'llm_http')
    }

    const choice = data.choices?.[0]
    if (!choice?.message) {
      throw new AgentRuntimeError('LLM empty choices', 'llm_bad_response')
    }

    const toolCalls = (choice.message.tool_calls ?? [])
      .map(normalizeToolCall)
      .filter((t): t is ToolCall => t !== null)

    const message: ChatMessage = {
      role: 'assistant',
      content: choice.message.content ?? null,
      tool_calls: toolCalls.length ? toolCalls : undefined,
      reasoning:
        typeof choice.message.reasoning === 'string'
          ? choice.message.reasoning
          : undefined,
    }

    return {
      message,
      finishReason: choice.finish_reason ?? null,
      usage: normalizeUsage(data.usage),
    }
  }
}

function normalizeUsage(
  usage: OpenAiChatResponse['usage'],
): TokenUsage | undefined {
  if (!usage) return undefined
  const inputTokens = usage.prompt_tokens
  const outputTokens = usage.completion_tokens
  const totalTokens = usage.total_tokens
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined
  }
  return { inputTokens, outputTokens, totalTokens }
}

function serializeMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: m.role,
    content: m.content,
  }
  if (m.name) out.name = m.name
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id
  if (m.tool_calls?.length) out.tool_calls = m.tool_calls
  if (m.reasoning) out.reasoning = m.reasoning
  return out
}

function normalizeToolCall(raw: {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}): ToolCall | null {
  const id = raw.id?.trim()
  const name = raw.function?.name?.trim()
  if (!id || !name) return null
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: raw.function?.arguments ?? '{}',
    },
  }
}

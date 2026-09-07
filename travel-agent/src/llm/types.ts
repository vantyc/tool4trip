export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export type ToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type ChatMessage = {
  role: ChatRole
  content: string | null
  name?: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
  /** Present on some reasoning models; preserve across turns when returned. */
  reasoning?: string
}

export type ToolDefinition = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type JsonSchemaResponseFormat = {
  type: 'json_schema'
  json_schema: {
    name: string
    strict?: boolean
    schema: Record<string, unknown>
  }
}

export type ChatCompletionParams = {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  tool_choice?: 'auto' | 'none'
  response_format?: { type: 'json_object' } | JsonSchemaResponseFormat
  temperature?: number
  /** Optional completion size cap (provider default if unset by caller). */
  max_tokens?: number
  signal?: AbortSignal
}

export type TokenUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type ChatCompletionResult = {
  message: ChatMessage
  finishReason: string | null
  usage?: TokenUsage
}

/** Swappable LLM backend — OpenAI-compatible now; Ollama later via same shape. */
export interface LLMProvider {
  readonly providerId: string
  readonly model: string
  chat(params: ChatCompletionParams): Promise<ChatCompletionResult>
}

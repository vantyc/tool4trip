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
}

export type ToolDefinition = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ChatCompletionParams = {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  tool_choice?: 'auto' | 'none'
  response_format?: { type: 'json_object' }
  temperature?: number
  signal?: AbortSignal
}

export type ChatCompletionResult = {
  message: ChatMessage
  finishReason: string | null
}

/** Swappable LLM backend — OpenAI-compatible now; Ollama later via same shape. */
export interface LLMProvider {
  readonly providerId: string
  readonly model: string
  chat(params: ChatCompletionParams): Promise<ChatCompletionResult>
}

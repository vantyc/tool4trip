import { randomUUID } from 'node:crypto'
import {
  agentProposalSchema,
  type AgentAskRequest,
  type AgentProposal,
  type ToolTraceEntry,
} from '../../shared/agentContracts.ts'
import {
  AgentRuntimeError,
  assertLlmReady,
  assertWebSearchReady,
  type LlmEnvConfig,
} from '../llm/config.ts'
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  ChatMessage,
  LLMProvider,
} from '../llm/types.ts'
import { logJobEvent } from '../jobs/log.ts'
import { ToolRegistry } from '../tools/registry.ts'
import { buildUserMessage, registerTravelTools } from '../tools/travelTools.ts'
import {
  buildFinalProposalPrompt,
  buildNewTravelUserNudge,
  buildRepairPrompt,
  buildSystemPrompt,
} from './prompts.ts'
import { assertDraftGrounded } from './claims.ts'
import {
  buildContextOnlyDraft,
  classifyAskIntent,
  tryContextAnswer,
} from './intent.ts'
import { enrichPackageWithAirportArrivals } from './airportArrivalEnrich.ts'
import { agentProposalStructuredResponseFormat } from './proposalSchema.ts'

export type AgentRunMeta = {
  steps: number
  llmCalls: number
  toolTrace: ToolTraceEntry[]
  lastFinishReason: string | null
  usage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  hadRepair: boolean
  finalContentChars?: number
  finalContentBytes?: number
}

export type AgentRunResult = {
  proposal: AgentProposal
  meta: AgentRunMeta
}

export type AgentRuntimeDeps = {
  llm: LLMProvider
  cfg: LlmEnvConfig
  /** Injected for tests — default builds registry with real tools. */
  createRegistry?: () => ToolRegistry
  jobId?: string
  requestId?: string
  tripId?: string
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00')
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed)
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) {
    return JSON.parse(fence[1].trim())
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1))
  }
  throw new Error('no JSON object in model output')
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** Like str(), but empty/whitespace strings fall through to fallback. */
function nonEmptyStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.trim() !== '' ? v : fallback
}

function normalizeGoals(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((g) => {
      if (typeof g === 'string') return g
      const o = asRecord(g)
      return str(o.label, str(o.id))
    })
    .filter(Boolean)
}

function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null) continue
      out[k] = stripNulls(val)
    }
    return out
  }
  return v
}

/** Hydrate LLM draft with server-owned fields; PWA still receives full AgentProposal. */
export function hydrateProposal(
  raw: unknown,
  req: AgentAskRequest,
  toolTrace: ToolTraceEntry[],
  opts?: { serverWarnings?: string[]; intent?: string },
): unknown {
  const obj = asRecord(stripNulls(raw))
  // claims[] is internal to AgentRuntime — never part of public AgentProposal
  const { claims: _claims, ...withoutClaims } = obj
  const isNewTravel =
    req.mode === 'new_travel' || opts?.intent === 'new_travel'
  const trip = asRecord(req.context.trip)
  const tripId = isNewTravel
    ? str(asRecord(asRecord(withoutClaims.package).trip).id, req.tripId)
    : str(trip.id, req.tripId)
  const title = isNewTravel
    ? str(asRecord(asRecord(withoutClaims.package).trip).title, 'Nuevo viaje')
    : str(trip.title, 'Viaje')
  const startDate = isNewTravel
    ? str(
        asRecord(asRecord(withoutClaims.package).trip).startDate,
        '2026-01-01',
      )
    : str(trip.startDate, '2026-01-01')
  const endDate = isNewTravel
    ? str(
        asRecord(asRecord(withoutClaims.package).trip).endDate,
        startDate,
      )
    : str(trip.endDate, startDate)
  const timezone = isNewTravel
    ? str(
        asRecord(asRecord(withoutClaims.package).trip).timezone,
        'America/Mexico_City',
      )
    : str(trip.timezone, 'America/Mexico_City')
  const packageImports = req.context.packageImports.map(asRecord)
  const priorPkg = isNewTravel ? undefined : packageImports[0]
  const packageId = isNewTravel
    ? nonEmptyStr(asRecord(withoutClaims.package).packageId, `new-${tripId}`)
    : nonEmptyStr(priorPkg?.id) ||
      nonEmptyStr(priorPkg?.packageId) ||
      `agent-${tripId}`
  const priorRevision =
    typeof priorPkg?.revision === 'number' ? priorPkg.revision : 0
  const revision = isNewTravel
    ? 1
    : Math.max(1, priorRevision + 1)

  let pkg = asRecord(withoutClaims.package)
  if (isNewTravel) {
    pkg = enrichPackageWithAirportArrivals(pkg)
  }
  const pkgTrip = asRecord(pkg.trip)

  const modelWarnings = Array.isArray(withoutClaims.warnings)
    ? withoutClaims.warnings.filter((w): w is string => typeof w === 'string')
    : []
  const warnings = [...modelWarnings, ...(opts?.serverWarnings ?? [])]

  return {
    ...withoutClaims,
    warnings,
    // Server-owned — always overwrite model values if present
    proposalId: randomUUID(),
    createdAt: nowIso(),
    toolTrace,
    package: {
      ...pkg,
      schemaVersion: 1,
      packageId: nonEmptyStr(pkg.packageId, packageId),
      revision:
        typeof pkg.revision === 'number' && pkg.revision >= 1
          ? pkg.revision
          : revision,
      generatedAt: nowIso(),
      trip: {
        id: tripId,
        title: str(pkgTrip.title, title),
        destination: isNewTravel
          ? str(pkgTrip.destination) || undefined
          : str(pkgTrip.destination, str(trip.destination)),
        startDate: str(pkgTrip.startDate, startDate),
        endDate: str(pkgTrip.endDate, endDate),
        timezone: str(pkgTrip.timezone, timezone),
        goals: normalizeGoals(
          pkgTrip.goals ?? (isNewTravel ? [] : trip.goals),
        ),
        status: str(pkgTrip.status, str(trip.status, 'planned')),
        // Explicit null/empty from a context-only draft must not re-echo Dexie notes
        // into the proposal package (those are INPUT CONTEXT, not agent output).
        notes:
          'notes' in pkgTrip
            ? str(pkgTrip.notes) || undefined
            : isNewTravel
              ? undefined
              : str(trip.notes) || undefined,
      },
      travelOptions: Array.isArray(pkg.travelOptions) ? pkg.travelOptions : [],
      itineraryItems: Array.isArray(pkg.itineraryItems) ? pkg.itineraryItems : [],
      checklistItems: Array.isArray(pkg.checklistItems) ? pkg.checklistItems : [],
      notes: Array.isArray(pkg.notes) ? pkg.notes : [],
    },
  }
}

export type ParseProposalResult =
  | { ok: true; proposal: AgentProposal }
  | { ok: false; error: string; code?: string; warnings?: string[] }

function tryParseProposal(
  text: string,
  req: AgentAskRequest,
  toolTrace: ToolTraceEntry[],
  intent?: string,
): ParseProposalResult {
  try {
    const raw = extractJsonObject(text)
    const draft = asRecord(stripNulls(raw))
    const grounding = assertDraftGrounded(draft, toolTrace, req.context, {
      allowSkeletonPackage: intent === 'new_travel' || req.mode === 'new_travel',
    })
    if (!grounding.ok) {
      const detail = [grounding.message, ...grounding.warnings].join('\n')
      return {
        ok: false,
        error: detail,
        code: 'ungrounded_claims',
        warnings: grounding.warnings,
      }
    }
    const hydrated = hydrateProposal(grounding.draft, req, toolTrace, {
      serverWarnings: [],
      intent,
    })
    const parsed = agentProposalSchema.safeParse(hydrated)
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message }
    }
    return { ok: true, proposal: parsed.data }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'parse failed',
    }
  }
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}

function addUsage(
  acc: { inputTokens: number; outputTokens: number; totalTokens: number },
  usage: ChatCompletionResult['usage'],
) {
  if (!usage) return
  acc.inputTokens += usage.inputTokens ?? 0
  acc.outputTokens += usage.outputTokens ?? 0
  acc.totalTokens +=
    usage.totalTokens ??
    (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
}

/**
 * AgentRuntime: tool loop → dedicated structured final → Zod → one repair max.
 */
export async function runAgentAsk(
  req: AgentAskRequest,
  deps: AgentRuntimeDeps,
): Promise<AgentRunResult> {
  assertLlmReady(deps.cfg)
  if (deps.cfg.enableWebTools) {
    assertWebSearchReady(deps.cfg)
  }

  const registry =
    deps.createRegistry?.() ??
    (() => {
      const r = new ToolRegistry()
      registerTravelTools(r, {
        enableWebTools: deps.cfg.enableWebTools,
        webSearchProvider: deps.cfg.webSearchProvider,
        enableDdgFallback: deps.cfg.enableDdgFallback,
      })
      return r
    })()

  const toolTrace: ToolTraceEntry[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.cfg.timeoutMs)

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserMessage(req) },
  ]

  let toolCallsUsed = 0
  let steps = 0
  let llmCalls = 0
  let lastFinishReason: string | null = null
  let hadRepair = false
  const usage = emptyUsage()

  const failMeta = (): NonNullable<AgentRuntimeError['runMeta']> => ({
    toolTrace: [...toolTrace],
    steps,
    llmCalls,
    lastFinishReason,
    usage: { ...usage },
    hadRepair,
  })

  const chatLogged = async (
    callType: 'tool' | 'final' | 'repair',
    params: ChatCompletionParams,
  ): Promise<ChatCompletionResult> => {
    steps += 1
    llmCalls += 1
    const maxTokensRequested = params.max_tokens ?? deps.cfg.maxTokens
    const t0 = Date.now()
    const result = await deps.llm.chat({
      ...params,
      max_tokens: maxTokensRequested,
      signal: controller.signal,
    })
    lastFinishReason = result.finishReason
    addUsage(usage, result.usage)
    const content = result.message.content ?? ''
    const contentLengthChars = content.length
    const contentLengthBytes = Buffer.byteLength(content, 'utf8')
    logJobEvent('llm_call', {
      jobId: deps.jobId ?? null,
      requestId: deps.requestId ?? null,
      tripId: deps.tripId ?? req.tripId,
      step: steps,
      callType,
      model: deps.llm.model,
      durationMs: Date.now() - t0,
      finish_reason: result.finishReason,
      input_tokens: result.usage?.inputTokens ?? null,
      output_tokens: result.usage?.outputTokens ?? null,
      total_tokens: result.usage?.totalTokens ?? null,
      contentLengthChars,
      contentLengthBytes,
      toolCallsCount: result.message.tool_calls?.length ?? 0,
      responseFormatUsed: Boolean(params.response_format),
      maxTokensRequested,
    })
    return result
  }

  try {
    const intent = classifyAskIntent(req.prompt, req.mode)
    logJobEvent('ask_intent', {
      jobId: deps.jobId ?? null,
      requestId: deps.requestId ?? null,
      tripId: deps.tripId ?? req.tripId,
      intent,
      mode: req.mode ?? 'ask',
    })

    // --- Context-only fast path: no tools, no web claims ---
    if (intent === 'context_answer') {
      const hit = tryContextAnswer(req)
      if (hit) {
        const draft = buildContextOnlyDraft(req, hit)
        const grounding = assertDraftGrounded(draft, toolTrace, req.context)
        if (!grounding.ok) {
          throw new AgentRuntimeError(
            [grounding.message, ...grounding.warnings].join('\n'),
            'ungrounded_claims',
            failMeta(),
          )
        }
        const hydrated = hydrateProposal(grounding.draft, req, toolTrace, {
          serverWarnings: [],
        })
        const parsed = agentProposalSchema.safeParse(hydrated)
        if (!parsed.success) {
          throw new AgentRuntimeError(
            parsed.error.message,
            'invalid_proposal',
            failMeta(),
          )
        }
        return {
          proposal: parsed.data,
          meta: {
            steps,
            llmCalls: 0,
            toolTrace,
            lastFinishReason: null,
            usage: emptyUsage(),
            hadRepair: false,
            finalContentChars: hit.narrative.length,
            finalContentBytes: Buffer.byteLength(hit.narrative, 'utf8'),
          },
        }
      }
      // Context intent but no deterministic hit → LLM final only (no tools)
      messages.push({
        role: 'user',
        content: [
          'INTENT: context_answer.',
          'Answer ONLY from DEXIE_TRIP_CONTEXT_SNAPSHOT_JSON.',
          'Do NOT call tools. Do NOT invent web sourceUrl.',
          'Use claims with sourceType=context (entityType, entityId, field).',
          'If the answer is not in context, say so briefly without web research.',
        ].join(' '),
      })
      // fall through to structured final (skip tool loop)
    } else {
      if (intent === 'new_travel') {
        messages.push({
          role: 'user',
          content: buildNewTravelUserNudge(req.tripId),
        })
      }
      // --- Tool loop (research / mutation / new_travel events) ---
      while (steps < deps.cfg.maxSteps) {
        if (controller.signal.aborted) {
          throw new AgentRuntimeError('Agent timeout', 'llm_timeout', failMeta())
        }

        const tools = registry.definitions()
        const result = await chatLogged('tool', {
          messages,
          ...(tools.length ? { tools, tool_choice: 'auto' as const } : {}),
        })

        const assistant = result.message
        messages.push(assistant)

        if (assistant.tool_calls?.length) {
          for (const call of assistant.tool_calls) {
            if (toolCallsUsed >= deps.cfg.maxToolCalls) {
              const checkedAt = nowIso()
              const skipTrace: ToolTraceEntry = {
                tool: call.function.name,
                args: { skipped: true },
                ok: false,
                sources: [],
                error: `AGENT_MAX_TOOL_CALLS=${deps.cfg.maxToolCalls} exceeded`,
                checkedAt,
              }
              toolTrace.push(skipTrace)
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.function.name,
                content: JSON.stringify({
                  UNTRUSTED_CONTENT: true,
                  error: skipTrace.error,
                }),
              })
              continue
            }
            toolCallsUsed += 1
            const exec = await registry.execute(
              call.function.name,
              call.function.arguments,
              { signal: controller.signal },
            )
            toolTrace.push(exec.trace)
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.function.name,
              content: exec.contentForModel,
            })
          }
          continue
        }

        // No tool calls → end tool loop
        break
      }
    }

    // --- Dedicated structured final (no tools) ---
    if (controller.signal.aborted) {
      throw new AgentRuntimeError('Agent timeout', 'llm_timeout', failMeta())
    }

    messages.push({ role: 'user', content: buildFinalProposalPrompt(intent) })
    const finalResult = await chatLogged('final', {
      messages,
      response_format: agentProposalStructuredResponseFormat(),
    })
    messages.push(finalResult.message)

    if (finalResult.finishReason === 'length') {
      throw new AgentRuntimeError(
        'LLM output truncated (finish_reason=length) on final structured turn',
        'output_truncated',
        failMeta(),
      )
    }

    const finalText = finalResult.message.content?.trim() || ''
    const finalChars = finalText.length
    const finalBytes = Buffer.byteLength(finalText, 'utf8')

    if (!finalText) {
      throw new AgentRuntimeError(
        `LLM returned empty content on final (finish=${finalResult.finishReason ?? 'unknown'})`,
        'llm_empty',
        failMeta(),
      )
    }

    const first = tryParseProposal(finalText, req, toolTrace, intent)
    if (first.ok) {
      return {
        proposal: first.proposal,
        meta: {
          steps,
          llmCalls,
          toolTrace,
          lastFinishReason,
          usage: { ...usage },
          hadRepair: false,
          finalContentChars: finalChars,
          finalContentBytes: finalBytes,
        },
      }
    }

    // --- Single repair fallback ---
    hadRepair = true
    if (controller.signal.aborted) {
      throw new AgentRuntimeError('Agent timeout', 'llm_timeout', failMeta())
    }

    const repairResult = await chatLogged('repair', {
      messages: [
        ...messages,
        { role: 'user', content: buildRepairPrompt(first.error) },
      ],
      response_format: agentProposalStructuredResponseFormat(),
    })
    messages.push(repairResult.message)

    if (repairResult.finishReason === 'length') {
      throw new AgentRuntimeError(
        'LLM output truncated (finish_reason=length) on repair turn',
        'output_truncated',
        failMeta(),
      )
    }

    const repairedText = repairResult.message.content?.trim() || ''
    const second = tryParseProposal(repairedText, req, toolTrace, intent)
    if (second.ok) {
      return {
        proposal: second.proposal,
        meta: {
          steps,
          llmCalls,
          toolTrace,
          lastFinishReason,
          usage: { ...usage },
          hadRepair: true,
          finalContentChars: repairedText.length,
          finalContentBytes: Buffer.byteLength(repairedText, 'utf8'),
        },
      }
    }

    const failCode =
      second.code === 'ungrounded_claims' || first.code === 'ungrounded_claims'
        ? 'ungrounded_claims'
        : 'invalid_proposal'
    throw new AgentRuntimeError(
      failCode === 'ungrounded_claims'
        ? second.error
        : `AgentProposal JSON inválido tras repair: ${second.error}`,
      failCode,
      failMeta(),
    )
  } catch (err) {
    if (err instanceof AgentRuntimeError) {
      if (!err.runMeta) {
        throw new AgentRuntimeError(err.message, err.code, failMeta())
      }
      throw err
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AgentRuntimeError('Agent timeout', 'llm_timeout', failMeta())
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
